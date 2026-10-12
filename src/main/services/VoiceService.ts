import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import {
  getTtsProvider,
  isTtsConnectionReady,
  ttsModelSpec
} from './providers/registry'
import {
  type TtsConnection,
  type VoiceRecord,
  type VoiceUsage
} from '../../shared/types'

/**
 * 音色库 / 声音克隆（M8）。
 *
 * 火山引擎「声音复刻」V3：POST /api/v3/tts/voice_clone（X-Api-Key 鉴权）→ 轮询
 * /api/v3/tts/get_voice（status 2 Success / 4 Active 可合成）。用后付费 custom_speaker_id
 * 模式自助注册（预付费音色槽需控制台下单，不在本流程内）。
 * ⚠ 后付费音色「首次合成即转正收费」，详情见官方《声音复刻下单及使用指南》。
 *
 * 阿里云百炼「声音复刻」voice-enrollment：POST {workspaceId}.maas…/audio/tts/customization，
 * target_model 绑定模型（ cosyvoice-v2/v3/v3.5、qwen-audio-3.x；官方不含 cosyvoice-v1 ），
 * 音频必须公网可访问 URL（sampleUrl），创建即完成（无异步训练）。
 *
 * 合规：克隆必须由调用方确认「已获得录音人授权」（docs/02-TTS选型调研 §合规），授权时间入库留痕。
 */

const VOLCANO_V3_CLONE_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone'
const VOLCANO_V3_GET_VOICE_URL = 'https://openspeech.bytedance.com/api/v3/tts/get_voice'
/** 火山 V3 复刻支持的样本格式（audio.format；webm 不在其列，录音产物要先转码） */
const VOLCANO_CLONE_FORMATS = new Set(['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'])

const MAAS_CLONE_PATH = '/services/audio/tts/customization'
const MAAS_BASE = '.cn-beijing.maas.aliyuncs.com/api/v1'

const POLL_INTERVAL_MS = 5000
/** 最多轮询 5 分钟（官方称秒级完成，留足异步余量） */
const POLL_MAX_TRIES = 60
const REQUEST_TIMEOUT_MS = 60000

export interface VoiceCloneInput {
  name: string
  /** 本地样本路径（火山必填；百炼可选——仅作归档留痕，API 用 sampleUrl） */
  samplePath?: string
  /** 公网可访问的样本地址（百炼必填） */
  sampleUrl?: string
  authorized: boolean
  /** 用哪条接入的凭据克隆（决定 provider） */
  connectionId: string
  /** 克隆目标模型（火山 seed-icl-x / 百炼 target_model） */
  model: string
}

