import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { audition, useAuditionStore } from '../lib/audition'

/**
 * 全局试听条（docs/11 第二部分）：挂在 App 级，任何页面触发试听都浮在这同一条上。
 * 呼吸点 + 段标题 + 暂停/继续 + 停止；外观参照 NowPlayingBar。
 */
export function AuditionBar() {
  const { key, title, audioPath, playing, paused } = useAuditionStore()
  if (!playing) return null
  return (
    <div className="shrink-0 border-t bg-card/60">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className={cn('size-2 shrink-0 rounded-full bg-primary', !paused && 'animate-pulse')} />
        <span className="shrink-0 text-xs text-muted-foreground">试听</span>
        <span className="min-w-0 flex-1 truncate text-[13px]" title={title}>
          {title}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title={paused ? '继续试听' : '暂停试听'}
          onClick={() => audition.toggle({ key, title, audioPath })}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button variant="ghost" size="icon-sm" title="停止试听" onClick={() => audition.stop()}>
          <Square />
        </Button>
      </div>
    </div>
  )
}
