import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { legacyLlmConfigured, type ModelConnection, type Persona } from '../../shared/types'
import {
  connectionFirstModel,
  getLlmProvider,
  isModelConnectionReady,
  type ResolvedModel
} from './providers/registry'
import type { StorageService } from './StorageService'

/** pi 内置服务商映射；其余（qwen/doubao/local-openai）走 models.json 的自定义 provider */
const BUILTIN_PROVIDERS: Record<string, string> = {
  deepseek: 'deepseek',
  kimi: 'moonshotai-cn',
  zai: 'zai'
}

const MODEL_MISSING_HINT = '还没有可用的语言模型：到主播团里给主播卡选一个接入和模型'

/** 人设卡没给可用模型时的报错（开播与底稿生成共用同一句，用户照着去主播团选） */
function missingBrainHint(personaName: string): string {
  return personaName
    ? `主播卡「${personaName}」还没选模型：到主播团里给它选一个接入和模型`
    : MODEL_MISSING_HINT
}

/** 连通性测试的超时（本地服务拉不起来时不要让 UI 一直转） */
const TEST_TIMEOUT_MS = 10_000

/** pi 内置模型目录（只读、不联网）：给设置页的「可用模型」下拉列真实存在的模型 id */
let catalogRuntime: Promise<ModelRuntime> | null = null

function getCatalogRuntime(): Promise<ModelRuntime> {
  catalogRuntime ??= ModelRuntime.create({
    modelsPath: join(app.getPath('userData'), 'pi-catalog', 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false
  }).catch((error) => {
    catalogRuntime = null
    throw error
  })
  return catalogRuntime
}

/** 该服务商真实可用的模型 id：pi 目录 → manifest 建议 → 空（本地服务只能手打） */
export async function listProviderModels(providerId: string): Promise<string[]> {
  const def = getLlmProvider(providerId)
  const builtin = BUILTIN_PROVIDERS[providerId] ?? providerId
  try {
    const runtime = await getCatalogRuntime()
    const ids = runtime.getModels(builtin).map((model) => model.id)
    if (ids.length > 0) return ids
  } catch (error) {
    console.error('[AgentAnchor] 读取 pi 模型目录失败:', error)
  }
  return def?.modelSuggestions ?? []
}

/**
 * 解析一个人设卡该用哪个模型（开播路径）：这张卡选的接入 + 模型 → 旧的 config.llm 临时兜底。
 * 卡上没选全（或选的接入没配齐、选的模型不在接入列表里）时没有「接入的默认模型」这一档，
 * 只能靠旧配置顶着并带 fallback 说明；旧配置也没有就抛中文错误，
 * 调用方直接把 message 给 UI（预检会把它列成阻断项）。
 */
export function resolveModelForPersona(
  storage: StorageService,
  persona: Persona | null | undefined
): ResolvedModel {
  const bound = boundConnectionOf(storage, persona)
  const selected = selectedModelOf(bound, persona)
  if (selected) return selected

  const legacy = storage.getConfig().llm
  if (legacyLlmConfigured(legacy)) {
    // 接入存在但没配齐（缺密钥/没模型）与「压根没选」在提示里要分开说
    const unusable = bound !== null && !isModelConnectionReady(bound, getLlmProvider(bound.providerId))
    return {
      connectionId: null,
      providerId: legacy.provider,
      params: { apiKey: legacy.apiKey, baseUrl: legacy.baseUrl },
      model: legacy.model,
      fallback: {
        kind: 'legacy',
        personaName: persona?.name ?? '',
        reason: unusable ? 'unusable' : 'missing',
        connectionName: unusable ? (bound?.name ?? '') : undefined
      }
    }
  }
  throw new Error(missingBrainHint(persona?.name ?? ''))
}

/**
 * 必须由人设卡显式指定模型时用（底稿生成这类路径）：没绑卡、没选齐、接入不可用都直接抛。
 * 不走旧 config.llm 的临时兜底——生成出来的底稿不能猜是用哪个大脑写的。
 */
export function requireModelForPersona(
  storage: StorageService,
  persona: Persona | null | undefined
): ResolvedModel {
  const bound = boundConnectionOf(storage, persona)
  if (!bound) {
    if (!persona) throw new Error('场次还没绑主播卡：先给它选一张卡，卡上要有接入和模型')
    throw new Error(missingBrainHint(persona.name))
  }
  if (!isModelConnectionReady(bound, getLlmProvider(bound.providerId))) {
    throw new Error(
      `主播卡「${persona?.name ?? ''}」选的接入「${bound.name}」还没配齐：到设置 → 语言模型补齐密钥和模型列表`
    )
  }
  const selected = selectedModelOf(bound, persona)
  if (!selected) throw new Error(missingBrainHint(persona?.name ?? ''))
  return selected
}

function boundConnectionOf(
  storage: StorageService,
  persona: Persona | null | undefined
): ModelConnection | null {
  return persona?.modelConnectionId ? storage.connectionGet(persona.modelConnectionId) : null
}

/**
 * 卡上接入与模型都选好、接入可用、且选的模型还在接入列表里时的结果；否则 null
 * （交给调用方决定是旧配置兜底还是报错）。没有「接入的默认模型」这一档：
 * 指定的模型不在列表里就等于没选，不做任何替换。
 */
function selectedModelOf(
  bound: ModelConnection | null,
  persona: Persona | null | undefined
): ResolvedModel | null {
  if (!bound) return null
  const requested = (persona?.model ?? '').trim()
  if (!requested) return null
  if (!isModelConnectionReady(bound, getLlmProvider(bound.providerId))) return null
  if (!bound.models.includes(requested)) return null
  return {
    connectionId: bound.id,
    providerId: bound.providerId,
    params: bound.params,
    model: requested
  }
}

/**
 * LLM 会话准备（主播会话用，直播/写稿同一条装配线）：
 * 自定义端点写 models.json → ModelRuntime → 运行时注入凭据（不落 pi 的 auth.json）→ 取模型。
 */
export async function prepareLlmModel(resolved: ResolvedModel, agentDir: string) {
  const def = getLlmProvider(resolved.providerId)
  if (!def) throw new Error(`不认识的服务商：${resolved.providerId}（到设置 → 语言模型里重新选一个）`)

  const { baseUrl, apiKey, model: modelId } = def.toModelConfig(resolved.params, resolved.model)
  if (!modelId) throw new Error(`还没选模型：${def.label}（设置 → 语言模型里给它加一个模型）`)

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
        (known.length > 0 ? `（可用：${known.join(' / ')}）` : '（检查设置页模型列表里的名字）')
    )
  }
  return { model, modelRuntime, modelLabel: `${def.label} · ${modelId}` }
}

