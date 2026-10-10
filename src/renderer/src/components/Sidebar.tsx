import type { CSSProperties } from 'react'
import {
  Anchor,
  BarChart3,
  BookOpen,
  Bot,
  CalendarDays,
  PanelLeft,
  Radio,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore, type NavPage } from '../stores/useAppStore'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

export const NAV_ITEMS: { id: NavPage; label: string; icon: LucideIcon }[] = [
  { id: 'live', label: '直播台', icon: Radio },
  { id: 'anchors', label: '主播团', icon: Bot },
  { id: 'knowledge', label: '知识库', icon: BookOpen },
  { id: 'sessions', label: '场次', icon: CalendarDays },
  { id: 'stats', label: '数据', icon: BarChart3 },
  { id: 'settings', label: '设置', icon: Settings }
]

/**
 * 应用侧边栏。不用 shadcn Sidebar 的 fixed 布局：
 * 那一层会和文档流占位各画一次，在 Electron 里左边会露出重影。
 * 收纳状态仍走 SidebarProvider（w-64 ↔ w-12）。
 */
export function AppSidebar() {
  const { state, toggleSidebar } = useSidebar()
  const collapsed = state === 'collapsed'
  const page = useAppStore((s) => s.page)
  const setPage = useAppStore((s) => s.setPage)

  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        collapsed ? 'w-12 min-w-12 max-w-12' : 'w-64 min-w-64 max-w-64'
      )}
    >
      {/* 顶行：和 DragStrip 同高（h-10），整行可拖 */}
      <div
        className={cn('flex h-10 shrink-0 items-center gap-2 border-b', collapsed ? 'justify-center' : 'px-2')}
        style={drag}
      >
        {!collapsed && (
          <>
            <Anchor className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">Agent Anchor</span>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title={collapsed ? '展开侧边栏' : '收纳侧边栏'}
          style={noDrag}
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </Button>
      </div>

      {/* 图标导航 */}
      <nav className={cn('flex min-h-0 flex-1 flex-col gap-0.5 py-2', collapsed ? 'items-center px-1' : 'px-2')}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = page === item.id
          const button = (
            <Button
              key={item.id}
              variant={active ? 'secondary' : 'ghost'}
              size={collapsed ? 'icon-sm' : 'sm'}
              className={cn(!collapsed && 'w-full justify-start gap-2', active && 'text-primary')}
              onClick={() => setPage(item.id)}
            >
              <Icon />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Button>
          )
          if (!collapsed) return button
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </div>
  )
}
