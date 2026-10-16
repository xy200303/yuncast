import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { StorageService } from './StorageService'
import type { BlobStoreService } from './BlobStoreService'
import {
  findTtsCatalogVoice,
  getTtsProvider,
  isTtsModelUsable,
  ttsModelBlocker,
  ttsModelCapabilities,
  ttsModelParams,
  ttsModelSpec
} from './providers/registry'
import { synthesizeVolcanoPodcast } from './providers/tts/podcastVolcano'
import { friendlyError } from './errorTranslate'
import { validatePodcastRequest } from '../../shared/podcast'
import { compileSpeechMarkup, hasSpeechMarkup, type SpeechCompileTarget } from '../../shared/speechTags'
import {
  TTS_PROVIDER_SHORT,
  TTS_MODEL_KIND_LABEL,
  type TtsConnection,
  type TtsModelSpec,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
  type VoiceRecord
} from '../../shared/types'
import {
  findCloneVoice,
  parseManualVoice,
  type ManualVoiceRef
} from '../../shared/voiceProvider'

/**
 * TTS 双通道合成。
 * - 火山引擎：V3 HTTP Chunked（https://www.volcengine.com/docs/6561/1598757），
 *   X-Api-Key + X-Api-Resource-Id 鉴权，逐行 JSON 累积 base64 音频后整段落盘（不接流式播出）。
 * - 阿里云百炼：qwen3-tts 系走 DashScope 通用端点，Qwen-Audio / CosyVoice 系走 maas 业务空间端点；
 *   SSE 真流式见 synthesizeBailianStream。
 * 预合成产物经 BlobStore（userData/blobs，内容寻址 + tts_cache 别名）缓存，同文同参只存一份。
 *
 * 凭据按接入存在 tts_connections（一条 = 一个服务商账号：凭据 + 启用模型 + 实时开关），
 * 没有默认模型 / 默认音色 / 默认接入——用哪条接入的哪个模型完全由音色自己决定。
 * 合成路由（route）：克隆音色按 voices.connection_id + voices.model 反推接入与模型；
 * 系统音色在 manifest 静态目录里反查归属模型，在启用了该模型的接入里取最早建的一条；
 * 目录查不到的（手动输入的）用 `接入id::模型id::音色` 复合串显式指定接入与模型。
 * 路由挑不出来就抛中文原因指路，不做任何兜底。
 *
 * 特殊能力模型（docs/10 §6.1）不走音色路由：synthesizeRequest 统一入口按模型 capability
 * 分发——text 给既有 HTTP/SSE 适配器；podcast（双人轮次稿）给火山 PodcastAPI WebSocket v3
 * 适配器（providers/tts/podcastVolcano），请求前先按能力上限本地校验（§15.9）。
 */

const VOLCANO_V3_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
/** V3 结束帧 code（中间帧 code=0 带 data） */
const VOLCANO_V3_END_CODE = 20000000
const BAILIAN_TTS_PATH = '/services/aigc/multimodal-generation/generation'
/** 百炼端点按模型系列区分（端点不可混用）：Qwen-TTS 走通用端点，其余走 maas 业务空间端点 */
const BAILIAN_QWEN_TTS_PREFIX = 'qwen3-tts'
const MAAS_TTS_PATH = '/services/audio/tts/SpeechSynthesizer'
const MAAS_BASE = '.cn-beijing.maas.aliyuncs.com/api/v1'
const BAILIAN_DEFAULT_BASE = 'https://dashscope.aliyuncs.com/api/v1'

interface BailianTarget {
  url: string
  body: Record<string, unknown>
}

const REQUEST_TIMEOUT_MS = 30000

/** 解析出来的合成路由：用哪条接入的哪个模型，以及真正送进合成的音色与合并参数 */
export interface TtsRoute {
  provider: TtsProvider
  connection: TtsConnection
  /** 生效模型 id（克隆音色 = voices.model；系统音色 = 目录反查；手动音色 = 复合串里的那一段） */
  modelId: string
  /** manifest 里的模型 spec；未知模型（手动输入场景以外的异常）为 undefined 时 route 已报错，这里必有值 */
  model: TtsModelSpec
  voice: string
  isClone: boolean
  /** 合并后的模型参数（manifest ParamSpec 默认 ← 接入 models[].params 覆盖） */
  params: Record<string, string | number | boolean>
}

export interface TtsTestInput {
  connectionId: string
  model: string
  voice?: string
  text?: string
}

/** 一次合成的演法（agent 的 delivery/rate/pitch 下沉到这）：覆盖接入静态默认，参与缓存键 */
export interface SynthPerformance {
  /** 自然语言演法（情绪/语气/停顿）：模型支持语气指令（model.instruction）才发 */
  instruction?: string
  /** 语速倍率（1.0 基准，0.85~1.3） */
  rate?: number
  /** 音调倍率（1.0 基准，0.9~1.1 保守） */
  pitch?: number
}

