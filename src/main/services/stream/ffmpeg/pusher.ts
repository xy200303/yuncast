import { spawn, type ChildProcess } from 'node:child_process'
import { getFfmpegPath } from './bin'
import { audioMixer } from './mixer'
const log = console

/**
 * FFmpeg 纯音频推流进程：静态封面帧 + AI 混音 PCM → RTMP。
 * 视频为 720p15 静态帧（CPU 开销可忽略），系统职责聚焦声音。
 * 统计从 stderr 的 progress 行解析；进程异常退出由上层负责重推。
 */

const VIDEO_BITRATE = '800k'

export interface PusherStats {
  bitrateKbps: number
  fps: number
}

export class FFmpegPusher {
  private proc: ChildProcess | null = null
  private onExit: ((code: number | null) => void) | null = null
  private onStats: ((s: PusherStats) => void) | null = null
  private stderrTail = ''

  get running(): boolean {
    return this.proc !== null
  }

  async start(
    cfg: { serverUrl: string; streamKey: string },
    hooks: { onExit: (code: number | null) => void; onStats: (s: PusherStats) => void }
  ): Promise<void> {
    if (this.proc) return
    this.onExit = hooks.onExit
    this.onStats = hooks.onStats

    const args = this.buildArgs(cfg)
    log.info('启动 FFmpeg 推流:', args.join(' '))

    this.proc = spawn(getFfmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] })
    audioMixer.attach(this.proc.stdin!)

    this.proc.stderr!.on('data', (chunk: Buffer) => this.parseStderr(chunk.toString()))
    this.proc.on('error', (err) => {
      log.error('FFmpeg 进程错误:', err)
      this.cleanup()
      this.onExit?.(1)
    })
    this.proc.on('close', (code) => {
      log.warn(`FFmpeg 进程退出 code=${code}`)
      this.cleanup()
      this.onExit?.(code)
    })
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    audioMixer.detach()
    proc.stdin?.end()
    const killer = setTimeout(() => proc.kill('SIGKILL'), 3000)
    proc.on('close', () => clearTimeout(killer))
  }

  private cleanup(): void {
    this.proc = null
    audioMixer.detach()
  }

  private buildArgs(cfg: { serverUrl: string; streamKey: string }): string[] {
    return [
      '-y', '-hide_banner', '-loglevel', 'info',
      // 视频：静态帧（后续可换封面图）
      '-f', 'lavfi', '-i', 'color=c=0x141311:s=1280x720:r=15',
      // 音频：AI 混音 PCM
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
      '-b:v', VIDEO_BITRATE, '-g', '60', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-f', 'flv',
      `${cfg.serverUrl.replace(/\/$/, '')}/${cfg.streamKey}`
    ]
  }

  private parseStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-2000)
    const m = text.match(/frame=\s*\d+\s+fps=\s*([\d.]+)[\s\S]*?bitrate=\s*([\d.]+)kbits\/s/)
    if (m) {
      this.onStats?.({ fps: Number(m[1]), bitrateKbps: Math.round(Number(m[2])) })
    }
  }

  getStderrTail(): string {
    return this.stderrTail
  }
}
