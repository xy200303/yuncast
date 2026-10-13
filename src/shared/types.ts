/** main / preload / renderer 三方共用的基本类型 */

/** 应用界面主题：浅色、深色，或跟着系统。 */
export const APP_THEMES = ['light', 'dark', 'system'] as const
export type AppTheme = (typeof APP_THEMES)[number]

/** 配色主题（点缀色）。每个配色在明/暗两套底色下各有一个色值。 */
export const APP_ACCENTS = ['clay', 'forest', 'ocean', 'rose', 'graphite'] as const
export type AppAccent = (typeof APP_ACCENTS)[number]

export const APP_ACCENT_META: Record<AppAccent, { label: string; light: string; dark: string }> = {
  clay: { label: '陶土（默认）', light: 'oklch(0.63 0.124 49.3)', dark: 'oklch(0.69 0.115 49.3)' },
  forest: { label: '松林', light: 'oklch(0.58 0.105 152)', dark: 'oklch(0.72 0.105 152)' },
  ocean: { label: '海蓝', light: 'oklch(0.56 0.11 250)', dark: 'oklch(0.72 0.1 250)' },
  rose: { label: '玫瑰', light: 'oklch(0.6 0.13 12)', dark: 'oklch(0.73 0.11 12)' },
  graphite: { label: '石墨（中性）', light: 'oklch(0.42 0.008 260)', dark: 'oklch(0.78 0.008 260)' }
}

// ---------- TTS 配置（双通道：火山引擎 / 阿里云百炼） ----------

export const TTS_PROVIDERS = ['volcano', 'bailian'] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]

/** 服务商短名（错误提示与音色分组标题用）；完整名见 TTS provider manifest 的 label */
export const TTS_PROVIDER_SHORT: Record<TtsProvider, string> = {
  volcano: '火山引擎',
  bailian: '阿里云百炼'
}

// ---------- TTS 模型目录与音色目录（provider manifest 的 models 段，经 IPC 交给渲染层） ----------

/** 目录里的一个系统音色 */
export interface VoiceSpec {
  /** 合成请求里的音色标识（火山 voice_type / 百炼 voice） */
  id: string
  /** 中文名 */
  name: string
  /** 场景/风格描述 */
  desc?: string
}

/** 目录分组（按官方文档的分组原样收录） */
export interface VoiceGroup {
  label: string
  voices: VoiceSpec[]
}

/** 模型级可调参数声明：默认值 ← 接入 models[].params 覆盖 ← 调用级覆盖 */
export interface ParamSpec {
  key: string
  label: string
  type: 'number' | 'select' | 'text'
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  default?: string | number
  help?: string
}

/** 服务商下的一个模型（manifest 静态内置，含系统音色目录） */
export interface TtsModelSpec {
  id: string
  label: string
  note?: string
  /** tts=普通合成；clone=复刻/ICL 模型（只吃克隆音色）；realtime 暂不进选择器 */
  kind: 'tts' | 'clone' | 'realtime'
  /** 端点需要业务空间 ID（百炼 maas 系） */
  needsWorkspace?: boolean
  /** 该模型支持 SSE/流式合成 */
  streaming?: boolean
  /** 该模型支持语气指令（调用级覆盖，不进模型 params）；缺省视为不支持 */
  instruction?: boolean
  /** 模型级可调参数 */
  params: ParamSpec[]
  /** 系统音色静态目录；空数组 = 官方未给目录，手动输入兜底 */
  voices: VoiceGroup[]
  /** 可作为复刻 target_model */
  cloneTarget?: boolean
}

/**
 * 语音合成的遗留偏好。凭据、模型、实时开关都在 tts_connections 接入里（一条 = 一个服务商账号），
 * 合成时按生效音色的归属路由到对应接入（见 TtsService.route）：没有默认接入，也没有默认音色。
 * 这份配置只剩迁移与「发音测试时间」在用。
 */
