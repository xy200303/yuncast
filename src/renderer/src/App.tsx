import { useEffect, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { AppSidebar } from './components/Sidebar'
import { MenuBar } from './components/MenuBar'
import { ProjectCreateDialog } from './components/ProjectCreateDialog'
import { ProjectSwitchDialog } from './components/ProjectSwitchDialog'
import { StatusBar } from './components/StatusBar'
import { LivePage } from './components/LivePage'
import { VoicesPage } from './components/VoicesPage'
import { SessionsPage } from './components/SessionsPage'
import { StatsPage } from './components/StatsPage'
import { SettingsDialog } from './components/SettingsDialog'
import { AgentPanel } from './components/AgentPanel'
import { ProjectWelcome } from './components/ProjectWelcome'
import { AuditionBar } from './components/AuditionBar'
import { useAppStore, type NavPage } from './stores/useAppStore'
import { useProjectStore } from './stores/useProjectStore'
import { audioEngine } from './audio/engine'
import { initScreenRecorder } from './audio/screenRecorder'
import { initVirtualCursor } from './overlay/virtualCursor'
import { streamPlayer } from './audio/streamPlayer'

const PAGES: Record<NavPage, ComponentType> = {
  live: LivePage,
  voices: VoicesPage,
  sessions: SessionsPage,
  stats: StatsPage
}

export default function App() {
  const page = useAppStore((s) => s.page)
  const project = useProjectStore((s) => s.current)
  const [createOpen, setCreateOpen] = useState(false)
  const [switchOpen, setSwitchOpen] = useState(false)
  const agentPanelMode = useAppStore((s) => s.agentPanelMode)
  const agentPanelWidth = useAppStore((s) => s.agentPanelWidth)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const loadModelLibrary = useAppStore((s) => s.loadModelLibrary)
  const syncSystemTheme = useAppStore((s) => s.syncSystemTheme)
  const setPool = useAppStore((s) => s.setPool)
  const setLevels = useAppStore((s) => s.setLevels)
  const setLoopRunning = useAppStore((s) => s.setLoopRunning)
  const setAgent = useAppStore((s) => s.setAgent)
  const setStream = useAppStore((s) => s.setStream)
  const setConnector = useAppStore((s) => s.setConnector)
  const setVoices = useAppStore((s) => s.setVoices)
  const setPage = useAppStore((s) => s.setPage)

  // 主进程/外部调用让界面切页（演示录屏时把直播台推到前台）
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.ui.onNavigate((page) => setPage(page as Parameters<typeof setPage>[0]))
  }, [setPage])

  useEffect(() => {
    if (!('api' in window)) return // 纯浏览器打开 dev server 时没有 preload
    void Promise.all([loadConfig(), loadModelLibrary()])
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => syncSystemTheme()
    themeQuery.addEventListener('change', onTheme)
    return () => themeQuery.removeEventListener('change', onTheme)
  }, [loadConfig, loadModelLibrary, syncSystemTheme])

  // 音频终端 + 话术池订阅（应用级单例，挂载即运行）。
  // 播放调度在主进程：这里只把推来的 PCM 排播出声、把电平显示出来。
  useEffect(() => {
    if (!('api' in window)) return
    initScreenRecorder()
    initVirtualCursor()
    audioEngine.init({ onHumanSpeaking: () => {} })
    const offPcm = window.api.audio.onPcm((payload) => {
      streamPlayer.push(
        new Int16Array(payload.pcm.buffer, payload.pcm.byteOffset, payload.pcm.byteLength >> 1),
        payload.sampleRate
      )
    })
    const offEnd = window.api.audio.onEnd((payload) => {
      // 正常播完：游标留着，下一条接着排（连播不空档）；被跳过/急停：立刻掐断
      if (payload.stopped) streamPlayer.stop()
      else streamPlayer.end()
    })
    const offLevel = window.api.audio.onLevel((payload) => setLevels(payload))
    /** 本轮连续失败计数：TTS 凭据不通时会十几条连环失败，提示合成一条，别把界面糊住 */
    let failedBurst = 0
    const offSnapshot = window.api.pool.onSnapshot((snapshot) => {
      const prevFailed = new Set(useAppStore.getState().pool.failed.map((item) => item.id))
      const fresh = snapshot.failed.filter((item) => !prevFailed.has(item.id))
      if (snapshot.failed.length === 0) failedBurst = 0
      if (fresh.length > 0) {
        failedBurst += fresh.length
        const latest = fresh[fresh.length - 1]
        toast.error('合成失败', {
          // 固定 id：同一条提示就地更新，不叠一摞盖住顶栏
          id: 'tts-failed',
          description:
            (failedBurst > 1 ? `连续 ${failedBurst} 条：` : `${latest.text.slice(0, 24)}：`) +
            (latest.error ?? '未知原因')
        })
      }
      setPool(snapshot)
    })
    void window.api.pool.snapshot().then(setPool)
    return () => {
      offPcm()
      offEnd()
      offLevel()
      offSnapshot()
      streamPlayer.stop()
    }
  }, [setPool, setLevels])

  // 主播 Agent 状态 + 评论事件 + 推流状态订阅
  useEffect(() => {
    if (!('api' in window)) return
    const offAgent = window.api.agent.onStatus((status) => {
      setAgent(status)
      // 播报暂停态以主进程为准（speakingPaused 随状态广播来，重启后不失真）
      setLoopRunning(status.speakingPaused !== true)
    })
    void window.api.agent.status().then((status) => {
      setAgent(status)
      setLoopRunning(status.speakingPaused !== true)
    })
    void window.api.stream.stats().then(setStream)
    void window.api.connector.status().then(setConnector)
    const offStream = window.api.stream.onStats((stats) => {
      setStream(stats)
      if (stats.state === 'error' && stats.error) {
        toast.error('推流出错', { description: stats.error })
      }
    })
    const offConnector = window.api.connector.onStatus(setConnector)
    const offVoices = window.api.voice.onChanged(setVoices)
    void window.api.voice.list().then(setVoices)
    // 配置是「主进程里 agent/MCP 也能改」的数据：任何一处落库都重拉一次，界面不再停在旧配置上
    const offData = window.api.data.onChanged((payload) => {
      if (payload.scope === 'settings') void loadConfig()
    })
    return () => {
      offAgent()
      offStream()
      offConnector()
      offVoices()
      offData()
    }
  }, [setAgent, setStream, setConnector, setVoices, setLoopRunning, loadConfig])

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh min-h-0">
        <AppSidebar />
        <SidebarInset
          className="min-h-0 overflow-hidden transition-[margin] duration-200"
          style={agentPanelMode === 'docked' ? { marginRight: agentPanelWidth } : undefined}
        >
          <MenuBar
            onCreateProject={() => setCreateOpen(true)}
            onOpenProject={() => setSwitchOpen(true)}
            onOpenFolder={() => {
              void (async () => {
                const picked = await window.api.project.pickDir()
                if (!picked.ok) return
                try {
                  await useProjectStore.getState().openAt(picked.path)
                } catch (error) {
                  toast.error('打开项目失败', {
                    description: error instanceof Error ? error.message : String(error)
                  })
                }
              })()
            }}
            onAbout={() => useAppStore.getState().openSettings('about')}
          />
          {project ? (
            <>
              {/* 项目内的页面常驻不卸载，只切换显隐（不用会卸载内容的 Tabs 组件） */}
              <div className="flex min-h-0 flex-1 flex-col">
                {(Object.keys(PAGES) as NavPage[]).map((id) => {
                  const Page = PAGES[id]
                  return (
                    <div key={id} className={cn('min-h-0 flex-1 flex-col', id === page ? 'flex' : 'hidden')}>
                      <Page />
                    </div>
                  )
                })}
              </div>
              {/* 全局试听条：任何页面触发的试听都收在这同一条上（aux 槽，不打断播报） */}
              <AuditionBar />
            </>
          ) : (
            <ProjectWelcome />
          )}
          <StatusBar />
        </SidebarInset>
        {project && <AgentPanel />}
        <SettingsDialog />
        <ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
        <ProjectSwitchDialog
          open={switchOpen}
          onOpenChange={setSwitchOpen}
          onCreate={() => setCreateOpen(true)}
        />
        {/* Toaster 提到 body 层：否则会被布局树的堆叠上下文困住，弹窗遮罩会盖住提示 */}
        {createPortal(<Toaster />, document.body)}
      </SidebarProvider>
    </TooltipProvider>
  )
}
