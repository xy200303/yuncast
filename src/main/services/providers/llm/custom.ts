import type { LlmProviderDef } from '../registry'

/**
 * 自定义接口（id 沿用 local-openai，旧库接入不用迁移）：地址、协议、模型全自己填。
 * 覆盖本地服务（Ollama / vLLM / LM Studio）和任何兼容网关（One API / OpenRouter 转发等）。
 */
export const customProvider: LlmProviderDef = {
  id: 'local-openai',
  label: '自定义接口',
  icon: 'local-openai',
  note: '地址和协议全部自己填：本地服务（Ollama / vLLM）或任何兼容网关',
  capabilities: { tools: true, streaming: true },
  defaultApi: 'completions',
  configFields: [
    {
      key: 'baseUrl',
      label: 'API 地址',
      type: 'text',
      placeholder: 'http://127.0.0.1:11434/v1',
      help: '按所选协议填到对应层级：OpenAI 兼容一般以 /v1 结尾；Anthropic 填域名根路径即可',
      required: true
    },
    {
      key: 'apiKey',
      label: 'API Key（本地服务多数不需要）',
      type: 'password',
      secret: true,
      optional: true,
      placeholder: '留空即可'
    }
  ],
  // 自定义接口的模型名由用户自己有什么模型决定，没有通用默认值
  defaultModel: '',
  modelSuggestions: [],
  toModelConfig(params, model) {
    return {
      baseUrl: String(params.baseUrl ?? '').trim(),
      apiKey: String(params.apiKey ?? ''),
      model: model.trim()
    }
  }
}
