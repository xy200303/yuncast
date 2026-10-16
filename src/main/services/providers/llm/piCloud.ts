import { LLM_PROVIDER_META, LLM_PROVIDERS, type LlmProvider } from '../../../../shared/types'
import type { LlmProviderDef } from '../registry'

/**
 * pi 内置目录里没有的服务商（通义千问 / 豆包）只能靠这里列出的型号做建议，
 * 只填确信存在的通用型号；目录能查到的（deepseek / kimi / zai）不必重复列举。
 * kimi 额外带上编程端点的型号（K3 / kimi-for-coding，配 Anthropic 协议用）。
 */
const EXTRA_MODEL_SUGGESTIONS: Partial<Record<LlmProvider, string[]>> = {
  qwen: ['qwen-max', 'qwen-turbo', 'qwen-long'],
  kimi: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']
}

/** Kimi 双端点：开放平台走 completions；编程端点（K3）走 Anthropic 协议 + 这个地址 */
const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding'

const PROVIDER_NOTES: Partial<Record<LlmProvider, string>> = {
  kimi: '开放平台默认模型 kimi-k2.6 · 编程端点（K3）选 Anthropic 协议即可'
}

/**
 * 各家上下文窗口（tokens）：只给自定义通道（models.json）用——内置目录里的模型以目录为准。
 * 估大了不怕（撑爆会走溢出压缩自愈），估小了会白白频繁压缩，所以都按主流型号的上限填。
 */
const CONTEXT_WINDOWS: Partial<Record<LlmProvider, number>> = {
  // deepseek-chat（V3.2 起）官方 128K
  deepseek: 131072,
  qwen: 131072,
  doubao: 131072,
  kimi: 131072,
  zai: 131072
}

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
    note: PROVIDER_NOTES[id] ?? `OpenAI 兼容通道 · 默认模型 ${meta.defaultModel}`,
    capabilities: { tools: true, streaming: true, contextWindow: CONTEXT_WINDOWS[id] },
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
    defaultApi: 'completions',
    defaultModel: meta.defaultModel,
    modelSuggestions: [...new Set([meta.defaultModel, ...(EXTRA_MODEL_SUGGESTIONS[id] ?? [])])],
    toModelConfig(params, model) {
      // Kimi 编程端点：协议选了 Anthropic 且没手填地址时，自动落到 coding 端点
      const fallback =
        id === 'kimi' && String(params.apiProtocol ?? '') === 'anthropic'
          ? KIMI_CODING_BASE_URL
          : meta.defaultBaseUrl
      const baseUrl = String(params.baseUrl ?? '').trim() || fallback
      return {
        baseUrl,
        apiKey: String(params.apiKey ?? ''),
        model: model.trim() || meta.defaultModel
      }
    }
  }
})
