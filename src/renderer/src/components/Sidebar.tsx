import type { CSSProperties } from 'react'
import {
  AudioLines,
  BarChart3,
  History,
  PanelLeft,
  Radio,
  Settings,
  type LucideIcon
} from 'lucide-react'
import logoUrl from '../../assets/logo.svg'
import { BRAND_NAME_EN, BRAND_NAME_ZH } from '../../../shared/brand'
import { useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore, type NavPage } from '../stores/useAppStore'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * 项目工作区的导航：
 *   项目  —— 直播台（内容 + 播出）
 *   全局  —— 音色库（跨项目复用的 TTS 资源）
 *   数据  —— 场次记录、统计
 * 项目入口只在顶部菜单「项目」里：新建 / 打开 / 切换。
 */
export const NAV_ITEMS: { id: NavPage; label: string; icon: LucideIcon; section: string }[] = [
  { id: 'live', label: '直播台', icon: Radio, section: '项目' },
  { id: 'voices', label: '音色库', icon: AudioLines, section: '全局' },
  { id: 'sessions', label: '场次记录', icon: History, section: '数据' },
  { id: 'stats', label: '统计', icon: BarChart3, section: '数据' }
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
      {/* 顶行：和菜单栏同高（h-9），整行可拖 */}
      <div
        className={cn('flex h-9 shrink-0 items-center gap-2 border-b', collapsed ? 'justify-center' : 'px-3')}
        style={drag}
      >
        {!collapsed && (
          <>
            <img src={logoUrl} alt={BRAND_NAME_ZH} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {BRAND_NAME_ZH} <span className="text-xs font-normal text-muted-foreground">{BRAND_NAME_EN}</span>
            </span>
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
      <nav className={cn('flex min-h-0 flex-1 flex-col gap-1 py-3', collapsed ? 'items-center px-1' : 'px-2.5')}>
        {NAV_ITEMS.map((item, index) => {
          const Icon = item.icon
          const active = page === item.id
          const showSection = index === 0 || NAV_ITEMS[index - 1].section !== item.section
          const button = (
            <Button
              key={item.id}
              variant={active ? 'secondary' : 'ghost'}
              size={collapsed ? 'icon' : 'default'}
              className={cn(
                !collapsed && 'h-10 w-full justify-start gap-2.5 px-3 text-sm',
                collapsed && 'h-10 w-10',
                active && 'text-primary'
              )}
              onClick={() => setPage(item.id)}
            >
              <Icon className={collapsed ? 'size-5' : 'size-[18px]'} />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Button>
          )
          if (!collapsed) {
            return (
              <div key={item.id} className="flex flex-col gap-1">
                {showSection && index > 0 && (
                  <p className="mt-2 px-3 text-[11px] text-muted-foreground">{item.section}</p>
                )}
                {button}
              </div>
            )
          }
          return (
            <div key={item.id} className="flex flex-col items-center">
              {showSection && index > 0 && <span className="my-1.5 h-px w-6 bg-border" />}
              <Tooltip>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </nav>

      {/* 底部：设置入口（弹窗，不占页面流） */}
      <div className={cn('shrink-0 border-t p-2.5', collapsed && 'flex justify-center px-1')}>
        {(() => {
          const button = (
            <Button
              variant="ghost"
              size={collapsed ? 'icon' : 'default'}
              className={cn(!collapsed && 'h-10 w-full justify-start gap-2.5 px-3 text-sm', collapsed && 'h-10 w-10')}
              onClick={() => useAppStore.getState().setSettingsOpen(true)}
            >
              <Settings className={collapsed ? 'size-5' : 'size-[18px]'} />
              {!collapsed && <span>设置</span>}
            </Button>
          )
          if (!collapsed) return button
          return (
            <Tooltip>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="right">设置</TooltipContent>
            </Tooltip>
          )
        })()}
      </div>
    </div>
  )
}
