/**
 * 音频风格解析（百炼 Qwen-Audio）：听一段人声样本，产出可直接当 TTS 风格指令的自然语言描述。
 *
 * 用途：新建克隆音色时给 instruction 起草；agent 工具 voice_analyze_style 也走这里。
 * 凭据复用「阿里云百炼」语音合成接入的 apiKey（同一个 DashScope 账号），不新增一套配置。
 * DashScope 音频理解只收公网 URL：本地文件先经 TempUploadService 传临时文件站换直链
 *（临时链接公开可访问，工具描述里已向调用方明示这个副作用）。
 */
import type { StorageService } from './StorageService'
import type { TempUploadService } from './TempUpload'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureVoice } from './audio/voiceMetrics'
import { friendlyError } from './errorTranslate'

const MULTIMODAL_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** 默认音频理解模型：Qwen 全模态（Omni）系——同一把百炼密钥、原生多模态接口直接吃音频 URL；
 *  老的 qwen-audio-turbo 在新账号上常无免费额度（403 AllocationQuota），Omni 按量计费更稳 */
const DEFAULT_MODEL = 'qwen3.8-omni-flash'

const DEFAULT_PROMPT =
  '请听这段人声样本，输出一个 JSON 对象（不要代码块、不要解释）：' +
  '{"instruction":"不超过 100 字、可直接下给语音合成模型的表演指令，只写指令正文",' +
  '"transcript":"这段音频说的话逐字转写（用于计算语速；听不清写「（听不清）」）",' +
  '"rate":0.85 到 1.3 之间的建议语速倍率（和真人正常语速比，正常就给 1）,' +
  '"pitch":0.9 到 1.1 之间的建议音调倍率}。' +
  'instruction 的要求：用祈使句/第二人称写（「用……的声音说」「语速……，句尾……」），' +
  '依次覆盖音色（年龄感/亮度/厚薄/气声）、语速、语气与情绪浓度、句尾习惯、说话距离感；' +
  '按真实直播/节目场景还原她的声音（正常发声位置与音量），不要因为有气声就写成耳语；' +
  '不要「这段音频…」「她听起来…」这类评测口吻，不要提节目或人名。'

export interface PersonaDraftResult {
  ok: boolean
  /** 音色级风格指令（≤100 字） */
  instruction: string
  /** 性格（一段话，可含声音描述） */
  personality: string
  /** 口癖/语气词（分号或顿号分隔的短语） */
  catchphrases: string
  /** 背景（一段话） */
  background: string
  model: string
  error?: string
}

export interface StyleAnalysisResult {
  ok: boolean
  /** ≤100 字的表演指令建议（失败为空） */
  style: string
  /** 建议语速倍率（0.85~1.3；TTS 会钳制） */
  rate?: number
  /** 建议音调倍率（0.9~1.1；TTS 会钳制） */
  pitch?: number
  /** 客观测量（本地 ffmpeg + 模型转写字数）：语速等数值，不依赖中文描述 */
  metrics?: {
    /** 总时长（秒） */
    duration: number
    /** 有效发声时长（扣掉停顿，秒） */
    speechSeconds: number
    /** 停顿占比 0~1 */
    silenceRatio: number
    /** 转写出的汉字数（模型给） */
    charCount: number
    /** 语速：汉字/秒（按有效发声时间算） */
    charsPerSec: number
    /** 平均响度 dBFS */
    meanVolumeDb?: number
    /** 基频中位数 Hz */
    f0Median?: number
    /** 基频 10/90 分位 Hz（音高范围） */
    f0P10?: number
    f0P90?: number
    /** 浊音帧占比（越低越气声） */
    voicedRatio?: number
    /** 帧能量标准差（dB，越大起伏越大） */
    energyStd?: number
  }
  /** 实际用的模型 */
  model: string
  /** 本次用的公网地址（本地文件上传后生成的临时链接） */
  sampleUrl?: string
  error?: string
}

