import { audioEngine } from './engine'

/**
 * 本机监听播放器（渲染层唯一的播放器）。
 *
 * 主进程 AudioPipeline 按真实速率把 PCM 片推来（IPC audio:pcm），这里用 WebAudio 的
 * AudioBufferSourceNode 按游标首尾相接排播：第一片到达就开始出声，后续片无缝接上。
 *
 * PCM 约定：s16le、48kHz、**单声道**（主进程推来的就是管线口径；立体声转换只在主进程喂混音器时做）。
 * 增益 / 静音 / 真人避让都挂在引擎的 tts 总线上，所以 master 音量与紧急静音天然生效。
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
    // 挂进引擎的 tts 总线：音量、AI 静音、真人避让都照常生效
    this.gain = ctx.createGain()
    this.gain.connect(audioEngine.ttsInput())
    return ctx
  }

  /** 推入一块 PCM（sampleRate 为该块原始采样率）；返回 true 表示这是本次会话的第一块 */
  push(pcm: Int16Array, sampleRate = SAMPLE_RATE): boolean {
    const ctx = this.ensureGraph()
    void ctx.resume()

    const samples = pcm.length
    if (samples === 0) return false
    // AudioBuffer 的采样率可与上下文不同：WebAudio 播放时自动重采样
    const buffer = ctx.createBuffer(1, samples, sampleRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) channel[i] = pcm[i] / 32768

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)

    const first = this.cursor <= ctx.currentTime
    const startAt = Math.max(this.cursor, ctx.currentTime + 0.02)
    source.start(startAt)
    this.cursor = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
    return first
  }

  /**
   * 一段播完：把游标留在原处，等它自然放完。
   * 下一条的 PCM 会接着游标排（连播不空档）；返回剩余播放时长（毫秒）。
   */
  end(): number {
    if (!this.ctx || this.cursor === 0) return 0
    return Math.max(0, (this.cursor - this.ctx.currentTime) * 1000)
  }

  /** 立即掐断（跳过这条 / 紧急停止）：已排的队列也不放了 */
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
