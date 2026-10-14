import { useEffect, useRef } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { LiveComment } from '../../../../shared/types'

/** 评论列表（ LivePage 持有数据与订阅，这里只渲染） */
export function CommentList({ comments }: { comments: LiveComment[] }) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments])

  if (comments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareText className="size-8" strokeWidth={1.25} />
        <p className="text-sm">还没有评论，开连接器的演示模式试试</p>
      </div>
    )
  }
  return (
    <div ref={listRef} className="flex flex-col gap-1 pt-2">
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
