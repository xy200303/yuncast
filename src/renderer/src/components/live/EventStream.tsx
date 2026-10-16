import { useEffect, useMemo, useRef } from 'react'
import { Bell, Gift, Heart, LogIn, MessageSquareText, Inbox } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { LiveInboxEvent, LiveInboxKind, LiveEventState } from '../../../../shared/types'
import { LIVE_EVENT_STATE_LABELS } from '../../../../shared/types'

const KIND_ICON: Record<LiveInboxKind, typeof Gift> = {
  comment: MessageSquareText,
  gift: Gift,
  follow: Heart,
  entrance: LogIn,
  trigger: Bell
}

const KIND_LABEL: Record<LiveInboxKind, string> = {
  comment: '评论',
  gift: '礼物',
  follow: '关注',
  entrance: '进场',
  trigger: '系统通知'
}

function stateVariant(state: LiveEventState): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (state) {
    case 'new':
      return 'default'
    case 'seen':
      return 'secondary'
    case 'handled':
      return 'outline'
    default:
      return 'outline'
  }
}

/**
 * 事件流：发给主播的直播间动态（数据与订阅由 LivePage 持有，这里只渲染）。
 * 口径与「评论流」一致：新的一条在底部 + 自动跟随。主进程的快照是"新的在前"，
 * 这里反过来渲染，别让两个紧邻的选项卡一个新在上一个新在下。
 */
export function EventStream({ events }: { events: LiveInboxEvent[] }) {
  const listRef = useRef<HTMLDivElement>(null)
  /** 新的在前 → 倒序成"新的在底"，和评论流同一个方向 */
  const items = useMemo(() => [...events].reverse(), [events])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length])

  if (events.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Inbox className="size-8" strokeWidth={1.25} />
        <p className="text-sm">还没有直播间动态：评论、礼物、触发器消息会按批送到主播</p>
      </div>
    )
  }
  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pt-2 pb-2">
      {items.map((event) => {
        const Icon = KIND_ICON[event.kind]
        const dead = event.state === 'expired' || event.state === 'ignored'
        return (
          <div key={event.id} className={`flex items-baseline gap-2 text-[13px] ${dead ? 'opacity-50' : ''}`}>
            <span className="shrink-0 text-xs text-muted-foreground">
              {new Date(event.receivedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
              })}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Icon className="size-3" />
              {KIND_LABEL[event.kind]}
            </span>
            <span className="shrink-0 font-medium text-primary">{event.author}</span>
            <span className="min-w-0 flex-1 truncate" title={event.content}>
              {event.content}
              {event.count > 1 && <span className="text-muted-foreground">（×{event.count}）</span>}
            </span>
            {event.priority === 'high' && (
              <Badge variant="destructive" className="shrink-0">
                优先
              </Badge>
            )}
            <Badge variant={stateVariant(event.state)} className="shrink-0">
              {LIVE_EVENT_STATE_LABELS[event.state]}
            </Badge>
          </div>
        )
      })}
    </div>
  )
}
