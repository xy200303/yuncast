import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { IPC } from '../shared/ipc-channels'
import { BRAND_DISPLAY } from '../shared/brand'
import { POOL_LIMITS } from '../shared/types'

/** 崩溃现场日志（无声退出排查）：追加写 userData/crash.log，只记事件类型不带业务数据 */
function crashNote(kind: string, detail: string): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'crash.log'), `${new Date().toISOString()} ${kind} ${detail.slice(0, 800)}\n`)
  } catch {
    // 记不进去就算了
  }
}

/**
 * macOS / Linux 没有安装器钩子，在应用启动时把 Go CLI 软链进 PATH 常见目录：
 * mac 优先 /usr/local/bin（管理员可写），linux 用 ~/.local/bin（现代发行版默认在 PATH）。
 * Windows 不走这里——NSIS 安装/卸载时直接读写注册表 PATH（build/installer.nsh）。
 */
function linkCliToPath(): void {
  if (!app.isPackaged || process.platform === 'win32') return
  const target = join(process.resourcesPath, 'bin', 'yuncast')
  if (!existsSync(target)) return
  const dirs =
    process.platform === 'darwin'
      ? ['/usr/local/bin', join(homedir(), '.local', 'bin')]
      : [join(homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true })
      const link = join(dir, 'yuncast')
      if (existsSync(link)) {
        try {
          if (readlinkSync(link) === target) return // 已就位
        } catch {
          // 不是软链：不动别人的文件
        }
        return
      }
      symlinkSync(target, link)
      return
    } catch {
      // 这个目录不可写就试下一个
    }
  }
}
process.on('uncaughtException', (error) =>
  crashNote('uncaughtException', error.stack ?? String(error))
)
process.on('unhandledRejection', (reason) =>
  crashNote('unhandledRejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
)
process.on('exit', (code) => crashNote('exit', `code=${code}`))
app.on('before-quit', () => crashNote('before-quit', ''))
app.on('child-process-gone', (_e, details) => crashNote('child-process-gone', JSON.stringify(details)))

// 日志管道断裂（EPIPE）绝不能杀掉进程：桌面应用的 stdout 随时可能没有读者
// （父进程先走/打包后无控制台/dev 任务被收），console.error 扔 EPIPE 不该炸掉应用——
// 已实测：连接器的 onerror → console.error → EPIPE → uncaughtException → 整进程死
for (const method of ['error', 'warn', 'log'] as const) {
  const original = console[method]
  console[method] = (...args: unknown[]) => {
    try {
      original.apply(console, args)
    } catch {
      // 管道断了就算了
    }
  }
}
import {
  type AgentStatus,
  type AppConfig,
  type AppInfo,
  type AudioEndPayload,
  type AudioLevelPayload,
  type AudioPcmPayload,
  type AudioProgressPayload,
  type ConnectorStatus,
  type DirectorConfig,
  type DirectorTimelineEvent,
  type DirectorTimelineReset,
  type LiveComment,
  type McpConfig,
  type McpRuntime,
  type ModelConnectionInput,
  type PartialDeep,
  type Persona,
  type PoolResult,
  type PoolSayInput,
  type PoolSnapshot,
  type MaterialInput,
  type ProgramExportOptions,
  type ProgramInput,
  type ProduceVoiceOverride,
  type SessionExportOptions,
  type StatsQuery,
  type StreamStats,
  type TriggerInput,
  type TtsConnectionInput,
  type TtsProvider,
  type DraftUnit,
  type DraftUnitInput,
  type ScriptScene,
  type LaunchResult,
  type VoiceRecord
} from '../shared/types'
import { StorageService } from './services/StorageService'
import { BlobStoreService } from './services/BlobStoreService'
import { TtsService, type TtsTestInput } from './services/TtsService'
import { SpeechPool } from './services/SpeechPool'
import { PersonaService } from './services/PersonaService'
import { PromptTemplateService } from './services/PromptTemplateService'
import { AgentService } from './services/AgentService'
import { KnowledgeService } from './services/KnowledgeService'
import { MemoryService } from './services/MemoryService'
import { EventBus } from './services/EventBus'
import { TriggerRuntime } from './services/TriggerRuntime'
import { ScriptService } from './services/ScriptService'
import { StreamService } from './services/stream/StreamService'
import { ConnectorService } from './services/ConnectorService'
import { VoiceService, type VoiceCloneInput } from './services/VoiceService'
import { TempUploadService } from './services/TempUpload'
import { AudioStyleService } from './services/AudioStyleService'
import type { DataChangeScope } from '../shared/types'
import { TtsStreamService } from './services/TtsStreamService'
import { DraftUnitService } from './services/DraftUnitService'
import { ProgramPlaybackService } from './services/ProgramPlaybackService'
import { SessionRecorder } from './services/SessionRecorder'
import { policyFor } from './services/broadcastPolicy'
import { ExportService } from './services/ExportService'
import { UpdateService } from './services/UpdateService'
import { listProviderModels, testModelConnection } from './services/llmModel'
import { friendlyError } from './services/errorTranslate'
import { getLlmProvider, getTtsProvider, listLlmProviders, listTtsProviders, secretFieldKeys, ttsSecretFieldKeys } from './services/providers/registry'
import { AudioPipeline } from './services/audio/AudioPipeline'
import { PlaybackLoop } from './services/audio/PlaybackLoop'
import { McpService } from './services/McpService'
import { EventHub } from './services/EventHub'
import { RecordingService } from './services/RecordingService'

// 固定到 %APPDATA%\YunCast。必须在 ready 之前设置，
// 否则开发时和打包后目录名不一致，配置会看起来"丢了"。
// 旧品牌目录 AgentAnchor 做一次性整体搬迁；测试/并行实例可用 YUN_CAST_USER_DATA（兼容 AGENT_ANCHOR_USER_DATA）指向别的目录。
const userDataOverride = process.env['YUN_CAST_USER_DATA'] ?? process.env['AGENT_ANCHOR_USER_DATA']
const userDataDir = join(app.getPath('appData'), 'YunCast')
if (!userDataOverride && !existsSync(userDataDir)) {
  const legacyDir = join(app.getPath('appData'), 'AgentAnchor')
  if (existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, userDataDir)
    } catch {
      // 目录被占用等原因搬不动就放弃，新目录从零开始
    }
  }
}
app.setPath('userData', userDataOverride ?? userDataDir)

let mainWindow: BrowserWindow | null = null
let pool: SpeechPool | null = null
let updater: UpdateService | null = null

/** Windows 上标题栏覆盖层偶发把第一帧停在白底。显示后改一次尺寸让系统重画；画面仍是空的就重新加载。 */
function recoverBlankWindow(win: BrowserWindow): void {
  let loaded = false
  let nudged = false
  let reloads = 0

  const reload = (why: string) => {
    if (win.isDestroyed() || reloads >= 2) return
    reloads += 1
    console.error(`[YunCast] 窗口没有画出来（${why}），重新加载`)
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, 200)
  }

  const show = () => {
    if (win.isDestroyed()) return
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
    title: BRAND_DISPLAY,
    // 开发模式下 exe 还是 Electron 默认图标，窗口图标显式指到 resources；打包后 exe 自带图标
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'resources', 'icon.png') }),
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

  // 通用录屏授权闸门：渲染层 getDisplayMedia 只在 RecordingService 发起的录制会话激活期
  // 自动放行「本应用窗口 + 系统回放声」，不弹系统选择器；其余请求一律拒绝（正式包同样走这道闸门）。
  // 只采本窗口（WGC 窗口采集）：其它窗口遮挡、用户鼠标的真实操作都不会进画面。
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (!screenRecorder?.isArmed) {
      callback({})
      return
    }
    desktopCapturer
      .getSources({ types: ['window'] })
      .then((sources) => {
        const title = win.isDestroyed() ? '' : win.getTitle()
        const self = sources.find((s) => s.name === title) ?? sources.find((s) => title && s.name.includes(title))
        if (!self) {
          callback({})
          return
        }
        callback({ video: self, audio: 'loopback' })
      })
      .catch(() => callback({}))
  })

  // 崩溃现场（无声退出排查）：渲染进程死了（崩溃/卡死被系统收）都记一笔到 userData/crash.log
  win.webContents.on('render-process-gone', (_e, details) =>
    crashNote('render-process-gone', JSON.stringify(details))
  )
  win.on('unresponsive', () => crashNote('unresponsive', ''))

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

