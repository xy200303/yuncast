import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import { getTtsProvider, isTtsConnectionReady } from './providers/registry'
import { TTS_PROVIDER_SHORT, type TtsProvider, type VoiceRecord, type VoiceUsage } from '../../shared/types'
import { voiceConnectionError } from '../../shared/voiceProvider'

/**
 * 音色库 / 声音克隆（M8）。
 *
 * 火山引擎「声音复刻」：上传样本 → 异步训练 → 轮询状态 → 得到 speaker_id（voice_type，S_ 前缀）。
 * ⚠ 下面的端点、字段与状态码按火山历史文档（mega_tts 一系）实现，**尚未对照当前官方文档逐字核对**（
 *   见 docs/06-TTS克隆接口核对.md 的核对清单）。核对时只需要改本文件顶部的常量与 parseVolcanoResponse。
 *
 * 合规：克隆必须由调用方确认「已获得录音人授权」（docs/02-TTS选型调研 §合规），授权时间入库留痕。
 */

const VOLCANO_UPLOAD_URL = 'https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload'
const VOLCANO_STATUS_URL = 'https://openspeech.bytedance.com/api/v1/mega_tts/status'
/** 复刻集群名（与合成用的 volcano_tts 不同） */
const VOLCANO_CLONE_CLUSTER = 'volc_mega_tts'
/** 新版接口要求带 Resource-Id；缺失时服务端会拒绝，保留常量便于核对时调整 */
const VOLCANO_RESOURCE_ID = 'volc.megatts.voiceclone'

