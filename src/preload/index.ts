import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentStatus,
  AppConfig,
  AppInfo,
  ConnectorStatus,
  EpisodeSummary,
  KnowledgeFile,
  LiveComment,
  LiveEvent,
  LivePlan,
  LivePlanInput,
  PartialDeep,
  Persona,
  PoolResult,
  PoolSayInput,
  PoolSnapshot,
  PoolStatus,
  Product,
  ProductInput,
  Script,
  ScriptInput,
  SpeechItem,
  SpeechLane,
  VoiceRecord,
  StreamStats,
  Trigger,
  TriggerInput,
  ViewerProfile
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
  },
  agent: {
    start: () => ipcRenderer.invoke(IPC.agentStart) as Promise<{ ok: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke(IPC.agentStop) as Promise<void>,
    restart: () => ipcRenderer.invoke(IPC.agentRestart) as Promise<{ ok: boolean; error?: string }>,
    status: () => ipcRenderer.invoke(IPC.agentStatus) as Promise<AgentStatus>,
    /** 订阅 Agent 状态 + 生成中预览，返回取消订阅函数 */
    onStatus: (cb: (status: AgentStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: AgentStatus) => cb(status)
      ipcRenderer.on(IPC.agentStatusEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.agentStatusEvent, listener)
      }
    }
  },
  persona: {
    get: () => ipcRenderer.invoke(IPC.personaGet) as Promise<Persona>,
    list: () => ipcRenderer.invoke(IPC.personaList) as Promise<Persona[]>,
    save: (input: Omit<Persona, 'id' | 'updatedAt'>, id?: string) =>
      ipcRenderer.invoke(IPC.personaSave, input, id) as Promise<Persona>,
    setActive: (id: string) => ipcRenderer.invoke(IPC.personaSetActive, id) as Promise<Persona | null>,
    remove: (id: string) => ipcRenderer.invoke(IPC.personaRemove, id) as Promise<void>
  },
  ttsStream: {
    start: (sessionId: string, text: string, voiceId?: string) =>
      ipcRenderer.invoke(IPC.ttsStreamStart, sessionId, text, voiceId) as Promise<{ ok: boolean }>,
    stop: (sessionId: string) =>
      ipcRenderer.invoke(IPC.ttsStreamStop, sessionId) as Promise<{ ok: boolean }>,
    /** 订阅 PCM 块与结束事件，返回取消订阅函数 */
    onChunk: (cb: (payload: { sessionId: string; pcm: Uint8Array; sampleRate: number }) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { sessionId: string; pcm: Uint8Array; sampleRate: number }
      ) => cb(payload)
      ipcRenderer.on(IPC.ttsStreamChunk, listener)
      return () => ipcRenderer.removeListener(IPC.ttsStreamChunk, listener)
    },
    onEnd: (cb: (payload: { sessionId: string; error?: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { sessionId: string; error?: string }) =>
        cb(payload)
      ipcRenderer.on(IPC.ttsStreamEnd, listener)
      return () => ipcRenderer.removeListener(IPC.ttsStreamEnd, listener)
    }
  },
  voice: {
    list: () => ipcRenderer.invoke(IPC.voiceList) as Promise<VoiceRecord[]>,
    clone: (input: { name: string; samplePath: string; authorized: boolean }) =>
      ipcRenderer.invoke(IPC.voiceClone, input) as Promise<{ ok: boolean; error?: string }>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.voiceRemove, id) as Promise<{ ok: boolean; error?: string }>,
    setDefault: (id: string) =>
      ipcRenderer.invoke(IPC.voiceSetDefault, id) as Promise<{ ok: boolean; error?: string }>,
    uploadSample: (bytes: Uint8Array, ext: string) =>
      ipcRenderer.invoke(IPC.voiceUploadSample, bytes, ext) as Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >,
    /** 音色列表变化（训练完成/失败等），返回取消订阅函数 */
    onChanged: (cb: (voices: VoiceRecord[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, voices: VoiceRecord[]) => cb(voices)
      ipcRenderer.on(IPC.voiceChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.voiceChanged, listener)
      }
    }
  },
  comment: {
    /** 订阅评论事件（来自连接器），返回取消订阅函数 */
    onComment: (cb: (comment: LiveComment) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, comment: LiveComment) => cb(comment)
      ipcRenderer.on(IPC.commentEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.commentEvent, listener)
      }
    }
  },
  knowledge: {
    listProducts: () => ipcRenderer.invoke(IPC.knowledgeProductList) as Promise<Product[]>,
    saveProduct: (input: ProductInput, id?: string) =>
      ipcRenderer.invoke(IPC.knowledgeProductSave, input, id) as Promise<PoolResult<Product>>,
    deleteProduct: (id: string) => ipcRenderer.invoke(IPC.knowledgeProductDelete, id) as Promise<PoolResult>,
    listFiles: () => ipcRenderer.invoke(IPC.knowledgeFileList) as Promise<KnowledgeFile[]>,
    /** 上传并解析资料文件；图片需带一句话描述 */
    uploadFile: (filePath: string, description?: string) =>
      ipcRenderer.invoke(IPC.knowledgeFileUpload, filePath, description) as Promise<
        { ok: true; file: KnowledgeFile } | { ok: false; error: string }
      >,
    deleteFile: (id: string) => ipcRenderer.invoke(IPC.knowledgeFileDelete, id) as Promise<PoolResult>
  },
  memory: {
    viewers: () => ipcRenderer.invoke(IPC.memoryViewers) as Promise<ViewerProfile[]>,
    episodes: () => ipcRenderer.invoke(IPC.memoryEpisodes) as Promise<EpisodeSummary[]>
  },
  dialog: {
    /** 弹出文件选择框，取消返回 null */
    pickFile: (filtersName: string, extensions: string[]) =>
      ipcRenderer.invoke(IPC.dialogPickFile, filtersName, extensions) as Promise<string | null>
  },
  trigger: {
    list: () => ipcRenderer.invoke(IPC.triggerList) as Promise<Trigger[]>,
    save: (input: TriggerInput) => ipcRenderer.invoke(IPC.triggerSave, input) as Promise<Trigger[]>,
    remove: (id: string) => ipcRenderer.invoke(IPC.triggerDelete, id) as Promise<Trigger[]>,
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.triggerToggle, id, enabled) as Promise<Trigger[]>
  },
  event: {
    /** 最近 n 条事件（数据页时间线） */
    recent: (n: number) => ipcRenderer.invoke(IPC.eventRecent, n) as Promise<LiveEvent[]>
  },
  script: {
    list: () => ipcRenderer.invoke(IPC.scriptList) as Promise<Script[]>,
    save: (input: ScriptInput, id?: string) =>
      ipcRenderer.invoke(IPC.scriptSave, input, id) as Promise<PoolResult<Script>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.scriptDelete, id) as Promise<PoolResult>
  },
  plan: {
    list: () => ipcRenderer.invoke(IPC.planList) as Promise<LivePlan[]>,
    save: (input: LivePlanInput, id?: string) =>
      ipcRenderer.invoke(IPC.planSave, input, id) as Promise<PoolResult<LivePlan>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.planDelete, id) as Promise<PoolResult>,
    /** 设为当前场次，返回生效的 activePlanId */
    setActive: (id: string) => ipcRenderer.invoke(IPC.planSetActive, id) as Promise<string>
  },
  stream: {
    start: () => ipcRenderer.invoke(IPC.streamStart) as Promise<{ ok: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke(IPC.streamStop) as Promise<void>,
    stats: () => ipcRenderer.invoke(IPC.streamStats) as Promise<StreamStats>,
    /** 直推混音器：TTS 音频入队（没在推流时主进程丢弃） */
    pushTts: (filePath: string) => ipcRenderer.invoke(IPC.streamPushTts, filePath) as Promise<void>,
    setBgm: (action: 'start' | 'stop' | 'volume', filePath?: string, volume?: number) =>
      ipcRenderer.invoke(IPC.streamSetBgm, action, filePath, volume) as Promise<void>,
    /** 麦克风 PCM 帧（s16le 48k stereo）进混音器 */
    pushMicPcm: (pcm: Uint8Array) => ipcRenderer.send(IPC.streamMicPcm, pcm),
    onStats: (cb: (stats: StreamStats) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, stats: StreamStats) => cb(stats)
      ipcRenderer.on(IPC.streamStatsEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.streamStatsEvent, listener)
      }
    }
  },
  connector: {
    status: () => ipcRenderer.invoke(IPC.connectorStatus) as Promise<ConnectorStatus>,
    restart: () => ipcRenderer.invoke(IPC.connectorRestart) as Promise<ConnectorStatus>,
    /** 出站动作口：调连接器工具（比如 get_room_stats） */
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke(IPC.connectorCallTool, name, args) as Promise<
        { ok: true; text: string } | { ok: false; error: string }
      >,
    /** 订阅连接器状态，返回取消订阅函数 */
    onStatus: (cb: (status: ConnectorStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: ConnectorStatus) => cb(status)
      ipcRenderer.on(IPC.connectorStatusEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.connectorStatusEvent, listener)
      }
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
