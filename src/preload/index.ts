import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentStatus,
  AppConfig,
  AppInfo,
  AudioBgmAction,
  AudioCommandResult,
  AudioEndPayload,
  AudioLevelPayload,
  AudioPcmPayload,
  AudioProgressPayload,
  ConnectorStatus,
  ChatEntry,
  DirectorTimelineEvent,
  DirectorTimelineReset,
  EpisodeSummary,
  KnowledgeFile,
  LiveComment,
  LiveEvent,
  LaunchResult,
  ModelConnectionInput,
  ModelConnectionSafe,
  PartialDeep,
  Persona,
  PromptTemplateInfo,
  PlaybackControlAction,
  PoolResult,
  PoolSayInput,
  PoolSnapshot,
  PoolStatus,
  PreflightItem,
  ProduceAudioResult,
  Program,
  ProgramAudioProgress,
  ProgramGateResult,
  ProgramInput,
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
import type { LlmProviderManifest, TtsProviderManifest } from '../main/services/providers/registry'
import type { TtsTestInput, TtsTestResult } from '../main/services/TtsService'
import type { VoiceCloneInput } from '../main/services/VoiceService'
import type { TempUploadResult } from '../main/services/TempUpload'

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
    /** 打断当前这一轮生成（会话保留）；对话输入框的停止钮 */
    abort: () => ipcRenderer.invoke(IPC.agentAbort) as Promise<void>,
    restart: () => ipcRenderer.invoke(IPC.agentRestart) as Promise<{ ok: boolean; error?: string }>,
    /** 原子换主播：abort 当前生成 → 节目历史存回 → 新主播套同一份历史重建会话（直播中可切，不断上下文） */
    handoff: (personaId: string) =>
      ipcRenderer.invoke(IPC.agentHandoff, personaId) as Promise<{ ok: boolean; error?: string }>,
    status: () => ipcRenderer.invoke(IPC.agentStatus) as Promise<AgentStatus>,
    /** 编剧模式：派主播给该节目写底稿（跳直播台看过程，随时可插话改口径） */
    draftStart: (programId: string) =>
      ipcRenderer.invoke(IPC.agentDraftStart, programId) as Promise<{ ok: boolean; error?: string }>,
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
    /** 导演指令 → 主播（最高优先级，steer 插队）；localId = 本地回显条目 id，落库恢复不重复。
     * attachments = 随消息附的文件：图片（png/jpg/jpeg/webp/gif）由 main 读成图像内容进会话（模型需开多模态），
     * 其它类型降级成 [附件] 文本说明 */
    send: (text: string, localId?: string, attachments?: { name: string; path: string }[]) =>
      ipcRenderer.invoke(IPC.directorSend, text, localId, attachments) as Promise<{ ok: boolean; error?: string }>,
    /** 拉某节目的对话时间线（切节目/刷新/重启后整段恢复） */
    timelineList: (programId: string) =>
      ipcRenderer.invoke(IPC.directorTimelineList, programId) as Promise<ChatEntry[]>,
    /** 订阅对话时间线（文本流式 / 工具调用 / 请示卡片 / reset 整体替换；同一 entry.id 会重复推更新，渲染层按 id upsert） */
    onTimeline: (cb: (event: DirectorTimelineEvent | DirectorTimelineReset) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: DirectorTimelineEvent | DirectorTimelineReset) =>
        cb(event)
      ipcRenderer.on(IPC.directorTimeline, listener)
      return () => {
        ipcRenderer.removeListener(IPC.directorTimeline, listener)
      }
    }
  },
  /** 提示词模板（设置 → 主播手册）：主播人格/导演包装/评论注入等全部可编辑 */
  promptTemplates: {
    list: () => ipcRenderer.invoke(IPC.promptTemplatesList) as Promise<PromptTemplateInfo[]>,
    save: (key: string, content: string) =>
      ipcRenderer.invoke(IPC.promptTemplatesSave, key, content) as Promise<{ ok: boolean; error?: string }>,
    reset: (key: string) =>
      ipcRenderer.invoke(IPC.promptTemplatesReset, key) as Promise<{ ok: boolean; error?: string }>
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
  audio: {
    /** 主音量（本机监听）：交给主进程 AudioPipeline，它按这个增益推 PCM（不影响推流那一路） */
    setMasterVolume: (volume: number) =>
      ipcRenderer.invoke(IPC.audioSetMasterVolume, volume) as Promise<AudioCommandResult>,
    /** 紧急静音：AI 两路（本机监听 + 推流）一起哑，麦克风人声不受影响 */
    setMuted: (muted: boolean) => ipcRenderer.invoke(IPC.audioSetMuted, muted) as Promise<AudioCommandResult>,
    /** BGM（选文件 / 停止 / 音量）：本机监听与推流两侧都由主进程处理 */
    setBgm: (action: AudioBgmAction, filePath?: string, volume?: number) =>
      ipcRenderer.invoke(IPC.audioSetBgm, action, filePath, volume) as Promise<AudioCommandResult>,
    /** 停掉当前 AI 播报（跳过这条 / 紧急停止）：主进程掐断解码与排播，BGM 与推流不断 */
    stopAll: () => ipcRenderer.invoke(IPC.audioStopAll) as Promise<AudioCommandResult>,
    /** 试听：主进程把指定音频文件播到监听通道（aux 槽，不打断主槽播报；dev 下渲染层读不了 file://，统一走这里） */
    playFile: (filePath: string) =>
      ipcRenderer.invoke(IPC.audioPlayFile, filePath) as Promise<AudioCommandResult>,
    /** 停止试听（停 aux 槽，不动主槽播报） */
    stopAux: () => ipcRenderer.invoke(IPC.audioStopAux) as Promise<AudioCommandResult>,
    /** 章内 seek（预制节目长音频）：主槽从指定毫秒位置继续播 */
    seekMain: (offsetMs: number) =>
      ipcRenderer.invoke(IPC.audioSeekMain, offsetMs) as Promise<AudioCommandResult>,
    /** 订阅主槽播放进度（预制节目进度条用），返回取消订阅函数 */
    onProgress: (cb: (payload: AudioProgressPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AudioProgressPayload) => cb(payload)
      ipcRenderer.on(IPC.audioProgressEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.audioProgressEvent, listener)
      }
    },
    /** 订阅 PCM 片（本机监听唯一数据流），返回取消订阅函数 */
    onPcm: (cb: (payload: AudioPcmPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AudioPcmPayload) => cb(payload)
      ipcRenderer.on(IPC.audioPcm, listener)
      return () => {
        ipcRenderer.removeListener(IPC.audioPcm, listener)
      }
    },
    /** 订阅电平（主进程按片算，渲染层只显示） */
    onLevel: (cb: (payload: AudioLevelPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AudioLevelPayload) => cb(payload)
      ipcRenderer.on(IPC.audioLevel, listener)
      return () => {
        ipcRenderer.removeListener(IPC.audioLevel, listener)
      }
    },
    /** 订阅「一段播完」（渲染层据此收尾排播） */
    onEnd: (cb: (payload: AudioEndPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AudioEndPayload) => cb(payload)
      ipcRenderer.on(IPC.audioEnd, listener)
      return () => {
        ipcRenderer.removeListener(IPC.audioEnd, listener)
      }
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
    /** 试听：合成一句固定文案，合成完由**主进程**直接出声（不再返回 audioPath 让渲染层播） */
    preview: (id: string) =>
      ipcRenderer.invoke(IPC.voicePreview, id) as Promise<
        { ok: true; audioPath: string } | { ok: false; error: string }
      >,
    usage: (id: string) => ipcRenderer.invoke(IPC.voiceUsage, id) as Promise<VoiceUsage>,
    uploadSample: (bytes: Uint8Array, ext: string) =>
      ipcRenderer.invoke(IPC.voiceUploadSample, bytes, ext) as Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >,
    /** 传本地样本到临时文件站，换回公网直链（百炼复刻只接受 URL） */
    uploadTemp: (filePath: string) =>
      ipcRenderer.invoke(IPC.voiceUploadTemp, filePath) as Promise<TempUploadResult>,
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
    /** 从抖音商城同步商品（连接器在线时；按 externalId 去重更新） */
    syncProducts: () =>
      ipcRenderer.invoke(IPC.knowledgeProductSync) as Promise<
        { ok: true; added: number; updated: number; total: number } | { ok: false; error: string }
      >,
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
  program: {
    list: () => ipcRenderer.invoke(IPC.programList) as Promise<Program[]>,
    save: (input: ProgramInput, id?: string) =>
      ipcRenderer.invoke(IPC.programSave, input, id) as Promise<PoolResult<Program>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.programDelete, id) as Promise<PoolResult>,
    /** 设为当前节目，返回生效的 activeProgramId */
    setActive: (id: string) => ipcRenderer.invoke(IPC.programSetActive, id) as Promise<string>,
    /** 开播前预检：检查项清单（阻断/警告） */
    preflight: (id: string) => ipcRenderer.invoke(IPC.programPreflight, id) as Promise<PreflightItem[]>,
    /** 启动节目：加载配置 + 应用人设音色 + 装载话术库 + 启动主播；opts.allowPartial = 预制节目「仅播放已完成部分」 */
    launch: (id: string, opts?: { allowPartial?: boolean }) =>
      ipcRenderer.invoke(IPC.programLaunch, id, opts) as Promise<LaunchResult>,
    /** 切场景：跳剧本场景 + 装载该场景话术库 */
    gotoScene: (programId: string, index: number) =>
      ipcRenderer.invoke(IPC.programGotoScene, programId, index) as Promise<{
        ok: boolean
        loaded: number
        title?: string
        error?: string
      }>,
    /** 统一音频生产入口：rolling=提前合成全部（立即返回，后台跑）；prepared=生成节目音频（跑完返回汇总，进度走 onAudioEvent / utterance.onEvent） */
    produceAudio: (id: string) => ipcRenderer.invoke(IPC.programProduceAudio, id) as Promise<ProduceAudioResult>,
    /** 预制节目正式播放门禁：所有单元 ready + 文件存在 + 指纹一致才 ok；未通过时 failures 带原因，不静默跳过 */
    playGate: (id: string) => ipcRenderer.invoke(IPC.programPlayGate, id) as Promise<ProgramGateResult>,
    /** 节目音频进度（单元总数/ready/synthesizing/pending/failed/stale） */
    audioProgress: (id: string) => ipcRenderer.invoke(IPC.programAudioProgress, id) as Promise<ProgramAudioProgress>,
    /** 预制节目按章跳播：装池提到队首并打断当前条目立即播；already=true 表示这章正在播 */
    playUnit: (id: string, target: { kind: 'scene' | 'utterance'; id: string }) =>
      ipcRenderer.invoke(IPC.programPlayUnit, id, target) as Promise<{
        ok: boolean
        title?: string
        already?: boolean
        error?: string
      }>,
    /** 导入外部音频（预制节目）：主进程弹文件选择框（mp3/wav/m4a），挂到指定 Scene/Utterance；取消返回 ok:false */
    importAudio: (id: string, target: { kind: 'scene' | 'utterance'; id: string }) =>
      ipcRenderer.invoke(IPC.programImportAudio, id, target) as Promise<
        { ok: true; audioPath: string } | { ok: false; error: string }
      >,
    /** 订阅预制音频资产变化（rendered 更新），返回取消订阅函数 */
    onAudioEvent: (cb: (payload: { programId: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { programId: string }) => cb(payload)
      ipcRenderer.on(IPC.programAudioEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.programAudioEvent, listener)
      }
    }
  },
  utterance: {
    list: (programId: string) => ipcRenderer.invoke(IPC.utteranceList, programId) as Promise<Utterance[]>,
    save: (input: UtteranceInput, id?: string) =>
      ipcRenderer.invoke(IPC.utteranceSave, input, id) as Promise<PoolResult<Utterance>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.utteranceDelete, id) as Promise<PoolResult>,
    clear: (programId: string, sceneId?: string) =>
      ipcRenderer.invoke(IPC.utteranceClear, programId, sceneId) as Promise<PoolResult>,
    /** 批量预合成（异步启动，进度走 onEvent；id='' 表示批次结束） */
    presynth: (programId: string) => ipcRenderer.invoke(IPC.utterancePresynth, programId) as Promise<{ ok: boolean }>,
    onEvent: (cb: (utterance: Utterance) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, utterance: Utterance) => cb(utterance)
      ipcRenderer.on(IPC.utteranceEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.utteranceEvent, listener)
      }
    }
  },
  stream: {
    start: () => ipcRenderer.invoke(IPC.streamStart) as Promise<{ ok: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke(IPC.streamStop) as Promise<void>,
    stats: () => ipcRenderer.invoke(IPC.streamStats) as Promise<StreamStats>,
    /** 麦克风 PCM 帧（s16le 48k stereo）进混音器；TTS/BGM 由主进程 AudioPipeline 直连，不经这里 */
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