/** 应用更新 IPC（检查/下载/安装，状态由 UpdateService 广播） */
function registerUpdateIpc(u: UpdateService): void {
  ipcMain.handle(IPC.updateCheck, () => u.check())
  ipcMain.handle(IPC.updateDownload, () => u.download())
  ipcMain.handle(IPC.updateInstall, () => u.install())
}

/** MCP 段变了才重启服务（配置保存很频繁，无关改动不折腾端口） */
function syncMcp(config: McpConfig): void {
  const signature = `${config.enabled}|${config.port}|${config.token}`
  if (signature === mcpApplied) return
  mcpApplied = signature
  void mcp?.apply(config).catch((error) => {
    // 端口被占等：状态（含 error）已经广播给设置页，这里只记日志
    console.warn('[YunCast] MCP 启动失败:', error instanceof Error ? error.message : error)
  })
}

/** 开放接口 IPC（设置 → 开放接口） */
function registerMcpIpc(storage: StorageService): void {
  ipcMain.handle(IPC.mcpGet, () => storage.getConfig().mcp)
  ipcMain.handle(
    IPC.mcpSave,
    async (_e, input: { enabled?: boolean; port?: number; regenerateToken?: boolean }) => {
      const current = storage.getConfig().mcp
      const port = Number(input?.port ?? current.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false as const, error: '端口需要在 1–65535' }
      }
      const next: McpConfig = {
        enabled: Boolean(input?.enabled),
        port,
        token: input?.regenerateToken === true ? randomUUID() : current.token
      }
      storage.setConfig({ mcp: next })
      try {
        mcpApplied = `${next.enabled}|${next.port}|${next.token}`
        await mcp?.apply(next)
        return { ok: true as const, config: next }
      } catch (error) {
        return { ok: false as const, error: friendlyError(error) }
      }
    }
  )
  ipcMain.handle(IPC.mcpState, (): McpRuntime => mcp?.state() ?? { running: false, port: storage.getConfig().mcp.port, clients: 0 })
}

/**
 * 播报暂停/继续的唯一实现（IPC 按钮、MCP 外部接口、合成停播三条路共用，避免行为分叉）。
 * 暂停 = 停播放循环 + 停主播产出（评论/触发器不派、speak 被拒）；
 * 继续要把合成彻底失败的条目重新触发一次，否则它们永远停在 halted。
 */
function applyPlaybackPause(paused: boolean): void {
  if (!paused) {
    pool?.retryFailed()
    autoPausedForDry = false // 恢复播报（不管谁点的）都清掉「因无内容自动暂停」标记
  }
  agent?.setSpeakingPaused(paused)
  playback?.setRunning(!paused)
}

/**
 * 「播完了就自动暂停」：池子见底、又没有在合成/没存货时，把播报停到「暂停」态，
 * 而不是保持「播报中」空转（用户看到的就是一直显示在播、其实没声音）。
 * 一旦有新内容进池（合成完成、主播补货、装载）自动继续；用户手动点过暂停则不会被自动继续。
 */
let autoPausedForDry = false

let lastDryCheckAt = 0

/**
 * 池空就核对一次：没有在途内容（无合成中/无未播存货/无预制在出）就停在「暂停」态。
 * 和 pool.empty 事件互补——启动即空、播完没人补货这类「没有从非空变空」的情况不会触发事件，
 * 以前就那样一直显示"播报中"空转。
 */
function ensurePauseWhenDry(): void {
  const now = Date.now()
  if (now - lastDryCheckAt < 2000) return
  lastDryCheckAt = now
  if (autoPausedForDry) return
  const status = agent?.status()
  if (status?.state !== 'running' || status.live !== true) return
  if (status.speakingPaused === true) return
  if ((pool?.snapshot().items.length ?? 0) > 0) return
  const programId = storageRef?.getConfig().live.activeProgramId
  if (!programId || !playerRef || !storageRef) return
  const program = storageRef.programList().find((item) => item.id === programId)
  if (!program) return
  const policy = policyFor(program, playerRef)
  if (policy.poolEmptyAction(program) !== 'wait') return
  const incoming =
    playerRef.hasIncomingDraftUnits(programId) ||
    playerRef.hasFreshDraftUnits(programId) ||
    playerRef.hasIncomingRendered(programId)
  if (incoming) return
  autoPauseWhenDry()
}

function autoPauseWhenDry(): boolean {
  if (agent?.status().speakingPaused === true) return false
  applyPlaybackPause(true)
  autoPausedForDry = true
  console.log('[YunCast] 池空了且没有待播内容：自动暂停播报，等新内容进来再继续')
  // 对话里留一条旁白：用户能看出"为什么停了"，主播也知道自己在等内容的空档
  agent?.notifyTimeline('本场内容播完了，已自动暂停播报；有新内容（补稿/合成完成）会自动继续。')
  return true
}

/** 池快照广播给所有窗口；顺带探测 pool.empty / pool.low（沿只发一次，恢复后可再发） */
let poolWasEmpty = true
let poolWasLow = false
/** 模块级引用：池快照回调里要用（main() 里创建后赋上） */
let storageRef: StorageService | null = null
let playerRef: ProgramPlaybackService | null = null
function broadcastPool(snapshot: PoolSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.poolSnapshotEvent, snapshot)
  }
  // 池里可能刚来了新话术：叫醒主进程的播放循环，不用等满一个睡眠周期
  playback?.kick()
  const remaining = snapshot.items.length
  const empty = remaining === 0
  if (empty) ensurePauseWhenDry()
  if (empty && !poolWasEmpty) bus?.emit('pool.empty', {}, 'pool')
  // 自动暂停后来了新内容（合成完成/主播补货/装载）：接着播，不用人点「继续」
  if (!empty && autoPausedForDry) {
    autoPausedForDry = false
    applyPlaybackPause(false)
    console.log('[YunCast] 有新内容进池：自动恢复播报')
  }
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
function broadcastDraftUnit(draftUnit: DraftUnit): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.draftUnitEvent, draftUnit)
  }
}

/** 批量预合成结束：发一条特殊事件（id='' 表示批次结束，UI 刷新列表） */
function broadcastDraftUnitDone(programId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.draftUnitEvent, {
        id: '',
        programId,
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
      } satisfies DraftUnit)
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
function broadcastDataChanged(scope: DataChangeScope, detail?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.dataChanged, { scope, detail })
  }
}

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

/** 主槽播放进度广播（预制节目长音频进度条用） */
function broadcastProgress(payload: AudioProgressPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.audioProgressEvent, payload)
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
let streamSvc: StreamService | null = null
let pipeline: AudioPipeline | null = null
let recorder: SessionRecorder | null = null
let playback: PlaybackLoop | null = null
let mcp: McpService | null = null
let eventHub: EventHub | null = null
let screenRecorder: RecordingService | null = null
let audioStyle: AudioStyleService | null = null
/** 上次实际应用的 MCP 配置签名（配置保存很频繁，只有 mcp 段变了才重启服务） */
let mcpApplied = ''

/**
 * finishMode=stop 的收播两阶段状态（pool.empty 决策点用）：
 * 第一阶段整轮播完 → 通知主播收尾（说 closer/道别），并挂兜底定时器；
 * 第二阶段收尾也播完（池再次见底）或兜底到点 → 正式收播（stream.ended + 收开播态 + 停会话写复盘）。
 * 开播成功时复位。
 */
