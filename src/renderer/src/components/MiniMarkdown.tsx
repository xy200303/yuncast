import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 极简 Markdown 渲染（只覆盖模型实际会写的那些语法，不引依赖）：
 * 标题 / 无序列表 / 有序列表 / 引用 / 代码块 / 行内代码 / 粗体 / 换行。
 *
 * 为什么自己写：主播的正文常常是「三段走完了，接下来…」这种多句式文本，既有小标题也有列表；
 * 用 <p> 平铺输出会糊成一片，加个 markdown 依赖又为这点需求引一套解析器+清洗链，不值。
 */

/** 行内：**粗体** 与 `代码` */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      out.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-medium text-foreground">
          {token.slice(2, -2)}
        </strong>
      )
    } else {
      out.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded bg-background/70 px-1 py-0.5 font-mono text-[12px]"
        >
          {token.slice(1, -1)}
        </code>
      )
    }
    last = match.index + token.length
    index += 1
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MiniMarkdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null

  const flushList = (): void => {
    if (!list) return
    const items = list.items.map((item, i) => (
      <li key={`li-${blocks.length}-${i}`} className="marker:text-muted-foreground">
        {inline(item, `li-${blocks.length}-${i}`)}
      </li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${blocks.length}`} className="ml-4 list-decimal space-y-0.5">
          {items}
        </ol>
      ) : (
        <ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-0.5">
          {items}
        </ul>
      )
    )
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.startsWith('```')) {
      if (code) {
        blocks.push(
          <pre
            key={`pre-${blocks.length}`}
            className="overflow-x-auto rounded-lg bg-background/70 p-2 font-mono text-[12px] leading-5"
          >
            {code.join('\n')}
          </pre>
        )
        code = null
      } else {
        flushList()
        code = []
      }
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      blocks.push(
        <p
          key={`h-${blocks.length}`}
          className={cn(
            'font-medium text-foreground',
            heading[1].length <= 2 ? 'mt-1 text-[13.5px]' : 'mt-1 text-[13px]'
          )}
        >
          {inline(heading[2], `h-${blocks.length}`)}
        </p>
      )
      continue
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
      continue
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[1])
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushList()
      blocks.push(
        <p
          key={`q-${blocks.length}`}
          className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground"
        >
          {inline(quote[1], `q-${blocks.length}`)}
        </p>
      )
      continue
    }

    if (line.trim() === '') {
      flushList()
      continue
    }

    flushList()
    blocks.push(
      <p key={`p-${blocks.length}`}>{inline(line, `p-${blocks.length}`)}</p>
    )
  }
  flushList()
  if (code) {
    blocks.push(
      <pre
        key={`pre-${blocks.length}`}
        className="overflow-x-auto rounded-lg bg-background/70 p-2 font-mono text-[12px] leading-5"
      >
        {code.join('\n')}
      </pre>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1.5 text-[13px] leading-[21px]', className)}>
      {blocks.map((block, index) => (
        <Fragment key={index}>{block}</Fragment>
      ))}
    </div>
  )
}