/** 转写结果：逐字稿 + 分句表演标注（停顿/情绪/语速），供对照复刻"像不像真人" */
export interface TranscriptResult {
  ok: boolean
  /** 转写正文（已去掉模型的口头解释） */
  text: string
  /** 分句标注：每句的语气、停顿、语速快慢（模型听出来的） */
  cues: { line: string; delivery: string; pauseMs?: number }[]
  /** 整体听感总结：音色/气声/情绪浓度/句尾习惯 */
  overall?: string
  model: string
  sampleUrl?: string
  error?: string
}

/** 指定了接入但那条不存在/没密钥时给准确提示（其余情况返回空串走通用文案） */
function configHint(storage: StorageService): string {
  const config = storage.getConfig().audioStyle
  if (!config.connectionId) return ''
  const connection = storage.ttsConnectionGet(config.connectionId)
  if (!connection) return '设置 → 音频理解里选的接入已被删除：重新选一条百炼接入'
  if (!String(connection.params.apiKey ?? '').trim()) return `接入「${connection.name}」没有 API Key：到 设置 → 语音合成 补上`
  return ''
}

export class AudioStyleService {
  constructor(
    private readonly storage: StorageService,
    private readonly uploads: TempUploadService
  ) {}

  /** 设置 → 音频理解里指定的接入优先；没指定就取最早一条有密钥的百炼接入 */
  private bailianKey(): string {
    const config = this.storage.getConfig().audioStyle
    const connections = this.storage.ttsConnectionListSafe().filter((c) => c.providerId === 'bailian')
    const picked = config.connectionId
      ? connections.filter((c) => c.id === config.connectionId)
      : connections
    for (const connection of picked) {
      const full = this.storage.ttsConnectionGet(connection.id)
      const key = String(full?.params.apiKey ?? '').trim()
      if (key) return key
    }
    return ''
  }

  private readonly PERSONA_PROMPT =
    '请听这段人声样本，先判断她的声音演法，再据此写一份主播人设草稿。只输出一个 JSON 对象，不要代码块、不要解释：' +
    '{"instruction":"≤100字的祈使句表演指令（用……的声音说；语速……；句尾……），不要评测口吻，只写指令正文",' +
    '"personality":"这个声音对应的人物性格，60~120字，写具体的行为倾向与说话习惯，不要形容词堆砌",' +
    '"catchphrases":"3~5个她会常说的口头禅或语气词，用中文分号隔开",' +
    '"background":"她的背景故事，60~120字，与声音气质一致，不要提具体节目或真人"}。' +
    '样本如果是朗读/电台类，人设就往安静、克制、贴耳的方向写；不要评价内容、不要复述原文。'

