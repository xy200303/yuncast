import type {
  ModelConnection,
  ThinkingLevelChoice,
  TtsConnection,
  TtsModelSpec,
  TtsProvider
} from '../../../shared/types'
import { piCloudProviders } from './llm/piCloud'
import { localOpenAiProvider } from './llm/localOpenAi'
import { volcanoTtsProvider } from './tts/volcano'
import { bailianTtsProvider } from './tts/bailian'

/**
 * 服务商注册表：语言模型（docs/09 §2、§3）与语音合成两侧共用同一套声明方式。
 * 能力与配置字段由适配器声明，设置页据此渲染表单——加一家服务商 = 新增一个适配器文件，
 * 不动主流程、不动设置页。只有本文件 import 适配器；业务代码只依赖定义类型。
 */

export interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch'
  placeholder?: string
  help?: string
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  /** 密钥字段：落盘加密，且不回传给渲染层 */
  secret?: boolean
  /** 可空的密钥字段（如本地服务的 apiKey）：留空也算配好 */
  optional?: boolean
  /** 必填字段：缺了就是「还没配齐」（UI 用它列出缺哪几项） */
  required?: boolean
  /** 占满整行（端点、业务空间 ID 这类长字段） */
  wide?: boolean
}

export interface LlmProviderDef {
  /** 'deepseek' | 'qwen' | 'doubao' | 'kimi' | 'zai' | 'local-openai' */
  id: string
  label: string
  /** 渲染层图标键，见 ProviderIcon */
  icon: string
  /** 一句话说明，UI 里做副标题 */
  note: string
  capabilities: { tools: boolean; streaming: boolean; contextWindow?: number }
  /** 各家自有参数（baseUrl / region / apiKey …） */
  configFields: FieldSpec[]
  /** 该服务商的兜底模型名：只在完全没给出模型名时用（如本地服务），不是接入级的默认模型 */
  defaultModel: string
  /**
   * 该服务商的常见模型 id，给设置页的模型列表做下拉建议。
   * pi 内置目录里能查到真实可用模型的（deepseek / kimi / zai）由目录兜底，
   * 查不到的（qwen / 豆包）只有这里列出的名字，所以只填确信存在的。
   */
  modelSuggestions: string[]
  /** 组装成 pi-agent 可用的模型描述（OpenAI 兼容通道） */
  toModelConfig(
    params: Record<string, string | number | boolean>,
    model: string
  ): {
    baseUrl: string
    apiKey: string
    model: string
    api: 'openai-completions'
  }
}

/** IPC 用的纯数据形态：不含函数，可结构化克隆 */
export type LlmProviderManifest = Omit<LlmProviderDef, 'toModelConfig'>

/** 解析出来的模型来源（喂给 prepareLlmModel） */
export interface ResolvedModel {
  /** 命中的接入 id */
  connectionId: string | null
  providerId: string
  params: Record<string, string | number | boolean>
  model: string
  /** 模型级上下文窗口（tokens）：来自接入的模型配置；空 = 按服务商声明/pi 内置目录 */
  contextWindow?: number
  /** 模型级思考强度（接入的模型配置）；缺省 off = 不思考 */
  thinkingLevel?: ThinkingLevelChoice
}

const LLM_PROVIDER_DEFS: LlmProviderDef[] = [...piCloudProviders, localOpenAiProvider]

export function listLlmProviders(): LlmProviderManifest[] {
  return LLM_PROVIDER_DEFS.map(({ toModelConfig: _toModelConfig, ...manifest }) => manifest)
}

export function getLlmProvider(id: string): LlmProviderDef | undefined {
  return LLM_PROVIDER_DEFS.find((def) => def.id === id)
}

/** provider 的密钥字段清单（落盘加密、编辑回填都用它） */
export function secretFieldKeys(providerId: string): string[] {
  return (getLlmProvider(providerId)?.configFields ?? [])
    .filter((field) => field.secret)
    .map((field) => field.key)
}

