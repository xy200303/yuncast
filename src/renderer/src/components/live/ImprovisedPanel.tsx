import { useEffect, useState } from 'react'
import { History, MessageSquareText, Mic, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '../../stores/useAppStore'
import { CommentList } from './CommentList'
import type { LiveComment, SpeechItem } from '../../../../shared/types'

/**
 * 即兴播出（现场发挥）的播控台中间区（docs/10 §11.5）：
 * 没有底稿就没有列表——不渲染空话术池/空底稿壳，只呈现三块实况：
 * ① 主播正在生成/正在说什么；② 直播间动态（节目开了 allowLiveEvents 才有）；
 * ③ 最近说过的内容。待播条数用一行小字带过，不做队列列表。
 */
export function ImprovisedPanel({
  comments,
  allowLiveEvents
}: {
  comments: LiveComment[]
  allowLiveEvents: boolean
}) {
  const pool = useAppStore((s) => s.pool)
  const agent = useAppStore((s) => s.agent)
  const [recent, setRecent] = useState<SpeechItem[]>([])

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  const queuedCount = pool.items.length - (playing ? 1 : 0)

  // 播完一条就刷新一次「最近说过」（池快照每条状态变迁都会广播，这里跟着变）
  useEffect(() => {
    void window.api.pool.recentPlayed(12).then(setRecent)
  }, [pool.items])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 正在生成 / 正在说 */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Mic className="size-4 shrink-0 text-primary" />
          <p className="text-xs text-muted-foreground">
            {agent.personaName ?? '主播'} · 现场发挥
            {queuedCount > 0 && ` · 待播 ${queuedCount} 条`}
          </p>
        </div>
        {playing ? (
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5">
            {playing.text}
            <Badge className="ml-2 align-middle">播报中</Badge>
          </p>
        ) : agent.draft ? (
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-muted-foreground">
            {agent.draft}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
          </p>
        ) : (
          <p className="mt-2 text-[13px] text-muted-foreground">
            主播这会儿没在说话——没有底稿，她根据导演指令和直播间动态现场发挥，没动静时允许自然安静。
          </p>
        )}
        {agent.draft && playing && (
          <p className="mt-2 whitespace-pre-wrap border-t pt-2 text-[13px] leading-5 text-muted-foreground">
            <Sparkles className="mr-1 inline size-3.5 align-middle" />
            正在生成：{agent.draft}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 最近说过 */}
        <section className="flex min-w-0 flex-1 flex-col border-r">
          <p className="flex shrink-0 items-center gap-1.5 px-4 pt-2 pb-1 text-xs text-muted-foreground">
            <History className="size-3.5" />
            最近说过
          </p>
          {recent.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <History className="size-8" strokeWidth={1.25} />
              <p className="text-sm">还没有播过的内容</p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 pb-3">
              {recent.map((item) => (
                <div key={item.id} className="rounded-md border bg-card px-3 py-1.5">
                  <p className="whitespace-pre-wrap text-[13px] leading-5 text-muted-foreground">{item.text}</p>
                  {item.playedAt && (
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
                      {new Date(item.playedAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 直播间动态（节目关了就不渲染这块） */}
        {allowLiveEvents && (
          <section className="flex min-w-0 flex-1 flex-col">
            <p className="flex shrink-0 items-center gap-1.5 px-4 pt-2 pb-1 text-xs text-muted-foreground">
              <MessageSquareText className="size-3.5" />
              直播间动态 · {comments.length}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
              <CommentList comments={comments} />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