  /** 音频 → 人设草稿（一次调用同时给出音色指令与人设字段） */
  async analyzePersona(input: {
    samplePath?: string
    sampleUrl?: string
    focus?: string
    model?: string
  }): Promise<PersonaDraftResult> {
    const model = input.model?.trim() || this.storage.getConfig().audioStyle.model || DEFAULT_MODEL
    const fail = (error: string): PersonaDraftResult => ({
      ok: false,
      instruction: '',
      personality: '',
      catchphrases: '',
      background: '',
      model,
      error
    })
    const apiKey = this.bailianKey()
    if (!apiKey) {
      return fail(
        configHint(this.storage) ||
          '没有可用的阿里云百炼接入：到设置 → 语音合成配一条（音频理解复用它的密钥）'
      )
    }
    let sampleUrl = input.sampleUrl?.trim() ?? ''
    if (!sampleUrl) {
      const path = input.samplePath?.trim() ?? ''
      if (!path) return fail('要解析人设得给音频：samplePath（本地文件）或 sampleUrl（公网地址）')
      const uploaded = await this.uploads.upload(path)
      if (!uploaded.ok || !uploaded.url) return fail(`样本上传失败：${uploaded.error ?? '未知原因'}`)
      sampleUrl = uploaded.url
    }
    const prompt = input.focus?.trim() ? `${this.PERSONA_PROMPT}
额外关注：${input.focus.trim()}` : this.PERSONA_PROMPT
    const body = {
      model,
      input: { messages: [{ role: 'user', content: [{ audio: sampleUrl }, { text: prompt }] }] },
      parameters: { temperature: 0.2, top_p: 0.7 }
    }
    let res: Response
    try {
      res = await fetch(MULTIMODAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      })
    } catch (error) {
      return fail(friendlyError(error))
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) return fail(`百炼音频理解请求失败 ${res.status}: ${text.slice(0, 200)}`)
    let raw = ''
    try {
      const data = JSON.parse(text) as {
        output?: { choices?: { message?: { content?: { text?: string }[] | string } }[] }
      }
      const content = data.output?.choices?.[0]?.message?.content
      raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : ''
    } catch {
      return fail(`百炼返回内容无法解析：${text.slice(0, 160)}`)
    }
    // 容错：模型可能包一层 ```json 或前后带解释，截取第一个 { 到最后一个 }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return fail(`解析结果不是 JSON：${raw.slice(0, 160)}`)
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
      const str = (key: string) => (typeof parsed[key] === 'string' ? String(parsed[key]).trim() : '')
      const instruction = str('instruction').slice(0, 100)
      const personality = str('personality')
      const catchphrases = str('catchphrases')
      const background = str('background')
      if (!instruction && !personality) return fail('解析结果缺少内容（音色指令与人设都是空的）')
      return { ok: true, instruction, personality, catchphrases, background, model }
    } catch {
      return fail(`解析结果不是合法 JSON：${raw.slice(0, 160)}`)
    }
  }

  /** 直接测一段本地音频的客观指标（校准工具用） */
  measure = measureVoice

  /**
   * 听音频 → 逐字转写 + 分句表演标注。
   * 和 analyze 的区别：analyze 只产出「下给 TTS 的表演指令」，明确不许复述原文；
   * 这条要的就是原文和"哪儿停顿/哪儿重/什么语气"，用来人工对照复刻像不像。
   */
  async transcribe(input: {
    samplePath?: string
    sampleUrl?: string
    model?: string
  }): Promise<TranscriptResult> {
    const model = input.model?.trim() || this.storage.getConfig().audioStyle.model || DEFAULT_MODEL
    const apiKey = this.bailianKey()
    if (!apiKey) {
      return {
        ok: false,
        text: '',
        cues: [],
        model,
        error: configHint(this.storage) || '没有可用的阿里云百炼接入：到设置 → 语音合成配一条（音频理解复用它的密钥）'
      }
    }
    let sampleUrl = input.sampleUrl?.trim() ?? ''
    if (!sampleUrl) {
      const path = input.samplePath?.trim() ?? ''
      if (!path) return { ok: false, text: '', cues: [], model, error: '要转写得给音频：samplePath（本地文件）或 sampleUrl（公网地址）' }
      const uploaded = await this.uploads.upload(path)
      if (!uploaded.ok || !uploaded.url) {
        return { ok: false, text: '', cues: [], model, error: `样本上传失败：${uploaded.error ?? '未知原因'}` }
      }
      sampleUrl = uploaded.url
    }
    const prompt =
      '请听这段人声，做两件事，只输出一个 JSON 对象（不要代码块、不要解释）：' +
      '1) text：逐字转写这段音频说的话，保留原有标点与语气词，不要改写、不要总结；' +
      '2) cues：按句子拆分，每句给 {"line":"这一句原文","delivery":"这句怎么说：情绪/重音/气声/句尾处理/语速快慢，20 字内","pauseMs":这句之后的停顿毫秒（没停顿就省略）}；' +
      '3) overall：整体听感，40 字内，只描述声音与说话方式（音色/气声比例/情绪浓度/句尾习惯/距离感），不要评价内容。' +
      '严格按听到的写，听不清的地方用「（听不清）」，不要编。'
    let res: Response
    try {
      res = await fetch(MULTIMODAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: { messages: [{ role: 'user', content: [{ audio: sampleUrl }, { text: prompt }] }] },
          parameters: { temperature: 0.1, top_p: 0.7 }
        }),
        signal: AbortSignal.timeout(180_000)
      })
    } catch (error) {
      return { ok: false, text: '', cues: [], model, sampleUrl, error: friendlyError(error) }
    }
    const raw = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, text: '', cues: [], model, sampleUrl, error: `百炼音频理解请求失败 ${res.status}: ${raw.slice(0, 200)}` }
    let content = ''
    try {
      const data = JSON.parse(raw) as { output?: { choices?: { message?: { content?: { text?: string }[] | string } }[] } }
      const c = data.output?.choices?.[0]?.message?.content
      content = typeof c === 'string' ? c : (c ?? []).map((part) => part?.text ?? '').join('')
    } catch {
      return { ok: false, text: '', cues: [], model, sampleUrl, error: `百炼返回内容无法解析：${raw.slice(0, 160)}` }
    }
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start < 0 || end <= start) return { ok: false, text: '', cues: [], model, sampleUrl, error: `解析结果不是 JSON：${content.slice(0, 160)}` }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return { ok: false, text: '', cues: [], model, sampleUrl, error: `解析结果不是合法 JSON：${content.slice(0, 160)}` }
    }
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    const overall = typeof parsed.overall === 'string' ? parsed.overall.trim() : undefined
    const cues = Array.isArray(parsed.cues)
      ? (parsed.cues as Record<string, unknown>[])
          .map((cue) => ({
            line: typeof cue.line === 'string' ? cue.line.trim() : '',
            delivery: typeof cue.delivery === 'string' ? cue.delivery.trim() : '',
            ...(typeof cue.pauseMs === 'number' && Number.isFinite(cue.pauseMs) ? { pauseMs: Math.round(cue.pauseMs) } : {})
          }))
          .filter((cue) => cue.line)
      : []
    if (!text) return { ok: false, text: '', cues, model, sampleUrl, error: '模型没给转写正文' }
    return { ok: true, text, cues, overall, model, sampleUrl }
  }

  async analyze(input: {
    samplePath?: string
    sampleUrl?: string
    focus?: string
    /** 真实使用场景（例：深夜治愈电台朗读，正常音量，像日常说话）——影响模型对人声的判断 */
    scene?: string
    model?: string
  }): Promise<StyleAnalysisResult> {
    const model = input.model?.trim() || this.storage.getConfig().audioStyle.model || DEFAULT_MODEL
    const apiKey = this.bailianKey()
    if (!apiKey) {
      return {
        ok: false,
        style: '',
        model,
        error:
          configHint(this.storage) ||
          '没有可用的阿里云百炼接入：到设置 → 语音合成配一条（音频理解复用它的密钥）'
      }
    }
    let sampleUrl = input.sampleUrl?.trim() ?? ''
    if (!sampleUrl) {
      const path = input.samplePath?.trim() ?? ''
      if (!path) {
        return { ok: false, style: '', model, error: '要解析风格得给音频：samplePath（本地文件）或 sampleUrl（公网地址）' }
      }
      const uploaded = await this.uploads.upload(path)
      if (!uploaded.ok || !uploaded.url) {
        return { ok: false, style: '', model, error: `样本上传失败：${uploaded.error ?? '未知原因'}` }
      }
      sampleUrl = uploaded.url
    }

    const prompt = input.focus?.trim()
      ? `${DEFAULT_PROMPT}\n额外关注：${input.focus.trim()}`
      : DEFAULT_PROMPT
    const body = {
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ audio: sampleUrl }, { text: prompt }]
          }
        ]
      },
      // 风格指令要稳定可复用：低温度、少量采样
      parameters: { temperature: 0.2, top_p: 0.7 }
    }

    let res: Response
    try {
      res = await fetch(MULTIMODAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      })
    } catch (error) {
      return { ok: false, style: '', model, sampleUrl, error: friendlyError(error) }
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return {
        ok: false,
        style: '',
        model,
        sampleUrl,
        error: `百炼音频理解请求失败 ${res.status}: ${text.slice(0, 200)}`
      }
    }
    let style = ''
    try {
      const data = JSON.parse(text) as {
        output?: { choices?: { message?: { content?: { text?: string }[] | string } }[] }
      }
      const content = data.output?.choices?.[0]?.message?.content
      if (typeof content === 'string') style = content
      else if (Array.isArray(content)) style = content.map((part) => part?.text ?? '').join('')
    } catch {
      return { ok: false, style: '', model, sampleUrl, error: `百炼返回内容无法解析：${text.slice(0, 160)}` }
    }
    let rate: number | undefined
    let pitch: number | undefined
    let transcript = ''
    const rawText = style.trim()
    if (rawText) {
      const start = rawText.indexOf('{')
      const end = rawText.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(rawText.slice(start, end + 1)) as Record<string, unknown>
          if (typeof parsed.instruction === 'string') style = parsed.instruction
          if (typeof parsed.rate === 'number' && Number.isFinite(parsed.rate)) {
            rate = Math.min(1.3, Math.max(0.85, parsed.rate))
          }
          if (typeof parsed.pitch === 'number' && Number.isFinite(parsed.pitch)) {
            pitch = Math.min(1.1, Math.max(0.9, parsed.pitch))
          }
          if (typeof parsed.transcript === 'string') transcript = parsed.transcript
        } catch {
          // 不是 JSON：当作纯文本指令
        }
      }
    }
    style = style.trim().replace(/\s+/g, ' ')
    if (!style) return { ok: false, style: '', model, sampleUrl, error: '音频理解没有返回文字（样本可能是纯音乐/静音）' }
    style = style
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/^你(?=用|以|把|说)/, '')
      .replace(/^(这段|该)(音频|录音|样本)[^，。；]*[，。；]\s*/, '')
      .trim()
    if (style.length > 100) style = style.slice(0, 100)

    // 客观测量：本地 ffmpeg 量时长/停顿/响度；字数用模型转写，语速 = 汉字数 ÷ 有效发声时间
    // 模型偶尔不返回 transcript：单独再要一次（只数汉字算语速，不展示内容）
    if (!transcript.trim()) {
      try {
        const res = await fetch(MULTIMODAL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            input: {
              messages: [
                {
                  role: 'user',
                  content: [{ audio: sampleUrl }, { text: '只输出一个 JSON 对象：{"transcript":"这段音频的逐字转写"}，不要解释、不要代码块' }]
                }
              ]
            },
            parameters: { temperature: 0 }
          }),
          signal: AbortSignal.timeout(90_000)
        })
        const text2 = await res.text().catch(() => '')
        if (res.ok) {
          const idx = text2.indexOf('{')
          const end2 = text2.lastIndexOf('}')
          if (idx >= 0 && end2 > idx) {
            const parsed = JSON.parse(text2.slice(idx, end2 + 1)) as Record<string, unknown>
            if (typeof parsed.transcript === 'string') transcript = parsed.transcript
          }
        }
      } catch {
        // 转写拿不到就算了：语速这一项留空
      }
    }

    let metrics: StyleAnalysisResult['metrics']
    let tempFile = ''
    try {
      let localPath = input.samplePath?.trim() ?? ''
      if (!localPath) {
        const res = await fetch(sampleUrl)
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer())
          tempFile = join(tmpdir(), `yuncast-style-${Date.now()}.wav`)
          await writeFile(tempFile, buffer)
          localPath = tempFile
        }
      }
      if (localPath) {
        const measured = await measureVoice(localPath)
        {
          const charCount = (transcript.match(/[一-鿿]/g) ?? []).length
          const speechSeconds = Math.max(0.5, measured.speechSeconds)
          const charsPerSec = charCount > 0 ? charCount / speechSeconds : 0
          metrics = {
            duration: measured.duration,
            speechSeconds,
            silenceRatio: measured.silenceRatio,
            charCount,
            charsPerSec: Number(charsPerSec.toFixed(2)),
            meanVolumeDb: measured.meanVolumeDb,
            f0Median: measured.f0Median,
            f0P10: measured.f0P10,
            f0P90: measured.f0P90,
            voicedRatio: measured.voicedRatio,
            energyStd: measured.energyStd
          }
          // 语速倍率以中文 TTS 默认约 4.5 字/秒为基准，按实测折算（无转写时保留模型估计）
          if (charsPerSec > 0) {
            const factor = charsPerSec / 4.5
            // 与默认语速差不到 5% 就别动（避免来回抖动）
            rate = Math.abs(factor - 1) < 0.05 ? undefined : Math.min(1.3, Math.max(0.85, Number(factor.toFixed(2))))
          }
        }
      }
    } catch {
      // 测量失败不影响文字指令
    } finally {
      if (tempFile) await unlink(tempFile).catch(() => undefined)
    }
    return { ok: true, style, rate, pitch, model, sampleUrl, metrics }
  }
}