const POLL_INTERVAL_MS = 5000
/** 最多轮询 5 分钟（官方称秒级完成，留足异步余量） */
const POLL_MAX_TRIES = 60
const REQUEST_TIMEOUT_MS = 30000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

  /** 提交克隆。authorized 必须为 true（合规底线）；provider = 这次复刻交给哪家（新建弹窗里选的）。 */
  async clone(input: {
    name: string
    samplePath: string
    authorized: boolean
    provider: TtsProvider
  }): Promise<{ ok: true; voice: VoiceRecord } | { ok: false; error: string }> {
    const name = input.name.trim()
    if (!name) return { ok: false, error: '请填写音色名称' }
    if (!input.authorized) return { ok: false, error: '请先勾选「已获得录音人授权」' }

    const provider = input.provider
    // 能力位驱动：只有火山实现了复刻（百炼 CosyVoice 复刻待核对是否支持本地音频直传，见 docs/06）
    // 放在样本校验之前：不能克隆的理由先于「样本没传」给出来
    if (!getTtsProvider(provider)?.capabilities.clone) {
      return { ok: false, error: `${TTS_PROVIDER_SHORT[provider]}音色复刻还没实现（接口核对中）：先选火山引擎` }
    }
    if (!input.samplePath || !existsSync(input.samplePath)) {
      return { ok: false, error: '样本文件不存在，请重新上传或录制' }
    }
    // 复刻走**所选那家**的接入（用的是那家的 appId / accessToken，与谁在当默认服务商无关）
    const connection = this.storage.ttsConnectionGetByProvider(provider)
    if (!connection || !isTtsConnectionReady(connection, getTtsProvider(provider))) {
      return {
        ok: false,
        error: `还没配置${TTS_PROVIDER_SHORT[provider]}接入：到设置 → 语音合成加上（克隆要用那家的凭据）`
      }
    }
    const appId = String(connection.params.appId ?? '')
    const accessToken = String(connection.params.accessToken ?? '')

    // 样本统一复制进音色目录，避免用户原始文件被移动/删除
    const samplePath = join(this.sampleDir(), basename(input.samplePath))
    try {
      if (input.samplePath !== samplePath) await copyFile(input.samplePath, samplePath)
    } catch (error) {
      return { ok: false, error: `样本归档失败：${error instanceof Error ? error.message : String(error)}` }
    }

    const now = Date.now()
    const voice: VoiceRecord = {
      id: randomUUID(),
      name,
      provider,
      voiceType: '',
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
      await this.submitVolcanoClone(voice, appId, accessToken)
    } catch (error) {
      this.fail(voice.id, error instanceof Error ? error.message : String(error))
      return { ok: false, error: '克隆任务提交失败，详见音色卡片' }
    }

    this.startPolling(voice.id, appId, accessToken)
    return { ok: true, voice }
  }

  /** 轮询训练状态，直到 ready / failed / 超时 */
  private startPolling(id: string, appId: string, accessToken: string): void {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      void this.pollOnce(id, appId, accessToken).then((done) => {
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
  private async pollOnce(id: string, appId: string, accessToken: string): Promise<boolean> {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice || voice.status !== 'training') return true
    try {
      const res = await this.requestVolcano(VOLCANO_STATUS_URL, accessToken, {
        app: { appid: appId, token: accessToken, cluster: VOLCANO_CLONE_CLUSTER },
        speaker_id: voice.voiceType || id
      })
      const state = parseVolcanoState(res)
      if (state === 'ready') {
        this.storage.saveVoice({ ...voice, status: 'ready', voiceType: res.speaker_id ?? voice.voiceType, updatedAt: Date.now() })
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

  /** 提交复刻训练（具体字段见文件头注释：待与官方文档逐字核对） */
  private async submitVolcanoClone(voice: VoiceRecord, appId: string, accessToken: string): Promise<void> {
    const { readFile } = await import('node:fs/promises')
    const audio = await readFile(voice.samplePath)
    const format = extname(voice.samplePath).replace('.', '') || 'wav'
    const payload = {
      app: { appid: appId, token: accessToken, cluster: VOLCANO_CLONE_CLUSTER },
      speaker_id: voice.id,
      audios: [{ audio_bytes: audio.toString('base64'), audio_format: format }],
      source: 2
    }
    const res = await this.requestVolcano(VOLCANO_UPLOAD_URL, accessToken, payload)
    const state = parseVolcanoState(res)
    if (state === 'failed') {
      throw new Error(res.BaseResp?.StatusMessage ?? res.message ?? '平台拒绝复刻请求')
    }
    // 平台返回的 speaker_id 可能与提交不同，以返回为准
    if (res.speaker_id && res.speaker_id !== voice.id) {
      this.storage.saveVoice({ ...voice, voiceType: res.speaker_id, updatedAt: Date.now() })
    } else {
      this.storage.saveVoice({ ...voice, voiceType: voice.id, updatedAt: Date.now() })
    }
    this.emitChanged()
  }

  private async requestVolcano(
    url: string,
    accessToken: string,
    body: Record<string, unknown>
  ): Promise<VolcanoResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer;${accessToken}`,
        'Resource-Id': VOLCANO_RESOURCE_ID
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error('火山鉴权失败：请检查 Access Token，或该账号未开通「声音复刻」权限')
    }
    if (!res.ok) throw new Error(`火山接口返回 ${res.status}`)
    const data = (await res.json()) as VolcanoResponse
    const code = data.BaseResp?.StatusCode
    // 0 表示成功；其余按业务状态处理（不同版本号段可能不同，核对时确认）
    if (code !== undefined && code !== 0 && code !== 3000) {
      throw new Error(data.BaseResp?.StatusMessage ?? `火山接口错误码 ${code}`)
    }
    return data
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
   * 试听：用该音色**自己那家**的接入合成一句固定文案，返回缓存文件路径（渲染层 media:// 播放）。
   * 那家的接入没配置就没法试听（合成时会撞上同一个路由，这里先给出带音色名的中文原因）。
   */
  async preview(id: string): Promise<{ ok: true; audioPath: string } | { ok: false; error: string }> {
    const voice = this.storage.listVoices().find((v) => v.id === id)
    if (!voice) return { ok: false, error: '音色不存在' }
    if (voice.status !== 'ready' || !voice.voiceType) {
      return { ok: false, error: '该音色还没训练完成，暂时没法试听' }
    }
    const connection = this.storage.ttsConnectionGetByProvider(voice.provider)
    if (!connection || !isTtsConnectionReady(connection, getTtsProvider(voice.provider))) {
      return { ok: false, error: voiceConnectionError(voice) }
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

interface VolcanoResponse {
  speaker_id?: string
  status?: number
  message?: string
  BaseResp?: { StatusCode?: number; StatusMessage?: string }
}

/**
 * 训练状态映射（火山历史文档口径，核对时确认）：
 * 0 不存在 / 1 训练中 / 2 训练成功 / 3 训练失败 / 4 已激活
 */
function parseVolcanoState(res: VolcanoResponse): 'training' | 'ready' | 'failed' {
  const status = res.status
  if (status === 2 || status === 4) return 'ready'
  if (status === 3) return 'failed'
  return 'training'
}
