/**
 * WebAudio 混音引擎（渲染进程单例，搬迁自旧版 desktop/src/renderer/src/audio/engine.ts）。
 * 拓扑：
 *   tts 元素 → ttsGain ┐
 *                      ┼→ masterGain → analyser → destination
 *   （BGM 预留）bgmGain ┘
 * ducking：tts 播放期间 bgmGain 自动下压（Gain 自动化，无延迟抖动）。
 * M2 只接 tts 总线 + master 电平；BGM / 麦克风总线留接口，后续里程碑接入。
 */

export interface EngineEvents {
  onLevels(levels: { tts: number; master: number }): void
}

const LEVEL_INTERVAL_MS = 150

/** audio-cache 里的合成音频走 media:// 自定义协议（dev 下页面是 http://，不能直接 file://） */
export function toCacheMediaUrl(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()!
  return `media:///${encodeURIComponent(name)}`
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private ttsGain: GainNode | null = null
  private bgmGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private ttsEl: HTMLAudioElement | null = null

  private duckingEnabled = true
  private duckingDepthDb = 14
  private aiMuted = false
  private activeTts = 0
  private bgmBaseVolume = 0.3
  private levelsTimer: ReturnType<typeof setInterval> | null = null
  private events: EngineEvents | null = null

  init(events: EngineEvents): void {
    this.events = events
  }

  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.ttsGain = this.ctx.createGain()
    this.bgmGain = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.ttsGain.connect(this.masterGain)
    this.bgmGain.connect(this.masterGain)
    this.masterGain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
    this.applyMute()
    this.startLevelLoop()
    return this.ctx
  }

  // ---------- TTS 播报 ----------

  /** 播放一条 TTS 音频，结束后 resolve */
  playTts(filePath: string): Promise<void> {
    const ctx = this.ensureGraph()
    void ctx.resume()
    return new Promise((resolve) => {
      const el = new Audio(toCacheMediaUrl(filePath))
      this.ttsEl = el
      const src = ctx.createMediaElementSource(el)
      src.connect(this.ttsGain!)
      el.addEventListener('ended', () => this.finishTts(src, el, resolve), { once: true })
      el.addEventListener('error', () => this.finishTts(src, el, resolve), { once: true })
      this.activeTts += 1
      this.applyBgmGain()
      void el.play().catch(() => this.finishTts(src, el, resolve))
    })
  }

  private finishTts(
    src: MediaElementAudioSourceNode,
    el: HTMLAudioElement,
    resolve: () => void
  ): void {
    if (this.ttsEl === el) this.ttsEl = null
    src.disconnect()
    this.activeTts = Math.max(0, this.activeTts - 1)
    if (this.activeTts === 0) this.applyBgmGain()
    resolve()
  }

  /** 当前 TTS 播放进度 0~1，未播放或时长未知时返回 null（提词器句级高亮用） */
  getTtsProgress(): number | null {
    const el = this.ttsEl
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return null
    return Math.min(1, el.currentTime / el.duration)
  }

  stopCurrentTts(): void {
    if (this.ttsEl) {
      this.ttsEl.pause()
      this.ttsEl.currentTime = 0
      this.ttsEl = null
      this.activeTts = 0
      this.applyBgmGain()
    }
  }

  // ---------- BGM（接口预留，M2 不接入） ----------

  /** BGM 总线已在图里，ducking 对它生效；音源接入等 BGM 里程碑再做 */
  startBgm(_filePath: string, volume: number): void {
    this.bgmBaseVolume = volume
  }

  stopBgm(): void {}

  setBgmVolume(volume: number): void {
    this.bgmBaseVolume = volume
    this.applyBgmGain()
  }

  // ---------- ducking / 静音 ----------

  setDucking(enabled: boolean, depthDb: number): void {
    this.duckingEnabled = enabled
    this.duckingDepthDb = depthDb
    this.applyBgmGain()
  }

  /** BGM 最终增益 = 基础音量 × ducking 系数 × AI 静音开关 */
  private applyBgmGain(): void {
    if (!this.bgmGain || !this.ctx) return
    let target = this.aiMuted ? 0 : this.bgmBaseVolume
    if (target > 0 && this.duckingEnabled && this.activeTts > 0) {
      target *= 10 ** (-this.duckingDepthDb / 20)
    }
    this.bgmGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15)
  }

  setAiMuted(muted: boolean): void {
    this.aiMuted = muted
    this.applyMute()
  }

  get muted(): boolean {
    return this.aiMuted
  }

  /** AI 静音只闷 TTS + BGM 总线，麦克风人声不受影响（mic 总线后续里程碑接入） */
  private applyMute(): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.ttsGain?.gain.setTargetAtTime(this.aiMuted ? 0 : 1, t, 0.05)
    this.bgmGain?.gain.setTargetAtTime(this.aiMuted ? 0 : 1, t, 0.05)
  }

  /** 紧急停止：立即停掉所有 AI 播报（BGM 保留，推流不断） */
  panic(): void {
    this.stopCurrentTts()
    this.setAiMuted(false)
  }

  // ---------- 电平 ----------

  private startLevelLoop(): void {
    if (this.levelsTimer || !this.analyser) return
    const buf = new Float32Array(this.analyser.fftSize)
    this.levelsTimer = setInterval(() => {
      this.analyser!.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.min(1, Math.sqrt(sum / buf.length) * 2.5)
      this.events?.onLevels({ tts: this.activeTts > 0 ? rms : 0, master: rms })
    }, LEVEL_INTERVAL_MS)
  }
}

export const audioEngine = new AudioEngine()
