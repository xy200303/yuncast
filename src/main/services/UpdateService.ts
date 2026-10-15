import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../../shared/ipc-channels'
import type { UpdateStatus } from '../../shared/types'

const GITHUB_REPO = { provider: 'github' as const, owner: 'xy200303', repo: 'yuncast' }

/**
 * 应用更新（设置 → 关于）：走 GitHub Releases 的 latest*.yml。
 * 手动触发：检查 → 下载 → 安装重启，状态全程广播给渲染层。
 * 未打包（dev）环境下不可检查更新。
 */
export class UpdateService {
  private status: UpdateStatus = { state: 'idle' }

  init(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.setFeedURL(GITHUB_REPO)

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.set({ state: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available' }))
    autoUpdater.on('download-progress', (p) =>
      this.set({ state: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (err) =>
      this.set({ state: 'error', message: friendlyError(err) })
    )
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'error', message: '开发环境不走更新通道，请以打包版为准' })
      return this.status
    }
    try {
      this.set({ state: 'checking' })
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // error 事件已广播；这里兜底一份返回值
      if (this.status.state !== 'error') {
        this.set({ state: 'error', message: friendlyError(err) })
      }
    }
    return this.status
  }

  async download(): Promise<void> {
    if (!app.isPackaged) return
    await autoUpdater.downloadUpdate()
  }

  /** 立即重启安装（Windows/macOS 有效；Linux AppImage 由 electron-updater 处理） */
  install(): void {
    autoUpdater.quitAndInstall()
  }

  private set(next: UpdateStatus): void {
    this.status = { ...this.status, ...next }
    if (next.state !== 'downloading') this.status.percent = undefined
    if (next.state === 'checking') {
      this.status.version = undefined
      this.status.message = undefined
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.updateStatusEvent, this.status)
    }
  }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/net|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|403|404/i.test(msg)) {
    return '网络不佳或 Release 尚未发布，稍后再试'
  }
  return msg.slice(0, 200)
}
