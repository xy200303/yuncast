import { app } from 'electron'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

export const PipeEventType = {
  Connected: 0,
  Broken: 1,
  Disconnected: 2,
  Message: 3,
  ConnectionReset: 4,
  Packet: 5
} as const

type PipeEventCallback = (eventType: number, messageId: number, data: string) => void

interface PipeNativeBinding {
  start(dllPath: string, pipeName: string, maxChannels: number, callback: PipeEventCallback): string
  sendMessage(messageId: number, payload: string): boolean
  isConnected(): boolean
  stop(): void
}

let binding: PipeNativeBinding | null = null

function resolveAddonPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'pipe-sdk', 'pipe_sdk.node')
  return resolve(app.getAppPath(), 'native/pipe-sdk/build/Release/pipe_sdk.node')
}

export function resolvePipeSdkDllPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'pipe-sdk', 'PipeSDK.dll')
  return resolve(app.getAppPath(), 'native/pipe-sdk/sdk/bin/x64/PipeSDK.dll')
}

export function loadPipeNativeBinding(): PipeNativeBinding {
  if (process.platform !== 'win32') {
    throw new Error('抖音直播伴侣 PipeSDK 仅支持 Windows')
  }
  if (binding) return binding
  const require = createRequire(__filename)
  binding = require(resolveAddonPath()) as PipeNativeBinding
  return binding
}