export interface TtsConfig {
  /** @deprecated 迁移用：旧配置的「默认服务商」，只在老库抽第一条接入时用 */
  providerId: TtsProvider
  /** @deprecated 迁移用（旧配置里「当前服务商」）：默认服务商缺失时取它；新代码一律读 providerId */
  provider: TtsProvider
  /** @deprecated 迁移用：已迁入 tts_connections，新代码不再读 */
  appId: string
  /** @deprecated 迁移用：已迁入 tts_connections（敏感字段，加密落盘（secretBox）） */
  accessToken: string
  /** @deprecated 迁移用：已迁入 tts_connections */
  cluster: string
  /** @deprecated 迁移用：已迁入 tts_connections（敏感字段，加密落盘（secretBox）） */
  apiKey: string
  /** @deprecated 迁移用：已迁入 tts_connections */
  model: string
  /** @deprecated 迁移用：已迁入 tts_connections */
  baseUrl: string
  /** @deprecated 迁移用：已迁入 tts_connections */
  languageType: string
  /** @deprecated 迁移用：已迁入 tts_connections */
  workspaceId: string
  /** @deprecated 迁移用：旧的全局默认音色，升级时清空，新代码一律读人设卡/场次的音色 */
  voiceId: string
  /** @deprecated 迁移用：已折入接入某个模型的 models[].params（speech_rate），新代码不再读 */
  speed: number
  /** 实时合成：不预合成整段音频，播出时边合成边播（降低首包延迟；需要服务商支持流式） */
  realtime: boolean
  /** 语气指令（instruction，≤100 字符）：自然语言描述语音表现，如「语速稍快，语气热情」 */
  instruction: string
  /** @deprecated 迁移用：已折入接入模型的 models[].params（format），新代码不再读 */
  format: 'mp3' | 'wav' | 'pcm'
  /** @deprecated 迁移用：已折入接入模型的 models[].params（sample_rate），新代码不再读 */
  sampleRate: number
  /** 上次「测试发音」成功的时间戳（预检里提示凭据可能失效，docs/07 §8.5） */
  lastTestAt: number
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  providerId: 'volcano',
  provider: 'volcano',
  appId: '',
  accessToken: '',
  cluster: 'volcano_tts',
  apiKey: '',
  model: 'qwen3-tts-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  languageType: 'Chinese',
  workspaceId: '',
  voiceId: '',
  speed: 1.0,
  realtime: false,
  instruction: '',
  format: 'mp3',
  sampleRate: 24000,
  lastTestAt: 0
}

// ---------- 语音合成的服务商接入（一个条目 = 一个服务商 + 一份凭据 + 它的模型与参数） ----------

/** 接入里启用的一个模型及其参数覆盖（参数键由 manifest 里该模型的 ParamSpec 声明，比如语气指令） */
export interface TtsConnectionModel {
  id: string
  /** 覆盖 manifest ParamSpec 默认值；缺省用默认 */
  params: Record<string, string | number | boolean>
}

/**
 * 一条接入 = 一个服务商账号（凭据 + 它启用的模型 + 实时合成开关）。
 * 没有「默认模型」「默认音色」「默认接入」：合成时用哪条接入的哪个模型，
 * 由音色自己决定（克隆音色带 connection_id + model；系统音色在模型目录里反查；
 * 手动音色用 `接入::模型::音色` 复合串显式指定）。
 */
export interface TtsConnection {
  id: string
  providerId: TtsProvider
  /** 显示名，默认取服务商 label，可改 */
  name: string
  /** 该服务商的凭据（按 provider manifest 的 configFields；secret 字段落盘加密） */
  params: Record<string, string | number | boolean>
  /** 启用的模型及其参数覆盖 */
  models: TtsConnectionModel[]
  /** 实时合成（动态内容流式播报）：按接入开，只有支持流式的模型才真生效 */
  realtime: boolean
  createdAt: number
  updatedAt: number
}

/** 新建/编辑接入入参：密钥字段留空表示不修改（沿用已保存的那个） */
export interface TtsConnectionInput {
  id?: string
  providerId: TtsProvider
  name: string
  params: Record<string, string | number | boolean>
  models: TtsConnectionModel[]
  realtime?: boolean
}

/** 给渲染层用的接入：密钥字段的值置空，只留「填没填过」「能不能用」与「哪些模型可用」 */
export type TtsConnectionSafe = TtsConnection & {
  hasSecret: boolean
  ready: boolean
  /** 启用的模型里现在真能合成的那些（缺业务空间 ID 等前置条件的模型不在这里） */
  usableModels: string[]
}

/** 某家服务商是否已配好接入（有这条接入且必填项齐）：音色提示、筛选标记与预检都按它判断 */
export function ttsProviderConfigured(
  connections: TtsConnectionSafe[],
  providerId: TtsProvider
): boolean {
  return connections.some((connection) => connection.providerId === providerId && connection.ready)
}

/**
 * @deprecated 迁移用：判断旧的 config.tts 平铺凭据里某家填没填过（`migrateLegacyTts` 抽接入时用）。
 * 新代码一律看 `tts_connections` 有没有这条接入。
 */
export function ttsProviderHasCredentials(tts: TtsConfig, provider: TtsProvider): boolean {
  return provider === 'bailian' ? Boolean(tts.apiKey) : Boolean(tts.appId && tts.accessToken)
}

// ---------- LLM 配置（主播 Agent 的大脑） ----------

