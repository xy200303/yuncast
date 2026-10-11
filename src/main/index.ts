import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc-channels'
import {
  type AgentStatus,
  type AppConfig,
  type AppInfo,
  type LiveComment,
  type PartialDeep,
  type Persona,
  type PoolResult,
  type PoolSayInput,
  type PoolSnapshot,
  type ProductInput,
  type SpeechItem,
  type SpeechLane
} from '../shared/types'
import { StorageService } from './services/StorageService'
import { TtsService } from './services/TtsService'
import { SpeechPool } from './services/SpeechPool'
import { PersonaService } from './services/PersonaService'
import { AgentService } from './services/AgentService'
import { CommentSimulator } from './services/CommentSimulator'
import { KnowledgeService } from './services/KnowledgeService'
import { MemoryService } from './services/MemoryService'

// 固定到 %APPDATA%\AgentAnchor。必须在 ready 之前设置，
// 否则开发时叫 agent-anchor、打包后叫 Agent Anchor，配置会看起来"丢了"。
app.setPath('userData', join(app.getPath('appData'), 'AgentAnchor'))

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

/** 池快照广播给所有窗口 */
function broadcastPool(snapshot: PoolSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.poolSnapshotEvent, snapshot)
  }
  // 主播节奏驱动：池水位低时催主播补货
  agent?.onPoolSnapshot(snapshot)
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

let agent: AgentService | null = null

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
  memory: MemoryService
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
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.agentStop, () => agent.stop())
  ipcMain.handle(IPC.agentRestart, async () => {
    try {
      await agent.restart()
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
    guard(() => knowledge.saveProduct(input, id))
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
    agent = new AgentService(storage, pool, persona, knowledge, memory, broadcastAgent)
    const sim = new CommentSimulator((comment) => {
      // 评论进主播（主播自己决定回不回），同时广播给渲染进程弹 toast
      agent?.onComment(comment)
      broadcastComment(comment)
    })

    // media:// 只服务 audio-cache 目录里的 basename，拒绝任何路径穿越
    protocol.handle('media', (request) => {
      const url = new URL(request.url)
      const requestedName = decodeURIComponent(url.pathname).replace(/^\//, '')
      if (!requestedName || requestedName !== basename(requestedName)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(join(tts.audioCacheDir(), requestedName)).toString())
    })

    // 主题改了立刻让窗口 chrome 跟上（标题栏按钮、窗口底色）
    storage.onConfigChange((config) => paintAllWindows(config.theme))
    registerIpc(storage, tts, pool, agent, persona, sim, knowledge, memory)
    createWindow(storage)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(storage)
    })
  })
}

app.on('window-all-closed', () => {
  pool?.dispose()
  void agent?.stop()
  if (process.platform !== 'darwin') app.quit()
})
