import { audioEngine } from './engine'

/**
 * 本机监听播放器（渲染层唯一的播放器）。
 *
 * 主进程 AudioPipeline 按真实速率把 PCM 片推来（IPC audio:pcm），这里用 WebAudio 的
 * AudioBufferSourceNode 按游标首尾相接排播：第一片到达就开始出声，后续片无缝接上。
 *
 * PCM 约定：s16le、48kHz、**单声道**（主进程推来的就是管线口径；立体声转换只在主进程喂混音器时做）。
 * 增益 / 静音 / 真人避让都挂在引擎的 tts 总线上，所以 master 音量与紧急静音天然生效。
 *
 * 多输出：主输出走引擎那条图；另外勾选的设备各开一个独立 AudioContext 镜像同一批 PCM
 * （典型是扬声器 + 虚拟声卡：自己听，推流软件同时采 CABLE Output）。
 */

const SAMPLE_RATE = 48000

interface Mirror {
  ctx: AudioContext
  gain: GainNode
  /** 下一块应该排播的时刻（该上下文的 AudioContext 时间轴） */
  cursor: number
  sources: Set<AudioBufferSourceNode>
}

class StreamPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  /** 下一块应该排播的时刻（AudioContext 时间轴） */
  private cursor = 0
  private sources = new Set<AudioBufferSourceNode>()
  /** 额外输出设备：deviceId → 独立音频图 */
  private mirrors = new Map<string, Mirror>()

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
   * 设置镜像输出设备集合：多退少补（已有的不重建，避免播放中途断音）。
   * 主输出不在这里——它由 audioEngine.setOutputDevice 管。
   */
  async setMirrorDevices(items: { deviceId: string; volume: number }[]): Promise<void> {
    const want = new Map(items.filter((item) => item.deviceId).map((item) => [item.deviceId, item.volume]))
    for (const [id, mirror] of [...this.mirrors.entries()]) {
      if (want.has(id)) {
        mirror.gain.gain.value = Math.max(0, Math.min(1, want.get(id) ?? 1))
        continue
      }
      this.stopMirror(mirror)
      this.mirrors.delete(id)
    }
    for (const [id, volume] of want) {
      if (this.mirrors.has(id)) continue
      try {
        const ctx = new AudioContext() as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }
        if (typeof ctx.setSinkId !== 'function') {
          void ctx.close().catch(() => undefined)
          continue
        }
        await ctx.setSinkId(id)
        const gain = ctx.createGain()
        gain.gain.value = Math.max(0, Math.min(1, volume))
        gain.connect(ctx.destination)
        void ctx.resume().catch(() => undefined)
        this.mirrors.set(id, { ctx, gain, cursor: 0, sources: new Set() })
      } catch (error) {
        console.warn('[音频] 额外输出接不上：', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private stopMirror(mirror: Mirror): void {
    for (const source of mirror.sources) {
      try {
        source.stop()
      } catch {
        // 已结束的 source 再 stop 会抛，忽略
      }
    }
    mirror.sources.clear()
    void mirror.ctx.close().catch(() => undefined)
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

    for (const mirror of this.mirrors.values()) this.pushMirror(mirror, channel, samples, sampleRate)
    return first
  }

  /** AudioBuffer 不能跨上下文复用：按镜像上下文的采样率重建一份，再按它自己的时间轴排 */
  private pushMirror(mirror: Mirror, channel: Float32Array, samples: number, sampleRate: number): void {
    const ctx = mirror.ctx
    void ctx.resume().catch(() => undefined)
    const buffer = ctx.createBuffer(1, samples, sampleRate)
    buffer.getChannelData(0).set(channel)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(mirror.gain)
    const startAt = Math.max(mirror.cursor, ctx.currentTime + 0.02)
    source.start(startAt)
    mirror.cursor = startAt + buffer.duration
    mirror.sources.add(source)
    source.onended = () => mirror.sources.delete(source)
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
    for (const mirror of this.mirrors.values()) {
      for (const source of mirror.sources) {
        try {
          source.stop()
        } catch {
          // 同上
        }
      }
      mirror.sources.clear()
      mirror.cursor = 0
    }
  }

  get isPlaying(): boolean {
    return this.sources.size > 0
  }
}

export const streamPlayer = new StreamPlayer()
