/**
 * WebAudio 混音引擎（渲染进程单例，M7 补齐自旧版 desktop/src/renderer/src/audio/engine.ts）。
 * 拓扑：
 *   tts 元素 → ttsGain ┐
 *   bgm 元素 → bgmGain ┼→ masterGain → analyser → destination
 *   mic 流   → micGain ┘
 * ducking：tts 播放或真人说话期间 bgmGain 自动下压（Gain 自动化，无延迟抖动）。
 * AI 音频整体经系统输出（伴侣模式由直播伴侣采集）；直推模式的 PCM 混音在主进程 AudioMixer。
 */

export interface EngineEvents {
  onLevels(levels: { tts: number; master: number }): void
  /** 真人说话状态变化（自动避让：压低 AI 播报） */
  onHumanSpeaking(speaking: boolean): void
}

const LEVEL_INTERVAL_MS = 150

/** audio-cache 里的合成音频走 media:// 自定义协议（dev 下页面是 http://，不能直接 file://） */
export function toCacheMediaUrl(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()!
  return `media:///${encodeURIComponent(name)}`
}

/** BGM 走 media://local/（主进程校验只允许 config.bgm.path 那个文件） */
function toLocalMediaUrl(filePath: string): string {
  return `media://local/${encodeURIComponent(filePath)}`
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private ttsGain: GainNode | null = null
  private bgmGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private ttsEl: HTMLAudioElement | null = null
  private bgmEl: HTMLAudioElement | null = null
  private bgmUrl = ''

  private duckingEnabled = true
  private duckingDepthDb = 14
  private aiMuted = false
  private activeTts = 0
  private bgmBaseVolume = 0.3
  private masterVolume = 1
  private levelsTimer: ReturnType<typeof setInterval> | null = null
  private events: EngineEvents | null = null

  // 麦克风总线
  private micStream: MediaStream | null = null
  private micGain: GainNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private micWorklet: AudioWorkletNode | null = null
  private micAutoYield = true
  private speaking = false
  private lastSpeakAt = 0

  init(events: EngineEvents): void {
    this.events = events
  }

  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this.masterVolume
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

  // ---------- BGM ----------

  startBgm(filePath: string, volume: number): void {
    const ctx = this.ensureGraph()
    void ctx.resume()
    const url = toLocalMediaUrl(filePath)
    if (this.bgmEl && this.bgmUrl === url) {
      this.setBgmVolume(volume)
      return
    }
    this.stopBgm()
    const el = new Audio(url)
    el.loop = true
    const src = ctx.createMediaElementSource(el)
    src.connect(this.bgmGain!)
    this.bgmEl = el
    this.bgmUrl = url
    this.setBgmVolume(volume)
    void el.play().catch(() => undefined)
  }

  stopBgm(): void {
    this.bgmEl?.pause()
    this.bgmEl = null
    this.bgmUrl = ''
  }

  get bgmPlaying(): boolean {
    return this.bgmEl !== null
  }

  setBgmVolume(volume: number): void {
    this.bgmBaseVolume = volume
    this.applyBgmGain()
  }

  // ---------- 麦克风总线（真人接管说话） ----------

  /**
   * 接入真人麦克风：人声进 master 总线（本地监听/伴侣采集），
   * forwardPcm=true 时同时把 PCM 帧转发给主进程混音器（FFmpeg 直推）。
   */
  async startMic(deviceId: string, opts: { autoYield: boolean; forwardPcm: boolean }): Promise<void> {
    this.stopMic()
    this.micAutoYield = opts.autoYield
    const ctx = this.ensureGraph()
    void ctx.resume()
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const src = ctx.createMediaStreamSource(this.micStream)
    this.micGain = ctx.createGain()
    src.connect(this.micGain)
    this.micGain.connect(this.masterGain!)
    this.micAnalyser = ctx.createAnalyser()
    this.micAnalyser.fftSize = 256
    src.connect(this.micAnalyser)

    if (opts.forwardPcm) {
      await ctx.audioWorklet.addModule('/mic-processor.js')
      this.micWorklet = new AudioWorkletNode(ctx, 'mic-processor')
      src.connect(this.micWorklet)
      this.micWorklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        window.api.stream.pushMicPcm(new Uint8Array(e.data))
      }
    }
  }

  stopMic(): void {
    this.micWorklet?.disconnect()
    this.micWorklet = null
    this.micGain?.disconnect()
    this.micGain = null
    this.micAnalyser = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    if (this.speaking) {
      this.speaking = false
      this.events?.onHumanSpeaking(false)
    }
  }

  get micActive(): boolean {
    return this.micStream !== null
  }

  /** 麦克风 RMS 检测：说话→压 TTS 并通知调度器暂停，停嘴 800ms 恢复 */
  private detectSpeech(): void {
    if (!this.micAnalyser || !this.micAutoYield) return
    const buf = new Float32Array(this.micAnalyser.fftSize)
    this.micAnalyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)

    if (rms > 0.02) {
      this.lastSpeakAt = Date.now()
      if (!this.speaking) {
        this.speaking = true
        this.applySpeechDuck()
        this.events?.onHumanSpeaking(true)
      }
    } else if (this.speaking && Date.now() - this.lastSpeakAt > 800) {
      this.speaking = false
      this.applySpeechDuck()
      this.events?.onHumanSpeaking(false)
    }
  }

  /** 说话时把 TTS 总线静音（双保险，主进程混音器同样压 BGM） */
  private applySpeechDuck(): void {
    if (!this.ttsGain || !this.ctx || !this.micAutoYield) return
    this.ttsGain.gain.setTargetAtTime(this.speaking ? 0 : 1, this.ctx.currentTime, 0.1)
  }

  // ---------- ducking / 静音 / 主音量 ----------

  setDucking(enabled: boolean, depthDb: number): void {
    this.duckingEnabled = enabled
    this.duckingDepthDb = depthDb
    this.applyBgmGain()
  }

  /** BGM 最终增益 = 基础音量 × ducking 系数 × AI 静音开关 */
  private applyBgmGain(): void {
    if (!this.bgmGain || !this.ctx) return
    let target = this.aiMuted ? 0 : this.bgmBaseVolume
    const talking = this.activeTts > 0 || this.speaking
    if (target > 0 && this.duckingEnabled && talking) {
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

  /** 主音量（全部总线） */
  setMasterVolume(volume: number): void {
    this.masterVolume = volume
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.aiMuted ? 0 : volume, this.ctx.currentTime, 0.05)
    }
  }

  /** AI 静音只闷 TTS + BGM 总线，麦克风人声不受影响 */
  private applyMute(): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.ttsGain?.gain.setTargetAtTime(this.aiMuted ? 0 : 1, t, 0.05)
    this.applyBgmGain()
    this.masterGain?.gain.setTargetAtTime(this.aiMuted ? 0 : this.masterVolume, t, 0.05)
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
      this.detectSpeech()
    }, LEVEL_INTERVAL_MS)
  }
}

export const audioEngine = new AudioEngine()
