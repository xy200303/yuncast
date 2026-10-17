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

// ---------- TTS 模型能力（docs/10 §6.1：特殊能力仍属于 TTS 模型，不新增"后端"概念） ----------

/** 模型种类：普通单人 TTS / 原生长文合成 / 双人播客专用模型 */
export type TtsModelKind = 'standard' | 'longform' | 'podcast'

export const TTS_MODEL_KIND_LABEL: Record<TtsModelKind, string> = {
  standard: '普通',
  longform: '长文',
  podcast: '双人播客'
}

/**
 * 模型能力声明：UI 按它自动变化（隐藏不适用字段），生产入口按它选合成路线（§6.4/§7.6）。
 * manifest 没声明 capabilities 的模型一律按 standard 默认（registry.ttsModelCapabilities 兜底）。
 */
export interface TtsModelCapabilities {
  kind: TtsModelKind
  /** 输入形态：单段文本 / 整章长文本 / 双人轮次稿 */
  input: 'text' | 'longText' | 'dialogueTurns'
  /** 产物形态：整段文件 / 流式 */
  output: 'file' | 'stream'
  minSpeakers: number
  maxSpeakers: number
  /** 能吃克隆音色（播客模型的 speaker_additions / ICL 音色） */
  supportsCloneVoice: boolean
  /** 断点续传（播客模型的 retry_task_id + last_finished_round_id） */
  supportsResume: boolean
  /** 返回逐轮时间戳 */
  supportsTimestamps: boolean
  /** 单次合成总文本上限（字符） */
  maxTextChars?: number
  /** 单轮文本上限（字符，podcast） */
  maxCharsPerTurn?: number
}

// ---------- 统一合成请求（docs/10 §6.5：上层只调统一入口，协议细节归模型适配器） ----------

/** 双人轮次稿的一轮（Agent 生成，角色音色映射后送进 Podcast 模型） */
export interface PodcastTurn {
  speaker: string
  text: string
}

export type TtsSynthesisRequest =
  | {
      type: 'text'
      text: string
      voiceId: string
      instruction?: string
      rate?: number
      pitch?: number
    }
  | {
      type: 'podcast'
      turns: PodcastTurn[]
      /** 恰好两个发音人（speaker id，顺序 = 主持人 A/B） */
      speakers: [string, string]
      useHeadMusic: boolean
      useTailMusic: boolean
      /** 语速倍率（1.0 基准）；空 = 接入默认 speech_rate */
      speechRate?: number
    }

/** 统一合成入口的返回：产物路径 + 能拿到的时长（播客模型按逐轮时长累加） */
export interface TtsSynthesisResult {
  audioPath: string
  durationMs?: number
}

