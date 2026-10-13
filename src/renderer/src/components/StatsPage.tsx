import { useEffect, useState } from 'react'
import { Activity, BarChart3, NotebookText, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { EpisodeSummary, LiveEvent, ViewerProfile } from '../../../shared/types'

/** 事件类型中文名（主进程 EventRegistry 的展示副本） */
const EVENT_LABEL: Record<string, string> = {
  'comment.new': '评论',
  'viewer.join': '进场',
  'gift.received': '礼物',
  'like.burst': '点赞',
  'pool.empty': '池空',
  'pool.low': '低水位',
  'timer.interval': '节拍',
  'stream.started': '开播',
  'stream.ended': '下播',
  'trigger.fired': '触发',
  'trigger.dropped': '拦截'
}

/** 事件 payload 的人类可读摘要（不甩 JSON 原文） */
function summarizePayload(event: LiveEvent): string {
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'comment.new':
      return `${p.author ?? ''}：${p.content ?? ''}`
    case 'viewer.join':
      return String(p.name ?? '')
    case 'gift.received':
      return `${p.author ?? ''} 送出 ${p.giftName ?? '礼物'}`
    case 'like.burst':
      return `点赞 ${p.count ?? ''}`
    case 'trigger.fired':
      return `${p.name ?? ''}（${p.mode === 'tool' ? '模板直连' : p.mode === 'steer' ? '引导' : '任务'}）`
    case 'trigger.dropped':
      return `${p.name ?? ''}（${p.reason ?? '被防护拦截'}）`
    default:
      return ''
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 数据页：观众画像 / 场次摘要 / 事件时间线，选项卡组织。 */
export function StatsPage() {
  const [viewers, setViewers] = useState<ViewerProfile[]>([])
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([])
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [tab, setTab] = useState<'viewers' | 'episodes' | 'events'>('viewers')

  useEffect(() => {
    void window.api.memory.viewers().then(setViewers)
    void window.api.memory.episodes().then(setEpisodes)
    void window.api.event.recent(100).then(setEvents)
    // 事件时间线 5s 轮询刷新（事件经由 EventBus 落库，量小直查即可）
    const timer = setInterval(() => void window.api.event.recent(100).then(setEvents), 5000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BarChart3 className="size-4 text-primary" />
        <h1 className="text-sm font-medium">数据</h1>
        <p className="text-xs text-muted-foreground">观众画像 · 场次摘要 · 事件时间线</p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="viewers" className="px-3">观众画像 · {viewers.length}</TabsTrigger>
            <TabsTrigger value="episodes" className="px-3">场次摘要 · {episodes.length}</TabsTrigger>
            <TabsTrigger value="events" className="px-3">事件时间线</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="viewers" className="overflow-auto p-4">
          {viewers.length === 0 ? (
            <EmptyState icon={Users} text="还没有画像。开播后观众来互动，主播会自动记住他们" />
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
        </TabsContent>

        <TabsContent value="episodes" className="overflow-auto p-4">
          {episodes.length === 0 ? (
            <EmptyState icon={NotebookText} text="还没有摘要。主播下播时会自动复盘本场亮点和高频问题" />
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
        </TabsContent>

        <TabsContent value="events" className="overflow-auto p-4">
          {events.length === 0 ? (
            <EmptyState icon={Activity} text="还没有事件。开播或启动连接器演示模式后这里会滚起来" />
          ) : (
            <div className="flex flex-col gap-1">
              {events.map((event) => {
                const summary = summarizePayload(event)
                return (
                  <div key={event.id} className="flex items-center gap-2 rounded-md border bg-card px-3 py-1.5">
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {new Date(event.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <Badge variant={event.type.startsWith('trigger.') ? 'secondary' : 'outline'}>
                      {EVENT_LABEL[event.type] ?? event.type}
                    </Badge>
                    {summary && (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>
                        {summary}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function EmptyState({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
      <Icon className="size-8" strokeWidth={1.25} />
      <p className="text-sm">{text}</p>
    </div>
  )
}
