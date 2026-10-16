import { useState, type ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { stripSpeechTags } from '../../../../shared/speechTags'
import { ContentText } from '../ContentText'

/**
 * 内容区（UpNext）的统一显示组件：**三种播出模式共用同一套列表与条目**。
 * 之前滚动/即兴/预制各写一套行（边框、内边距、头部、正文槽都不一样），换个模式就像换了个软件；
 * 现在结构只在这一个地方定义：
 *
 *   ┌ 卡片 ─────────────────────────────────────────────┐
 *   │ [状态图标]  头部（来源/车道/章名/序号/徽章）  右上元信息  尾部动作 │
 *   │ 正文（ContentText；长文给「展开全文/收起」）          │
 *   └───────────────────────────────────────────────┘
 *
 * 各模式只是往里填不同的槽：滚动填"来源+车道+语音名+撤回"，预制填"序号+章名+时长+跳播"，
 * 即兴填"时间戳"。卡片外观、正文排版、长文折叠、正在播高亮都在这里，一处改处处生效。
 */
export function ContentItem({
  status,
  header,
  meta,
  actions,
  text,
  title,
  muted = false,
  current = false,
  loading = false,
  textTrailing,
  /** 超过这个字数才给折叠按钮（默认不折叠：播的就是全文） */
  longTextThreshold = 240,
  defaultCollapsed = false
}: {
  /** 左侧状态图标（各模式给各自的语义：合成状态 / 章节状态 / 无） */
  status?: ReactNode
  /** 头部内容（来源、车道、章名、序号、徽章…） */
  header?: ReactNode
  /** 右上元信息（时长、状态文字…） */
  meta?: ReactNode
  /** 尾部动作（跳播、撤回…）：默认常显，传 hoverOnly 的场景由调用方自己控制透明度 */
  actions?: ReactNode
  text: string
  /** 正文 hover 提示 */
  title?: string
  /** 次要正文（历史回看、章节全文）：只压字色，字号行高不变 */
  muted?: boolean
  /** 正在播的那条：主色描边 + 淡底 + 正文变主色 */
  current?: boolean
  /** 还在合成：正文位置给骨架，不显示未合成的内容 */
  loading?: boolean
  /** 正文尾部追加（如"正在生成"的呼吸光标） */
  textTrailing?: ReactNode
  longTextThreshold?: number
  defaultCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const plain = stripSpeechTags(text).trim()
  const long = plain.length > longTextThreshold

  return (
    <div
      data-playing={current ? 'true' : undefined}
      className={cn(
        'rounded-md border bg-card px-3 py-2 transition-colors',
        current && 'border-primary/50 bg-primary/5'
      )}
    >
      <div className="flex items-center gap-2">
        {status}
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">{header}</div>
        {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>

      {loading ? (
        <Skeleton className="mt-2 h-4 w-3/4" />
      ) : (
        plain.length > 0 && (
          <div className={cn('flex', textTrailing ? 'items-end gap-0.5' : 'block')}>
            <ContentText
              text={text}
              muted={muted && !current}
              title={title}
              className={cn(
                'mt-1.5 min-w-0 flex-1',
                collapsed && long && 'line-clamp-6',
                current && 'text-primary'
              )}
            />
            {textTrailing}
          </div>
        )
      )}

      {!loading && long && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? `展开全文（${plain.length} 字）` : '收起'}
        </button>
      )}
    </div>
  )
}

/** 内容区的滚动容器（三模式共用）：id 供播放条的"定位到正在播的那条"滚动用 */
export function ContentList({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div id="up-next-list" className={cn('flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3', className)}>
      {children}
    </div>
  )
}
