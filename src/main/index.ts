import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { setDefaultResultOrder } from 'node:dns'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import { POOL_LIMITS } from '../shared/types'
import {
  type AgentStatus,
  type AppConfig,
  type AppInfo,
  type AudioEndPayload,
  type AudioLevelPayload,
  type AudioPcmPayload,
  type ConnectorStatus,
  type DirectorTimelineEvent,
  type DirectorTimelineReset,
  type LiveComment,
  type ModelConnectionInput,
  type PartialDeep,
  type Persona,
  type PoolResult,
  type PoolSayInput,
  type PoolSnapshot,
  type ProductInput,
  type ScriptInput,
  type LiveModeInput,
  type LivePlanInput,
  type SpeechItem,
  type SpeechLane,
  type StreamStats,
  type TriggerInput,
  type TtsConnectionInput,
  type Utterance,
  type UtteranceInput,
  type VoiceRecord
} from '../shared/types'
import { StorageService } from './services/StorageService'
import { TtsService, type TtsTestInput } from './services/TtsService'
import { SpeechPool } from './services/SpeechPool'
import { PersonaService } from './services/PersonaService'
import { PromptTemplateService } from './services/PromptTemplateService'
import { AgentService } from './services/AgentService'
import { KnowledgeService } from './services/KnowledgeService'
import { MemoryService } from './services/MemoryService'
import { ModeService } from './services/ModeService'
import { EventBus } from './services/EventBus'
import { TriggerRuntime } from './services/TriggerRuntime'
import { ScriptService } from './services/ScriptService'
import { StreamService } from './services/stream/StreamService'
import { ConnectorService } from './services/ConnectorService'
import { VoiceService, type VoiceCloneInput } from './services/VoiceService'
import { TempUploadService } from './services/TempUpload'
import { TtsStreamService } from './services/TtsStreamService'
import { TtsRealtimeService } from './services/TtsRealtimeService'
import { UtteranceService } from './services/UtteranceService'
import { LaunchService } from './services/LaunchService'
import { listProviderModels, testModelConnection } from './services/llmModel'
import { getLlmProvider, getTtsProvider, listLlmProviders, listTtsProviders } from './services/providers/registry'
import { AudioPipeline } from './services/audio/AudioPipeline'
import { PlaybackLoop } from './services/audio/PlaybackLoop'

// 固定到 %APPDATA%\AgentAnchor。必须在 ready 之前设置，
// 否则开发时叫 agent-anchor、打包后叫 Agent Anchor，配置会看起来"丢了"。
// 测试/并行实例可用 AGENT_ANCHOR_USER_DATA 指向别的目录。
app.setPath('userData', process.env['AGENT_ANCHOR_USER_DATA'] ?? join(app.getPath('appData'), 'AgentAnchor'))

let mainWindow: BrowserWindow | null = null
let pool: SpeechPool | null = null

/** Windows 上标题栏覆盖层偶发把第一帧停在白底。显示后改一次尺寸让系统重画；画面仍是空的就重新加载。 */
function recoverBlankWindow(win: BrowserWindow): void {
  let shown = false
  let loaded = false
  let nudged = false
  let reloads = 0

  const reload = (why: string) => {
    if (win.isDestroyed() || reloads >= 2) return
    reloads += 1
    console.error(`[AgentAnchor] 窗口没有画出来（${why}），重新加载`)
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, 200)
  }

  const show = () => {
    if (win.isDestroyed()) return
    shown = true
    if (!win.isVisible()) win.show()
    if (nudged || !loaded || process.platform !== 'win32') return
    nudged = true
    setTimeout(() => {
      if (win.isDestroyed()) return
      const [width, height] = win.getContentSize()
      win.setContentSize(width, height + 1)
      win.setContentSize(width, height)
    }, 50)
  }

  win.once('ready-to-show', show)

  win.webContents.on('did-finish-load', () => {
    loaded = true
    show()
    setTimeout(() => {
      if (win.isDestroyed()) return
      void win.webContents
        .executeJavaScript(
          'Boolean(document.getElementById("root") && document.getElementById("root").childElementCount > 0)',
          true
        )
        .then((painted) => {
          if (!painted) reload('画面是空的')
        })
        .catch(() => reload('画面检查失败'))
    }, 400)
  })

  win.webContents.on('preload-error', (_event, _path, error) => {
    reload(error instanceof Error ? error.message : 'preload')
  })

  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    reload(`${code} ${description}`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    reload(details.reason)
  })
}