let stopWrap: { programId: string; timer: NodeJS.Timeout | null } | null = null

function resetStopWrap(): void {
  if (stopWrap?.timer) clearTimeout(stopWrap.timer)
  stopWrap = null
}

/**
 * 开播的唯一实现：直播台按钮（IPC）、MCP 外部接口、主播 start_live 工具三条路共用。
 * 副作用一次做完：开播事件只在「没在播 → 开播」时发一次（开播信号触发器靠它）、复位收尾状态、
 * 0 就绪开播时顶一条低水位（引擎会续写，不冷场）。以前三处各抄一份，改一处漏两处。
 */
async function launchAndAnnounce(
  player: ProgramPlaybackService,
  programId: string,
  opts: { allowPartial?: boolean; source: 'human' | 'agent' }
): Promise<LaunchResult> {
  const wasLive = agent?.status().live === true
  const result = await player.launch(programId, { allowPartial: opts.allowPartial === true })
  if (!result.ok) return result
  if (!wasLive) bus?.emit('stream.started', {}, opts.source)
  resetStopWrap()
  if ((result.loaded ?? 0) === 0) {
    bus?.emit('pool.low', { remaining: 0 }, 'system')
    // 一条都没装进来，且没有在合成/没存货：直接停到「暂停」态等内容，别让界面显示在播却没声音
    const incoming =
      player.hasIncomingDraftUnits(programId) ||
      player.hasFreshDraftUnits(programId) ||
      player.hasIncomingRendered(programId)
    if (!incoming) autoPauseWhenDry()
  }
  return result
}

/** 收播原因：手动结束 / 整轮播完自动收 / 急停。场记落库端 reasons 见 SessionRecorder */
type EndProgramReason = 'manual' | 'auto_stop' | 'emergency'

/**
 * 收播的唯一实现：手动「结束节目」、整轮播完、紧急停止三条路都走这里。
 * 一次做完全部收尾：停播放循环 → 停会话（先把复盘摘要写进场次）→ 收开播态 → 清池 → 场记收播 → 广播。
 * 以前这三处各写一遍，急停那份不带主播产出状态、退出那份还漏了清池——状态撕裂都是那么来的。
 */
async function endProgram(reason: EndProgramReason): Promise<void> {
  const wasLive = agent?.status().live ?? false
  resetStopWrap()
  playback?.setRunning(false)
  if (reason === 'emergency') {
    pipeline?.stopAll()
    agent?.setSpeakingPaused(true)
    await agent?.panic()
  } else {
    await agent?.stop()
  }
  if (!wasLive) return
  agent?.setLiveActive(false)
  pool?.clearAll(reason === 'emergency' ? '场次已紧急停止' : '场次已结束')
  if (pool) pool.sessionId = null
  recorder?.end(reason)
  bus?.emit('stream.ended', {}, reason === 'manual' ? 'human' : 'system')
}

function finishRoundStop(programId: string): void {
  if (!stopWrap) {
    stopWrap = { programId, timer: null }
    console.log('[YunCast] 整轮播完（finishMode=stop）：通知主播收尾，说完收播')
    agent?.notifyProgramFinished()
    // 主播没接话（暂停中/生成失败等）就 2 分钟后兜底收播，节目不能挂在半空
    stopWrap.timer = setTimeout(() => finishRoundStop(programId), 120_000)
    stopWrap.timer.unref?.()
    return
  }
  if (stopWrap.programId !== programId) return
  console.log('[YunCast] finishMode=stop：收尾播完，节目结束')
  void endProgram('auto_stop')
}

/** 池操作统一包一层：错误不抛给渲染进程，返回 { ok, error } 给 UI 提示（error 过错误翻译层，docs/REDESIGN 4.10） */
function guard<T>(fn: () => T): { ok: true; item: T } | { ok: false; error: string }
function guard(fn: () => void): PoolResult
function guard(fn: () => unknown): { ok: true; item?: unknown } | { ok: false; error: string } {
  try {
    const result = fn()
    return result !== undefined ? { ok: true, item: result } : { ok: true }
  } catch (error) {
    return { ok: false, error: friendlyError(error) }
  }
}

// ---------- 通用录屏（RecordingService：主进程状态机 + 落盘；渲染层采集） ----------

function registerRecordIpc(recorder: RecordingService): void {
  ipcMain.handle(IPC.recordStart, (_e, name?: string, showCursor?: boolean) => recorder.start(name, showCursor))
  ipcMain.handle(IPC.recordStop, () => recorder.stop())
  ipcMain.handle(IPC.recordState, () => recorder.state())
  ipcMain.handle(IPC.recordChunk, (_e, base64: string) => recorder.appendChunk(String(base64 ?? '')))
  ipcMain.handle(IPC.recordReady, (_e, container?: string) => recorder.notifyReady(container))
  ipcMain.handle(IPC.recordFail, (_e, error: string) => recorder.notifyFailed(String(error ?? '未知错误')))
  ipcMain.handle(IPC.recordDone, () => recorder.notifyDone())
}


