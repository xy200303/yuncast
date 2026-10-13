import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import {
  normalizeContext,
  retryAssistantCall,
  type Message,
  type Model,
  type UserMessage
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  type AgentStatus,
  type ChatEntry,
  type DirectorMessage,
  type DirectorTimelineEvent,
  type DirectorTimelineReset,
  type LiveComment,
  type LiveModeWiring,
  type LivePlan,
  type PlaybackControlAction,
  type Script
} from '../../shared/types'
import { planTargetBits } from '../../shared/planDuration'
import type { StorageService } from './StorageService'
import type { SpeechPool } from './SpeechPool'
import type { PersonaService } from './PersonaService'
import type { PromptTemplateService } from './PromptTemplateService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { ModeService } from './ModeService'
import type { ScriptService } from './ScriptService'
import type { UtteranceService } from './UtteranceService'
import { buildAnchorTools } from './anchorTools'
import { prepareLlmModel, resolveModelForPersona } from './llmModel'
import type { ResolvedModel } from './providers/registry'

/**
 * 主播 Agent（docs/01 §3.1 单脑架构）：唯一话术生产者。
 * - 引擎：pi-agent-core 的 Agent 裸用。会话树/models.json/资源发现都不存在也不需要——
 *   会话按场次自己存 SQLite（线性消息数组），system prompt 就是人设卡 + 场次
 * - 只挂主播工具（anchorTools，一切声音走话术池）；core 没有内置工具，不用 allowlist
 * - 模型：手工构造 OpenAI 兼容 Model，凭据随 stream options 注入不落盘；我们的 config 里 secretBox 加密
 * - 上下文压缩：transformContext 钩子里自研——估算超阈值就把旧消息发给 LLM 摘要，替换 state.messages
 * - text_delta 既累积成"AI 正在组织语言"预览（提词器），也推给对话时间线（docs/09 §11）
 * - 对话时间线照事件流原样渲染：文本流式 / 工具卡片 / 请示卡片，不做二次解释（thinking_delta 不渲染）
 */

