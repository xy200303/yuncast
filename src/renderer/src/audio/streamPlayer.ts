import { audioEngine } from './engine'

/**
 * 实时 TTS 的 PCM 流式播放器。
 *
 * 与整段播放（playTts 播 mp3 文件）不同：这里接收主进程按真实速率推来的 PCM 块，
 * 用 WebAudio 的 AudioBufferSourceNode 按游标首尾相接排播 —— 第一块到达就开始出声，
 * 后续块无缝接上，做到"边合成边播"。
 *
 * PCM 约定：s16le、48kHz、单声道（与混音器同一口径，主进程直接转发给混音器所以两边一致）。
 */

const SAMPLE_RATE = 48000

class StreamPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  /** 下一块应该排播的时刻（AudioContext 时间轴） */
  private cursor = 0
  private sources = new Set<AudioBufferSourceNode>()

  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = audioEngine.ensureContext()
    this.ctx = ctx
    // 挂进引擎的 tts 总线：ducking、AI 静音、电平表都照常生效
    this.gain = ctx.createGain()
    this.gain.connect(audioEngine.ttsInput())
    return ctx
  }

  /** 推入一块 PCM；返回 true 表示这是本次会话的第一块（已开始出声） */
  push(pcm: Int16Array): boolean {
    const ctx = this.ensureGraph()
    void ctx.resume()

    const samples = pcm.length
    if (samples === 0) return false
    const buffer = ctx.createBuffer(1, samples, SAMPLE_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) channel[i] = pcm[i] / 32768

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)

    const startAt = Math.max(this.cursor, ctx.currentTime + 0.02)
    const first = this.cursor === 0
    source.start(startAt)
    this.cursor = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
    return first
  }

  /** 会话结束：返回剩余播放时长（毫秒），调用方可等它播完 */
  end(): number {
    if (!this.ctx || this.cursor === 0) {
      this.cursor = 0
      return 0
    }
    const remainMs = Math.max(0, (this.cursor - this.ctx.currentTime) * 1000)
    this.cursor = 0
    return remainMs
  }

  /** 立即停止（接管说话/紧急停止时用） */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // 已经结束的 source 再 stop 会抛，忽略
      }
    }
    this.sources.clear()
    this.cursor = 0
  }

  get isPlaying(): boolean {
    return this.sources.size > 0
  }
}

export const streamPlayer = new StreamPlayer()
