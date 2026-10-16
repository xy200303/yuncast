import type { StatsHotWord } from '../../shared/types'

// 中文热词统计（统计页/场次图表的词云）：不引分词库——CJK 连续段切二元组 + 停用字/停用词表过滤，
// 英文/数字按整词计。评论与话术场景短句居多，二元组足够抓住高频说法。

/** 单字停用：含任一端字的二元组直接丢（虚词/语气字成不了词义） */
const STOP_CHARS = new Set(
  '的了是在我有和就不人都一上也很到说要去你会着没看好这那吗呢吧啊哦呀嘛啦他她它们个么什怎还为又并于把被让从向对就啊呀呗咯噢喔嗯哼哈'.split('')
)

/** 二元组停用：高频但没信息量的搭配 */
const STOP_WORDS = new Set([
  '就是', '这个', '那个', '什么', '怎么', '我们', '你们', '他们', '没有', '不是', '知道', '可以', '现在',
  '还是', '一个', '真的', '已经', '自己', '因为', '所以', '但是', '如果', '觉得', '这样', '那样', '一下',
  '时候', '东西', '为什么', '这么', '那么', '不要', '不会', '不能', '是不是', '哈哈'
])

/** 一批文本的高频词：二元组 + 停用表统计，只留出现 ≥2 次的，按词频降序取前 limit 个 */
export function hotWords(texts: string[], limit = 40): StatsHotWord[] {
  const counts = new Map<string, number>()
  for (const text of texts) {
    const runs = text.match(/[一-鿿]+|[a-zA-Z0-9]+/g) ?? []
    for (const run of runs) {
      if (/[一-鿿]/.test(run[0])) {
        for (let i = 0; i + 1 < run.length; i++) {
          const gram = run.slice(i, i + 2)
          if (STOP_CHARS.has(gram[0]) || STOP_CHARS.has(gram[1]) || STOP_WORDS.has(gram)) continue
          counts.set(gram, (counts.get(gram) ?? 0) + 1)
        }
      } else if (run.length >= 2) {
        const word = run.toLowerCase()
        counts.set(word, (counts.get(word) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }))
}