function createWindow(storage: StorageService): void {
  const dark = followAppTheme(storage.getConfig().theme)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(dark),
    title: 'Agent Anchor',
    autoHideMenuBar: true,
    ...(process.platform === 'win32'
      ? {
          // 系统按钮留在右上角，左边这一行由界面自己画，和它们齐平。
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlay(dark)
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：沙箱 + 上下文隔离，渲染进程无 Node 能力
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏期间也要画出第一帧，否则显示时会停在白底。
      backgroundThrottling: false
    }
  })
  mainWindow = win

  recoverBlankWindow(win)

  // 外部链接一律交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 池快照广播给所有窗口；顺带探测 pool.empty / pool.low（沿只发一次，恢复后可再发） */
let poolWasEmpty = true
let poolWasLow = false
function broadcastPool(snapshot: PoolSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.poolSnapshotEvent, snapshot)
  }
  // 池里可能刚来了新话术：叫醒主进程的播放循环，不用等满一个睡眠周期
  playback?.kick()
  const remaining = snapshot.items.length
  const empty = remaining === 0
  if (empty && !poolWasEmpty) bus?.emit('pool.empty', {}, 'pool')
  poolWasEmpty = empty
  // 低水位：还剩几段但不够播多久了，提前叫主播续写——等空了再叫必然冷场（写稿+合成要时间）
  const low = !empty && remaining <= POOL_LIMITS.lowWater
  if (low && !poolWasLow) bus?.emit('pool.low', { remaining }, 'pool')
  poolWasLow = low
}

/** Agent 状态（含生成中预览）广播给所有窗口 */
function broadcastAgent(status: AgentStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentStatusEvent, status)
  }
}

/** 评论事件广播（toast 展示用） */
function broadcastComment(comment: LiveComment): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.commentEvent, comment)
  }
}

/** 对话时间线广播（文本流式 / 工具调用 / 请示卡片；同一 entry.id 会重复推更新，渲染层按 id upsert；reset = 压缩后整体替换） */
function broadcastDirectorTimeline(event: DirectorTimelineEvent | DirectorTimelineReset): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.directorTimeline, event)
  }
}


/** 话术库单条状态变化广播（预合成进度） */
function broadcastUtterance(utterance: Utterance): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.utteranceEvent, utterance)
  }
}

/** 批量预合成结束：发一条特殊事件（id='' 表示批次结束，UI 刷新列表） */
function broadcastUtteranceDone(planId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.utteranceEvent, {
        id: '',
        planId,
        sceneId: '',
        variantIdx: 0,
        seq: 0,
        text: '',
        bitType: '',
        delivery: '',
        voiceId: '',
        audioPath: null,
        status: 'ready',
        source: 'initial',
        sources: [],
        createdAt: Date.now()
      } satisfies Utterance)
    }
  }
}

/** 推流状态广播 */
function broadcastStream(stats: StreamStats): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.streamStatsEvent, stats)
  }
}

/** 连接器状态广播 */
function broadcastConnector(status: ConnectorStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.connectorStatusEvent, status)
  }
}

/** 音色库变化广播（训练状态更新/新增/删除） */
function broadcastVoices(voices: VoiceRecord[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.voiceChanged, voices)
  }
}

/** 音频 PCM 片广播（本机监听唯一数据流；AudioPipeline 是唯一发源地） */
function broadcastPcm(payload: AudioPcmPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.audioPcm, payload)
  }
}

/** 电平广播（主进程算，渲染层只显示） */
function broadcastLevel(payload: AudioLevelPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.audioLevel, payload)
  }
}

/** 一段播放结束广播（渲染层据此收尾排播） */
function broadcastAudioEnd(payload: AudioEndPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.audioEnd, payload)
  }
}

let agent: AgentService | null = null
let bus: EventBus | null = null
let triggers: TriggerRuntime | null = null
let timerInterval: ReturnType<typeof setInterval> | null = null
let audioCacheSweep: ReturnType<typeof setInterval> | null = null
let connector: ConnectorService | null = null
let voiceSvc: VoiceService | null = null
let ttsStream: TtsStreamService | null = null
let ttsRealtime: TtsRealtimeService | null = null
let streamSvc: StreamService | null = null
let pipeline: AudioPipeline | null = null
let playback: PlaybackLoop | null = null

