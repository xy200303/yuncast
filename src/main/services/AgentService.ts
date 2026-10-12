import { join } from 'node:path'
import { app } from 'electron'
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'
import {
  type AgentStatus,
  type DirectorTimelineEvent,
  type LiveComment,
  type PlaybackControlAction
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { SpeechPool } from './SpeechPool'
import type { PersonaService } from './PersonaService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { ScriptService } from './ScriptService'
import { ANCHOR_TOOL_NAMES, buildAnchorTools } from './anchorTools'
import { prepareLlmModel, resolveModelForPersona } from './llmModel'
import type { ResolvedModel } from './providers/registry'

/**
 * 主播 Agent（docs/01 §3.1 单脑架构）：唯一话术生产者。
 * - pi-agent SDK 路线：createAgentSession，资源目录全部重定向到 userData/pi（不碰 ~/.pi）
 * - 关掉全部内置编码工具，只挂主播工具（anchorTools，一切声音走话术池）
 * - 凭据运行时注入 ModelRuntime，不落 pi 的盘；我们的 config 里 safeStorage 加密
 * - text_delta 既累积成"AI 正在组织语言"预览（提词器），也推给对话时间线（docs/09 §11）
 * - 对话时间线照 pi 事件流原样渲染：文本流式 / 工具卡片 / 最终回复，不做二次解释
 *   （thinking_delta 不渲染；ask_director 的工具卡片跳过——它走请示卡片那条通道）
 */

/** 中间文本的节流间隔：text_delta 又密又碎，攒够这个间隔再推一次全文快照 */
const TEXT_THROTTLE_MS = 60
/** 工具卡片里参数压成一行后的长度上限 */
const TOOL_ARGS_MAX = 120
/** 工具卡片里结果压成一行后的长度上限 */
const TOOL_RESULT_MAX = 200

/** 一条 assistant 消息在时间线上的文本状态（按 messageId 更新，不重复追加条目） */
interface TimelineText {
  turnId: string
  text: string
  /** 上次推出去的快照（相同就不推，减少 IPC） */
  sent: string
  /** 已经标过最终回复 */
  finalSent: boolean
  /** 节流挂起的补推定时器 */
  timer?: NodeJS.Timeout
}

export class AgentService {
  private session: AgentSession | null = null
  private state: AgentStatus['state'] = 'stopped'
  private error: string | undefined
  private modelLabel: string | undefined
  private draft = ''
  private busy = false
  /** 最近一条待回应评论（insert_next 工具挂 replyTo 用） */
  private lastComment: LiveComment | null = null
  /** 本场开播时间（下播总结用） */
  private startedAt = 0
  /** 本场发生过几轮对话（没对话就不写总结） */
  private exchanges = 0
  /** 本场运行态音色（场次指定；set_voice 工具可热改；空 = 用当前人设卡的音色） */
  private planVoiceId = ''
  /** 播报是否被暂停：暂停时评论/触发器不再派给 LLM，say 也说不出去（统一开播控制里的「暂停」） */
  private speakingPaused = false
  /** 场景推进后的装载钩子（LaunchService 接上：把新场景话术库载入池） */
  onSceneAdvanced: ((sceneIndex: number) => void) | null = null
  /** 主播请示（ask_director）→ 导演对话面板高亮卡片；不阻塞 run（docs/07 §8.8.6 ④） */
  onDirectorAsk:
    | ((ask: { text: string; options: string[]; timeoutSec: number; defaultAction?: string }) => void)
    | null = null
  /** 播报控制（pause/resume/skip）→ 广播到渲染进程执行 */
  onPlaybackControl: ((action: PlaybackControlAction) => void) | null = null

  /** 本轮序号（agent_start 自增，一次派活 = 一轮，形如 turn-3） */
  private turnSeq = 0
  /** 本轮里的 assistant 消息序号（message_start 自增，形如 turn-3-msg-1） */
  private msgSeq = 0
  private turnId = 'turn-0'
  /** 当前正在流式的 assistant 消息（text_delta 都累加到它） */
  private currentMessageId: string | null = null
  /** 本轮各消息的文本快照（本轮开始时清空） */
  private texts = new Map<string, TimelineText>()
  /** 最近一次文本广播时间（全局节流，避免一条满屏 delta） */
  private lastTextEmitAt = 0
  /** 本轮最后一条有正文的 assistant 消息 = 最终回复（装得下工具轮次里的中间文本） */
  private lastTextMessageId: string | null = null
  /** 本轮是否已标过最终回复（agent_end / agent_settled 兜底时不重复推） */
  private turnFinalized = false

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly script: ScriptService,
    private readonly broadcast: (status: AgentStatus) => void,
    private readonly onDirectorTimeline?: (event: DirectorTimelineEvent) => void
  ) {}

  /** 设置本场音色（开播装载时写入场次音色；运行中热切换音色也走这里） */
  setPlanVoice(voiceId: string): void {
    this.planVoiceId = voiceId.trim()
  }

  /**
   * 暂停/恢复主播产出。暂停时：评论不再派给 LLM、触发器不触发、say/insert_next 被拒
   * （说出去的话收不回，所以宁可不生成）；导演指令照常送达，随时可以喊「继续」。
   */
  setSpeakingPaused(paused: boolean): void {
    this.speakingPaused = paused
  }

  /** 开播时冻结的资产指纹：会话出生时读了一次人设/模型/剧本，之后不再读（docs/07 §8.5） */
  private sessionFingerprint: string | null = null

  status(): AgentStatus {
    const current = this.state === 'stopped' ? null : this.script.currentScene()
    return {
      state: this.state,
      error: this.error,
      model: this.modelLabel,
      personaName: this.state === 'stopped' ? undefined : this.persona.get().name,
      draft: this.draft,
      scene: current
        ? { title: current.scene.title, index: current.index, total: current.total }
        : undefined,
      // 会话还活着时比对资产：改过人设/模型/剧本就得重启会话才生效
      assetsStale:
        this.sessionFingerprint !== null && this.assetFingerprint() !== this.sessionFingerprint
    }
  }

  /**
   * 资产指纹：凡是「出生时组装进 system prompt 或模型 provider」的东西都算。
   * 不含音色——音色是每条话术现算的（resolveVoice 每次读当前值），改了立刻对后说的生效。
   */
  private assetFingerprint(): string {
    const persona = this.persona.get()
    const { plan, script } = this.script.getActive()
    const connection = persona.modelConnectionId
      ? this.storage.connectionGet(persona.modelConnectionId)
      : null
    const { llm } = this.storage.getConfig()
    return fingerprint(
      JSON.stringify({
        persona: [
          persona.id,
          persona.name,
          persona.personality,
          persona.catchphrases,
          persona.background,
          persona.taboos,
          persona.roles,
          persona.modelConnectionId,
          persona.model
        ],
        // 接入自身的改动（换密钥、改模型列表）同样要让会话作废
        connection: connection
          ? [connection.providerId, connection.models, connection.params]
          : null,
        legacy: [llm.provider, llm.model, llm.apiKey, llm.baseUrl],
        plan: [plan?.id, plan?.personaId, plan?.styleHint, plan?.scriptId, plan?.knowledgeScope],
        script: script ? [script.title, script.scenes] : null
      })
    )
  }

  /** 启动主播会话。解析不出模型时抛清晰中文错误（UI 弹 toast + 引导去设置页）。 */
  async start(): Promise<void> {
    if (this.session) return
    // 大脑只用这张卡选的接入与模型；没选时只能临时顶旧配置（预检会把这种情况列成阻断项）
    const resolved = resolveModelForPersona(this.storage, this.persona.get())
    this.setState('starting')
    try {
      this.session = await this.createSession(resolved)
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.setState('running')
    this.startedAt = Date.now()
    this.exchanges = 0
    // 新一场总是从"能说话"开始（上一场可能是暂停状态停掉的）
    this.speakingPaused = false
    // 开场白由「开场白」触发器（stream.started → task）负责，见 TriggerRuntime
  }

  async stop(): Promise<void> {
    const session = this.session
    this.session = null
    this.sessionFingerprint = null
    this.draft = ''
    this.lastComment = null
    if (session) {
      // 下播总结：本场有过对话就让主播自我复盘，写进场次摘要（本场记忆）
      if (this.exchanges > 0 && this.state === 'running') {
        await this.summarizeEpisode(session).catch(() => undefined)
      }
      try {
        await session.abort()
      } catch {
        // 停止时 abort 失败不影响关闭
      }
      session.dispose()
    }
    // 停了就不再收尾当前这一轮（abort 后可能还有 agent_settled 飘过来）
    this.clearTextTimers()
    this.texts.clear()
    this.currentMessageId = null
    this.lastTextMessageId = null
    this.turnFinalized = true
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** 评论入口（连接器）：主播自己决定回不回、怎么回。老粉画像随评论注入。 */
  onComment(comment: LiveComment): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    // 暂停期间评论只进事件队列（EventBus 已记下），不派给 LLM（同 docs/07 §8.5 人工接管的处理）
    if (this.speakingPaused) return
    // 先查画像（老粉识别），再记一次互动
    const known = this.memory.lookupViewer(comment.author)
    const isQuestion = /[?？]$/.test(comment.content.trim())
    this.memory.touchViewer(comment.author, isQuestion ? comment.content : undefined)
    this.lastComment = comment
    const profileHint = known
      ? `\n[老粉画像] ${comment.author}：${this.memory.describeViewer(known)}`
      : '\n[新观众] 没见过这位观众'
    void this.ask(
      `[观众评论] ${comment.author} 说：「${comment.content}」${profileHint}\n` +
        '值得回应就用 insert_next 回一句（口语、简短）；答不上来的商品信息先用 search_knowledge / check_price 查；' +
        '聊出值得记住的偏好就顺手 remember_viewer 记一笔；不值得回应就忽略它，继续你的节奏。'
    )
  }

  /** 触发器入口（docs/01 §3.5）：steer=生成中插一句，task=派一个任务。主播没在跑/已暂停就丢弃。 */
  inject(text: string, mode: 'steer' | 'task'): void {
    if (this.speakingPaused) return
    this.deliver(text, mode)
  }

  /** 实际投递：导演指令绕过暂停检查走这里，其余的入口统一先过暂停闸门 */
  private deliver(text: string, mode: 'steer' | 'task'): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (mode === 'steer' && this.busy) {
      try {
        this.session.steer(text)
      } catch (error) {
        console.error('[AgentAnchor] steer 失败:', error)
      }
      return
    }
    void this.ask(text)
  }

  /**
   * 导演指令入口（docs/07 §8.8）：最高优先级，生成中就 steer 插队，空闲直接派。
   * 暂停期间照常送达（不然喊不出「继续」）；执行过程与结果由对话时间线按 pi 事件流原样呈现。
   */
  directorSay(text: string): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) {
      throw new Error('主播没在跑：先在直播台启动场次')
    }
    this.deliver(
      `[导演指令] ${text}\n这是对导演（真人场控）指令的执行请求，照做；做完直接说一句执行情况（你说的话会出现在导演对话面板，不会被播报）。`,
      'steer'
    )
  }

  /** 急停（配合 renderer 停播放 + 清池）：停会话即可，池由调用方清 */
  async panic(): Promise<void> {
    await this.stop()
  }

  /** 场景推进后广播状态（提词器「当前场景」刷新） */
  notifySceneChanged(): void {
    this.broadcast(this.status())
  }

  // ---------- 对话时间线（docs/09 §11：照 pi 事件流原样渲染，不做二次解释） ----------

  /**
   * 新一轮（agent_start）：一次派给主播的任务 = 一轮，含中间文本 + 多轮工具调用 + 最终回复。
   * turnId 形如 turn-3，本轮内每条 assistant 消息形如 turn-3-msg-1。
   */
  private beginTurn(): void {
    this.clearTextTimers()
    this.texts.clear()
    this.turnSeq += 1
    this.msgSeq = 0
    this.turnId = `turn-${this.turnSeq}`
    this.currentMessageId = null
    this.lastTextMessageId = null
    this.turnFinalized = false
  }

  /** 一条 assistant 消息开始：给它一个 id，后续 text_delta 都累加到它名下 */
  private beginMessage(): void {
    this.msgSeq += 1
    const id = `${this.turnId}-msg-${this.msgSeq}`
    this.currentMessageId = id
    this.texts.set(id, { turnId: this.turnId, text: '', sent: '', finalSent: false })
  }

  /** 累积 text_delta。节流推全文快照——渲染层按 id 覆盖，所以中间文本不会跳成多条 */
  private appendText(delta: string): void {
    const id = this.currentMessageId
    const state = id ? this.texts.get(id) : undefined
    if (!id || !state) return
    state.text += delta
    if (state.text.trim()) this.lastTextMessageId = id
    this.emitText(id)
  }

  /**
   * 推一条文本条目（同一 id 反复推，渲染层按 id upsert）。
   * 节流 ≥60ms；final 与 force 绕过节流，保证收尾那次一定送出去。
   */
  private emitText(id: string, final = false, force = false): void {
    const state = this.texts.get(id)
    if (!state) return
    if (state.finalSent) return
    if (!final && state.sent === state.text) return
    const elapsed = Date.now() - this.lastTextEmitAt
    if (!final && !force && elapsed < TEXT_THROTTLE_MS) {
      if (!state.timer) {
        const timer = setTimeout(() => {
          state.timer = undefined
          this.emitText(id, false, true)
        }, TEXT_THROTTLE_MS - elapsed)
        timer.unref?.()
        state.timer = timer
      }
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    this.lastTextEmitAt = Date.now()
    state.sent = state.text
    if (final) state.finalSent = true
    this.onDirectorTimeline?.({
      turnId: state.turnId,
      entry: { type: 'text', id, text: state.text, ...(final ? { final: true } : {}) }
    })
  }

  /** 一轮结束前把没推完的最后一段文本补上（节流可能还压着一段） */
  private flushText(): void {
    const id = this.currentMessageId
    if (id) this.emitText(id, false, true)
  }

  /**
   * 本轮收尾：最后一条有正文的 assistant 消息就是最终回复。
   * 标在 agent_end（整轮真正结束）而不是 turn_end——带工具调用的一轮里有好几个 turn_end，
   * 那样会把每个工具轮次的中间文本都标成"最终回复"，出好几个气泡。
   */
  private finalizeTurn(): void {
    const id = this.lastTextMessageId
    if (!id || this.turnFinalized) return
    const state = this.texts.get(id)
    if (!state?.text.trim()) return
    this.turnFinalized = true
    this.emitText(id, true, true)
  }

  /** 工具开始：发一张"运行中"的工具卡片（按 toolCallId 更新，不追加新条目） */
  private startTool(toolCallId: string, toolName: string, args: unknown): void {
    if (toolName === 'ask_director') return
    this.onDirectorTimeline?.({
      turnId: this.turnId,
      entry: {
        type: 'tool',
        id: toolCallId,
        name: toolName,
        args: oneLine(args, TOOL_ARGS_MAX),
        status: 'running'
      }
    })
  }

  /** 工具结束：同 id 更新状态与结果摘要 */
  private endTool(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    durationMs?: number
  ): void {
    if (toolName === 'ask_director') return
    this.onDirectorTimeline?.({
      turnId: this.turnId,
      entry: {
        type: 'tool',
        id: toolCallId,
        name: toolName,
        status: isError ? 'error' : 'ok',
        result: oneLine(result, TOOL_RESULT_MAX),
        isError,
        ...(durationMs === undefined ? {} : { durationMs })
      }
    })
  }

  private clearTextTimers(): void {
    for (const state of this.texts.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  // ---------- 内部 ----------

  private setState(state: AgentStatus['state'], error?: string): void {
    this.state = state
    this.error = error
    if (state !== 'running') this.draft = ''
    this.broadcast(this.status())
  }

  /** 当前场景上下文前缀：每次派话带上，让主播知道讲到哪了 */
  private scenePrefix(): string {
    const current = this.script.currentScene()
    if (!current) return ''
    const { scene, index, total } = current
    return `[当前场景：${scene.title}（第 ${index + 1}/${total} 场）目标：${scene.goal}；要点：${scene.keyPoints}]\n`
  }

  /** 给主播派一句话：生成中走 steer 插队，空闲走 prompt；失败记状态不崩溃 */
  private async ask(text: string): Promise<void> {
    const session = this.session
    if (!session) return
    const full = this.scenePrefix() + text
    try {
      if (this.busy) {
        session.steer(full)
        return
      }
      this.busy = true
      this.exchanges += 1
      await session.prompt(full)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[AgentAnchor] 主播 Agent 调用失败:', message)
      this.setState('error', `LLM 调用失败：${message.slice(0, 200)}`)
      // 会话还活着就留着重试（下一条评论/触发器会再试），不要一报错就死透
    } finally {
      this.busy = false
    }
  }

  /** 下播总结：让主播自我复盘本场亮点/高频问题，写入 episode_summaries。失败静默，不挡下播。 */
  private async summarizeEpisode(session: AgentSession): Promise<void> {
    const endedAt = Date.now()
    await Promise.race([
      (async () => {
        await session.waitForIdle()
        await session.prompt(
          '直播结束了。不要用任何工具，直接用一段话复盘本场：亮点、翻车、观众高频问题，120 字以内。'
        )
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('总结超时')), 30_000))
    ])
    const summary = session.getLastAssistantText()?.trim()
    if (summary) this.memory.saveEpisodeSummary(this.startedAt, endedAt, summary)
  }

  private async createSession(resolved: ResolvedModel): Promise<AgentSession> {
    const agentDir = join(app.getPath('userData'), 'pi')
    const { model, modelRuntime, modelLabel } = await prepareLlmModel(resolved, agentDir)
    this.modelLabel = modelLabel
    // 记下出生时的资产指纹：之后 UI 靠它判断"本场是不是旧版本"
    this.sessionFingerprint = this.assetFingerprint()

    const persona = this.persona.get()
    const { plan, script } = this.script.getActive()
    // 人设卡的音色即主播的嗓子，必选；没选时不留兜底，合成路由会直接报错（预检也会拦下）
    const systemPrompt = this.persona.buildSystemPrompt(persona, plan, script)

    // 全自定义 ResourceLoader：不读 ~/.pi，不发现项目资源，system prompt 就是人设卡 + 场次
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {}
    }

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      model,
      thinkingLevel: 'off',
      modelRuntime,
      resourceLoader,
      // 只启用主播工具（allowlist 逐项点名——M3 踩过坑：tools: [] 会连 customTools 一起清掉）
      customTools: buildAnchorTools({
        pool: this.pool,
        knowledge: this.knowledge,
        memory: this.memory,
        persona: this.persona,
        script: this.script,
        getLastComment: () => this.lastComment,
        onSceneChanged: () => this.notifySceneChanged(),
        getPlanVoice: () => this.planVoiceId,
        onSceneAdvanced: (sceneIndex) => this.onSceneAdvanced?.(sceneIndex),
        onDirectorAsk: (ask) => this.onDirectorAsk?.(ask),
        setPlanVoice: (voiceId) => this.setPlanVoice(voiceId),
        onPlaybackControl: (action) => this.onPlaybackControl?.(action),
        getSpeakingPaused: () => this.speakingPaused
      }),
      tools: [...ANCHOR_TOOL_NAMES],
      sessionManager: SessionManager.inMemory(agentDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } })
    })

    session.subscribe((event) => {
      const assistantEvent = event.type === 'message_update' ? event.assistantMessageEvent : undefined
      if (assistantEvent?.type === 'text_delta') {
        // 生成中预览：累积 text_delta —— 既给提词器，也是对话时间线里"正在说话"的那一段
        this.draft += assistantEvent.delta
        this.appendText(assistantEvent.delta)
        this.broadcast(this.status())
      } else if (event.type === 'agent_start') {
        this.beginTurn()
      } else if (event.type === 'message_start') {
        // 只认 assistant 消息：同一个会话里还有工具结果/工具变更等合成消息，它们不该占消息 id
        if (event.message.role === 'assistant') this.beginMessage()
      } else if (event.type === 'tool_execution_start') {
        // 文本部分说完（接着要执行工具）：先把压着的最后一段推出去，再清提词器预览
        this.flushText()
        this.startTool(event.toolCallId, event.toolName, event.args)
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      } else if (event.type === 'tool_execution_end') {
        this.endTool(event.toolCallId, event.toolName, event.result, event.isError, event.durationMs)
      } else if (event.type === 'agent_end') {
        // prompt() 在 LLM 失败时也会正常 resolve——错误要看末条 assistant 消息的 stopReason
        const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant') as
          | { stopReason?: string; errorMessage?: string }
          | undefined
        if (lastAssistant?.stopReason === 'error') {
          const detail = lastAssistant.errorMessage ?? '未知错误'
          console.error('[AgentAnchor] 主播 Agent 调用失败:', detail)
          this.setState('error', `LLM 调用失败：${detail.slice(0, 200)}`)
        } else if (this.state === 'error') {
          this.setState('running')
        }
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
        // 整轮结束：最后一条 assistant 消息的文本 = 最终回复
        this.flushText()
        this.finalizeTurn()
      } else if (event.type === 'message_end') {
        // 这条消息说完了：把节流压着的尾巴推出去（还接着调工具时，它仍是中间文本）
        this.flushText()
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      } else if (event.type === 'agent_settled') {
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
        // 兜底：agent_end 没走到（异常/中断）也要把最终回复标出来
        this.finalizeTurn()
      }
    })

    return session
  }
}

/** 短指纹（djb2）：只用来判断"资产变没变"，不承担安全职责，避免把密钥原样留在内存字符串里 */
function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(16)
}

/**
 * 把工具的入参/结果压成一行短摘要给工具卡片用（渲染层只展示一行，全文放 title）。
 * pi 的工具结果是 `{ content: [{ type: 'text', text }] }`，直接抽文本比 JSON 好读得多。
 */
function oneLine(value: unknown, max: number): string {
  let raw: string
  if (typeof value === 'string') {
    raw = value
  } else if (Array.isArray(value)) {
    raw = value.map((item) => oneLine(item, max)).join(' ')
  } else if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content
    if (Array.isArray(content)) {
      raw = content
        .map((part) => {
          const text = (part as { text?: unknown })?.text
          return typeof text === 'string' ? text : ''
        })
        .filter(Boolean)
        .join(' ')
    } else {
      try {
        raw = JSON.stringify(value) ?? String(value)
      } catch {
        raw = String(value)
      }
    }
  } else {
    raw = String(value)
  }
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
