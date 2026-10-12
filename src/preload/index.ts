import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentStatus,
  AppConfig,
  AppInfo,
  ConnectorStatus,
  DirectorMessage,
  EpisodeSummary,
  KnowledgeFile,
  LiveComment,
  LiveEvent,
  LivePlan,
  LivePlanInput,
  LaunchResult,
  ModelConnectionInput,
  ModelConnectionSafe,
  PartialDeep,
  Persona,
  PlaybackControlAction,
  PoolResult,
  PoolSayInput,
  PoolSnapshot,
  PoolStatus,
  PreflightItem,
  Product,
  ProductInput,
  Script,
  ScriptInput,
  SpeechItem,
  SpeechLane,
  TtsConnectionInput,
  TtsConnectionSafe,
  Utterance,
  UtteranceInput,
  VoiceRecord,
  VoiceUsage,
  StreamStats,
  Trigger,
  TriggerInput,
  ViewerProfile
} from '../shared/types'
import type { GenerationProgress } from '../main/services/GenerationService'
import type { LlmProviderManifest, TtsProviderManifest } from '../main/services/providers/registry'
import type { TtsTestInput, TtsTestResult } from '../main/services/TtsService'
import type { VoiceCloneInput } from '../main/services/VoiceService'

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
    /** 播放中断：把正在播的这条退回 ready（恢复后从头重播） */
    requeue: (id: string) => ipcRenderer.invoke(IPC.poolRequeue, id) as Promise<PoolResult>,
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
    /** 测试发音：用指定的接入 + 模型合成一小段（voice 空 → 模型目录第一个音色或该接入 + 模型的克隆音色） */
    test: (input: TtsTestInput) => ipcRenderer.invoke(IPC.ttsTest, input) as Promise<TtsTestResult>,
    /**
     * 语音合成的供应商接入（设置 → 语音合成）：一家可多条（不同账号/参数）。
     * 密钥字段的值不出主进程，只有 hasSecret / ready 两个标记。
     */
    connections: () => ipcRenderer.invoke(IPC.ttsConnectionList) as Promise<TtsConnectionSafe[]>,
    /** 新建/编辑接入（id 空则新建）。密钥字段留空 = 不修改；没有默认模型/默认音色，音色自带接入与模型 */
    saveConnection: (input: TtsConnectionInput) =>
      ipcRenderer.invoke(IPC.ttsConnectionSave, input) as Promise<
        { ok: true; connections: TtsConnectionSafe[] } | { ok: false; error: string }
      >,
    /** 删除接入（音色路由按接入 id 找接入：绑它的克隆音色会报错，界面提示补回） */
    removeConnection: (id: string) =>
      ipcRenderer.invoke(IPC.ttsConnectionRemove, id) as Promise<{
        ok: true
        connections: TtsConnectionSafe[]
      }>
  },
  /**
   * 供应商接入（设置 → 语言模型）：一条 = 一个服务商 + 一份凭据 + 一串模型。
   * 密钥字段的值不出主进程，只有 hasSecret / ready 两个标记。
   */
  model: {
    list: () => ipcRenderer.invoke(IPC.modelList) as Promise<ModelConnectionSafe[]>,
    save: (input: ModelConnectionInput) =>
      ipcRenderer.invoke(IPC.modelSave, input) as Promise<
        { ok: true; connections: ModelConnectionSafe[] } | { ok: false; error: string }
      >,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.modelRemove, id) as Promise<{ ok: true; connections: ModelConnectionSafe[] }>,
    /** 连通性测试；不传 model 就测该接入模型列表的第一个 */
    test: (id: string, model?: string) =>
      ipcRenderer.invoke(IPC.modelTest, id, model) as Promise<{
        ok: boolean
        error?: string
        latencyMs?: number
      }>
  },
  providers: {
    /** 服务商能力与配置字段（表单由 manifest 驱动渲染） */
    llmList: () => ipcRenderer.invoke(IPC.providersLlmList) as Promise<LlmProviderManifest[]>,
    /** 语音合成服务商清单（设置页表单 + 音色选择的分组与能力位） */
    ttsList: () => ipcRenderer.invoke(IPC.providersTtsList) as Promise<TtsProviderManifest[]>,
    /** 该服务商真实可用的模型 id（模型列表的下拉建议） */
    models: (providerId: string) =>
      ipcRenderer.invoke(IPC.providersModels, providerId) as Promise<string[]>
  },
  agent: {
    start: () => ipcRenderer.invoke(IPC.agentStart) as Promise<{ ok: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke(IPC.agentStop) as Promise<void>,
    restart: () => ipcRenderer.invoke(IPC.agentRestart) as Promise<{ ok: boolean; error?: string }>,
    status: () => ipcRenderer.invoke(IPC.agentStatus) as Promise<AgentStatus>,
    /** 暂停/恢复主播产出（统一开播控制里的暂停：停播报 + 停生成） */
    setSpeakingPaused: (paused: boolean) =>
      ipcRenderer.invoke(IPC.playbackSetPaused, paused) as Promise<void>,
    /** 订阅 Agent 状态 + 生成中预览，返回取消订阅函数 */
    onStatus: (cb: (status: AgentStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: AgentStatus) => cb(status)
      ipcRenderer.on(IPC.agentStatusEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.agentStatusEvent, listener)
      }
    }
  },
  director: {
    /** 导演指令 → 主播（最高优先级，steer 插队） */
    send: (text: string) =>
      ipcRenderer.invoke(IPC.directorSend, text) as Promise<{ ok: boolean; error?: string }>,
    /** 订阅主播汇报/请示消息，返回取消订阅函数 */
    onEvent: (cb: (message: DirectorMessage) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, message: DirectorMessage) => cb(message)
      ipcRenderer.on(IPC.directorEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.directorEvent, listener)
      }
    }
  },
  /** 订阅播报控制（主播工具 pause/resume/skip 触发），返回取消订阅函数 */
  playback: {
    onControl: (cb: (action: PlaybackControlAction) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, action: PlaybackControlAction) => cb(action)
      ipcRenderer.on(IPC.playbackControlEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.playbackControlEvent, listener)
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
    /** 克隆到指定接入 + 模型（火山要本地样本 samplePath；百炼要公网音频地址 sampleUrl） */
    clone: (input: VoiceCloneInput) =>
      ipcRenderer.invoke(IPC.voiceClone, input) as Promise<{ ok: boolean; error?: string }>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.voiceRemove, id) as Promise<{ ok: boolean; error?: string }>,
    rename: (id: string, name: string) =>
      ipcRenderer.invoke(IPC.voiceRename, id, name) as Promise<{ ok: boolean; error?: string }>,
    /** 试听：合成一句固定文案并返回缓存路径（用 audioEngine.playTts 播放） */
    preview: (id: string) =>
      ipcRenderer.invoke(IPC.voicePreview, id) as Promise<
        { ok: true; audioPath: string } | { ok: false; error: string }
      >,
    usage: (id: string) => ipcRenderer.invoke(IPC.voiceUsage, id) as Promise<VoiceUsage>,
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
    setActive: (id: string) => ipcRenderer.invoke(IPC.planSetActive, id) as Promise<string>,
    /** 开播前预检：检查项清单（阻断/警告） */
    preflight: (id: string) => ipcRenderer.invoke(IPC.planPreflight, id) as Promise<PreflightItem[]>,
    /** 启动场次：加载配置 + 应用人设音色 + 装载话术库 + 启动主播 */
    launch: (id: string) => ipcRenderer.invoke(IPC.planLaunch, id) as Promise<LaunchResult>,
    /** 切场景：跳剧本场景 + 装载该场景话术库 */
    gotoScene: (planId: string, index: number) =>
      ipcRenderer.invoke(IPC.planGotoScene, planId, index) as Promise<{
        ok: boolean
        loaded: number
        title?: string
        error?: string
      }>
  },
  utterance: {
    list: (planId: string) => ipcRenderer.invoke(IPC.utteranceList, planId) as Promise<Utterance[]>,
    save: (input: UtteranceInput, id?: string) =>
      ipcRenderer.invoke(IPC.utteranceSave, input, id) as Promise<PoolResult<Utterance>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.utteranceDelete, id) as Promise<PoolResult>,
    clear: (planId: string, sceneId?: string) =>
      ipcRenderer.invoke(IPC.utteranceClear, planId, sceneId) as Promise<PoolResult>,
    /** 批量预合成（异步启动，进度走 onEvent；id='' 表示批次结束） */
    presynth: (planId: string) => ipcRenderer.invoke(IPC.utterancePresynth, planId) as Promise<{ ok: boolean }>,
    onEvent: (cb: (utterance: Utterance) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, utterance: Utterance) => cb(utterance)
      ipcRenderer.on(IPC.utteranceEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.utteranceEvent, listener)
      }
    }
  },
  generation: {
    start: (planId: string) =>
      ipcRenderer.invoke(IPC.generationStart, planId) as Promise<{ ok: boolean; error?: string }>,
    cancel: () => ipcRenderer.invoke(IPC.generationCancel) as Promise<void>,
    onEvent: (cb: (progress: GenerationProgress) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: GenerationProgress) => cb(progress)
      ipcRenderer.on(IPC.generationEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.generationEvent, listener)
      }
    }
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
