import { useEffect, useRef } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { LiveComment } from '../../../../shared/types'

/**
 * 评论列表（LivePage 持有数据与订阅，这里只渲染）。
 * 口径与「事件流」一致：新的一条在底部，来了就自动跟到最新。
 * 注意滚动容器必须是这个 div：长在 TabsContent 上时 listRef 指的是个不溢出的盒子，
 * `scrollTop = scrollHeight` 是空操作，看着"跟了"其实没跟。
 */
export function CommentList({ comments }: { comments: LiveComment[] }) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments])

  if (comments.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareText className="size-8" strokeWidth={1.25} />
        <p className="text-sm">还没有评论，开连接器的演示模式试试</p>
      </div>
    )
  }
  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pt-2 pb-2">
      {comments.map((comment) => (
        <div key={comment.id} className="flex items-baseline gap-2 text-[13px]">
          <span className="shrink-0 text-xs text-muted-foreground">
            {new Date(comment.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span className="shrink-0 font-medium text-primary">{comment.author}</span>
          <span className="min-w-0">{comment.content}</span>
        </div>
      ))}
    </div>
  )
}
