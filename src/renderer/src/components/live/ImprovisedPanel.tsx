import { useEffect, useState } from 'react'
import { History, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../stores/useAppStore'
import { audition, auditionTitle } from '../../lib/audition'
import type { PoolItem } from '../../../../shared/types'
import { ContentItem, ContentList } from './ContentItem'

/**
 * 即兴播出（现场发挥）的「接下来」内容（docs/REDESIGN 4.6）：
 * 没有底稿就没有列表——不渲染空话术池/空底稿壳，只呈现两块实况：
 * ① 主播正在生成什么（draft 预览）；② 最近说过的内容。
 * 正在播什么在底部 NowPlayingBar，评论流/事件流收进 UpNext 的 tab。
 */
export function ImprovisedPanel() {
  const pool = useAppStore((s) => s.pool)
  const agent = useAppStore((s) => s.agent)
  const [recent, setRecent] = useState<PoolItem[]>([])

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  const queuedCount = pool.items.length - (playing ? 1 : 0)

  // 播完一条就刷新一次「最近说过」（池快照每条状态变迁都会广播，这里跟着变）
  useEffect(() => {
    void window.api.pool.recentPlayed(12).then(setRecent)
  }, [pool.items])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 正在生成：同一个内容条目（头部写状态，正文是生成中的稿子 + 呼吸光标） */}
      <div className="shrink-0 px-3 pt-3">
        <ContentItem
          status={<Sparkles className="size-4 shrink-0 text-primary" />}
          header={
            <>
              <span className="truncate">{agent.leadPersonaName ?? '主播'} · 现场发挥</span>
              {queuedCount > 0 && <span className="shrink-0">待播 {queuedCount} 条</span>}
            </>
          }
          meta={agent.draft ? '正在生成' : '待命'}
          text={agent.draft || '这会儿没在写新词——没有底稿，她根据导演指令和直播间动态现场发挥。'}
          textTrailing={
            agent.draft ? (
              <span className="mb-1 inline-block h-3.5 w-1.5 shrink-0 animate-pulse rounded-sm bg-foreground/40" />
            ) : undefined
          }
        />
      </div>

      {/* 最近说过 */}
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
        <ContentList>
          {recent.map((item) => (
            <ContentItem
              key={item.id}
              header={
                item.playedAt ? (
                  <span className="flex shrink-0 items-center gap-1 font-medium text-foreground">
                    <History className="size-3" />
                    {new Date(item.playedAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    })}
                  </span>
                ) : null
              }
              text={item.text}
              onTextClick={() => {
                if (!item.audioPath) {
                  toast.warning('这段还没合成', { description: '这条是流式播报或没合成，没有可试听的音频文件' })
                  return
                }
                audition.toggle({ key: `speech:${item.id}`, title: auditionTitle(item.text), audioPath: item.audioPath })
              }}
            />
          ))}
        </ContentList>
      )}
    </div>
  )
}
