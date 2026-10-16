import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  normalizeContext,
  retryAssistantCall,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type UserMessage
} from '@earendil-works/pi-ai'
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  type AgentStatus,
  type ChatEntry,
  type DirectorMessage,
  type DirectorTimelineEntry,
  type DirectorTimelineEvent,
  type DirectorTimelineReset,
  type LiveComment,
  type Persona,
  type PlaybackControlAction,
  type Program,
  type Script,
  type UsageKind
} from '../../shared/types'
import { StorageService } from './StorageService'
import type { SpeechPool } from './SpeechPool'
import type { ConnectorService } from './ConnectorService'
import type { PersonaService } from './PersonaService'
import type { PromptTemplateService } from './PromptTemplateService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { ScriptService } from './ScriptService'
import type { UtteranceService } from './UtteranceService'
import { buildAnchorTools } from './anchorTools'
import { buildAnchorSystemTools } from './anchorSystemTools'
import { LiveEventInbox, type LiveInboxEvent } from './LiveEventInbox'
import { prepareLlmModel, resolveModelForDirector, streamLlmModel } from './llmModel'
import { clampOversizedMessages, estimateMsgTokens, oneLine, renderMessageForSummary } from './agentText'
import type { LlmApi, ResolvedModel } from './providers/registry'
import type { VoiceService } from './VoiceService'
import type { TriggerRuntime } from './TriggerRuntime'
import type { StreamService } from './stream/StreamService'
import type { ExportService } from './ExportService'

/**
 * 导演 Agent（单脑架构）：唯一话术生产者。恒定导演身份，从不开口——
 * 卡司（主播卡）只是它手上的资料与嗓音，谁出镜由 say 的 role 决定。
 * - 引擎：pi-agent-core 的 Agent 裸用。会话树/models.json/资源发现都不存在也不需要——
 *   全局唯一会话自己存 SQLite（线性消息数组，key 固定 'director'），system prompt 是导演手册 + 卡司表 + 节目
 * - 只挂主播工具（anchorTools，一切声音走话术池）；core 没有内置工具，不用 allowlist
 * - 模型：手工构造 Model（OpenAI 兼容 completions / OpenAI Responses，由接入协议决定），凭据随 stream options 注入不落盘；我们的 config 里 secretBox 加密
 * - 上下文压缩：transformContext 钩子里自研——估算超阈值就把旧消息发给 LLM 摘要，替换 state.messages
 * - text_delta 既累积成"AI 正在组织语言"预览（提词器），也推给对话时间线（docs/09 §11）
 * - 对话时间线照事件流原样渲染：文本流式 / 工具卡片 / 请示卡片，不做二次解释（thinking_delta 不渲染）
 */

/**
 * 节目事件接线：由节目字段决定，会话启动时冻结、开播装载时刷新（换节目不重启会话）。
 * allowLiveEvents=false → 评论/礼物/进场不派给 Agent；enabledTriggerIds → TriggerRuntime 只响这些触发器；
 * broadcastMode → 水位类触发器（pool.empty/pool.low）在预制节目里不放行（播完/循环是引擎决策，不需要主播救场）。
 */
export interface ProgramGate {
  allowLiveEvents: boolean
  enabledTriggerIds: string[]
  broadcastMode: Program['broadcastMode'] | null
}

/** 从节目字段取事件接线（没选节目 = 动态不派、触发器不响） */
function gateOfProgram(program: Program | null | undefined): ProgramGate {
  return {
    allowLiveEvents: program?.allowLiveEvents ?? false,
    enabledTriggerIds: program?.enabledTriggerIds ?? [],
    broadcastMode: program?.broadcastMode ?? null
  }
}

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

/**
 * 工具按场景裁剪：黑名单命中的工具不进会话——schema 不占上下文、模型也看不到，
 * 减少误调；工具内部的运行时门禁（isLiveActive/getSpeakingPaused 等）保留兜底，裁剪只是省 token 不是安全边界。
 * - 即兴节目（现场发挥）：没有底稿概念，底稿族（写稿 + 底稿 CRUD）全裁，挂上去只会引诱模型写稿
 * - 其余场景：全量保留。没开播时 say/insert_next 由运行时门禁拦下（播出通道关着）
 */
const IMPROVISED_TOOL_EXCLUDE: ReadonlySet<string> = new Set([
  'write_bits',
  'list_drafts',
  'edit_draft',
  'add_draft',
  'remove_draft',
  'clear_drafts'
])

/**
 * 工具表 schema 的粗估开销（tokens）：每个工具的 name+label+description+参数 schema 的 JSON 字符数 ÷ 4
 * （与 pi-ai 的上下文估算同口径；中文描述按字符算偏低估，状态栏进度条仅供参考）。
 * 裁剪后按实际进会话的工具算：全量 64 个约 8k，即兴节目裁掉底稿族后更少，不再是固定常数。
 */