export const LLM_PROVIDERS = ['deepseek', 'qwen', 'doubao', 'kimi', 'zai'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export interface LlmConfig {
  provider: LlmProvider
  /** 模型 id（留空用该服务商默认值） */
  model: string
  /** API Key（敏感字段，加密落盘（secretBox），运行时注入 pi，不落 pi 的盘） */
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

/** 旧的单体 LLM 配置是否还能用。接入库为空时的兜底（迁移期保留，不删字段）。 */
export function legacyLlmConfigured(llm: LlmConfig): boolean {
  return Boolean(llm.apiKey && (llm.model || LLM_PROVIDER_META[llm.provider].defaultModel))
}

// ---------- 供应商接入（一条 = 一个服务商 + 一份凭据 + 一串可用模型） ----------

export interface ModelConnection {
  id: string
  /** 显示名，默认取服务商 label，可改 */
  name: string
  providerId: string
  /** 各家自有参数（键由 provider 的 configFields 声明）；密钥字段落盘加密 */
  params: Record<string, string | number | boolean>
  /** 这家服务商下可用的模型 id 列表 */
  models: string[]
  createdAt: number
  updatedAt: number
}

/** 给渲染层用的接入：密钥字段的值置为空串，只留「填没填过」与「能不能用」两个标记 */
export interface ModelConnectionSafe extends ModelConnection {
  /** 是否已保存过密钥（渲染层不拿密钥本身） */
  hasSecret: boolean
  /** 主进程按 provider manifest 判定的可用性：有模型且凭据齐备（密钥可空的服务商不要求密钥） */
  ready: boolean
}

/** 新建/编辑接入入参：密钥字段留空表示不修改（沿用已保存的那个） */
export interface ModelConnectionInput {
  id?: string
  name: string
  providerId: string
  params: Record<string, string | number | boolean>
  models: string[]
}

/**
 * 当前主播卡的语言模型是否就绪（状态栏徽章用）：卡上显式选了接入和模型，
 * 且那条接入的密钥齐备、模型还在列表里——没选模型就等于没配置。
 */
export function llmReady(
  connections: ModelConnectionSafe[],
  persona: Persona | null | undefined
): boolean {
  const connection = persona?.modelConnectionId
    ? connections.find((item) => item.id === persona.modelConnectionId)
    : undefined
  if (!connection?.ready) return false
  return connection.models.includes(persona?.model ?? '')
}

// ---------- 应用配置 ----------

/** 触发器全局配置（AppConfig.trigger 段） */
export interface TriggerConfig {
  /** 全局 LLM 速率帽：每分钟最多触发 LLM 的次数（steer/task 合计），超出降级丢弃 */
  maxLlmPerMinute: number
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  maxLlmPerMinute: 6
}

/** 当前场次（config.live 段） */
export interface LiveStateConfig {
  /** 当前选中的场次 id（空串 = 未选择） */
  activePlanId: string
}

export const DEFAULT_LIVE_CONFIG: LiveStateConfig = { activePlanId: '' }

export const DEFAULT_STREAM_CONFIG: StreamConfig = { mode: 'companion', serverUrl: '', streamKey: '' }

export const DEFAULT_BGM_CONFIG: BgmConfig = { path: '', volume: 0.3 }

export const DEFAULT_COMMENT_CONFIG: CommentConfig = { connectorPort: 8102, connectorToken: '' }

function parseStream(input: unknown): StreamConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    mode: row.mode === 'direct' ? 'direct' : 'companion',
    serverUrl: typeof row.serverUrl === 'string' ? row.serverUrl : '',
    streamKey: typeof row.streamKey === 'string' ? row.streamKey : ''
  }
}

function parseComment(input: unknown): CommentConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  let port = Number(row.connectorPort)
  if (port === 8101) port = 8102 // v1（WS 事件面）→ v2（MCP）端口迁移
  return {
    connectorPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8102,
    connectorToken: typeof row.connectorToken === 'string' ? row.connectorToken : ''
  }
}

function parseBgm(input: unknown): BgmConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    path: typeof row.path === 'string' ? row.path : '',
    volume: typeof row.volume === 'number' && row.volume >= 0 && row.volume <= 1 ? row.volume : 0.3
  }
}

/** 持久化到数据库 app_config 表（单行 JSON）的应用配置。 */
export interface AppConfig {
  theme: AppTheme
  /** 配色主题（点缀色） */
  accent: AppAccent
  tts: TtsConfig
  llm: LlmConfig
  /** 主播 Agent 运行参数（高级） */
  agent: AgentConfig
  trigger: TriggerConfig
  live: LiveStateConfig
  stream: StreamConfig
  bgm: BgmConfig
  comment: CommentConfig
}