/** 池操作统一包一层：错误不抛给渲染进程，返回 { ok, error } 给 UI 提示 */
function guard<T>(fn: () => T): { ok: true; item: T } | { ok: false; error: string }
function guard(fn: () => void): PoolResult
function guard(fn: () => unknown): { ok: true; item?: unknown } | { ok: false; error: string } {
  try {
    const result = fn()
    return result !== undefined ? { ok: true, item: result } : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function registerIpc(
  storage: StorageService,
  tts: TtsService,
  pool: SpeechPool,
  agent: AgentService,
  persona: PersonaService,
  prompts: PromptTemplateService,
  knowledge: KnowledgeService,
  memory: MemoryService,
  modes: ModeService,
  bus: EventBus,
  triggers: TriggerRuntime,
  script: ScriptService,
  stream: StreamService,
  connector: ConnectorService,
  utterances: UtteranceService,
  launch: LaunchService
): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: 'Agent Anchor',
    version: app.getVersion(),
    platform: process.platform
  }))
  ipcMain.handle(IPC.configGet, () => storage.getConfig())
  ipcMain.handle(IPC.configSet, (_event, patch: PartialDeep<AppConfig>) => storage.setConfig(patch))

  // ---------- 话术池 ----------
  ipcMain.handle(IPC.poolSay, (_e, input: PoolSayInput) => guard(() => pool.say(input)))
  ipcMain.handle(IPC.poolInsertNext, (_e, input: Omit<PoolSayInput, 'lane'>) =>
    guard(() => pool.insertNext(input))
  )
  ipcMain.handle(IPC.poolRevise, (_e, id: string, text: string) =>
    guard(() => pool.revise(id, text))
  )
  ipcMain.handle(IPC.poolRevoke, (_e, id: string) => guard(() => pool.revoke(id)))
  ipcMain.handle(IPC.poolReorder, (_e, ids: string[]) => guard(() => pool.reorder(ids)))
  ipcMain.handle(IPC.poolClearLane, (_e, lane: SpeechLane) => guard(() => pool.clearLane(lane)))
  ipcMain.handle(IPC.poolStatus, () => pool.getStatus())
  ipcMain.handle(IPC.poolRecentPlayed, (_e, n: number) => pool.getRecentPlayed(n))
  ipcMain.handle(IPC.poolNext, () => pool.next())
  ipcMain.handle(IPC.poolMarkDone, (_e, id: string) => pool.markDone(id))
  ipcMain.handle(IPC.poolRequeue, (_e, id: string) => guard(() => pool.requeue(String(id ?? ''))))
  ipcMain.handle(IPC.poolSnapshot, () => pool.snapshot())

  // ---------- TTS ----------
  // 测试发音：合成完由**主进程**出声（aux 槽，不打断正在播报的话术）——
  // 渲染层不再拿到 audioPath 自己去播；只有真的开始出声才回 ok，解码/放音失败照实报错。
  ipcMain.handle(IPC.ttsTest, async (_e, input: TtsTestInput) => {
    const result = await tts.test({
      connectionId: String(input?.connectionId ?? ''),
      model: String(input?.model ?? ''),
      voice: input?.voice ? String(input.voice) : undefined,
      text: input?.text ? String(input.text).slice(0, 200) : undefined
    })
    if (!result.ok || !result.audioPath || !pipeline) return result
    const request = pipeline.playFile(`tts-test-${Date.now()}`, result.audioPath, { slot: 'aux' })
    const started = await request.started
    if (!started.ok) {
      return { ...result, error: started.error ?? '音频没能放出来（没有可用输出设备或播放被系统拒绝）' }
    }
    await request.done
    return { ...result, playing: true }
  })

  // ---------- 语音合成的供应商接入（设置 → 语音合成） ----------
  ipcMain.handle(IPC.ttsConnectionList, () => storage.ttsConnectionListSafe())
  ipcMain.handle(IPC.ttsConnectionSave, (_e, input: TtsConnectionInput) => {
    try {
      const providerId = String(input?.providerId ?? '')
      if (!getTtsProvider(providerId)) return { ok: false, error: '服务商不认识：重新选一家' }
      const models = (input?.models ?? [])
        .map((model) => ({
          id: String(model?.id ?? '').trim(),
          params: model?.params && typeof model.params === 'object' ? model.params : {}
        }))
        .filter((model) => model.id)
      if (models.length === 0) return { ok: false, error: '至少启用一个模型：合成要靠它出声' }
      storage.ttsConnectionSave({
        id: input?.id ? String(input.id) : undefined,
        providerId: providerId as TtsConnectionInput['providerId'],
        name: String(input?.name ?? ''),
        params: input?.params ?? {},
        models,
        // 不传就沿用已保存的那条（编辑时不碰开关不该把它关掉）
        realtime: typeof input?.realtime === 'boolean' ? input.realtime : undefined
      })
      return { ok: true, connections: storage.ttsConnectionListSafe() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.ttsConnectionRemove, (_e, id: string) => {
    storage.ttsConnectionDelete(String(id ?? ''))
    return { ok: true, connections: storage.ttsConnectionListSafe() }
  })

  // ---------- 语言模型（供应商接入，设置 → 语言模型） ----------
  ipcMain.handle(IPC.modelList, () => storage.connectionListSafe())
  ipcMain.handle(IPC.modelSave, (_e, input: ModelConnectionInput) => {
    try {
      const providerId = String(input?.providerId ?? '')
      if (!getLlmProvider(providerId)) return { ok: false, error: '服务商不认识：重新选一家' }
      const models = (input?.models ?? []).map((model) => String(model ?? '').trim()).filter(Boolean)
      if (models.length === 0) return { ok: false, error: '至少加一个模型：主播要靠它说话' }
      storage.connectionSave({
        id: input?.id,
        name: String(input?.name ?? ''),
        providerId,
        params: input?.params ?? {},
        models,
        modelContextWindows: input?.modelContextWindows ?? {}
      })
      return { ok: true, connections: storage.connectionListSafe() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.modelRemove, (_e, id: string) => {
    storage.connectionDelete(String(id ?? ''))
    return { ok: true, connections: storage.connectionListSafe() }
  })
  ipcMain.handle(IPC.modelTest, async (_e, id: string, model?: string) => {
    const connection = storage.connectionGet(String(id ?? ''))
    if (!connection) return { ok: false, error: '这条接入不存在（可能刚被删掉）' }
    return testModelConnection(connection, model)
  })
  ipcMain.handle(IPC.providersLlmList, () => listLlmProviders())
  ipcMain.handle(IPC.providersTtsList, () => listTtsProviders())
  ipcMain.handle(IPC.providersModels, (_e, providerId: string) => listProviderModels(String(providerId ?? '')))

  // ---------- 主播 Agent ----------
  ipcMain.handle(IPC.agentStart, async () => {
    try {
      await agent.start()
      bus.emit('stream.started', {}, 'human')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.agentStop, async () => {
    const wasRunning = agent.status().state !== 'stopped'
    await agent.stop()
    if (wasRunning) bus.emit('stream.ended', {}, 'human')
  })
  // 打断当前这一轮生成（对话输入框的停止钮）：会话保留，下条指令照常来
  ipcMain.handle(IPC.agentAbort, () => agent.stopGeneration())
  ipcMain.handle(IPC.agentRestart, async () => {
    try {
      await agent.stop()
      bus.emit('stream.ended', {}, 'human')
      await agent.start()
      bus.emit('stream.started', {}, 'human')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.agentStatus, () => agent.status())
  // 统一开播控制里的「暂停」：停播报（主进程播放循环）+ 停主播产出（评论/触发器不派、say 被拒）
  ipcMain.handle(IPC.playbackSetPaused, (_e, paused: boolean) => {
    const value = Boolean(paused)
    agent.setSpeakingPaused(value)
    playback?.setRunning(!value)
  })

  // ---------- 导演对话 ----------
  // chat：无会话时自动按当前选中场次起 prep 会话再投递（选中场次即可开聊，不必先启动场次）
  // localId：渲染层本地回显条目的 id，main 以同一 id 落库——重载/切场恢复时不重复
  ipcMain.handle(IPC.directorSend, async (_e, text: string, localId?: string) => {
    const content = String(text ?? '').slice(0, 500)
    const planId = storage.getConfig().live.activePlanId
    if (planId && content) {
      const id = String(localId ?? '').trim() || `dm-${Date.now()}`
      try {
        storage.timelineAppend(
          planId,
          id,
          '',
          Date.now(),
          JSON.stringify({ type: 'director', id, ts: Date.now(), text: content })
        )
      } catch {
        // 落库失败不影响发送
      }
    }
    try {
      await agent.chat(content)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  /** 拉某场次的对话时间线（切场/刷新/重启后整段恢复；载荷已是 ChatEntry JSON） */
  ipcMain.handle(IPC.directorTimelineList, (_e, planId: string) =>
    storage.timelineList(String(planId ?? '')).map((row) => JSON.parse(row.payload) as unknown)
  )

  // ---------- 主播手册（提示词模板） ----------
  ipcMain.handle(IPC.promptTemplatesList, () => prompts.list())
  ipcMain.handle(IPC.promptTemplatesSave, (_e, key: string, content: string) => {
    try {
      prompts.save(String(key ?? ''), String(content ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.promptTemplatesReset, (_e, key: string) => {
    try {
      prompts.reset(String(key ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---------- 人设卡 ----------
  ipcMain.handle(IPC.personaGet, () => persona.get())
  ipcMain.handle(IPC.personaList, () => persona.list())
  ipcMain.handle(
    IPC.personaSave,
    (_e, input: Omit<Persona, 'id' | 'updatedAt'>, id?: string) => persona.save(input, id)
  )
  ipcMain.handle(IPC.personaSetActive, (_e, id: string) => persona.setActive(id))
  ipcMain.handle(IPC.personaRemove, (_e, id: string) => persona.remove(id))

  // ---------- 音频（主进程 AudioPipeline 是唯一音频权威） ----------
  // 渲染层只做三件事：收 PCM 出声、master 音量/紧急静音、麦克风采集。
  ipcMain.handle(IPC.audioSetMasterVolume, (_e, volume: number) => {
    pipeline?.setMasterVolume(Number(volume))
    return { ok: true }
  })
  ipcMain.handle(IPC.audioSetMuted, (_e, muted: boolean) => {
    pipeline?.setMuted(Boolean(muted))
    return { ok: true }
  })
  ipcMain.handle(IPC.audioSetBgm, async (_e, action: 'start' | 'stop' | 'volume', filePath?: string, volume?: number) => {
    if (!pipeline) return { ok: false, error: '音频管线未初始化' }
    return pipeline.setBgm(action, filePath ? String(filePath) : undefined, volume)
  })
  ipcMain.handle(IPC.audioStopAll, () => {
    pipeline?.stopAll()
    return { ok: true }
  })

  // ---------- 音色库（M8 声音克隆） ----------
  ipcMain.handle(IPC.voiceList, () => voiceSvc?.list() ?? [])
  ipcMain.handle(
    IPC.voiceClone,
    (_e, input: VoiceCloneInput) =>
      voiceSvc?.clone(input) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceRemove, (_e, id: string) => voiceSvc?.remove(id) ?? { ok: false, error: '音色服务未初始化' })
  ipcMain.handle(IPC.voiceRename, (_e, id: string, name: string) =>
    voiceSvc?.rename(String(id ?? ''), String(name ?? '')) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(
    IPC.voicePreview,
    (_e, id: string) =>
      voiceSvc?.preview(String(id ?? '')) ?? { ok: false as const, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceUsage, (_e, id: string) =>
    voiceSvc?.usage(String(id ?? '')) ?? { personas: [], plans: [], utteranceCount: 0, utteranceSamples: [] }
  )
  ipcMain.handle(IPC.voiceUploadSample, async (_e, bytes: Uint8Array, ext: string) => {
    if (!voiceSvc) return { ok: false, error: '音色服务未初始化' }
    const path = await voiceSvc.saveSample(bytes, ext)
    return { ok: true, path }
  })

  // 本地样本 → 临时文件站 → 公网直链（百炼复刻只收 URL）
  const tempUpload = new TempUploadService()
  ipcMain.handle(IPC.voiceUploadTemp, (_e, filePath: string) => tempUpload.upload(String(filePath ?? '')))

  // ---------- 知识库 ----------
  ipcMain.handle(IPC.knowledgeProductList, () => knowledge.listProducts())
  ipcMain.handle(IPC.knowledgeProductSave, (_e, input: ProductInput, id?: string) =>
    guard(() => {
      // 价格变动发事件：腹稿修订链路（主播收到后自己决定 revise 池里没播的报价）
      const before = id ? knowledge.listProducts().find((p) => p.id === id) : undefined
      const saved = knowledge.saveProduct(input, id)
      if (before && before.price !== saved.price) {
        bus.emit(
          'product.price_changed',
          { name: saved.name, oldPrice: before.price, newPrice: saved.price },
          'human'
        )
      }
      return saved
    })
  )
  ipcMain.handle(IPC.knowledgeProductDelete, (_e, id: string) => guard(() => knowledge.deleteProduct(id)))
  ipcMain.handle(IPC.knowledgeFileList, () => knowledge.listFiles())
  ipcMain.handle(IPC.knowledgeFileUpload, async (_e, filePath: string, description?: string) => {
    try {
      return { ok: true, file: await knowledge.uploadFile(String(filePath), description) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.knowledgeFileDelete, (_e, id: string) => guard(() => knowledge.deleteFile(id)))

  // ---------- 记忆 ----------
  ipcMain.handle(IPC.memoryViewers, () => memory.listViewers())
  ipcMain.handle(IPC.memoryEpisodes, () => memory.listEpisodes())

  // ---------- 触发器 ----------
  ipcMain.handle(IPC.triggerList, () => triggers.list())
  ipcMain.handle(IPC.triggerSave, (_e, input: TriggerInput) => {
    triggers.save(input)
    return triggers.list()
  })
  ipcMain.handle(IPC.triggerDelete, (_e, id: string) => {
    triggers.remove(id)
    return triggers.list()
  })
  ipcMain.handle(IPC.triggerToggle, (_e, id: string, enabled: boolean) => {
    triggers.toggle(id, Boolean(enabled))
    return triggers.list()
  })

  // ---------- 事件时间线 ----------
  ipcMain.handle(IPC.eventRecent, (_e, n: number) => bus.recent(n))

  // ---------- 剧本 ----------
  ipcMain.handle(IPC.scriptList, () => script.listScripts())
  ipcMain.handle(IPC.scriptSave, (_e, input: ScriptInput, id?: string) =>
    guard(() => script.saveScript(input, id))
  )
  ipcMain.handle(IPC.scriptDelete, (_e, id: string) => guard(() => script.deleteScript(id)))

  // ---------- 场次 ----------
  ipcMain.handle(IPC.planList, () => script.listPlans())
  ipcMain.handle(IPC.planSave, (_e, input: LivePlanInput, id?: string) =>
    guard(() => script.savePlan(input, id))
  )
  ipcMain.handle(IPC.planDelete, (_e, id: string) =>
    guard(() => {
      script.deletePlan(id)
      // 场次的持久对话（会话 entries + 时间线）跟着场次一起走
      storage.deletePlanSession(String(id ?? ''))
    })
  )
  ipcMain.handle(IPC.planSetActive, (_e, id: string) => {
    script.setActivePlan(String(id ?? ''))
    return storage.getConfig().live.activePlanId
  })
  // 开播预检与启动（docs/07 §8.5）：直播台唯一开播入口
  ipcMain.handle(IPC.planPreflight, (_e, id: string) => launch.preflight(String(id ?? '')))
  ipcMain.handle(IPC.planLaunch, async (_e, id: string) => {
    const wasRunning = agent.status().state !== 'stopped'
    const result = await launch.launch(String(id ?? ''))
    // 真的开起来了才发开播事件（开场白触发器靠它）
    if (result.ok && !wasRunning) bus.emit('stream.started', {}, 'human')
    return result
  })
  /** 切场景（直播台按钮）：跳场景 + 装载新场景话术库 */
  ipcMain.handle(IPC.planGotoScene, (_e, planId: string, index: number) =>
    launch.gotoScene(String(planId ?? ''), Math.floor(Number(index) || 0))
  )

  // ---------- 直播模式（模式预设包） ----------
  ipcMain.handle(IPC.modeList, () => modes.list())
  ipcMain.handle(IPC.modeSave, (_e, input: LiveModeInput, id?: string) =>
    guard(() => modes.save(input, id))
  )
  ipcMain.handle(IPC.modeDelete, (_e, id: string) => guard(() => modes.remove(String(id ?? ''))))
  ipcMain.handle(IPC.modeDuplicate, (_e, id: string) =>
    guard(() => modes.duplicate(String(id ?? '')))
  )

  // ---------- 话术库（场次底稿） ----------
  ipcMain.handle(IPC.utteranceList, (_e, planId: string) => utterances.list(String(planId)))
  ipcMain.handle(IPC.utteranceSave, (_e, input: UtteranceInput, id?: string) =>
    guard(() => utterances.save(input, id))
  )
  ipcMain.handle(IPC.utteranceDelete, (_e, id: string) => guard(() => utterances.remove(id)))
  ipcMain.handle(IPC.utteranceClear, (_e, planId: string, sceneId?: string) =>
    guard(() => utterances.clear(String(planId), sceneId))
  )
  ipcMain.handle(IPC.utterancePresynth, async (_e, planId: string) => {
    // 批量预合成：异步跑（带场次锁，主播改底稿触发的重合成共用同一条流水线），进度走 utteranceEvent
    void utterances.kickSynthesis(String(planId))
    return { ok: true }
  })

  // ---------- 编剧模式：主播自己写底稿 ----------
  ipcMain.handle(IPC.agentDraftStart, async (_e, planId: string) => {
    try {
      await agent.startDrafting(String(planId))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---------- 系统对话框 ----------
  ipcMain.handle(IPC.dialogPickFile, async (_e, filtersName: string, extensions: string[]) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: String(filtersName ?? '文件'), extensions: Array.isArray(extensions) ? extensions.map(String) : ['*'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---------- 推流 ----------
  // TTS / BGM 不再由渲染层转手：AudioPipeline 直连混音器（stream.pushTtsPcm / stream.setBgm）
  ipcMain.handle(IPC.streamStart, () => stream.start())
  ipcMain.handle(IPC.streamStop, () => stream.stop())
  ipcMain.handle(IPC.streamStats, () => stream.getStats())
  ipcMain.on(IPC.streamMicPcm, (_e, pcm: Uint8Array) => stream.pushMicPcm(pcm))

  // ---------- 平台连接器 ----------
  ipcMain.handle(IPC.connectorStatus, () => connector.status())
  ipcMain.handle(IPC.connectorRestart, () => {
    connector.restart()
    return connector.status()
  })
  ipcMain.handle(IPC.connectorCallTool, async (_e, name: string, args: Record<string, unknown>) => {
    try {
      return { ok: true, text: await connector.callTool(String(name), args ?? {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

const single = app.requestSingleInstanceLock()
if (!single) {
  app.quit()
} else {
  // 开发期开 CDP 端口，便于外部检查渲染层 DOM/布局（打包版不开）
  if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', '9222')
  app.on('second-instance', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    watchSystemChrome()

    const storage = new StorageService()
    const tts = new TtsService(storage)
    ttsRealtime = new TtsRealtimeService(storage, tts)
    pool = new SpeechPool(storage, tts, broadcastPool, ttsRealtime)
    const prompts = new PromptTemplateService(storage)
    const persona = new PersonaService(storage, prompts)
    const knowledge = new KnowledgeService(storage)
    const memory = new MemoryService(storage)
    const modes = new ModeService(storage)
    const script = new ScriptService(storage)
    bus = new EventBus(storage)
    // 场次底稿库（提前建：主播 Agent 的底稿工具、生成 Agent、场次启动都用它）
    const utterances = new UtteranceService(storage, tts, persona)
    utterances.onEvent = (u) => broadcastUtterance(u)
    utterances.onBatchDone = (planId) => broadcastUtteranceDone(planId)
    agent = new AgentService(
      storage,
      pool,
      persona,
      prompts,
      knowledge,
      memory,
      modes,
      script,
      utterances,
      broadcastAgent,
      // 对话时间线：文本流式 + 工具卡片，照 pi 事件流原样推到渲染层（docs/09 §11）
      broadcastDirectorTimeline
    )
    triggers = new TriggerRuntime(storage, bus, pool, agent)
    // 模式接线：触发器总闸/进场过滤跟着当前场次模式走；老粉判定接观众画像
    triggers.wiringProvider = () => agent!.currentWiring()
    triggers.fanChecker = (author) => Boolean(memory.lookupViewer(author))
    streamSvc = new StreamService(storage, broadcastStream)

    // 音频管线（唯一音频权威）：解码/排播/混音/音量都在这。
    // 同一片 PCM 同时喂推流（混音器）与本机监听（IPC → 渲染层声卡）。
    pipeline = new AudioPipeline({
      feedStream: (pcmStereo48k) => streamSvc?.pushTtsPcm(pcmStereo48k),
      setStreamBgm: (action, filePath, volume) => streamSvc?.setBgm(action, filePath, volume) ?? Promise.resolve(),
      sendPcm: broadcastPcm,
      sendLevel: broadcastLevel,
      sendEnd: broadcastAudioEnd
    })
    // 播放循环搬到了主进程：渲染层不再参与播放调度
    playback = new PlaybackLoop(pool, () => ttsStream, pipeline)
    playback.start()

    // 评论统一在 EventBus 收口：comment.new → 喂主播 + 广播评论流（任何事件源下游都无感知）
    bus.subscribe((event) => {
      if (event.type !== 'comment.new') return
      const comment: LiveComment = {
        id: String(event.payload.id ?? event.id),
        author: String(event.payload.author ?? '匿名'),
        content: String(event.payload.content ?? ''),
        ts: typeof event.payload.ts === 'number' ? event.payload.ts : event.ts
      }
      if (!comment.content) return
      agent?.onComment(comment)
      broadcastComment(comment)
    })

    // 平台连接器：MCP 客户端，事件流注入事件总线，断线退避重连
    connector = new ConnectorService(storage, bus, broadcastConnector)
    connector.start()
    // 端口改了重连
    storage.onConfigChange(() => connector?.restart())

    // 音色库（M8 声音克隆）：训练状态变化推给渲染进程；试听由主进程合成完直接出声（aux 槽）
    voiceSvc = new VoiceService(storage, tts, broadcastVoices, async (itemId, filePath) => {
      const request = pipeline!.playFile(itemId, filePath, { slot: 'aux' })
      const started = await request.started
      if (started.ok) await request.done
      return started
    })

    // 场次底稿库 + 场次启动（docs/07 §8.5）
    const launch = new LaunchService(storage, script, persona, utterances, pool, agent, connector, streamSvc, tts)
    // 场景推进（advance_scene）后把新场景话术库载入池，骨架不断档
    agent.onSceneAdvanced = () => {
      const loaded = launch.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 新场景装载话术 ${loaded} 条`)
    }
    // 主播自己开播（start_live 工具）：跟「启动场次」按钮走同一条 LaunchService.launch，预检拦截如实回报
    agent.onGoLive = async () => {
      const planId = storage.getConfig().live.activePlanId
      if (!planId) return '没有选中场次，开不了播'
      const wasRunning = agent!.status().state !== 'stopped'
      const result = await launch.launch(planId)
      if (!result.ok) return `开播被预检拦下了：${result.error}`
      if (!wasRunning) bus!.emit('stream.started', {}, 'agent')
      return `已开播：装载 ${result.loaded} 条底稿，播出通道已打开，评论开始进来了`
    }
    // 滚动补货：池见底时把当前场景的就绪底稿装回去循环轮播，别等主播现场救火
    bus.subscribe((event) => {
      if (event.type !== 'pool.empty') return
      const status = agent?.status()
      if (status?.state !== 'running' || status.purpose !== 'live') return
      const loaded = launch.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 池见底，装回 ${loaded} 条底稿继续轮播`)
    })
    // 主播请示（ask_director）：AgentService 内部直接进对话时间线单通道（高亮卡片，不阻塞直播）
    // 播报控制（pause/resume/skip）：主播工具改播放状态，转给渲染进程的播放循环
    agent.onPlaybackControl = (action) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.playbackControlEvent, action)
      }
    }

    // 实时 TTS：流式合成（整段合成 → 解码 → 分块吐 PCM，由 AudioPipeline 按真实速率排播；
    // 供应商流式接口见 docs/06）。它只对主进程内部开口，渲染层拿不到 PCM 通道。
    ttsStream = new TtsStreamService(tts)

    // 定时节拍：5 分钟一跳
    timerInterval = setInterval(() => bus?.emit('timer.interval', {}, 'timer'), 5 * 60_000)

    // 音频缓存：启动扫一次、之后每 30 分钟一次（按最久未用+容量上限清理；被话术条目引用的文件不删）
    void tts.sweepAudioCache()
    audioCacheSweep = setInterval(() => void tts.sweepAudioCache(), 30 * 60_000)
    audioCacheSweep.unref?.()
    timerInterval.unref?.()

    // 主题改了立刻让窗口 chrome 跟上（标题栏按钮、窗口底色）
    storage.onConfigChange((config) => paintAllWindows(config.theme))
    registerIpc(storage, tts, pool, agent, persona, prompts, knowledge, memory, modes, bus, triggers, script, streamSvc, connector, utterances, launch)
    createWindow(storage)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(storage)
    })
  })
}

app.on('window-all-closed', () => {
  if (timerInterval) clearInterval(timerInterval)
  connector?.stop()
  // 播放循环先停（它会把正在播的那条退回 ready），再收音频管线（杀掉解码进程、断了推流 BGM）
  playback?.dispose()
  pipeline?.dispose()
  void streamSvc?.stop()
  triggers?.dispose()
  pool?.dispose()
  void agent?.stop()
  if (process.platform !== 'darwin') app.quit()
})
