import type { LlmProviderDef } from '../registry'

/** OpenAI 官方 API（docs/09 §2 的云端通道补充）：默认走 Responses 协议，GPT-5 系的思考强度只在它上面完整生效 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * 常见型号目录（下拉建议 + 窗口预填）：只列确信存在的通用型号，窗口填官方公开值。
 * pi 没有 openai 的内置目录兜底，所以这里要自给；表里没有的型号手填 id 即可。
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // GPT-5 系官方 400k
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  // GPT-4.1 系官方 1M
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  // GPT-4o 系 128k
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  // o 系推理模型 200k
  'o4-mini': 200_000,
  o3: 200_000
}

export const openAiProvider: LlmProviderDef = {
  id: 'openai',
  label: 'OpenAI',
  icon: 'openai',
  note: '官方 Responses 协议 · GPT-4o / GPT-5 系',
  // 目录里最老的 GPT-4o 也有 128k，兜底按它填；具体型号以 modelContextWindows 预填为准
  capabilities: { tools: true, streaming: true, contextWindow: 128_000 },
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
      placeholder: DEFAULT_BASE_URL
    },
    {
      key: 'apiProtocol',
      label: 'API 协议',
      type: 'select',
      default: 'responses',
      options: [
        { value: 'responses', label: 'Responses（推荐：GPT-5 系与思考强度走它）' },
        { value: 'completions', label: 'Chat Completions（旧模型或兼容网关）' }
      ],
      help: 'Responses 是 OpenAI 新协议：思考强度（reasoning effort）、缓存命中统计都更完整'
    }
  ],
  defaultModel: 'gpt-4o-mini',
  modelSuggestions: Object.keys(MODEL_CONTEXT_WINDOWS),
  modelContextWindows: MODEL_CONTEXT_WINDOWS,
  toModelConfig(params, model) {
    return {
      baseUrl: String(params.baseUrl ?? '').trim() || DEFAULT_BASE_URL,
      apiKey: String(params.apiKey ?? ''),
      model: model.trim() || 'gpt-4o-mini',
      api: String(params.apiProtocol ?? '') === 'completions' ? 'openai-completions' : 'openai-responses'
    }
  }
}
