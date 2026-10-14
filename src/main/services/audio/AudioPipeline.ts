import { spawn, type ChildProcess } from 'node:child_process'
import type {
  AudioBgmAction,
  AudioCommandResult,
  AudioEndPayload,
  AudioLevelPayload,
  AudioPcmPayload,
  AudioProgressPayload
} from '../../../shared/types'
import { getFfmpegPath } from '../stream/ffmpeg/bin'
import { decodeToPcm } from '../stream/ffmpeg/mixer'

/**
 * 主进程音频管线：应用的**唯一音频权威**。
 *
 * 数据流（同一份解码 PCM 同时喂两路，不各自解码一遍）：
 *   合成文件 / PCM 流 → 这里按 50ms 一片、按真实速率节拍推
 *        ├→ 推流：复制成立体声 48k → StreamService → ffmpeg 混音器（没在直推就丢掉）
 *        └→ 本机监听：IPC audio:pcm → 渲染层 WebAudio 排播 → 声卡
 *
 * 口径统一：s16le / 48kHz / 单声道（混音器要的立体声在这一层复制出来）。
 * 音量（BGM、ducking、主音量、紧急静音）只在这里判定一次，渲染层只负责出声：
 *   - 主音量只压本机监听（你耳朵里听到的），不动推流那一路的电平；
 *   - 紧急静音把 AI 两路（本机监听 + 推流）一起哑，麦克风人声不受影响。
 * 推流那一路继续用现成的 ffmpeg 混音器，只是数据来源换成了这里解码出来的 PCM。
 */

const SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2
/** 一片的音频时长：50ms（调度精度与 IPC 频率的折中） */
const CHUNK_MS = 50
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS * BYTES_PER_SAMPLE) / 1000
/** 提前量：给混音器（20ms 时钟）和渲染层留的缓冲，也是本机监听的固有延迟 */
const LEAD_MS = 150
/** 解码队列上限（背压）：超过就让 ffmpeg 先歇着，避免长文件整段堆在内存里 */
const MAX_QUEUE_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 2
/** 每 3 片（150ms）推一次电平 */
const LEVEL_EVERY_FRAMES = 3
/** 每 5 片（250ms）推一次主槽播放进度（预制节目进度条用） */
const PROGRESS_EVERY_FRAMES = 5
const DUCK_DEPTH_DB = 14
const DEFAULT_DUCK_RATIO = 10 ** (-DUCK_DEPTH_DB / 20)
/** BGM 增益平滑系数（每片逼近目标，避免 ducking 切换咔哒） */
const BGM_SMOOTH = 0.3
/** 电平显示放大（与旧渲染层口径一致，UI 电平条不跳变） */
const LEVEL_DISPLAY_GAIN = 2.5

/** 播放槽：main = 话术池播报（顺序取件）；aux = 试听/接入测试（不打断主播） */
const SLOTS = ['main', 'aux'] as const
export type AudioSlot = (typeof SLOTS)[number]

export interface PlayResult {
  ok: boolean
  error?: string
  /** 被 stopAll 打断（跳过 / 紧急停止 / 暂停） */
  stopped?: boolean
}

export interface PlayRequest {
  /** 第一片真的推出去（解码成功、开始出声）时兑现；失败带具体原因 */
  started: Promise<PlayResult>
  /** 播完（或被打断）时兑现 */
  done: Promise<PlayResult>
  stop(): void
}

export interface PcmStreamHandle extends PlayRequest {
  /** 推入一块 PCM（s16le、单声道；采样率不是 48k 就线性重采样） */
  push(pcm: Buffer, sampleRate: number): void
  /** 生产者正常结束（剩余队列放完才算 done） */
  end(): void
  /** 生产者失败（合成报错等）：整段按失败收尾 */
  fail(error: string): void
}