/**
 * 接入模型列表里的第一个。只在「调用方没指定模型」的场景用（连通性测试、老库补大脑）：
 * 运行时用哪个模型一律由人设卡显式指定，接入没有默认模型这一档。
 */
export function connectionFirstModel(
  connection: Pick<ModelConnection, 'models'>,
  def: LlmProviderDef | undefined
): string {
  const models = connection.models.filter((model) => model.trim())
  return models[0] ?? def?.defaultModel ?? ''
}

/**
 * 接入是否具备调用条件：模型列表里至少有一个模型，且必填的密钥字段有值
 * （标注 optional 的密钥可空，如本地服务）。
 */
export function isModelConnectionReady(
  connection: Pick<ModelConnection, 'models' | 'params'>,
  def: LlmProviderDef | undefined
): boolean {
  if (!def) return false
  if (connection.models.filter((model) => model.trim()).length === 0) return false
  return def.configFields.every((field) => {
    if (!field.secret || field.optional) return true
    return String(connection.params[field.key] ?? '').trim().length > 0
  })
}

/**
 * 语音合成服务商 manifest（与 LLM 侧同一套 FieldSpec 声明凭据字段）。
 *
 * 一条接入 = 一套凭据（configFields，存 tts_connections.params）+ 启用的模型数组
 * （models 里挑，参数覆盖存 tts_connections.models[].params）。
 * `models` 是静态内置的模型目录：每个模型带参数声明（ParamSpec）与系统音色目录
 * （VoiceGroup[]，官方文档解析收录；空数组 = 官方未给目录，手动输入兜底）。
 * 能力位决定「实时合成」开关能不能开、音色克隆入口显不显示：
 *   streaming —— 该服务商是否已接入真流式（百炼 Qwen-TTS / maas 系 SSE）
 *   clone     —— 是否支持音色克隆（火山 V3 voice_clone / 百炼 voice-enrollment）
 * 纯数据，可直接经 IPC 交给渲染层。
 */
export interface TtsProviderManifest {
  id: TtsProvider
  /** 完整名（设置页下拉与服务商标记） */
  label: string
  /** 渲染层图标键，见 ProviderIcon */
  icon: string
  /** 一句话说明，UI 里做副标题 */
  note: string
  capabilities: {
    /** 真流式（边合成边出） */
    streaming: boolean
    /** 音色克隆 */
    clone: boolean
    /** 语气指令 */
    instruction: boolean
    formats: ('mp3' | 'wav' | 'pcm' | 'ogg_opus')[]
  }
  /** 该服务商的接入凭据字段 */
  configFields: FieldSpec[]
  /** 模型目录（含每模型的参数声明与系统音色目录） */
  models: TtsModelSpec[]
  links: { label: string; url: string }[]
  /**
   * 批量预合成的请求间隔默认值（毫秒，按官方限流文档配）：
   * 火山语音合成并发 100（并发制，串行无压力）；百炼 Qwen-TTS/CosyVoice RPM 180 / RPS 3（留余量）。
   * config.tts.synthIntervalMs > 0 时以用户值为准
   */
  defaultSynthIntervalMs: number
}

const TTS_PROVIDER_DEFS: TtsProviderManifest[] = [volcanoTtsProvider, bailianTtsProvider]

export function listTtsProviders(): TtsProviderManifest[] {
  return TTS_PROVIDER_DEFS
}

export function getTtsProvider(id: string): TtsProviderManifest | undefined {
  return TTS_PROVIDER_DEFS.find((def) => def.id === id)
}

/** 该服务商**接入**要填的字段（凭据） */
export function ttsConnectionFields(providerId: string): FieldSpec[] {
  return getTtsProvider(providerId)?.configFields ?? []
}

/** provider 的密钥字段清单（落盘加密、编辑回填都用它） */
export function ttsSecretFieldKeys(providerId: string): string[] {
  return ttsConnectionFields(providerId)
    .filter((field) => field.secret)
    .map((field) => field.key)
}

