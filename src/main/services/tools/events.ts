import { Type } from 'typebox'
import { defineTool } from './types'

/**
 * 事件域：直播间事件的出口。一次性近查走 events_recent；
 * 实时订阅走 GET /events SSE（kinds 过滤 + after 游标续传），CLI 用 yuncast events --follow。
 */
export const eventsTools = [
  defineTool({
    name: 'events_recent',
    domain: 'events',
    label: '查近期事件',
    risk: 'read',
    expose: { mcp: true },
    description:
      '查近期直播间事件（评论/礼物/进场/池水位/触发器/推流状态等），按时间正序返回，每条带 seq 游标。' +
      '要实时跟随事件流别轮询它——订阅 GET /events SSE（或 CLI：yuncast events --follow），' +
      '用返回的 seq 做 after 游标断线续传。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '条数，默认 50，最多 500' })),
      kinds: Type.Optional(
        Type.Array(Type.String(), {
          description: '只看这些类型（如 comment.new / gift.received / pool.low），不传 = 全部'
        })
      )
    }),
    handler: (ctx, params) => {
      if (!ctx.eventsRecent) return '事件出口没接上'
      const limit = Math.min(Math.max(Math.round(params.limit ?? 50), 1), 500)
      const kinds = params.kinds?.length ? new Set(params.kinds.map((k) => k.trim())) : undefined
      return ctx.eventsRecent(limit, kinds)
    }
  })
]
