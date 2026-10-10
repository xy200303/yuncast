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

// ---------- LLM 配置（主播 Agent 的大脑） ----------

export const LLM_PROVIDERS = ['deepseek', 'qwen', 'doubao', 'kimi', 'zai'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export interface LlmConfig {
  provider: LlmProvider
  /** 模型 id（留空用该服务商默认值） */
  model: string
  /** API Key（敏感字段，safeStorage 加密落盘，运行时注入 pi，不落 pi 的盘） */
  apiKey: string
  /** 自定义 API 地址，留空走服务商默认 */
  baseUrl: string
}

export const LLM_PROVIDER_META: Record<LlmProvider, { label: string; defaultModel: string; defaultBaseUrl: string }> = {
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-flash', defaultBaseUrl: 'https://api.deepseek.com' },
  qwen: { label: '通义千问（DashScope）', defaultModel: 'qwen-plus', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  doubao: { label: '豆包（火山方舟）', defaultModel: 'doubao-pro-32k', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  kimi: { label: 'Kimi（月之暗面）', defaultModel: 'kimi-k2.6', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  zai: { label: '智谱（Z.ai）', defaultModel: 'glm-4.7', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: 'deepseek',
  model: LLM_PROVIDER_META.deepseek.defaultModel,
  apiKey: '',
  baseUrl: ''
}

export function llmConfigured(llm: LlmConfig): boolean {
  return Boolean(llm.apiKey && (llm.model || LLM_PROVIDER_META[llm.provider].defaultModel))
}

// ---------- 应用配置 ----------

/** 持久化到 userData/config.json 的应用配置。 */
export interface AppConfig {
  theme: AppTheme
  tts: TtsConfig
  llm: LlmConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  tts: DEFAULT_TTS_CONFIG,
  llm: DEFAULT_LLM_CONFIG
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
  const llmRow = row.llm && typeof row.llm === 'object' ? (row.llm as Record<string, unknown>) : {}
  const llmProvider = LLM_PROVIDERS.find((id) => id === llmRow.provider) ?? DEFAULT_LLM_CONFIG.provider
  const llm: LlmConfig = {
    provider: llmProvider,
    model:
      typeof llmRow.model === 'string' && llmRow.model
        ? llmRow.model
        : LLM_PROVIDER_META[llmProvider].defaultModel,
    apiKey: typeof llmRow.apiKey === 'string' ? llmRow.apiKey : '',
    baseUrl: typeof llmRow.baseUrl === 'string' ? llmRow.baseUrl : ''
  }
  return {
    theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme,
    tts,
    llm
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

// ---------- 人设卡（Persona，主播 Agent 的人格） ----------

export interface Persona {
  id: string
  /** 主播名字 */
  name: string
  /** 性格（开朗/沉稳/毒舌……） */
  personality: string
  /** 口癖（口头禅、语气词） */
  catchphrases: string
  /** 背景故事 */
  background: string
  /** 禁区（绝不能说的话题/承诺） */
  taboos: string
  /** 默认音色（对应 config.tts 的 voiceId 体系） */
  voiceId: string
  updatedAt: number
}

export const DEFAULT_PERSONA: Omit<Persona, 'id' | 'updatedAt'> = {
  name: '小陶',
  personality: '开朗亲切、节奏明快的带货主播，像邻家姐姐一样和观众聊天',
  catchphrases: '家人们、真的绝了、闭眼入、给你们安排上',
  background: '做了三年直播带货，熟悉各种家居好物，对成分和材质很有研究',
  taboos: '不承诺绝对最低价；不贬低其它品牌；不谈论政治和隐私话题；不夸大功效',
  voiceId: ''
}

// ---------- 主播 Agent 状态 ----------

export type AgentRunState = 'stopped' | 'starting' | 'running' | 'error'

/** agent:status 广播给渲染进程的状态 */
export interface AgentStatus {
  state: AgentRunState
  error?: string
  /** provider/model 展示用 */
  model?: string
  personaName?: string
  /** 生成中预览：text_delta 累积的文本，入池即清空 */
  draft: string
}

// ---------- 评论（M3 来自模拟器，PipeSDK 真接入后续里程碑） ----------

export interface LiveComment {
  id: string
  author: string
  content: string
  ts: number
}

export interface SimulatorStatus {
  running: boolean
  count: number
}
