import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { StorageService } from './StorageService'
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
import { validatePodcastRequest } from '../../shared/podcast'
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
 * 预合成产物写入 userData/audio-cache。
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

/** 音频缓存上限（超出按最久未用清理，被话术条目引用的文件不删）；可用 AGENT_ANCHOR_AUDIO_CACHE_MB 覆盖，便于运维与自测 */
const AUDIO_CACHE_MAX_BYTES = Math.max(0, Number(process.env.AGENT_ANCHOR_AUDIO_CACHE_MB ?? 500)) * 1024 * 1024

export class TtsService {
  /** 内容寻址缓存的命中/未命中计数（诊断用） */
  private cacheHits = 0
  private cacheMisses = 0

  constructor(private readonly storage: StorageService) {}

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

  /**
   * 缓存清理：按"最久没用"排，超出上限就删；**被话术条目引用的文件一律不删**
   * （条目可能还没播完/还要重播），另外只清 1 小时前落盘的，避免误删正在合成的。
   */
  async sweepAudioCache(maxBytes = AUDIO_CACHE_MAX_BYTES): Promise<{ removed: number; bytes: number }> {
    /**
     * 路径统一归一化再比较：库里存过的路径可能是正斜杠（或大小写不同），
     * 而这里用 join() 得到的是反斜杠——不归一化就会把"还有条目在引用"的文件当孤儿删掉，
     * 表现就是还没播的音频被清走（"有字无声"那一类事故）。
     */
    const normalize = (value: string): string => resolve(value).toLowerCase()
    const dir = this.audioCacheDir()
    const referenced = new Set(this.storage.speechReferencedAudioPaths().map(normalize))
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const files: { path: string; size: number; mtime: number }[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(dir, entry.name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      files.push({ path, size: info.size, mtime: info.mtimeMs })
    }
    files.sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    let removed = 0
    let bytes = 0
    const now = Date.now()
    for (const file of files) {
      const keep = referenced.has(normalize(file.path)) || now - file.mtime < 3600_000
      if (keep) continue
      if (total <= maxBytes) break
      await rm(file.path, { force: true }).catch(() => undefined)
      total -= file.size
      removed += 1
      bytes += file.size
    }
    if (removed > 0) {
      console.log(`[TTS] 缓存清理：删除 ${removed} 个文件（${(bytes / 1024 / 1024).toFixed(1)}MB），当前 ${(total / 1024 / 1024).toFixed(1)}MB`)
    }
    return { removed, bytes }
  }

  /** 合成音频缓存目录：主进程音频管线从这里取文件解码成本机监听/推流用的 PCM */
  audioCacheDir(): string {
    const dir = join(app.getPath('userData'), 'audio-cache')
    void mkdir(dir, { recursive: true }).catch(() => undefined)
    return dir
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
        `音色 ${voice} 不在模型目录里：到主播团选一个带接入与模型的音色（手动输入的音色要写成 接入id::模型id::音色）`
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
      throw new Error(
        `手动音色里的接入（${ref.connectionId}）不存在：到主播团重新选一个带接入与模型的音色`
      )
    }
    const def = getTtsProvider(connection.providerId)
    const spec = ttsModelSpec(connection.providerId, ref.modelId)
    if (!spec) {
      throw new Error(
        `手动音色里的模型 ${ref.modelId} 不在${def?.label ?? connection.providerId}目录里：到主播团重新选一个带接入与模型的音色`
      )
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
      const invalid = validatePodcastRequest(request, caps)
      if (invalid) throw new Error(invalid)
      return this.synthesizePodcast(itemId, request, connection, spec, signal, programId)
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

    // 内容寻址缓存：轮次稿 + 接入 + 模型 + 音乐/语速/格式一起进键
    const cachePath = join(
      this.audioCacheDir(),
      `tts-${createHash('sha1')
        .update(JSON.stringify({ p: 'podcast', c: connection.id, m: spec.id, f: format, r: speechRate, q: request }))
        .digest('hex')
        .slice(0, 20)}.${extension}`
    )
    const cached = await stat(cachePath).catch(() => null)
    if (cached && cached.size > 0) {
      this.cacheHits += 1
      console.log(`[TTS] 播客缓存命中（省一次整期合成）：${request.turns.length} 轮`)
      return { audioPath: cachePath }
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
    const tempPath = join(this.audioCacheDir(), `${itemId}.${extension}`)
    await mkdir(dirname(tempPath), { recursive: true }).catch(() => undefined)
    await writeFile(tempPath, result.audio)
    try {
      await rename(tempPath, cachePath)
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
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
    return { audioPath: cachePath, durationMs: result.durationMs }
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

  private async synthesizeWithRoute(
    itemId: string,
    text: string,
    route: TtsRoute,
    signal?: AbortSignal,
    programId?: string
  ): Promise<string> {
    const format = String(route.params.format ?? 'mp3')
    const extension = format === 'pcm' ? 'pcm' : format === 'wav' ? 'wav' : format === 'ogg_opus' ? 'ogg' : 'mp3'
    const cachePath = join(this.audioCacheDir(), `${this.cacheKey(text, route)}.${extension}`)
    const cached = await stat(cachePath).catch(() => null)
    if (cached && cached.size > 0) {
      this.cacheHits += 1
      console.log(`[TTS] 缓存命中（省一次合成）：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`)
      return cachePath
    }
    this.cacheMisses += 1
    // 先写临时文件（按条目 id 命名，便于排查），成功后再改名到内容寻址路径
    const tempPath = join(this.audioCacheDir(), `${itemId}.${extension}`)
    if (route.provider === 'bailian') {
      await this.synthesizeBailian(text, tempPath, route, signal)
    } else {
      await this.synthesizeVolcano(text, tempPath, route, signal)
    }
    this.recordSynthesis(route, text.length, programId)
    try {
      await rename(tempPath, cachePath)
      return cachePath
    } catch {
      // 并发合成同一句时目标已存在（Windows 上 rename 会失败）：保留缓存里那份，丢掉临时文件
      await rm(tempPath, { force: true }).catch(() => undefined)
      return cachePath
    }
  }

  /**
   * 设置页「测试发音」：用指定的接入 + 模型合成一小段。
   * voice 空 → 该模型目录第一个音色；目录为空 → 绑这条接入 + 模型的 ready 克隆音色。
   */
  async test(input: TtsTestInput): Promise<TtsTestResult> {
    try {
      const connection = this.storage.ttsConnectionGet(input.connectionId)
      if (!connection) return { ok: false, error: '接入不存在（可能已被删除）：刷新设置页重试' }
      const def = getTtsProvider(connection.providerId)
      const spec = ttsModelSpec(connection.providerId, input.model)
      if (!def || !spec) {
        return { ok: false, error: `模型 ${input.model} 不在${def?.label ?? connection.providerId}目录里` }
      }
      const blocker = ttsModelBlocker(connection, def, input.model)
      if (blocker) {
        return {
          ok: false,
          error: `接「${connection.name}」的模型 ${input.model} 现在用不了：${blocker}：到设置 → 语音合成处理`
        }
      }
      const caps = ttsModelCapabilities(spec)
      if (caps.kind !== 'standard') {
        return {
          ok: false,
          error: `「${spec.label}」是${TTS_MODEL_KIND_LABEL[caps.kind]}模型，不能用单句文本测试：到预制节目里用「生成节目音频」整期合成`
        }
      }
      const voice = input.voice?.trim() || this.testVoice(connection, spec)
      if (!voice) {
        return {
          ok: false,
          error:
            '没有可用音色：该模型没有系统音色目录（需手动输入音色），也没有绑这条接入 + 模型的克隆音色'
        }
      }
      const text = input.text?.trim() || '你好，欢迎光临直播间，这是一条语音合成测试。'
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
    signal?: AbortSignal
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
      body: JSON.stringify({ user: { uid: 'agent-anchor' }, req_params: reqParams }),
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
    const apiKey = String(route.connection.params.apiKey ?? '')
    const sampleRate = asNumber(route.params.sample_rate, 24000)

    const target = this.buildBailianTarget(text, route, { stream: true })
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
      if (completed) this.recordSynthesis(route, text.length, programId)
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