export interface AudioPipelineSinks {
  /** 推流那一路：48k 立体声 s16le → 混音器（调用方按推流状态决定收不收） */
  feedStream(pcmStereo48k: Buffer): void
  /** 推流侧的 BGM 仍用混音器现成的 setBgm（它自己解码自己循环） */
  setStreamBgm(action: AudioBgmAction, filePath?: string, volume?: number): Promise<void>
  /** main → renderer */
  sendPcm(payload: AudioPcmPayload): void
  sendLevel(payload: AudioLevelPayload): void
  sendEnd(payload: AudioEndPayload): void
  /** 主槽播放进度（预制节目长音频进度条用） */
  sendProgress(payload: AudioProgressPayload): void
}

interface Session {
  itemId: string
  slot: AudioSlot
  /** 文件播放的源路径（章内 seek 重启解码用；流式会话为 null） */
  filePath: string | null
  /** 待播 PCM（mono 48k s16le），按片取用 */
  queue: Buffer[]
  headOffset: number
  queued: number
  /** 已排播字节数的进度基准（seek 时重置为跳转位置对应字节，之后随排播累加） */
  progressBytes: number
  /** 生产者已结束（文件读完 / 流式合成收尾）：队列放完就收尾 */
  ended: boolean
  error: string | null
  stopped: boolean
  decoder: ChildProcess | null
  paused: boolean
  emitted: number
  startedSettled: boolean
  resolveStarted: (result: PlayResult) => void
  resolveDone: (result: PlayResult) => void
  started: Promise<PlayResult>
  done: Promise<PlayResult>
}

