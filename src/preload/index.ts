import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AppConfig,
  AppInfo,
  PartialDeep,
  PoolResult,
  PoolSayInput,
  PoolSnapshot,
  PoolStatus,
  SpeechItem,
  SpeechLane
} from '../shared/types'

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
    set: (patch: PartialDeep<AppConfig>) =>
      ipcRenderer.invoke(IPC.configSet, patch) as Promise<AppConfig>
  },
  pool: {
    say: (input: PoolSayInput) => ipcRenderer.invoke(IPC.poolSay, input) as Promise<PoolResult<SpeechItem>>,
    insertNext: (input: Omit<PoolSayInput, 'lane'>) =>
      ipcRenderer.invoke(IPC.poolInsertNext, input) as Promise<PoolResult<SpeechItem>>,
    revise: (id: string, text: string) =>
      ipcRenderer.invoke(IPC.poolRevise, id, text) as Promise<PoolResult<SpeechItem>>,
    revoke: (id: string) => ipcRenderer.invoke(IPC.poolRevoke, id) as Promise<PoolResult>,
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.poolReorder, ids) as Promise<PoolResult>,
    clearLane: (lane: SpeechLane) => ipcRenderer.invoke(IPC.poolClearLane, lane) as Promise<PoolResult>,
    status: () => ipcRenderer.invoke(IPC.poolStatus) as Promise<PoolStatus>,
    recentPlayed: (n: number) => ipcRenderer.invoke(IPC.poolRecentPlayed, n) as Promise<SpeechItem[]>,
    /** 取第一个 ready 条目开始播放（主进程置 playing），无则 null */
    next: () => ipcRenderer.invoke(IPC.poolNext) as Promise<SpeechItem | null>,
    markDone: (id: string) => ipcRenderer.invoke(IPC.poolMarkDone, id) as Promise<void>,
    snapshot: () => ipcRenderer.invoke(IPC.poolSnapshot) as Promise<PoolSnapshot>,
    /** 订阅池快照广播，返回取消订阅函数 */
    onSnapshot: (cb: (snapshot: PoolSnapshot) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, snapshot: PoolSnapshot) => cb(snapshot)
      ipcRenderer.on(IPC.poolSnapshotEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.poolSnapshotEvent, listener)
      }
    }
  },
  tts: {
    test: (text: string) =>
      ipcRenderer.invoke(IPC.ttsTest, text) as Promise<{ ok: boolean; error?: string; audioPath?: string }>
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
