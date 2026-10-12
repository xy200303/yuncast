import type { ModelProfile } from '../../../shared/types'
import { piCloudProviders } from './llm/piCloud'
import { localOpenAiProvider } from './llm/localOpenAi'

/**
 * 语言模型服务商注册表（docs/09 §2、§3）。
 * 能力与配置字段由适配器声明，设置页据此渲染表单——加一家服务商 = 新增一个适配器文件，
 * 不动主流程、不动设置页。只有本文件 import 适配器；业务代码只依赖 LlmProviderDef。
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
  /** 默认模型名，条目里留空时用它 */
  defaultModel: string
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
  providerId: string
  params: Record<string, string | number | boolean>
  model: string
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
 * 条目是否具备调用条件：有模型名（或服务商有默认模型），且必填的密钥字段有值
 * （标注 optional 的密钥可空，如本地服务）。
 */
export function isModelProfileReady(
  profile: Pick<ModelProfile, 'model' | 'params'>,
  def: LlmProviderDef | undefined
): boolean {
  if (!def) return false
  if (!(profile.model.trim() || def.defaultModel)) return false
  return def.configFields.every((field) => {
    if (!field.secret || field.optional) return true
    return String(profile.params[field.key] ?? '').trim().length > 0
  })
}
