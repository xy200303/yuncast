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
import { ProgramsPage } from './components/ProgramsPage'
import { StatsPage } from './components/StatsPage'
import { SettingsDialog } from './components/SettingsDialog'
import { useAppStore, type NavPage } from './stores/useAppStore'
import { audioEngine } from './audio/engine'
import { streamPlayer } from './audio/streamPlayer'

const PAGES: Record<NavPage, ComponentType> = {
  live: LivePage,
  anchors: AnchorsPage,
  knowledge: KnowledgePage,
  voices: VoicesPage,
  programs: ProgramsPage,
  stats: StatsPage
}

export default function App() {
  const page = useAppStore((s) => s.page)
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

  useEffect(() => {
    if (!('api' in window)) return // 纯浏览器打开 dev server 时没有 preload
    loadConfig()
    void loadModelLibrary()
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => syncSystemTheme()
    themeQuery.addEventListener('change', onTheme)
    return () => themeQuery.removeEventListener('change', onTheme)
  }, [loadConfig, loadModelLibrary, syncSystemTheme])

  // 音频终端 + 话术池订阅（应用级单例，挂载即运行）。
  // 播放调度在主进程：这里只把推来的 PCM 排播出声、把电平显示出来。
  useEffect(() => {
    if (!('api' in window)) return
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
    setLoopRunning(true)
    return () => {
      offPcm()
      offEnd()
      offLevel()
      offSnapshot()
      streamPlayer.stop()
      setLoopRunning(false)
    }
  }, [setPool, setLevels, setLoopRunning])

  // 主播 Agent 状态 + 评论事件 + 推流状态订阅
  useEffect(() => {
    if (!('api' in window)) return
    const refreshPersona = useAppStore.getState().refreshPersona
    const offAgent = window.api.agent.onStatus((status) => {
      const prev = useAppStore.getState().agent.state
      setAgent(status)
      // 节目开播会按节目把人设卡切成当前主播，徽章要跟着新的卡走
      if (status.state !== prev) void refreshPersona()
    })
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
    return () => {
      offAgent()
      offStream()
      offConnector()
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
