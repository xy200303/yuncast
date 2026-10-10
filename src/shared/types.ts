/** main / preload / renderer 三方共用的基本类型 */

/** 应用界面主题：浅色、深色，或跟着系统。 */
export const APP_THEMES = ['light', 'dark', 'system'] as const
export type AppTheme = (typeof APP_THEMES)[number]

// ---------- TTS 配置（双通道：火山引擎 / 阿里云百炼） ----------

export const TTS_PROVIDERS = ['volcano', 'bailian'] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]

export interface TtsConfig {
  provider: TtsProvider
  /** 火山引擎：应用 AppId */
  appId: string
  /** 火山引擎：Access Token（敏感字段，safeStorage 加密落盘） */
  accessToken: string
  /** 火山引擎：接入集群 */
  cluster: string
  /** 百炼：API Key（敏感字段，safeStorage 加密落盘） */
  apiKey: string
  /** 百炼模型名称，例如 qwen3-tts-flash */
  model: string
  /** 百炼 DashScope API 地址 */
  baseUrl: string
  /** 百炼可选语种，Auto 或 Chinese 等 */
  languageType: string
  /** 默认音色（火山 voice_type / 百炼 voice） */
  voiceId: string
  /** 语速倍率（仅火山生效） */
  speed: number
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  provider: 'volcano',
  appId: '',
  accessToken: '',
  cluster: 'volcano_tts',
  apiKey: '',
  model: 'qwen3-tts-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  languageType: 'Chinese',
  voiceId: '',
  speed: 1.0
}

/** 该服务商是否已具备合成所需的最小凭据 */
export function ttsConfigured(tts: TtsConfig): boolean {
  if (tts.provider === 'bailian') return Boolean(tts.apiKey && tts.model && tts.voiceId)
  return Boolean(tts.appId && tts.accessToken && tts.voiceId)
}

// ---------- 应用配置 ----------

/** 持久化到 userData/config.json 的应用配置。 */
export interface AppConfig {
  theme: AppTheme
  tts: TtsConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  tts: DEFAULT_TTS_CONFIG
}

/** 单层到多层的部分更新（secret 字段同样是明文进、密文存） */
export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K]
}

export function parseAppConfig(input: unknown): AppConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const ttsRow = row.tts && typeof row.tts === 'object' ? (row.tts as Record<string, unknown>) : {}
  const tts: TtsConfig = {
    provider: TTS_PROVIDERS.find((id) => id === ttsRow.provider) ?? DEFAULT_TTS_CONFIG.provider,
    appId: typeof ttsRow.appId === 'string' ? ttsRow.appId : '',
    accessToken: typeof ttsRow.accessToken === 'string' ? ttsRow.accessToken : '',
    cluster: typeof ttsRow.cluster === 'string' ? ttsRow.cluster : DEFAULT_TTS_CONFIG.cluster,
    apiKey: typeof ttsRow.apiKey === 'string' ? ttsRow.apiKey : '',
    model: typeof ttsRow.model === 'string' ? ttsRow.model : DEFAULT_TTS_CONFIG.model,
    baseUrl: typeof ttsRow.baseUrl === 'string' ? ttsRow.baseUrl : DEFAULT_TTS_CONFIG.baseUrl,
    languageType:
      typeof ttsRow.languageType === 'string' ? ttsRow.languageType : DEFAULT_TTS_CONFIG.languageType,
    voiceId: typeof ttsRow.voiceId === 'string' ? ttsRow.voiceId : '',
    speed: typeof ttsRow.speed === 'number' && ttsRow.speed > 0 ? ttsRow.speed : 1.0
  }
  return {
    theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme,
    tts
  }
}

/** app.info() 返回的应用信息 */
export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

// ---------- 话术池（SpeechPool，docs/01 §3.2/3.3） ----------

export const SPEECH_LANES = ['interrupt', 'next', 'normal', 'filler'] as const
export type SpeechLane = (typeof SPEECH_LANES)[number]

export const SPEECH_SOURCE_KINDS = [
  'scene',
  'reply',
  'interact',
  'announce',
  'filler',
  'manual',
  'reaction'
] as const
export type SpeechSourceKind = (typeof SPEECH_SOURCE_KINDS)[number]

export type SpeechStatus =
  | 'pending'
  | 'synthesizing'
  | 'ready'
  | 'playing'
  | 'done'
  | 'interrupted'
  | 'skipped'
  | 'failed'
  | 'expired'

export interface SpeechReplyTo {
  commentId: string
  author: string
}

export interface SpeechItem {
  id: string
  sessionId: string
  text: string
  /** 话轮：同一批连续条目原子播出，排序时不被插队拆开 */
  turnId: string
  /** 话轮内顺序 */
  seq: number
  /** 角色音色（编剧模式），空串 = 用 TTS 默认音色 */
  voiceId: string
  source: { agentId: string; kind: SpeechSourceKind }
  lane: SpeechLane
  /** 未播条目去重键 */
  dedupeKey?: string
  /** 时效过期不播（毫秒时间戳） */
  expiresAt?: number
  replyTo?: SpeechReplyTo
  status: SpeechStatus
  /** TTS 合成完成的音频文件绝对路径（合成前为空） */
  audioPath?: string
  /** 合成/播放失败原因 */
  error?: string
  /** reorder 手动指定的顺序（优先级高于 createdAt） */
  sortOrder?: number
  createdAt: number
  playedAt?: number
}

/** say / insert_next 的入参 */
export interface PoolSayInput {
  text: string
  voiceId?: string
  lane?: SpeechLane
  sourceKind?: SpeechSourceKind
  sourceAgentId?: string
  /** 不传则新开一个话轮 */
  turnId?: string
  seq?: number
  dedupeKey?: string
  expiresAt?: number
  replyTo?: SpeechReplyTo
}

export interface PoolStatus {
  /** 未播完的条目总数（pending + synthesizing + ready + playing） */
  active: number
  byLane: Record<SpeechLane, number>
  playing: SpeechItem | null
}

/** 池快照：广播给渲染进程驱动队列视图和提词器 */
export interface PoolSnapshot {
  /** 未播完条目，按播出顺序排好 */
  items: SpeechItem[]
  /** 近期合成失败的条目（5 分钟内），供 toast / 队列展示 */
  failed: SpeechItem[]
}

/** 池操作统一返回形状（IPC 层不抛异常，错误信息给 UI 用） */
export type PoolResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { item: T }))
  | { ok: false; error: string }

/** 池/合成的常量约束 */
export const POOL_LIMITS = {
  /** 池内容量上限（未播完条目） */
  capacity: 50,
  /** 每来源每分钟限流 */
  perSourcePerMinute: 20,
  /** 预合成窗口：队列前 N 条提前送 TTS */
  synthWindow: 5,
  /** 单条话术字数上限 */
  textMaxLength: 500
} as const
