import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc-channels'
import {
  type AgentStatus,
  type AppConfig,
  type AppInfo,
  type ConnectorStatus,
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
  type TriggerInput
} from '../shared/types'
import { StorageService } from './services/StorageService'
import { TtsService } from './services/TtsService'
import { SpeechPool } from './services/SpeechPool'
import { PersonaService } from './services/PersonaService'
import { AgentService } from './services/AgentService'
import { CommentSimulator } from './services/CommentSimulator'
import { KnowledgeService } from './services/KnowledgeService'
import { MemoryService } from './services/MemoryService'
import { EventBus } from './services/EventBus'
import { TriggerRuntime } from './services/TriggerRuntime'
import { ScriptService } from './services/ScriptService'
import { StreamService } from './services/stream/StreamService'
import { ConnectorService } from './services/ConnectorService'

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

let agent: AgentService | null = null
let bus: EventBus | null = null
let triggers: TriggerRuntime | null = null
let timerInterval: ReturnType<typeof setInterval> | null = null
let connector: ConnectorService | null = null
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
  sim: CommentSimulator,
  knowledge: KnowledgeService,
  memory: MemoryService,
  bus: EventBus,
  triggers: TriggerRuntime,
  script: ScriptService,
  stream: StreamService,
  connector: ConnectorService
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

  // ---------- 人设卡 ----------
  ipcMain.handle(IPC.personaGet, () => persona.get())
  ipcMain.handle(IPC.personaSave, (_e, input: Omit<Persona, 'id' | 'updatedAt'>) => persona.save(input))

  // ---------- 评论模拟器 ----------
  ipcMain.handle(IPC.simStart, () => {
    sim.start()
    return sim.status()
  })
  ipcMain.handle(IPC.simStop, () => {
    sim.stop()
    return sim.status()
  })
  ipcMain.handle(IPC.simStatus, () => sim.status())

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
    pool = new SpeechPool(storage, tts, broadcastPool)
    const persona = new PersonaService(storage)
    const knowledge = new KnowledgeService(storage)
    const memory = new MemoryService(storage)
    const script = new ScriptService(storage)
    bus = new EventBus(storage)
    agent = new AgentService(storage, pool, persona, knowledge, memory, script, broadcastAgent)
    triggers = new TriggerRuntime(storage, bus, pool, agent)
    streamSvc = new StreamService(storage, broadcastStream)

    // 评论统一在 EventBus 收口：comment.new → 喂主播 + 广播评论流（连接器/模拟器下游无感知）
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

    // 模拟器 = 内置假连接器（docs/04）：产出只进事件总线
    const sim = new CommentSimulator((event) => {
      if (event.type === 'comment.new') {
        bus?.emit(
          'comment.new',
          { id: event.comment.id, author: event.comment.author, content: event.comment.content, ts: event.comment.ts, simulated: true },
          'system'
        )
      } else {
        bus?.emit(event.type, event.payload, 'system')
      }
    })

    // 平台连接器：订阅本地连接器 WS 事件流，断线退避重连
    connector = new ConnectorService(storage, bus, broadcastConnector)
    connector.start()
    // 端口改了重连
    storage.onConfigChange(() => connector?.restart())

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
    registerIpc(storage, tts, pool, agent, persona, sim, knowledge, memory, bus, triggers, script, streamSvc, connector)
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