/** 服务商下的一个模型（manifest 静态内置，含系统音色目录） */
export interface TtsModelSpec {
  id: string
  label: string
  note?: string
  /** tts=普通合成；clone=复刻/ICL 模型（只吃克隆音色）；realtime 暂不进选择器 */
  kind: 'tts' | 'clone' | 'realtime'
  /** 能力声明（docs/10 §6.1）；空 = 普通单人 TTS（standard 默认，见 registry.ttsModelCapabilities） */
  capabilities?: TtsModelCapabilities
  /** 端点需要业务空间 ID（百炼 maas 系） */
  needsWorkspace?: boolean
  /** 该模型支持 SSE/流式合成 */
  streaming?: boolean
  /** 该模型支持语气指令（调用级覆盖，不进模型 params）；缺省视为不支持 */
  instruction?: boolean
  /** 该模型支持文本内嵌 [emotion]/[拟声] 标签（百炼 Qwen-Audio 系；shared/speechTags 有白名单）；缺省视为不支持 */
  inlineTags?: boolean
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

/**
 * API 协议（接入级配置，存 params.apiProtocol；服务商只是预设，协议可以自选）：
 * completions = OpenAI 兼容 Chat Completions（绝大多数服务商）；
 * responses   = OpenAI 官方 Responses（GPT-5 系思考强度走它）；
 * anthropic   = Anthropic Messages（Claude 兼容端点，如 Kimi Code 编程端点）。
 */
export const LLM_API_PROTOCOLS = ['completions', 'responses', 'anthropic'] as const
export type LlmApiProtocol = (typeof LLM_API_PROTOCOLS)[number]

export const LLM_API_PROTOCOL_META: Record<LlmApiProtocol, { label: string; hint: string }> = {
  completions: {
    label: 'OpenAI 兼容（Chat Completions）',
    hint: '绝大多数服务商：DeepSeek / Kimi / 千问 / 豆包 / 智谱 / Ollama 等'
  },
  responses: {
    label: 'OpenAI Responses',
    hint: 'OpenAI 官方新协议：GPT-5 系的思考强度、缓存统计只在它上面完整生效'
  },
  anthropic: {
    label: 'Anthropic Messages',
    hint: 'Claude 兼容端点：Claude 官方 / Kimi Code 编程端点（k3、kimi-for-coding）'
  }
}

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

/** 模型级单价（历史遗留）：DB 的 model_prices 列与旧数据保留，但单价配置已停用——UI 不再提供录入，用量看板不折算金额 */
export interface LlmModelPrice {
  input?: number
  output?: number
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
  /** 模型级单价（已停用，仅为旧库数据回读保留；UI 不再录入，看板不折算金额） */
  modelPrices: Record<string, LlmModelPrice>
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
  /** 模型级单价（已停用：UI 不再发送，仅为兼容旧调用保留；空对象键不落盘） */
  modelPrices?: Record<string, LlmModelPrice>
}

/**
 * 导演大脑是否就绪（状态栏徽章用）：directorConfig 上显式选了接入和模型，
 * 且那条接入的密钥齐备、模型还在列表里——没选模型就等于没配置。
 */
export function llmReady(
  connections: ModelConnectionSafe[],
  director: DirectorConfig | null | undefined
): boolean {
  const connection = director?.modelConnectionId
    ? connections.find((item) => item.id === director.modelConnectionId)
    : undefined
  if (!connection?.ready) return false
  return connection.models.includes(director?.model ?? '')
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

/** 导演大脑（AppConfig.director 段）：全局一份，系统唯一 agent（导演）的 LLM 接入与模型 */
export interface DirectorConfig {
  /** 导演名字（system prompt 里的恒定身份），默认「小云」 */
  name: string
  /** 大脑：供应商接入 id（ModelConnection.id）；要和 model 一起选好 */
  modelConnectionId: string | null
  /** 指定用接入里的哪个模型（必选）；不在该接入的模型列表里视同没选 */
  model: string
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = { name: '小云', modelConnectionId: null, model: '' }

/** 当前节目（config.live 段） */
export interface LiveStateConfig {
  /** 当前选中的节目 id（空串 = 未选择） */
  activeProgramId: string
}

export const DEFAULT_LIVE_CONFIG: LiveStateConfig = { activeProgramId: '' }

export const DEFAULT_STREAM_CONFIG: StreamConfig = { mode: 'companion', serverUrl: '', streamKey: '' }

export const DEFAULT_BGM_CONFIG: BgmConfig = { path: '', volume: 0.3 }

export const DEFAULT_COMMENT_CONFIG: CommentConfig = { connectorPort: 8102, connectorToken: '' }

// ---------- 开放接口（MCP / CLI，docs 参照同作者 TermPilot） ----------

/** 本机 MCP 服务端口（避开 TermPilot 3927、平台连接器 8102） */
export const MCP_DEFAULT_PORT = 3931
export const MCP_HOST = '127.0.0.1'

/** 开放接口配置（config.mcp 段）：只绑回环地址，Bearer 令牌鉴权，默认关闭 */
export interface McpConfig {
  enabled: boolean
  port: number
  /** 访问令牌（落库时按敏感字段加密；首次启动自动生成） */
  token: string
}

export const DEFAULT_MCP_CONFIG: McpConfig = { enabled: false, port: MCP_DEFAULT_PORT, token: '' }

/** MCP 服务运行状态（设置 → 开放接口 的状态徽标；main 广播 + 拉取共用） */
export interface McpRuntime {
  running: boolean
  port: number
  /** 已建立的 MCP 会话数 */
  clients: number
  /** 起不来时的可读原因（端口被占等） */
  error?: string
}

/** 录屏状态（设置/播放条红点/MCP 工具共用） */
export interface RecordingState {
  recording: boolean
  /** 录制开始时间（毫秒） */
  startedAt?: number
  /** 当前录制落盘文件 */
  file?: string
  /** 画面里是否带鼠标指针 */
  showCursor?: boolean
}

function parseMcp(input: unknown): McpConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const port = Number(row.port)
  return {
    enabled: row.enabled === true,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : MCP_DEFAULT_PORT,
    token: typeof row.token === 'string' ? row.token : ''
  }
}

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
/** 统一数据变更的 scope：界面订阅 data:changed 后按 scope 重拉对应数据 */
export type DataChangeScope =
  | 'personas'
  | 'voices'
  | 'programs'
  | 'drafts'
  | 'knowledge'
  | 'triggers'
  | 'sessions'
  | 'settings'

/** 音频理解（声音风格解析）：复用某条百炼接入的凭据 + 指定模型（Qwen-Omni 系） */
export interface AudioStyleConfig {
  /** 用哪条语音合成接入的 API Key；空 = 自动取最早一条有密钥的百炼接入 */
  connectionId: string
  /** 音频理解模型（默认 qwen3.8-omni-flash） */
  model: string
}

export const DEFAULT_AUDIO_STYLE_CONFIG: AudioStyleConfig = {
  connectionId: '',
  model: 'qwen3.8-omni-flash'
}

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
  director: DirectorConfig
  mcp: McpConfig
  audioStyle: AudioStyleConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  accent: 'clay',
  tts: DEFAULT_TTS_CONFIG,
  trigger: DEFAULT_TRIGGER_CONFIG,
  live: DEFAULT_LIVE_CONFIG,
  stream: DEFAULT_STREAM_CONFIG,
  bgm: DEFAULT_BGM_CONFIG,
  comment: DEFAULT_COMMENT_CONFIG,
  director: DEFAULT_DIRECTOR_CONFIG,
  mcp: DEFAULT_MCP_CONFIG,
  audioStyle: DEFAULT_AUDIO_STYLE_CONFIG
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
  const directorRow =
    row.director && typeof row.director === 'object' ? (row.director as Record<string, unknown>) : {}
  const director: DirectorConfig = {
    name:
      typeof directorRow.name === 'string' && directorRow.name.trim()
        ? directorRow.name.trim()
        : DEFAULT_DIRECTOR_CONFIG.name,
    modelConnectionId:
      typeof directorRow.modelConnectionId === 'string' && directorRow.modelConnectionId
        ? directorRow.modelConnectionId
        : null,
    model: typeof directorRow.model === 'string' ? directorRow.model : ''
  }
  const audioStyleRow =
    row.audioStyle && typeof row.audioStyle === 'object' ? (row.audioStyle as Record<string, unknown>) : {}
  const audioStyle: AudioStyleConfig = {
    connectionId: typeof audioStyleRow.connectionId === 'string' ? audioStyleRow.connectionId : '',
    model: typeof audioStyleRow.model === 'string' && audioStyleRow.model.trim()
      ? audioStyleRow.model.trim()
      : DEFAULT_AUDIO_STYLE_CONFIG.model
  }
  return {
    theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme,
    accent: APP_ACCENTS.find((id) => id === row.accent) ?? DEFAULT_CONFIG.accent,
    tts,
    trigger,
    live: {
      activeProgramId: typeof liveRow.activeProgramId === 'string' ? liveRow.activeProgramId : ''
    },
    stream: parseStream(row.stream),
    bgm: parseBgm(row.bgm),
    comment: parseComment(row.comment),
    director,
    audioStyle,
    mcp: parseMcp(row.mcp)
  }
}

/** app.info() 返回的应用信息 */
export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

/** 应用更新状态（设置 → 关于，main 广播 + check() 返回值共用） */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** available / downloaded 时的新版本号 */
  version?: string
  /** downloading 时的进度百分比 */
  percent?: number
  /** error 时的可读信息 */
  message?: string
}

