import { CONTENT_TYPE_LABELS, PROGRAM_LANGUAGE_LABELS, type DraftBriefParams } from './types'

/**
 * 写稿参数（语言/形态/风格/收尾）属于「本轮」，不属于 system prompt。
 *
 * system prompt 只在会话出生时组装一次，用户中途改语言它看不到；所以这些值一律随调用传：
 * 生成底稿带一份完整任务书参数，导演对话每轮带一行，写稿工具按它做语言校验。
 * 这里只做「同一份参数，同一种说法」的格式化，避免三处各写一份文案。
 */
export function describeDraftParams(params: DraftBriefParams): string {
  const language = params.language ?? 'auto'
  const parts = [
    `语言=${language === 'auto' ? '自动识别' : PROGRAM_LANGUAGE_LABELS[language]}`,
    `形态=${CONTENT_TYPE_LABELS[params.contentType ?? 'solo']}`,
    `收尾=${params.endMode === 'stop' ? '播完收播' : '循环返场'}`
  ]
  if (params.instruction?.trim()) parts.push(`风格=${params.instruction.trim()}`)
  return parts.join('；')
}
