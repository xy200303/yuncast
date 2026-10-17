import type { Static, TSchema } from 'typebox'
import type {
  AgentStatus,
  LaunchResult,
  LiveComment,
  PlaybackControlAction,
  ProduceAudioResult,
  ProducePlanInfo
} from '../../../shared/types'
import type { SpeechPool } from '../SpeechPool'
import type { KnowledgeService } from '../KnowledgeService'
import type { MemoryService } from '../MemoryService'
import type { PersonaService } from '../PersonaService'
import type { ScriptService } from '../ScriptService'
import type { StorageService } from '../StorageService'
import type { AudioStyleService } from '../AudioStyleService'
import type { DraftUnitService } from '../DraftUnitService'
import type { TtsService } from '../TtsService'
import type { AgentService } from '../AgentService'
import type { ProgramPlaybackService } from '../ProgramPlaybackService'
import type { ConnectorService } from '../ConnectorService'
import type { VoiceService } from '../VoiceService'
import type { TriggerRuntime } from '../TriggerRuntime'
import type { StreamService } from '../stream/StreamService'
import type { ExportService } from '../ExportService'
import type { RecordingService } from '../RecordingService'

/** 调用方身份：agent=内置主播自己调；external=MCP/CLI 外部 agent 调 */
export type ToolCaller = 'agent' | 'external'

/** read=只读查询；write=改内部状态（可逆）；danger=真出声/真开播/删数据/外部副作用 */
export type ToolRisk = 'read' | 'write' | 'danger'

/** ask_director 的确认卡载荷（导演在对话面板里点选回答） */
export interface DirectorAsk {
  text: string
  options: string[]
  timeoutSec: number
  defaultAction?: string
}

/**
 * 工具上下文：handler 拿到的全部依赖。服务实例两侧都有；运行态回调只有对应侧才接得上，
 * handler 里对可能缺失的回调要做兜底（给调用方一条能听懂的指引，而不是炸 undefined）。
 */
export interface ToolCtx {
  caller: ToolCaller

  // ---------- 服务实例（两侧必有） ----------
  pool: SpeechPool
  knowledge: KnowledgeService
  memory: MemoryService
  persona: PersonaService
  script: ScriptService
  storage: StorageService
  draftUnits: DraftUnitService
  agent: AgentService

  // ---------- 可能没接线的服务（null = 没配置/没连上/这一侧不提供） ----------
  tts: TtsService | null
  programPlayback: ProgramPlaybackService | null
  connector: ConnectorService | null
  voices: VoiceService | null
  /** 音频风格解析（百炼 Qwen-Audio）：voice_analyze_style 用 */
  audioStyle?: AudioStyleService | null
  triggers: TriggerRuntime | null
  stream: StreamService | null
  exporter: ExportService | null
  recorder: RecordingService | null

  // ---------- 运行态回调（按侧接线，缺失时 handler 给指引） ----------
  /** 最近一条评论（speak lane=next 挂 replyTo 用） */
  getLastComment?: () => LiveComment | null
  /** 场景变了：广播状态刷提词器 */
  onSceneChanged?: () => void
  /** 场景推进后装载新场景话术库 */
  onSceneAdvanced?: (sceneIndex: number) => void
  /** 请示导演确认卡（ask_director / 危险操作确认） */
  onDirectorAsk?: (ask: DirectorAsk) => void
  /** 播报控制 pause/resume/skip（agent 侧：广播到渲染进程执行） */
  onPlaybackControl?: (action: PlaybackControlAction) => void
  /** 播报是否被暂停 */
  getSpeakingPaused?: () => boolean
  /** 节目开播态 */
  isLiveActive?: () => boolean
  /** 标记直播间动态批次处理结果 */
  markLiveEvents?: (ids: string[], state: 'handled' | 'ignored') => string
  /** 正式启动当前节目开播（agent 侧的 program_launch） */
  onGoLive?: () => Promise<string>
  /** 从连接器同步商品入库 */
  syncProducts?: () => Promise<{ added: number; updated: number; total: number }>
  /** 系统旁白上对话时间线 */
  notifyTimeline?: (text: string) => void
  /** 选中节目后让主播就位的预热 */
  warmupProgram?: (programId: string) => void
  /** 紧急停止总闸：掐声音+停播放循环+停会话 */
  onEmergencyStop?: () => Promise<void>
  /** Agent 运行状态（会话态/开播态/资产是否过期） */
  getStatus?: () => AgentStatus
  /** 会话绑定的节目（删除保护用） */
  getSessionInfo?: () => { programId: string; purpose: 'live' | 'prep' } | null
  /** 统一音频生产入口：rolling=提前合成全部；prepared=生成节目音频（有外部费用） */
  produceProgramAudio?: (programId: string) => Promise<ProduceAudioResult>
  /** 生产前的合成计划摘要（确认卡用） */
  describeProducePlan?: (programId: string) => ProducePlanInfo
  /** 外部侧开播编排（与 IPC.programLaunch 同口径） */
  launchProgram?: (programId: string, allowPartial: boolean) => Promise<LaunchResult>
  /** 外部侧暂停/恢复播报 */
  setPaused?: (paused: boolean) => void
  /** 外部侧跳过当前这条 */
  skipCurrent?: () => void
  /** 导演指令 → 主播，等本轮 final 文本返回（agent_chat 工具，仅外部侧接线） */
  agentChat?: (text: string, timeoutMs: number) => Promise<string>
  /** 事件近查（events_recent 工具，仅外部侧接线；实时流走 GET /events SSE） */
  eventsRecent?: (limit: number, kinds?: Set<string>) => string
}

/**
 * 工具定义：唯一事实源。name/parameters/description 一份，内置 agent 的 function-calling
 * schema、MCP 的 inputSchema、CLI 的 schema 输出全部由它生成。
 */
export interface ToolDef<P extends TSchema = TSchema> {
  name: string
  /** UI 工具卡的显示名（中文，一两个字，如「说」「查知识库」） */
  label: string
  /** 域（speech/draft/scene/program/…）：目录分组和文档用 */
  domain: string
  risk: ToolRisk
  /** 暴露面：agent=内置主播可调；mcp=外部 MCP/CLI 可调 */
  expose: { agent?: boolean; mcp?: boolean }
  /**
   * 描述四要素：干什么+什么时候用 → 副作用（出声/开播/删除明说）→ id 从哪个工具拿 → 返回什么。
   * 误用警告直接写进来（"要做 X 用 Y，别用这个"）。
   */
  description: string
  parameters: P
  /** 实现：返回给人看的文本（模型/外部 agent 读）。出错 throw，适配层统一包成「操作被拒绝：…」 */
  handler: (ctx: ToolCtx, params: Static<P>) => string | Promise<string>
}

export function defineTool<P extends TSchema>(def: ToolDef<P>): ToolDef<P> {
  return def
}
