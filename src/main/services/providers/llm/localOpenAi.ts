import type { LlmProviderDef } from '../registry'

/** 本地 OpenAI 兼容服务（Ollama / vLLM / LM Studio…，docs/09 §2.2 的本地 LLM 落地点） */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'

export const localOpenAiProvider: LlmProviderDef = {
  id: 'local-openai',
  label: '本地 OpenAI 兼容服务',
  icon: 'local-openai',
  note: 'Ollama / vLLM / LM Studio：模型跑在本机，数据不出网',
  capabilities: { tools: true, streaming: true },
  configFields: [
    {
      key: 'baseUrl',
      label: '服务地址',
      type: 'text',
      default: DEFAULT_BASE_URL,
      placeholder: DEFAULT_BASE_URL,
      help: 'OpenAI 兼容端点，一般以 /v1 结尾（vLLM 常用 http://127.0.0.1:8000/v1）'
    },
    {
      key: 'apiKey',
      label: 'API Key（多数本地服务不需要）',
      type: 'password',
      secret: true,
      optional: true,
      placeholder: '留空即可'
    }
  ],
  // 本地服务的模型名由用户自己拉过什么模型决定，没有通用默认值
  defaultModel: '',
  toModelConfig(params, model) {
    return {
      baseUrl: String(params.baseUrl ?? '').trim() || DEFAULT_BASE_URL,
      apiKey: String(params.apiKey ?? ''),
      model: model.trim(),
      api: 'openai-completions'
    }
  }
}
