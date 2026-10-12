import type { ModelConnection, TtsProvider } from '../../../shared/types'
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
  /** 默认模型名，接入里没指定时用它 */
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
  /** 命中的接入 id；临时用旧的 config.llm 时为 null */
  connectionId: string | null
  providerId: string
  params: Record<string, string | number | boolean>
  model: string
  /** 没按人设卡指定的模型跑时的兜底说明（预检据此给 warn） */
  fallback?: ResolvedFallback
}

/** 兜底说明的两种来源（条目文案由 LaunchService 拼） */
export type ResolvedFallback =
  /** 人设卡指定的模型已不在该接入的模型列表里，回落用了接入的默认模型 */
  | { kind: 'model'; requested: string; used: string; connectionName: string }
  /** 人设卡没给出可用的接入与模型（没选 / 选了但没配齐），临时用了旧的 config.llm */
  | { kind: 'legacy'; personaName: string; reason: 'missing' | 'unusable'; connectionName?: string }

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
 * 接入实际用的模型：默认模型（得在列表里）→ 列表第一个 → provider 的默认模型。
 * 解析模型、连通性测试都走它，保证「测的是哪条」和「跑的是哪条」一致。
 */
export function connectionModel(
  connection: Pick<ModelConnection, 'models' | 'defaultModel'>,
  def: LlmProviderDef | undefined
): string {
  const models = connection.models.filter((model) => model.trim())
  const preferred = connection.defaultModel.trim()
  if (preferred && models.includes(preferred)) return preferred
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
 * 语音合成服务商 manifest（与 LLM 侧同一套 FieldSpec）。
 * 设置页据此渲染表单，能力位决定「实时合成」开关能不能开、音色克隆入口显不显示：
 *   streaming —— 该服务商是否已接入真流式（docs/06 附录：百炼 Qwen-TTS 已核实，火山待核对）
 *   clone     —— 是否支持音色克隆（docs/06：火山已实现、百炼复刻未实现）
 *   instruction / formats —— 合成请求里实际支持的参数与输出格式
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
    formats: ('mp3' | 'wav' | 'pcm')[]
  }
  /** 该服务商在 TtsConfig 里要填的字段（provider 由下拉承担，清单里保留它是为了完整覆盖） */
  configFields: FieldSpec[]
  /** 「默认音色」字段的说法 */
  voiceHint: { label: string; placeholder: string; help?: string }
  links: { label: string; url: string }[]
}

const TTS_PROVIDER_DEFS: TtsProviderManifest[] = [volcanoTtsProvider, bailianTtsProvider]

export function listTtsProviders(): TtsProviderManifest[] {
  return TTS_PROVIDER_DEFS
}

export function getTtsProvider(id: string): TtsProviderManifest | undefined {
  return TTS_PROVIDER_DEFS.find((def) => def.id === id)
}
