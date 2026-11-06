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

  // 第二路输出（同时送虚拟声卡）：独立 AudioContext，同一批 PCM 镜像过去
  private mirrorCtx: AudioContext | null = null
  private mirrorGain: GainNode | null = null
  private mirrorCursor = 0
  private mirrorSources = new Set<AudioBufferSourceNode>()
  private mirrorDeviceId: string | null = null

  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = audioEngine.ensureContext()
    this.ctx = ctx
    // 挂进引擎的 tts 总线：音量、AI 静音、真人避让都照常生效
    this.gain = ctx.createGain()
    this.gain.connect(audioEngine.ttsInput())
    return ctx
  }

  /**
   * 第二路输出设备（虚拟声卡）：
   * - deviceId 非空 = 开一路镜像，同一批 PCM 同时送过去（自己听主输出，推流软件采 CABLE Output）
   * - null = 关掉镜像
   */
  async setMirrorDevice(deviceId: string | null): Promise<boolean> {
    if (!deviceId) {
      this.stopMirror()
      return true
    }
    if (this.mirrorCtx && this.mirrorDeviceId === deviceId) return true
    this.stopMirror()
    try {
      const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> }
      if (typeof ctx.setSinkId !== 'function') {
        void ctx.close()
        return false
      }
      await ctx.setSinkId(deviceId)
      const gain = ctx.createGain()
      gain.gain.value = 1
      gain.connect(ctx.destination)
      void ctx.resume().catch(() => undefined)
      this.mirrorCtx = ctx
      this.mirrorGain = gain
      this.mirrorCursor = 0
      this.mirrorDeviceId = deviceId
      return true
    } catch (error) {
      console.warn('[音频] 第二路输出接不上：', error instanceof Error ? error.message : String(error))
      this.stopMirror()
      return false
    }
  }

  private stopMirror(): void {
    for (const source of this.mirrorSources) {
      try {
        source.stop()
      } catch {
        // 已结束的 source 再 stop 会抛，忽略
      }
    }
    this.mirrorSources.clear()
    if (this.mirrorCtx) void this.mirrorCtx.close().catch(() => undefined)
    this.mirrorCtx = null
    this.mirrorGain = null
    this.mirrorCursor = 0
    this.mirrorDeviceId = null
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

    // 镜像一路：AudioBuffer 不能跨上下文复用，得按镜像上下文的采样率重建
    if (this.mirrorCtx && this.mirrorGain) {
      const mirror = this.mirrorCtx
      const mirrorBuffer = mirror.createBuffer(1, samples, sampleRate)
      const mirrorChannel = mirrorBuffer.getChannelData(0)
      mirrorChannel.set(channel)
      const mirrorSource = mirror.createBufferSource()
      mirrorSource.buffer = mirrorBuffer
      mirrorSource.connect(this.mirrorGain)
      const mirrorStart = Math.max(this.mirrorCursor, mirror.currentTime + 0.02)
      mirrorSource.start(mirrorStart)
      this.mirrorCursor = mirrorStart + mirrorBuffer.duration
      this.mirrorSources.add(mirrorSource)
      mirrorSource.onended = () => this.mirrorSources.delete(mirrorSource)
    }

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
    for (const source of this.mirrorSources) {
      try {
        source.stop()
      } catch {
        // 同上
      }
    }
    this.mirrorSources.clear()
    this.mirrorCursor = 0
  }

  get isPlaying(): boolean {
    return this.sources.size > 0
  }
}

export const streamPlayer = new StreamPlayer()