export interface TtsTestResult {
  ok: boolean
  error?: string
  audioPath?: string
  latencyMs?: number
  /** 合成完由主进程直接出声：true = 真的播出来了（渲染层不再自己播） */
  playing?: boolean
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export class TtsService {
  /** 内容寻址缓存的命中/未命中计数（诊断用） */
  private cacheHits = 0
  private cacheMisses = 0
  /** 「稿子带标记但被剥成纯文本」提醒：每路由只警告一次 */
  private readonly markupStrippedWarned = new Set<string>()

  constructor(
    private readonly storage: StorageService,
    private readonly blobs: BlobStoreService
  ) {}

  /**
   * 缓存键：把"会影响音频的一切"（服务商 / 接入 / 模型 / 音色 / 参数 / 文本）哈希成一个短串。
   * 同一句话换个话术条目再合成（催单、问候、报名这类高频重复）就能直接复用，不再打接口。
   * 反过来说：只要有一个参数变了（语速、情感、instruction…）就是另一个键，不会串味。
   */
  private cacheKey(text: string, route: TtsRoute): string {
    const payload = JSON.stringify({
      p: route.provider,
      c: route.connection.id,
      m: route.modelId,
      v: route.voice,
      a: route.params,
      t: text
    })
    return `tts-${createHash('sha1').update(payload).digest('hex').slice(0, 20)}`
  }

  cacheStats(): { hits: number; misses: number } {
    return { hits: this.cacheHits, misses: this.cacheMisses }
  }

  /**
   * 合成用量落库（用量看板）：每次真正打接口的合成记一条（缓存命中不记）。
   * cost 恒 null（只统计字符数，不折算金额）。落库失败静默。
   */
  private recordSynthesis(
    route: Pick<TtsRoute, 'connection' | 'modelId' | 'voice'>,
    chars: number,
    programId?: string
  ): void {
    try {
      if (chars <= 0) return
      this.storage.ttsInsert({
        id: `tr-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ts: Date.now(),
        programId: programId || null,
        connectionId: route.connection.id,
        modelId: route.modelId,
        voiceId: route.voice,
        chars,
        cost: null
      })
    } catch (error) {
      console.warn('[TTS] 用量记录落库失败:', error)
    }
  }

  /** 缓存别名命中 → blob 路径；别名还在但 blob 已被 GC 的顺手清掉 */
  private cachedPathFor(cacheKey: string): string | null {
    const hash = this.storage.ttsCacheGet(cacheKey)
    if (!hash) return null
    const path = this.blobs.pathOf(hash)
    if (!path) this.storage.ttsCacheDelete(cacheKey)
    return path
  }

  /** 路径归不归 BlobStore 管（内容寻址缓存）：调用方删「临时」文件前必须先问，桶里的 blob 别处还在引用 */
  isBlobPath(path: string): boolean {
    return this.blobs.isBlobPath(path)
  }

  /** 该音色会走哪家（流式通道据此选实现；接入没配就抛中文原因） */
  providerForVoice(voiceId?: string): TtsProvider {
    return this.route(voiceId).provider
  }

  /** 该音色的完整路由（流式通道据此看模型 streaming 能力位） */
  routeForVoice(voiceId?: string): TtsRoute {
    return this.route(voiceId)
  }

  /**
   * 合成路由：输入 voiceId，输出接入 + 模型 + 音色 + 合并参数。没有兜底——空音色直接报错。
   * 1. 克隆音色命中（voices 表，按 voiceType 或 name）→ 接入 = connection_id 指向的那条，
   *    模型 = voices.model；接入没了 / 没启用该模型 → 中文报错指路。
   * 2. 手动音色（`接入id::模型id::音色`）→ 前缀里的接入与模型，接入必须存在且能启用该模型。
   * 3. 系统音色 → manifest 目录反查，在启用了该模型的接入里按 created_at ASC 取第一条。
   * 4. 目录查不到、也不是手动写法 → 中文报错指路。
   */
  private route(voiceId?: string): TtsRoute {
    const voice = (voiceId ?? '').trim()
    if (!voice) {
      throw new Error('这条话术没有音色：到主播团给人设卡选一个音色')
    }
    const voices = this.storage.listVoices()
    const clone =
      findCloneVoice(voices, voice) ?? voices.find((item) => item.name === voice && item.voiceType)
    if (clone) return this.routeClone(clone)
    return this.routeSystem(voice)
  }

  private routeClone(clone: VoiceRecord): TtsRoute {
    const provider = clone.provider as TtsProvider
    const def = getTtsProvider(provider)
    if (!clone.voiceType.trim()) {
      throw new Error(`音色「${clone.name}」还没训练完成（或克隆失败），等状态变成「可用」再合成`)
    }
    const modelId = clone.model.trim()
    if (!modelId) {
      throw new Error(`音色「${clone.name}」缺少模型绑定（老数据）：到音色库重新克隆一个`)
    }
    const spec = ttsModelSpec(provider, modelId)
    if (!spec) {
      throw new Error(`音色「${clone.name}」绑定的模型 ${modelId} 不在${def?.label ?? provider}目录里`)
    }
    const connection = clone.connectionId ? this.storage.ttsConnectionGet(clone.connectionId) : null
    const owner = TTS_PROVIDER_SHORT[provider]
    if (!connection) {
      throw new Error(
        `音色「${clone.name}」克隆时用的${owner}接入已经没了：到设置 → 语音合成把这条接入加回来（音色绑定不跨接入），或到音色库用现有接入重新克隆一个`
      )
    }
    const blocker = ttsModelBlocker(connection, def, modelId)
    if (blocker) {
      throw new Error(
        `音色「${clone.name}」暂时合不了声：${blocker}（接入「${connection.name}」）：到设置 → 语音合成处理`
      )
    }
    return {
      provider,
      connection,
      modelId,
      model: spec,
      voice: clone.voiceType,
      isClone: true,
      params: ttsModelParams(connection, spec, modelId)
    }
  }

  private routeSystem(voice: string): TtsRoute {
    // 手动音色：`接入id::模型id::音色`，接入与模型都写在前缀里，不猜
    const manual = parseManualVoice(voice)
    if (manual) return this.routeManual(manual)

    const hits = findTtsCatalogVoice(voice)
    if (hits.length === 0) {
      throw new Error(
        `音色「${voice}」合不了声：它不是音色库里的克隆音色，系统音色目录里也查不到（多半是旧数据里手输的裸音色 id）。` +
          `重新选一次音色即可——手动输入的音色要在选择器里走「手动输入音色 ID」，挂在选好的接入与模型下`
      )
    }
    // 同名音色可能属于多个模型（如 longanyang 同属 v3-plus / v3-flash）：按 manifest 顺序逐家试
    for (const providerId of [...new Set(hits.map((hit) => hit.providerId))]) {
      const route = this.tryResolveCatalogHit(voice, hits, providerId)
      if (route) return route
    }
    // 都没落上：报第一条命中为什么用不了（缺凭据 / 没启用模型 / 缺业务空间 ID / 根本没这条接入）
    const first = hits[0]
    const short = TTS_PROVIDER_SHORT[first.providerId]
    const here = hits.filter((hit) => hit.providerId === first.providerId)
    const labels = [...new Set(here.map((hit) => hit.model.label))].join(' / ')
    const modelIds = here.map((hit) => hit.model.id)
    const owner = this.storage
      .ttsConnectionList()
      .filter(
        (connection) =>
          connection.providerId === first.providerId &&
          connection.models.some((model) => modelIds.includes(model.id))
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    let blocker: string
    if (!owner) {
      blocker = `没有启用了这个模型的${short}接入`
    } else {
      const modelId = owner.models.map((model) => model.id).find((id) => modelIds.includes(id)) ?? ''
      const reason = ttsModelBlocker(owner, getTtsProvider(first.providerId), modelId)
      blocker = `接入「${owner.name}」现在用不了${reason ? `：${reason}` : ''}`
    }
    throw new Error(
      `音色 ${voice} 属于${short}模型「${labels}」，但现在没有能用的接入（${blocker}）：到设置 → 语音合成处理`
    )
  }

  /**
   * 目录命中落到具体接入：该服务商的接入里，启用了含此音色的模型、且这个模型现在真能用的，
   * 按 created_at ASC 取第一条。一条都没有返回 null（调用方换下一家 / 报错）。
   * 这里没有「默认接入」这一档：挑不出来就让用户去设置页把接入补齐。
   */
  private tryResolveCatalogHit(
    voice: string,
    hits: { providerId: TtsProvider; model: TtsModelSpec }[],
    providerId: TtsProvider
  ): TtsRoute | null {
    const def = getTtsProvider(providerId)
    const modelIds = hits.filter((hit) => hit.providerId === providerId).map((hit) => hit.model.id)
    const candidates = this.storage
      .ttsConnectionList()
      .filter((connection) => connection.providerId === providerId)
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const connection of candidates) {
      const enabled = connection.models.map((model) => model.id)
      const modelId = modelIds.find((id) => enabled.includes(id)) ?? ''
      if (!modelId) continue
      const spec = ttsModelSpec(providerId, modelId)
      if (!spec) continue
      // 逐模型判定：这条接入缺业务空间 ID 只挡它自己的 maas 系模型，别把 mp3 里能用的 qwen3 一起挡了
      if (!isTtsModelUsable(connection, def, modelId)) continue
      return {
        provider: providerId,
        connection,
        modelId,
        model: spec,
        voice,
        isClone: false,
        params: ttsModelParams(connection, spec, modelId)
      }
    }
    return null
  }

  /**
   * 手动音色：官方没给系统音色目录的模型（qwen-audio-3.x / cosyvoice-v3.5）走这条。
   * 复合串里的接入必须存在，模型必须在目录里，且这条接入启用了它、该模型的前置条件也满足
   * （ttsModelBlocker 会一并挡下缺业务空间 ID 这类情况）。
   */
  private routeManual(ref: ManualVoiceRef): TtsRoute {
    const connection = this.storage.ttsConnectionGet(ref.connectionId)
    if (!connection) {
      throw new Error('这个手动音色挂的语音接入已经删除了：重新选一次音色（选择器里会只列出还在的接入）')
    }
    const def = getTtsProvider(connection.providerId)
    const spec = ttsModelSpec(connection.providerId, ref.modelId)
    if (!spec) {
      throw new Error(`这个手动音色挂的模型 ${ref.modelId} 不在${def?.label ?? connection.providerId}目录里：重新选一次音色`)
    }
    const blocker = ttsModelBlocker(connection, def, ref.modelId)
    if (blocker) {
      throw new Error(
        `手动音色现在用不了：${blocker}（接入「${connection.name}」）：到设置 → 语音合成处理`
      )
    }
    return {
      provider: connection.providerId,
      connection,
      modelId: ref.modelId,
      model: spec,
      voice: ref.voice,
      isClone: false,
      params: ttsModelParams(connection, spec, ref.modelId)
    }
  }

  /** 合成一条话术到缓存文件，返回绝对路径。signal 用于预合成窗口挤出时取消。
   *  perf：这次合成专用的演法（agent 写的 delivery/rate/pitch）——覆盖接入上的静态默认并参与缓存键（不同演法不串缓存）
   *  programId：用量归属的节目（用量看板按节目分摊）；现场 say 由调用方带 activeProgramId */
  async synthesize(
    itemId: string,
    text: string,
    voiceId?: string,
    signal?: AbortSignal,
    perf?: SynthPerformance,
    programId?: string
  ): Promise<string> {
    return this.synthesizeWithRoute(itemId, text, this.withPerformance(this.route(voiceId), perf), signal, programId)
  }

  /**
   * 统一合成入口（docs/10 §6.5）：显式指定接入 + 模型（节目声音快照冻结的就是这两个 id，
   * 不从音色反推路由），按模型 capability 分发到适配器：
   * - text：普通单人合成（既有 HTTP/SSE 通道）；voiceId 是这个接入 + 模型下的音色标识；
   * - podcast：双人轮次稿 → 火山 PodcastAPI（WebSocket v3）。请求前先本地校验（§15.9：
   *   发音人恰好 2 个、每轮/总文本不超上限），超限直接中文报错，不等服务端；
   *   内容审核/配额等失败显式抛出，绝不静默降级到普通 TTS。
   * 产物走内容寻址缓存（同一份轮次稿 + 同样配置不重复打接口），返回缓存绝对路径。
   */
  async synthesizeRequest(
    itemId: string,
    request: TtsSynthesisRequest,
    target: { connectionId: string; modelId: string },
    signal?: AbortSignal,
    programId?: string
  ): Promise<TtsSynthesisResult> {
    const connection = this.storage.ttsConnectionGet(target.connectionId)
    if (!connection) throw new Error('合成接入不存在（可能已被删除）：到节目设置里重选合成模型')
    const def = getTtsProvider(connection.providerId)
    const spec = ttsModelSpec(connection.providerId, target.modelId)
    if (!def || !spec) {
      throw new Error(`模型 ${target.modelId} 不在${def?.label ?? connection.providerId}目录里：到节目设置里重选合成模型`)
    }
    const blocker = ttsModelBlocker(connection, def, target.modelId)
    if (blocker) throw new Error(`合成模型现在用不了：${blocker}（接入「${connection.name}」）`)
    const caps = ttsModelCapabilities(spec)

    if (request.type === 'podcast') {
      if (caps.kind !== 'podcast') {
        throw new Error(`模型「${spec.label}」不是双人播客模型，不接受轮次稿：到节目设置里换 Podcast 模型或普通模型`)
      }
      if (connection.providerId !== 'volcano') {
        throw new Error(`「${spec.label}」的合成通道还没接入（目前只有火山 PodcastAPI 适配器）`)
      }
      // 播客模型不解析任何演法标记：编译成纯文本再合成（cot 留正文、fx 留拟声词）
      const cleanRequest = {
        ...request,
        turns: request.turns.map((turn) => ({ ...turn, text: compileSpeechMarkup(turn.text, 'plain') }))
      }
      const invalid = validatePodcastRequest(cleanRequest, caps)
      if (invalid) throw new Error(invalid)
      return this.synthesizePodcast(itemId, cleanRequest, connection, spec, signal, programId)
    }

    if (caps.input === 'dialogueTurns') {
      throw new Error(
        `「${spec.label}」是${TTS_MODEL_KIND_LABEL[caps.kind]}模型，只接受双人轮次稿：到预制节目里用「生成节目音频」整期合成`
      )
    }
    const voice = request.voiceId.trim()
    if (!voice) throw new Error('合成请求缺音色：voiceId 不能为空')
    const route: TtsRoute = {
      provider: connection.providerId,
      connection,
      modelId: spec.id,
      model: spec,
      voice,
      isClone: this.storage.listVoices().some((item) => item.voiceType === voice),
      params: ttsModelParams(connection, spec, spec.id)
    }
    const audioPath = await this.synthesizeWithRoute(
      itemId,
      request.text,
      this.withPerformance(route, { instruction: request.instruction, rate: request.rate, pitch: request.pitch }),
      signal,
      programId
    )
    return { audioPath }
  }

  /**
   * podcast 分支：轮次稿 → 火山 PodcastAPI。语速换算成火山口径（request.speechRate 是 1.0
   * 基准倍率 → speech_rate 百分点；没传用接入默认），复刻 2.0 音色补 speaker_additions
   * （官方要求 ICL 音色显式带 model 参数；具体取值按文档示例，需联调校准）。
   */
  private async synthesizePodcast(
    itemId: string,
    request: Extract<TtsSynthesisRequest, { type: 'podcast' }>,
    connection: TtsConnection,
    spec: TtsModelSpec,
    signal?: AbortSignal,
    programId?: string
  ): Promise<TtsSynthesisResult> {
    const apiKey = String(connection.params.apiKey ?? '')
    if (!apiKey) throw new Error('火山引擎接入缺 API Key：到设置 → 语音合成填新版控制台的 API Key')
    const params = ttsModelParams(connection, spec, spec.id)
    const format = String(params.format ?? 'mp3')
    const extension = format === 'pcm' ? 'pcm' : format === 'ogg_opus' ? 'ogg' : 'mp3'
    const speechRate =
      request.speechRate !== undefined && Number.isFinite(request.speechRate)
        ? Math.max(-50, Math.min(100, Math.round((request.speechRate - 1) * 100)))
        : asNumber(params.speech_rate, 0)
    const speakerAdditions: Record<string, string> = {}
    for (const speaker of request.speakers) {
      const clone = this.storage
        .listVoices()
        .find((voice) => voice.voiceType === speaker && voice.status === 'ready')
      if (clone?.model === 'seed-icl-2.0') {
        speakerAdditions[speaker] = JSON.stringify({ model: 'seed-tts-2.0-standard' })
      }
    }

    // 内容寻址缓存：轮次稿 + 接入 + 模型 + 音乐/语速/格式一起进键（别名格式沿用 tts-<sha1-20>）
    const cacheKey = `tts-${createHash('sha1')
      .update(JSON.stringify({ p: 'podcast', c: connection.id, m: spec.id, f: format, r: speechRate, q: request }))
      .digest('hex')
      .slice(0, 20)}`
    const cachedPath = this.cachedPathFor(cacheKey)
    if (cachedPath) {
      this.cacheHits += 1
      console.log(`[TTS] 播客缓存命中（省一次整期合成）：${request.turns.length} 轮`)
      return { audioPath: cachedPath }
    }
    this.cacheMisses += 1

    const result = await synthesizeVolcanoPodcast({
      apiKey,
      request,
      payload: {
        format,
        sampleRate: asNumber(params.sample_rate, 24000),
        speechRate,
        speakerAdditions
      },
      signal,
      onLog: (message) => console.log(`[TTS] 播客合成：${message}`)
    })
    const tempPath = this.blobs.tmpPath(`${itemId}.${extension}`)
    await mkdir(dirname(tempPath), { recursive: true }).catch(() => undefined)
    await writeFile(tempPath, result.audio)
    const put = await this.blobs.putFile(tempPath, extension)
    this.storage.ttsCachePut(cacheKey, put.hash)
    console.log(
      `[TTS] 播客整期合成完成：${request.turns.length} 轮，${(result.audio.length / 1024).toFixed(0)}KB` +
        `${result.fromAudioUrl ? '（服务端整期成品）' : '（逐轮拼接）'}`
    )
    // 用量采集：podcast 按总轮次字符记（火山播客模型按字符计费）
    this.recordSynthesis(
      { connection, modelId: spec.id, voice: request.speakers.join('+') },
      request.turns.reduce((sum, turn) => sum + turn.text.length, 0),
      programId
    )
    return { audioPath: put.path, durationMs: result.durationMs }
  }

  /**
   * 演法覆盖到路由参数：instruction 覆盖静态语气指令（模型标了 instruction 才发）；
   * rate/pitch 是 agent 侧的 1.0 基准倍率，按服务商口径换算（百炼倍率直发；火山 speech_rate 百分点 / pitch 半音），
   * 模型参数表里没有对应键的不发。
   */
  private withPerformance(route: TtsRoute, perf?: SynthPerformance): TtsRoute {
    if (!perf) return route
    let params = route.params
    const declares = (key: string) => route.model.params?.some((p) => p.key === key) ?? false
    const trimmed = perf.instruction?.trim()
    if (trimmed && route.model.instruction) params = { ...params, instruction: trimmed }
    if (perf.rate !== undefined && Number.isFinite(perf.rate)) {
      const rate = Math.min(1.3, Math.max(0.85, perf.rate))
      if (declares('rate')) params = { ...params, rate: Math.round(rate * 100) / 100 }
      else if (declares('speech_rate')) params = { ...params, speech_rate: Math.round((rate - 1) * 100) }
    }
    if (perf.pitch !== undefined && Number.isFinite(perf.pitch)) {
      const pitch = Math.min(1.1, Math.max(0.9, perf.pitch))
      if (route.provider === 'bailian' && declares('pitch')) {
        params = { ...params, pitch: Math.round(pitch * 100) / 100 }
      } else if (route.provider === 'volcano' && declares('pitch')) {
        // 倍率 → 半音：12 * log2（0.9≈-2、1.1≈+2）
        params = { ...params, pitch: Math.max(-12, Math.min(12, Math.round(12 * Math.log2(pitch)))) }
      }
    }
    return params === route.params ? route : { ...route, params }
  }

  /** 这条音色路由所属服务商的预合成请求间隔（config 没显式配时的默认值，来自 manifest 的官方限流档） */
  synthIntervalFor(voiceId?: string): number {
    try {
      const route = this.route(voiceId)
      const def = getTtsProvider(route.provider)
      return def?.defaultSynthIntervalMs ?? 500
    } catch {
      return 500
    }
  }

  /**
   * 稿内演法标记按路由编译成目标模型方言（shared/speechTags，单向）：
   * cot/fx/pause 是稿子里的唯一标准写法；火山复刻 expressive 编成 cot 方言、百炼 Qwen-Audio 系
   * 编成方括号标签方言、其余模型全剥留正文。不认识的标记绝不原样发给模型（会照字面念出来）。
   */
  private markupFor(route: TtsRoute, text: string): string {
    const target: SpeechCompileTarget =
      route.provider === 'volcano' &&
      route.modelId === 'seed-icl-2.0' &&
      String(route.params.model ?? '') === 'seed-tts-2.0-expressive'
        ? 'volcano-cot'
        : route.provider === 'bailian' && route.model.inlineTags === true
          ? 'bailian-brackets'
          : 'plain'
    // 稿子带了标记但路由不支持 → 标记会被剥掉，首次发生时提醒去开对应的表达能力（不然用户以为功能坏了）
    if (target === 'plain' && hasSpeechMarkup(text) && !this.markupStrippedWarned.has(this.routeKeyOf(route))) {
      this.markupStrippedWarned.add(this.routeKeyOf(route))
      const hint =
        route.provider === 'volcano' && route.modelId === 'seed-icl-2.0'
          ? '到接入参数里把 seed-icl-2.0 的 model 选成 expressive（标准版服务端会直接过滤 cot）'
          : '当前模型不支持局部演法标记'
      console.warn(`[TTS] 稿子带演法标记但已按纯文本合成：${hint}`)
    }
    return compileSpeechMarkup(text, target)
  }

  private routeKeyOf(route: TtsRoute): string {
    return `${route.provider}:${route.connection.id}:${route.modelId}:${route.voice}`
  }

  /**
   * 合成上下文集（火山 additions.section_id）：同一节目的连续合成请求带同一个 UUID，
   * 服务端保留对话历史，段与段的语气/韵律衔接更自然（仅 seed-tts-2.0 / seed-icl-2.0 生效）。
   * 内存 Map 随 app 重启重新生成——服务端对历史有轮数与超时限制，不该跨天复用。
   * 不进缓存键：内容寻址缓存本来就是为了跨场次复用同一句音频。
   */
  private readonly sectionIds = new Map<string, string>()
  private sectionIdFor(programId: string): string {
    let id = this.sectionIds.get(programId)
    if (!id) {
      id = randomUUID()
      this.sectionIds.set(programId, id)
    }
    return id
  }

  private async synthesizeWithRoute(
    itemId: string,
    text: string,
    route: TtsRoute,
    signal?: AbortSignal,
    programId?: string
  ): Promise<string> {
    const format = String(route.params.format ?? 'mp3')
    const extension = format === 'pcm' ? 'pcm' : format === 'wav' ? 'wav' : format === 'ogg_opus' ? 'ogg' : 'mp3'
    const sendText = this.markupFor(route, text)
    if (!sendText.trim()) {
      throw new Error('剥离演法标记后没有可合成的文字：标签要和实际句子一起写，别只发标签')
    }
    const cacheKey = this.cacheKey(sendText, route)
    const cachedPath = this.cachedPathFor(cacheKey)
    if (cachedPath) {
      this.cacheHits += 1
      console.log(`[TTS] 缓存命中（省一次合成）：${sendText.slice(0, 24)}${sendText.length > 24 ? '…' : ''}`)
      return cachedPath
    }
    this.cacheMisses += 1
    // 先写临时文件（按条目 id 命名，便于排查），成功后入 BlobStore（同内容自动去重）并登记缓存别名
    const tempPath = this.blobs.tmpPath(`${itemId}.${extension}`)
    if (route.provider === 'bailian') {
      await this.synthesizeBailian(sendText, tempPath, route, signal)
    } else {
      await this.synthesizeVolcano(sendText, tempPath, route, signal, programId)
    }
    this.recordSynthesis(route, sendText.length, programId)
    const put = await this.blobs.putFile(tempPath, extension)
    this.storage.ttsCachePut(cacheKey, put.hash)
    return put.path
  }

  /**
   * 设置页「测试发音」：用指定的接入 + 模型合成一小段。
   * voice 空 → 该模型目录第一个音色；目录为空 → 绑这条接入 + 模型的 ready 克隆音色。
   */
  async test(input: TtsTestInput): Promise<TtsTestResult> {
    const connection = this.storage.ttsConnectionGet(input.connectionId)
    if (!connection) return { ok: false, error: '接入不存在（可能已被删除）：刷新设置页重试' }
    return this.runTest(connection, input.model, input.voice, input.text)
  }

  /**
   * 表单直连测试（新建接入还没保存也能测）：调用方把表单当前值拼成临时接入传进来，不查库。
   * 与 test() 共用同一条合成链；临时接入 id 不在 voices 表里，音色回退到模型目录第一个。
   */
  async testConnection(connection: TtsConnection, model: string, text?: string): Promise<TtsTestResult> {
    return this.runTest(connection, model, undefined, text)
  }

  private async runTest(
    connection: TtsConnection,
    model: string,
    voiceOverride?: string,
    textOverride?: string
  ): Promise<TtsTestResult> {
    try {
      const def = getTtsProvider(connection.providerId)
      const spec = ttsModelSpec(connection.providerId, model)
      if (!def || !spec) {
        return { ok: false, error: `模型 ${model} 不在${def?.label ?? connection.providerId}目录里` }
      }
      const blocker = ttsModelBlocker(connection, def, model)
      if (blocker) {
        return {
          ok: false,
          error: `接「${connection.name}」的模型 ${model} 现在用不了：${blocker}：到设置 → 语音合成处理`
        }
      }
      const caps = ttsModelCapabilities(spec)
      if (caps.kind !== 'standard') {
        return {
          ok: false,
          error: `「${spec.label}」是${TTS_MODEL_KIND_LABEL[caps.kind]}模型，不能用单句文本测试：到预制节目里用「生成节目音频」整期合成`
        }
      }
      const voice = voiceOverride?.trim() || this.testVoice(connection, spec)
      if (!voice) {
        return {
          ok: false,
          error:
            '没有可用音色：该模型没有系统音色目录（需手动输入音色），也没有绑这条接入 + 模型的克隆音色'
        }
      }
      const text = textOverride?.trim() || '你好，欢迎光临直播间，这是一条语音合成测试。'
      const route: TtsRoute = {
        provider: connection.providerId,
        connection,
        modelId: spec.id,
        model: spec,
        voice,
        isClone: this.storage.listVoices().some((item) => item.voiceType === voice),
        params: ttsModelParams(connection, spec, spec.id)
      }
      const started = Date.now()
      const audioPath = await this.synthesizeWithRoute(`test-${started}`, text, route)
      // 记下成功时间：开播预检用它提示"凭据可能失效"（docs/07 §8.5）
      this.storage.setConfig({ tts: { lastTestAt: Date.now() } })
      return { ok: true, audioPath, latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  }

  /**
   * 测某条接入 + 模型时用哪个音色：目录第一个系统音色；目录为空（qwen-audio / v3.5 / ICL）
   * 就找绑这条接入 + 模型的 ready 克隆音色。
   */
  private testVoice(connection: TtsConnection, spec: TtsModelSpec): string {
    const catalogFirst = spec.voices[0]?.voices[0]?.id
    if (catalogFirst) return catalogFirst
    const clone = this.storage
      .listVoices()
      .find(
        (voice) =>
          voice.connectionId === connection.id &&
          voice.model === spec.id &&
          voice.status === 'ready' &&
          voice.voiceType.trim()
      )
    return clone?.voiceType ?? ''
  }

  private combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }

  /**
   * 火山 V3 单向流式（HTTP Chunked）：响应是逐行 JSON，code=0 的行带 base64 音频片段，
   * code=20000000 是结束帧。这里整段累积后落盘（预合成场景不需要边收边播）。
   * 文档：https://www.volcengine.com/docs/6561/1598757
   */
  private async synthesizeVolcano(
    text: string,
    outPath: string,
    route: TtsRoute,
    signal?: AbortSignal,
    programId?: string
  ): Promise<void> {
    const apiKey = String(route.connection.params.apiKey ?? '')
    if (!apiKey) {
      throw new Error('火山引擎接入缺 API Key：到设置 → 语音合成填新版控制台的 API Key')
    }
    const p = route.params
    const format = String(p.format ?? 'mp3')
    const emotion = String(p.emotion ?? '').trim()
    const pitch = asNumber(p.pitch, 0)
    // additions：音调后处理 + 语音指令（仅 2.0 / ICL2.0 支持，文档说列表只第一个值有效）
    const instruction = route.model.instruction ? String(p.instruction ?? '').trim() : ''
    const additions: Record<string, unknown> = {}
    if (pitch !== 0) additions.post_process = { pitch }
    if (instruction) additions.context_texts = [instruction]
    // 复刻 expressive：开 cot 标签解析（<cot text=情绪>句子</cot> 局部演法），官方要求显式开
    if (String(p.model ?? '') === 'seed-tts-2.0-expressive') additions.use_tag_parser = true
    // 合成上下文：TTS2.0/ICL2.0 带节目级 section_id，同节目连续合成共享上下文，段间语气衔接更自然
    if (programId && (route.modelId === 'seed-tts-2.0' || route.modelId === 'seed-icl-2.0')) {
      additions.section_id = this.sectionIdFor(programId)
    }
    const reqParams: Record<string, unknown> = {
      text,
      speaker: route.voice,
      // seed-icl-2.0 的复刻版本（standard / expressive），仅该模型的 ParamSpec 有这个键
      ...(typeof p.model === 'string' && p.model.trim() ? { model: p.model } : {}),
      audio_params: {
        format,
        sample_rate: asNumber(p.sample_rate, 24000),
        speech_rate: asNumber(p.speech_rate, 0),
        loudness_rate: asNumber(p.loudness_rate, 0),
        ...(emotion ? { emotion, emotion_scale: asNumber(p.emotion_scale, 4) } : {})
      },
      ...(Object.keys(additions).length > 0 ? { additions: JSON.stringify(additions) } : {})
    }

    const res = await fetch(VOLCANO_V3_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': route.modelId,
        'X-Api-Request-Id': randomUUID()
      },
      body: JSON.stringify({ user: { uid: 'yuncast' }, req_params: reqParams }),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`火山 TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }

    const raw = await res.text()
    const chunks: Buffer[] = []
    let finished = false
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let frame: {
        code?: number
        message?: string
        data?: string
      }
      try {
        frame = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (frame.code === 0 && frame.data) {
        chunks.push(Buffer.from(frame.data, 'base64'))
        continue
      }
      if (frame.code === VOLCANO_V3_END_CODE) {
        finished = true
        break
      }
      if (frame.code !== undefined && frame.code !== 0) {
        throw new Error(`火山 TTS 合成失败: code=${frame.code} ${frame.message ?? ''}`)
      }
    }
    if (chunks.length === 0) {
      throw new Error(finished ? '火山 TTS 未返回音频数据' : '火山 TTS 响应异常（没有音频帧）')
    }

    await mkdir(dirname(outPath), { recursive: true }).catch(() => undefined)
    await writeFile(outPath, Buffer.concat(chunks))
  }

  /**
   * 百炼 Qwen-TTS **真流式**合成（依据 help.aliyun.com/zh/model-studio/qwen-tts-api）。
   * 端点与鉴权同非流式，加 X-DashScope-SSE: enable 头，服务端按 SSE 返回多个 chunk：
   *   中间帧：output.audio.data = base64 音频片段（PCM 16bit 单声道）
   *   末帧：finish_reason = stop，data 为空、url 为完整音频地址（不用它）
   * 文本上限 600 字符。仅对 manifest 标 streaming 的模型开放（TtsStreamService 判定）。
   */
  async *synthesizeBailianStream(
    text: string,
    voiceId?: string,
    signal?: AbortSignal,
    perf?: SynthPerformance,
    programId?: string
  ): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const route = this.withPerformance(this.route(voiceId), perf)
    // 按模型能力透传/剥出演法标记：Qwen-Audio 系吃 [标签]，其余百炼模型全剥
    const sendText = this.markupFor(route, text)
    const apiKey = String(route.connection.params.apiKey ?? '')
    const sampleRate = asNumber(route.params.sample_rate, 24000)

    const target = this.buildBailianTarget(sendText, route, { stream: true })
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-SSE': 'enable'
      },
      body: JSON.stringify(target.body),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`百炼流式 TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }
    if (!res.body) throw new Error('百炼流式 TTS 无响应体')

    const sep = new RegExp(String.fromCharCode(13) + '?\\n{2}')
    const brk = new RegExp(String.fromCharCode(13) + '?\\n')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(sep)
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          for (const line of block.split(brk)) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let frame: {
              status_code?: number
              message?: string
              output?: { audio?: { data?: string }; finish_reason?: string | null }
            }
            try {
              frame = JSON.parse(payload)
            } catch {
              continue
            }
            if (frame.status_code && frame.status_code !== 200) {
              throw new Error(
                `百炼流式 TTS 返回 ${frame.status_code}${frame.message ? `：${frame.message}` : ''}`
              )
            }
            const base64 = frame.output?.audio?.data
            if (base64) {
              yield { pcm: Buffer.from(base64, 'base64'), sampleRate }
            }
          }
        }
      }
      completed = true
    } finally {
      // 用量采集：整段合成正常收尾才记（中断/失败按没合成完处理）；流式通道没有内容寻址缓存，每次都真打接口
      if (completed) this.recordSynthesis(route, sendText.length, programId)
    }
  }

  /**
   * 依据路由的模型系列，构造百炼请求的端点与请求体：
   * qwen3-tts 系 → DashScope 通用端点（language_type，无 format/sample_rate）；
   * 其余系（needsWorkspace）→ maas 业务空间端点（format/sample_rate/volume/rate/pitch）。
   * instruction 是模型参数（在接入弹窗里逐个模型配），只发给 manifest 标 instruction 的模型。
   */
  private buildBailianTarget(
    text: string,
    route: TtsRoute,
    extra: { stream: boolean }
  ): BailianTarget {
    const credentials = route.connection.params
    const base = (String(credentials.baseUrl ?? '') || BAILIAN_DEFAULT_BASE).replace(/\/+$/, '')
    const instruction = route.model.instruction ? String(route.params.instruction ?? '').trim() : ''

    // Qwen-TTS 系列（qwen3-tts-flash）：通用端点 + multimodal-generation 请求体
    if (route.modelId.startsWith(BAILIAN_QWEN_TTS_PREFIX)) {
      return {
        url: `${base}${BAILIAN_TTS_PATH}`,
        body: {
          model: route.modelId,
          input: {
            text,
            voice: route.voice,
            language_type: String(route.params.language_type ?? '') || 'Auto',
            ...(instruction ? { instruction } : {})
          }
        }
      }
    }

    // 其余系列（Qwen-Audio-TTS / CosyVoice）：maas 端点，需要业务空间 ID
    const workspaceId = String(credentials.workspaceId ?? '')
    if (!workspaceId) {
      throw new Error(
        `模型 ${route.modelId} 需要「业务空间 ID」（设置 → 语音合成 → 阿里云百炼接入）：端点形如 https://{业务空间ID}.cn-beijing.maas.aliyuncs.com`
      )
    }
    const maasBase = `https://${workspaceId}${MAAS_BASE}`
    return {
      url: `${maasBase}${MAAS_TTS_PATH}`,
      body: {
        model: route.modelId,
        input: {
          text,
          voice: route.voice,
          format: extra.stream ? 'pcm' : String(route.params.format ?? 'mp3'),
          sample_rate: asNumber(route.params.sample_rate, 24000),
          volume: asNumber(route.params.volume, 50),
          rate: asNumber(route.params.rate, 1),
          pitch: asNumber(route.params.pitch, 1),
          ...(instruction ? { instruction } : {})
        }
      }
    }
  }

  private async synthesizeBailian(
    text: string,
    outPath: string,
    route: TtsRoute,
    signal?: AbortSignal
  ): Promise<void> {
    const apiKey = String(route.connection.params.apiKey ?? '')
    if (!apiKey) {
      throw new Error('阿里云百炼接入缺 API Key：到设置 → 语音合成填 API Key')
    }

    const target = this.buildBailianTarget(text, route, { stream: false })
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(target.body),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`百炼 TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      output?: { audio?: { url?: string } }
      code?: string
      message?: string
    }
    const audioUrl = data.output?.audio?.url
    if (!audioUrl) {
      throw new Error(`百炼 TTS 未返回音频地址${data.message ? `：${data.message}` : ''}`)
    }

    const audioRes = await fetch(audioUrl, { signal: this.combinedSignal(signal) })
    if (!audioRes.ok) throw new Error(`百炼音频下载失败 ${audioRes.status}`)
    await mkdir(dirname(outPath), { recursive: true }).catch(() => undefined)
    await writeFile(outPath, Buffer.from(await audioRes.arrayBuffer()))
  }
}
