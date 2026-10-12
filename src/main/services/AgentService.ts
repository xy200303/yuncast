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
 * - text_delta 累积成"AI 正在组织语言"预览广播给渲染进程，入池（工具执行）即清
 * - 当前场次的主题/剧本场景随 system prompt 注入；每次对话带当前场景上下文
 */

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
  /** 本场运行态音色（场次指定；set_voice 工具可热改；空 = 回落人设/TTS 默认） */
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

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly script: ScriptService,
    private readonly broadcast: (status: AgentStatus) => void,
    private readonly onDirectorReport?: (text: string) => void
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
        : undefined
    }
  }

  /** 启动主播会话。解析不出模型时抛清晰中文错误（UI 弹 toast + 引导去设置页）。 */
  async start(): Promise<void> {
    if (this.session) return
    // 模型按「这张卡的接入与模型 → 全局默认接入 → 旧的 config.llm」解析，解析不出就明确报错
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
   * 暂停期间照常送达（不然喊不出「继续」）；主播用 report_to_director 回报执行结果。
   */
  directorSay(text: string): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) {
      throw new Error('主播没在跑：先在直播台启动场次')
    }
    this.deliver(
      `[导演指令] ${text}\n这是对导演（真人场控）指令的执行请求，照做；做完用 report_to_director 简要汇报执行情况。`,
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

    const persona = this.persona.get()
    const { plan, script } = this.script.getActive()
    const systemPrompt = this.persona.buildSystemPrompt(
      persona,
      this.storage.getConfig().tts.voiceId,
      plan,
      script
    )

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
        onDirectorReport: (text) => this.onDirectorReport?.(text),
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
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        // 生成中预览：累积 text_delta 广播给提词器
        this.draft += event.assistantMessageEvent.delta
        this.broadcast(this.status())
      } else if (event.type === 'tool_execution_start') {
        // 一句话说完入了池，清掉生成中预览
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
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
      } else if (event.type === 'agent_settled') {
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      }
    })

    return session
  }
}
