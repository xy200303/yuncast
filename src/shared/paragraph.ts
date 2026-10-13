/**
 * 段落合成（底稿连贯性）的共享常量与文本工具。
 *
 * 背景：逐条合成时每句话的语气都"从零起步"，句间停顿是硬切的。
 * 把同一场景的连续底稿拼成一段整送模型（上下文完整 → 语气连贯），
 * 拿到音频后再按句切回条目粒度来播——跳过/插播/打断的粒度一条不丢。
 */

/** 一段最多拼多少字：qwen3-tts 上限 600，取一个语气连贯与重合成成本都合适的值 */
export const PARAGRAPH_MAX_CHARS = 200

/** 一组至少几条才值得拼段（单条没有连贯性问题，直接逐条合成） */
export const PARAGRAPH_MIN_ITEMS = 2

/** 句末强停顿标点：切句只认这些（逗号/顿号级别的停顿不当句界，避免和 TTS 分句对不上） */
const SENTENCE_END = /(?<=[。！？!?…])/

/**
 * 把一段文本切成句子（保留句末标点）。
 * 用于：拼接段落前预估每条的句数，与火山返回的字幕句数对齐校验。
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parts = trimmed
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : [trimmed]
}

/**
 * 拼接段落前给每条兜底一个句末标点：
 * 缺标点的话两条会粘成一句，句数校验必定对不上。
 */
export function ensureSentenceEnd(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[。！？!?…，,；;：:]$/.test(trimmed) ? trimmed : `${trimmed}。`
}