// ---------- 话术池（SpeechPool，docs/01 §3.2/3.3） ----------

export const SPEECH_LANES = ['interrupt', 'next', 'normal', 'filler'] as const
export type PoolLane = (typeof SPEECH_LANES)[number]

export const SPEECH_SOURCE_KINDS = [
  'scene',
  'reply',
  'interact',
  'announce',
  'filler',
  'manual',
  'reaction'
] as const
export type PoolSourceKind = (typeof SPEECH_SOURCE_KINDS)[number]

export type PoolItemStatus =
  | 'pending'
  | 'synthesizing'
  | 'ready'
  | 'playing'
  | 'done'
  | 'interrupted'
  | 'skipped'
  | 'failed'
  | 'expired'

export interface PoolReplyTo {
  commentId: string
  author: string
}

export interface PoolItem {
  id: string
  sessionId: string
  text: string
  /** 话轮：同一批连续条目原子播出，排序时不被插队拆开 */
  turnId: string
  /** 话轮内顺序 */
  seq: number
  /** 这段归哪张主播卡（稳定寻址；改名/换音色不影响）。空 = 合成时用卡司第一张 */
  /** 角色音色（写稿时按卡司分派），空串 = 用卡司第一张 */
  voiceId: string
  source: { agentId: string; kind: PoolSourceKind }
  lane: PoolLane
  /** 未播条目去重键 */
  dedupeKey?: string
  /** 时效过期不播（毫秒时间戳） */
  expiresAt?: number
  replyTo?: PoolReplyTo
  status: PoolItemStatus
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
  /** 情感（仅火山支持按条指定：happy / angry / sad 等；留空 = 接入默认） */
  emotion?: string
  /** 情感强度（火山 emotion_scale，1~5）：只在带了 emotion 时生效 */
  emotionScale?: number
  /** 语种提示（仅百炼 qwen3-tts 支持：Auto / Chinese / English 等；留空 = 接入默认） */
  languageType?: string
  /** 实时合成条目：不预合成文件，播出时由主进程流式合成 + 排播（tts.realtime 开启时） */
  stream?: boolean
  /** 取件来源：话术库条目 id（复盘溯源用，docs/07 §3） */
  originDraftUnitId?: string
  /** 合成/播放失败原因 */
  error?: string
  /** reorder 手动指定的顺序（优先级高于 createdAt） */
  sortOrder?: number
  /** 播完这条后的停顿毫秒（播放时调度，不进合成）：undefined/0 = 连续播；段内停顿用 <pause> 演法标记 */
  pauseAfterMs?: number
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
  /** 情感 / 情感强度（火山）：按条指定情绪，空 = 接入默认 */
  emotion?: string
  emotionScale?: number
  /** 语种提示（百炼 qwen3-tts）：Auto / Chinese / English…，空 = 接入默认 */
  languageType?: string
  lane?: PoolLane
  sourceKind?: PoolSourceKind
  sourceAgentId?: string
  /** 不传则新开一个话轮 */
  turnId?: string
  seq?: number
  dedupeKey?: string
  expiresAt?: number
  replyTo?: PoolReplyTo
  /** 从话术库取件入池时带来源 id（复盘溯源） */
  originDraftUnitId?: string
  /** 手动指定的播出锚点（精确插队用；不传按入池时间排） */
  sortOrder?: number
  /** 播完这条后的停顿毫秒（播放时调度）：不传 = 连续播 */
  pauseAfterMs?: number
  /** 已预合成的音频文件（话术库预合成产物）：带上即置 ready，不再重复合成 */
  audioPath?: string
}