/** 中间文本的节流间隔：text_delta 又密又碎，攒够这个间隔再推一次全文快照 */
const TEXT_THROTTLE_MS = 60
/** 工具卡片里参数压成一行后的长度上限 */
const TOOL_ARGS_MAX = 120
/** 工具卡片里结果压成一行后的长度上限 */
const TOOL_RESULT_MAX = 200
/** 自动压缩：估算 tokens 超过「窗口 - 这个值」就触发（给回复留空间） */
const COMPACT_RESERVE_TOKENS = 16_384
/** 压缩时保留的最近对话额度：旧的部分进摘要，这部分原样留下 */
const COMPACT_KEEP_RECENT_TOKENS = 20_000
/** 喂给摘要模型的旧对话文本上限（字符）：再老的记录截掉，保住摘要调用本身不溢出 */
const SUMMARY_TRANSCRIPT_MAX_CHARS = 50_000
/** HTTP 请求超时：DeepSeek 偶尔挂住连接一个字节都不吐，收紧到 60s——超时变 error 态（可重试） */
const LLM_TIMEOUT_MS = 60_000
/** 工具表 schema 的粗估开销（tokens）：26 个主播工具不进 messages 但真实占窗口，状态栏进度条要算上 */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 4000

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
  private session: Agent | null = null
  private state: AgentStatus['state'] = 'stopped'
  private error: string | undefined
  private modelLabel: string | undefined
  private draft = ''
  private busy = false
  /** 正在生成（agent_start → agent_end）：广播给对话输入框，发送钮变停止钮 */
  private generating = false
  /** 会话用途：一个脑管全场——prep 写稿备播（播出通道关闭），live 直播中 */
  private sessionPurpose: 'live' | 'prep' = 'live'
  /** 本会话绑定的场次 id（选场次切换时判断要不要换场重开） */
  private sessionPlanId = ''
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
  /** 本场的事件接线（直播模式预设包，会话启动时按场次 modeId 解析冻结） */
  private wiring: LiveModeWiring | null = null
  /** 评论攒批缓冲（wiring.comments === 'batched'）：窗口到了打包成一条派给主播 */
  private commentBuffer: { comment: LiveComment; profileHint: string }[] = []
  private commentBatchTimer: NodeJS.Timeout | null = null
  /** 场景推进后的装载钩子（LaunchService 接上：把新场景话术库载入池） */
  onSceneAdvanced: ((sceneIndex: number) => void) | null = null
  /** 主播自己开播（start_live 工具）：LaunchService 接上，返回给主播看的成败说明 */
  onGoLive: (() => Promise<string>) | null = null
  /** 播报控制（pause/resume/skip）→ 广播到渲染进程执行 */
  onPlaybackControl: ((action: PlaybackControlAction) => void) | null = null

  /** 本轮序号（agent_start 自增，一次派活 = 一轮，形如 turn-m3k9x2-3） */
  private turnSeq = 0
  /**
   * 本次进程的唯一串，揉进 turn/消息 id：时间线按场次永久落库、按 entry id upsert，
   * 不带它的话重启后序号从 0 重来，新回复会原地覆盖上一进程同 id 的旧行——
   * 内容换了、行位置还停在上次启动时，看起来就是「回复跑到提问上面」的错位
   */
  private readonly runId = Date.now().toString(36)
  /** 本轮里的 assistant 消息序号（message_start 自增，形如 turn-m3k9x2-3-msg-1） */
  private msgSeq = 0
  private turnId = `turn-${this.runId}-0`
  /** 当前正在流式的 assistant 消息（text_delta 都累加到它） */
  private currentMessageId: string | null = null
  /** 本轮各消息的文本快照（本轮开始时清空） */
  private texts = new Map<string, TimelineText>()
  /** 最近一次文本广播时间（全局节流，避免一条满屏 delta） */
  private lastTextEmitAt = 0
  /** 本轮最后一条有正文的 assistant 消息 = 最终回复（装得下工具轮次里的中间文本） */
  private lastTextMessageId: string | null = null
  /** 本轮是否已标过最终回复（agent_end 兜底时不重复推） */
  private turnFinalized = false
  /** 正在进行的上下文压缩的时间线卡片 id */
  private compactionCardId: string | null = null
  /** 压缩进行中（transformContext 防重入） */
  private compacting = false
  /** 本会话的上下文窗口（tokens）：状态栏进度条的分母 */
  private contextWindow = 0
  /** system prompt + 工具表的固定开销（tokens，会话出生时估一次） */
  private contextOverhead = 0
  /** 上下文估算缓存：消息条数没变就不重算（status 广播很勤，全量估算不便宜） */
  private contextCache: { messagesLength: number; tokens: number } = { messagesLength: -1, tokens: 0 }

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
    private readonly prompts: PromptTemplateService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly modes: ModeService,
    private readonly script: ScriptService,
    private readonly utterances: UtteranceService,
    private readonly broadcast: (status: AgentStatus) => void,
    private readonly onDirectorTimeline?: (event: DirectorTimelineEvent | DirectorTimelineReset) => void
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
      purpose: this.state === 'stopped' ? undefined : this.sessionPurpose,
      scene: current
        ? { title: current.scene.title, index: current.index, total: current.total }
        : undefined,
      // 会话还活着时比对资产：改过人设/模型/剧本就得重启会话才生效
      assetsStale:
        this.sessionFingerprint !== null && this.assetFingerprint() !== this.sessionFingerprint,
      busy: this.generating,
      contextTokens: this.state === 'stopped' ? undefined : this.currentContextTokens(),
      contextWindow: this.state === 'stopped' ? undefined : this.contextWindow || undefined
    }
  }

  /** 当前上下文估算（tokens）：消息估算 + system/工具表固定开销；条数没变用缓存 */
  private currentContextTokens(): number {
    const messages = this.session?.state.messages
    if (!messages) return 0
    if (this.contextCache.messagesLength !== messages.length) {
      let tokens = this.contextOverhead
      try {
        tokens += estimateContextTokens(messages as readonly Message[]).tokens
      } catch {
        // 估算失败就给出已知开销，别影响状态广播
      }
      this.contextCache = { messagesLength: messages.length, tokens }
    }
    return this.contextCache.tokens
  }

  /** 打断当前这一轮生成（会话保留，下条指令照常来）；没在生成就是空操作 */
  stopGeneration(): void {
    this.session?.abort()
  }

  private setGenerating(value: boolean): void {
    if (this.generating === value) return
    this.generating = value
    this.broadcast(this.status())
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
        // 接入自身的改动（换密钥、改模型列表、调模型窗口）同样要让会话作废
        connection: connection
          ? [connection.providerId, connection.models, connection.params, connection.modelContextWindows]
          : null,
        legacy: [llm.provider, llm.model, llm.apiKey, llm.baseUrl],
        plan: [plan?.id, plan?.personaId, plan?.styleHint, plan?.scriptId, plan?.knowledgeScope],
        // 直播模式（事件接线 + 演法模块）也是出生资产：换模式这场就得重开
        mode: this.modes.fingerprint(plan?.modeId),
        script: script ? [script.title, script.scenes] : null,
        // 主播手册（提示词模板）任何一条改过，活着的会话都得重开才生效
        prompts: this.prompts.fingerprint()
      })
    )
  }

  /** 启动主播会话。解析不出模型时抛清晰中文错误（UI 弹 toast + 引导去设置页）。
   *  restoredMessages：该场次上次存下的会话消息（场次即会话，切回来接着聊）。 */
  async start(purpose: 'live' | 'prep' = 'live', restoredMessages?: AgentMessage[]): Promise<void> {
    if (this.session) return
    // 大脑只用这张卡选的接入与模型；没选时只能临时顶旧配置（预检会把这种情况列成阻断项）
    const resolved = resolveModelForPersona(this.storage, this.persona.get())
    this.setState('starting')
    try {
      this.session = await this.createSession(resolved, restoredMessages)
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.sessionPurpose = purpose
    this.sessionPlanId = this.script.getActive().plan?.id ?? ''
    // 冻结本场事件接线：纯直播不派评论不接触发器，互动直播攒批派评论（模式包运行时现查，换模式重开会话生效）
    this.wiring = this.modes.resolve(this.script.getActive().plan?.modeId).wiring
    this.setState('running')
    this.startedAt = Date.now()
    this.exchanges = 0
    // 新一场总是从"能说话"开始（上一场可能是暂停状态停掉的）
    this.speakingPaused = false
    // 开场白由「开场白」触发器（stream.started → task）负责，见 TriggerRuntime
  }

  /** 把当前会话的消息存进 DB（场次即会话：stop/切场/每轮结束时都存，崩溃也丢不了多少）。
   *  线性消息数组直接 JSON——首位是 system 消息，恢复时剥掉换当前人设卡的。 */
  private persistSession(): void {
    if (!this.session || !this.sessionPlanId) return
    try {
      this.storage.savePlanSession(
        this.sessionPlanId,
        this.sessionPurpose,
        JSON.stringify(this.session.state.messages)
      )
    } catch (error) {
      console.error('[AgentAnchor] 会话落库失败:', error)
    }
  }

  /** 该场次上次存下的会话消息（没有 = 全新对话）。
   *  兼容旧格式：pi-coding-agent 时代的 FileEntry 树形 entries 一次性转成线性消息（我们从不分叉，文件序即时间序）。 */
  private restoredMessagesFor(planId: string): AgentMessage[] | undefined {
    const saved = this.storage.loadPlanSession(planId)
    if (!saved) return undefined
    try {
      const parsed = JSON.parse(saved.entries) as Record<string, unknown>[]
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined
      // 旧格式：元素是 { type: 'session' | 'message' | ..., parentId }；新格式：元素是 { role, content }
      const legacy = typeof parsed[0]?.type === 'string' && !('role' in parsed[0])
      let messages = (
        legacy ? parsed.filter((e) => e.type === 'message').map((e) => e.message) : parsed
      ) as AgentMessage[]
      // 剥掉首部 system 消息：恢复时让当前人设卡的 systemPrompt 重新 prepend（人设改过重开才生效）
      while (messages.length > 0 && (messages[0] as { role?: string }).role === 'system') {
        messages = messages.slice(1)
      }
      // 修剪尾部脏状态：上轮被强杀时末尾可能挂着 error/aborted 的 assistant 消息，带着它恢复没意义
      while (messages.length > 0) {
        const last = messages[messages.length - 1] as { role?: string; stopReason?: string }
        const dirty =
          last.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')
        if (!dirty) break
        messages = messages.slice(0, -1)
      }
      return messages.length > 0 ? messages : undefined
    } catch {
      return undefined
    }
  }

  async stop(): Promise<void> {
    const session = this.session
    if (session) {
      // 下播总结：直播会话有过对话就让主播自我复盘，写进场次摘要；写稿会话不复盘
      if (this.exchanges > 0 && this.state === 'running' && this.sessionPurpose === 'live') {
        await this.summarizeEpisode(session).catch(() => undefined)
      }
      // 场次即会话：关掉之前把会话存回该场次名下，下次切回来/重启接着聊
      this.persistSession()
      try {
        session.abort()
      } catch {
        // 停止时 abort 失败不影响关闭
      }
    }
    this.session = null
    this.sessionFingerprint = null
    this.sessionPlanId = ''
    this.draft = ''
    this.lastComment = null
    this.generating = false
    this.wiring = null
    // 攒批没发出去的评论随会话一起清掉
    if (this.commentBatchTimer) clearTimeout(this.commentBatchTimer)
    this.commentBatchTimer = null
    this.commentBuffer = []
    // 停了就不再收尾当前这一轮（abort 后可能还有事件飘过来）
    this.clearTextTimers()
    this.texts.clear()
    this.currentMessageId = null
    this.lastTextMessageId = null
    this.turnFinalized = true
    this.compactionCardId = null
    this.compacting = false
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start(this.sessionPurpose)
  }

  /** 当前生效的事件接线（TriggerRuntime 也看它：触发器总开关/进场过滤）。会话没跑时按当前场次的模式现解 */
  currentWiring(): LiveModeWiring {
    return this.wiring ?? this.modes.resolve(this.script.getActive().plan?.modeId).wiring
  }

  /** 评论入口（连接器）：主播自己决定回不回、怎么回。老粉画像随评论注入；派不派、怎么派由模式接线决定。 */
  onComment(comment: LiveComment): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    // 写稿会话不接评论：没开播，评论不存在也不该打断写稿
    if (this.sessionPurpose !== 'live') return
    // 暂停期间评论只进事件队列（EventBus 已记下），不派给 LLM（同 docs/07 §8.5 人工接管的处理）
    if (this.speakingPaused) return
    // 先查画像（老粉识别），再记一次互动——纯直播也照记：不打扰主播，但观众资产照攒
    const known = this.memory.lookupViewer(comment.author)
    const isQuestion = /[?？]$/.test(comment.content.trim())
    this.memory.touchViewer(comment.author, isQuestion ? comment.content : undefined)
    const wiring = this.currentWiring()
    // 纯直播：评论根本不派给主播，全身心演自己的
    if (wiring.comments === 'off') return
    this.lastComment = comment
    const profileHint = known ? `老粉：${this.memory.describeViewer(known)}` : '新观众'
    if (wiring.comments === 'batched') {
      // 攒批：窗口内的评论打包成一条派，别让弹幕把主播的节奏切碎
      this.commentBuffer.push({ comment, profileHint })
      if (!this.commentBatchTimer) {
        this.commentBatchTimer = setTimeout(
          () => this.flushCommentBatch(),
          Math.max(3, wiring.commentBatchSec) * 1000
        )
      }
      return
    }
    void this.ask(
      this.prompts.render('user.comment', {
        author: comment.author,
        content: comment.content,
        profileHint: `\n[${profileHint}]`
      })
    )
  }

  /** 攒批窗口到点：打包派给主播。窗口期间停了播/切了暂停就整批丢掉（同逐条派的暂停语义） */
  private flushCommentBatch(): void {
    this.commentBatchTimer = null
    const batch = this.commentBuffer
    this.commentBuffer = []
    if (batch.length === 0) return
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (this.sessionPurpose !== 'live' || this.speakingPaused) return
    const comments = batch
      .map(({ comment, profileHint }) => `- ${comment.author}：「${comment.content}」（${profileHint}）`)
      .join('\n')
    void this.ask(this.prompts.render('user.comment_batch', { comments }))
  }

  /** 触发器入口（docs/01 §3.5）：steer=生成中插一句，task=派一个任务。主播没在跑/已暂停就丢弃。 */
  inject(text: string, mode: 'steer' | 'task'): void {
    if (this.speakingPaused) return
    // 写稿会话不接触发器（开场白/催单这些是直播节拍，写稿时别来打扰）
    if (this.sessionPurpose !== 'live') return
    this.deliver(text, mode)
  }

  /** 实际投递：导演指令绕过暂停检查走这里，其余的入口统一先过暂停闸门 */
  private deliver(text: string, mode: 'steer' | 'task'): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (mode === 'steer' && this.busy) {
      try {
        this.session.steer({ role: 'user', content: text, timestamp: Date.now() } as AgentMessage)
      } catch (error) {
        console.error('[AgentAnchor] steer 失败:', error)
      }
      return
    }
    void this.ask(text)
  }

  /**
   * 导演指令入口（docs/07 §8.8）：最高优先级，生成中就 steer 插队，空闲直接派。
   * 暂停期间照常送达（不然喊不出「继续」）；执行过程与结果由对话时间线照事件流原样呈现。
   */
  directorSay(text: string): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) {
      throw new Error('主播没在跑：先在直播台启动场次')
    }
    this.deliver(this.prompts.render('user.director_wrap', { text }), 'steer')
  }

  /**
   * 导演对话入口（直播台输入框）：选中场次就能聊——没会话时先按当前场次
   * 把主播就位（prep：上下文齐备、播出通道关着），再投递指令。
   * 已有会话（写稿中/直播中）直接投递，不动它。
   */
  async chat(text: string): Promise<void> {
    // 选中场次换了（且不在直播中）：旧会话存回它自己场次名下，切回目标场次原来的对话——
    // 场次即会话，各场次的记录互不串味，切回来还能接着聊
    const activePlanId = this.storage.getConfig().live.activePlanId
    if (this.session && this.sessionPurpose === 'prep' && activePlanId && this.sessionPlanId !== activePlanId) {
      const plan = this.storage.planList().find((p) => p.id === activePlanId)
      await this.stop()
      this.emitNote(`—— 已切到「${plan?.name ?? '新场次'}」，主播带着这场原来的记录就位 ——`)
    }
    await this.ensurePrepSession()
    this.directorSay(text)
  }

  /** 时间线系统提示（换场重开等）：以一段文本条目上屏，不走 LLM */
  private emitNote(text: string): void {
    this.emitTimeline({
      turnId: this.turnId,
      entry: { type: 'text', id: `note-${Date.now()}`, text, final: false }
    })
  }

  /**
   * 时间线条目出口：先按场次落库（ChatEntry 形状，切场/刷新/重启后整段恢复），再广播给渲染层。
   * 落库失败不影响直播。
   */
  private emitTimeline(event: DirectorTimelineEvent): void {
    const planId = this.sessionPlanId || this.storage.getConfig().live.activePlanId
    if (planId) {
      const entry = event.entry
      const ts = Date.now()
      const chat: ChatEntry =
        entry.type === 'text'
          ? { type: 'text', id: entry.id, ts, text: entry.text, final: entry.final ?? false, turnId: event.turnId }
          : entry.type === 'ask'
            ? { type: 'ask', id: entry.id, ts, message: entry.message }
            : {
                type: 'tool',
                id: entry.id,
                ts,
                turnId: event.turnId,
                name: entry.name,
                args: entry.args,
                status: entry.status,
                result: entry.result,
                durationMs: entry.durationMs
              }
      try {
        this.storage.timelineAppend(planId, entry.id, event.turnId, ts, JSON.stringify(chat))
      } catch {
        // 落库失败静默：时间线只是记录，不能反过来影响主播
      }
    }
    this.onDirectorTimeline?.(event)
  }

  /** 主播就位（无会话时）：绑当前选中场次的资产（场次 → 人设 → 音色），恢复该场次存下的对话（没有就新起） */
  private async ensurePrepSession(): Promise<void> {
    if (this.session) return
    const planId = this.storage.getConfig().live.activePlanId
    const plan = planId ? this.storage.planList().find((p) => p.id === planId) : null
    if (!plan) throw new Error('先在上方选一个场次：主播需要知道自己要播哪场，才有上下文')
    this.script.setActivePlan(plan.id)
    if (plan.personaId && plan.personaId !== this.persona.get().id) {
      this.persona.setActive(plan.personaId)
    }
    this.setPlanVoice(plan.voiceId)
    await this.start('prep', this.restoredMessagesFor(plan.id))
  }

  /**
   * 编剧模式（直播前写稿）：主播自己写自己的底稿——跟开播用同一个人设/场次/音色，
   * 区别在于 purpose=prep：say/insert_next 关着，产出只走 write_drafts 进底稿库。
   * 同场次已有写稿会话就复用（多轮续写/改稿），不同场次换场重开；直播中拒绝。
   */
  async startDrafting(planId: string): Promise<void> {
    const plan = this.storage.planList().find((p) => p.id === planId)
    if (!plan) throw new Error('场次不存在')
    const script = this.script.getScript(plan.scriptId)
    if (!script || script.scenes.length === 0) {
      throw new Error('先给场次绑定剧本——写稿按场景逐场产出')
    }
    if (this.session && this.sessionPurpose === 'live') {
      throw new Error('正在直播：写稿先下播，或者用对话直接改底稿')
    }
    // 换场次：旧会话存回它自己场次名下，目标场次恢复它原来的对话接着写；同场次复用
    if (this.session && this.script.getActive().plan?.id !== plan.id) await this.stop()
    // 资产切换跟开播装载同一套：场次 → 人设 → 音色
    this.script.setActivePlan(plan.id)
    if (plan.personaId && plan.personaId !== this.persona.get().id) {
      this.persona.setActive(plan.personaId)
    }
    this.setPlanVoice(plan.voiceId)
    if (!this.session) await this.start('prep', this.restoredMessagesFor(plan.id))
    this.directorSay(this.composeDraftBrief(plan, script))
  }

  /** 写稿任务书：场景行（id/时长/目标段数/要点）代码拼好，主文案走主播手册（user.draft_brief） */
  private composeDraftBrief(plan: LivePlan, script: Script): string {
    const target = planTargetBits(plan, script)
    const { toneHint } = plan.genConfig
    const scenes = script.scenes
      .map(
        (scene, i) =>
          `  ${i + 1}. 「${scene.title}」（sceneId=${scene.id}，约 ${scene.estDurationMin} 分钟，目标 ${target.perScene[i] ?? 0} 段桥段）` +
          `目标：${scene.goal}；要点：${scene.keyPoints.replace(/\n/g, '；')}`
      )
      .join('\n')
    return this.prompts.render('user.draft_brief', {
      plannedMinutes: plan.plannedMinutes,
      total: target.total,
      scenes,
      toneHintLine: toneHint ? `6. 语气：${toneHint}\n` : ''
    })
  }

  /** 急停（配合 renderer 停播放 + 清池）：停会话即可，池由调用方清 */
  async panic(): Promise<void> {
    await this.stop()
  }

  /** 场景推进后广播状态（提词器「当前场景」刷新） */
  notifySceneChanged(): void {
    this.broadcast(this.status())
  }

  // ---------- 对话时间线（docs/09 §11：照事件流原样渲染，不做二次解释） ----------

  /**
   * 新一轮（agent_start）：一次派给主播的任务 = 一轮，含中间文本 + 多轮工具调用 + 最终回复。
   * turnId 形如 turn-m3k9x2-3（runId-序号），本轮内每条 assistant 消息形如 turn-m3k9x2-3-msg-1。
   */
  private beginTurn(): void {
    this.clearTextTimers()
    this.texts.clear()
    this.turnSeq += 1
    this.msgSeq = 0
    this.turnId = `turn-${this.runId}-${this.turnSeq}`
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
    this.emitTimeline({
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
    this.emitTimeline({
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
    this.emitTimeline({
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
    return this.prompts.render('user.scene_prefix', {
      title: scene.title,
      index: index + 1,
      total,
      goal: scene.goal,
      keyPoints: scene.keyPoints
    })
  }

  /** 给主播派一句话：生成中走 steer 插队，空闲走 prompt；失败记状态不崩溃 */
  private async ask(text: string): Promise<void> {
    const session = this.session
    if (!session) return
    const full = this.scenePrefix() + text
    try {
      if (this.busy) {
        session.steer({ role: 'user', content: full, timestamp: Date.now() } as AgentMessage)
        return
      }
      this.busy = true
      this.exchanges += 1
      await session.prompt(full)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 导演按了停止（abort）：不是故障，不进 error 态
      if (!/abort/i.test(message)) {
        console.error('[AgentAnchor] 主播 Agent 调用失败:', message)
        this.setState('error', `LLM 调用失败：${message.slice(0, 200)}`)
        // 会话还活着就留着重试（下一条评论/触发器会再试），不要一报错就死透
      }
    } finally {
      this.busy = false
    }
  }

  /** 下播总结：让主播自我复盘本场亮点/高频问题，写入 episode_summaries。失败静默，不挡下播。 */
  private async summarizeEpisode(session: Agent): Promise<void> {
    const endedAt = Date.now()
    await Promise.race([
      (async () => {
        await session.waitForIdle()
        await session.prompt(this.prompts.render('user.episode_summary'))
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('总结超时')), 30_000))
    ])
    const summary = lastAssistantText(session.state.messages)?.trim()
    if (summary) this.memory.saveEpisodeSummary(this.startedAt, endedAt, summary)
  }

  /** 主播请示（ask_director）：高亮卡片走对话时间线单通道（与文本/工具同路，切场/重启后还在）；不阻塞直播（docs/07 §8.8.6 ④） */
  private handleDirectorAsk(ask: {
    text: string
    options: string[]
    timeoutSec: number
    defaultAction?: string
  }): void {
    const message: DirectorMessage = {
      id: `dm-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      ts: Date.now(),
      kind: 'ask',
      text: ask.text,
      options: ask.options,
      timeoutSec: ask.timeoutSec,
      defaultAction: ask.defaultAction
    }
    this.emitTimeline({ turnId: this.turnId, entry: { type: 'ask', id: message.id, message } })
  }

  // ---------- 上下文压缩（transformContext 钩子：超过阈值就把旧消息摘要成一条） ----------

  /**
   * 压缩阈值：窗口 - reserve。reserve 取 16k 与窗口 40% 的小者——窗口配置偏小时留的比例不变，
   * 否则「system prompt + 22 个工具的 schema」这个地板就可能比阈值还高，压完立刻又超，每轮白压一遍。
   */
  private compactThreshold(contextWindow: number): number {
    return contextWindow - Math.min(COMPACT_RESERVE_TOKENS, Math.floor(contextWindow * 0.4))
  }

  /**
   * 每次 LLM 请求前调用。估算 tokens 超「窗口 - reserve」就压缩：
   * 旧消息发给同一模型摘要成一条「前情摘要」user 消息，连同最近对话一起替换 state.messages（持久生效），
   * 同时清屏 + 上压缩卡（有多少聊天记录 = 实际有多长上下文）。摘要失败硬截断保命，长直播不死。
   */
  private async compactIfNeeded(
    agent: Agent,
    messages: AgentMessage[],
    contextWindow: number,
    model: Model<'openai-completions'>,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<AgentMessage[]> {
    if (this.compacting) return messages
    let tokensBefore: number
    try {
      tokensBefore = estimateContextTokens(messages as readonly Message[]).tokens
    } catch {
      return messages
    }
    if (tokensBefore <= this.compactThreshold(contextWindow)) return messages
    this.compacting = true
    try {
      const system = (messages[0] as { role?: string })?.role === 'system' ? messages[0] : undefined
      const body = system ? messages.slice(1) : messages.slice()
      // 切分点只落在 user 消息上（不拆散 assistant 的 toolCall 与它的 toolResult）：
      // 从尾部往前往返，保留额度用光时停在最近一条 user；保留额度取「阈值的一半」与固定值的小者，
      // 保证压完真的低于阈值（否则窗口配置偏小时会每轮都压一遍，永远停不下来）
      const keepLimit = Math.min(
        COMPACT_KEEP_RECENT_TOKENS,
        Math.max(2000, Math.floor(this.compactThreshold(contextWindow) / 2))
      )
      let keepTokens = 0
      let split = -1
      for (let i = body.length - 1; i >= 0; i--) {
        keepTokens += estimateMsgTokens(body[i])
        if ((body[i] as { role?: string }).role === 'user') {
          split = i
          if (keepTokens > keepLimit) break
        }
      }
      // 没啥可压：旧部分为空（全部对话都在保留额度内）——放弃这次，也别上卡片
      if (split <= 0) return messages
      const oldPart = body.slice(0, split)
      // 保留区钳制：一条巨型消息（全量列表/长文类的工具结果）就能把压完的上下文重新顶过阈值，
      // 死循环压缩——超大文本一律截断，只动文本不动结构（角色与工具配对保持完整）
      const recent = clampOversizedMessages(body.slice(split))
      this.beginCompactionCard()

      let noteText: string
      try {
        const transcript = oldPart
          .map(renderMessageForSummary)
          .join('\n')
          .slice(-SUMMARY_TRANSCRIPT_MAX_CHARS)
        const summaryMessage: UserMessage = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: this.prompts.render('compact.summary_prompt', { transcript })
            }
          ],
          timestamp: Date.now()
        }
        // 摘要是非流式一次性调用：用 retryAssistantCall 做应用层重试（瞬断自动再来，quota 类错误快速失败）
        const result = await retryAssistantCall(
          async () => {
            const stream = await streamSimple(
              model,
              normalizeContext({ messages: [summaryMessage] }),
              { apiKey, timeoutMs: LLM_TIMEOUT_MS, maxRetries: 2, signal }
            )
            return stream.result()
          },
          { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
          signal
        )
        const summaryText = result.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
          .trim()
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || !summaryText) {
          throw new Error(result.errorMessage ?? '摘要为空')
        }
        noteText = this.prompts.render('compact.summary_note', { summary: summaryText })
      } catch (error) {
        // 摘要失败：硬截断保命（插一条说明消息顶替旧部分），卡片如实标错
        console.error('[AgentAnchor] 上下文压缩的摘要失败，改硬截断:', error)
        this.endCompactionError(
          `摘要失败（${error instanceof Error ? error.message.slice(0, 120) : String(error)}），已直接丢弃最旧记录`
        )
        noteText = this.prompts.render('compact.overflow_note')
        const note: UserMessage = {
          role: 'user',
          content: [{ type: 'text', text: noteText }],
          timestamp: Date.now()
        }
        agent.state.messages = this.assembleCompacted(system, note as AgentMessage, recent, contextWindow)
        this.persistSession()
        return agent.state.messages
      }

      const note: UserMessage = {
        role: 'user',
        content: [{ type: 'text', text: noteText }],
        timestamp: Date.now()
      }
      agent.state.messages = this.assembleCompacted(system, note as AgentMessage, recent, contextWindow)
      this.endCompactionOk(tokensBefore)
      this.persistSession()
      return agent.state.messages
    } finally {
      this.compacting = false
    }
  }

  /**
   * 组装压缩后的会话并保证「压完必降」：极端情况下保留区条数太多仍超阈值，
   * 从保留区头部整条丢（丢带工具调用的 assistant 时连同它后面的工具结果一起丢，免得上游 400）。
   */
  private assembleCompacted(
    system: AgentMessage | undefined,
    note: AgentMessage,
    recent: AgentMessage[],
    contextWindow: number
  ): AgentMessage[] {
    const threshold = this.compactThreshold(contextWindow)
    let kept = recent
    const over = (): boolean => {
      try {
        const probe = [...(system ? [system] : []), note, ...kept]
        return estimateContextTokens(probe as readonly Message[]).tokens > threshold
      } catch {
        return false
      }
    }
    while (kept.length > 0 && over()) {
      const [dropped, ...rest] = kept
      kept = rest
      const content = (dropped as { content?: unknown }).content
      const hadToolCall =
        Array.isArray(content) && content.some((p) => (p as { type?: string }).type === 'toolCall')
      if (hadToolCall) {
        while (kept.length > 0 && (kept[0] as { role?: string }).role === 'toolResult') {
          kept = kept.slice(1)
        }
      }
    }
    return [...(system ? [system] : []), note, ...kept]
  }

  /** 压缩开始：上时间线卡片让导演知道主播在"整理笔记" */
  private beginCompactionCard(): void {
    this.compactionCardId = `compaction-${Date.now()}`
    this.emitTimeline({
      turnId: this.turnId,
      entry: {
        type: 'tool',
        id: this.compactionCardId,
        name: 'context_compact',
        args: '上下文接近上限，把旧消息整理成摘要',
        status: 'running'
      }
    })
  }

  /** 压缩成功：可见历史全清（只留这张压缩卡）：有多少聊天记录 = 实际有多长上下文，所见即所得 */
  private endCompactionOk(tokensBefore: number): void {
    const id = this.compactionCardId
    this.compactionCardId = null
    if (!id) return
    const planId = this.sessionPlanId || this.storage.getConfig().live.activePlanId
    if (planId) this.storage.timelineClear(planId)
    const card: ChatEntry = {
      type: 'tool',
      id,
      ts: Date.now(),
      turnId: this.turnId,
      name: 'context_compact',
      status: 'ok',
      result: `压缩前约 ${Math.round(tokensBefore / 1000)}k tokens → 摘要 + 最近对话继续（不丢价格/口径等已查证事实）`
    }
    if (planId) {
      try {
        this.storage.timelineAppend(planId, id, this.turnId, card.ts, JSON.stringify(card))
      } catch {
        // 落库失败静默
      }
    }
    this.onDirectorTimeline?.({ type: 'reset', entries: [card] })
  }

  /** 压缩失败：卡片标错（随后会硬截断，直播继续） */
  private endCompactionError(detail: string): void {
    const id = this.compactionCardId
    this.compactionCardId = null
    if (!id) return
    this.emitTimeline({
      turnId: this.turnId,
      entry: { type: 'tool', id, name: 'context_compact', status: 'error', result: detail, isError: true }
    })
  }

  private async createSession(resolved: ResolvedModel, restoredMessages?: AgentMessage[]): Promise<Agent> {
    const { model, apiKey, modelLabel, contextWindow } = await prepareLlmModel(resolved)
    this.modelLabel = modelLabel
    // 记下出生时的资产指纹：之后 UI 靠它判断"本场是不是旧版本"
    this.sessionFingerprint = this.assetFingerprint()

    const persona = this.persona.get()
    const { plan, script } = this.script.getActive()
    const mode = this.modes.resolve(plan?.modeId)
    // 人设卡的音色即主播的嗓子，必选；没选时不留兜底，合成路由会直接报错（预检也会拦下）
    const systemPrompt = this.persona.buildSystemPrompt(persona, plan, script, mode.promptModule)
    // 上下文仪表：窗口 + 固定开销（system prompt + 工具表 schema）出生时就位
    this.contextWindow = contextWindow
    this.contextOverhead =
      estimateMsgTokens({
        role: 'user',
        content: [{ type: 'text', text: systemPrompt }],
        timestamp: 0
      } as unknown as AgentMessage) + TOOL_SCHEMA_OVERHEAD_TOKENS
    this.contextCache = { messagesLength: -1, tokens: 0 }

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: 'off',
        // 只挂主播工具：core 没有内置工具，给什么就是什么
        tools: buildAnchorTools({
          pool: this.pool,
          knowledge: this.knowledge,
          memory: this.memory,
          persona: this.persona,
          script: this.script,
          utterances: this.utterances,
          getLastComment: () => this.lastComment,
          onSceneChanged: () => this.notifySceneChanged(),
          getPlanVoice: () => this.planVoiceId,
          onSceneAdvanced: (sceneIndex) => this.onSceneAdvanced?.(sceneIndex),
          onDirectorAsk: (ask) => this.handleDirectorAsk(ask),
          setPlanVoice: (voiceId) => this.setPlanVoice(voiceId),
          onPlaybackControl: (action) => this.onPlaybackControl?.(action),
          getSpeakingPaused: () => this.speakingPaused,
          getPurpose: () => this.sessionPurpose,
          onGoLive: async () => this.onGoLive?.() ?? '开播通道没接上，让导演从界面点「启动场次」'
        }),
        // 场次即会话：恢复时把该场次存下的消息重建进内存会话，上下文原样回来
        messages: restoredMessages
      },
      // 凭据/超时随 stream options 注入：httpIdleTimeoutMs → timeoutMs（60s）；重试靠传输层 maxRetries
      // （应用层 retryAssistantCall 是消息级的，包主链路会丢掉流式——coding-agent 也只把它用在摘要调用上）
      streamFn: (mdl, context, options) =>
        streamSimple(mdl as Model<'openai-completions'>, context, {
          ...options,
          apiKey,
          timeoutMs: LLM_TIMEOUT_MS,
          maxRetries: 2
        }),
      transformContext: (messages, signal) =>
        this.compactIfNeeded(agent, messages, contextWindow, model, apiKey, signal)
    })

    agent.subscribe((event) => {
      const assistantEvent = event.type === 'message_update' ? event.assistantMessageEvent : undefined
      if (assistantEvent?.type === 'text_delta') {
        // 生成中预览：累积 text_delta —— 既给提词器，也是对话时间线里"正在说话"的那一段
        this.draft += assistantEvent.delta
        this.appendText(assistantEvent.delta)
        this.broadcast(this.status())
      } else if (event.type === 'agent_start') {
        this.beginTurn()
        this.setGenerating(true)
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
        this.setGenerating(false)
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
        // 场次即会话：每轮落一次库，崩溃/强杀也丢不了多少
        this.persistSession()
      } else if (event.type === 'message_end') {
        // 这条消息说完了：把节流压着的尾巴推出去（还接着调工具时，它仍是中间文本）
        this.flushText()
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      }
    })

    return agent
  }
}

/** 短指纹（djb2）：只用来判断"资产变没变"，不承担安全职责，避免把密钥原样留在内存字符串里 */
function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(16)
}

/** 末条 assistant 消息的正文（下播总结用） */
function lastAssistantText(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .map((part) => {
        const p = part as { type?: string; text?: string }
        return p.type === 'text' ? (p.text ?? '') : ''
      })
      .join('')
      .trim()
    if (text) return text
  }
  return undefined
}

/** 单条消息的粗估 tokens：中文按字算（≈1 token/字），其余按 4 字符 ≈ 1 token。
 *  pi-ai 的 estimateMessageTokens 是 chars/4，对中文小三倍不止，切分保留额度会虚放大。 */
function estimateMsgTokens(message: AgentMessage): number {
  const m = message as { content?: unknown }
  let text = ''
  if (typeof m.content === 'string') {
    text = m.content
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; name?: string; arguments?: unknown }
      if (p.type === 'text' && p.text) text += p.text
      else if (p.type === 'toolCall') text += (p.name ?? '') + JSON.stringify(p.arguments ?? '')
    }
  }
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x2e7f) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4) + 8
}

/** 压缩保留区的超大消息钳制：单条文本超过这个长度就截断（只动文本，不动消息结构） */
const CLAMP_MESSAGE_CHARS = 4000

/**
 * 超大消息截断：一条巨型工具结果（全量列表/长文）就能把压完的上下文重新顶过阈值造成死循环。
 * 只截文本内容，角色、toolCall/toolResult 配对等结构原样保留。
 */
function clampOversizedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const m = message as { content?: unknown }
    if (typeof m.content === 'string') {
      return m.content.length > CLAMP_MESSAGE_CHARS
        ? ({ ...message, content: `${m.content.slice(0, CLAMP_MESSAGE_CHARS)}…（超长已截断）` } as AgentMessage)
        : message
    }
    if (!Array.isArray(m.content)) return message
    let changed = false
    const content = m.content.map((part) => {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string' && p.text.length > CLAMP_MESSAGE_CHARS) {
        changed = true
        return { ...(part as Record<string, unknown>), text: `${p.text.slice(0, CLAMP_MESSAGE_CHARS)}…（超长已截断）` }
      }
      return part
    })
    return changed ? ({ ...message, content } as AgentMessage) : message
  })
}

/** 把一条消息渲染成摘要模型看得懂的一行（压缩时喂旧对话用） */
function renderMessageForSummary(message: AgentMessage): string {
  const m = message as { role?: string; content?: unknown; toolName?: string }
  const roleLabel =
    m.role === 'user' ? '导演/观众' : m.role === 'assistant' ? '主播' : m.role === 'toolResult' ? `工具结果(${m.toolName ?? ''})` : '系统'
  const parts: string[] = []
  if (typeof m.content === 'string') {
    parts.push(m.content)
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; name?: string }
      if (p.type === 'text' && p.text) parts.push(p.text)
      else if (p.type === 'toolCall') parts.push(`[调用工具 ${p.name ?? ''}]`)
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return `${roleLabel}: ${text.slice(0, 300)}`
}

/**
 * 把工具的入参/结果压成一行短摘要给工具卡片用（渲染层只展示一行，全文放 title）。
 * 工具结果是 `{ content: [{ type: 'text', text }] }`，直接抽文本比 JSON 好读得多。
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
