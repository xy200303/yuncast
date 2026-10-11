import { useEffect, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { AppSidebar } from './components/Sidebar'
import { DragStrip } from './components/DragStrip'
import { StatusBar } from './components/StatusBar'
import { LivePage } from './components/LivePage'
import { AnchorsPage } from './components/AnchorsPage'
import { KnowledgePage } from './components/KnowledgePage'
import { VoicesPage } from './components/VoicesPage'
import { SessionsPage } from './components/SessionsPage'
import { StatsPage } from './components/StatsPage'
import { SettingsDialog } from './components/SettingsDialog'
import { useAppStore, type NavPage } from './stores/useAppStore'
import { audioEngine } from './audio/engine'
import { playbackLoop } from './audio/playbackLoop'

const PAGES: Record<NavPage, ComponentType> = {
  live: LivePage,
  anchors: AnchorsPage,
  knowledge: KnowledgePage,
  voices: VoicesPage,
  sessions: SessionsPage,
  stats: StatsPage
}

export default function App() {
  const page = useAppStore((s) => s.page)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const syncSystemTheme = useAppStore((s) => s.syncSystemTheme)
  const setPool = useAppStore((s) => s.setPool)
  const setLevels = useAppStore((s) => s.setLevels)
  const setLoopRunning = useAppStore((s) => s.setLoopRunning)
  const setAgent = useAppStore((s) => s.setAgent)
  const setStream = useAppStore((s) => s.setStream)
  const setConnector = useAppStore((s) => s.setConnector)
  const setVoices = useAppStore((s) => s.setVoices)

  useEffect(() => {
    if (!('api' in window)) return // 纯浏览器打开 dev server 时没有 preload
    loadConfig()
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => syncSystemTheme()
    themeQuery.addEventListener('change', onTheme)
    return () => themeQuery.removeEventListener('change', onTheme)
  }, [loadConfig, syncSystemTheme])

  // 音频引擎 + 话术池订阅 + 播放循环（应用级单例，挂载即运行）
  useEffect(() => {
    if (!('api' in window)) return
    audioEngine.init({ onLevels: setLevels, onHumanSpeaking: () => {} })
    const offSnapshot = window.api.pool.onSnapshot((snapshot) => {
      const prevFailed = new Set(useAppStore.getState().pool.failed.map((item) => item.id))
      for (const item of snapshot.failed) {
        if (!prevFailed.has(item.id)) {
          toast.error('合成失败', { description: `${item.text.slice(0, 40)}：${item.error ?? '未知原因'}` })
        }
      }
      setPool(snapshot)
      playbackLoop.kick()
    })
    void window.api.pool.snapshot().then(setPool)
    playbackLoop.start()
    setLoopRunning(true)
    return () => {
      offSnapshot()
      playbackLoop.stop()
      setLoopRunning(false)
    }
  }, [setPool, setLevels, setLoopRunning])

  // 主播 Agent 状态 + 评论事件 + 推流状态订阅
  useEffect(() => {
    if (!('api' in window)) return
    const offAgent = window.api.agent.onStatus(setAgent)
    void window.api.agent.status().then(setAgent)
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
    const offComment = window.api.comment.onComment((comment) => {
      toast.message(`💬 ${comment.author}`, { description: comment.content })
    })
    return () => {
      offAgent()
      offStream()
      offConnector()
      offComment()
      offVoices()
    }
  }, [setAgent, setStream, setConnector, setVoices, setConnector])

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh min-h-0">
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <DragStrip />
          {/* 五个页面常驻不卸载，只切换显隐（不用会卸载内容的 Tabs 组件） */}
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
          <StatusBar />
        </SidebarInset>
        <SettingsDialog />
        {/* Toaster 提到 body 层：否则会被布局树的堆叠上下文困住，弹窗遮罩会盖住提示 */}
        {createPortal(<Toaster />, document.body)}
      </SidebarProvider>
    </TooltipProvider>
  )
}
