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

/** 事件流：发给主播 Agent 的直播间动态收件箱（新的在前；数据与订阅由 LivePage 持有，这里只渲染） */
export function EventStream({ events }: { events: LiveInboxEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Inbox className="size-8" strokeWidth={1.25} />
        <p className="text-sm">还没有动态进收件箱，评论/礼物/触发器通知会按批送到主播</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1 pt-2">
      {events.map((event) => {
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