function registerIpc(
  storage: StorageService,
  tts: TtsService,
  pool: SpeechPool,
  agent: AgentService,
  persona: PersonaService,
  prompts: PromptTemplateService,
  knowledge: KnowledgeService,
  bus: EventBus,
  triggers: TriggerRuntime,
  script: ScriptService,
  stream: StreamService,
  connector: ConnectorService,
  draftUnits: DraftUnitService,
  programPlayback: ProgramPlaybackService,
  exporter: ExportService
): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: BRAND_DISPLAY,
    version: app.getVersion(),
    platform: process.platform
  }))
  ipcMain.handle(IPC.configGet, () => storage.getConfig())
  ipcMain.handle(IPC.configSet, (_event, patch: PartialDeep<AppConfig>) => storage.setConfig(patch))
  // ---------- 导演大脑（全局一份：名字 + 接入 + 模型） ----------
  ipcMain.handle(IPC.directorGet, () => storage.getConfig().director)
  ipcMain.handle(IPC.directorSave, (_event, input: DirectorConfig) => {
    const name = String(input?.name ?? '').trim() || '小云'
    const modelConnectionId = String(input?.modelConnectionId ?? '').trim() || null
    const model = String(input?.model ?? '').trim()
    if (modelConnectionId) {
      const connection = storage.connectionGet(modelConnectionId)
      if (!connection) return { ok: false, error: '这条接入不存在（可能刚被删掉）' }
      if (!model) return { ok: false, error: '选了接入还要选一个模型' }
      if (!connection.models.includes(model)) {
        return { ok: false, error: `模型 ${model} 不在接入「${connection.name}」的模型列表里` }
      }
    }
    const director: DirectorConfig = { name, modelConnectionId, model: modelConnectionId ? model : '' }
    storage.setConfig({ director })
    return { ok: true, director }
  })

  // ---------- 话术池 ----------
  ipcMain.handle(IPC.poolSay, (_e, input: PoolSayInput) => guard(() => pool.say(input)))
  ipcMain.handle(IPC.poolInsertNext, (_e, input: Omit<PoolSayInput, 'lane'>) =>
    guard(() => pool.insertNext(input))
  )
  ipcMain.handle(IPC.poolRevoke, (_e, id: string) => guard(() => pool.revoke(id)))
  ipcMain.handle(IPC.poolRecentPlayed, (_e, n: number) => pool.getRecentPlayed(n))
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

  // 表单直连测试（新建接入还没保存也能测）：入参是表单当前值拼的完整接入，不查库；
  // 密钥字段留空时沿用已保存的那条（编辑场景，与保存时「留空 = 不修改」同口径）
  ipcMain.handle(IPC.ttsTestInput, async (_e, input: TtsConnectionInput & { model?: string; text?: string }) => {
    try {
      const providerId = String(input?.providerId ?? '') as TtsProvider
      const def = getTtsProvider(providerId)
      if (!def) return { ok: false, error: '服务商不认识：重新选一家' }
      const existing = input?.id ? storage.ttsConnectionGet(String(input.id)) : null
      const params: Record<string, string | number | boolean> = { ...(input?.params ?? {}) }
      for (const key of ttsSecretFieldKeys(providerId)) {
        if (String(params[key] ?? '') === '') params[key] = existing?.params[key] ?? ''
      }
      const models = (input?.models ?? [])
        .map((model) => ({
          id: String(model?.id ?? '').trim(),
          params: model?.params && typeof model.params === 'object' ? model.params : {}
        }))
        .filter((model) => model.id)
      if (models.length === 0) return { ok: false, error: '先在模型列表里勾一个模型再测' }
      const model = String(input?.model ?? '') || models[0].id
      const result = await tts.testConnection(
        {
          id: existing?.id ?? 'test-unsaved',
          providerId,
          name: String(input?.name ?? '') || def.label,
          params,
          models,
          realtime: false,
          createdAt: existing?.createdAt ?? 0,
          updatedAt: existing?.updatedAt ?? 0
        },
        model,
        input?.text ? String(input.text).slice(0, 200) : undefined
      )
      if (!result.ok || !result.audioPath || !pipeline) return result
      const request = pipeline.playFile(`tts-test-${Date.now()}`, result.audioPath, { slot: 'aux' })
      const started = await request.started
      if (!started.ok) {
        return { ...result, error: started.error ?? '音频没能放出来（没有可用输出设备或播放被系统拒绝）' }
      }
      await request.done
      return { ...result, playing: true }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
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
      return { ok: false, error: friendlyError(error) }
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
        modelContextWindows: input?.modelContextWindows ?? {},
        modelThinkingLevels: input?.modelThinkingLevels ?? {},
        modelParams: input?.modelParams ?? {}
      })
      return { ok: true, connections: storage.connectionListSafe() }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
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
  // 表单直连测试（新建接入还没保存也能测）：入参是表单当前值，不查库；
  // 密钥字段留空时沿用已保存的那条（编辑场景，与保存时「留空 = 不修改」同口径）
  ipcMain.handle(IPC.modelTestInput, async (_e, input: ModelConnectionInput & { model?: string }) => {
    const providerId = String(input?.providerId ?? '')
    if (!getLlmProvider(providerId)) return { ok: false, error: '服务商不认识：重新选一家' }
    const existing = input?.id ? storage.connectionGet(String(input.id)) : null
    const params: Record<string, string | number | boolean> = { ...(input?.params ?? {}) }
    for (const key of secretFieldKeys(providerId)) {
      if (String(params[key] ?? '') === '') params[key] = existing?.params[key] ?? ''
    }
    const models = (input?.models ?? []).map((model) => String(model ?? '').trim()).filter(Boolean)
    if (models.length === 0) return { ok: false, error: '先在模型列表里加一个模型再测' }
    return testModelConnection(
      {
        id: existing?.id ?? 'test-unsaved',
        name: String(input?.name ?? ''),
        providerId,
        params,
        models,
        modelContextWindows: {},
        modelThinkingLevels: {},
        modelParams: {},
        modelPrices: {},
        createdAt: existing?.createdAt ?? 0,
        updatedAt: existing?.updatedAt ?? 0
      },
      input?.model ? String(input.model) : undefined
    )
  })
  ipcMain.handle(IPC.providersLlmList, () => listLlmProviders())
  ipcMain.handle(IPC.providersTtsList, () => listTtsProviders())
  ipcMain.handle(IPC.providersModels, (_e, providerId: string) => listProviderModels(String(providerId ?? '')))

  // ---------- 主播 Agent ----------
  ipcMain.handle(IPC.agentStop, async () => {
    // 结束节目 = 收播（与整轮播完/急停同一条收尾路径）
    await endProgram('manual')
  })
  // 打断当前这一轮生成（对话输入框的停止钮）：会话保留，下条指令照常来
  ipcMain.handle(IPC.agentAbort, () => agent.stopGeneration())
  ipcMain.handle(IPC.agentRestart, async () => {
    try {
      // 应用改动后的资产：文本层（人设/剧本/手册/节目）热替换不打断；脑层（模型/接入）才重开会话
      const mode = await agent.applyAssets()
      return { ok: true, mode }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })
  ipcMain.handle(IPC.agentStatus, () => agent.status())
  // 直播间动态收件箱（直播台「事件流」）：快照拉取 + 250ms 节流广播
  ipcMain.handle(IPC.agentInbox, () => agent.inboxSnapshot())
  {
    let inboxTimer: NodeJS.Timeout | null = null
    let inboxLastSent = 0
    agent.onInboxChange = () => {
      const send = () => {
        inboxLastSent = Date.now()
        const snapshot = agent.inboxSnapshot()
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC.agentInboxEvent, snapshot)
        }
      }
      const wait = 250 - (Date.now() - inboxLastSent)
      if (wait <= 0 && !inboxTimer) return send()
      if (!inboxTimer) {
        inboxTimer = setTimeout(() => {
          inboxTimer = null
          send()
        }, Math.max(wait, 0))
        inboxTimer.unref?.()
      }
    }
  }
  // 统一开播控制里的「暂停/继续」：唯一实现在下面 applyPlaybackPause
  ipcMain.handle(IPC.playbackSetPaused, (_e, paused: boolean) => applyPlaybackPause(Boolean(paused)))

  // ---------- 导演对话 ----------
  // chat：无会话时自动按当前选中节目起 prep 会话再投递（选中节目即可开聊，不必先启动节目）
  // localId：渲染层本地回显条目的 id，main 以同一 id 落库——重载/切节目恢复时不重复
  // attachments：随消息附的文件。图片（png/jpg/jpeg/webp/gif）读成 base64 图像内容进会话（模型需开多模态，
  // 没开则由主播侧提示）；其它类型（pdf/docx…）拼成 [附件] 文本说明随指令投递
  const IMAGE_EXT_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
  }
  ipcMain.handle(
    IPC.directorSend,
    async (_e, text: string, localId?: string, attachments?: { name: string; path: string }[]) => {
      let content = String(text ?? '').slice(0, 500)
      // 斜杠命令：/clear 清空当前节目的会话（上下文 + 对话时间线），不进会话也不落库
      if (!attachments?.length && content.trim().toLowerCase() === '/clear') {
        return agent.clearConversation()
      }
      let images: { type: 'image'; data: string; mimeType: string }[] | undefined
      const files = Array.isArray(attachments) ? attachments : []
      const IMAGE_MAX_BYTES = 4 * 1024 * 1024
      const lines: string[] = []
      for (const file of files.slice(0, 8)) {
        const name = String(file?.name ?? '')
        const path = String(file?.path ?? '')
        if (!path) continue
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        const mime = IMAGE_EXT_MIME[ext]
        if (mime) {
          try {
            const buf = await readFile(path)
            if (buf.byteLength > IMAGE_MAX_BYTES) {
              lines.push(`[附件] ${name}：图片超过 4MB，发不进去（压缩后再发）`)
              continue
            }
            images = images ?? []
            if (images.length >= 4) {
              lines.push(`[附件] ${name}：一次最多 4 张图，这张没发`)
              continue
            }
            images.push({ type: 'image', data: buf.toString('base64'), mimeType: mime })
            continue
          } catch {
            lines.push(`[附件] ${name}：图片读不出来（文件还在吗？）`)
            continue
          }
        }
        lines.push(`[附件] ${name}：${path}`)
      }
      if (lines.length > 0) content = `${content}\n${lines.join('\n')}`.trim()
      const programId = StorageService.DIRECTOR_SESSION_KEY
      if (content) {
        const id = String(localId ?? '').trim() || `dm-${Date.now()}`
        try {
          storage.timelineAppend(
            programId,
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
        await agent.chat(content, images)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: friendlyError(error) }
      }
    }
  )
  /** 全局导演的连续对话时间线；与节目、直播状态解耦 */
  ipcMain.handle(IPC.directorTimelineList, () =>
    storage.timelineList(StorageService.DIRECTOR_SESSION_KEY).map((row) => JSON.parse(row.payload) as unknown)
  )

  // ---------- 导演手册（提示词模板） ----------
  ipcMain.handle(IPC.promptTemplatesList, () => prompts.list())
  ipcMain.handle(IPC.promptTemplatesSave, (_e, key: string, content: string) => {
    try {
      prompts.save(String(key ?? ''), String(content ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })
  ipcMain.handle(IPC.promptTemplatesReset, (_e, key: string) => {
    try {
      prompts.reset(String(key ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })

  // ---------- 人设卡 ----------
  ipcMain.handle(IPC.personaList, () => persona.list())
  ipcMain.handle(
    IPC.personaSave,
    (_e, input: Omit<Persona, 'id' | 'updatedAt'>, id?: string) => persona.save(input, id)
  )
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
  ipcMain.handle(IPC.audioStopAll, () => {
    pipeline?.stopAll()
    return { ok: true }
  })
  // 试听（aux 槽）：主进程播指定音频文件到监听通道——渲染层不再碰 file://（dev 的 http 源读不了本地文件）。
  // 真的开始出声才回 ok；同槽互斥，新试听自动顶掉旧的。
  // itemId 由渲染层带（preview- 前缀，audio:end 据此判播完收尾）；没带就现场生成一个。
  ipcMain.handle(IPC.audioPlayFile, async (_e, filePath: string, itemId?: string) => {
    if (!pipeline) return { ok: false, error: '音频管线未初始化' }
    const path = String(filePath ?? '')
    if (!path) return { ok: false, error: '没有音频文件路径' }
    const id = typeof itemId === 'string' && itemId.startsWith('preview-') ? itemId : `preview-${Date.now()}`
    const request = pipeline.playFile(id, path, { slot: 'aux' })
    const started = await request.started
    if (!started.ok) return { ok: false, error: started.error ?? '音频没能放出来' }
    return { ok: true }
  })
  ipcMain.handle(IPC.audioStopAux, () => {
    pipeline?.stopSlot('aux')
    return { ok: true }
  })
  // aux 槽用户级暂停/继续（试听条）：只停消费队列，主槽播报与解码背压不受影响
  ipcMain.handle(IPC.audioPauseAux, (_e, paused: boolean) => {
    pipeline?.pauseAux(Boolean(paused))
    return { ok: true }
  })
  // 章内 seek（预制节目长音频）：主槽 ffmpeg 以 -ss 重启解码
  ipcMain.handle(IPC.audioSeekMain, (_e, offsetMs: number) => {
    if (!pipeline) return { ok: false, error: '音频管线未初始化' }
    return pipeline.seekMain(Number(offsetMs))
  })

  // ---------- 音色库（M8 声音克隆） ----------
  ipcMain.handle(IPC.voiceList, () => voiceSvc?.list() ?? [])
  ipcMain.handle(
    IPC.voiceClone,
    (_e, input: VoiceCloneInput) =>
      voiceSvc?.clone(input) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceRemove, (_e, id: string) => voiceSvc?.remove(id) ?? { ok: false, error: '音色服务未初始化' })
  ipcMain.handle(IPC.voiceUpdate, (_e, id: string, patch: { name?: string; instruction?: string }) =>
    voiceSvc?.update(String(id ?? ''), {
      name: typeof patch?.name === 'string' ? patch.name : undefined,
      instruction: typeof patch?.instruction === 'string' ? patch.instruction : undefined
    }) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(
    IPC.voicePreview,
    (_e, id: string) =>
      voiceSvc?.preview(String(id ?? '')) ?? { ok: false as const, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceUsage, (_e, id: string) =>
    voiceSvc?.usage(String(id ?? '')) ?? { personas: [], programs: [], draftUnitCount: 0, draftUnitSamples: [] }
  )
  ipcMain.handle(IPC.voiceUploadSample, async (_e, bytes: Uint8Array, ext: string) => {
    if (!voiceSvc) return { ok: false, error: '音色服务未初始化' }
    const path = await voiceSvc.saveSample(bytes, ext)
    return { ok: true, path }
  })

  // 本地样本 → 临时文件站 → 公网直链（百炼复刻只收 URL）
  const tempUpload = new TempUploadService()
  audioStyle = new AudioStyleService(storage, tempUpload)
  ipcMain.handle(IPC.voiceUploadTemp, (_e, filePath: string) => tempUpload.upload(String(filePath ?? '')))

  // ---------- 知识库 ----------
  ipcMain.handle(IPC.knowledgeProductList, () => knowledge.listMaterials())
  ipcMain.handle(IPC.knowledgeProductSave, (_e, input: MaterialInput, id?: string) =>
    guard(() => {
      // 价格变动发事件：腹稿修订链路（主播收到后自己决定 revise 池里没播的报价）
      const before = id ? knowledge.listMaterials().find((p) => p.id === id) : undefined
      const saved = knowledge.saveMaterial(input, id)
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
  ipcMain.handle(IPC.knowledgeProductDelete, (_e, id: string) => guard(() => knowledge.deleteMaterial(id)))
  // 抖音商城同步：连接器在线时把绑定商品拉成知识条目（发现式找商品工具，按 externalId 去重更新）
  ipcMain.handle(IPC.knowledgeProductSync, async () => {
    try {
      if (connector.status().state !== 'connected') {
        return { ok: false, error: '连接器未连接（先确认连接器在运行、设置里的端口和 Token 对）' }
      }
      const result = await knowledge.syncFromConnector(connector)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })
  ipcMain.handle(IPC.materialFileList, () => knowledge.listFiles())
  ipcMain.handle(IPC.knowledgeFileUpload, async (_e, filePath: string, description?: string, materialId?: string) => {
    try {
      return { ok: true, file: await knowledge.uploadFile(String(filePath), description, materialId) }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })
  ipcMain.handle(IPC.materialAttachUrl, (_e, materialId: string, url: string, title?: string) => {
    try {
      return { ok: true, file: knowledge.attachUrl(String(materialId), String(url), title) }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  })
  ipcMain.handle(IPC.materialFileDelete, (_e, id: string) => guard(() => knowledge.deleteFile(id)))

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

  // ---------- 用量看板（数据页；事件时间线已并入直播台「事件流」，event_log 只留档不展示） ----------
  ipcMain.handle(IPC.statsUsageDashboard, (_e, programId?: string) =>
    storage.usageDashboard(String(programId ?? '') || undefined)
  )
  ipcMain.handle(IPC.statsUsageRecords, (_e, limit?: number, programId?: string) =>
    storage.usageRecent(Math.max(1, Math.min(Number(limit) || 100, 500)), String(programId ?? '') || undefined)
  )
  ipcMain.handle(IPC.statsTtsRecords, (_e, limit?: number, programId?: string) =>
    storage.ttsRecent(Math.max(1, Math.min(Number(limit) || 100, 500)), String(programId ?? '') || undefined)
  )

  // ---------- 统计可视化（docs/REDESIGN 4.11）：全局图表 + 单场图表 ----------
  ipcMain.handle(IPC.statsGlobal, (_e, query?: StatsQuery) =>
    storage.statsGlobal({
      from: Number(query?.from) || 0,
      to: Number(query?.to) || 0,
      programId: String(query?.programId ?? '') || undefined
    })
  )
  ipcMain.handle(IPC.statsSession, (_e, sessionId: string) => storage.statsSession(String(sessionId ?? '')))

  // ---------- 剧本 ----------
    // ---------- 节目 ----------
  ipcMain.handle(IPC.programList, () => script.listPrograms())
  ipcMain.handle(IPC.programSave, (_e, input: ProgramInput, id?: string) =>
    guard(() => script.saveProgram(input, id))
  )
  ipcMain.handle(IPC.programDelete, (_e, id: string) =>
    // 底稿/音频/持久对话（会话 entries + 时间线）的级联清理由 ScriptService.deleteProgram 统一负责
    guard(() => script.deleteProgram(String(id ?? '')))
  )
  ipcMain.handle(IPC.programSetActive, (_e, id: string) => {
    script.setActiveProgram(String(id ?? ''))
    // 选中节目导演即就位（建会话不调 LLM，零成本）：上下文仪表从这一刻就有读数，不用等第一句话
    if (id) void agent.warmupSession().catch(() => undefined)
    return storage.getConfig().live.activeProgramId
  })
  // 开播预检与启动（docs/07 §8.5）：直播台唯一开播入口
  ipcMain.handle(IPC.programPreflight, (_e, id: string) => programPlayback.preflight(String(id ?? '')))
  ipcMain.handle(IPC.programLaunch, async (_e, id: string, opts?: { allowPartial?: boolean }) =>
    launchAndAnnounce(programPlayback, String(id ?? ''), {
      allowPartial: opts?.allowPartial === true,
      source: 'human'
    })
  )
  /** 切场景（直播台按钮）：跳场景 + 装载新场景话术库 */
  // 统一音频生产入口（docs/10 §7.5）：rolling=后台提前合成全部；prepared=同步跑完返回汇总。
  // voiceOverride = 声音选择弹窗（docs/REDESIGN 4.4）里用户显式选的声音，本次合成冻结它
  ipcMain.handle(IPC.programProduceAudio, (_e, programId: string, voiceOverride?: ProduceVoiceOverride) =>
    draftUnits.produceProgramAudio(String(programId ?? ''), voiceOverride)
  )
  // 生产前的合成计划摘要（声音选择弹窗）：段数、就绪/待合成计数、声音描述、粗估时长
  ipcMain.handle(IPC.programProducePlan, (_e, programId: string) =>
    draftUnits.describeProducePlan(String(programId ?? ''))
  )
  // 预制节目正式播放门禁（docs/10 §7.8）：结构化结果，未通过不静默跳过
  ipcMain.handle(IPC.programPlayGate, (_e, programId: string) =>
    programPlayback.playGate(String(programId ?? ''))
  )
  ipcMain.handle(IPC.programPlans, () => script.listPrograms().map((program) => script.planOf(program)))
  ipcMain.handle(IPC.programScenesGet, (_e, programId: string) => script.scenesOf(String(programId ?? '')))
  ipcMain.handle(IPC.programScenesSave, (_e, programId: string, scenes: ScriptScene[]) =>
    guard(() => script.saveScenes(String(programId ?? ''), scenes))
  )
  ipcMain.handle(IPC.programAudioProgress, (_e, programId: string) =>
    programPlayback.audioProgress(String(programId ?? ''))
  )
  // 预制节目按段跳播（上一段/下一段/段点播）：装池提到队首，再打断当前条目让播放循环立即取它
  ipcMain.handle(
    IPC.programPlayUnit,
    (_e, programId: string, target: { kind: 'scene' | 'draftUnit'; id: string }) => {
      const result = programPlayback.playUnit(String(programId ?? ''), {
        kind: target?.kind === 'scene' ? 'scene' : 'draftUnit',
        id: String(target?.id ?? '')
      })
      if (result.ok && !result.already) pipeline?.stopAll()
      return result
    }
  )
  // 导入外部音频（§7.4）：主进程弹文件选择框，复制入 BlobStore（不动用户原文件）并挂到指定 Scene/DraftUnit 的 rendered
  ipcMain.handle(
    IPC.programImportAudio,
    async (_e, programId: string, target: { kind: 'scene' | 'draftUnit'; id: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return { ok: false as const, error: '没有可用窗口' }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a'] }]
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false as const, error: '已取消' }
      return draftUnits.importExternalAudio(
        String(programId ?? ''),
        { kind: target?.kind === 'scene' ? 'scene' : 'draftUnit', id: String(target?.id ?? '') },
        result.filePaths[0]
      )
    }
  )

  // ---------- 节目音频导出（docs/10 §8.3/§15.17，P6） ----------
  // 输出目录空 = UI 路径：主进程弹目录选择框；Agent 路径传显式目录或走默认 exports 目录
  ipcMain.handle(IPC.programExport, async (_e, options: ProgramExportOptions) => {
    let outputDir = String(options?.outputDir ?? '').trim()
    if (!outputDir) {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return { ok: false as const, error: '没有可用窗口' }
      const picked = await dialog.showOpenDialog(win, {
        title: '选择导出目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || !picked.filePaths[0]) {
        return { ok: false as const, cancelled: true, error: '已取消选择输出目录' }
      }
      outputDir = picked.filePaths[0]
    }
    return exporter.export({
      programId: String(options?.programId ?? ''),
      mode: options?.mode === 'merged' ? 'merged' : 'separate',
      format: options?.format === 'wav' ? 'wav' : 'mp3',
      outputDir,
      fileNameTemplate: typeof options?.fileNameTemplate === 'string' ? options.fileNameTemplate : undefined,
      loudness: options?.loudness === true,
      onlyReady: options?.onlyReady === true
    })
  })
  ipcMain.handle(IPC.programExportCancel, () => ({ ok: exporter.cancel() }))
  ipcMain.handle(IPC.programExportPickDir, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.programExportOpenDir, (_e, dir: string) =>
    shell.openPath(String(dir ?? ''))
  )

  // ---------- 场记（场次记录） ----------
  ipcMain.handle(IPC.sessionList, (_e, programId?: string) =>
    storage.sessionList(typeof programId === 'string' && programId ? programId : undefined)
  )
  ipcMain.handle(IPC.sessionDetail, (_e, id: string) => {
    const session = storage.sessionGet(String(id ?? ''))
    if (!session) return null
    // 互动观众：本场评论聚合 + 全局画像（主播长期记忆）顺带附上
    const viewers = storage.sessionViewerAgg(session.id).map((agg) => ({
      ...agg,
      profile: storage.viewerGet(agg.name) ?? undefined
    }))
    return { session, items: storage.sessionSpeechItems(session.id), events: storage.sessionEvents(session.id), viewers }
  })
  ipcMain.handle(IPC.sessionDelete, (_e, id: string) => {
    const sid = String(id ?? '')
    if (recorder?.current() === sid) return { ok: false, error: '这场还在播，先收播再删' }
    storage.sessionDelete(sid)
    return { ok: true }
  })
  ipcMain.handle(IPC.sessionExport, async (_e, options: SessionExportOptions) => {
    let outputDir = String(options?.outputDir ?? '').trim()
    if (!outputDir) {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return { ok: false as const, error: '没有可用窗口' }
      const picked = await dialog.showOpenDialog(win, {
        title: '选择导出目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || !picked.filePaths[0]) {
        return { ok: false as const, cancelled: true, error: '已取消选择输出目录' }
      }
      outputDir = picked.filePaths[0]
    }
    return exporter.exportSession({
      sessionId: String(options?.sessionId ?? ''),
      mode: options?.mode === 'separate' ? 'separate' : 'merged',
      format: options?.format === 'wav' ? 'wav' : 'mp3',
      outputDir,
      loudness: options?.loudness === true
    })
  })

  // ---------- 话术库（节目底稿） ----------
  ipcMain.handle(IPC.draftUnitList, (_e, programId: string) => draftUnits.list(String(programId)))
  ipcMain.handle(IPC.draftUnitSave, (_e, input: DraftUnitInput, id?: string) =>
    guard(() => draftUnits.save(input, id))
  )
  ipcMain.handle(IPC.draftUnitDelete, (_e, id: string) => guard(() => draftUnits.remove(id)))
  ipcMain.handle(IPC.draftUnitClear, (_e, programId: string, sceneId?: string) =>
    guard(() => draftUnits.clear(String(programId), sceneId))
  )
  ipcMain.handle(IPC.draftUnitClearAudio, (_e, programId: string) =>
    guard(() => draftUnits.clearAudio(String(programId)))
  )
  // ---------- 写稿：导演给当前节目写底稿 ----------
  ipcMain.handle(IPC.agentDraftStart, async (_e, programId: string) => {
    try {
      await agent.startDrafting(String(programId))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
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

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    watchSystemChrome()

    const storage = new StorageService()
    // 结构迁移必须先落地再装配服务：迁移会改表结构，服务构造时就假定结构已就位
    await storage.init()
    // 命令行（Go 版，resources/bin/yuncast）在应用没开时按这个把应用拉起来
    storage.setLaunch(process.execPath, app.isPackaged ? [] : [app.getAppPath()])
    linkCliToPath()
    const blobs = new BlobStoreService(storage)
    const tts = new TtsService(storage, blobs)
    pool = new SpeechPool(storage, tts, broadcastPool)
    pool.onWarmCache = (path) => blobs.warm(path)
    const prompts = new PromptTemplateService(storage)
    const persona = new PersonaService(storage)
    const knowledge = new KnowledgeService(storage, blobs)
    const memory = new MemoryService(storage)
    const script = new ScriptService(storage)
    bus = new EventBus(storage)
    // 场记：场次记录器（开播/收播在 ProgramPlaybackService.launch 与三个收播点挂钩）；
    // 启动先把上次没来得及收播的场次补尾成 crash
    recorder = new SessionRecorder(storage, bus)
    recorder.fixUnfinished()
    // 节目底稿库（提前建：主播 Agent 的底稿工具、生成 Agent、节目启动都用它）
    const draftUnits = new DraftUnitService(storage, tts, persona, script, blobs)
    draftUnits.onEvent = (u) => broadcastDraftUnit(u)
    draftUnits.onBatchDone = (programId) => broadcastDraftUnitDone(programId)
    // 预制音频资产变化广播（Scene/DraftUnit 的 rendered 更新，渲染层刷新节目音频进度）
    draftUnits.onRenderedEvent = (programId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.programAudioEvent, { programId })
      }
    }
    // Agent 改场景（append/update/remove_scene）也触发预制音频的 stale 检测
    script.onContentChanged = (programId) => draftUnits.refreshRenderedStaleness(programId)
    agent = new AgentService(
      storage,
      pool,
      persona,
      prompts,
      knowledge,
      memory,
      script,
      draftUnits,
      broadcastAgent,
      // 对话时间线：文本流式 + 工具卡片，照 pi 事件流原样推到渲染层（docs/09 §11）；
      // 顺带喂给 MCP 服务：agent_chat 工具的等待者从这里收本轮回复
      (event) => {
        broadcastDirectorTimeline(event)
        mcp?.feedTimeline(event)
      }
    )
    triggers = new TriggerRuntime(storage, bus, pool, agent, () => persona.programVoice())
    // 节目事件接线：触发器白名单/动态事件总闸跟着当前节目走
    triggers.gateProvider = () => agent!.currentProgramGate()
    streamSvc = new StreamService(storage, broadcastStream)
    // 系统控制工具的迟接线服务（音色/触发器/推流都生于 Agent 之后）
    agent.getTriggers = () => triggers
    agent.getStream = () => streamSvc

    // 音频管线（唯一音频权威）：解码/排播/混音/音量都在这。
    // 同一片 PCM 同时喂推流（混音器）与本机监听（IPC → 渲染层声卡）。
    pipeline = new AudioPipeline({
      feedStream: (pcmStereo48k) => streamSvc?.pushTtsPcm(pcmStereo48k),
      setStreamBgm: (action, filePath, volume) => streamSvc?.setBgm(action, filePath, volume) ?? Promise.resolve(),
      sendPcm: broadcastPcm,
      sendLevel: broadcastLevel,
      sendEnd: broadcastAudioEnd,
      sendProgress: broadcastProgress
    })
    // 播放循环搬到了主进程：渲染层不再参与播放调度。段间不留白，停顿由主播用 <pause> 标记写在内容里
    playback = new PlaybackLoop(pool, () => ttsStream, pipeline)
    playback.start()

    // 合成彻底失败（退避重试耗尽，或 401/403 这类重试无意义的）：一条合不出来就停播——
    // 走统一暂停（播报停 + 主播产出停），点「继续」时 playbackSetPaused 里 retryFailed 重新触发合成
    pool.onSynthHalt = (item, error) => {
      console.error(`[YunCast] 合成彻底失败，停播等人处理（${item.id}）: ${error}`)
      bus?.emit('speech.failed', { id: item.id, error, text: item.text.slice(0, 80) })
      applyPlaybackPause(true)
    }

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
    // agent 的连接器工具（list/call_connector_tool、商品同步）从这里取
    agent.getConnector = () => connector

    // 音色库（M8 声音克隆）：训练状态变化推给渲染进程；试听由主进程合成完直接出声（aux 槽）
    // 音色库变更：payload 事件（旧订阅）+ 统一 data:changed
    const broadcastVoicesAll = (voices: VoiceRecord[]): void => {
      broadcastVoices(voices)
      broadcastDataChanged('voices')
    }
    voiceSvc = new VoiceService(storage, tts, blobs, broadcastVoicesAll, async (itemId, filePath) => {
      const request = pipeline!.playFile(itemId, filePath, { slot: 'aux' })
      const started = await request.started
      if (started.ok) await request.done
      return started
    })
    agent.getVoices = () => voiceSvc
    // agent/MCP 改人设卡：广播给所有窗口，界面即时刷新（不再依赖用户手动切页）
    knowledge.onChanged = (scope) => broadcastDataChanged('knowledge', scope)
    // 存储层统一广播：剧本/触发器/场次/知识文件/配置这些「IPC 与 agent 都能改」的数据，
    // 只认库真的变了这一个信号，界面不会再因为某条写路径忘了广播而停在旧数据上
    storage.onDataChanged = (scope, detail) => {
      if (scope === 'triggers') agent?.refreshProgramGate()
      broadcastDataChanged(scope, detail)
    }
    recorder.onChanged = () => broadcastDataChanged('sessions')
    draftUnits.onDraftChanged = (programId) => broadcastDataChanged('drafts', programId)
    persona.onChanged = (personaId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.personaChanged, personaId)
      }
      broadcastDataChanged('personas', personaId)
    }
    agent.getAudioStyle = () => audioStyle

    // 节目底稿库 + 节目播放（docs/07 §8.5）
    const programPlayback = new ProgramPlaybackService(storage, script, persona, draftUnits, pool, agent, connector, streamSvc, tts)
    storageRef = storage
    playerRef = programPlayback
    programPlayback.recorder = recorder
    // 节目音频导出（docs/10 §8.3，P6）：进度逐单元广播；export_program 工具的确认卡用它出计划摘要
    const exporter = new ExportService(storage, script)
    exporter.onProgress = (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.programExportEvent, progress)
      }
    }
    agent.getExporter = () => exporter

    // 通用录屏：主进程状态机 + 授权闸门；状态广播给所有窗口（播放条红点），事件进 SSE 流
    screenRecorder = new RecordingService()
    screenRecorder.bindContents(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null))
    screenRecorder.onStateChange = (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.recordStateEvent, state)
      }
    }
    screenRecorder.onEvent = (type, payload) => bus?.emit(type, payload, 'human')
    registerRecordIpc(screenRecorder)
    agent.getRecorder = () => screenRecorder

    // 开放接口（MCP / CLI / SSE 事件流）：与界面走同一批服务实例，Agent 开播/说话窗口里立刻看得到
    eventHub = new EventHub(bus!, storage)
    eventHub.start()
    mcp = new McpService({
      storage,
      tts,
      pool,
      agent,
      persona,
      knowledge,
      memory,
      script,
      stream: streamSvc,
      draftUnits,
      programPlayback,
      exporter,
      recorder: screenRecorder!,
      voices: voiceSvc,
      getAudioStyle: () => audioStyle,
      eventHub,
      getConnector: () => connector,
      getTriggers: () => triggers,
      hooks: {
        // 与 IPC.programLaunch 同一条实现（launchAndAnnounce），不各写一份
        launchProgram: (programId, allowPartial) =>
          launchAndAnnounce(programPlayback, programId, { allowPartial, source: 'human' }),
        // 与 IPC.playbackSetPaused 同口径：停播报循环 + 停主播产出
        setPaused: (paused) => applyPlaybackPause(paused),
        // 跳过当前这条：掐音频，播放循环按播完处理
        skipCurrent: () => pipeline?.stopAll()
      },
      getSender: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
    })
    // 配置里的 mcp 段变了才重启服务（无关的配置保存不动端口）
    storage.onConfigChange((config) => syncMcp(config.mcp))
    syncMcp(storage.getConfig().mcp)
    // 就绪补装：直播中底稿每就绪一段就补装进池（播出策略决定接不接：rolling 接，prepared/improvised 不接）
    const broadcastDraftUnitOnly = draftUnits.onEvent
    draftUnits.onEvent = (u) => {
      broadcastDraftUnitOnly?.(u)
      if (u.status !== 'ready' || !u.id) return
      if (storage.getConfig().live.activeProgramId !== u.programId) return
      const status = agent?.status()
      if (status?.state !== 'running' || status.live !== true) return
      const program = storage.programList().find((p) => p.id === u.programId)
      if (!program || !policyFor(program, programPlayback).autoReloadOnReady) return
      const loaded = programPlayback.loadActiveSceneDraftUnits()
      if (loaded > 0) console.log(`[YunCast] 新就绪底稿补装 ${loaded} 条`)
    }
    // 场景推进（advance_scene）后补装兜底（整库装载，正常早已装好；去重落空）
    agent.onSceneAdvanced = () => {
      const loaded = programPlayback.loadActiveSceneDraftUnits()
      if (loaded > 0) console.log(`[YunCast] 场景推进补装话术 ${loaded} 条`)
    }
    // 主播自己开播（start_live 工具）：跟「启动节目」按钮走同一条 ProgramPlaybackService.launch，预检拦截如实回报
    agent.onGoLive = async () => {
      const programId = storage.getConfig().live.activeProgramId
      if (!programId) return '没有选中节目，开不了播'
      const result = await launchAndAnnounce(programPlayback, programId, { source: 'agent' })
      if (!result.ok) return `开播被预检拦下了：${result.error}`
      return `已开播：装载 ${result.loaded} 条底稿，播出通道已打开，评论开始进来了`
    }
    // 水位事件统一走播出策略（broadcastPolicy.ts）：引擎只问策略要决策，不写模式分叉。
    // rolling：低水位引擎直发续写（冷却 180s；导演也可随时在对话里人工叫写）；
    //          见底时 stop→两阶段收播 / 内容在路上就等（允许冷场）/ 到上限才循环重播。
    // prepared：见底 stop→收播（音频还在出就等）/ loop→重装 rendered 单元（复用不重新合成）；永不续写。
    // improvised：无底稿，水位与播出内容无关，忽略。
    let lastLowWaterAt = 0
    bus.subscribe((event) => {
      if (event.type !== 'pool.empty' && event.type !== 'pool.low') return
      const status = agent?.status()
      if (status?.state !== 'running' || status.live !== true) return
      const programId = storage.getConfig().live.activeProgramId
      if (!programId) return
      const program = storage.programList().find((p) => p.id === programId) ?? null
      if (!program) return
      const policy = policyFor(program, programPlayback)

      if (event.type === 'pool.low') {
        if (!policy.shouldAutoWrite(program)) return
        if (Date.now() - lastLowWaterAt < 180_000) return
        lastLowWaterAt = Date.now()
        agent?.notifyLowWater(Number(event.payload.remaining ?? 0))
        return
      }

      // pool.empty：整轮播完的「播完即停」决策点也在策略里（stop = 不循环重播，通知主播收尾后收播）
      switch (policy.poolEmptyAction(program)) {
        case 'wrap-up':
          finishRoundStop(programId)
          return
        case 'reload': {
          const loaded = policy.reload(program)
          if (loaded > 0) console.log(`[YunCast] 池见底，装回 ${loaded} 条继续播出`)
          return
        }
        case 'wait': {
          // 内容在路上（还在合成）→ 保持运行等它，别暂停；真没货了 → 自动暂停
          const incoming =
            programPlayback.hasIncomingDraftUnits(programId) ||
            programPlayback.hasFreshDraftUnits(programId) ||
            programPlayback.hasIncomingRendered(programId)
          if (incoming) {
            console.log('[YunCast] 池空了但内容还在路上：保持播报态等合成')
            return
          }
          if (autoPauseWhenDry()) return
          console.log('[YunCast] 池空了（已暂停）：等新内容或手动继续')
          return
        }
        case 'ignore':
          return
      }
    })
    // 主播请示（ask_director）：AgentService 内部直接进对话时间线单通道（高亮卡片，不阻塞直播）
    // 紧急停止总闸（emergency_stop 工具，安全优先直接执行）：掐声音 + 收播，走统一收尾
    agent.onEmergencyStop = async () => {
      await endProgram('emergency')
    }
    // 播报控制（pause/resume/skip）：主播工具改播放状态，转给渲染进程的播放循环
    agent.onPlaybackControl = (action) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.playbackControlEvent, action)
      }
    }

    // 实时 TTS：流式合成（整段合成 → 解码 → 分块吐 PCM，由 AudioPipeline 按真实速率排播；
    // 供应商流式接口见 docs/06）。它只对主进程内部开口，渲染层拿不到 PCM 通道。
    ttsStream = new TtsStreamService(tts, () => storage.getConfig().live.activeProgramId)

    // 定时节拍：5 分钟一跳
    timerInterval = setInterval(() => bus?.emit('timer.interval', {}, 'timer'), 5 * 60_000)

    // BlobStore：启动清临时区 → 异步迁移老目录（audio-cache / voices / program-audio / 知识库附件，不阻塞窗口）→ 之后每 30 分钟 GC
    void blobs.sweepTmp()
    void (async () => {
      try {
        await blobs.migrateLegacyAudioCache()
        await blobs.migrateVoiceSamples()
        await blobs.migrateProgramAudio()
        await blobs.migrateMaterialFiles()
        await blobs.sweep()
      } catch (error) {
        console.warn('[BlobStore] 启动迁移失败:', error)
      }
    })()
    audioCacheSweep = setInterval(() => void blobs.sweep(), 30 * 60_000)
    audioCacheSweep.unref?.()
    timerInterval.unref?.()

    // 主题改了立刻让窗口 chrome 跟上（标题栏按钮、窗口底色）
    storage.onConfigChange((config) => paintAllWindows(config.theme))
    updater = new UpdateService()
    updater.init()
    registerIpc(storage, tts, pool, agent, persona, prompts, knowledge, bus, triggers, script, streamSvc, connector, draftUnits, programPlayback, exporter)
    registerUpdateIpc(updater)
    registerMcpIpc(storage)
    createWindow(storage)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(storage)
    })
  })
}

app.on('window-all-closed', () => {
  crashNote('window-all-closed', '')
  // 场记：应用退出时还有没收的场次，补 app_quit（崩溃没走到这的由下次启动补 crash）
  recorder?.end('app_quit')
  if (timerInterval) clearInterval(timerInterval)
  connector?.stop()
  void mcp?.stop()
  // 播放循环先停（它会把正在播的那条退回 ready），再收音频管线（杀掉解码进程、断了推流 BGM）
  playback?.dispose()
  pipeline?.dispose()
  void streamSvc?.stop()
  triggers?.dispose()
  pool?.dispose()
  void agent?.stop()
  if (process.platform !== 'darwin') app.quit()
})