function estimateToolSchemaTokens(tools: readonly AgentTool[]): number {
  let chars = 0
  for (const tool of tools) {
    try {
      chars += JSON.stringify({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters
      }).length
    } catch {
      chars += 400
    }
  }
  return Math.ceil(chars / 4)
}

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
  /** 节目开播态（引擎语义，与 agent 会话解耦）：launch 置真、结束节目置假；播出通道/事件派发只看它 */
  private liveActive = false
  /** 最近一条待回应评论（insert_next 工具挂 replyTo 用） */
  private lastComment: LiveComment | null = null
  /** 本场开播时间（下播总结用） */
  private startedAt = 0
  /** 本场发生过几轮对话（没对话就不写总结） */
  private exchanges = 0
  /** 本场运行态段间留白（set_gap 工具可热改；-1 = 跟随系统默认 config.live.bitGapMs） */
  private programGapMs = -1
  /** 播报是否被暂停：暂停时评论/触发器不再派给 LLM，say 也说不出去（统一开播控制里的「暂停」） */
  private speakingPaused = false
  /** 本场的事件接线（由节目字段决定，会话启动时冻结、开播装载时刷新） */
  private programGate: ProgramGate | null = null
  /**
   * 直播间动态收件箱（docs/10 §5.3）：评论/内容类触发器通知统一进箱，
   * 去重/过滤/归组/聚合唤醒/限速由它管；flush 出来的批次文本派给主播，回不回由主播定。
   * flush 只由事件驱动：没有新动态时不唤醒、不产生 LLM 请求。
   */
  private readonly inbox = new LiveEventInbox({
    isAgentBusy: () => this.busy,
    flush: (batchText, events) => this.deliverInboxBatch(batchText, events)
  })
  /** 收件箱变更广播钩子（index.ts 接上，直播台「事件流」用；节流也在那边做） */
  onInboxChange: (() => void) | null = null

  /** 收件箱快照（新的在前），给 IPC `agent:inbox` 用 */
  inboxSnapshot(): LiveInboxEvent[] {
    return this.inbox.snapshot()
  }
  /** 场景推进后的补装钩子（ProgramPlaybackService 接上：整库装载去重兜底，骨架不断档） */
  onSceneAdvanced: ((sceneIndex: number) => void) | null = null
  /** 主播自己开播（start_live 工具）：ProgramPlaybackService 接上，返回给主播看的成败说明 */
  onGoLive: (() => Promise<string>) | null = null
  /** 播报控制（pause/resume/skip）→ 广播到渲染进程执行 */
  onPlaybackControl: ((action: PlaybackControlAction) => void) | null = null
  /** 平台连接器（index.ts 在 ConnectorService 建好之后接上：连接器生于 Agent 之后） */
  getConnector: (() => ConnectorService | null) | null = null
  /** 音色库 / 触发器库 / 推流（系统控制工具用；都生于 Agent 之后，由 index.ts 接上） */
  getVoices: (() => VoiceService | null) | null = null
  getTriggers: (() => TriggerRuntime | null) | null = null
  getStream: (() => StreamService | null) | null = null
  /** 节目音频导出（export_program 工具；ExportService 生于 Agent 之后，由 index.ts 接上） */
  getExporter: (() => ExportService | null) | null = null
  /** 紧急停止总闸（emergency_stop 工具）：index.ts 接上——掐声音 + 停播放循环 + 停会话 */
  onEmergencyStop: (() => Promise<void>) | null = null
  /** 当前场次 id（场记；ProgramPlaybackService.launch 开播时写入）：下播复盘摘要挂到这场 */
  broadcastSessionId: string | null = null
  /** 当前会话的模型是否开了多模态（出生时的模型级配置；没开图像附件不进会话） */
  private visionCapable = false

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
  /** 思考流快照（thinking_delta 累积，按消息 id upsert 到时间线的「思考过程」条目） */
  private thinkings = new Map<
    string,
    { turnId: string; text: string; sent: string; done: boolean; startedAt: number; timer?: NodeJS.Timeout }
  >()
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
  /** 会话出生时的用量归属（成本采集）：接入/模型在会话期间不变（变更走重开会话） */
  private usageConnectionId = ''
  private usageModel = ''
  /** system prompt + 工具表的固定开销（tokens，会话出生时估一次） */
  private contextOverhead = 0
  /** 上下文估算缓存：消息条数没变就不重算（status 广播很勤，全量估算不便宜）；
   *  生成中（text_delta 不停进）每 2 秒兜底重估一次，不然流式期间仪表像死的 */
  private contextCache: { messagesLength: number; tokens: number; at: number } = {
    messagesLength: -1,
    tokens: 0,
    at: 0
  }

  /**
   * 状态里"重字段"的缓存：资产指纹（要 hash 全部提示词模板）、当前场景、卡司名、事件接线
   * ——这几项都得读库/算 hash，而 status() 会被每个 text_delta 触发。缓存 1 秒：
   * 黄条/场景/接线这类信息晚 1 秒无所谓，但省掉的同步查库与 hash 是实打实的。
   */
  private statusHeavyCache: {
    at: number
    assetsStale: boolean
    personaName: string | undefined
    scene: AgentStatus['scene']
    enabledTriggerIds: string[]
    allowLiveEvents: boolean
  } | null = null

  /** 状态广播节流：delta 密集时几十次/秒，合并成 ~8 次/秒（UI 看不出差别，主进程与 IPC 省一大截） */
  private statusTimer: NodeJS.Timeout | null = null

  private heavyStatus(): NonNullable<AgentService['statusHeavyCache']> {
    const now = Date.now()
    if (this.statusHeavyCache && now - this.statusHeavyCache.at < 1000) return this.statusHeavyCache
    const current = this.state === 'stopped' ? null : this.script.currentScene()
    const gate = this.currentProgramGate()
    this.statusHeavyCache = {
      at: now,
      assetsStale: this.assetsStale(),
      personaName: this.state === 'stopped' ? undefined : this.persona.get().name,
      scene: current ? { title: current.scene.title, index: current.index, total: current.total } : undefined,
      enabledTriggerIds: gate.enabledTriggerIds,
      allowLiveEvents: gate.allowLiveEvents
    }
    return this.statusHeavyCache
  }

  /** 丢弃重字段缓存（接线/资产/会话状态变了就调，别让 UI 慢一秒才反应过来） */
  private invalidateStatusHeavy(): void {
    this.statusHeavyCache = null
  }

  /** 流式期间的广播入口：合并到 ~120ms 一次（脏了就排一次，不重复排队） */
  private broadcastStatusThrottled(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.broadcast(this.status())
    }, 120)
    this.statusTimer.unref?.()
  }

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
    private readonly prompts: PromptTemplateService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly script: ScriptService,
    private readonly utterances: UtteranceService,
    private readonly broadcast: (status: AgentStatus) => void,
    private readonly onDirectorTimeline?: (event: DirectorTimelineEvent | DirectorTimelineReset) => void
  ) {
    this.inbox.onChange = () => this.onInboxChange?.()
  }

  /** 设置本场段间留白（set_gap 工具；0 = 回系统默认） */
  setProgramGap(gapMs: number): void {
    this.programGapMs = gapMs > 0 ? gapMs : -1
  }

  /** 当前生效的段间留白（PlaybackLoop 每次取）：agent 调过用它的，没调返回 undefined 走系统默认 */
  currentGapMs(): number | undefined {
    return this.state !== 'stopped' && this.programGapMs > 0 ? this.programGapMs : undefined
  }

  /** 当前出镜主播的嗓音（PlaybackLoop/触发器每次取）：即当前主播卡的音色 */
  currentVoice(): string {
    return this.persona.get().voiceId
  }

  /**
   * 暂停/恢复主播产出。暂停时：评论不再派给 LLM、触发器不触发、say/insert_next 被拒
   * （说出去的话收不回，所以宁可不生成）；导演指令照常送达，随时可以喊「继续」。
   */
  setSpeakingPaused(paused: boolean): void {
    this.speakingPaused = paused
    // 暂停态进状态广播：渲染层的「播报中/已暂停」以主进程为准（重启后不失真）
    this.broadcast(this.status())
  }

  /** 开播态开关（ProgramPlaybackService/结束节目用）：「这场在播」归引擎管，不归 agent 会话死活 */
  setLiveActive(active: boolean): void {
    this.liveActive = active
    this.broadcast(this.status())
  }

  /** 开播时冻结的资产指纹：会话出生时读了一次导演/卡司/剧本，之后不再读（docs/07 §8.5） */
  private sessionFingerprint: string | null = null

  status(): AgentStatus {
    // 重字段走 1 秒缓存（这一句把"每个 delta 查库 + hash 模板"变成"每秒一次"）
    const heavy = this.heavyStatus()
    return {
      state: this.state,
      error: this.error,
      model: this.modelLabel,
      personaName: heavy.personaName,
      draft: this.draft,
      scene: heavy.scene,
      // 会话还活着时比对资产：改过导演/卡司/剧本就得重启会话才生效
      assetsStale: heavy.assetsStale,
      busy: this.generating,
      contextTokens: this.state === 'stopped' ? undefined : this.currentContextTokens(),
      contextWindow: this.state === 'stopped' ? undefined : this.contextWindow || undefined,
      live: this.liveActive,
      speakingPaused: this.speakingPaused,
      // 当前生效的自动响应白名单（引擎侧真值，播出中改节目配置后立刻反映在这里）
      enabledTriggerIds: heavy.enabledTriggerIds,
      allowLiveEvents: heavy.allowLiveEvents
    }
  }

  /** 当前上下文估算（tokens）：消息估算 + system/工具表固定开销；条数没变用缓存，生成中超 2 秒重估 */
  private currentContextTokens(): number {
    const messages = this.session?.state.messages
    if (!messages) return 0
    const stale = this.generating && Date.now() - this.contextCache.at > 2000
    if (this.contextCache.messagesLength !== messages.length || stale) {
      let tokens = this.contextOverhead
      try {
        tokens += estimateContextTokens(messages as readonly Message[]).tokens
      } catch {
        // 估算失败就给出已知开销，别影响状态广播
      }
      this.contextCache = { messagesLength: messages.length, tokens, at: Date.now() }
    }
    return this.contextCache.tokens
  }

  /** 打断当前这一轮生成（会话保留，下条指令照常来）；没在生成就是空操作 */
  stopGeneration(): void {
    this.session?.abort()
    // 中断不会有正常的收尾事件：思考/文本条目就地定稿，别让时间线卡在「思考中…」
    this.flushText()
  }

  private setGenerating(value: boolean): void {
    if (this.generating === value) return
    this.generating = value
    this.broadcast(this.status())
  }

  /** 本场卡司：节目定了卡司（presenterIds）就按它，空数组 = 导演自选（全部主播卡都是候选人） */
  private currentCast(program: Program | null | undefined): { cast: Persona[]; castAuto: boolean } {
    const all = this.persona.list()
    const ids = program?.presenterIds ?? []
    if (ids.length === 0) return { cast: all, castAuto: true }
    return { cast: all.filter((p) => ids.includes(p.id)), castAuto: false }
  }

  /**
   * 会话出生时组装进 system prompt 的资产（导演/卡司/节目/剧本/导演手册）跟现在对不上了：
   * 得重开会话才生效。写稿、开播这类"必须有准头"的动作会自动重开（见 startDrafting / launch）。
   */
  assetsStale(): boolean {
    return this.sessionFingerprint !== null && this.assetFingerprint() !== this.sessionFingerprint
  }

  /**
   * 资产指纹：凡是「出生时组装进 system prompt 或模型 provider」的东西都算。
   * 不含音色——音色是每条话术现算的（resolveVoice 每次读当前值），改了立刻对后说的生效。
   * 也不含「当前出镜」指针——switchPresenter 换人不换脑，不需要重启会话（上下文说明会追加进会话）。
   */
  private assetFingerprint(): string {
    const { program, script } = this.script.getActive()
    const cfg = this.storage.getConfig()
    const { cast, castAuto } = this.currentCast(program)
    const connection = cfg.director.modelConnectionId
      ? this.storage.connectionGet(cfg.director.modelConnectionId)
      : null
    return fingerprint(
      JSON.stringify({
        director: cfg.director,
        // 接入自身的改动（换密钥、改模型列表、调模型窗口）同样要让会话作废
        connection: connection
          ? [connection.providerId, connection.models, connection.params, connection.modelContextWindows]
          : null,
        // 卡司内容（哪几张卡 + 卡里写了什么）；castAuto=导演自选时是全量名单
        castAuto,
        cast: cast.map((p) => [p.id, p.name, p.personality, p.catchphrases, p.background, p.taboos]),
        program: program
          ? [
              program.id,
              program.name,
              program.theme,
              program.contentType,
              program.broadcastMode,
              program.finishMode,
              program.allowLiveEvents,
              program.enabledTriggerIds,
              program.audioConfig,
              program.scriptId,
              program.knowledgeScope,
              program.presenterIds
            ]
          : null,
        script: script ? [script.title, script.scenes] : null,
        // 导演手册（提示词模板）任何一条改过，活着的会话都得重开才生效
        prompts: this.prompts.fingerprint()
      })
    )
  }

  /** 启动导演会话。解析不出模型时抛清晰中文错误（UI 弹 toast + 引导去设置页）。
   *  restoredMessages：恢复用的历史消息；不传 = 读全局会话存档（单会话滚动存档，重开接着聊）。 */
  async start(restoredMessages?: AgentMessage[]): Promise<void> {
    if (this.session) return
    // 大脑只看导演配置（设置 → 语言模型里那份）；没配好这里抛错，预检也会拦
    const resolved = resolveModelForDirector(this.storage, this.storage.getConfig().director)
    this.setState('starting')
    try {
      this.session = await this.createSession(resolved, restoredMessages ?? this.restoredMessages())
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    }
    // 冻结本场事件接线：由当前节目字段决定（开播装载时刷新；换节目不重启会话）
    this.programGate = gateOfProgram(this.script.getActive().program)
    this.setState('running')
    this.startedAt = Date.now()
    this.exchanges = 0
    // 新一场总是从"能说话"开始（上一场可能是暂停状态停掉的）
    this.speakingPaused = false
    // 没有开场白触发器：开场由底稿 hook 段承担（按创作序第一个播）；0 就绪开播由引擎低水位续写现场顶
  }

  /** 把当前会话的消息存进 DB（全局单会话：key 固定 'director'，stop/每轮结束时都存，崩溃也丢不了多少）。
   *  线性消息数组直接 JSON——首位是 system 消息，恢复时剥掉换当前导演手册的。
   *  purpose 列只是存档时刻的开播态快照（live/prep），不再决定会话归属。 */
  private persistSession(): void {
    if (!this.session) return
    try {
      this.storage.saveProgramSession(
        StorageService.DIRECTOR_SESSION_KEY,
        this.liveActive ? 'live' : 'prep',
        JSON.stringify(this.session.state.messages)
      )
    } catch (error) {
      console.error('[AgentAnchor] 会话落库失败:', error)
    }
  }

  /** 全局会话上次存下的消息（没有 = 全新对话）。
   *  兼容旧格式：pi-coding-agent 时代的 FileEntry 树形 entries 一次性转成线性消息（我们从不分叉，文件序即时间序）。 */
  private restoredMessages(): AgentMessage[] | undefined {
    const saved = this.storage.loadProgramSession(StorageService.DIRECTOR_SESSION_KEY)
    if (!saved) return undefined
    try {
      const parsed = JSON.parse(saved.entries) as Record<string, unknown>[]
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined
      // 旧格式：元素是 { type: 'session' | 'message' | ..., parentId }；新格式：元素是 { role, content }
      const legacy = typeof parsed[0]?.type === 'string' && !('role' in parsed[0])
      let messages = (
        legacy ? parsed.filter((e) => e.type === 'message').map((e) => e.message) : parsed
      ) as AgentMessage[]
      // 剥掉首部 system 消息：恢复时让当前导演手册重新 prepend（手册/卡司改过重开才生效）
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

  async stop(opts?: { skipSummarize?: boolean }): Promise<void> {
    const session = this.session
    if (session) {
      // 下播总结：开播过且有过对话就让导演自我复盘，写进场次摘要；纯写稿的会话不复盘
      if (!opts?.skipSummarize && this.exchanges > 0 && this.state === 'running' && this.liveActive) {
        await this.summarizeEpisode(session).catch(() => undefined)
      }
      // 全局单会话：关掉之前把会话存回存档，下次就位/重启接着聊
      this.persistSession()
      try {
        session.abort()
      } catch {
        // 停止时 abort 失败不影响关闭
      }
    }
    if (this.statusTimer) {
      clearTimeout(this.statusTimer)
      this.statusTimer = null
    }
    this.session = null
    this.sessionFingerprint = null
    this.invalidateStatusHeavy()
    this.draft = ''
    this.lastComment = null
    this.generating = false
    // 留白是运行态：下一场从系统默认重新开始
    this.programGapMs = -1
    this.programGate = null
    // 攒在收件箱里没送出/没处理的动态随会话一起清掉
    this.inbox.clear()
    // 停了就不再收尾当前这一轮（abort 后可能还有事件飘过来）
    this.clearTextTimers()
    // 但没封口的思考段落必须封口：渲染端的秒表靠 done 停表，不封口它会一直往上跑
    // （曾出现「思考过程 · 1018s」——那一轮被中断，entry 永远 done=false，秒表就跑了 17 分钟）
    this.finalizeThinking()
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
    // stop 已把会话落库：start 默认读存档，带着历史重新就位（导演大脑/卡司/剧本按当前值重组装）
    await this.start()
  }

  /**
   * /clear：清空全局会话——停掉活着的会话（不复盘、不存回），删掉存的会话记录和
   * 当前节目的对话时间线，渲染层 reset 清屏。下次说话导演从零就位（system prompt 重新组装，
   * 卡司/节目/剧本按当前值）。正在直播中不许清：主播还在台上，清了上下文就断片。
   */
  async clearConversation(): Promise<{ ok: boolean; error?: string }> {
    if (this.liveActive) return { ok: false, error: '正在直播中，不能清空会话——先停播再清' }
    const programId = StorageService.DIRECTOR_SESSION_KEY
    await this.stop({ skipSummarize: true })
    try {
      this.storage.deleteProgramSession(StorageService.DIRECTOR_SESSION_KEY)
      if (programId) this.storage.timelineClear(programId)
    } catch (error) {
      console.error('[AgentAnchor] 清空会话落库失败:', error)
    }
    this.onDirectorTimeline?.({ type: 'reset', entries: [] })
    this.broadcast(this.status())
    this.emitNote('—— 会话已清空，导演下次说话从零开始 ——')
    return { ok: true }
  }

  /**
   * 卡司切换（直播/写稿中都能切）：不 abort、不重启会话——导演还是那个导演，
   * 只是接下来出镜的人换了。池里旧音色的未播条目跟着换人重合成（文本不动）；
   * 会话里追加一条换人说明，让导演知道「当前出镜」换卡了（system prompt 里的
   * 标记是出生时的快照，靠这条修正）。
   */
  async switchPresenter(personaId: string): Promise<{ ok: boolean; error?: string }> {
    const target = this.persona.list().find((p) => p.id === personaId)
    if (!target) return { ok: false, error: '主播卡不存在' }
    if (this.persona.get().id === personaId) return { ok: true }
    // 池里旧音色的未播条目跟着换人重合成（文本不动），新卡司开嗓就是她自己的声音
    const reVoiced = this.pool.reVoice(target.voiceId)
    this.persona.setActive(personaId)
    this.broadcast(this.status())
    this.emitNote(
      `—— 卡司切换：接下来以「${target.name}」的风格和嗓音出镜${reVoiced > 0 ? `，${reVoiced} 条旧音色话术正用新嗓音重合成` : ''} ——`
    )
    if (this.session && (this.state === 'running' || this.state === 'error')) {
      const note =
        `[导播通知] 卡司切换：从现在起由「${target.name}」出镜——say 不传 role 时默认是她，` +
        `她的资料就在你的卡司表里，按她的性格和红线写台词。`
      if (this.busy) {
        try {
          this.session.steer({ role: 'user', content: note, timestamp: Date.now() } as AgentMessage)
        } catch (error) {
          console.error('[AgentAnchor] 卡司切换通知 steer 失败:', error)
        }
      } else {
        this.session.state.messages = [
          ...this.session.state.messages,
          { role: 'user', content: note, timestamp: Date.now() } as AgentMessage
        ]
      }
      this.persistSession()
    }
    return { ok: true }
  }

  /** 刷新事件接线（开播装载时调：换节目不重启会话，接线跟着当前节目重新冻结） */
  refreshProgramGate(): void {
    this.programGate = gateOfProgram(this.script.getActive().program)
    this.invalidateStatusHeavy()
  }

  /** 当前生效的节目事件接线（TriggerRuntime 也看它：触发器白名单/直播动态事件总闸）。会话没跑时按当前节目现解 */
  currentProgramGate(): ProgramGate {
    return this.programGate ?? gateOfProgram(this.script.getActive().program)
  }

  /** 评论入口（连接器）：画像照记、派不派由节目的事件接线决定；派的进直播间动态收件箱，回不回由主播定（docs/10 §5.3） */
  onComment(comment: LiveComment): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    // 没开播不接评论：评论不存在也不该打断写稿/待命
    if (!this.liveActive) return
    // 暂停期间评论只进事件队列（EventBus 已记下），不进收件箱不派给 LLM（同 docs/07 §8.5 人工接管的处理）
    if (this.speakingPaused) return
    // 先查画像（老粉识别），再记一次互动——节目关了直播事件也照记：不打扰主播，但观众资产照攒
    const known = this.memory.lookupViewer(comment.author)
    const isQuestion = /[?？]$/.test(comment.content.trim())
    this.memory.touchViewer(comment.author, isQuestion ? comment.content : undefined)
    // 节目关闭了直播事件：评论根本不派给主播，全身心演自己的
    if (!this.currentProgramGate().allowLiveEvents) return
    const profileHint = known ? `老粉：${this.memory.describeViewer(known)}` : '新观众'
    // 进收件箱：去重/过滤/归组/聚合唤醒由收件箱统一管，攒成一批才唤醒主播
    this.inbox.push({
      connectorEventId: comment.id,
      kind: 'comment',
      author: comment.author,
      content: comment.content,
      profileHint
    })
  }

  /**
   * 内容类触发器通知入口（docs/10 §5.4）：触发后不再直接派固定话术任务，
   * 统一进直播间动态收件箱（攒批/限速/防轰炸由收件箱管），回不回、怎么回由主播决定。
   * 安全类/纯控制类触发器不走这里（TriggerRuntime 的 tool 模式直连话术池，保留确定性操作）。
   */
  pushTriggerEvent(triggerName: string, text: string): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    // 没开播不接触发器（这些是直播节拍，写稿/待命时别来打扰）
    if (!this.liveActive) return
    if (this.speakingPaused) return
    this.inbox.push({ kind: 'trigger', author: `触发器·${triggerName}`, content: text })
  }

  /** 收件箱 flush 出口：包上模板派给主播。主播处理完后用 mark_live_events 标记；不标 5 分钟后自然过期 */
  markLiveEvents(ids: string[], state: 'handled' | 'ignored'): string {
    return this.inbox.markEvents(ids, state)
  }

  /**
   * 收件箱批次送达：窗口期间会话停了/下播了/已暂停就整批退回 new（requeue）——
   * 事件不丢，暂停恢复/会话起来后由 notifyIdle 或新事件补排；退回不主动排唤醒，暂停期间不会自旋叫醒。
   */
  private deliverInboxBatch(batchText: string, events: LiveInboxEvent[]): void {
    if (
      !this.session ||
      (this.state !== 'running' && this.state !== 'error') ||
      !this.liveActive ||
      this.speakingPaused
    ) {
      this.inbox.requeue(events)
      return
    }
    // 批次里最后一条评论更新 lastComment：insert_next 挂 replyTo 用
    const lastCommentEvent = [...events].reverse().find((e) => e.kind === 'comment')
    if (lastCommentEvent) {
      this.lastComment = {
        id: lastCommentEvent.connectorEventId ?? lastCommentEvent.id,
        author: lastCommentEvent.author,
        content: lastCommentEvent.content,
        ts: lastCommentEvent.receivedAt
      }
    }
    void this.ask(this.prompts.render('user.live_batch', { events: batchText }))
  }

  /**
   * 节目整轮播完（finishMode=stop）的收尾通知：播出循环的决策点（index.ts pool.empty）调。
   * 以系统通知口吻派给主播——说完 closer/道别这场就收播；暂停中说不出话就不派（兜底定时器会收）。
   */
  notifyProgramFinished(): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (!this.liveActive || this.speakingPaused) return
    this.deliver(this.prompts.render('user.program_finish'), 'task')
  }

  /** 实际投递：导演指令绕过暂停检查走这里，其余的入口统一先过暂停闸门 */
  private deliver(text: string, mode: 'steer' | 'task', images?: ImageContent[]): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (mode === 'steer' && this.busy) {
      try {
        this.session.steer({ role: 'user', content: text, timestamp: Date.now() } as AgentMessage)
      } catch (error) {
        console.error('[AgentAnchor] steer 失败:', error)
      }
      return
    }
    void this.ask(text, images)
  }

  /**
   * 导演指令入口（docs/07 §8.8）：最高优先级，生成中就 steer 插队，空闲直接派。
   * 暂停期间照常送达（不然喊不出「继续」）；执行过程与结果由对话时间线照事件流原样呈现。
   * images：导演随消息附的图（模型没开多模态时丢弃图片、文本照送并附说明）
   */
  directorSay(text: string, images?: ImageContent[]): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) {
      throw new Error('主播没在跑：先在直播台启动节目')
    }
    let payload = this.prompts.render('user.director_wrap', { text })
    let pics = images?.length ? images : undefined
    if (pics && !this.visionCapable) {
      payload += '\n[导演附了图片，但当前模型没开多模态，看不到——需要到接入的模型行「高级」里打开]'
      pics = undefined
    }
    this.deliver(payload, 'steer', pics)
  }

  /**
   * 导演对话入口（直播台输入框）：全局单会话——选中节目就能聊，没会话时先把导演
   * 就位（上下文齐备、播出通道关着）；已有会话直接投递。换节目不重启：
   * 新任务是同一会话里的下一条指令，资产变更由 assetsStale 提示手动重启。
   */
  async chat(text: string, images?: ImageContent[]): Promise<void> {
    await this.ensureSession()
    this.directorSay(text, images)
  }

  /** 时间线系统提示（卡司切换等）：以一段文本条目上屏，不走 LLM */
  private emitNote(text: string): void {
    this.emitTimeline({
      turnId: this.turnId,
      entry: { type: 'text', id: `note-${Date.now()}`, text, final: false }
    })
  }

  /**
   * 引擎低水位自动续写（rolling 专属，index.ts 的 pool.low 策略分支调）：
   * 水位信号直达主播，不依赖触发器勾选；导演随时可以在对话里人工叫写。
   * 暂停中不叫——没人听的时候写稿是白烧 token；冷却由调用方管。
   */
  notifyLowWater(remaining: number): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (!this.liveActive || this.speakingPaused) return
    this.deliver(this.prompts.render('user.low_water', { remaining }), 'task')
  }

  /**
   * 时间线条目出口：先按节目落库（ChatEntry 形状，切节目/刷新/重启后整段恢复），再广播给渲染层。
   * 落库失败不影响直播。
   */
  private emitTimeline(event: DirectorTimelineEvent): void {
    const programId = StorageService.DIRECTOR_SESSION_KEY
    // 发言人标记：agent 侧条目盖当前主播的戳（卡司切换后时间线看得出哪段是谁出镜）
    const speakerId = this.state === 'stopped' ? undefined : this.persona.get().id
    const stamped = (
      speakerId ? { ...event.entry, personaId: speakerId } : event.entry
    ) as DirectorTimelineEntry
    if (programId) {
      const entry = stamped
      const ts = Date.now()
      const pid = 'personaId' in entry ? entry.personaId : undefined
      const speaker = pid ? { personaId: pid } : {}
      const chat: ChatEntry =
        entry.type === 'text'
          ? { type: 'text', id: entry.id, ts, text: entry.text, final: entry.final ?? false, turnId: event.turnId, ...speaker }
          : entry.type === 'thinking'
            ? {
                type: 'thinking',
                id: entry.id,
                ts,
                turnId: event.turnId,
                text: entry.text,
                done: entry.done ?? false,
                // 权威时长要落库：恢复出来的条目 ts 是"结束时刻"，拿它反推不出真实思考了多久
                ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
                ...speaker
              }
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
                durationMs: entry.durationMs,
                ...speaker
              }
      // 流式增量刻度不落库：库里的行必须是全文，等定稿（final/done）那次再写，
      // 顺带把"每 60ms 一次 UPSERT 整段文本"也去掉（长回复时这是笔不小的写放大）
      const isDeltaTick = 'append' in entry && entry.append === true
      if (!isDeltaTick) {
        try {
          this.storage.timelineAppend(programId, entry.id, event.turnId, ts, JSON.stringify(chat))
        } catch {
          // 落库失败静默：时间线只是记录，不能反过来影响主播
        }
      }
    }
    this.onDirectorTimeline?.({ turnId: event.turnId, entry: stamped })
  }

  /** 选中场次即就位：不等第一句话就建会话（上下文仪表从这一刻就有读数；建会话不调 LLM，零成本） */
  async warmupSession(): Promise<void> {
    await this.ensureSession()
  }

  /** 导演就位（无会话时）：导演大脑 + 卡司 + 选中节目的上下文，恢复全局会话存下的对话（没有就新起） */
  private async ensureSession(): Promise<void> {
    if (this.session) return
    const programId = this.storage.getConfig().live.activeProgramId
    const program = programId ? this.storage.programList().find((p) => p.id === programId) : null
    if (!program) throw new Error('先在上方选一个节目：导演需要知道要准备哪场，才有上下文')
    this.script.setActiveProgram(program.id)
    await this.start(this.restoredMessages())
  }

  /**
   * 写稿（直播前）：导演给当前节目写底稿——同一份全局会话，区别只在开播态：
   * 没开播时播出通道关着，产出只走 write_bits 进底稿库。切到目标节目（没开播，安全），
   * 没会话就就位，然后派写稿任务书；直播中拒绝。
   */
  async startDrafting(programId: string): Promise<void> {
    const program = this.storage.programList().find((p) => p.id === programId)
    if (!program) throw new Error('节目不存在')
    // 即兴节目没有底稿概念：不进写稿模式，给一句能照做的提示（备料走知识库）
    if (program.broadcastMode === 'improvised') {
      throw new Error(`「${program.name}」是现场发挥的节目，不需要底稿；要备料可以让我把内容直接存进知识库`)
    }
    // 没绑剧本不拦：自动建一本空剧本绑到节目（与 create_scene 工具同一套「主播自编」），
    // 场景让主播用 create_scene 自己搭——兑现任务书里「场景不够自己搭」的承诺
    const { script } = this.script.ensureProgramScript(program.id)
    if (this.liveActive) {
      throw new Error('正在直播：写稿先下播，或者用对话直接改底稿')
    }
    // 切到目标节目：写稿工具的默认目标就是它；事件接线跟着刷新（没开播，换了也没人在播）
    this.script.setActiveProgram(program.id)
    this.refreshProgramGate()
    await this.ensureSession()
    // 写稿必须有准头：刚换了节目/改过卡司，旧会话的 system prompt 里还是上一套（导演不知道现在手上有哪些主播）
    // → 先按新资产重开会话（stop 会把历史落库，start 带着历史重组装），再派任务书
    if (this.assetsStale()) await this.restart()
    this.directorSay(this.composeDraftBrief(script))
  }

  /** 写稿任务书：场景行（id/时长/要点）代码拼好，主文案走导演手册（user.draft_brief）；
   *  末尾附本场卡司名单——写谁的词要钻进谁的人设，导演得先知道手上有哪些主播 */
  private composeDraftBrief(script: Script): string {
    const scenes =
      script.scenes.length === 0
        ? '  （还没有场景——先按节目主题用 create_scene 把场次搭出来，再逐场写）'
        : script.scenes
            .map(
              (scene, i) =>
                `  ${i + 1}. 「${scene.title}」（sceneId=${scene.id}，约 ${scene.estDurationMin} 分钟）` +
                `目标：${scene.goal}；要点：${scene.keyPoints.replace(/\n/g, '；')}`
            )
            .join('\n')
    return `${this.prompts.render('user.draft_brief', { scenes })}\n\n${this.castBrief()}`
  }

  /** 任务书末尾的卡司段：节目定了卡司就点名，没定就报可用名单（导演自选） */
  private castBrief(): string {
    const program = this.script.getActive().program
    const all = this.persona.list()
    const ids = program?.presenterIds ?? []
    if (all.length === 0) {
      return '# 本场卡司\n  还没有主播卡——先用 save_persona 立一张（人设/口癖/背景/红线/嗓音），不然写出来的稿没人能出声。'
    }
    const describe = (p: (typeof all)[number]): string =>
      `${p.name}${p.personality.trim() ? `（${p.personality.trim().split('\n')[0].slice(0, 24)}）` : ''}`
    if (ids.length > 0) {
      const cast = all.filter((p) => ids.includes(p.id))
      return `# 本场卡司（节目定的，只用这几位出镜）\n  写谁的词就钻进谁的人设，同一个人说的连续内容用同一个 role；这几位之外不要凭空造人。\n  ${cast.map(describe).join('、')}`
    }
    return `# 本场卡司（节目没定，你自己挑）\n  手上可用：${all.map(describe).join('、')}。\n  单人节目就用其中一位当主讲；需要串场/双人对谈时按人设分派 role，别让一个人演两个性格。`
  }

  /** 急停（配合 renderer 停播放 + 清池）：停会话即可，池由调用方清 */
  async panic(): Promise<void> {
    await this.stop()
  }

  /** 场景推进后广播状态（提词器「当前场景」刷新） */
  notifySceneChanged(): void {
    this.broadcast(this.status())
  }

  /** 系统旁白上对话时间线（emergency_stop 等系统控制工具执行后通知导演用） */
  notifyTimeline(text: string): void {
    this.emitNote(text)
  }

  /** 会话绑定信息（系统控制工具的删除保护用）：无会话返回 null；purpose 由开播态派生 */
  sessionInfo(): { programId: string; purpose: 'live' | 'prep' } | null {
    if (!this.session) return null
    return {
      programId: this.storage.getConfig().live.activeProgramId,
      purpose: this.liveActive ? 'live' : 'prep'
    }
  }

  // ---------- 对话时间线（docs/09 §11：照事件流原样渲染，不做二次解释） ----------

  /**
   * 新一轮（agent_start）：一次派给主播的任务 = 一轮，含中间文本 + 多轮工具调用 + 最终回复。
   * turnId 形如 turn-m3k9x2-3（runId-序号），本轮内每条 assistant 消息形如 turn-m3k9x2-3-msg-1。
   */
  private beginTurn(): void {
    this.clearTextTimers()
    // 上一轮若有没封口的思考段落，先按 done 封掉再清（清了就再也没机会封口 → 渲染端秒表失控）
    this.finalizeThinking()
    this.texts.clear()
    this.thinkings.clear()
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
    // 增量：中间刻度只发新增片段（渲染层累加），定稿那次发全文兜底对账——
    // 每 60ms 重发整段的字节数对长回复是平方级，增量后是线性
    const delta = state.text.slice(state.sent.length)
    state.sent = state.text
    if (final) state.finalSent = true
    this.emitTimeline({
      turnId: state.turnId,
      entry: { type: 'text', id, text: final ? state.text : delta, append: !final, ...(final ? { final: true } : {}) }
    })
  }

  /** 累积 thinking_delta（按消息 id 归入「思考过程」条目），节流同文本 */
  private appendThinking(delta: string): void {
    const id = this.currentMessageId
    if (!id) return
    const entryId = `th-${id}`
    let state = this.thinkings.get(entryId)
    if (!state) {
      // startedAt：思考真正开始的时刻。渲染层不能拿"落库的 ts"当开始时间——
      // 增量推送后只有定稿那次落库，库里的 ts 是"结束时刻"，恢复出来当开始用会算出天文数字
      state = { turnId: this.turnId, text: '', sent: '', done: false, startedAt: Date.now() }
      this.thinkings.set(entryId, state)
    }
    state.text += delta
    this.emitThinking(entryId)
  }

  /** 推一条思考条目（同一 id 反复推，渲染层按 id upsert）；节流 ≥60ms 与文本共用节拍 */
  private emitThinking(entryId: string, force = false): void {
    const state = this.thinkings.get(entryId)
    if (!state) return
    if (!force && !state.done && state.sent === state.text) return
    const elapsed = Date.now() - this.lastTextEmitAt
    if (!force && elapsed < TEXT_THROTTLE_MS) {
      if (!state.timer) {
        const timer = setTimeout(() => {
          state.timer = undefined
          this.emitThinking(entryId, true)
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
    // 与文本同理：中间刻度发增量，定稿（done）那次发全文
    const delta = state.text.slice(state.sent.length)
    state.sent = state.text
    this.emitTimeline({
      turnId: this.turnId,
      entry: {
        type: 'thinking',
        id: entryId,
        text: state.done ? state.text : delta,
        append: !state.done,
        ...(state.done ? { done: true, durationMs: Date.now() - state.startedAt } : {})
      }
    })
  }

  /** 思考收尾：这条消息的思考段落标 done（渲染层收成可折叠的一行） */
  private finalizeThinking(): void {
    for (const [entryId, state] of this.thinkings) {
      if (state.done || !state.text.trim()) continue
      state.done = true
      this.emitThinking(entryId, true)
    }
  }

  /** 一轮结束前把没推完的最后一段文本补上（节流可能还压着一段） */
  private flushText(): void {
    const id = this.currentMessageId
    if (id) this.emitText(id, false, true)
    // 思考段落跟着文本一起收尾：这条消息的输出阶段切换时，思考就定稿了
    this.finalizeThinking()
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
    this.invalidateStatusHeavy()
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
  private async ask(text: string, images?: ImageContent[]): Promise<void> {
    const session = this.session
    if (!session) return
    const full = this.scenePrefix() + text
    try {
      if (this.busy) {
        // steer 只接受文本：有图时等这轮生成完再派（图中说明已让主播知道）
        session.steer({ role: 'user', content: full, timestamp: Date.now() } as AgentMessage)
        return
      }
      this.busy = true
      this.exchanges += 1
      await session.prompt(full, images?.length ? images : undefined)
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

  /** 下播总结：让导演自我复盘本场亮点/高频问题，写进场次的 summary 字段。失败静默，不挡下播。 */
  private async summarizeEpisode(session: Agent): Promise<void> {
    await Promise.race([
      (async () => {
        await session.waitForIdle()
        await session.prompt(this.prompts.render('user.episode_summary'))
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('总结超时')), 30_000))
    ])
    const summary = lastAssistantText(session.state.messages)?.trim()
    // 场次 id 开播时由 ProgramPlaybackService 写入；没开播过的会话不复盘（stop 入口已按开播态过滤）
    if (summary && this.broadcastSessionId) this.memory.saveSessionSummary(this.broadcastSessionId, summary)
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

  // ---------- 用量采集（数据页用量看板） ----------

  /**
   * 一次 LLM 请求落库：pi-ai 的 AssistantMessage 自带服务商回报的真实 usage（completions
   * 通道已请求 stream_options.include_usage；responses 通道从 response.usage 映射，含缓存命中），
   * 直接记；没拿到 usage（全 0）时按输出文本字符数/4 估算并标 estimated。
   * 纯失败的请求（error 且无正文）不记。cost 恒为 null（用量看板只统计用量，不折算金额）。落库失败静默，不影响直播。
   */
  private recordUsage(kind: UsageKind, message: AssistantMessage): void {
    try {
      const usage = message.usage
      const real =
        usage && (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0)
      let inputTokens = 0
      let outputTokens = 0
      let cacheRead = 0
      let cacheWrite = 0
      let estimated = false
      if (real) {
        inputTokens = usage.input
        outputTokens = usage.output
        cacheRead = usage.cacheRead
        cacheWrite = usage.cacheWrite
      } else {
        // 估算兜底：只估输出（输入是整份会话上下文，在这里估不出来，估了反而误导）
        const text = Array.isArray(message.content)
          ? message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
          : ''
        if (!text.trim()) return
        outputTokens = Math.ceil(text.length / 4)
        estimated = true
      }
      this.storage.usageInsert({
        id: `ur-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ts: Date.now(),
        programId: this.storage.getConfig().live.activeProgramId || null,
        personaId: this.persona.get().id,
        connectionId: this.usageConnectionId,
        model: this.usageModel,
        kind,
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
        estimated,
        cost: null
      })
    } catch (error) {
      console.warn('[AgentAnchor] 用量记录落库失败:', error)
    }
  }

  // ---------- 上下文压缩（transformContext 钩子：超过阈值就把旧消息摘要成一条） ----------

  /**
   * 压缩阈值：窗口 - reserve。reserve 取 16k 与窗口 40% 的小者——窗口配置偏小时留的比例不变，
   * 否则「system prompt + 工具表 schema」这个地板就可能比阈值还高，压完立刻又超，每轮白压一遍。
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
    model: Model<LlmApi>,
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
            const stream = await streamLlmModel(
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
        // 摘要调用也是一次真实 LLM 请求：usage 落库（kind=compact，与正常对话分开统计）
        this.recordUsage('compact', result)
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
    const programId = StorageService.DIRECTOR_SESSION_KEY
    this.storage.timelineClear(programId)
    const card: ChatEntry = {
      type: 'tool',
      id,
      ts: Date.now(),
      turnId: this.turnId,
      name: 'context_compact',
      status: 'ok',
      result: `压缩前约 ${Math.round(tokensBefore / 1000)}k tokens → 摘要 + 最近对话继续（不丢价格/口径等已查证事实）`
    }
    if (programId) {
      try {
        this.storage.timelineAppend(programId, id, this.turnId, card.ts, JSON.stringify(card))
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

  private async createSession(
    resolved: ResolvedModel,
    restoredMessages?: AgentMessage[]
  ): Promise<Agent> {
    const { model, apiKey, modelLabel, contextWindow, thinkingLevel, temperature, vision } =
      await prepareLlmModel(resolved)
    this.modelLabel = modelLabel
    this.visionCapable = vision
    // 成本采集的归属信息：本台会话的每次 LLM 请求都记到这套接入 + 模型名下
    this.usageConnectionId = resolved.connectionId ?? ''
    this.usageModel = resolved.model
    // 记下出生时的资产指纹：之后 UI 靠它判断"本场是不是旧版本"
    this.sessionFingerprint = this.assetFingerprint()

    const persona = this.persona.get()
    const { program, script } = this.script.getActive()
    const director = this.storage.getConfig().director
    const { cast, castAuto } = this.currentCast(program)
    // system prompt = 导演手册 + 卡司资料 + 节目上下文，出生组装一次（之后变更靠 assetsStale 提示重启）
    const systemPrompt = this.prompts.buildSystemPrompt({
      director,
      cast,
      castAuto,
      activePersona: persona,
      program,
      script
    })

    const allTools = [
      ...buildAnchorTools({
      pool: this.pool,
      knowledge: this.knowledge,
      memory: this.memory,
      persona: this.persona,
      script: this.script,
      storage: this.storage,
      utterances: this.utterances,
      getLastComment: () => this.lastComment,
      onSceneChanged: () => this.notifySceneChanged(),
      onSceneAdvanced: (sceneIndex) => this.onSceneAdvanced?.(sceneIndex),
      onDirectorAsk: (ask) => this.handleDirectorAsk(ask),
      setProgramGap: (ms) => this.setProgramGap(ms),
      onPlaybackControl: (action) => this.onPlaybackControl?.(action),
      getSpeakingPaused: () => this.speakingPaused,
      isLiveActive: () => this.liveActive,
      markLiveEvents: (ids, state) => this.markLiveEvents(ids, state),
      onGoLive: async () => this.onGoLive?.() ?? '开播通道没接上，让导演从界面点「启动节目」',
      syncProducts: async () =>
        this.knowledge.syncFromConnector({
          listTools: () => this.getConnector?.()?.listTools() ?? Promise.resolve([]),
          callTool: (name, args) => {
            const c = this.getConnector?.()
            if (!c) return Promise.reject(new Error('连接器没接线'))
            return c.callTool(name, args)
          }
        }),
      connector: this.getConnector?.() ?? null
      }),
      ...buildAnchorSystemTools({
        storage: this.storage,
        script: this.script,
        persona: this.persona,
        utterances: this.utterances,
        pool: this.pool,
        getStatus: () => this.status(),
        getSessionInfo: () => this.sessionInfo(),
        getActivePersonaId: () => this.persona.get().id,
        switchPresenter: (personaId) => this.switchPresenter(personaId),
        onDirectorAsk: (ask) => this.handleDirectorAsk(ask),
        notifyTimeline: (text) => this.notifyTimeline(text),
        warmupProgram: (programId) => {
          if (programId) void this.warmupSession().catch(() => undefined)
        },
        onEmergencyStop: () => this.onEmergencyStop?.() ?? Promise.resolve(),
        getConnector: () => this.getConnector?.() ?? null,
        getVoices: () => this.getVoices?.() ?? null,
        getTriggers: () => this.getTriggers?.() ?? null,
        getStream: () => this.getStream?.() ?? null,
        getExporter: () => this.getExporter?.() ?? null,
        // 统一音频生产入口（produce_program_audio 工具，docs/10 §7.5-7.6）
        produceProgramAudio: (programId) => this.utterances.produceProgramAudio(programId),
        describeProducePlan: (programId) => this.utterances.describeProducePlan(programId)
      })
    ]
    // 工具按场景裁剪（规则见 IMPROVISED_TOOL_EXCLUDE 的注释）
    const improvised = program?.broadcastMode === 'improvised'
    const tools = improvised
      ? allTools.filter((tool) => !IMPROVISED_TOOL_EXCLUDE.has(tool.name))
      : allTools
    // 上下文仪表：窗口 + 固定开销（system prompt + 实际进会话的工具表 schema）出生时就位
    this.contextWindow = contextWindow
    this.contextOverhead =
      estimateMsgTokens({
        role: 'user',
        content: [{ type: 'text', text: systemPrompt }],
        timestamp: 0
      } as unknown as AgentMessage) + estimateToolSchemaTokens(tools)
    this.contextCache = { messagesLength: -1, tokens: 0, at: 0 }

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        // 思考强度来自接入的模型级配置（off=不思考）；思考流会进对话时间线的「思考过程」
        thinkingLevel,
        // 主播工具（说话/写稿/播出控制）+ 系统控制工具（节目/剧本/主播/音色/触发器/全局状态，docs/10 §10.2），按场景裁剪后挂入
        tools,
        // 全局单会话：恢复时把存档消息重建进内存会话，上下文原样回来
        messages: restoredMessages
      },
      // 凭据/超时随 stream options 注入：httpIdleTimeoutMs → timeoutMs（60s）；重试靠传输层 maxRetries
      // （应用层 retryAssistantCall 是消息级的，包主链路会丢掉流式——coding-agent 也只把它用在摘要调用上）
      streamFn: (mdl, context, options) =>
        streamLlmModel(mdl as Model<LlmApi>, context, {
          ...options,
          apiKey,
          timeoutMs: LLM_TIMEOUT_MS,
          maxRetries: 2,
          // 温度（接入的模型级高级参数）：undefined = 服务商默认，不硬塞
          ...(temperature !== undefined ? { temperature } : {})
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
        // 广播合并到 ~120ms 一次：delta 密集时这里原本是几十次/秒的状态风暴
        this.broadcastStatusThrottled()
      } else if (assistantEvent?.type === 'thinking_delta') {
        // 思考流：模型开了思考强度才有；进时间线的「思考过程」条目（不进提词器、不播报）
        this.appendThinking(assistantEvent.delta)
      } else if (assistantEvent?.type === 'thinking_end') {
        // 思考段落写完：收起来（delta 流完后 thinking_end 是定稿信号）
        this.finalizeThinking()
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
        // 全局单会话：每轮落一次库，崩溃/强杀也丢不了多少
        this.persistSession()
        // 一轮跑完：收件箱里忙时攒下的动态补排唤醒（闲时不叫主播，攒着等下一批）
        this.inbox.notifyIdle()
      } else if (event.type === 'message_end') {
        // 用量采集：每条 assistant 消息 = 一次真实 LLM 请求（带工具轮次的一轮里有多条）
        if (event.message.role === 'assistant') {
          this.recordUsage(this.liveActive ? 'chat' : 'draft', event.message as AssistantMessage)
        }
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
