import { cn } from '@/lib/utils'
import { SpeechText } from './SpeechText'

/**
 * 内容区正文的统一排版：**三种播出模式（滚动/即兴/预制）与场记共用这一处**。
 * 之前每处各写一套（leading-5/leading-6、muted/前景色交错），换个模式字就变了样——
 * 所以字号、行高、字色只在下面这一个常量里定义，谁渲染正文都走它。
 */
const CONTENT_TEXT_CLASS = 'text-[13px] leading-6'

/** 次要正文（历史回看、生成中预览）：字号行高完全一致，只把字色压暗 */
const CONTENT_TEXT_MUTED_CLASS = `${CONTENT_TEXT_CLASS} text-muted-foreground`

/**
 * 正文渲染（演法标记照样变 chip）：正文内容都该用它，别再手写 className。
 * muted = 次要正文（历史/预览）；其余情况是主要内容（正在播的稿子、底稿正文）。
 */
export function ContentText({
  text,
  muted = false,
  className,
  title
}: {
  text: string
  muted?: boolean
  className?: string
  /** 悬停提示（例如"实际念的是什么"） */
  title?: string
}) {
  return (
    <SpeechText
      text={text}
      title={title}
      className={cn(muted ? CONTENT_TEXT_MUTED_CLASS : CONTENT_TEXT_CLASS, className)}
    />
  )
}
