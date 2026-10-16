import { useEffect, useRef, useState } from 'react'
import { Bot, PanelRight, PictureInPicture2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { DirectorConsole } from './LivePage'

/** 键里带版本：以后浮窗结构改了可以直接换 v2，老键自然作废，不用猜旧数据是什么形状 */
const FLOAT_KEY = 'yuncast.agent-panel.float:v1'
// 无版本的旧键只做读取兜底，写只写新键：老用户升级后浮窗位置不丢
const LEGACY_FLOAT_KEY = 'yuncast.agent-panel.float'
/** 应用自己的标题栏高度（DragStrip h-10 = 40px，右侧是系统窗口按钮）：浮窗不许压上去 */
const TITLEBAR_H = 40

type FloatRect = { x: number; y: number; width: number; height: number }

/** 浮窗位置钳制：顶部让开标题栏，底部/右侧不出屏 */
function clampRect(rect: FloatRect): FloatRect {
  const width = Math.max(360, Math.min(window.innerWidth - 16, rect.width))
  const height = Math.max(320, Math.min(window.innerHeight - TITLEBAR_H - 16, rect.height))
  return {
    width,
    height,
    x: Math.max(8, Math.min(window.innerWidth - width - 8, rect.x)),
    y: Math.max(TITLEBAR_H + 8, Math.min(window.innerHeight - height - 8, rect.y))
  }
}

function initialRect(): FloatRect {
  try {
    const stored = JSON.parse(localStorage.getItem(FLOAT_KEY) ?? localStorage.getItem(LEGACY_FLOAT_KEY) ?? '') as FloatRect
    if (stored.width >= 360 && stored.height >= 420) return clampRect(stored)
  } catch {}
  return clampRect({ x: Math.max(20, window.innerWidth - 440), y: TITLEBAR_H + 8, width: 400, height: 620 })
}

export function AgentPanel() {
  const mode = useAppStore((s) => s.agentPanelMode)
  const context = useAppStore((s) => s.agentPanelContext)
  const width = useAppStore((s) => s.agentPanelWidth)
  const setMode = useAppStore((s) => s.setAgentPanelMode)
  const setContext = useAppStore((s) => s.setAgentPanelContext)
  const setWidth = useAppStore((s) => s.setAgentPanelWidth)
  const agent = useAppStore((s) => s.agent)
  const page = useAppStore((s) => s.page)
  const [directorName, setDirectorName] = useState('小云')
  const [rect, setRect] = useState<FloatRect>(initialRect)
  const dragRef = useRef<{ kind: 'move' | 'resize' | 'dock'; x: number; y: number; rect: FloatRect; width: number } | null>(null)

  useEffect(() => {
    if (!('api' in window)) return
    void window.api.director.get().then((director) => setDirectorName(director?.name?.trim() || '小云'))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setMode(mode === 'minimized' ? (useAppStore.getState().page === 'live' ? 'docked' : 'floating') : 'minimized')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, setMode])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = dragRef.current
      if (!start) return
      if (start.kind === 'dock') {
        setWidth(start.width + start.x - event.clientX)
        return
      }
      if (start.kind === 'move') {
        // 顶部钳到标题栏下沿：不让浮窗压住应用自己的标题栏与系统窗口按钮
        const next = clampRect({
          ...start.rect,
          x: start.rect.x + event.clientX - start.x,
          y: start.rect.y + event.clientY - start.y
        })
        setRect(next)
        if (event.clientX >= window.innerWidth - 18) setMode('docked')
        return
      }
      setRect(
        clampRect({
          ...start.rect,
          width: start.rect.width + event.clientX - start.x,
          height: start.rect.height + event.clientY - start.y
        })
      )
    }
    const up = () => {
      if (dragRef.current?.kind !== 'dock') localStorage.setItem(FLOAT_KEY, JSON.stringify(rect))
      dragRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [rect, setMode, setWidth])

  const minimized = mode === 'minimized'
  const floating = mode === 'floating'
  /** 悬浮球别压直播台底部那一条（播放条 + 状态栏）：直播页抬高一个播放条的量，其他页常规位置 */
  const ballBottom = page === 'live' ? 'bottom-32' : 'bottom-10'
  return (
    <>
      {minimized && (
        <button
          type="button"
          className={cn(
            'fixed right-5 z-50 flex size-12 items-center justify-center rounded-full border bg-background shadow-lg transition-transform hover:scale-105',
            ballBottom
          )}
          onClick={() => setMode(useAppStore.getState().page === 'live' ? 'docked' : 'floating')}
          title="打开导演"
        >
          <Bot className="size-5" />
          {agent.busy && <span className="absolute top-0 right-0 size-3 animate-pulse rounded-full border-2 border-background bg-primary" />}
        </button>
      )}
      <aside
      className={cn(
        'fixed z-40 flex min-h-0 flex-col overflow-hidden border bg-background shadow-xl',
        minimized && 'invisible pointer-events-none',
        floating ? 'rounded-xl' : 'right-0 bottom-0 border-y-0 border-r-0'
      )}
      style={
        floating
          ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
          : { top: TITLEBAR_H, width }
      }
    >
      {!floating && (
        <div
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/20"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { kind: 'dock', x: event.clientX, y: event.clientY, rect, width }
          }}
        />
      )}
      <header
        className={cn('flex h-11 shrink-0 items-center gap-2 border-b px-3', floating && 'cursor-move')}
        onPointerDown={(event) => {
          if (!floating || (event.target as HTMLElement).closest('button')) return
          dragRef.current = { kind: 'move', x: event.clientX, y: event.clientY, rect, width }
        }}
      >
        <span className="size-2 rounded-full bg-emerald-500" />
        <span className="text-sm font-medium">{directorName}</span>
        <span className="text-xs text-muted-foreground">导演</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMode(floating ? 'docked' : 'floating')}
            title={floating ? '停靠到右侧' : '切换为悬浮窗'}
          >
            {floating ? <PanelRight /> : <PictureInPicture2 />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setMode('minimized')} title="关闭（对话继续，随时可再打开）">
            <X />
          </Button>
        </div>
      </header>
      {context && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate">{context.label}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setContext(null)} title="移除上下文">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <DirectorConsole active onUnread={() => {}} />
      {floating && (
        <div
          className="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { kind: 'resize', x: event.clientX, y: event.clientY, rect, width }
          }}
        />
      )}
      </aside>
    </>
  )
}
