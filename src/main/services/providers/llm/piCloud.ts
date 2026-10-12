import { LLM_PROVIDER_META, LLM_PROVIDERS } from '../../../../shared/types'
import type { LlmProviderDef } from '../registry'

/**
 * 云端 OpenAI 兼容通道：DeepSeek / 通义千问 / 豆包 / Kimi / 智谱。
 * 这五家都是「一个密钥 + 可选自定义地址」，所以共用一个适配器，
 * 各自的 label / 默认模型 / 默认地址仍来自 shared/types 的 LLM_PROVIDER_META（不重复定义）。
 */
export const piCloudProviders: LlmProviderDef[] = LLM_PROVIDERS.map((id) => {
  const meta = LLM_PROVIDER_META[id]
  return {
    id,
    label: meta.label,
    icon: id,
    note: `OpenAI 兼容通道 · 默认模型 ${meta.defaultModel}`,
    capabilities: { tools: true, streaming: true },
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        secret: true,
        placeholder: 'sk-…',
        help: '只在落盘时加密保存，运行时注入 pi，不落 pi 的盘'
      },
      {
        key: 'baseUrl',
        label: '自定义 API 地址（留空走官方地址）',
        type: 'text',
        placeholder: meta.defaultBaseUrl
      }
    ],
    defaultModel: meta.defaultModel,
    toModelConfig(params, model) {
      const baseUrl = String(params.baseUrl ?? '').trim() || meta.defaultBaseUrl
      return {
        baseUrl,
        apiKey: String(params.apiKey ?? ''),
        model: model.trim() || meta.defaultModel,
        api: 'openai-completions'
      }
    }
  }
})
