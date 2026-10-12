import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { legacyLlmConfigured, type ModelProfile, type Persona } from '../../shared/types'
import { getLlmProvider, isModelProfileReady, type ResolvedModel } from './providers/registry'
import type { StorageService } from './StorageService'

/** pi 内置服务商映射；其余（qwen/doubao/local-openai）走 models.json 的自定义 provider */
const BUILTIN_PROVIDERS: Record<string, string> = {
  deepseek: 'deepseek',
  kimi: 'moonshotai-cn',
  zai: 'zai'
}

const MODEL_MISSING_HINT = '没有可用的模型：到设置 → 语言模型添加一个条目'

/** 连通性测试的超时（本地服务拉不起来时不要让 UI 一直转） */
const TEST_TIMEOUT_MS = 10_000

/**
 * 解析一个人设卡该用哪个模型（业务口径：主播卡 → 全局默认条目 → 旧的 config.llm）。
 * 逐档跳过没配齐的条目，全都没有就抛中文错误，调用方直接把 message 给 UI。
 */
export function resolveModelForPersona(
  storage: StorageService,
  persona: Persona | null | undefined
): ResolvedModel {
  const bound = persona?.modelProfileId ? storage.modelProfileGet(persona.modelProfileId) : null
  if (bound && isModelProfileReady(bound, getLlmProvider(bound.providerId))) return toResolved(bound)

  // 默认条目排在库的最前面（StorageService 的排序），这一档同时覆盖「全局默认条目」与默认条目失效时的兜底
  const fromLibrary = storage
    .modelProfileList()
    .find((profile) => isModelProfileReady(profile, getLlmProvider(profile.providerId)))
  if (fromLibrary) return toResolved(fromLibrary)

  const legacy = storage.getConfig().llm
  if (legacyLlmConfigured(legacy)) {
    return {
      providerId: legacy.provider,
      params: { apiKey: legacy.apiKey, baseUrl: legacy.baseUrl },
      model: legacy.model
    }
  }
  throw new Error(MODEL_MISSING_HINT)
}

function toResolved(profile: ModelProfile): ResolvedModel {
  return { providerId: profile.providerId, params: profile.params, model: profile.model }
}

/**
 * LLM 会话准备（AgentService 与 GenerationService 共用）：
 * 自定义端点写 models.json → ModelRuntime → 运行时注入凭据（不落 pi 的 auth.json）→ 取模型。
 */
export async function prepareLlmModel(resolved: ResolvedModel, agentDir: string) {
  const def = getLlmProvider(resolved.providerId)
  if (!def) throw new Error(`不认识的服务商：${resolved.providerId}（到设置 → 语言模型里重新选一个）`)

  const { baseUrl, apiKey, model: modelId } = def.toModelConfig(resolved.params, resolved.model)
  if (!modelId) throw new Error(`还没填模型名：${def.label}（设置 → 语言模型里补一个）`)

  mkdirSync(agentDir, { recursive: true })

  const providerId = BUILTIN_PROVIDERS[resolved.providerId] ?? resolved.providerId
  // params 留空时的地址就是官方默认地址，拿它判断用户有没有自定义端点
  const defaultBaseUrl = def.toModelConfig({}, def.defaultModel).baseUrl
  const isBuiltin = resolved.providerId in BUILTIN_PROVIDERS
  const needModelsJson = !isBuiltin || baseUrl !== defaultBaseUrl
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
  await modelRuntime.setRuntimeApiKey(providerId, apiKey)

  const model = modelRuntime.getModel(providerId, modelId)
  if (!model) {
    // pi 只认它目录里的模型名：带上「它认识哪些」，免得用户对着报错猜
    const known = modelRuntime
      .getModels(providerId)
      .map((item) => item.id)
      .slice(0, 8)
    throw new Error(
      `模型不可用：${def.label} 不认识「${modelId}」` +
        (known.length > 0 ? `（可用：${known.join(' / ')}）` : '（检查设置页的模型名）')
    )
  }
  return { model, modelRuntime, modelLabel: `${def.label} · ${modelId}` }
}

/**
 * 条目连通性测试：直接用条目自己的 toModelConfig 组装结果打 {baseUrl}/chat/completions，
 * 发一个 max_tokens=1 的最小请求。不走 pi（那里没有「测试」入口），错误翻成中文给 UI。
 */
export async function testModelProfile(profile: ModelProfile): Promise<{ ok: boolean; error?: string }> {
  const def = getLlmProvider(profile.providerId)
  if (!def) return { ok: false, error: `不认识的服务商：${profile.providerId}` }
  const cfg = def.toModelConfig(profile.params, profile.model)
  if (!cfg.model) return { ok: false, error: `还没填模型名（${def.label}）` }

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: '鉴权失败：检查 API Key，或该密钥没开通这个模型' }
    }
    if (res.status === 404) {
      return { ok: false, error: `地址或模型名不对（404）：${url}` }
    }
    if (!res.ok) {
      return { ok: false, error: `服务商返回 ${res.status}：${(await res.text()).slice(0, 200)}` }
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, error: `超时（${TEST_TIMEOUT_MS / 1000} 秒没响应）：检查网络，或本地服务是否在跑` }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `地址不通：${message.slice(0, 200)}` }
  }
}