/**
 * 接入连通性测试：打 {baseUrl}/chat/completions 发一个 max_tokens=1 的最小请求。
 * 调用方一般逐个模型测（界面就是这么做的）；没指定就用列表第一个。
 * 不走 pi（那里没有「测试」入口），错误翻成中文给 UI。
 */
export async function testModelConnection(
  connection: ModelConnection,
  model?: string
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const def = getLlmProvider(connection.providerId)
  if (!def) return { ok: false, error: `不认识的服务商：${connection.providerId}` }
  // 必填凭据是空的就别发请求了：空密钥打出去只会换回 401，错误会误导成「密钥填错了」，
  // 真实原因往往是凭据根本没存上/读不出来（比如换机后旧系统密文解不开）
  const missing = def.configFields.filter(
    (field) => field.secret && !field.optional && !String(connection.params[field.key] ?? '').trim()
  )
  if (missing.length > 0) {
    return {
      ok: false,
      error: `这条接入的${missing.map((f) => f.label).join('、')}是空的：没填，或保存的凭据读不出来——重填一次再测`
    }
  }
  const target = (model ?? '').trim() || connectionFirstModel(connection, def)
  const cfg = def.toModelConfig(connection.params, target)
  if (!cfg.model) return { ok: false, error: `还没有模型（${def.label}）：先加一个模型再测` }

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const startedAt = Date.now()
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
    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, error: `超时（${TEST_TIMEOUT_MS / 1000} 秒没响应）：检查网络，或本地服务是否在跑` }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `地址不通：${message.slice(0, 200)}` }
  }
}
