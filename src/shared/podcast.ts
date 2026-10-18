import type { PodcastTurn, TtsModelCapabilities, TtsSynthesisRequest } from './types'

/**
 * Podcast（双人播客）模型的请求侧纯函数（docs/10 §6.5/§15.9）。
 * shared 目录：不引 node 模块，渲染层/主进程/自检脚本共用。
 */

type PodcastRequest = Extract<TtsSynthesisRequest, { type: 'podcast' }>

/**
 * 请求前校验（§15.9：超限直接本地报错，不等服务端）：
 * 发音人恰好 maxSpeakers 个且互不相同、每轮 ≤ maxCharsPerTurn、总文本 ≤ maxTextChars、
 * 每轮发音人必须在 speakers 里。通过返回 null，否则返回中文原因。
 */
export function validatePodcastRequest(
  request: PodcastRequest,
  caps: TtsModelCapabilities
): string | null {
  if (request.turns.length === 0) return '双人播客轮次稿是空的：先让主播写稿，再生成节目音频'
  const unique = new Set(request.speakers)
  if (request.speakers.length !== caps.maxSpeakers || unique.size !== request.speakers.length) {
    return `Podcast 模型需要恰好 ${caps.maxSpeakers} 个不同的发音人（当前给了 ${request.speakers.length} 个）`
  }
  const perTurn = caps.maxCharsPerTurn ?? Number.POSITIVE_INFINITY
  const totalCap = caps.maxTextChars ?? Number.POSITIVE_INFINITY
  let total = 0
  for (let i = 0; i < request.turns.length; i++) {
    const turn = request.turns[i]
    if (!turn.text.trim()) return `第 ${i + 1} 轮是空文本：把这段文稿删掉或补上内容`
    if (!unique.has(turn.speaker)) {
      return `第 ${i + 1} 轮的发音人不在两个主持人里：Podcast 模型只支持 ${caps.maxSpeakers} 个发音人`
    }
    if (turn.text.length > perTurn) {
      return `第 ${i + 1} 轮 ${turn.text.length} 字，超过单轮上限 ${perTurn} 字：把这段文稿改短或拆开`
    }
    total += turn.text.length
  }
  if (total > totalCap) {
    return `这一期文稿共 ${total} 字，超过模型上限 ${totalCap} 字：拆成更多期/章，或删减后再合成`
  }
  return null
}

/**
 * 把一段文稿拆成 ≤ maxChars 的若干轮：优先在句末标点（。！？；…换行）断句，
 * 其次逗号/顿号，实在没有停顿点才硬切——保证每轮语句尽量完整（§15.9 单轮上限）。
 */
export function splitPodcastTurnText(text: string, maxChars: number): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]
  const sentenceEnd = ['。', '！', '？', '!', '?', '；', ';', '…', '\n']
  const clauseEnd = ['，', ',', '、', '：', ':']
  const parts: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1)
    let cut = lastIndexOfAny(window, sentenceEnd)
    // 断点太靠前（短于一半）说明长句没句号，退到逗号；再不行硬切
    if (cut < maxChars / 2) cut = lastIndexOfAny(window, clauseEnd)
    const at = cut >= 0 ? cut + 1 : maxChars
    const part = rest.slice(0, at).trim()
    if (part) parts.push(part)
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

function lastIndexOfAny(window: string, marks: string[]): number {
  let at = -1
  for (const mark of marks) at = Math.max(at, window.lastIndexOf(mark))
  return at
}

/**
 * 把一章（或一段）文稿组装成双人轮次稿：
 * - 文稿段落的 voiceId 命中某个主持人音色 → 该主持人讲；
 * - 没标角色的段落 → 与上一轮交替（默认主持人 A 开场），对话感不断；
 * - 超过单轮上限的段落按句末标点拆成同一个人的连续几轮。
 * podcastVoices/speakers 顺序一致：[主持人 A, 主持人 B]；podcastVoices 是节目 cast 里的原始音色输入，
 * speakers 是解析后的发音人 id（克隆音色 → speaker_id）。返回 null = 有第三种音色混入（§6.4 拒绝）。
 */
export function buildPodcastTurns(
  lines: { voiceId: string; text: string }[],
  podcastVoices: [string, string],
  speakers: [string, string],
  maxCharsPerTurn: number
): PodcastTurn[] | null {
  const turns: PodcastTurn[] = []
  let prev = 1 // 上一轮是 B → 第一段未标角色时由 A 开场
  for (const line of lines) {
    const voice = line.voiceId.trim()
    let who = -1
    if (voice) {
      // 原始输入与解析后的 speaker id 都算命中（cast 里可能一个写音色名一个写 speaker_id）
      if (voice === podcastVoices[0] || voice === speakers[0]) who = 0
      else if (voice === podcastVoices[1] || voice === speakers[1]) who = 1
      else return null
    } else {
      who = prev === 0 ? 1 : 0
    }
    prev = who
    for (const text of splitPodcastTurnText(line.text, maxCharsPerTurn)) {
      turns.push({ speaker: speakers[who], text })
    }
  }
  return turns
}