export class VoiceService {
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly onChanged: (voices: VoiceRecord[]) => void
  ) {}

  list(): VoiceRecord[] {
    return this.storage.listVoices()
  }

  sampleDir(): string {
    const dir = join(app.getPath('userData'), 'voices')
    void mkdir(dir, { recursive: true }).catch(() => undefined)
    return dir
  }

  /** 录制/上传的样本落盘（渲染进程传来的音频字节流） */
  async saveSample(bytes: Uint8Array, ext = 'webm'): Promise<string> {
    const file = join(this.sampleDir(), `sample-${Date.now()}-${randomUUID().slice(0, 6)}.${ext}`)
    await writeFile(file, Buffer.from(bytes))
    return file
  }

  /** 提交克隆。authorized 必须为 true（合规底线）；克隆到哪条接入 + 哪个模型由调用方指定。 */
  async clone(input: VoiceCloneInput): Promise<{ ok: true; voice: VoiceRecord } | { ok: false; error: string }> {
    const name = input.name.trim()
    if (!name) return { ok: false, error: '请填写音色名称' }
    if (!input.authorized) return { ok: false, error: '请先勾选「已获得录音人授权」' }

    const connection = this.storage.ttsConnectionGet(input.connectionId)
    if (!connection) return { ok: false, error: '接入不存在（可能已被删除）：刷新设置页重选' }
    const provider = connection.providerId
    const def = getTtsProvider(provider)
    const spec = ttsModelSpec(provider, input.model)
    if (!def || !spec) {
      return { ok: false, error: `模型 ${input.model} 不在${def?.label ?? provider}目录里` }
    }
    if (!spec.cloneTarget) {
      return { ok: false, error: `模型 ${spec.label} 不支持声音复刻：换支持复刻的模型` }
    }
    if (!isTtsConnectionReady(connection, def)) {
      return {
        ok: false,
        error: `接入「${connection.name}」还没配齐：到设置 → 语音合成补齐凭据（克隆要用它的凭据）`
      }
    }

    if (provider === 'volcano') {
      return this.cloneVolcano(name, input, connection)
    }
    return this.cloneBailian(name, input, connection)
  }

  // ---------- 火山 V3 声音复刻 ----------

  private async cloneVolcano(
    name: string,
    input: VoiceCloneInput,
    connection: TtsConnection
  ): Promise<{ ok: true; voice: VoiceRecord } | { ok: false; error: string }> {
    if (!input.samplePath || !existsSync(input.samplePath)) {
      return { ok: false, error: '样本文件不存在，请重新上传或录制' }
    }
    const format = extname(input.samplePath).replace('.', '').toLowerCase()
    if (!VOLCANO_CLONE_FORMATS.has(format)) {
      return {
        ok: false,
        error: `样本格式 ${format || '未知'} 火山复刻不支持（支持 wav / mp3 / ogg / m4a / aac / pcm）：请换这些格式的音频`
      }
    }
    const samplePath = await this.archiveSample(input.samplePath)
    if (!samplePath) return { ok: false, error: '样本归档失败：检查文件是否可读写' }

    const now = Date.now()
    const voice: VoiceRecord = {
      id: randomUUID(),
      name,
      provider: 'volcano',
      voiceType: '',
      model: input.model,
      connectionId: connection.id,
      samplePath,
      status: 'training',
      error: '',
      authorized: true,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.storage.saveVoice(voice)
    this.emitChanged()

    const apiKey = String(connection.params.apiKey ?? '')
    try {
      await this.submitVolcanoClone(voice, apiKey)
    } catch (error) {
      this.fail(voice.id, error instanceof Error ? error.message : String(error))
      return { ok: false, error: '克隆任务提交失败，详见音色卡片' }
    }

    this.startPolling(voice.id, apiKey)
    return { ok: true, voice: this.list().find((item) => item.id === voice.id) ?? voice }
  }

  /**
   * 提交 V3 复刻：后付费 custom_speaker_id 模式（自助注册，无需控制台下单）。
   * 自定义音色代号规则：长度 [8,256]、字母开头、仅数字字母 -_、首尾不可 -_。
   */
  private async submitVolcanoClone(voice: VoiceRecord, apiKey: string): Promise<void> {
    const audio = await readFile(voice.samplePath)
    const format = extname(voice.samplePath).replace('.', '').toLowerCase()
    const customSpeakerId = `anchor${randomUUID().replace(/-/g, '')}`
    const res = await fetch(VOLCANO_V3_CLONE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Request-Id': randomUUID()
      },
      body: JSON.stringify({
        speaker_id: 'custom_speaker_id',
        custom_speaker_id: customSpeakerId,
        audio: { data: audio.toString('base64'), format },
        language: 0,
        extra_params: {}
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const data = (await res.json().catch(() => ({}))) as {
      code?: number
      message?: string
      status?: number
    }
    if (!res.ok) {
      throw new Error(volcanoCloneError(data.code, data.message, res.status))
    }
    // 提交即可能 Success（秒级）；没完成的交给轮询
    const state = parseVolcanoCloneState(data.status)
    const next: VoiceRecord = { ...voice, voiceType: customSpeakerId, updatedAt: Date.now() }
    if (state === 'ready') next.status = 'ready'
    if (state === 'failed') {
      this.storage.saveVoice(next)
      throw new Error('平台侧复刻失败：检查样本质量（清晰人声、无伴奏），或到火山控制台查看原因')
    }
    this.storage.saveVoice(next)
    this.emitChanged()
  }

  /** 轮询训练状态，直到 ready / failed / 超时 */
  private startPolling(id: string, apiKey: string): void {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      void this.pollOnce(id, apiKey).then((done) => {
        if (done || tries >= POLL_MAX_TRIES) {
          clearInterval(timer)
          this.timers.delete(id)
          if (!done) this.fail(id, '训练超时未完成，请到火山控制台查看复刻任务状态')
        }
      })
    }, POLL_INTERVAL_MS)
    this.timers.set(id, timer)
  }

  /** 返回 true 表示已到终态（ready/failed） */
  private async pollOnce(id: string, apiKey: string): Promise<boolean> {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice || voice.status !== 'training') return true
    try {
      const res = await fetch(VOLCANO_V3_GET_VOICE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Request-Id': randomUUID()
        },
        body: JSON.stringify({
          speaker_id: 'custom_speaker_id',
          custom_speaker_id: voice.voiceType
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const data = (await res.json().catch(() => ({}))) as { status?: number }
      const state = parseVolcanoCloneState(data.status)
      if (state === 'ready') {
        this.storage.saveVoice({ ...voice, status: 'ready', updatedAt: Date.now() })
        this.emitChanged()
        return true
      }
      if (state === 'failed') {
        this.fail(id, '平台侧训练失败，请检查样本质量或到火山控制台查看原因')
        return true
      }
      return false
    } catch {
      // 单次查询失败不判死，等下一轮
      return false
    }
  }

  // ---------- 百炼 voice-enrollment 复刻 ----------

  /**
   * 百炼复刻是同步接口（创建即完成，音色长期有效），不需要轮询。
   * 音频必须公网可访问 URL——本地文件给中文报错引导（UI 下个代理做，参数已留好）。
   */
  private async cloneBailian(
    name: string,
    input: VoiceCloneInput,
    connection: TtsConnection
  ): Promise<{ ok: true; voice: VoiceRecord } | { ok: false; error: string }> {
    const sampleUrl = input.sampleUrl?.trim() ?? ''
    if (!sampleUrl) {
      return {
        ok: false,
        error: '百炼复刻需要公网可访问的音频地址：把样本传到可访问的 URL 后粘贴'
      }
    }
    const workspaceId = String(connection.params.workspaceId ?? '')
    if (!workspaceId) {
      return {
        ok: false,
        error: '百炼复刻需要「业务空间 ID」：到设置 → 语音合成给这条接入填上'
      }
    }
    // 本地样本可选归档（留痕用，API 只认 URL）
    let samplePath = ''
    if (input.samplePath && existsSync(input.samplePath)) {
      samplePath = (await this.archiveSample(input.samplePath)) ?? ''
    }

    const now = Date.now()
    const voice: VoiceRecord = {
      id: randomUUID(),
      name,
      provider: 'bailian',
      voiceType: '',
      model: input.model,
      connectionId: connection.id,
      samplePath,
      status: 'training',
      error: '',
      authorized: true,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.storage.saveVoice(voice)
    this.emitChanged()

    try {
      const voiceId = await this.submitBailianClone(input.model, sampleUrl, name, connection)
      this.storage.saveVoice({
        ...voice,
        voiceType: voiceId,
        status: 'ready',
        updatedAt: Date.now()
      })
      this.emitChanged()
      return { ok: true, voice: this.list().find((item) => item.id === voice.id) ?? voice }
    } catch (error) {
      this.fail(voice.id, error instanceof Error ? error.message : String(error))
      return { ok: false, error: '复刻失败，详见音色卡片' }
    }
  }

  private async submitBailianClone(
    targetModel: string,
    sampleUrl: string,
    name: string,
    connection: TtsConnection
  ): Promise<string> {
    const workspaceId = String(connection.params.workspaceId ?? '')
    const apiKey = String(connection.params.apiKey ?? '')
    const res = await fetch(`https://${workspaceId}${MAAS_BASE}${MAAS_CLONE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'voice-enrollment',
        input: {
          action: 'create_voice',
          target_model: targetModel,
          prefix: bailianVoicePrefix(name),
          url: sampleUrl
        }
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const data = (await res.json().catch(() => ({}))) as {
      output?: { voice_id?: string }
      code?: string
      message?: string
    }
    if (!res.ok) {
      throw new Error(`百炼复刻接口返回 ${res.status}${data.message ? `：${data.message}` : ''}`)
    }
    const voiceId = data.output?.voice_id
    if (!voiceId) {
      throw new Error(`百炼复刻未返回 voice_id${data.message ? `：${data.message}` : ''}`)
    }
    return voiceId
  }

  // ---------- 通用 ----------

  /** 样本统一复制进音色目录，避免用户原始文件被移动/删除；失败返回空串 */
  private async archiveSample(source: string): Promise<string> {
    const target = join(this.sampleDir(), basename(source))
    try {
      if (source !== target) await copyFile(source, target)
      return target
    } catch {
      return ''
    }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return { ok: false, error: '音色不存在' }
    const timer = this.timers.get(id)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(id)
    }
    this.storage.deleteVoice(id)
    if (voice.samplePath) await rm(voice.samplePath, { force: true }).catch(() => undefined)
    // 删掉的是当前默认音色就清空，避免指向不存在的音色
    if (this.storage.getConfig().tts.voiceId === voice.voiceType) {
      this.storage.setConfig({ tts: { voiceId: '' } })
    }
    this.emitChanged()
    return { ok: true }
  }

  /** 设为默认音色（写 config.tts.voiceId，人设卡留空时即用它） */
  setDefault(id: string): { ok: boolean; error?: string } {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return { ok: false, error: '音色不存在' }
    if (voice.status !== 'ready' || !voice.voiceType) {
      return { ok: false, error: '该音色还没训练完成' }
    }
    this.storage.setConfig({ tts: { voiceId: voice.voiceType } })
    this.emitChanged()
    return { ok: true }
  }

  private fail(id: string, error: string): void {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return
    this.storage.saveVoice({ ...voice, status: 'failed', error, updatedAt: Date.now() })
    this.emitChanged()
  }

  /** 重命名（只改显示名，平台侧的复刻音色标识不动） */
  rename(id: string, name: string): { ok: boolean; error?: string } {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return { ok: false, error: '音色不存在' }
    const next = name.trim()
    if (!next) return { ok: false, error: '音色名称不能为空' }
    this.storage.saveVoice({ ...voice, name: next, updatedAt: Date.now() })
    this.emitChanged()
    return { ok: true }
  }

  /** 谁在用这个音色：人设卡（默认音色 / 角色表）、场次、话术库条目 */
  usage(id: string): VoiceUsage {
    const empty: VoiceUsage = { personas: [], plans: [], utteranceCount: 0, utteranceSamples: [] }
    const voiceType = this.storage.listVoices().find((v) => v.id === id)?.voiceType.trim() ?? ''
    if (!voiceType) return empty

    const personas = this.storage.personaList().flatMap((persona) => {
      const refs: VoiceUsage['personas'] = []
      if (persona.voiceId === voiceType) refs.push({ id: persona.id, name: persona.name, role: '' })
      for (const role of persona.roles) {
        if (role.voiceId === voiceType) refs.push({ id: persona.id, name: persona.name, role: role.name })
      }
      return refs
    })

    const plans: VoiceUsage['plans'] = []
    let utteranceCount = 0
    const utteranceSamples: VoiceUsage['utteranceSamples'] = []
    for (const plan of this.storage.planList()) {
      if (plan.voiceId === voiceType) plans.push({ id: plan.id, name: plan.name })
      for (const utterance of this.storage.utteranceList(plan.id)) {
        if (utterance.voiceId !== voiceType) continue
        utteranceCount += 1
        if (utteranceSamples.length < 3) {
          utteranceSamples.push({ id: utterance.id, planName: plan.name, text: utterance.text })
        }
      }
    }
    return { personas, plans, utteranceCount, utteranceSamples }
  }

  /**
   * 试听：合成路由自己解决「这个音色走哪条接入哪个模型」（voices.model + connection_id），
   * 路由抛出的中文原因直接透传给渲染层。
   */
  async preview(id: string): Promise<{ ok: true; audioPath: string } | { ok: false; error: string }> {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return { ok: false, error: '音色不存在' }
    if (voice.status !== 'ready' || !voice.voiceType) {
      return { ok: false, error: '该音色还没训练完成，暂时没法试听' }
    }
    try {
      const audioPath = await this.tts.synthesize(
        `voice-preview-${voice.id}`,
        `你好，我是${voice.name}，欢迎来到直播间。`,
        voice.voiceType
      )
      return { ok: true, audioPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private emitChanged(): void {
    this.onChanged(this.list())
  }
}

/** 训练状态映射：0 NotFound / 1 Training / 2 Success / 3 Failed / 4 Active（2、4 可合成） */
function parseVolcanoCloneState(status: number | undefined): 'training' | 'ready' | 'failed' {
  if (status === 2 || status === 4) return 'ready'
  if (status === 3) return 'failed'
  return 'training'
}

/** V3 复刻常见错误码的中文说法（其余原样透出 code + message） */
function volcanoCloneError(code: number | undefined, message: string | undefined, httpStatus: number): string {
  if (httpStatus === 401 || httpStatus === 403) {
    return '火山鉴权失败：检查 API Key，或该账号未开通「声音复刻」'
  }
  const known: Record<number, string> = {
    45001104: '声纹校验未通过：换一段更清晰、无伴奏的人声样本',
    45001109: '样本文本校验未通过（WER 过高）：样本里说话要清晰、与语种一致',
    45001122: '样本里没检测到有效人声：换一段有说话声的音频',
    45001123: '复刻次数已达上限：到火山控制台查看额度'
  }
  if (code !== undefined && known[code]) return known[code]
  return `火山复刻失败${code !== undefined ? `（${code}）` : ''}${message ? `：${message}` : ''}`
}

/** 百炼复刻 prefix：小写字母数字、字母开头、≤10 字符（不合规的名字收敛成 anchor+序号感） */
function bailianVoicePrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 10)
  return slug || `anchor${Math.floor(Math.random() * 100)}`
}
