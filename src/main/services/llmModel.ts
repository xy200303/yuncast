import type { Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { streamSimple as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { type ModelConnection, type Persona, type ThinkingLevelChoice } from '../../shared/types'
import {
  connectionFirstModel,
  getLlmProvider,
  isModelConnectionReady,
  type LlmApi,
  type ResolvedModel
} from './providers/registry'
import type { StorageService } from './StorageService'

const MODEL_MISSING_HINT = '还没有可用的语言模型：到主播团里给主播卡选一个接入和模型'

/** 人设卡没给可用模型时的报错（开播与底稿生成共用同一句，用户照着去主播团选） */
function missingBrainHint(personaName: string): string {
  return personaName
    ? `主播卡「${personaName}」还没选模型：到主播团里给它选一个接入和模型`
    : MODEL_MISSING_HINT
}

/** 连通性测试的超时（本地服务拉不起来时不要让 UI 一直转） */
const TEST_TIMEOUT_MS = 10_000

/** 上下文窗口兜底值：服务商没声明、接入上也没配模型级窗口时用 */
const FALLBACK_CONTEXT_WINDOW = 128_000

/** 该服务商的模型 id 建议（设置页模型列表的下拉建议；本地服务只能手打） */
export async function listProviderModels(providerId: string): Promise<string[]> {
  return getLlmProvider(providerId)?.modelSuggestions ?? []
}

/**
 * 解析一个人设卡该用哪个模型（开播与底稿生成共用）：
 * 卡上选的接入 + 模型，接入要可用、模型要在接入列表里——没选齐就抛中文错误，
 * 调用方把 message 给 UI（预检会列成阻断项）。没有兜底：用哪个大脑必须明确。
 */
export function resolveModelForPersona(
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
    model: requested,
    // 模型级窗口 + 思考强度（接入上配的）：自动压缩的标尺 / 思考流开关
    ...(bound.modelContextWindows?.[requested]
      ? { contextWindow: bound.modelContextWindows[requested] }
      : {}),
    ...(bound.modelThinkingLevels?.[requested]
      ? { thinkingLevel: bound.modelThinkingLevels[requested] }
      : {}),
    ...(bound.modelParams?.[requested] ? { advanced: bound.modelParams[requested] } : {})
  }
}

export interface PreparedLlm {
  /** 手工构造的模型描述（pi-ai 直接吃，不需要 models.json/目录）；协议由接入配置决定 */
  model: Model<LlmApi>
  /** 凭据：随 stream options 注入，不落盘 */
  apiKey: string
  modelLabel: string
  /** 自动压缩的标尺：接入上配的模型级窗口 > 服务商声明 > 128k 兜底 */
  contextWindow: number
  /** 思考强度（接入的模型级配置）：off = 不思考；responses 协议映射 reasoning effort，completions 协议解析 reasoning_content */
  thinkingLevel: ThinkingLevelChoice
  /** 温度（接入的模型级高级参数）：undefined = 服务商默认 */
  temperature?: number
  /** 多模态（接入的模型级高级参数）：开了图像附件才进会话 */
  vision: boolean
}

/**
 * 按模型的 api 协议分发到对应的 pi-ai 流实现（openai-completions / openai-responses）。
 * options.reasoning（pi-agent-core 从 thinkingLevel 映射来）两个实现都认：
 * completions 解析 reasoning_content，responses 映射成 reasoning.effort。
 */
export function streamLlmModel(
  model: Model<LlmApi>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
) {
  return model.api === 'openai-responses'
    ? streamResponses(model as Model<'openai-responses'>, context, options)
    : streamCompletions(model as Model<'openai-completions'>, context, options)
}

/**
 * LLM 会话准备（主播会话用，直播/写稿同一条装配线）：
 * 接入配置 → 手工构造 Model 对象。协议由 manifest 的 toModelConfig 给出（地址/密钥/模型名/api）。
 */
export async function prepareLlmModel(resolved: ResolvedModel): Promise<PreparedLlm> {
  const def = getLlmProvider(resolved.providerId)
  if (!def) throw new Error(`不认识的服务商：${resolved.providerId}（到设置 → 语言模型里重新选一个）`)

  const { baseUrl, apiKey, model: modelId, api } = def.toModelConfig(resolved.params, resolved.model)
  if (!modelId) throw new Error(`还没选模型：${def.label}（设置 → 语言模型里给它加一个模型）`)

  const contextWindow = resolved.contextWindow ?? def.capabilities.contextWindow ?? FALLBACK_CONTEXT_WINDOW
  const thinkingLevel: ThinkingLevelChoice = resolved.thinkingLevel ?? 'off'
  const advanced = resolved.advanced ?? {}
  const model: Model<LlmApi> = {
    id: modelId,
    name: modelId,
    api,
    provider: resolved.providerId,
    baseUrl,
    // 多模态是模型级配置（接入编辑器模型行「高级」里开）：开了图像附件才进会话
    input: advanced.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // reasoning=true 才会解析/回传思考流（completions 的 reasoning_content / responses 的 reasoning effort）；关了思考就别开
    reasoning: thinkingLevel !== 'off',
    contextWindow,
    maxTokens: advanced.maxTokens ?? 8192
  }
  return {
    model,
    apiKey,
    modelLabel: `${def.label} · ${modelId}`,
    contextWindow,
    thinkingLevel,
    temperature: advanced.temperature,
    vision: advanced.vision === true
  }
}

/**
 * 接入连通性测试：按接入协议打一个最小请求（completions → /chat/completions，responses → /responses）。
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

  const base = cfg.baseUrl.replace(/\/+$/, '')
  // Responses 协议要求 max_output_tokens ≥ 16（GPT-5 系思考模型更低会直接 400）
  const url = cfg.api === 'openai-responses' ? `${base}/responses` : `${base}/chat/completions`
  const body =
    cfg.api === 'openai-responses'
      ? { model: cfg.model, input: 'ping', max_output_tokens: 16 }
      : { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
  const startedAt = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify(body),
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
