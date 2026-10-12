/**
 * 渲染层音频终端（哑终端：只做出声与采集，编排全在主进程）。
 *
 * 主进程 AudioPipeline 是唯一音频权威：解码 / 调度 / 混音 / BGM / ducking / 音量都在那边判定，
 * 按 50ms 一片把 PCM 推过来（IPC audio:pcm）。这里只做三件事：
 *   1. 把收到的 PCM 排播出声 —— streamPlayer 挂在这条 tts 总线上（masterGain → analyser → 声卡）
 *   2. 本机输出增益与紧急静音（只影响你耳朵里听到的；推流那一路由主进程单独判定）
 *   3. 麦克风采集（真人接管 / 伴侣模式），说话时压低 AI 总线（自动避让）
 *
 * 不再读文件、不再建 `<audio>`、不管 BGM 与 ducking、不再自己算电平（电平由主进程推来）。
 */

export interface EngineEvents {
  /** 真人说话状态变化（自动避让：说话期间压低 AI 播报） */
  onHumanSpeaking(speaking: boolean): void
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private ttsGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private aiMuted = false
  private masterVolume = 1
  private events: EngineEvents | null = null

  // 麦克风总线
  private micStream: MediaStream | null = null
  private micGain: GainNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private micWorklet: AudioWorkletNode | null = null
  private micAutoYield = true
  private speaking = false
  private lastSpeakAt = 0
  private speechTimer: ReturnType<typeof setInterval> | null = null

  init(events: EngineEvents): void {
    this.events = events
  }

  /** 对外暴露音频图入口（PCM 排播器要挂在同一条 tts 总线上） */
  ensureContext(): AudioContext {
    return this.ensureGraph()
  }

  /** TTS 总线输入节点（主进程推来的 PCM 接这里） */
  ttsInput(): GainNode {
    this.ensureGraph()
    return this.ttsGain!
  }

  /** 输出分析节点（电平观察/自检用；出声链路的末端取样） */
  outputAnalyser(): AnalyserNode {
    this.ensureGraph()
    return this.analyser!
  }

  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = 1
    this.ttsGain = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.ttsGain.connect(this.masterGain)
    this.masterGain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
    this.applyTtsGain()
    void this.ctx.resume().catch(() => undefined)
    return this.ctx
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

    if (opts.autoYield) this.startSpeechWatch()
  }

  stopMic(): void {
    this.stopSpeechWatch()
    this.micWorklet?.disconnect()
    this.micWorklet = null
    this.micGain?.disconnect()
    this.micGain = null
    this.micAnalyser = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    if (this.speaking) {
      this.speaking = false
      this.applyTtsGain()
      this.events?.onHumanSpeaking(false)
    }
  }

  get micActive(): boolean {
    return this.micStream !== null
  }

  private startSpeechWatch(): void {
    if (this.speechTimer) return
    this.speechTimer = setInterval(() => this.detectSpeech(), 150)
  }

  private stopSpeechWatch(): void {
    if (this.speechTimer) clearInterval(this.speechTimer)
    this.speechTimer = null
  }

  /** 麦克风 RMS 检测：说话→压低 AI 总线并通知调度器，停嘴 800ms 恢复 */
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
        this.applyTtsGain()
        this.events?.onHumanSpeaking(true)
      }
    } else if (this.speaking && Date.now() - this.lastSpeakAt > 800) {
      this.speaking = false
      this.applyTtsGain()
      this.events?.onHumanSpeaking(false)
    }
  }

  // ---------- 音量 / 静音 ----------

  /** 主音量（本机监听）：只是把值交给主进程 AudioPipeline，它在推 PCM 时按这个增益走 */
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume))
    void window.api.audio.setMasterVolume(this.masterVolume)
  }

  get volume(): number {
    return this.masterVolume
  }

  /**
   * 紧急静音：本地立刻把 AI 总线压零（不等 IPC），同时告诉主进程
   * （推流那一路与电平显示也跟着静）。麦克风人声不受影响。
   */
  setAiMuted(muted: boolean): void {
    this.aiMuted = muted
    this.applyTtsGain()
    void window.api.audio.setMuted(muted)
  }

  get muted(): boolean {
    return this.aiMuted
  }

  /** 停掉当前 AI 播报（跳过这条 / 紧急停止）：解码与排播都在主进程，这里只管本地已排的队列 */
  stopCurrent(): void {
    void window.api.audio.stopAll()
  }

  /** AI 总线增益 = 静音 或 真人在说话 → 0 */
  private applyTtsGain(): void {
    if (!this.ttsGain || !this.ctx) return
    const target = this.aiMuted || this.speaking ? 0 : 1
    this.ttsGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05)
  }
}

export const audioEngine = new AudioEngine()

// 开发期把引擎挂到 window 上，便于本机自检（CDP 脚本测 audioEngine 图内的 RMS），打包版不挂
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>)['__audioEngine'] = audioEngine
}