/** 主播 Agent 运行参数：长会话自动压缩的标尺 */
export interface AgentConfig {
  /** 上下文窗口覆盖（tokens）：自动压缩按「窗口 − 16k」触发；0 = 按服务商声明/内置目录 */
  contextWindow: number
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  contextWindow: 0
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  accent: 'clay',
  tts: DEFAULT_TTS_CONFIG,
  llm: DEFAULT_LLM_CONFIG,
  agent: DEFAULT_AGENT_CONFIG,
  trigger: DEFAULT_TRIGGER_CONFIG,
  live: DEFAULT_LIVE_CONFIG,
  stream: DEFAULT_STREAM_CONFIG,
  bgm: DEFAULT_BGM_CONFIG,
  comment: DEFAULT_COMMENT_CONFIG
}

/** 单层到多层的部分更新（secret 字段同样是明文进、密文存） */
export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K]
}

export function parseAppConfig(input: unknown): AppConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const ttsRow = row.tts && typeof row.tts === 'object' ? (row.tts as Record<string, unknown>) : {}
  const legacyTtsProvider =
    TTS_PROVIDERS.find((id) => id === ttsRow.provider) ?? DEFAULT_TTS_CONFIG.providerId
  const tts: TtsConfig = {
    // 默认服务商：新字段优先；老配置只有 provider，升级后它就是默认那家
    providerId: TTS_PROVIDERS.find((id) => id === ttsRow.providerId) ?? legacyTtsProvider,
    provider: legacyTtsProvider,
    appId: typeof ttsRow.appId === 'string' ? ttsRow.appId : '',
    accessToken: typeof ttsRow.accessToken === 'string' ? ttsRow.accessToken : '',
    cluster: typeof ttsRow.cluster === 'string' ? ttsRow.cluster : DEFAULT_TTS_CONFIG.cluster,
    apiKey: typeof ttsRow.apiKey === 'string' ? ttsRow.apiKey : '',
    model: typeof ttsRow.model === 'string' ? ttsRow.model : DEFAULT_TTS_CONFIG.model,
    baseUrl: typeof ttsRow.baseUrl === 'string' ? ttsRow.baseUrl : DEFAULT_TTS_CONFIG.baseUrl,
    languageType:
      typeof ttsRow.languageType === 'string' ? ttsRow.languageType : DEFAULT_TTS_CONFIG.languageType,
    voiceId: typeof ttsRow.voiceId === 'string' ? ttsRow.voiceId : '',
    speed: typeof ttsRow.speed === 'number' && ttsRow.speed > 0 ? ttsRow.speed : 1.0,
    realtime: ttsRow.realtime === true,
    workspaceId: typeof ttsRow.workspaceId === 'string' ? ttsRow.workspaceId : '',
    instruction: typeof ttsRow.instruction === 'string' ? ttsRow.instruction : '',
    format:
      ttsRow.format === 'wav' || ttsRow.format === 'pcm'
        ? ttsRow.format
        : 'mp3',
    sampleRate: typeof ttsRow.sampleRate === 'number' && ttsRow.sampleRate > 0 ? ttsRow.sampleRate : 24000,
    lastTestAt: typeof ttsRow.lastTestAt === 'number' ? ttsRow.lastTestAt : 0
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
  const triggerRow =
    row.trigger && typeof row.trigger === 'object' ? (row.trigger as Record<string, unknown>) : {}
  const trigger: TriggerConfig = {
    maxLlmPerMinute:
      typeof triggerRow.maxLlmPerMinute === 'number' && triggerRow.maxLlmPerMinute > 0
        ? triggerRow.maxLlmPerMinute
        : DEFAULT_TRIGGER_CONFIG.maxLlmPerMinute
  }
  const liveRow = row.live && typeof row.live === 'object' ? (row.live as Record<string, unknown>) : {}
  const agentRow =
    row.agent && typeof row.agent === 'object' ? (row.agent as Record<string, unknown>) : {}
  return {
    theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme,
    accent: APP_ACCENTS.find((id) => id === row.accent) ?? DEFAULT_CONFIG.accent,
    tts,
    llm,
    agent: {
      contextWindow:
        typeof agentRow.contextWindow === 'number' && agentRow.contextWindow > 0
          ? Math.floor(agentRow.contextWindow)
          : 0
    },
    trigger,
    live: { activePlanId: typeof liveRow.activePlanId === 'string' ? liveRow.activePlanId : '' },
    stream: parseStream(row.stream),
    bgm: parseBgm(row.bgm),
    comment: parseComment(row.comment)
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
  /** 角色音色（编剧模式），空串 = 用当前主播的音色 */
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
  /** 语音稿：真正送进 TTS 的文本（已把 @昵称 转成自然称呼）；空则用 text */
  speechText?: string
  /** 实时合成条目：不预合成文件，播出时由主进程流式合成 + 排播（tts.realtime 开启时） */
  stream?: boolean
  /** 取件来源：话术库条目 id（复盘溯源用，docs/07 §3） */
  originUtteranceId?: string
  /** 连贯段落 id：同一段的条目是一次整段合成后切开的，播出时按顺序连在一起语气才自然 */
  paraId?: string
  /** 段内位置（从 1 开始）与段落总条数，供池状态展示与插播调度 */
  paraPos?: number
  paraLen?: number
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
  /** 从话术库取件入池时带来源 id（复盘溯源） */
  originUtteranceId?: string
  /** 连贯段落标记（见 SpeechItem.paraId），装载话术库时带入 */
  paraId?: string
  paraPos?: number
  paraLen?: number
  /** 手动指定的播出锚点（插播到段落末尾这类精确位置用；不传按入池时间排） */
  sortOrder?: number
  /** 已预合成的音频文件（话术库预合成产物）：带上即置 ready，不再重复合成 */
  audioPath?: string
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
  /** 池内容量上限（未播完条目）；超出场次的底稿按波次装载（轮播补货），不必一次全装 */
  capacity: 50,
  /** 每来源每分钟限流（主播/触发器/人工的硬限） */
  perSourcePerMinute: 20,
  /** 底稿库装载来源（library）的宽松限流：整版底稿按波次重装，一轮要装得下 */
  libraryPerSourcePerMinute: 300,
  /** 预合成窗口：队列前 N 条提前送 TTS */
  synthWindow: 5,
  /** 单条话术字数上限 */
  textMaxLength: 500
} as const

/** 底稿库装载进池的来源 id（限流走 library 档；不占主播自己的发言额度） */
export const LIBRARY_SOURCE_ID = 'library'

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
  /** 音色（火山 voice_type / 百炼 voice，或手动音色的 `接入::模型::音色` 复合串）：必选，没选预检会拦下 */
  voiceId: string
  /** 大脑：绑定的供应商接入 id（ModelConnection.id）；要和 model 一起选好，开播才确定用哪个模型 */
  modelConnectionId: string | null
  /** 指定用接入里的哪个模型（必选）；不在该接入的模型列表里视同没选 */
  model: string
  /** 编剧模式角色：主播一个脑子写多个角色的台词，按 voiceId 路由音色 */
  roles: PersonaRole[]
  updatedAt: number
}

