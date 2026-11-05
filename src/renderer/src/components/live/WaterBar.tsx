import { useMemo } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { useLiveStore } from '../../stores/useLiveStore'
import { cn } from '@/lib/utils'
import { stripSpeechTags } from '../../../../shared/speechTags'

/**
 * 水位条（docs/12 第九节）。
 *
 * 回答两个问题：**现在在播哪一段**、**还能撑多久**。
 * 三段式：已播（实心）/ 已就绪缓冲（浅实心）/ 未就绪（虚线），缓冲每合成好一条就往右长一截。
 * 未开播时不画进度，只留一行"未开播 · 底稿 11 段待播"，别让空进度条占地方。
 */

/** 粗估时长：中文 4.5 字/秒（只用于"还能撑多久"，不当作事实展示） */
function secondsOf(text: string): number {
  return Math.max(1, Math.round(stripSpeechTags(text).trim().length / 4.5))
}

export function WaterBar() {
  const live = useAppStore((s) => s.agent.live === true)
  const pool = useAppStore((s) => s.pool)
  const history = useLiveStore((s) => s.history)
  const drafts = useLiveStore((s) => s.drafts)

  const stats = useMemo(() => {
    const ready = pool.items.filter((item) => item.status === 'ready' || item.status === 'playing')
    const pending = pool.items.filter((item) => item.status === 'pending' || item.status === 'synthesizing')
    const failed = pool.failed.length
    const readySec = ready.reduce((sum, item) => sum + secondsOf(item.text), 0)
    const pendingSec = pending.reduce((sum, item) => sum + secondsOf(item.text), 0)
    const total = readySec + pendingSec
    return {
      playedCount: history.length,
      readyCount: ready.length,
      pendingCount: pending.length,
      failed,
      readySec,
      pendingSec,
      readyPct: total > 0 ? (readySec / total) * 100 : 0
    }
  }, [pool, history])

  if (!live) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        未开播
        <span className="text-muted-foreground/60">
          {drafts.length} 段底稿待播 · 点「启动节目」选好主播与声音再开
        </span>
      </div>
    )
  }

  const mmss = (sec: number) => {
    const m = Math.floor(sec / 60)
    return `${m} 分 ${String(Math.round(sec % 60)).padStart(2, '0')} 秒`
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t px-4 pt-1.5 pb-1">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {/* 已播：占整体比例按条数（历史没有时长口径，用条数近似） */}
        <div
          className="h-full bg-foreground/25"
          style={{ width: `${Math.min(100, (stats.playedCount / Math.max(1, stats.playedCount + stats.readyCount + stats.pendingCount)) * 100)}%` }}
        />
        <div className="h-full bg-primary/45" style={{ width: `${stats.readyPct / Math.max(1, 1 + stats.pendingSec / Math.max(1, stats.readySec))}%` }} />
        <div className="h-full flex-1 bg-[repeating-linear-gradient(90deg,rgba(0,0,0,.10)_0_4px,transparent_4px_8px)]" />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={cn(stats.readySec < 120 && 'text-amber-600')}>
          还能播 {mmss(stats.readySec)}
        </span>
        <span>·</span>
        <span>就绪 {stats.readyCount} 条</span>
        {stats.pendingCount > 0 && <span>· 待合成 {stats.pendingCount} 条</span>}
        {stats.failed > 0 && <span className="text-amber-600">· 失败 {stats.failed} 条</span>}
        <span className="ml-auto">已播 {stats.playedCount} 段</span>
      </div>
    </div>
  )
}
