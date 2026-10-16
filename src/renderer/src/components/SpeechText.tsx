import { Fragment } from 'react'
import { Music, Pause } from 'lucide-react'
import { parseSpeechMarkup } from '../../../shared/speechTags'

/**
 * 稿子文本的演法标记可视化（shared/speechTags 统一语法）：
 * - <cot text=情绪>句子</cot> → 句子带底色，前面缀情绪小标
 * - <fx>笑声</fx> → 音效 chip
 * - <pause>600</pause> → 停顿 chip
 * 纯文本原样渲染。截断容器（truncate）里也能用——chip 都是 inline 元素。
 */
export function SpeechText({ text, className, title }: { text: string; className?: string; title?: string }) {
  // 段序列没有业务 id，用「种类+内容+同名出现次序」拼一个稳定 key：
  // 内容重复的段（连着两个 <fx>笑声</fx>）也要能各自唯一，所以补次序后缀
  const seen = new Map<string, number>()
  const segments = parseSpeechMarkup(text).map((seg) => {
    let base: string
    if (seg.kind === 'cot') base = `cot:${seg.style}:${seg.text}`
    else if (seg.kind === 'fx') base = `fx:${seg.name}`
    else if (seg.kind === 'pause') base = `pause:${seg.ms}`
    else base = `text:${seg.text}`
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return { seg, key: `${base}#${nth}` }
  })
  return (
    <span className={className} title={title}>
      {segments.map(({ seg, key }) => {
        if (seg.kind === 'cot') {
          return (
            <span key={key} className="rounded bg-primary/8 px-0.5 box-decoration-clone">
              <span className="mr-1 inline-flex items-center rounded bg-primary/15 px-1 py-px align-middle text-[10px] font-medium text-primary">
                {seg.style}
              </span>
              {seg.text}
            </span>
          )
        }
        if (seg.kind === 'fx') {
          return (
            <span
              key={key}
              className="mx-0.5 inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-px align-middle text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              <Music className="h-2.5 w-2.5" />
              {seg.name}
            </span>
          )
        }
        if (seg.kind === 'pause') {
          return (
            <span
              key={key}
              className="mx-0.5 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px align-middle text-[10px] font-medium text-muted-foreground"
            >
              <Pause className="h-2.5 w-2.5" />
              {seg.ms >= 1000 ? `${seg.ms / 1000}s` : `${seg.ms}ms`}
            </span>
          )
        }
        return <Fragment key={key}>{seg.text}</Fragment>
      })}
    </span>
  )
}