interface Frame {
  /** 本片 TTS 内容（两个槽相加后的 mono 48k） */
  tts: Buffer
  /** 本片最终出声内容（TTS + BGM，含主音量与静音） */
  monitor: Buffer
  hasTts: boolean
  finished: Session[]
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

function clamp16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : Math.round(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取 ffmpeg stderr 的第一行非空内容（报错要具体，别只说"解码失败"） */
function firstStderrLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

/** 单声道 RMS（0-1） */
function rms(buf: Buffer): number {
  const samples = Math.floor(buf.length / BYTES_PER_SAMPLE)
  if (samples === 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * BYTES_PER_SAMPLE) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples)
}

/** 线性插值重采样到 48k（单声道 s16le） */
function resampleTo48k(pcm: Buffer, fromRate: number): Buffer {
  if (fromRate === SAMPLE_RATE || fromRate <= 0) return pcm
  const inSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  if (inSamples === 0) return pcm
  const ratio = SAMPLE_RATE / fromRate
  const outSamples = Math.max(1, Math.floor(inSamples * ratio))
  const out = Buffer.alloc(outSamples * BYTES_PER_SAMPLE)
  for (let i = 0; i < outSamples; i++) {
    const pos = i / ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = pcm.readInt16LE(Math.min(idx, inSamples - 1) * BYTES_PER_SAMPLE)
    const b = pcm.readInt16LE(Math.min(idx + 1, inSamples - 1) * BYTES_PER_SAMPLE)
    out.writeInt16LE(clamp16(a + (b - a) * frac), i * BYTES_PER_SAMPLE)
  }
  return out
}

/** 单声道 → 立体声（混音器口径是 48k stereo） */
function toStereo48k(mono: Buffer): Buffer {
  const out = Buffer.alloc(mono.length * 2)
  for (let i = 0; i + 1 < mono.length; i += BYTES_PER_SAMPLE) {
    const sample = mono.readInt16LE(i)
    out.writeInt16LE(sample, i * 2)
    out.writeInt16LE(sample, i * 2 + 2)
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export class AudioPipeline {
  private slots: Partial<Record<AudioSlot, Session>> = {}
  private pumpRunning = false
  private disposed = false

  private masterVolume = 1
  private muted = false
  private duckingEnabled = true
  private duckRatio = DEFAULT_DUCK_RATIO

  private bgm: Buffer | null = null
  private bgmPos = 0
  private bgmVolume = 0.3
  private bgmGain = 0

  private seq = 0
  private framesSinceLevel = 0
  private framesSinceProgress = 0
  /** 累加器与各槽的临时缓冲（复用，避免每片都分配） */
  private mixScratch = Buffer.alloc(CHUNK_BYTES)
  private slotScratch: Record<AudioSlot, Buffer> = {
    main: Buffer.alloc(CHUNK_BYTES),
    aux: Buffer.alloc(CHUNK_BYTES)
  }
  private monitorScratch = Buffer.alloc(CHUNK_BYTES)

  constructor(private readonly sinks: AudioPipelineSinks) {}

  // ---------- 播放入口 ----------

  /** 播一个音频文件（ffmpeg 流式解码，不整段读进内存） */
  playFile(itemId: string, filePath: string, opts: { slot?: AudioSlot } = {}): PlayRequest {
    const session = this.createSession(itemId, opts.slot ?? 'main')
    session.filePath = filePath
    this.spawnDecoder(session, filePath)
    this.startPump()
    return this.requestOf(session)
  }

  /**
   * 起一路 ffmpeg 解码（流式 stdout → 会话队列）。
   * offsetSec > 0 = 章内 seek：input seeking（-ss 在 -i 前），速度快、精度对听感足够。
   * close 回调带进程身份校验：seek 替换掉旧解码进程后，旧进程的 close 不能误伤新会话状态。
   */
  private spawnDecoder(session: Session, filePath: string, offsetSec = 0): void {
    const args = ['-hide_banner', '-loglevel', 'error']
    if (offsetSec > 0) args.push('-ss', offsetSec.toFixed(3))
    args.push('-i', filePath, '-f', 's16le', '-ar', '48000', '-ac', '1', '-')
    const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    session.decoder = proc
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => this.enqueue(session, chunk))
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    proc.on('error', (error) => {
      if (session.decoder !== proc) return
      this.failSession(session, `音频解码失败：${error.message}`)
    })
    proc.on('close', (code) => {
      if (session.decoder !== proc) return
      session.decoder = null
      if (session.stopped) return
      if (code === 0) this.endSession(session)
      else {
        const reason = firstStderrLine(stderr) || `ffmpeg 退出码 ${code}`
        this.failSession(session, `音频解码失败：${reason}（${filePath}）`)
      }
    })
  }

  /**
   * 章内 seek（预制节目长音频）：只支持主槽的文件播放会话。
   * 实现 = 掐掉旧解码进程、清空已解码缓冲、以 -ss 从目标位置重启解码；
   * 播放循环与条目状态无感知（它等的是 session.done，进度基准由 progressBytes 重新起算）。
   */
  seekMain(offsetMs: number): AudioCommandResult {
    const session = this.slots['main']
    if (!session || !session.filePath) return { ok: false, error: '当前没有可拖动的文件播放' }
    const ms = Math.max(0, Number(offsetMs) || 0)
    if (session.decoder) {
      const decoder = session.decoder
      session.decoder = null
      decoder.stdout?.removeAllListeners('data')
      decoder.kill()
    }
    session.queue = []
    session.headOffset = 0
    session.queued = 0
    session.paused = false
    // 可能是在整章已解码完（ended=true）后才拖的：不重置的话，新解码进程启动前
    // 队列一空就会被当成「播完」提前收尾
    session.ended = false
    session.error = null
    session.progressBytes = Math.floor((ms * SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000)
    this.spawnDecoder(session, session.filePath, ms / 1000)
    this.startPump()
    this.sinks.sendProgress({ itemId: session.itemId, positionMs: ms, active: true })
    return { ok: true }
  }

  /** 停指定槽（aux 试听停止用；不动另一个槽的播报） */
  stopSlot(slot: AudioSlot): void {
    const session = this.slots[slot]
    if (session) this.settleSession(session, { ok: false, stopped: true })
  }

  /** 接一路流式 PCM（动态内容的实时合成），与文件播放共用同一条排播/混音链 */
  beginStream(itemId: string, opts: { slot?: AudioSlot } = {}): PcmStreamHandle {
    const session = this.createSession(itemId, opts.slot ?? 'main')
    this.startPump()
    return {
      ...this.requestOf(session),
      push: (pcm: Buffer, sampleRate: number) => {
        if (pcm.length === 0) return
        this.enqueue(session, resampleTo48k(pcm, sampleRate))
      },
      end: () => this.endSession(session),
      fail: (error: string) => this.failSession(session, error)
    }
  }

  /** 停掉当前 AI 播报（跳过这条 / 紧急停止；BGM 与推流不断） */
  stopAll(): void {
    for (const slot of SLOTS) {
      const session = this.slots[slot]
      if (session) this.settleSession(session, { ok: false, stopped: true })
    }
  }

  // ---------- 音量 / BGM ----------

  /** 本机监听主音量（只影响你耳朵里听到的，不动推流那一路） */
  setMasterVolume(volume: number): void {
    const value = Number(volume)
    this.masterVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  }

  /** 紧急静音：AI 两路（本机监听 + 推流）一起哑，麦克风人声不受影响。
   *  时间照走（条目照常播完），解除后从当前位置继续。 */
  setMuted(muted: boolean): void {
    this.muted = Boolean(muted)
  }

  setDucking(enabled: boolean, depthDb = DUCK_DEPTH_DB): void {
    this.duckingEnabled = Boolean(enabled)
    this.duckRatio = this.duckingEnabled ? 10 ** (-depthDb / 20) : 1
  }

  /** BGM：本机这一路解码成 PCM 循环混音；推流那一路交给混音器自己的 setBgm */
  async setBgm(action: AudioBgmAction, filePath?: string, volume?: number): Promise<AudioCommandResult> {
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      this.bgmVolume = Math.max(0, Math.min(1, volume))
    }
    if (action === 'volume') {
      await this.sinks.setStreamBgm('volume', undefined, this.bgmVolume)
      return { ok: true }
    }
    if (action === 'stop') {
      this.bgm = null
      this.bgmPos = 0
      this.bgmGain = 0
      await this.sinks.setStreamBgm('stop')
      return { ok: true }
    }
    if (!filePath) return { ok: false, error: '没有选择 BGM 文件' }
    try {
      const pcm = await decodeToPcm(filePath, { channels: 1 })
      if (pcm.length < BYTES_PER_SAMPLE) return { ok: false, error: 'BGM 文件里没有音频数据' }
      this.bgm = pcm
      this.bgmPos = 0
      this.bgmGain = 0
      this.startPump()
      await this.sinks.setStreamBgm('start', filePath, this.bgmVolume)
      return { ok: true }
    } catch (error) {
      // decodeToPcm 的报错已经带着 ffmpeg stderr 首行和文件路径，原样透出
      return { ok: false, error: errorText(error) }
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopAll()
    this.bgm = null
    this.bgmPos = 0
    this.bgmGain = 0
  }

  // ---------- 会话管理 ----------

  private createSession(itemId: string, slot: AudioSlot): Session {
    const previous = this.slots[slot]
    // 同一槽同时只播一条：新的来了先把旧的按"被打断"收尾（调用方按 stopped 处理）
    if (previous) this.settleSession(previous, { ok: false, stopped: true })
    const started = deferred<PlayResult>()
    const done = deferred<PlayResult>()
    const session: Session = {
      itemId,
      slot,
      filePath: null,
      queue: [],
      headOffset: 0,
      queued: 0,
      progressBytes: 0,
      ended: false,
      error: null,
      stopped: false,
      decoder: null,
      paused: false,
      emitted: 0,
      startedSettled: false,
      resolveStarted: started.resolve,
      resolveDone: done.resolve,
      started: started.promise,
      done: done.promise
    }
    this.slots[slot] = session
    return session
  }

  private requestOf(session: Session): PlayRequest {
    return {
      started: session.started,
      done: session.done,
      stop: () => this.settleSession(session, { ok: false, stopped: true })
    }
  }

  private enqueue(session: Session, chunk: Buffer): void {
    if (session.stopped || this.disposed || chunk.length === 0) return
    session.queue.push(chunk)
    session.queued += chunk.length
    this.applyBackpressure(session)
  }

  private applyBackpressure(session: Session): void {
    const stdout = session.decoder?.stdout
    if (!stdout) return
    if (!session.paused && session.queued > MAX_QUEUE_BYTES) {
      stdout.pause()
      session.paused = true
    } else if (session.paused && session.queued < MAX_QUEUE_BYTES / 2) {
      stdout.resume()
      session.paused = false
    }
  }

  /** 生产者正常结束：队列里没东西了就立刻收尾，否则等排播放完 */
  private endSession(session: Session): void {
    if (session.stopped) return
    session.ended = true
    if (session.queued > 0) return
    if (session.emitted === 0) {
      this.settleSession(session, { ok: false, error: '这段音频没有可播放的数据（解码结果为空）' })
      return
    }
    this.settleSession(session, { ok: true })
  }

  private failSession(session: Session, error: string): void {
    if (session.stopped) return
    session.error = error
    session.ended = true
    // 已经出过声：剩下的队列放完再说，收尾时带错误（不算成功）
    if (session.emitted > 0) {
      if (session.queued === 0) this.settleSession(session, { ok: false, error })
      return
    }
    this.settleSession(session, { ok: false, error })
  }

  private settleSession(session: Session, result: PlayResult): void {
    if (session.stopped) return
    session.stopped = true
    if (session.decoder) {
      const decoder = session.decoder
      session.decoder = null
      decoder.stdout?.removeAllListeners('data')
      decoder.kill()
    }
    session.queue = []
    session.queued = 0
    if (this.slots[session.slot] === session) delete this.slots[session.slot]
    if (!session.startedSettled) {
      session.startedSettled = true
      session.resolveStarted(result)
    }
    // 渲染层据此收尾排播（stopped 就是立刻掐断，不把已排的队列放完）
    this.sinks.sendEnd({ itemId: session.itemId, stopped: result.stopped })
    // 主槽收尾：进度归零（下一条的第一帧进度会再把它顶起来）
    if (session.slot === 'main') {
      this.sinks.sendProgress({ itemId: session.itemId, positionMs: 0, active: false })
    }
    session.resolveDone(result)
  }

  /** 从会话队列取至多 out.length 字节（跨块续读） */
  private takeInto(session: Session, out: Buffer): number {
    let written = 0
    while (written < out.length && session.queue.length > 0) {
      const head = session.queue[0]
      const n = Math.min(out.length - written, head.length - session.headOffset)
      head.copy(out, written, session.headOffset, session.headOffset + n)
      session.headOffset += n
      session.queued -= n
      written += n
      if (session.headOffset >= head.length) {
        session.queue.shift()
        session.headOffset = 0
      }
    }
    this.applyBackpressure(session)
    return written
  }

  // ---------- 排播（按真实速率推进） ----------

  private isActive(): boolean {
    return SLOTS.some((slot) => this.slots[slot] !== undefined) || this.bgm !== null
  }

  private startPump(): void {
    if (this.pumpRunning || this.disposed) return
    this.pumpRunning = true
    void this.pump()
  }

  /**
   * 排播循环：每片 50ms 音频，按**累积时间戳**节拍推出。
   * 留 LEAD_MS 提前量（前 3 片立即出），让混音器与渲染层先有缓冲，之后严格按真实速率走。
   */
  private async pump(): Promise<void> {
    const startedAt = Date.now()
    let frames = 0
    try {
      while (!this.disposed && this.isActive()) {
        const wait = startedAt + frames * CHUNK_MS - LEAD_MS - Date.now()
        if (wait > 0) await sleep(Math.min(wait, CHUNK_MS))
        if (this.disposed || !this.isActive()) break
        this.emitFrame()
        frames += 1
      }
    } finally {
      this.pumpRunning = false
      this.bgmGain = 0
      // 收工：电平归零，UI 上的电平条不会停在最后一个峰值
      this.framesSinceLevel = 0
      this.framesSinceProgress = 0
      this.sinks.sendLevel({ tts: 0, master: 0 })
      // 刚好在收工这一瞬来了新会话：重启循环，别让它等一个不会来的泵
      if (this.isActive()) this.startPump()
    }
  }

  private emitFrame(): void {
    const frame = this.buildFrame()
    const bgmActive = this.bgm !== null
    const ttsRms = frame.hasTts ? rms(frame.tts) : 0
    const masterRms = frame.hasTts || bgmActive ? rms(frame.monitor) : 0

    if (frame.hasTts || bgmActive) {
      this.seq += 1
      // 送出的必须是副本：scratch 下一片还要复用
      this.sinks.sendPcm({ pcm: Buffer.from(frame.monitor), sampleRate: SAMPLE_RATE, seq: this.seq })
    }
    // 推流那一路：同一份 TTS PCM（复制成立体声）喂混音器；静音期间不喂 = 直播间也哑
    if (frame.hasTts && !this.muted) this.sinks.feedStream(toStereo48k(frame.tts))

    this.framesSinceLevel += 1
    if (this.framesSinceLevel >= LEVEL_EVERY_FRAMES) {
      this.framesSinceLevel = 0
      const display = this.muted ? 0 : 1
      this.sinks.sendLevel({
        tts: Math.min(1, ttsRms * LEVEL_DISPLAY_GAIN) * display,
        master: Math.min(1, masterRms * LEVEL_DISPLAY_GAIN) * display
      })
    }

    // 主槽播放进度（预制节目进度条）：按已排播字节折算毫秒，静音期间时间照走
    this.framesSinceProgress += 1
    if (this.framesSinceProgress >= PROGRESS_EVERY_FRAMES) {
      this.framesSinceProgress = 0
      const main = this.slots['main']
      if (main && !main.stopped) {
        this.sinks.sendProgress({
          itemId: main.itemId,
          positionMs: (main.progressBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000,
          active: true
        })
      }
    }

    // 队列放完的会话收尾（audioEnd 在最后一片 PCM 之后发，渲染层据此收排播）
    for (const session of frame.finished) {
      if (session.error) this.settleSession(session, { ok: false, error: session.error })
      else this.settleSession(session, { ok: true })
    }
  }

  private buildFrame(): Frame {
    const mix = this.mixScratch
    mix.fill(0)
    let hasTts = false
    const finished: Session[] = []

    for (const slot of SLOTS) {
      const session = this.slots[slot]
      if (!session) continue
      const part = this.slotScratch[slot]
      part.fill(0)
      const n = this.takeInto(session, part)
      if (n > 0) {
        hasTts = true
        session.emitted += n
        session.progressBytes += n
        if (!session.startedSettled) {
          // 第一片真的推出去 = 开始出声，试听/接入测试据此判成功
          session.startedSettled = true
          session.resolveStarted({ ok: true })
        }
        for (let i = 0; i + 1 < part.length; i += BYTES_PER_SAMPLE) {
          const mixed = mix.readInt16LE(i) + part.readInt16LE(i)
          mix.writeInt16LE(clamp16(mixed), i)
        }
      }
      if (session.ended && session.queued === 0) finished.push(session)
    }

    return { tts: mix, monitor: this.buildMonitor(mix, hasTts), hasTts, finished }
  }

  /** 本机监听这一片：TTS（含主音量/静音）+ BGM（含音量与 ducking 平滑） */
  private buildMonitor(tts: Buffer, ttsTalking: boolean): Buffer {
    const out = this.monitorScratch
    const aiGain = this.muted ? 0 : this.masterVolume
    const bgm = this.bgm
    if (bgm) {
      // 紧急静音要立刻哑掉（不淡出），恢复才走平滑，避免 BGM 突然回来"啪"一下
      if (this.muted) this.bgmGain = 0
      else {
        const target = this.bgmVolume * (this.duckingEnabled && ttsTalking ? this.duckRatio : 1)
        this.bgmGain += (target - this.bgmGain) * BGM_SMOOTH
      }
    }
    for (let i = 0; i + 1 < CHUNK_BYTES; i += BYTES_PER_SAMPLE) {
      let value = tts.readInt16LE(i) * aiGain
      if (bgm) {
        value += bgm.readInt16LE(this.bgmPos) * this.bgmGain
        this.bgmPos += BYTES_PER_SAMPLE
        if (this.bgmPos >= bgm.length) this.bgmPos = 0
      }
      out.writeInt16LE(clamp16(value), i)
    }
    return out
  }
}
