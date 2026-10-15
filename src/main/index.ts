import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { setDefaultResultOrder } from 'node:dns'
import { followAppTheme, paintAllWindows, titleBarOverlay, watchSystemChrome, windowBackground } from './window-chrome'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { IPC } from '../shared/ipc-channels'
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
  type ProgramExportOptions,
  type ProgramInput,
  type ScriptInput,
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
import { ProgramPlaybackService } from './services/ProgramPlaybackService'
import { ExportService } from './services/ExportService'
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
function broadcastUtteranceDone(programId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.utteranceEvent, {
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
let ttsRealtime: TtsRealtimeService | null = null
let streamSvc: StreamService | null = null
let pipeline: AudioPipeline | null = null
let playback: PlaybackLoop | null = null

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

function finishRoundStop(programId: string): void {
  if (!stopWrap) {
    stopWrap = { programId, timer: null }
    console.log('[AgentAnchor] 整轮播完（finishMode=stop）：通知主播收尾，说完收播')
    agent?.notifyProgramFinished()
    // 主播没接话（暂停中/生成失败等）就 2 分钟后兜底收播，节目不能挂在半空
    stopWrap.timer = setTimeout(() => finishRoundStop(programId), 120_000)
    stopWrap.timer.unref?.()
    return
  }
  if (stopWrap.programId !== programId) return
  resetStopWrap()
  console.log('[AgentAnchor] finishMode=stop：收尾播完，节目结束')
  agent?.setLiveActive(false)
  bus?.emit('stream.ended', {}, 'system')
  // 会话一并收掉：与手动「结束节目」同口径——live 会话有对话会先让主播自我复盘写进场次摘要
  void agent?.stop()
}

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
  bus: EventBus,
  triggers: TriggerRuntime,
  script: ScriptService,
  stream: StreamService,
  connector: ConnectorService,
  utterances: UtteranceService,
  programPlayback: ProgramPlaybackService,
  exporter: ExportService
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
        modelContextWindows: input?.modelContextWindows ?? {},
        modelThinkingLevels: input?.modelThinkingLevels ?? {},
        modelParams: input?.modelParams ?? {}
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
    const statusBefore = agent.status()
    const wasRunning = statusBefore.state !== 'stopped'
    resetStopWrap()
    await agent.stop()
    // 结束节目：开播态归引擎——就算 agent 早就没起来，这场也算收了
    if (statusBefore.live) agent.setLiveActive(false)
    if (wasRunning || statusBefore.live) bus.emit('stream.ended', {}, 'human')
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
  ipcMain.handle(IPC.agentHandoff, async (_e, personaId: string) => agent.handoff(personaId))
  ipcMain.handle(IPC.agentStatus, () => agent.status())
  // 直播间动态收件箱（播控台「事件流」）：快照拉取 + 250ms 节流广播
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
  // 统一开播控制里的「暂停」：停播报（主进程播放循环）+ 停主播产出（评论/触发器不派、say 被拒）
  ipcMain.handle(IPC.playbackSetPaused, (_e, paused: boolean) => {
    const value = Boolean(paused)
    agent.setSpeakingPaused(value)
    playback?.setRunning(!value)
  })

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
      const programId = storage.getConfig().live.activeProgramId
      if (programId && content) {
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
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  /** 拉某节目的对话时间线（切节目/刷新/重启后整段恢复；载荷已是 ChatEntry JSON） */
  ipcMain.handle(IPC.directorTimelineList, (_e, programId: string) =>
    storage.timelineList(String(programId ?? '')).map((row) => JSON.parse(row.payload) as unknown)
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
  // 试听（aux 槽）：主进程播指定音频文件到监听通道——渲染层不再碰 file://（dev 的 http 源读不了本地文件）。
  // 真的开始出声才回 ok；同槽互斥，新试听自动顶掉旧的。
  ipcMain.handle(IPC.audioPlayFile, async (_e, filePath: string) => {
    if (!pipeline) return { ok: false, error: '音频管线未初始化' }
    const path = String(filePath ?? '')
    if (!path) return { ok: false, error: '没有音频文件路径' }
    const request = pipeline.playFile(`preview-${Date.now()}`, path, { slot: 'aux' })
    const started = await request.started
    if (!started.ok) return { ok: false, error: started.error ?? '音频没能放出来' }
    return { ok: true }
  })
  ipcMain.handle(IPC.audioStopAux, () => {
    pipeline?.stopSlot('aux')
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
  ipcMain.handle(IPC.voiceRename, (_e, id: string, name: string) =>
    voiceSvc?.rename(String(id ?? ''), String(name ?? '')) ?? { ok: false, error: '音色服务未初始化' }
  )
  ipcMain.handle(
    IPC.voicePreview,
    (_e, id: string) =>
      voiceSvc?.preview(String(id ?? '')) ?? { ok: false as const, error: '音色服务未初始化' }
  )
  ipcMain.handle(IPC.voiceUsage, (_e, id: string) =>
    voiceSvc?.usage(String(id ?? '')) ?? { personas: [], programs: [], utteranceCount: 0, utteranceSamples: [] }
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
  // 抖音商城同步：连接器在线时把绑定商品拉成知识条目（发现式找商品工具，按 externalId 去重更新）
  ipcMain.handle(IPC.knowledgeProductSync, async () => {
    try {
      if (connector.status().state !== 'connected') {
        return { ok: false, error: '连接器未连接（先确认连接器在运行、设置里的端口和 Token 对）' }
      }
      const result = await knowledge.syncFromConnector(connector)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
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

  // ---------- 成本看板（数据页；事件时间线已并入播控台「事件流」，event_log 只留档不展示） ----------
  ipcMain.handle(IPC.statsDashboard, (_e, programId?: string) =>
    storage.costDashboard(String(programId ?? '') || undefined)
  )
  ipcMain.handle(IPC.statsUsageRecords, (_e, limit?: number, programId?: string) =>
    storage.usageRecent(Math.max(1, Math.min(Number(limit) || 100, 500)), String(programId ?? '') || undefined)
  )
  ipcMain.handle(IPC.statsTtsRecords, (_e, limit?: number, programId?: string) =>
    storage.ttsRecent(Math.max(1, Math.min(Number(limit) || 100, 500)), String(programId ?? '') || undefined)
  )

  // ---------- 剧本 ----------
  ipcMain.handle(IPC.scriptList, () => script.listScripts())
  ipcMain.handle(IPC.scriptSave, (_e, input: ScriptInput, id?: string) =>
    guard(() => script.saveScript(input, id))
  )
  ipcMain.handle(IPC.scriptDelete, (_e, id: string) => guard(() => script.deleteScript(id)))

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
    // 选中节目主播即就位（建会话不调 LLM，零成本）：上下文仪表从这一刻就有读数，不用等第一句话
    if (id) void agent.warmupPrepSession().catch(() => undefined)
    return storage.getConfig().live.activeProgramId
  })
  // 开播预检与启动（docs/07 §8.5）：直播台唯一开播入口
  ipcMain.handle(IPC.programPreflight, (_e, id: string) => programPlayback.preflight(String(id ?? '')))
  ipcMain.handle(IPC.programLaunch, async (_e, id: string, opts?: { allowPartial?: boolean }) => {
    // 「在跑」不等于「已开播」：写稿会话（prep）也在跑，prep→live 必须发开播事件（开播信号触发器靠它）
    const statusBefore = agent.status()
    const wasLive = statusBefore.state !== 'stopped' && statusBefore.purpose === 'live'
    const result = await programPlayback.launch(String(id ?? ''), {
      allowPartial: opts?.allowPartial === true
    })
    if (result.ok && !wasLive) bus.emit('stream.started', {}, 'human')
    // 新一轮开播：上一场可能停在「收尾中」状态，复位
    if (result.ok) resetStopWrap()
    // 0 就绪开播：底稿还在后台合成，开播空隙叫「续写补给」顶上（agent 现场编一段，不冷场）
    if (result.ok && (result.loaded ?? 0) === 0) bus.emit('pool.low', { remaining: 0 }, 'system')
    return result
  })
  /** 切场景（直播台按钮）：跳场景 + 装载新场景话术库 */
  ipcMain.handle(IPC.programGotoScene, (_e, programId: string, index: number) =>
    programPlayback.gotoScene(String(programId ?? ''), Math.floor(Number(index) || 0))
  )
  // 统一音频生产入口（docs/10 §7.5）：rolling=后台提前合成全部；prepared=同步跑完返回汇总
  ipcMain.handle(IPC.programProduceAudio, (_e, programId: string) =>
    utterances.produceProgramAudio(String(programId ?? ''))
  )
  // 预制节目正式播放门禁（docs/10 §7.8）：结构化结果，未通过不静默跳过
  ipcMain.handle(IPC.programPlayGate, (_e, programId: string) =>
    programPlayback.playGate(String(programId ?? ''))
  )
  ipcMain.handle(IPC.programAudioProgress, (_e, programId: string) =>
    programPlayback.audioProgress(String(programId ?? ''))
  )
  // 预制节目按章跳播（上一章/下一章/章节点播）：装池提到队首，再打断当前条目让播放循环立即取它
  ipcMain.handle(
    IPC.programPlayUnit,
    (_e, programId: string, target: { kind: 'scene' | 'utterance'; id: string }) => {
      const result = programPlayback.playUnit(String(programId ?? ''), {
        kind: target?.kind === 'scene' ? 'scene' : 'utterance',
        id: String(target?.id ?? '')
      })
      if (result.ok && !result.already) pipeline?.stopAll()
      return result
    }
  )
  // 导入外部音频（§7.4）：主进程弹文件选择框，拷贝进预制音频目录并挂到指定 Scene/Utterance 的 rendered
  ipcMain.handle(
    IPC.programImportAudio,
    async (_e, programId: string, target: { kind: 'scene' | 'utterance'; id: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return { ok: false as const, error: '没有可用窗口' }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a'] }]
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false as const, error: '已取消' }
      return utterances.importExternalAudio(
        String(programId ?? ''),
        { kind: target?.kind === 'scene' ? 'scene' : 'utterance', id: String(target?.id ?? '') },
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

  // ---------- 话术库（节目底稿） ----------
  ipcMain.handle(IPC.utteranceList, (_e, programId: string) => utterances.list(String(programId)))
  ipcMain.handle(IPC.utteranceSave, (_e, input: UtteranceInput, id?: string) =>
    guard(() => utterances.save(input, id))
  )
  ipcMain.handle(IPC.utteranceDelete, (_e, id: string) => guard(() => utterances.remove(id)))
  ipcMain.handle(IPC.utteranceClear, (_e, programId: string, sceneId?: string) =>
    guard(() => utterances.clear(String(programId), sceneId))
  )
  ipcMain.handle(IPC.utterancePresynth, async (_e, programId: string) => {
    // 批量预合成：异步跑（带节目锁，主播改底稿触发的重合成共用同一条流水线），进度走 utteranceEvent
    void utterances.kickSynthesis(String(programId))
    return { ok: true }
  })

  // ---------- 编剧模式：主播自己写底稿 ----------
  ipcMain.handle(IPC.agentDraftStart, async (_e, programId: string) => {
    try {
      await agent.startDrafting(String(programId))
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
    pool = new SpeechPool(storage, tts, broadcastPool, ttsRealtime, () => agent?.currentVoice() ?? '')
    const prompts = new PromptTemplateService(storage)
    const persona = new PersonaService(storage, prompts)
    const knowledge = new KnowledgeService(storage)
    const memory = new MemoryService(storage)
    const script = new ScriptService(storage)
    bus = new EventBus(storage)
    // 节目底稿库（提前建：主播 Agent 的底稿工具、生成 Agent、节目启动都用它）
    const utterances = new UtteranceService(storage, tts, persona, script)
    utterances.onEvent = (u) => broadcastUtterance(u)
    utterances.onBatchDone = (programId) => broadcastUtteranceDone(programId)
    // 预制音频资产变化广播（Scene/Utterance 的 rendered 更新，渲染层刷新节目音频进度）
    utterances.onRenderedEvent = (programId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.programAudioEvent, { programId })
      }
    }
    // Agent 改场景（append/update/remove_scene）也触发预制音频的 stale 检测
    script.onContentChanged = (programId) => utterances.refreshRenderedStaleness(programId)
    agent = new AgentService(
      storage,
      pool,
      persona,
      prompts,
      knowledge,
      memory,
      script,
      utterances,
      broadcastAgent,
      // 对话时间线：文本流式 + 工具卡片，照 pi 事件流原样推到渲染层（docs/09 §11）
      broadcastDirectorTimeline
    )
    triggers = new TriggerRuntime(storage, bus, pool, agent)
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
    // 播放循环搬到了主进程：渲染层不再参与播放调度。留白优先听 agent 的（set_gap），没调走系统默认
    playback = new PlaybackLoop(
      pool,
      () => ttsStream,
      pipeline,
      () => agent?.currentGapMs() ?? storage.getConfig().live.bitGapMs,
      () => agent?.currentVoice() ?? ''
    )
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
    // agent 的连接器工具（list/call_connector_tool、商品同步）从这里取
    agent.getConnector = () => connector

    // 音色库（M8 声音克隆）：训练状态变化推给渲染进程；试听由主进程合成完直接出声（aux 槽）
    voiceSvc = new VoiceService(storage, tts, broadcastVoices, async (itemId, filePath) => {
      const request = pipeline!.playFile(itemId, filePath, { slot: 'aux' })
      const started = await request.started
      if (started.ok) await request.done
      return started
    })
    agent.getVoices = () => voiceSvc

    // 节目底稿库 + 节目播放（docs/07 §8.5）
    const programPlayback = new ProgramPlaybackService(storage, script, persona, utterances, pool, agent, connector, streamSvc, tts)
    // 节目音频导出（docs/10 §8.3，P6）：进度逐单元广播；export_program 工具的确认卡用它出计划摘要
    const exporter = new ExportService(storage, script)
    exporter.onProgress = (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.programExportEvent, progress)
      }
    }
    agent.getExporter = () => exporter
    // 就绪补装：直播中底稿每就绪一段就把当前场景新就绪的装进池（0 就绪开播不空转——边合成边播，不用等整批）
    const broadcastUtteranceOnly = utterances.onEvent
    utterances.onEvent = (u) => {
      broadcastUtteranceOnly?.(u)
      if (u.status !== 'ready' || !u.id) return
      if (storage.getConfig().live.activeProgramId !== u.programId) return
      const status = agent?.status()
      if (status?.state !== 'running' || status.purpose !== 'live') return
      const loaded = programPlayback.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 新就绪底稿补装 ${loaded} 条`)
    }
    // 场景推进（advance_scene）后把新场景话术库载入池，骨架不断档
    agent.onSceneAdvanced = () => {
      const loaded = programPlayback.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 新场景装载话术 ${loaded} 条`)
    }
    // 主播自己开播（start_live 工具）：跟「启动节目」按钮走同一条 ProgramPlaybackService.launch，预检拦截如实回报
    agent.onGoLive = async () => {
      const programId = storage.getConfig().live.activeProgramId
      if (!programId) return '没有选中节目，开不了播'
      // prep 会话也算「在跑」但没开播：prep→live 必须发开播事件（开播信号触发器靠它）
      const statusBefore = agent!.status()
      const wasLive = statusBefore.state !== 'stopped' && statusBefore.purpose === 'live'
      const result = await programPlayback.launch(programId)
      if (!result.ok) return `开播被预检拦下了：${result.error}`
      if (!wasLive) bus!.emit('stream.started', {}, 'agent')
      // 新一轮开播：上一场可能停在「收尾中」状态，复位
      resetStopWrap()
      // 0 就绪开播：后台合成还没出活，开播空隙叫「续写补给」顶上
      if ((result.loaded ?? 0) === 0) bus!.emit('pool.low', { remaining: 0 }, 'system')
      return `已开播：装载 ${result.loaded} 条底稿，播出通道已打开，评论开始进来了`
    }
    // 滚动补货（有闸）：池见底时——首轮没播完的底稿随时补（接着播不是循环）；
    // 全播过了要重播（循环）只在到底稿段数上限时才允许，没到就等主播续写/合成，允许冷场不硬顶
    bus.subscribe((event) => {
      if (event.type !== 'pool.empty') return
      const status = agent?.status()
      if (status?.state !== 'running' || status.purpose !== 'live') return
      const programId = storage.getConfig().live.activeProgramId
      if (!programId) return
      const program = storage.programList().find((p) => p.id === programId) ?? null
      // 「整轮播完/池见底」决策点读节目 finishMode（docs/10 §7）：stop = 播完即停，不循环重播。
      // 判定整轮真播完：没有没进过池的（首轮还在播叫「接着播」）、也没有排队/合成中的（内容在路上就等，允许冷场不自旋）。
      // 即兴（improvised）没有循环概念，天然走不到这（没有底稿可装）。
      if (
        program &&
        program.broadcastMode !== 'improvised' &&
        program.finishMode === 'stop' &&
        !programPlayback.hasFreshUtterances(programId) &&
        !programPlayback.hasIncomingUtterances(programId)
      ) {
        finishRoundStop(programId)
        return
      }
      if (!programPlayback.hasFreshUtterances(programId) && !programPlayback.atDraftCap(programId)) {
        console.log('[AgentAnchor] 池空了但未到段数上限：不循环重播，等主播续写/合成（允许冷场）')
        return
      }
      const loaded = programPlayback.loadActiveSceneUtterances()
      if (loaded > 0) console.log(`[AgentAnchor] 池见底，装回 ${loaded} 条底稿继续轮播`)
    })
    // 主播请示（ask_director）：AgentService 内部直接进对话时间线单通道（高亮卡片，不阻塞直播）
    // 紧急停止总闸（emergency_stop 工具，安全优先直接执行）：掐所有声音 + 停播放循环 + 停会话 + 收开播态
    agent.onEmergencyStop = async () => {
      pipeline?.stopAll()
      playback?.setRunning(false)
      agent?.setSpeakingPaused(true)
      const wasLive = agent?.status().live ?? false
      resetStopWrap()
      await agent?.panic()
      if (wasLive) {
        agent?.setLiveActive(false)
        bus?.emit('stream.ended', {}, 'system')
      }
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

    // 音频缓存：启动扫一次、之后每 30 分钟一次（按最久未用+容量上限清理；被话术条目引用的文件不删）
    void tts.sweepAudioCache()
    audioCacheSweep = setInterval(() => void tts.sweepAudioCache(), 30 * 60_000)
    audioCacheSweep.unref?.()
    timerInterval.unref?.()

    // 主题改了立刻让窗口 chrome 跟上（标题栏按钮、窗口底色）
    storage.onConfigChange((config) => paintAllWindows(config.theme))
    registerIpc(storage, tts, pool, agent, persona, prompts, knowledge, memory, bus, triggers, script, streamSvc, connector, utterances, programPlayback, exporter)
    createWindow(storage)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(storage)
    })
  })
}

app.on('window-all-closed', () => {
  crashNote('window-all-closed', '')
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
