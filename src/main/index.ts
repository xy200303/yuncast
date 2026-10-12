import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc-channels'
import {
  type AgentStatus,
  type AppConfig,
  type AppInfo,
  type ConnectorStatus,
  type DirectorMessage,
  type LiveComment,
  type PartialDeep,
  type Persona,
  type PoolResult,
  type PoolSayInput,
  type PoolSnapshot,
  type ProductInput,
  type ScriptInput,
  type LivePlanInput,
  type SpeechItem,
  type SpeechLane,
  type StreamStats,
  type TriggerInput,
  type Utterance,
  type UtteranceInput,
  type VoiceRecord
} from '../shared/types'
import { StorageService } from './services/StorageService'
import { TtsService } from './services/TtsService'
import { SpeechPool } from './services/SpeechPool'
import { PersonaService } from './services/PersonaService'
import { AgentService } from './services/AgentService'
import { KnowledgeService } from './services/KnowledgeService'
import { MemoryService } from './services/MemoryService'
import { EventBus } from './services/EventBus'
import { TriggerRuntime } from './services/TriggerRuntime'
import { ScriptService } from './services/ScriptService'
import { StreamService } from './services/stream/StreamService'
import { ConnectorService } from './services/ConnectorService'
import { VoiceService } from './services/VoiceService'
import { TtsStreamService } from './services/TtsStreamService'
import { TtsRealtimeService } from './services/TtsRealtimeService'
import { UtteranceService } from './services/UtteranceService'
import { GenerationService, type GenerationProgress } from './services/GenerationService'
import { LaunchService } from './services/LaunchService'
import { audioMixer } from './services/stream/ffmpeg/mixer'

// 固定到 %APPDATA%\AgentAnchor。必须在 ready 之前设置，
// 否则开发时叫 agent-anchor、打包后叫 Agent Anchor，配置会看起来"丢了"。
// 测试/并行实例可用 AGENT_ANCHOR_USER_DATA 指向别的目录。
app.setPath('userData', process.env['AGENT_ANCHOR_USER_DATA'] ?? join(app.getPath('appData'), 'AgentAnchor'))

// 自定义媒体协议：渲染进程经 WebAudio 播放 audio-cache 内的合成音频（火山 mp3 / 百炼 wav）。
// dev 环境页面是 http://，无法直接引用 file:// 资源。
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

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

/** 池快照广播给所有窗口；顺带探测 pool.empty（空了一次只发一次，恢复后再次为空可再发） */
let poolWasEmpty = true
function broadcastPool(snapshot: PoolSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.poolSnapshotEvent, snapshot)
  }
  const empty = snapshot.items.length === 0
  if (empty && !poolWasEmpty) bus?.emit('pool.empty', {}, 'pool')
  poolWasEmpty = empty
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

/** 导演对话消息广播（主播汇报/请示 → 导演对话面板） */
function broadcastDirector(message: DirectorMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.directorEvent, message)
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
        text: '',
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

/** 话术库生成进度广播 */
function broadcastGeneration(progress: GenerationProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.generationEvent, progress)
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

/** 线性插值重采样到 48k（混音器口径固定 48k mono s16le） */
function resampleTo48k(pcm: Buffer, fromRate: number): Buffer {
  if (fromRate === 48000) return pcm
  const inSamples = Math.floor(pcm.length / 2)
  if (inSamples === 0) return pcm
  const ratio = 48000 / fromRate
  const outSamples = Math.floor(inSamples * ratio)
  const out = Buffer.alloc(outSamples * 2)
  for (let i = 0; i < outSamples; i++) {
    const pos = i / ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = pcm.readInt16LE(Math.min(idx, inSamples - 1) * 2)
    const b = pcm.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))), i * 2)
  }
  return out
}

/** 音色库变化广播（训练状态更新/新增/删除） */
function broadcastVoices(voices: VoiceRecord[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.voiceChanged, voices)
  }
}

