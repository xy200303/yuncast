import type { StatsHotWord } from '../../../shared/types'

/**
 * 词云（不引插件）：按词频把字号映射到 12–28px、颜色深浅映射到透明度，
 * flex wrap 流式排布。词由主进程 statsWords 按二元组 + 停用词表统计，已按词频降序。
 */
export function WordCloud({ words, empty, className = '' }: { words: StatsHotWord[]; empty: string; className?: string }) {
  if (words.length === 0) {
    return <p className="flex h-24 items-center justify-center text-xs text-muted-foreground">{empty}</p>
  }
  const max = words[0].count
  const min = words[words.length - 1].count
  const scale = (count: number): number => (max === min ? 0.5 : (count - min) / (max - min))
  return (
    <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1.5 ${className}`}>
      {words.map(({ word, count }) => {
        const t = scale(count)
        return (
          <span
            key={word}
            title={`出现 ${count} 次`}
            className="cursor-default leading-none text-foreground"
            style={{ fontSize: `${Math.round(12 + t * 16)}px`, opacity: 0.45 + t * 0.55 }}
          >
            {word}
          </span>
        )
      })}
    </div>
  )
}