export const DEFAULT_PERSONA: Omit<Persona, 'id' | 'updatedAt'> = {
  name: '小陶',
  personality: '开朗亲切、节奏明快的带货主播，像邻家姐姐一样和观众聊天',
  catchphrases: '家人们、真的绝了、闭眼入、给你们安排上',
  background: '做了三年直播带货，熟悉各种家居好物，对成分和材质很有研究',
  taboos: '不承诺绝对最低价；不贬低其它品牌；不谈论政治和隐私话题；不夸大功效',
  voiceId: '',
  modelConnectionId: null,
  model: '',
  roles: []
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
  /** 生成中预览：text_delta 累积的文本，入池即清空（提词器用） */
  draft: string
  /** 当前场景（提词器显示用），无剧本为空 */
  scene?: { title: string; index: number; total: number }
  /** 会话用途：prep=直播前写稿（播出通道关闭），live=直播中。stopped 时无意义 */
  purpose?: 'prep' | 'live'
  /** 会话出生后资产改过（人设/模型/剧本/场次结构）：改动要重启会话才生效（docs/07 §8.5） */
  assetsStale?: boolean
}

// ---------- 评论（来自连接器，docs/04） ----------

export interface LiveComment {
  id: string
  author: string
  content: string
  ts: number
}

// ---------- 导演对话（docs/07 §8.8） ----------

/** director=导演指令（右侧气泡）；ask=主播请示（高亮卡片+一键选项） */
export type DirectorMessageKind = 'director' | 'ask'

export interface DirectorMessage {
  id: string
  ts: number
  kind: DirectorMessageKind
  text: string
  /** ask 的一键选项 */
  options?: string[]
  /** ask 被回答后记录所选/所答 */
  answered?: string
  /** ask 的等待时限（秒）：超时未答即按默认策略继续，卡片标过期（docs/07 §8.8.6 ④） */
  timeoutSec?: number
  /** ask 超时后主播打算走的默认策略（给导演看"不问会怎么走"） */
  defaultAction?: string
  /** 导演指令附带的文件（名称 + 本机路径，随指令一起发给主播） */
  attachments?: { name: string; path: string }[]
}

// ---------- 对话时间线（main → renderer，docs/07 §8.8 / docs/09 §11） ----------

/**
 * 时间线条目：照 pi-agent 事件流原样渲染，不做二次解释。
 * - text：assistant 消息的正文。中间文本（还在调工具/还会继续说）final 为空，前端渲染成淡色流式行；
 *   本轮最后一条 assistant 消息带 final=true，渲染成独立气泡。
 * - tool：一次工具执行（toolCallId 就是 id），start 时 running，end 时同 id 更新为结果。
 *   请示 ask_director 不走这里（它有自己的卡片通道）。
 */
