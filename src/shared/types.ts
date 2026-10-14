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
  /** 实时合成：不预合成整段音频，播出时边合成边播（降低首包延迟；需要服务商支持流式） */
  realtime: boolean
  /** 批量预合成队列：两次合成请求的最小间隔（毫秒）。0 = 跟随服务商默认（按官方限流文档配在 manifest 里：火山 50 / 百炼 400） */
  synthIntervalMs: number
  /** 批量预合成队列：瞬时错误的重试次数（指数退避 2s/4s）；鉴权类硬错误不重试 */
  synthRetries: number
  /** 上次「测试发音」成功的时间戳（预检里提示凭据可能失效，docs/07 §8.5） */
  lastTestAt: number
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  realtime: false,
  synthIntervalMs: 0,
  synthRetries: 2,
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

// ---------- LLM 配置（主播 Agent 的大脑） ----------

export const LLM_PROVIDERS = ['deepseek', 'qwen', 'doubao', 'kimi', 'zai'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export const LLM_PROVIDER_META: Record<LlmProvider, { label: string; defaultModel: string; defaultBaseUrl: string }> = {
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-flash', defaultBaseUrl: 'https://api.deepseek.com' },
  qwen: { label: '通义千问（DashScope）', defaultModel: 'qwen-plus', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  doubao: { label: '豆包（火山方舟）', defaultModel: 'doubao-pro-32k', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  kimi: { label: 'Kimi（月之暗面）', defaultModel: 'kimi-k2.6', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  zai: { label: '智谱（Z.ai）', defaultModel: 'glm-4.7', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
}

// ---------- 供应商接入（一条 = 一个服务商 + 一份凭据 + 一串可用模型） ----------

/** 思考强度（模型级配置）：off=关闭；low/medium/high 映射 pi 的 ThinkingLevel，思考内容流进对话时间线 */
export type ThinkingLevelChoice = 'off' | 'low' | 'medium' | 'high'

/** 模型级高级参数（接入编辑器模型行的「高级」）：都是可选覆盖，缺省走官方/内置默认 */
export interface ModelAdvancedParams {
  /** 多模态：模型能吃图像（导演对话的图片附件才会真的进会话；不开则按路径文本处理） */
  vision?: boolean
  /** 温度（0~2）：越低越稳，越高越发散 */
  temperature?: number
  /** 最大输出 tokens：长稿/长思考可以调大 */
  maxTokens?: number
}

export interface ModelConnection {
  id: string
  /** 显示名，默认取服务商 label，可改 */
  name: string
  providerId: string
  /** 各家自有参数（键由 provider 的 configFields 声明）；密钥字段落盘加密 */
  params: Record<string, string | number | boolean>
  /** 这家服务商下可用的模型 id 列表 */
  models: string[]
  /** 模型级上下文窗口（tokens）：模型 id → 窗口。缺省按服务商声明/pi 内置目录；自动压缩按「窗口 − 16k」触发 */
  modelContextWindows: Record<string, number>
  /** 模型级思考强度：模型 id → 档位；缺省 off（不思考）。模型不支持思考时开了也没效果 */
  modelThinkingLevels: Record<string, ThinkingLevelChoice>
  /** 模型级高级参数：模型 id → { vision/温度/maxTokens }；缺省走官方/内置默认 */
  modelParams: Record<string, ModelAdvancedParams>
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
  /** 模型级上下文窗口（可选，只保留 models 里存在的 id） */
  modelContextWindows?: Record<string, number>
  /** 模型级思考强度（可选，只保留 models 里存在的 id） */
  modelThinkingLevels?: Record<string, ThinkingLevelChoice>
  /** 模型级高级参数（可选，只保留 models 里存在的 id；空对象键不落盘） */
  modelParams?: Record<string, ModelAdvancedParams>
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

/** 当前节目（config.live 段） */
export interface LiveStateConfig {
  /** 当前选中的节目 id（空串 = 未选择） */
  activeProgramId: string
  /** 桥段间留白（毫秒）：正常/兜底车道播完一条后的呼吸停顿；插播/互动车道不等，0 = 不留白 */
  bitGapMs: number
}

export const DEFAULT_LIVE_CONFIG: LiveStateConfig = { activeProgramId: '', bitGapMs: 1200 }

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
  trigger: TriggerConfig
  live: LiveStateConfig
  stream: StreamConfig
  bgm: BgmConfig
  comment: CommentConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  accent: 'clay',
  tts: DEFAULT_TTS_CONFIG,
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
  const tts: TtsConfig = {
    realtime: ttsRow.realtime === true,
    synthIntervalMs:
      // 迁移：500 是「全局限流」时代的默认，那时天天写进库；现在限流归服务商 manifest，
      // 500 按没配过处理（跟随服务商），否则它就成了用户看不见也改不掉的隐藏覆盖
      typeof ttsRow.synthIntervalMs === 'number' && ttsRow.synthIntervalMs >= 0 && ttsRow.synthIntervalMs !== 500
        ? ttsRow.synthIntervalMs
        : DEFAULT_TTS_CONFIG.synthIntervalMs,
    synthRetries:
      typeof ttsRow.synthRetries === 'number' && ttsRow.synthRetries >= 0
        ? Math.floor(ttsRow.synthRetries)
        : DEFAULT_TTS_CONFIG.synthRetries,
    lastTestAt: typeof ttsRow.lastTestAt === 'number' ? ttsRow.lastTestAt : 0
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
  return {
    theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme,
    accent: APP_ACCENTS.find((id) => id === row.accent) ?? DEFAULT_CONFIG.accent,
    tts,
    trigger,
    live: {
      activeProgramId: typeof liveRow.activeProgramId === 'string' ? liveRow.activeProgramId : '',
      bitGapMs:
        typeof liveRow.bitGapMs === 'number' && liveRow.bitGapMs >= 0
          ? liveRow.bitGapMs
          : DEFAULT_LIVE_CONFIG.bitGapMs
    },
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
  /** 现场表演指示（情绪/语气，一句话）：模型支持语气指令时随这次合成发出去（agent 的 say delivery） */
  delivery?: string
  /** 语速倍率（1.0 基准，0.85~1.3）：演法硬参数，内部换算成服务商口径 */
  rate?: number
  /** 音调倍率（1.0 基准，0.9~1.1 保守）：克隆音色大变会不像本人 */
  pitch?: number
  /** 实时合成条目：不预合成文件，播出时由主进程流式合成 + 排播（tts.realtime 开启时） */
  stream?: boolean
  /** 取件来源：话术库条目 id（复盘溯源用，docs/07 §3） */
  originUtteranceId?: string
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
  /** 现场表演指示（情绪/语气，一句话）：模型支持语气指令时随合成发出去 */
  delivery?: string
  /** 语速倍率（1.0 基准，0.85~1.3）/ 音调倍率（0.9~1.1 保守）：演法硬参数，空 = 接入默认 */
  rate?: number
  pitch?: number
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
  /** 手动指定的播出锚点（精确插队用；不传按入池时间排） */
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
  /** 池内容量上限（未播完条目）；超出节目的底稿按波次装载（轮播补货），不必一次全装 */
  capacity: 50,
  /** 每来源每分钟限流（主播/触发器/人工的硬限） */
  perSourcePerMinute: 20,
  /** 底稿库装载来源（library）的宽松限流：整版底稿按波次重装，一轮要装得下 */
  libraryPerSourcePerMinute: 300,
  /** 预合成窗口：队列前 N 条提前送 TTS */
  synthWindow: 5,
  /** 低水位阈值（未播条目数）：降到这就发 pool.low 叫主播续写——等空了再叫必然冷场 */
  lowWater: 3,
  /** 单条话术字数上限（桥段 = 多句连续讲述，90 秒约 500~700 字） */
  textMaxLength: 800
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
  personality:
    '风趣幽默、出口成章的带货主播，爱把卖点编进押韵古诗和打油诗里，说起话来有书卷气但不掉书袋，逗乐为主、叫卖为辅，像说评书一样讲商品',
  catchphrases: '诸位看官、正所谓、且听我说道说道、妙啊',
  background:
    '做了三年直播带货，自诩「直播界一枝笔」，酷爱诗词歌赋，讲商品随手拈来一段押韵，观众都说看她直播像听评书，既能长知识又能捡便宜',
  taboos:
    '不喊「家人们」这类烂大街的称呼（称诸位、各位朋友即可）；诗词点缀自然为主，不硬塞、不拽文到听不懂；不承诺绝对最低价；不贬低其它品牌；不谈论政治和隐私话题；不夸大功效',
  voiceId: '',
  modelConnectionId: null,
  model: '',
  roles: []
}

/**
 * 旧版内置小陶的人设文本（升级迁移用）：库里的卡这三个字段还跟它一字不差，
 * 说明用户没改过人设，启动时自动升级到新版（音色/模型/角色等配置不动）；改过的一律不动。
 */
export const LEGACY_DEFAULT_PERSONA_FIELDS = {
  personality: '开朗亲切、节奏明快的带货主播，像邻家姐姐一样和观众聊天',
  catchphrases: '家人们、真的绝了、闭眼入、给你们安排上',
  background: '做了三年直播带货，熟悉各种家居好物，对成分和材质很有研究',
  taboos: '不承诺绝对最低价；不贬低其它品牌；不谈论政治和隐私话题；不夸大功效'
} as const

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
  /** 会话出生后资产改过（人设/模型/剧本/节目配置）：改动要重启会话才生效（docs/07 §8.5） */
  assetsStale?: boolean
  /** 节目开播态（引擎语义）：launch 置真、结束节目置假，与 agent 会话是否活着无关 */
  live?: boolean
  /** 正在生成（一轮没跑完）：对话输入框的发送钮据此变停止钮 */
  busy?: boolean
  /** 当前上下文估算（tokens，含 system prompt 与工具表开销）；无会话时无 */
  contextTokens?: number
  /** 上下文窗口（tokens）：进度条的分母，涨近「窗口 − 预留」会自动压缩 */
  contextWindow?: number
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
 * - ask：主播请示（ask_director）的高亮卡片——与文本/工具同一条单通道，切场/重启后照常恢复。
 */
export type DirectorTimelineEntry =
  | { type: 'text'; id: string; text: string; final?: boolean; personaId?: string }
  | { type: 'thinking'; id: string; text: string; done?: boolean; personaId?: string }
  | {
      type: 'tool'
      id: string
      name: string
      args?: string
      status: 'running' | 'ok' | 'error'
      result?: string
      durationMs?: number
      isError?: boolean
      personaId?: string
    }
  | { type: 'ask'; id: string; message: DirectorMessage }

/** 一条时间线事件：turnId = 本轮（一次派给主播的任务）内所有条目的分组键；渲染层按 entry.id upsert */
export interface DirectorTimelineEvent {
  turnId: string
  entry: DirectorTimelineEntry
}

/**
 * 对话面板的一行（渲染层完整条目，含导演自己的指令和请示卡片）。
 * main 侧按节目持久化（director_timeline 表），切节目/刷新/重启后整段恢复。
 */
export type ChatEntry =
  | { type: 'director'; id: string; ts: number; text: string; attachments?: { name: string; path: string }[] }
  | { type: 'text'; id: string; ts: number; text: string; final: boolean; turnId: string; personaId?: string }
  | { type: 'thinking'; id: string; ts: number; turnId: string; text: string; done: boolean; personaId?: string }
  | {
      type: 'tool'
      id: string
      ts: number
      turnId: string
      name: string
      args?: string
      status: 'running' | 'ok' | 'error'
      result?: string
      durationMs?: number
      personaId?: string
    }
  | { type: 'ask'; id: string; ts: number; message: DirectorMessage }

/**
 * 时间线整体替换指令：自动压缩成功后 main 清掉该场次的可见历史（留一张压缩卡），
 * 让「有多少聊天记录 = 实际有多长上下文」成立。走 directorTimeline 同一个通道。
 */
export interface DirectorTimelineReset {
  type: 'reset'
  entries: ChatEntry[]
}

/** 播报控制（主播工具 pause_broadcast / resume_broadcast / skip_current → 渲染进程执行） */
export type PlaybackControlAction = 'pause' | 'resume' | 'skip'

// ---------- 提示词模板（设置 → 主播手册） ----------

export interface PromptTemplateInfo {
  key: string
  label: string
  /** 用在哪 + 可用变量说明（编辑界面展示） */
  description: string
  content: string
  updatedAt: number
  /** 内容 = 内置默认（用户没改过） */
  isDefault: boolean
}

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
  programs: { id: string; name: string }[]
  /** 话术库条目数（可能很多，只给计数） */
  utteranceCount: number
  /** 前几条话术示例（让人认出是哪批话术） */
  utteranceSamples: { id: string; programName: string; text: string }[]
}

// ---------- 知识库（docs/01 §4） ----------

/**
 * 知识条目类型：商品只是其中一种——书籍/读物（有声书）、话题/节目（播客）、自定义都行。
 * 条目是主播的弹药库：搜素材走它；只有 product 参与价格护栏（check_price）。
 */
export const ENTRY_KINDS = ['product', 'book', 'topic', 'custom'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  product: '商品',
  book: '书籍/读物',
  topic: '话题/节目',
  custom: '自定义'
}

export interface Product {
  id: string
  name: string
  /** 条目类型（product/book/topic/custom）；老库默认 product */
  kind: EntryKind
  /** 价格（元）。价格护栏的数据源：主播报价只能出自这里（仅 product 有意义） */
  price: number
  /** 要点：商品=卖点；书籍=内容要点；话题=节目要点 */
  sellingPoints: string
  /** 问答/备注：商品=FAQ；其它类型=备注 */
  faq: string
  /** 外部来源 id（抖音商城商品 id 等）：同步时按它去重更新；空 = 本地手工条目 */
  externalId: string
  /** 各类型扩展字段（book.author / topic.guests…），JSON 对象 */
  meta: Record<string, string>
  createdAt: number
}

export type ProductInput = Omit<Product, 'id' | 'createdAt' | 'kind' | 'externalId' | 'meta'> & {
  /** 缺省 product；书籍/话题/自定义条目录它 */
  kind?: EntryKind
  /** 外部来源 id（抖音同步）；缺省空 */
  externalId?: string
  /** 各类型扩展字段；缺省 {} */
  meta?: Record<string, string>
}

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
  /** 条目类型（source=product 时）：书籍/话题/自定义也有 */
  kind?: EntryKind
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

// ---------- 预制音频资产（docs/10 §9.6 RenderedAudioRef） ----------

/** 预制音频状态；stale = 文稿已改、音频与当前文稿不一致（文件保留，不删） */
export type RenderedAudioStatus = 'pending' | 'synthesizing' | 'ready' | 'failed' | 'stale'

/**
 * 预制音频引用：预制节目的正式产物，挂在 Scene（整章/整期）或 Utterance（段）上。
 * 与 Utterance.audioPath/status 的分工：后者是滚动合成的运行态字段；rendered 是长期资产，
 * 应用重启不随播出队列清理。开始预制合成时把声音安排冻结成快照写进来，
 * 之后切换主播/改主播音色不改写已有 rendered。
 */
export interface RenderedAudioRef {
  audioPath: string
  durationMs?: number
  status: RenderedAudioStatus
  /** 合成时冻结的完整声音快照；切换当前主播不改写。外部音频记 'external' */
  ttsConnectionId: string
  ttsModelId: string
  /** 音色或角色表的指纹（冻结快照的一部分） */
  voiceOrCastFingerprint: string
  /** 合成时的文稿指纹（shared/fingerprint）；与当前文稿不一致 → stale */
  sourceFingerprint: string
  /** true = 用户导入的外部音频（跳过 TTS，不参与重新合成） */
  external?: boolean
  error?: string
}

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
  /** 整章/整期预制音频（预制节目；存在 scripts.scenes JSON 内，docs/10 §9.6） */
  rendered?: RenderedAudioRef
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

// ---------- 节目（Program，原场次升级：一场直播/一期播客/一本有声书都是一个节目） ----------

/** 节目知识库范围：'*' = 全部，否则是 id 白名单 */
export interface ProgramKnowledgeScope {
  products: '*' | string[]
  files: '*' | string[]
}

export const DEFAULT_PROGRAM_KNOWLEDGE_SCOPE: ProgramKnowledgeScope = { products: '*', files: '*' }

/** 内容类型（UI 显示用 CONTENT_TYPE_LABELS；只影响 prompt/写稿任务书/界面文案，不限制播放导出） */
export type ContentType = 'solo' | 'conversation' | 'reading' | 'roleplay'

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  solo: '一个人讲',
  conversation: '多人聊天',
  reading: '照着稿子读',
  roleplay: '分角色表演'
}

/** 播出方式：现场发挥=无底稿实时说 / 边播边准备=滚动合成窗口 / 全部做好再播=预制全量合成 */
export type BroadcastMode = 'improvised' | 'rolling' | 'prepared'

export const BROADCAST_MODE_LABELS: Record<BroadcastMode, string> = {
  improvised: '现场发挥',
  rolling: '边播边准备',
  prepared: '全部做好再播'
}

/** 播完以后（即兴播出无此概念） */
export type FinishMode = 'stop' | 'loop'

export type ProgramAudioMode = 'follow-presenter' | 'custom'

export interface ProgramCastMember {
  roleId: string
  roleName: string
  voiceId: string
}

/** 节目声音配置：跟随当前主播（默认）或自定义合成模型+角色选角；预制合成开始时冻结成快照 */
export interface ProgramAudioConfig {
  mode: ProgramAudioMode
  ttsConnectionId?: string
  ttsModelId?: string
  cast?: ProgramCastMember[]
}

export const DEFAULT_PROGRAM_AUDIO_CONFIG: ProgramAudioConfig = { mode: 'follow-presenter' }

export interface Program {
  id: string
  name: string
  /** 本场主题/节目说明（注入主播 system prompt） */
  theme: string
  contentType: ContentType
  broadcastMode: BroadcastMode
  finishMode: FinishMode
  /** 是否把直播间动态（评论/礼物/进场）提供给主播 Agent */
  allowLiveEvents: boolean
  /** 启用的全局触发器 id（触发器定义在全局触发器库，节目只存启用项） */
  enabledTriggerIds: string[]
  audioConfig: ProgramAudioConfig
  scriptId: string | null
  knowledgeScope: ProgramKnowledgeScope
  /** 剧本推进进度（断播续播用），advance_scene 更新 */
  currentSceneIdx: number
  createdAt: number
  updatedAt: number
}

export type ProgramInput = Omit<Program, 'id' | 'createdAt' | 'updatedAt' | 'currentSceneIdx'>

export const DEFAULT_PROGRAM_INPUT: ProgramInput = {
  name: '',
  theme: '',
  contentType: 'solo',
  broadcastMode: 'rolling',
  finishMode: 'loop',
  allowLiveEvents: true,
  enabledTriggerIds: [],
  audioConfig: DEFAULT_PROGRAM_AUDIO_CONFIG,
  scriptId: null,
  knowledgeScope: DEFAULT_PROGRAM_KNOWLEDGE_SCOPE
}

// ---------- 话术库（docs/07 §3 utterances：节目底稿库，与运行态 speech_items 分工） ----------

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
  programId: string
  /** 所属场景 id；'' = 全场通用（暖场/兜底，不许写开场和收尾） */
  sceneId: string
  variantIdx: number
  /**
   * 场景内创作顺序号（同场景递增）：装池按它排，首轮严格按叙事顺序播放——
   * 写作时建立的铺垫→展开→落点不再被轮换打乱
   */
  seq: number
  text: string
  /**
   * 桥段类型（BIT_TYPES 之一）；'' = 旧式单句（桥段制之前的底稿）。
   * 桥段 = 内容/合成/播放/缓存四个单元对齐的一段连续讲述（多句、30~90 秒）。
   */
  bitType: string
  /** 表演指示（情绪/语速/停顿，一句话）：合成时随文本一起进 TTS 的语境，UI 可编辑 */
  delivery: string
  /** 语速倍率（1.0 基准，0.85~1.3）：agent 演法的硬参数，内部换算成服务商口径；空 = 接入默认 */
  rate?: number
  /** 音调倍率（1.0 基准，保守 0.9~1.1）：克隆音色大变会不像本人；空 = 接入默认 */
  pitch?: number
  /** 空 = 用节目/人设卡的音色 */
  voiceId: string
  audioPath: string | null
  /** 预合成时实际用的音色：装载进池前比对，音色改过则旧音频作废 */
  synthVoice?: string
  status: UtteranceStatus
  error?: string
  /** 预制音频资产（预制节目的正式产物，docs/10 §9.6）；滚动节目的段音频继续用 audioPath/status */
  rendered?: RenderedAudioRef
  /** initial=生成时产出；adopted=复盘采纳的现场改写版（docs/07 §5.5） */
  source: 'initial' | 'adopted'
  sources: UtteranceSource[]
  createdAt: number
}

export type UtteranceInput = Omit<Utterance, 'id' | 'createdAt' | 'status' | 'audioPath' | 'error' | 'seq'> & {
  /** 不传 = 自动排到这个场景末尾（编辑已有条目时保留原序号） */
  seq?: number
}

/** 桥段类型（内容形态标签）：写稿/展示/防单调都用它；自定义类型也允许（存档原样展示）。
 *  closer 特殊：收尾段不进自动轮播（播到一半来句「下回接着聊」就穿帮了），主播要收尾时自己 say 出去 */
export const BIT_TYPES = [
  { id: 'hook', label: '开场钩' },
  { id: 'story', label: '故事' },
  { id: 'scene', label: '场景化' },
  { id: 'math', label: '算账' },
  { id: 'compare', label: '对比' },
  { id: 'punchline', label: '包袱' },
  { id: 'interact', label: '互动' },
  { id: 'cta', label: '催单' },
  { id: 'transition', label: '转场' },
  { id: 'closer', label: '收尾' },
  { id: 'general', label: '通用' }
] as const

export const BIT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  BIT_TYPES.map((t) => [t.id, t.label])
)

/** 底稿合成状态的中文名（agent 工具的 list_drafts 与话术库 UI 共用一份，别各写各的） */
export const UTTERANCE_STATUS_LABEL: Record<UtteranceStatus, string> = {
  pending: '待合成',
  synthesizing: '合成中',
  ready: '就绪',
  failed: '失败'
}

// ---------- 节目启动预检与装载（docs/07 §8.5） ----------

export type PreflightLevel = 'ok' | 'warn' | 'block'

export interface PreflightItem {
  level: PreflightLevel
  label: string
  detail?: string
  /**
   * 检查项标识（UI 需要针对性反应时用）：
   * 'draft-empty'=一段底稿都没写（给「去生成底稿」入口）；'presynth'=写了没合成（给「预合成全部」入口）；
   * 'coverage'=底稿就绪（通常 ok 级，无需动作）
   */
  code?: string
}

export interface LaunchResult {
  ok: boolean
  /** 装载进话术池的条目数 */
  loaded?: number
  /** 引擎开播成功但智能层没起来（模型挂了等）：照播存量，agent 就位后恢复 */
  warning?: string
  error?: string
  /** 预制节目正式播放门禁结果（broadcastMode=prepared 时带上；未通过时 ok=false 且不静默跳过） */
  gate?: ProgramGateResult
}

// ---------- 预制音频：生产入口与播放门禁（docs/10 §7.5-§7.9） ----------

/** 节目音频进度（节目内进度展示 + get_program 工具的音频统计） */
export interface ProgramAudioProgress {
  /** 合成单元总数（reading/conversation/roleplay=章，solo=段） */
  total: number
  ready: number
  synthesizing: number
  pending: number
  failed: number
  stale: number
}

/** 门禁未通过单元的明细 */
export interface ProgramGateFailure {
  unitKind: 'scene' | 'utterance'
  unitId: string
  title: string
  status: RenderedAudioStatus | 'missing'
  /** 中文原因（限流/文件丢失/文稿已修改…） */
  reason: string
}

/**
 * 预制节目正式播放门禁结果（docs/10 §7.8）：所有单元 ready + 文件存在 + 指纹一致才算通过。
 * 不通过时调用方拿这个结构给用户三选项：继续生成 / 重试失败 / 仅播放已完成部分。
 */
export interface ProgramGateResult extends ProgramAudioProgress {
  ok: boolean
  programId: string
  failures: ProgramGateFailure[]
}

/** 统一音频生产入口（program:produce-audio / produce_program_audio 工具）的返回 */
export interface ProduceAudioResult {
  ok: boolean
  mode: BroadcastMode
  total: number
  done: number
  failed: number
  /** 已就绪且指纹一致、跳过重合成的单元数 */
  skipped: number
  /** 能力降级提示（如「分段合成并拼接，不等同原生长文模型的连续表演效果」） */
  notice?: string
  error?: string
}

/** 生产前的合成计划摘要（produce_program_audio 的确认卡 / UI 确认弹窗用） */
export interface ProducePlanInfo {
  ok: boolean
  error?: string
  /** 单元数（章/段） */
  units?: number
  /** 章数与总段数 */
  scenes?: number
  segments?: number
  /** 总字数与粗估时长（分钟，按约 4.5 字/秒） */
  totalChars?: number
  estMinutes?: number
  /** 将使用的模型与声音快照描述（冻结进产物） */
  modelDesc?: string
  voiceDesc?: string
  notice?: string
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

/** 主槽播放进度（主进程按片节流推来，预制节目长音频的进度条用） */
export interface AudioProgressPayload {
  /** 正在播的话术条目 id（与话术池快照的 playing 条目对应） */
  itemId: string
  /** 已播位置（毫秒，按已排播 PCM 字节折算；章内 seek 后从新位置继续走） */
  positionMs: number
  /** false = 这段已收尾（播完/被打断），渲染层进度归零 */
  active: boolean
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