let agent: AgentService | null = null
let bus: EventBus | null = null
let triggers: TriggerRuntime | null = null
let timerInterval: ReturnType<typeof setInterval> | null = null
let connector: ConnectorService | null = null
let voiceSvc: VoiceService | null = null
let ttsStream: TtsStreamService | null = null
let ttsRealtime: TtsRealtimeService | null = null
let streamSvc: StreamService | null = null

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
  knowledge: KnowledgeService,
  memory: MemoryService,
  bus: EventBus,
  triggers: TriggerRuntime,
  script: ScriptService,
  stream: StreamService,
  connector: ConnectorService,
  utterances: UtteranceService,
  generation: GenerationService,
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
  ipcMain.handle(IPC.poolSnapshot, () => pool.snapshot())

  // ---------- TTS ----------
  ipcMain.handle(IPC.ttsTest, (_e, text: string) => tts.test(String(text ?? '').slice(0, 200)))

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
  // 统一开播控制里的「暂停」：停播报的同时停主播产出（评论/触发器不派、say 被拒）
  ipcMain.handle(IPC.playbackSetPaused, (_e, paused: boolean) => {
    agent.setSpeakingPaused(Boolean(paused))
  })

  // ---------- 导演对话 ----------
  ipcMain.handle(IPC.directorSend, (_e, text: string) =>
    guard(() => agent.directorSay(String(text ?? '').slice(0, 500)))
  )

  // ---------- 人设卡 ----------
  ipcMain.handle(IPC.personaGet, () => persona.get())
  ipcMain.handle(IPC.personaList, () => persona.list())
  ipcMain.handle(
    IPC.personaSave,
    (_e, input: Omit<Persona, 'id' | 'updatedAt'>, id?: string) => persona.save(input, id)
  )
  ipcMain.handle(IPC.personaSetActive, (_e, id: string) => persona.setActive(id))
  ipcMain.handle(IPC.personaRemove, (_e, id: string) => persona.remove(id))

  // ---------- 实时 TTS 流式合成 ----------
  ipcMain.handle(IPC.ttsStreamStart, async (_e, sessionId: string, text: string, voiceId?: string) => {
    void ttsStream?.start(sessionId, text, voiceId, {
      onChunk: (pcm, sampleRate) => {
        // 直推模式：PCM 同时进混音器（混音器口径固定 48k，非 48k 先重采样）
        if (storage.getConfig().stream.mode === 'direct') {
          audioMixer.pushTtsPcm(sampleRate === 48000 ? pcm : resampleTo48k(pcm, sampleRate))
        }
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC.ttsStreamChunk, { sessionId, pcm, sampleRate })
        }
      },
      onEnd: () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC.ttsStreamEnd, { sessionId })
        }
      },
      onError: (error) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC.ttsStreamEnd, { sessionId, error })
        }
      }
    })
    return { ok: true }
  })
  ipcMain.handle(IPC.ttsStreamStop, (_e, sessionId: string) => {
    ttsStream?.stop(sessionId)
    return { ok: true }
  })

  // ---------- 音色库（M8 声音克隆） ----------
  ipcMain.handle(IPC.voiceList, () => voiceSvc?.list() ?? [])
  ipcMain.handle(
    IPC.voiceClone,
    (_e, input: { name: string; samplePath: string; authorized: boolean }) =>
      voiceSvc?.clone(input) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceRemove, (_e, id: string) => voiceSvc?.remove(id) ?? { ok: false, error: '音色服务未初始化' })
  ipcMain.handle(IPC.voiceSetDefault, (_e, id: string) => voiceSvc?.setDefault(id) ?? { ok: false, error: '音色服务未初始化' })
  ipcMain.handle(IPC.voiceUploadSample, async (_e, bytes: Uint8Array, ext: string) => {
    if (!voiceSvc) return { ok: false, error: '音色服务未初始化' }
    const path = await voiceSvc.saveSample(bytes, ext)
    return { ok: true, path }
  })

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
  ipcMain.handle(IPC.planDelete, (_e, id: string) => guard(() => script.deletePlan(id)))
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
    // 批量预合成：异步跑，逐条进度走 utteranceEvent；这里只回启动结果
    void utterances
      .synthesizeAll(String(planId), broadcastUtterance)
      .then(() => broadcastUtteranceDone(String(planId)))
      .catch(() => broadcastUtteranceDone(String(planId)))
    return { ok: true }
  })

  // ---------- 话术库生成 Agent ----------
  ipcMain.handle(IPC.generationStart, (_e, planId: string) => {
    try {
      generation.start(String(planId))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.generationCancel, () => generation.cancel())

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
  ipcMain.handle(IPC.streamStart, () => stream.start())
  ipcMain.handle(IPC.streamStop, () => stream.stop())
  ipcMain.handle(IPC.streamStats, () => stream.getStats())
  ipcMain.handle(IPC.streamPushTts, (_e, filePath: string) => stream.pushTts(String(filePath)))
  ipcMain.handle(IPC.streamSetBgm, (_e, action: 'start' | 'stop' | 'volume', filePath?: string, volume?: number) =>
    stream.setBgm(action, filePath, volume)
  )
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
    ttsRealtime = new TtsRealtimeService(storage)
    pool = new SpeechPool(storage, tts, broadcastPool, ttsRealtime)
    const persona = new PersonaService(storage)
    const knowledge = new KnowledgeService(storage)
    const memory = new MemoryService(storage)
    const script = new ScriptService(storage)
    bus = new EventBus(storage)
    agent = new AgentService(storage, pool, persona, knowledge, memory, script, broadcastAgent, (text) =>
      broadcastDirector({
        id: `dm-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ts: Date.now(),
        kind: 'report',
        text
      })
    )
    triggers = new TriggerRuntime(storage, bus, pool, agent)
    streamSvc = new StreamService(storage, broadcastStream)

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

    // 音色库（M8 声音克隆）：训练状态变化推给渲染进程
    voiceSvc = new VoiceService(storage, broadcastVoices)

    // 话术库（场次底稿）+ 生成 Agent（docs/07 §4，P1）+ 场次启动（§8.5）
    const utterances = new UtteranceService(storage, tts, persona)
    const generation = new GenerationService(storage, knowledge, utterances, persona, script, broadcastGeneration)
    const launch = new LaunchService(storage, script, persona, utterances, pool, agent, connector, streamSvc)
    // 场景推进（advance_scene）后把新场景话术库载入池，骨架不断档
    agent.onSceneAdvanced = () => {
      const loaded = launch.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 新场景装载话术 ${loaded} 条`)
    }
    // 主播请示（ask_director）：进导演对话面板高亮卡片；不阻塞直播（docs/07 §8.8.6 ④）
    agent.onDirectorAsk = (ask) => {
      broadcastDirector({
        id: `dm-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ts: Date.now(),
        kind: 'ask',
        text: ask.text,
        options: ask.options,
        timeoutSec: ask.timeoutSec,
        defaultAction: ask.defaultAction
      })
    }
    // 播报控制（pause/resume/skip）：主播工具改播放状态，转给渲染进程的播放循环
    agent.onPlaybackControl = (action) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.playbackControlEvent, action)
      }
    }

    // 实时 TTS：流式合成（当前=整段合成后按真实速率分块吐，管线真流式；供应商流式接口见 docs/06）
    ttsStream = new TtsStreamService(tts)

    // 定时节拍：5 分钟一跳
    timerInterval = setInterval(() => bus?.emit('timer.interval', {}, 'timer'), 5 * 60_000)
    timerInterval.unref?.()

    // media:// 只服务两类资源：audio-cache 里的合成音频（basename）；config.bgm.path 指向的 BGM 文件
    protocol.handle('media', (request) => {
      const url = new URL(request.url)
      const pathname = decodeURIComponent(url.pathname)
      if (url.hostname === 'local') {
        const requestedPath = pathname.replace(/^\//, '')
        const allowedPath = storage.getConfig().bgm.path
        const normalize = (value: string): string => {
          const normalized = resolve(value)
          return process.platform === 'win32' ? normalized.toLowerCase() : normalized
        }
        if (!allowedPath || normalize(requestedPath) !== normalize(allowedPath)) {
          return new Response('Forbidden', { status: 403 })
        }
        return net.fetch(pathToFileURL(requestedPath).toString())
      }
      const requestedName = pathname.replace(/^\//, '')
      if (!requestedName || requestedName !== basename(requestedName)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(join(tts.audioCacheDir(), requestedName)).toString())
    })

    // 主题改了立刻让窗口 chrome 跟上（标题栏按钮、窗口底色）
    storage.onConfigChange((config) => paintAllWindows(config.theme))
    registerIpc(storage, tts, pool, agent, persona, knowledge, memory, bus, triggers, script, streamSvc, connector, utterances, generation, launch)
    createWindow(storage)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(storage)
    })
  })
}

app.on('window-all-closed', () => {
  if (timerInterval) clearInterval(timerInterval)
  connector?.stop()
  void streamSvc?.stop()
  triggers?.dispose()
  pool?.dispose()
  void agent?.stop()
  if (process.platform !== 'darwin') app.quit()
})