export interface PoolStatus {
  /** 未播完的条目总数（pending + synthesizing + ready + playing） */
  active: number
  byLane: Record<PoolLane, number>
  playing: PoolItem | null
}

/** 池快照：广播给渲染进程驱动队列视图和提词器 */
export interface PoolSnapshot {
  /** 未播完条目，按播出顺序排好 */
  items: PoolItem[]
  /** 近期合成失败的条目（5 分钟内），供 toast / 队列展示 */
  failed: PoolItem[]
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

// ---------- 主播卡（Presenter：纯数据卡，没有人格大脑；想的事全归导演） ----------

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
  /** 内容红线（写这张卡的台词时绝不能碰的话题/承诺） */
  taboos: string
  /** 音色（火山 voice_type / 百炼 voice，或手动音色的 `接入::模型::音色` 复合串）：必选，没选预检会拦下 */
  voiceId: string
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
  castName?: string
  /** 生成中预览：text_delta 累积的文本，入池即清空（提词器用） */
  draft: string
  /** 当前场景（提词器显示用），无剧本为空 */
  scene?: { title: string; index: number; total: number }
  /** 会话出生后资产改过了：'prompt' = 人设/剧本/手册/节目（热更新即生效，不打断）；
   *  'brain' = 导演模型/接入（要重开会话）；'none'/缺省 = 都对得上（docs/07 §8.5） */
  assetsStale?: 'none' | 'prompt' | 'brain'
  /** 节目开播态（引擎语义）：launch 置真、结束节目置假，与 agent 会话是否活着无关 */
  live?: boolean
  /** 播报暂停中（统一开播控制的「暂停」）：渲染层的「播报中/已暂停」以此为准，不做本地镜像 */
  speakingPaused?: boolean
  /** 引擎侧当前生效的自动响应白名单（节目配置真值；播出中改配置立刻生效） */
  enabledTriggerIds?: string[]
  /** 引擎侧当前生效的互动总闸（节目 allowLiveEvents 真值） */
  allowLiveEvents?: boolean
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
  | {
      type: 'text'
      id: string
      /** append=true 时这里只是**新增片段**（流式增量）；否则是全文 */
      text: string
      append?: boolean
      final?: boolean
      personaId?: string
    }
  | {
      type: 'thinking'
      id: string
      text: string
      append?: boolean
      done?: boolean
      /** 定稿时给：这段思考实际花了多久（渲染层不要拿 ts 反推，见 AgentService 注释） */
      durationMs?: number
      personaId?: string
    }
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
  | {
      type: 'text'
      id: string
      ts: number
      text: string
      final: boolean
      /** 仅 IPC 途中为 true：text 是新增片段，渲染层累加后立刻清掉 */
      append?: boolean
      turnId: string
      personaId?: string
    }
  | {
      type: 'thinking'
      id: string
      ts: number
      turnId: string
      text: string
      done: boolean
      append?: boolean
      durationMs?: number
      personaId?: string
    }
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

// ---------- 提示词模板（设置 → 导演手册） ----------

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
  /**
   * 音色级风格指令（≤100 字符）：合成优先级 agent 逐条演法 > 节目级 > 音色级 > 接入×模型默认参数。
   * 只对支持 instruction 的模型生效（百炼各系 / 火山 seed-tts-2.0；seed-icl 复刻模型静默跳过）
   */
  instruction?: string
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

/** 一条音色被谁引用（主播卡音色） */
export interface VoiceUsagePersona {
  id: string
  name: string
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
// ---------- 事件驱动与触发体系（docs/01 §3.5） ----------

export type EventSource = 'pipe' | 'pool' | 'timer' | 'agent' | 'human' | 'system'

export interface LiveEvent {
  id: string
  /** domain.action：viewer.join / gift.received / pool.empty / timer.interval / … */
  type: string
  source: EventSource
  payload: Record<string, unknown>
  ts: number
  /** 事件发生时选中的节目（写入时取 activeProgramId）；空 = 未选节目 */
  programId?: string
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
  lane?: PoolLane
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
 * 预制音频引用：预制节目的正式产物，挂在 Scene（整章/整期）或 DraftUnit（段）上。
 * 与 DraftUnit.audioPath/status 的分工：后者是滚动合成的运行态字段；rendered 是长期资产，
 * 应用重启不随播出队列清理。开始预制合成时把卡司声音冻结成快照写进来，
 * 之后切换主播/改主播音色不改写已有 rendered。
 */
export interface RenderedAudioRef {
  audioPath: string
  durationMs?: number
  status: RenderedAudioStatus
  /** 合成时冻结的完整声音快照；换卡司不改写。外部音频记 'external' */
  ttsConnectionId: string
  ttsModelId: string
  /** 音色或角色表的指纹（冻结快照的一部分） */
  voiceOrCastFingerprint: string
  /** 合成时的文稿指纹（shared/fingerprint，含节目级风格指令盐）；与当前文稿不一致 → stale */
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

/**
 * 节目语言（多语言节目/跨境电商用）：影响写稿语言、TTS 语种提示与标记编译。
 * auto = 让模型/服务商自动判断（默认，行为与旧版一致）。
 */
export type ProgramLanguage =
  | 'auto'
  | 'Chinese'
  | 'English'
  | 'Japanese'
  | 'Korean'
  | 'German'
  | 'French'
  | 'Russian'
  | 'Italian'
  | 'Spanish'
  | 'Portuguese'

export const PROGRAM_LANGUAGE_LABELS: Record<ProgramLanguage, string> = {
  auto: '自动识别',
  Chinese: '中文',
  English: 'English（英语）',
  Japanese: '日本語（日语）',
  Korean: '한국어（韩语）',
  German: 'Deutsch（德语）',
  French: 'Français（法语）',
  Russian: 'Русский（俄语）',
  Italian: 'Italiano（意大利语）',
  Spanish: 'Español（西班牙语）',
  Portuguese: 'Português（葡萄牙语）'
}

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
  /** 节目卡司：主播卡 id 数组（告诉导演"你手下有哪些人设可用"）；空数组 = 导演自选 */
  presenterIds: string[]
  /**
   * 节目级风格指令（≤100 字）：整期默认演法，覆盖音色默认风格、低于 agent 逐条 delivery；
   * 进文稿指纹盐——改了它预制音频会判过期重合成。节目不再配「声音」，出镜与嗓音由卡司决定。
   */
  instruction?: string
  /** 节目语言（多语言播出）：影响写稿语言与 TTS 语种提示；auto = 自动 */
  language: ProgramLanguage
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
  presenterIds: [],
  instruction: '',
  language: 'auto',
  scriptId: null,
  knowledgeScope: DEFAULT_PROGRAM_KNOWLEDGE_SCOPE
}

// ---------- 直播间动态收件箱（docs/10 §5.3）：直播台「事件流」直接展示这份状态 ----------

export type LiveEventState = 'new' | 'seen' | 'handled' | 'ignored' | 'expired'
export type LiveInboxKind = 'comment' | 'gift' | 'follow' | 'entrance' | 'trigger'

export interface LiveInboxEvent {
  id: string
  /** 连接器事件 id（去重用；触发器通知没有） */
  connectorEventId?: string
  kind: LiveInboxKind
  author: string
  /** 评论文本 / 礼物描述 / 触发器通知文本 */
  content: string
  /** 老粉画像（评论用，入箱时已拼好） */
  profileHint?: string
  /** 提问/价格/售后类识别为 high */
  priority: 'high' | 'normal'
  state: LiveEventState
  /** 相同内容归组计数 */
  count: number
  receivedAt: number
}

export const LIVE_EVENT_STATE_LABELS: Record<LiveEventState, string> = {
  new: '聚合中',
  seen: '已送达主播',
  handled: '已回应',
  ignored: '主播没理',
  expired: '已过期'
}

// ---------- 话术库（docs/07 §3 utterances：节目底稿库，与运行态 pool_items 分工） ----------

export type DraftUnitStatus = 'pending' | 'synthesizing' | 'ready' | 'failed'

/** 话术来源引用（审阅可追溯；url 类型高亮"外部信息需确认"） */
export interface DraftUnitSource {
  type: 'file' | 'url' | 'product'
  id: string
  name: string
  snippet: string
}

export interface DraftUnit {
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
  /** 播完这段后的停顿毫秒（播放时调度，不进合成）：空 = 连续播 */
  pauseAfterMs?: number
  /** 这段归哪张主播卡（稳定寻址：改名/换音色不影响；空 = 合成时用卡司第一张） */
  presenterId?: string
  /** 写稿时的音色快照（presenterId 存在时以卡上当前音色为准），空 = 用卡司第一张 */
  voiceId: string
  audioPath: string | null
  /** 预合成时实际用的音色：装载进池前比对，音色改过则旧音频作废 */
  synthVoice?: string
  status: DraftUnitStatus
  error?: string
  /** 预制音频资产（预制节目的正式产物，docs/10 §9.6）；滚动节目的段音频继续用 audioPath/status */
  rendered?: RenderedAudioRef
  /** initial=生成时产出；adopted=复盘采纳的现场改写版（docs/07 §5.5） */
  source: 'initial' | 'adopted'
  sources: DraftUnitSource[]
  createdAt: number
}

export type DraftUnitInput = Omit<DraftUnit, 'id' | 'createdAt' | 'status' | 'audioPath' | 'error' | 'seq'> & {
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
export const UTTERANCE_STATUS_LABEL: Record<DraftUnitStatus, string> = {
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
  /** 引擎开播成功但导演会话没起来（模型挂了等）：照播存量，会话就位后恢复 */
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
  /** 已就绪（本次会跳过）的单元/段数 */
  readyCount?: number
  /** 本次实际要合成的段数（不含已就绪跳过的） */
  pendingSegments?: number
  /** 待合成总字数与粗估时长（分钟，按约 4.5 字/秒） */
  totalChars?: number
  estMinutes?: number
  /** 将使用的模型与声音快照描述（冻结进产物） */
  modelDesc?: string
  voiceDesc?: string
  notice?: string
}

/**
 * 声音选择弹窗（docs/REDESIGN 4.4）里用户显式选定的声音覆盖：
 * 合成时冻结进产物快照；节目本身不存任何声音配置。
 * - voiceId：单音色覆盖，值是完整可路由音色（克隆 voiceType / 目录音色 / 手动复合串「接入::模型::音色」），
 *   全部段落都用它（弹窗里明示「混音」风险，可勾全部重合成统一）；
 * - castVoices：播客双主持覆盖（顺序 = 主持人 A/B），两个音色必须路由到同一条接入、同一个播客模型。
 */
export interface ProduceVoiceOverride {
  voiceId?: string
  castVoices?: [string, string]
  /**
   * 播客模型的整期配乐（不给就按服务商默认）。
   * 配乐只在「播客双人整期合成」这一条路线上有意义，所以它跟着录入弹窗里选，而不是存在节目上。
   */
  useHeadMusic?: boolean
  useTailMusic?: boolean
}

// ---------- 节目音频导出（docs/10 §8.3/§11.6/§15.17，P6） ----------

/** 导出方式：分章文件 / 合并为一个文件（第一版不做「当前段/当前章」单选，做全部） */
export type ProgramExportMode = 'separate' | 'merged'
export type ProgramExportFormat = 'mp3' | 'wav'

export interface ProgramExportOptions {
  programId: string
  mode: ProgramExportMode
  format: ProgramExportFormat
  /** 输出目录；空字符串 = 主进程弹目录选择框（UI 路径），Agent 路径给默认 exports 目录 */
  outputDir: string
  /** 文件名模板（分段导出用）：含 {节目名} {序号} {段标题} 变量，默认 {节目名}-{序号}-{段标题} */
  fileNameTemplate?: string
  /** 响度归一（ffmpeg loudnorm 一遍法） */
  loudness: boolean
  /** true = 仅导出已完成部分（部分段缺音频时的显式选择，不静默跳过） */
  onlyReady: boolean
}

/** 导出进度事件（IPC 广播：当前第几个/共几个/当前段标题/终态） */
export interface ProgramExportProgress {
  programId: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  /** 当前第几个（1 起）与总数 */
  current: number
  total: number
  /** 当前处理的段标题 */
  title: string
  error?: string
}

export interface ProgramExportResult {
  ok: boolean
  /** 用户取消（已产出的成品文件保留，files 里列出） */
  cancelled?: boolean
  outputDir?: string
  /** 产出文件（完整路径） */
  files?: string[]
  /** 非失败警告：导出期间有音频被更新，结果可能不一致 */
  warning?: string
  error?: string
}

/** 导出前的计划摘要（export_program 确认卡 / UI 弹窗缺章提示用） */
export interface ProgramExportPlan {
  ok: boolean
  error?: string
  total?: number
  ready?: number
  /** 缺音频单元的标题列表（pending/synthesizing/failed/stale/文件丢失都算缺） */
  missing?: { title: string; reason: string }[]
  /** 可导出源文件总字节数（磁盘空间预估用：×1.5 对比可用空间） */
  totalBytes?: number
}

// ---------- 场记（场次记录）：一次开播的完整留档 ----------

/** 场次结束原因：空串 = 还在播（崩溃恢复时会补 'crash'） */
export type BroadcastEndReason = '' | 'manual' | 'auto_stop' | 'emergency' | 'app_quit' | 'crash'

export interface BroadcastSessionCastMember {
  personaId: string
  personaName: string
  voiceDesc: string
}

export interface BroadcastSession {
  id: string
  programId: string
  /** 开播时刻的 snapshot（节目后来改名/删除不影响历史场次显示） */
  programName: string
  /** 开播时刻实际使用的导演大脑与卡司快照 */
  directorModelDesc: string
  cast: BroadcastSessionCastMember[]
  startedAt: number
  /** 0 = 还在播 */
  endedAt: number
  endReason: BroadcastEndReason
  /** 收场时结算：播出条数 / 评论数 / 回复数 */
  stats: { played: number; comments: number; replies: number }
  /** 下播复盘摘要（主播自我复盘写在场上）；空 = 这场没复盘 */
  summary: string
}

/** 场次内事件：评论与直播事件的时间线镜像（话术播出事实在 speech_items.session_id） */
export interface BroadcastEvent {
  id: string
  sessionId: string
  ts: number
  kind: 'comment' | 'event' | 'note'
  /** comment: {author, content}；event: {type, label, payload 摘要}；note: {text} */
  payload: Record<string, unknown>
}

/** 场次内的互动观众：从本场评论按作者聚合；有全局画像（主播长期记忆）的附带过来 */
export interface SessionViewer {
  name: string
  /** 本场发言数 */
  count: number
  /** 本场发言内容（最近最多 5 条） */
  contents: string[]
  profile?: ViewerProfile
}

/** 场次详情：话术播出条目（按实际播出顺序）+ 事件流 + 互动观众，前端交错渲染（摘要在 session.summary） */
export interface SessionDetail {
  session: BroadcastSession
  items: PoolItem[]
  events: BroadcastEvent[]
  viewers: SessionViewer[]
}

/** 场次音频导出：实际播出的有音频条目按播放顺序导出（流式播报无文件，跳过并明示） */
export interface SessionExportOptions {
  sessionId: string
  mode: ProgramExportMode
  format: ProgramExportFormat
  outputDir: string
  loudness: boolean
}

export interface SessionExportResult extends ProgramExportResult {
  /** 跳过的流式播报条数（无音频文件，未包含进导出） */
  skippedStream?: number
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

// ---------- 用量采集（数据页用量看板，DB v3） ----------

/** LLM 用量记录的用途分类 */
export type UsageKind = 'chat' | 'draft' | 'compact'

export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  chat: '直播对话',
  draft: '写稿',
  compact: '上下文压缩'
}

/**
 * 一次 LLM 请求的用量（usage_records 表）：真实 usage 直接落库；
 * 服务商没给 usage 时按字符数/4 估算并标 estimated。
 * cost 列保留在库（历史数据），但已停用：新记录恒为 null，看板只统计用量不折算金额。
 */
export interface UsageRecord {
  id: string
  ts: number
  programId: string | null
  personaId: string
  connectionId: string
  model: string
  kind: UsageKind
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  /** true = 估算值（服务商没回 usage，按字符数/4 估的输出） */
  estimated: boolean
  /** 已停用（恒 null）：历史记录里可能还有按当时单价折算的金额 */
  cost: number | null
}

/** 一次 TTS 合成（tts_records 表）：chars = 送进合成的字符数；cost 已停用（恒 null，历史记录可能有值） */
export interface TtsRecord {
  id: string
  ts: number
  programId: string | null
  connectionId: string
  modelId: string
  voiceId: string
  chars: number
  /** 已停用（恒 null） */
  cost: number | null
}

/** 一段时间/全局的用量合计（用量看板总览卡） */
export interface UsageBucket {
  llmInputTokens: number
  llmOutputTokens: number
  llmCacheRead: number
  ttsChars: number
}

/** 用量看板一屏数据（stats:usage-dashboard） */
export interface UsageDashboard {
  today: UsageBucket
  total: UsageBucket
  /** 近 30 天按天用量（本地时区，缺的天补 0）：llmTokens = 输入 + 输出 tokens */
  trend: { day: string; llmTokens: number; ttsChars: number }[]
  /** 按节目分组用量（全部时间；programId null = 未绑定节目） */
  byProgram: { programId: string | null; programName: string; llmTokens: number; ttsChars: number }[]
}

// ---------- 统计可视化（docs/REDESIGN 4.11）：场次/互动聚合，与用量看板互补 ----------

/** 统计查询参数：时间范围 + 节目筛选（统计页图表与单场图表共用一套口径） */
export interface StatsQuery {
  /** 起始时间（毫秒，含）；0/缺省 = 不限 */
  from?: number
  /** 结束时间（毫秒，含）；0/缺省 = 到现在 */
  to?: number
  /** 只算这个节目；缺省 = 全部节目 */
  programId?: string
}

/** 热词（词云用）：词频已降序排好 */
export interface StatsHotWord {
  word: string
  count: number
}

/** 统计页全局图表一屏数据（stats:global） */
export interface StatsGlobal {
  totals: {
    sessions: number
    /** 播出总时长（毫秒；还在播的场按当前时刻计） */
    broadcastMs: number
    comments: number
    /** 累计互动观众（评论作者去重） */
    viewers: number
    /** 播出话术总字符数（合成量按字符折算时长） */
    speechChars: number
    played: number
  }
  /** 按天播出趋势（本地时区，缺天补 0；最多 30 天，到 query.to/今天为止） */
  trend: { day: string; sessions: number; minutes: number }[]
  /** 按天互动趋势：评论数 / 互动观众数（按天去重） */
  interactionTrend: { day: string; comments: number; viewers: number }[]
  /** 节目排行：场次数 / 总时长（分钟）/ 场均评论 */
  byProgram: { programId: string; programName: string; sessions: number; minutes: number; avgComments: number }[]
  /** 主播排行：按场次卡司快照的 personaName 归集 */
  byPresenter: { personaName: string; sessions: number; minutes: number }[]
  /** 全局评论热词 */
  commentWords: StatsHotWord[]
  /** 全局话术热词（实际播出的条目） */
  speechWords: StatsHotWord[]
}

/** 单场可视化（stats:session，场次详情「图表」tab） */
export interface SessionStats {
  /** 时长（毫秒；还在播的按当前时刻计） */
  durationMs: number
  /** 播出段数（done/interrupted） */
  played: number
  comments: number
  /** 互动观众数（评论作者去重） */
  viewers: number
  /** 按分钟聚合的互动热度：offsetMin = 距开播分钟数 */
  heat: { offsetMin: number; comments: number; speech: number }[]
  /** 本场评论热词 */
  commentWords: StatsHotWord[]
  /** 话术来源构成（实际播出条目按 source.kind 归集） */
  sourceMix: { kind: PoolSourceKind; count: number }[]
  /** 互动最多观众 TOP10 */
  topViewers: { name: string; count: number }[]
}

