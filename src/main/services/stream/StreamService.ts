import {
  INITIAL_STREAM_STATS,
  type StreamStats,
  type StreamState
} from '../../../shared/types'
import type { StorageService } from '../StorageService'
import { FFmpegPusher } from './ffmpeg/pusher'
import { audioMixer } from './ffmpeg/mixer'
import { getDouyinLaunchContext } from '../comment/launchContext'

/**
 * 推流编排服务（搬迁自旧版 streamService）。
 * 直推模式：FFmpeg 静态帧 + PCM 混音（tts/bgm/mic 三路）→ RTMP；
 * 伴侣模式：不推流只出声，画面和采集由直播伴侣负责（伴侣启动参数优先于配置）。
 */

const STATS_INTERVAL_MS = 1000
const MAX_RECONNECT = 5
const RECONNECT_BASE_DELAY_MS = 2000

export class StreamService {
  private pusher = new FFmpegPusher()
  private stats: StreamStats = { ...INITIAL_STREAM_STATS }
  private statsTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private stopping = false
  private liveStartedAt = 0

  constructor(
    private readonly storage: StorageService,
    private readonly onStats: (stats: StreamStats) => void
  ) {}

  getStats(): StreamStats {
    return { ...this.stats }
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.stats.state === 'live' || this.stats.state === 'starting') return { ok: true }

    const config = this.storage.getConfig()
    // 被直播伴侣带着启动参数拉起来时强制伴侣模式
    const launchedByCompanion = getDouyinLaunchContext()?.mode === 'pipe'
    const mode = launchedByCompanion ? 'companion' : config.stream.mode
    if (mode === 'direct' && (!config.stream.serverUrl || !config.stream.streamKey)) {
      this.patch({ state: 'error', error: '推流地址或密钥为空：请先在「设置 → 接入 → 推流」中填写' })
      return { ok: false, error: this.stats.error }
    }

    this.stopping = false
    this.patch({ state: 'starting', mode, error: undefined })
    try {
      if (mode === 'direct') {
        await this.pusher.start(
          { serverUrl: config.stream.serverUrl, streamKey: config.stream.streamKey },
          {
            onExit: (code) => this.handlePushExit(code),
            onStats: (s) => this.patch({ bitrateKbps: s.bitrateKbps })
          }
        )
      }
      // 伴侣模式：无进程要起，AI 声音经系统声音由伴侣采集
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentAnchor] 开播失败:', message)
      this.patch({ state: 'error', error: message })
      return { ok: false, error: message }
    }

    this.reconnectAttempt = 0
    this.liveStartedAt = Date.now()
    this.patch({ state: 'live', streaming: true })
    this.startStatsLoop()
    console.error(`[AgentAnchor] 直播已开始（${mode === 'direct' ? 'FFmpeg 直推' : '伴侣模式'}）`)
    return { ok: true }
  }

  async stop(): Promise<void> {
    if (this.stats.state !== 'live' && this.stats.state !== 'starting' && this.stats.state !== 'error') return
    this.stopping = true
    this.clearTimers()
    this.patch({ state: 'stopping' })
    try {
      if (this.stats.mode === 'direct') await this.pusher.stop()
    } catch (err) {
      console.error('[AgentAnchor] 停止推流时出错（忽略）:', err)
    }
    this.patch({ state: 'idle', streaming: false, reconnecting: false, bitrateKbps: 0, durationSec: 0 })
  }

  /** 直推模式：合成完成的 TTS 音频送入混音器进流（没在推流时丢弃） */
  async pushTts(filePath: string): Promise<void> {
    if (this.stats.state !== 'live' || this.stats.mode !== 'direct') return
    await audioMixer.pushTts(filePath)
  }

  async setBgm(action: 'start' | 'stop' | 'volume', filePath?: string, volume?: number): Promise<void> {
    await audioMixer.setBgm(action, filePath, volume)
  }

  /** 真人麦克风 PCM 帧（渲染进程 AudioWorklet 转发） */
  pushMicPcm(pcm: Uint8Array): void {
    audioMixer.pushMicPcm(Buffer.from(pcm))
  }

  // ---------- 内部 ----------

  private patch(patch: Partial<StreamStats>): void {
    this.stats = { ...this.stats, ...patch }
    this.onStats(this.getStats())
  }

  private startStatsLoop(): void {
    this.clearTimers()
    this.statsTimer = setInterval(() => {
      const durationSec = Math.floor((Date.now() - this.liveStartedAt) / 1000)
      this.patch({ durationSec, streaming: this.stats.mode === 'companion' ? true : this.pusher.running || this.stats.reconnecting })
    }, STATS_INTERVAL_MS)
  }

  private clearTimers(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.statsTimer = null
    this.reconnectTimer = null
  }

  /** FFmpeg 进程异常退出：指数退避自动重推 */
  private handlePushExit(code: number | null): void {
    if (this.stopping || code === 0) return
    if (this.stats.state !== 'live') return
    if (this.reconnectAttempt >= MAX_RECONNECT) {
      this.patch({ streaming: false, reconnecting: false, state: 'error', error: `断流重推 ${MAX_RECONNECT} 次仍失败` })
      console.error('[AgentAnchor] 断流重推失败。FFmpeg 输出：', this.pusher.getStderrTail().slice(-300))
      return
    }
    this.reconnectAttempt += 1
    const delay = RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1)
    this.patch({ streaming: false, reconnecting: true, reconnectAttempt: this.reconnectAttempt })
    console.error(`[AgentAnchor] 推流进程退出(code=${code})，${delay / 1000}s 后第 ${this.reconnectAttempt} 次重推`)
    this.reconnectTimer = setTimeout(() => {
      const config = this.storage.getConfig()
      this.pusher
        .start(
          { serverUrl: config.stream.serverUrl, streamKey: config.stream.streamKey },
          {
            onExit: (c) => this.handlePushExit(c),
            onStats: (s) => this.patch({ bitrateKbps: s.bitrateKbps })
          }
        )
        .catch((err) => {
          console.error('[AgentAnchor] 断流重推失败:', err)
          this.handlePushExit(1)
        })
    }, delay)
  }
}
