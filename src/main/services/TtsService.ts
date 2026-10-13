import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { StorageService } from './StorageService'
import { decodeToPcm } from './stream/ffmpeg/mixer'
import {
  cutsFromSentenceBounds,
  cutsFromSilence,
  pcmToWav,
  slicePcm,
  type SentenceBound
} from './paragraphSplit'
import { ensureSentenceEnd, splitSentences } from '../../shared/paragraph'
import {
  findTtsCatalogVoice,
  getTtsProvider,
  isTtsModelUsable,
  ttsModelBlocker,
  ttsModelParams,
  ttsModelSpec
} from './providers/registry'
import {
  TTS_PROVIDER_SHORT,
  type TtsConnection,
  type TtsModelSpec,
  type TtsProvider,
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
   *  instruction：这次合成专用的表演指示（agent 写的 delivery）；模型支持语气指令才生效，
   *  会覆盖接入上配的静态 instruction 并参与缓存键（不同演法不串缓存） */
  async synthesize(
    itemId: string,
    text: string,
    voiceId?: string,
    signal?: AbortSignal,
    instruction?: string
  ): Promise<string> {
    return this.synthesizeWithRoute(itemId, text, this.withInstruction(this.route(voiceId), instruction), signal)
  }

  /** delivery 覆盖路由的静态 instruction（模型标了 instruction 才生效；参与缓存键不串味） */
  private withInstruction(route: TtsRoute, instruction?: string): TtsRoute {
    const trimmed = instruction?.trim()
    if (!trimmed || !route.model.instruction) return route
    return { ...route, params: { ...route.params, instruction: trimmed } }
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
   * 段落合成（底稿连贯性）：同一场景的连续条目拼成一段整送模型——
   * 模型看到完整上下文，句间停顿和语气是连贯的；拿到整段音频后再按句切回
   * 每条一片 wav，播放/跳过/插播仍是条目粒度（见 shared/paragraph.ts）。
   *
   * 句界定位：火山开字幕/时间戳（精确），百炼用静音检测（对不上句数就抛错）。
   * 任何一步对不上都抛错，由调用方整段回退逐条合成——绝不硬切错。
   *
   * 缓存：段落本体按"拼接全文+路由"内容寻址；切片文件全在就直接复用。
   */
  async synthesizeParagraph(
    items: { itemId: string; text: string }[],
    voiceId?: string,
    signal?: AbortSignal
  ): Promise<{ paths: string[]; paraId: string }> {
    if (items.length < 2) throw new Error('段落合成至少需要两条')
    const route = this.route(voiceId)
    const texts = items.map((item) => ensureSentenceEnd(item.text))
    const joined = texts.join('')
    const perItemSentences = texts.map((text) => splitSentences(text).length)

    const format = String(route.params.format ?? 'mp3')
    const extension =
      format === 'pcm' ? 'pcm' : format === 'wav' ? 'wav' : format === 'ogg_opus' ? 'ogg' : 'mp3'
    const paraKey = this.cacheKey(joined, route)
    const paraId = `para-${paraKey.slice(4)}`
    const dir = this.audioCacheDir()
    const paraPath = join(dir, `${paraKey}.${extension}`)
    const boundsPath = join(dir, `${paraKey}.bounds.json`)
    const slicePaths = items.map((_, i) => join(dir, `${paraKey}-s${i}.wav`))

    // 切片全在 → 整段复用（段落重合成只在文本/音色/参数变了之后才发生）
    const sliceStats = await Promise.all(slicePaths.map((path) => stat(path).catch(() => null)))
    if (sliceStats.every((info) => info && info.size > 44)) {
      this.cacheHits += 1
      console.log(`[TTS] 段落缓存命中（${items.length} 条切片复用，省一次整段合成）`)
      return { paths: slicePaths, paraId }
    }
    this.cacheMisses += 1

    // 段落本体：不在就合成（火山顺手收句级字幕；命中缓存时句界从 sidecar 读）
    let bounds: SentenceBound[] | null = null
    const cachedPara = await stat(paraPath).catch(() => null)
    if (cachedPara && cachedPara.size > 0) {
      if (route.provider === 'volcano') {
        bounds = await readFile(boundsPath, 'utf8')
          .then((raw) => JSON.parse(raw) as SentenceBound[])
          .catch(() => null)
        if (!Array.isArray(bounds)) {
          throw new Error('段落的句界信息丢了（缓存被清过），放弃整段合成')
        }
      }
    } else {
      const tempPath = join(dir, `${items[0].itemId}-para.${extension}`)
      if (route.provider === 'bailian') {
        await this.synthesizeBailian(joined, tempPath, route, signal)
      } else {
        bounds = await this.synthesizeVolcano(joined, tempPath, route, signal, true)
      }
      try {
        await rename(tempPath, paraPath)
      } catch {
        await rm(tempPath, { force: true }).catch(() => undefined)
      }
      if (bounds) await writeFile(boundsPath, JSON.stringify(bounds)).catch(() => undefined)
    }

    // 解码整段 → 按句界切 → 每条一片 wav
    const pcm = await decodeToPcm(paraPath, { channels: 1, sampleRate: 48000 })
    const cuts =
      route.provider === 'volcano'
        ? cutsFromSentenceBounds(bounds ?? [], perItemSentences)
        : cutsFromSilence(pcm, perItemSentences)
    const slices = slicePcm(pcm, cuts, items.length)
    for (let i = 0; i < slices.length; i++) {
      await writeFile(slicePaths[i], pcmToWav(slices[i]))
    }
    console.log(
      `[TTS] 段落合成完成：${items.length} 条切自一段 ${(pcm.length / 2 / 48000).toFixed(1)}s（语气连贯）`
    )
    return { paths: slicePaths, paraId }
  }

  private async synthesizeWithRoute(
    itemId: string,
    text: string,
    route: TtsRoute,
    signal?: AbortSignal
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
   * timed=true 时开句级时间戳（2.0/ICL2.0 用 enable_subtitle，1.0 用 enable_timestamp），
   * 顺带收每句的起止秒数返回（段落合成切句用）；非 timed 返回 null。
   * 文档：C:\tmp\md_1598757.md（https://www.volcengine.com/docs/6561/1598757）
   */
  private async synthesizeVolcano(
    text: string,
    outPath: string,
    route: TtsRoute,
    signal?: AbortSignal,
    timed = false
  ): Promise<SentenceBound[] | null> {
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
        ...(emotion ? { emotion, emotion_scale: asNumber(p.emotion_scale, 4) } : {}),
        // 段落切句要句级时间戳：2.0/ICL2.0 用 enable_subtitle，1.0 用 enable_timestamp
        ...(timed ? (route.modelId.endsWith('2.0') ? { enable_subtitle: true } : { enable_timestamp: true }) : {})
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
    const bounds: SentenceBound[] = []
    let finished = false
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let frame: {
        code?: number
        message?: string
        data?: string
        sentence?: { words?: { startTime?: number; endTime?: number }[] }
      }
      try {
        frame = JSON.parse(trimmed)
      } catch {
        continue
      }
      // 句级字幕帧（timed 模式）：记下这句的起止秒数
      const words = frame.sentence?.words
      if (timed && words && words.length > 0) {
        const start = words[0].startTime
        const end = words[words.length - 1].endTime
        if (typeof start === 'number' && typeof end === 'number') bounds.push({ start, end })
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
    return timed ? bounds : null
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
    instruction?: string
  ): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const route = this.withInstruction(this.route(voiceId), instruction)
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
