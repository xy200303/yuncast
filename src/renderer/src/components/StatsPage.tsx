import { useEffect, useState } from 'react'
import { BarChart3, NotebookText, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { EpisodeSummary, ViewerProfile } from '../../../shared/types'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 数据页（M4 简单版）：观众画像 + 场次摘要。评论/回复统计和事件时间线留给 M5+。 */
export function StatsPage() {
  const [viewers, setViewers] = useState<ViewerProfile[]>([])
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([])

  useEffect(() => {
    void window.api.memory.viewers().then(setViewers)
    void window.api.memory.episodes().then(setEpisodes)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BarChart3 className="size-4 text-primary" />
        <h1 className="text-sm font-medium">数据</h1>
        <p className="text-xs text-muted-foreground">观众画像 · 场次摘要</p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" />
          观众画像 · {viewers.length}
        </p>
        {viewers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <Users className="size-8" strokeWidth={1.25} />
            <p className="text-sm">还没有画像。开播后观众来互动，主播会自动记住他们</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {viewers.map((viewer) => (
              <div key={viewer.name} className="rounded-lg border bg-card px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium">{viewer.name}</span>
                  <Badge variant="secondary">互动 {viewer.interactions}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">最近互动 {formatTime(viewer.lastSeenAt)}</p>
                {viewer.asks.length > 0 && (
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={viewer.asks.join('\n')}>
                    问过：{viewer.asks.slice(0, 2).join('；')}
                  </p>
                )}
                {viewer.notes.length > 0 && (
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={viewer.notes.join('\n')}>
                    备注：{viewer.notes.slice(0, 2).join('；')}
                  </p>
                )}
                {viewer.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {viewer.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mt-6 mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <NotebookText className="size-3.5" />
          场次摘要 · {episodes.length}
        </p>
        {episodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <NotebookText className="size-8" strokeWidth={1.25} />
            <p className="text-sm">还没有摘要。主播下播时会自动复盘本场亮点和高频问题</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {episodes.map((episode) => (
              <div key={episode.id} className="rounded-lg border bg-card px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  {formatTime(episode.startedAt)} 开播 · 播了 {Math.max(1, Math.round((episode.endedAt - episode.startedAt) / 60000))} 分钟
                </p>
                <p className="mt-1 text-[13px] leading-6">{episode.summary}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
