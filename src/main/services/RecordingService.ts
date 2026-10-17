import { app, BrowserWindow, type WebContents } from 'electron'
import { appendFileSync, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { RecordingState } from '../../shared/types'
import { IPC } from '../../shared/ipc-channels'
import { getFfmpegPath } from './stream/ffmpeg/bin'

/**
 * 通用录屏服务（主进程侧状态机 + 落盘）：
 * 录制本体在渲染进程（getDisplayMedia + MediaRecorder，整屏 + 系统回放声），
 * 主进程负责：发起/停止命令、授权闸门（armed 时 display-media 请求才放行）、分块写文件。
 *
 * 安全边界：只有本服务发起的录制会话会 armed，渲染层其它 getDisplayMedia 请求一律拒绝；
 * 正式包同样走这道闸门（录屏是正式功能，不是 demo 专用）。
 *
 * mp4 说明：Chromium 的 mp4 封装有时间戳毛病（音频 dts 大量重复、样本边界错位），
 * 所以停止后自动用 ffmpeg 重封装一次（-c copy，不重编码，秒级），出来的成品干净。
 */

/** 文件名清洗：只去掉 Windows/macOS 路径非法字符，中文原样保留 */
function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = (name?.trim() || fallback).replace(/[<>:"/\|?*\x00-\x1f]+/g, '_')
  return cleaned || fallback
}

/** mp4 重封装：修 Chromium 封装的 dts/边界问题；失败则保留原文件（内容照样能播） */
function remuxMp4(file: string): Promise<void> {
  return new Promise((resolve) => {
    const tmp = `${file}.remux.mp4`
    execFile(
      getFfmpegPath(),
      ['-v', 'error', '-i', file, '-c', 'copy', '-fflags', '+genpts', '-movflags', '+faststart', '-y', tmp],
      { timeout: 120_000 },
      (error) => {
        if (error) {
          rmSync(tmp, { force: true })
          resolve()
          return
        }
        try {
          copyFileSync(tmp, file)
          rmSync(tmp, { force: true })
        } catch {
          rmSync(tmp, { force: true })
        }
        resolve()
      }
    )
  })
}
export class RecordingService {
  private recording = false
  private armed = false
  private file: string | null = null
  private startedAt = 0
  private showCursor = true
  /** 等待渲染层握手/收尾的 resolver */
  private waitReady: ((ok: boolean, error?: string) => void) | null = null
  private waitDone: (() => void) | null = null
  private getContents: () => WebContents | null = () => null

  /** 录屏状态变化广播（UI 红点）与事件流（SSE record.start/record.stop） */
  onStateChange?: (state: RecordingState) => void
  onEvent?: (type: 'record.start' | 'record.stop', payload: Record<string, unknown>) => void

  /** 主窗口 webContents 提供者（录制命令往这儿发） */
  bindContents(get: () => WebContents | null): void {
    this.getContents = get
  }

  /** display-media 请求闸门：只有录制会话激活期才放行 */
  get isArmed(): boolean {
    return this.armed
  }

  state(): RecordingState {
    return {
      recording: this.recording,
      startedAt: this.startedAt || undefined,
      file: this.file ?? undefined,
      showCursor: this.showCursor
    }
  }

  async start(name?: string, showCursor = true): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
    if (this.recording) return { ok: false, error: '已经在录制中，先停止当前录制' }
    const contents = this.getContents()
    if (!contents || contents.isDestroyed()) return { ok: false, error: '主窗口不在，没法录（渲染进程是录制本体）' }

    // 只采本应用窗口（WGC）：遮挡/其它窗口/用户真实鼠标都不进画面，不用抢焦点。
    // 但最小化的窗口不出帧，所以最小化时先还原（不抢焦点）
    const win = BrowserWindow.fromWebContents(contents)
    if (win && !win.isDestroyed() && win.isMinimized()) win.restore()

    const stamp = new Date()
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const safe = safeFileName(name, 'screen')
    const dir = join(app.getPath('userData'), 'recordings')
    mkdirSync(dir, { recursive: true })
    const file = join(
      dir,
      // 扩展名先按默认容器 mp4 起；渲染层回退到 webm 时会在 ready 握手里上报，届时改名
      `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${safe}.mp4`
    )
    writeFileSync(file, '')

    const ready = new Promise<boolean>((resolve, reject) => {
      this.waitReady = (ok, error) => (ok ? resolve(true) : reject(new Error(error ?? '录制启动失败')))
      setTimeout(() => {
        if (this.waitReady) {
          this.waitReady = null
          reject(new Error('渲染层没回应（10 秒超时）：窗口可能在忙，重试一次'))
        }
      }, 10_000)
    })

    this.armed = true
    this.file = file
    this.showCursor = showCursor
    contents.send(IPC.recordCmdEvent, { action: 'start', showCursor })
    try {
      await ready
    } catch (error) {
      this.armed = false
      this.file = null
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.recording = true
    this.startedAt = Date.now()
    const state = this.state()
    this.onStateChange?.(state)
    this.onEvent?.('record.start', { file })
    return { ok: true, file }
  }

  async stop(): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
    if (!this.recording) return { ok: false, error: '当前没在录制' }
    const contents = this.getContents()
    const file = this.file
    const done = new Promise<void>((resolve) => {
      this.waitDone = resolve
      setTimeout(() => {
        if (this.waitDone) {
          this.waitDone = null
          resolve()
        }
      }, 5_000)
    })
    contents?.send(IPC.recordCmdEvent, { action: 'stop' })
    await done
    this.recording = false
    this.armed = false
    this.file = null
    // mp4 成品先过一道 ffmpeg 重封装：Chromium 封装的 dts/样本边界有毛病，remux 后才算干净成品
    if (file && file.endsWith('.mp4')) await remuxMp4(file)
    const state = this.state()
    this.onStateChange?.(state)
    this.onEvent?.('record.stop', { file, durationMs: Date.now() - this.startedAt })
    this.startedAt = 0
    return file ? { ok: true, file } : { ok: false, error: '录制文件丢失（渲染进程异常）' }
  }

  /** 应用窗口截图：capturePage 直取渲染画面（高分屏全分辨率，不受遮挡影响），PNG 落 userData/screenshots */
  async captureScreenshot(name?: string): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
    const contents = this.getContents()
    if (!contents || contents.isDestroyed()) return { ok: false, error: '主窗口不在，没法截图' }
    try {
      const image = await contents.capturePage()
      if (image.isEmpty()) return { ok: false, error: '截图失败：拿到的是空画面' }
      const stamp = new Date()
      const pad = (n: number, w = 2) => String(n).padStart(w, '0')
      const safe = safeFileName(name, 'screen')
      const dir = join(app.getPath('userData'), 'screenshots')
      mkdirSync(dir, { recursive: true })
      const file = join(
        dir,
        `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${safe}.png`
      )
      writeFileSync(file, image.toPNG())
      return { ok: true, file }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ---------- 渲染层回调（IPC handlers 里调） ----------

  appendChunk(base64: string): boolean {
    if (!this.file) return false
    appendFileSync(this.file, Buffer.from(String(base64 ?? ''), 'base64'))
    return true
  }

  /** 渲染层确认采集已开始；container 是实际容器格式（mp4/webm），与文件扩展名不一致时改名对齐 */
  notifyReady(container?: string): void {
    if (container && this.file && !this.file.endsWith(`.${container}`)) {
      const renamed = this.file.replace(/\.\w+$/, `.${container}`)
      try {
        renameSync(this.file, renamed)
        this.file = renamed
      } catch {
        // 改名失败不致命：内容照样能播，只是扩展名不符
      }
    }
    this.waitReady?.(true)
    this.waitReady = null
  }

  /** 渲染层启动失败（用户拒绝/无权限/编码器不支持） */
  notifyFailed(error: string): void {
    this.waitReady?.(false, error)
    this.waitReady = null
  }

  /** 渲染层确认收尾完成（最后一个分块已落盘） */
  notifyDone(): void {
    this.waitDone?.()
    this.waitDone = null
  }
}
