import { useEffect, type ComponentType } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AppSidebar } from './components/Sidebar'
import { DragStrip } from './components/DragStrip'
import { StatusBar } from './components/StatusBar'
import { LivePage } from './components/LivePage'
import { AnchorsPage } from './components/AnchorsPage'
import { KnowledgePage } from './components/KnowledgePage'
import { SessionsPage } from './components/SessionsPage'
import { StatsPage } from './components/StatsPage'
import { SettingsPage } from './components/SettingsPage'
import { useAppStore, type NavPage } from './stores/useAppStore'

const PAGES: Record<NavPage, ComponentType> = {
  live: LivePage,
  anchors: AnchorsPage,
  knowledge: KnowledgePage,
  sessions: SessionsPage,
  stats: StatsPage,
  settings: SettingsPage
}

export default function App() {
  const page = useAppStore((s) => s.page)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const syncSystemTheme = useAppStore((s) => s.syncSystemTheme)

  useEffect(() => {
    loadConfig()
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => syncSystemTheme()
    themeQuery.addEventListener('change', onTheme)
    return () => themeQuery.removeEventListener('change', onTheme)
  }, [loadConfig, syncSystemTheme])

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh min-h-0">
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <DragStrip />
          {/* 六个页面常驻不卸载，只切换显隐（不用会卸载内容的 Tabs 组件） */}
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
      </SidebarProvider>
    </TooltipProvider>
  )
}
