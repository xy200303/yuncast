import { spawn } from 'node:child_process'
import { getFfmpegPath } from './bin'
/** 日志走 console（本项目无 electron-log） */
const log = console

/**
 * Node 侧 PCM 混音器（FFmpeg 直推模式的音频汇合点）。
 * 以 20ms 时钟向推流进程 stdin 喂 48kHz 立体声 s16le：
 *   TTS 播报 + BGM 循环 + 麦克风人声，BGM 在 TTS 期间自动下压（ducking）。
 * TTS 的 PCM 由主进程 AudioPipeline 按真实速率推来（与本机监听同一份解码结果）；
 * 本机监听那一份由渲染层 WebAudio 出声，混音器只管推流。
 */

const SAMPLE_RATE = 48000
const CHANNELS = 2
const BYTES_PER_SAMPLE = 2
const FRAME_MS = 20
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS * CHANNELS * BYTES_PER_SAMPLE) / 1000 // 3840

const DUCK_RATIO = 10 ** (-14 / 20) // 默认下压 14dB

/** 把任意音频文件解码为 PCM Buffer（默认 s16le 48k stereo；可指定声道/采样率） */
export function decodeToPcm(
  filePath: string,
  opts: { channels?: number; sampleRate?: number } = {}
): Promise<Buffer> {
  const channels = opts.channels ?? CHANNELS
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), [
      '-v', 'error',
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      'pipe:1'
    ])
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-2000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`音频解码失败：${firstLine(stderr) || `ffmpeg 退出码 ${code}`}（${filePath}）`))
    })
  })
}

/** ffmpeg stderr 的第一行非空内容（报错要具体） */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

export class AudioMixer {
  private writer: NodeJS.WritableStream | null = null
  private clock: NodeJS.Timeout | null = null

  private ttsQueue: Buffer[] = []
  private ttsCurrent: { buf: Buffer; pos: number } | null = null
  private bgmBuf: Buffer | null = null
  private bgmPos = 0
  private bgmVolume = 0.3
  private duckingEnabled = true
  private micRing: Buffer[] = []
  private micRingBytes = 0
  private lastMicAt = 0

  /** 接入推流进程的 stdin，开始喂流 */
  attach(sink: NodeJS.WritableStream): void {
    this.writer = sink
    if (this.clock) return
    this.clock = setInterval(() => this.tick(), FRAME_MS)
  }

  detach(): void {
    this.writer = null
    if (this.clock) clearInterval(this.clock)
    this.clock = null
    this.ttsQueue = []
    this.ttsCurrent = null
  }

  /** 实时 TTS / 文件解码后的 PCM 块入播报队列（48k 立体声 s16le；AudioPipeline 是唯一数据源） */
  pushTtsPcm(pcm: Buffer): void {
    if (pcm.length > 0) this.ttsQueue.push(pcm)
  }

  async setBgm(action: 'start' | 'stop' | 'volume', filePath?: string, volume?: number): Promise<void> {
    if (action === 'volume' && volume !== undefined) {
      this.bgmVolume = volume
      return
    }
    if (action === 'stop') {
      this.bgmBuf = null
      this.bgmPos = 0
      return
    }
    if (action === 'start' && filePath) {
      try {
        this.bgmBuf = await decodeToPcm(filePath)
        this.bgmPos = 0
        if (volume !== undefined) this.bgmVolume = volume
      } catch (err) {
        log.warn('BGM 解码失败:', err)
      }
    }
  }

  setDuckingEnabled(enabled: boolean): void {
    this.duckingEnabled = enabled
  }

  /** 真人麦克风 PCM 帧入环形缓冲（上限约 1MB，溢出丢弃最旧数据保实时） */
  pushMicPcm(pcm: Buffer): void {
    const MAX_RING = 1024 * 1024
    this.micRing.push(pcm)
    this.micRingBytes += pcm.length
    this.lastMicAt = Date.now()
    while (this.micRingBytes > MAX_RING && this.micRing.length > 1) {
      this.micRingBytes -= this.micRing[0].length
      this.micRing.shift()
    }
  }

  // ---------- 内部 ----------

  private tick(): void {
    const writer = this.writer as (NodeJS.WritableStream & { destroyed?: boolean }) | null
    if (!writer || writer.destroyed) return
    const frame = Buffer.alloc(FRAME_BYTES)
    this.mixTts(frame)
    this.mixMic(frame)
    this.mixBgm(frame)
    // 背压：写不进去时丢帧保实时，下拍再写
    writer.write(frame)
  }

  /** 麦克风人声满音量混入（人声优先级最高，不被压） */
  private mixMic(frame: Buffer): void {
    let offset = 0
    while (offset < FRAME_BYTES && this.micRing.length > 0) {
      const head = this.micRing[0]
      const n = Math.min(FRAME_BYTES - offset, head.length)
      for (let i = 0; i < n; i += 2) {
        const mixed = clamp16(frame.readInt16LE(offset + i) + head.readInt16LE(i))
        frame.writeInt16LE(mixed, offset + i)
      }
      offset += n
      if (n === head.length) {
        this.micRing.shift()
      } else {
        this.micRing[0] = head.subarray(n)
      }
      this.micRingBytes -= n
    }
  }

  private mixTts(frame: Buffer): void {
    let offset = 0
    while (offset < FRAME_BYTES) {
      if (!this.ttsCurrent) {
        const next = this.ttsQueue.shift()
        if (!next) return
        this.ttsCurrent = { buf: next, pos: 0 }
      }
      const { buf, pos } = this.ttsCurrent
      const n = Math.min(FRAME_BYTES - offset, buf.length - pos)
      buf.copy(frame, offset, pos, pos + n)
      this.ttsCurrent.pos += n
      offset += n
      if (this.ttsCurrent.pos >= buf.length) this.ttsCurrent = null
    }
  }

  private mixBgm(frame: Buffer): void {
    const bgm = this.bgmBuf
    if (!bgm || bgm.length === 0) return
    // TTS 播报中或真人说话中（600ms 内有麦克风输入）都压低 BGM
    const micFresh = Date.now() - this.lastMicAt < 600
    const talking = this.ttsCurrent !== null || this.ttsQueue.length > 0 || micFresh
    const gain = this.bgmVolume * (this.duckingEnabled && talking ? DUCK_RATIO : 1)

    for (let i = 0; i < FRAME_BYTES; i += 4) {
      const bgmSampleL = bgm.readInt16LE(this.bgmPos)
      const bgmSampleR = bgm.readInt16LE(this.bgmPos + 2)
      const mixedL = clamp16(frame.readInt16LE(i) + bgmSampleL * gain)
      const mixedR = clamp16(frame.readInt16LE(i + 2) + bgmSampleR * gain)
      frame.writeInt16LE(mixedL, i)
      frame.writeInt16LE(mixedR, i + 2)
      this.bgmPos = (this.bgmPos + 4) % bgm.length
    }
  }
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)))
}

export const audioMixer = new AudioMixer()