/** 查某服务商的某个模型 spec */
export function ttsModelSpec(providerId: string, modelId: string): TtsModelSpec | undefined {
  return getTtsProvider(providerId)?.models.find((model) => model.id === modelId)
}

/** 合并某接入某模型的最终参数：manifest ParamSpec 默认值 ← 接入 models[].params 覆盖 */
export function ttsModelParams(
  connection: Pick<TtsConnection, 'models'>,
  spec: TtsModelSpec | undefined,
  modelId: string
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const param of spec?.params ?? []) {
    if (param.default !== undefined) out[param.key] = param.default
  }
  const override = connection.models.find((model) => model.id === modelId)?.params ?? {}
  for (const [key, value] of Object.entries(override)) out[key] = value
  return out
}

/**
 * 系统音色目录反查：这个音色 id 被哪些服务商的哪些模型目录收录
 * （可能多个模型含同名音色，如 longanyang 同属 v3-plus / v3-flash；路由据此挑接入与模型）。
 */
export function findTtsCatalogVoice(
  voiceId: string
): { providerId: TtsProvider; model: TtsModelSpec }[] {
  const id = voiceId.trim()
  if (!id) return []
  const hits: { providerId: TtsProvider; model: TtsModelSpec }[] = []
  for (const def of TTS_PROVIDER_DEFS) {
    for (const model of def.models) {
      if (model.voices.some((group) => group.voices.some((voice) => voice.id === id))) {
        hits.push({ providerId: def.id, model })
      }
    }
  }
  return hits
}

/** 凭据齐不齐：manifest 里标了 required 的字段都有值 */
export function ttsCredentialsOk(
  connection: Pick<TtsConnection, 'params'>,
  def: TtsProviderManifest | undefined
): boolean {
  if (!def) return false
  return ttsConnectionFields(def.id).every((field) => {
    if (!field.required) return true
    return String(connection.params[field.key] ?? '').trim().length > 0
  })
}

/**
 * 这条接入里的**某个模型**现在能不能用：被启用 + 凭据齐 + 该模型自己的前置条件满足
 * （needsWorkspace 的模型要业务空间 ID）。
 * 逐模型判定是必须的：一家接入里 qwen3-tts 能用、qwen-audio 缺业务空间 ID 不能用，是常态，
 * 拿整条接入的 ready 去判断会把能用的模型一起废掉。
 */
export function isTtsModelUsable(
  connection: Pick<TtsConnection, 'params' | 'models'>,
  def: TtsProviderManifest | undefined,
  modelId: string
): boolean {
  return ttsModelBlocker(connection, def, modelId) === null
}

/** 这个模型为什么不能用（中文原因，设置页与路由共用文案）；能用返回 null */
export function ttsModelBlocker(
  connection: Pick<TtsConnection, 'params' | 'models'>,
  def: TtsProviderManifest | undefined,
  modelId: string
): string | null {
  if (!def) return '这条接入的服务商不在语音合成目录里'
  const spec = ttsModelSpec(def.id, modelId)
  if (!spec) return `模型 ${modelId} 不在${def.label}目录里`
  if (!connection.models.some((model) => model.id === modelId)) {
    return `接入没启用模型「${spec.label}」`
  }
  const missing = ttsConnectionFields(def.id).filter(
    (field) => field.required && !String(connection.params[field.key] ?? '').trim()
  )
  if (missing.length > 0) {
    return `接入缺必填凭据：${missing.map((field) => field.label).join(' / ')}`
  }
  if (spec.needsWorkspace && !String(connection.params.workspaceId ?? '').trim()) {
    return `模型「${spec.label}」需要业务空间 ID`
  }
  return null
}

/** 接入是否可以一用：至少有一个启用模型可用（卡片徽章、预检这类粗粒度判断用它） */
export function isTtsConnectionReady(
  connection: Pick<TtsConnection, 'params' | 'models'>,
  def: TtsProviderManifest | undefined
): boolean {
  if (!def) return false
  if (connection.models.filter((model) => model.id.trim()).length === 0) return false
  return connection.models.some((model) => isTtsModelUsable(connection, def, model.id))
}