export type DirectorTimelineEntry =
  | { type: 'text'; id: string; text: string; final?: boolean }
  | {
      type: 'tool'
      id: string
      name: string
      args?: string
      status: 'running' | 'ok' | 'error'
      result?: string
      durationMs?: number
      isError?: boolean
    }

/** 一条时间线事件：turnId = 本轮（一次派给主播的任务）内所有条目的分组键；渲染层按 entry.id upsert */
export interface DirectorTimelineEvent {
  turnId: string
  entry: DirectorTimelineEntry
}

/** 播报控制（主播工具 pause_broadcast / resume_broadcast / skip_current → 渲染进程执行） */
export type PlaybackControlAction = 'pause' | 'resume' | 'skip'

// ---------- 音色库（M8 声音克隆） ----------

export type VoiceProvider = 'volcano' | 'bailian'
export type VoiceStatus = 'training' | 'ready' | 'failed'

export interface VoiceRecord {
  id: string
  name: string
  provider: VoiceProvider
  /** 克隆完成后的音色标识（火山 speaker_id / 百炼 voice_id），训练完成前为空 */
  voiceType: string
  /** 克隆目标模型（定死，不可跨模型）：火山 seed-icl-x / 百炼 target_model */
  model: string
  /** 克隆时用的接入 id（合成路由只走它：绑定失效就得重新克隆或把接入加回来） */
  connectionId: string
  /** 样本音频文件路径（userData/voices/）；百炼公网 URL 克隆时为空 */
  samplePath: string
  status: VoiceStatus
  /** 失败原因（中文） */
  error: string
  /** 授权确认（合规底线：克隆向导必须勾选并留痕） */
  authorized: boolean
  authorizedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 一条音色被谁引用（人设卡音色 / 角色表） */
export interface VoiceUsagePersona {
  id: string
  name: string
  /** 空 = 用在这张卡的音色上；否则是角色名 */
  role: string
}

/** 音色的引用关系（`voice:usage`）：删除前先看谁在用，别删掉正在用的那个 */
export interface VoiceUsage {
  personas: VoiceUsagePersona[]
  plans: { id: string; name: string }[]
  /** 话术库条目数（可能很多，只给计数） */
  utteranceCount: number
  /** 前几条话术示例（让人认出是哪批话术） */
  utteranceSamples: { id: string; planName: string; text: string }[]
}

// ---------- 知识库（docs/01 §4） ----------

export interface Product {
  id: string
  name: string
  /** 价格（元）。价格护栏的数据源：主播报价只能出自这里 */
  price: number
  sellingPoints: string
  faq: string
  createdAt: number
}

export type ProductInput = Omit<Product, 'id' | 'createdAt'>

export const KNOWLEDGE_KINDS = ['text', 'doc', 'pdf', 'image'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export interface KnowledgeFile {
  id: string
  name: string
  kind: KnowledgeKind
  /** 解析出的文本；image 类型是用户填的一句话描述 */
  content: string
  filePath: string
  createdAt: number
}

/** search_knowledge 的命中结果 */
export interface KnowledgeHit {
  source: 'product' | 'file'
  id: string
  name: string
  /** 命中片段（截断） */
  snippet: string
  /** 商品命中时带价格 */
  price?: number
}

// ---------- 记忆（docs/01 §3.6 三层） ----------

/** 长期记忆：老粉画像 */
export interface ViewerProfile {
  name: string
  /** 互动次数（评论 + remember 调用） */
  interactions: number
  /** 问过的问题（最近 20 条） */
  asks: string[]
  /** 偏好/特征标签 */
  tags: string[]
  /** 主播记的笔记（最近 20 条） */
  notes: string[]
  firstSeenAt: number
  lastSeenAt: number
}

/** 本场记忆：下播总结 */
export interface EpisodeSummary {
  id: string
  startedAt: number
  endedAt: number
  /** 主播自我复盘：亮点 / 翻车 / 高频问题 */
  summary: string
  createdAt: number
}

// ---------- 事件驱动与触发体系（docs/01 §3.5） ----------

export type EventSource = 'pipe' | 'pool' | 'timer' | 'agent' | 'human' | 'system'

export interface LiveEvent {
  id: string
  /** domain.action：viewer.join / gift.received / pool.empty / timer.interval / … */
  type: string
  source: EventSource
  payload: Record<string, unknown>
  ts: number
}

export type TriggerMode = 'tool' | 'steer' | 'task'
export type AggregateAs = 'list' | 'count' | 'latest'

export interface TriggerThrottle {
  /** 聚合窗口：攒一批再触发（毫秒） */
  aggregateMs?: number
  /** 聚合形态：list=名单列表 / count=计数 / latest=只留最新一条 */
  aggregateAs?: AggregateAs
  /** 冷却：两次触发最小间隔（毫秒） */
  cooldownMs?: number
  /** 单场触发预算（防刷），stream.started 时重置 */
  maxPerSession?: number
}

/** mode=tool 时：模板话术直连话术池（不过 LLM） */
export interface TriggerToolAction {
  /** 支持 {{payload.xxx}} / {{aggregated.xxx}} 插值 */
  template: string
  lane?: SpeechLane
}

export interface Trigger {
  id: string
  name: string
  enabled: boolean
  on: {
    event: string
    /** 条件过滤：键值相等命中；键以 Min 结尾表示数值下限（如 giftValueMin: 99） */
    filter?: Record<string, unknown>
  }
  target: {
    agentId: string
    mode: TriggerMode
    toolAction?: TriggerToolAction
    /** mode=steer/task 时给主播的提示模板，支持插值 */
    promptTemplate?: string
  }
  throttle?: TriggerThrottle
}

export type TriggerInput = Omit<Trigger, 'id'> & { id?: string }

// ---------- 剧本与场景（docs/01 §4） ----------

export interface ScriptScene {
  id: string
  title: string
  /** 这场要达成什么（开场留人/痛点共鸣/讲解卖点/互动/催单/收尾） */
  goal: string
  /** 必讲要点，一行一条 */
  keyPoints: string
  /** 预计时长（分钟） */
  estDurationMin: number
}

export interface Script {
  id: string
  title: string
  /** 剧本主题/方向 */
  theme: string
  scenes: ScriptScene[]
  createdAt: number
  updatedAt: number
}

export type ScriptInput = Omit<Script, 'id' | 'createdAt' | 'updatedAt'>

// ---------- 场次（docs/01 §5 场次页；docs/07 §8.5 场次=开播单元） ----------

/** 场次话术库生成配置（docs/07 §4 ①）；条数目标由 plannedMinutes 推算（shared/planDuration） */
export interface PlanGenConfig {
  /** 语气指令（注入生成 Agent） */
  toneHint: string
  /** 单条长度上限（字） */
  maxLen: number
}

export const DEFAULT_PLAN_GEN_CONFIG: PlanGenConfig = {
  toneHint: '',
  maxLen: 60
}

/** 场次知识库范围：'*' = 全部，否则是 id 白名单（docs/07 §3 plan_knowledge） */
export interface PlanKnowledgeScope {
  products: '*' | string[]
  files: '*' | string[]
}

export const DEFAULT_PLAN_KNOWLEDGE_SCOPE: PlanKnowledgeScope = { products: '*', files: '*' }

/** 预设直播时长（分钟）的默认值与下限：开播向导按它推算这场要备多少条底稿 */
export const DEFAULT_PLANNED_MINUTES = 60
export const MIN_PLANNED_MINUTES = 5

export interface LivePlan {
  id: string
  name: string
  /** 本场主题/方向（注入主播 system prompt） */
  theme: string
  /** 绑定人设卡（开播时应用为当前主播，docs/07 §8.5 ②） */
  personaId: string | null
  /** 演出形式提示（单口/对口相声/幽默/朗诵…，注入 system prompt；docs/07 §5.6） */
  styleHint: string
  /** 预设直播时长（分钟）：开播向导按它推算本场底稿规模，预检拿就绪覆盖比对 */
  plannedMinutes: number
  scriptId: string | null
  /** 剧本推进进度（断播续播用），advance_scene 更新 */
  currentSceneIdx: number
  genConfig: PlanGenConfig
  knowledgeScope: PlanKnowledgeScope
  /** 场次指定音色（四层优先级最高：场次 > 角色 > 人设）；空 = 用场次绑的人设卡的音色 */
  voiceId: string
  createdAt: number
  updatedAt: number
}

export type LivePlanInput = Omit<LivePlan, 'id' | 'createdAt' | 'updatedAt' | 'currentSceneIdx'>

/** 新建场次的表单初值（场次页 PlanDialog 用） */
export const DEFAULT_LIVE_PLAN_INPUT: LivePlanInput = {
  name: '',
  theme: '',
  personaId: null,
  styleHint: '',
  plannedMinutes: DEFAULT_PLANNED_MINUTES,
  scriptId: null,
  genConfig: DEFAULT_PLAN_GEN_CONFIG,
  knowledgeScope: DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  voiceId: ''
}

// ---------- 话术库（docs/07 §3 utterances：场次底稿库，与运行态 speech_items 分工） ----------

export type UtteranceStatus = 'pending' | 'synthesizing' | 'ready' | 'failed'

/** 话术来源引用（审阅可追溯；url 类型高亮"外部信息需确认"） */
export interface UtteranceSource {
  type: 'file' | 'url' | 'product'
  id: string
  name: string
  snippet: string
}

export interface Utterance {
  id: string
  planId: string
  /** 所属场景 id；'' = 全场通用（暖场/兜底） */
  sceneId: string
  variantIdx: number
  text: string
  /** 空 = 用场次/人设卡的音色 */
  voiceId: string
  audioPath: string | null
  /** 预合成时实际用的音色：装载进池前比对，音色改过则旧音频作废 */
  synthVoice?: string
  status: UtteranceStatus
  error?: string
  /** initial=生成时产出；adopted=复盘采纳的现场改写版（docs/07 §5.5） */
  source: 'initial' | 'adopted'
  sources: UtteranceSource[]
  /** 连贯段落 id：预合成时同段整组一次合成再切句（见 shared/paragraph.ts）；空 = 逐条合成 */
  paraId?: string
  createdAt: number
}

export type UtteranceInput = Omit<Utterance, 'id' | 'createdAt' | 'status' | 'audioPath' | 'error'>

// ---------- 场次启动预检与装载（docs/07 §8.5） ----------

export type PreflightLevel = 'ok' | 'warn' | 'block'

export interface PreflightItem {
  level: PreflightLevel
  label: string
  detail?: string
  /**
   * 检查项标识（UI 需要针对性反应时用）：
   * 'coverage'=底稿覆盖，预检弹窗靠它决定要不要显示「去生成底稿」入口
   */
  code?: string
}

export interface LaunchResult {
  ok: boolean
  /** 装载进话术池的条目数 */
  loaded?: number
  error?: string
}

// ---------- 人设卡角色（编剧模式多音色，docs/01 §3.1） ----------

export interface PersonaRole {
  name: string
  voiceId: string
  /** 口吻提示（写进 system prompt，告诉主播怎么写这个角色的台词） */
  style: string
}

// ---------- 推流（M7，FFmpeg 静态帧 + PCM 混音直推 RTMP / 伴侣模式只出声） ----------

export type StreamMode = 'direct' | 'companion'

export interface StreamConfig {
  /** direct=FFmpeg 直推 RTMP；companion=直播伴侣采集系统声音（需从伴侣互动工具入口启动） */
  mode: StreamMode
  serverUrl: string
  /** 推流密钥（敏感字段，加密落盘（secretBox）） */
  streamKey: string
}


export interface BgmConfig {
  path: string
  /** 0 - 1 */
  volume: number
}


// ---------- 音频管线（main → renderer） ----------
// 主进程 AudioPipeline 是唯一音频权威：解码/调度/混音/音量都在那边判定，
// 渲染层只把这里推来的 PCM 排队出声。

/** 一片 PCM：s16le / 48kHz / 单声道（渲染层排播；混音器那一路由主进程自己复制成立体声） */
export interface AudioPcmPayload {
  pcm: Uint8Array
  sampleRate: number
  /** 本次播放会话内的递增序号（丢块排查用） */
  seq: number
}

/** 电平（0-1，主进程按片算，渲染层只显示） */
export interface AudioLevelPayload {
  tts: number
  master: number
}

/** 一段播放结束（渲染层据此收尾排播） */
export interface AudioEndPayload {
  itemId?: string
  /** true = 被跳过/急停打断：渲染层立刻掐断已排的队列，不放完 */
  stopped?: boolean
}

export type AudioBgmAction = 'start' | 'stop' | 'volume'

export interface AudioCommandResult {
  ok: boolean
  error?: string
}

export type StreamState = 'idle' | 'starting' | 'live' | 'stopping' | 'error'

export interface StreamStats {
  state: StreamState
  mode: StreamMode
  streaming: boolean
  reconnecting: boolean
  reconnectAttempt: number
  bitrateKbps: number
  durationSec: number
  error?: string
}

export const INITIAL_STREAM_STATS: StreamStats = {
  state: 'idle',
  mode: 'companion',
  streaming: false,
  reconnecting: false,
  reconnectAttempt: 0,
  bitrateKbps: 0,
  durationSec: 0
}

// ---------- 评论接入（docs/04 v2：本地连接器 MCP） ----------

export type ConnectorState = 'idle' | 'connecting' | 'connected' | 'error'

export interface ConnectorStatus {
  state: ConnectorState
  port: number
  error?: string
  receivedCount: number
}

// ---------- 评论接入配置 ----------

export interface CommentConfig {
  /** 本地连接器 MCP 端口（v2 单一协议：事件推送 + 工具调用都走它） */
  connectorPort: number
  /** 连接器 MCP Bearer Token（在连接器设置页复制；敏感字段 加密落盘（secretBox）） */
  connectorToken: string
}

