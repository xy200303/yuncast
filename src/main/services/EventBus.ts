import { randomUUID } from 'node:crypto'
import type { LiveEvent } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 事件总线（docs/01 §3.5）：所有事件源的唯一入口。
 * emit() 落 event_log 表（持久化留档，带当前节目 id）→ 同步派发给订阅者（TriggerRuntime 等）。
 * EventRegistry：内建类型先注册，未来「注册即接入」。
 */

/** 内建事件类型注册表 */
const EVENT_REGISTRY = new Map<string, string>([
  ['comment.new', '观众评论'],
  ['viewer.join', '观众进场'],
  ['gift.received', '收到礼物'],
  ['like.burst', '点赞里程碑'],
  ['viewer.follow', '关注主播'],
  ['viewer.share', '分享直播间'],
  ['pool.empty', '话术池空了'],
  ['pool.low', '话术池低水位'],
  ['speech.failed', '合成彻底失败停播'],
  ['timer.interval', '定时节拍（5 分钟）'],
  ['stream.started', '开播'],
  ['stream.ended', '下播'],
  ['trigger.fired', '触发器执行'],
  ['trigger.dropped', '触发器被防护拦截'],
  ['product.price_changed', '商品价格变动']
])

export function listEventTypes(): { type: string; label: string }[] {
  return [...EVENT_REGISTRY.entries()].map(([type, label]) => ({ type, label }))
}

export class EventBus {
  private subscribers = new Set<(event: LiveEvent) => void>()

  constructor(private readonly storage: StorageService) {}

  emit(type: string, payload: Record<string, unknown>, source: LiveEvent['source'] = 'system'): LiveEvent {
    const event: LiveEvent = {
      id: `ev-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type,
      source,
      payload,
      ts: Date.now()
    }
    this.storage.eventLogInsert(event)
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event)
      } catch (error) {
        console.error('[AgentAnchor] 事件订阅者出错:', error)
      }
    }
    return event
  }

  subscribe(cb: (event: LiveEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }
}
