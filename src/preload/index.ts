import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AppConfig, AppInfo } from '../shared/types'

/**
 * 渲染进程唯一可见的 API 白名单。
 * 不暴露 ipcRenderer 本体，不暴露任何文件/进程能力。
 */
const api = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet) as Promise<AppConfig>,
    set: (patch: Partial<AppConfig>) =>
      ipcRenderer.invoke(IPC.configSet, patch) as Promise<AppConfig>
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
