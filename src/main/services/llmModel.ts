import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { LLM_PROVIDER_META, type LlmConfig } from '../../shared/types'

/** pi 内置服务商映射；qwen/doubao 走 OpenAI 兼容，写进 models.json */
const BUILTIN_PROVIDERS: Partial<Record<LlmConfig['provider'], string>> = {
  deepseek: 'deepseek',
  kimi: 'moonshotai-cn',
  zai: 'zai'
}

/**
 * LLM 会话准备（AgentService 与 GenerationService 共用）：
 * 自定义端点写 models.json → ModelRuntime → 运行时注入凭据（不落 pi 的 auth.json）→ 取模型。
 */
export async function prepareLlmModel(llm: LlmConfig, agentDir: string) {
  mkdirSync(agentDir, { recursive: true })

  const meta = LLM_PROVIDER_META[llm.provider]
  const providerId = BUILTIN_PROVIDERS[llm.provider] ?? llm.provider
  const modelId = llm.model || meta.defaultModel
  const baseUrl = llm.baseUrl.trim() || meta.defaultBaseUrl

  // qwen/doubao 是 pi 不内置的 OpenAI 兼容端点，写 models.json 自定义 provider；
  // 内置服务商自定义了 baseUrl 时也写 provider 级覆盖。
  const isBuiltin = llm.provider in BUILTIN_PROVIDERS
  const needModelsJson = !isBuiltin || baseUrl !== meta.defaultBaseUrl
  const modelsPath = join(agentDir, 'models.json')
  if (needModelsJson) {
    const providerEntry: Record<string, unknown> = isBuiltin
      ? { baseUrl }
      : { baseUrl, api: 'openai-completions', models: [{ id: modelId }] }
    writeFileSync(modelsPath, JSON.stringify({ providers: { [providerId]: providerEntry } }, null, 2), 'utf8')
  } else {
    // 配置回退到默认时清掉旧的自定义文件，避免残留旧端点
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), 'utf8')
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath
  })
  // 凭据运行时注入，不落 pi 的 auth.json
  await modelRuntime.setRuntimeApiKey(providerId, llm.apiKey)

  const model = modelRuntime.getModel(providerId, modelId)
  if (!model) {
    throw new Error(`模型不可用：${providerId}/${modelId}（检查设置页的模型名）`)
  }
  return { model, modelRuntime, modelLabel: `${meta.label} · ${modelId}` }
}
