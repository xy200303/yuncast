/**
 * 底稿规模推算（开播向导与生成 Agent 共用一套账）：
 * 预设直播时长 → 需要多少个桥段；就绪桥段数 → 大概能播多久。
 * 预检拿「能播多久 vs 预设时长」决定要不要拦住先去补底稿。
 *
 * 桥段制：一个桥段 = 一段 30~90 秒的连续讲述（多句），是内容/合成/播放的共同单元。
 * 桥段之间有呼吸留白，还要穿插回复评论/互动，所以每分钟实际播不到一个完整桥段。
 */

/** 一个桥段平均时长（秒）：150~350 字、正常带货语速 */
export const AVG_BIT_SECONDS = 45
/** 每分钟实际播出占比：桥段间留白 + 互动稀释后，一分钟约 0.8 个桥段的内容 */
export const BITS_PER_MINUTE = 0.8

/**
 * 本场底稿段数上限（成本闸）：genConfig.maxBits > 0 用显式值，否则按预设时长推算。
 * 写够上限就停；开播后池空了循环已有底稿（音频复用，零重合成）——合成总次数收敛在上限附近。
 */
export function planMaxBits(plan: { plannedMinutes: number; genConfig?: { maxBits?: number } }): number {
  const explicit = plan.genConfig?.maxBits ?? 0
  if (explicit > 0) return Math.floor(explicit)
  return Math.max(1, Math.ceil(plan.plannedMinutes * BITS_PER_MINUTE))
}

/** 这么多个就绪桥段大概能播多久（分钟） */
export function coveredMinutes(bits: number): number {
  return (bits * AVG_BIT_SECONDS) / 60
}

/** 按预设时长推算本场底稿目标：总量 + 逐场分摊（前面的场次多摊余数，开场通常更费话）。
 *  总量走 planMaxBits：配了段数上限就以它为准（上限即目标，写够就停） */
export function planTargetBits(
  plan: { plannedMinutes: number; genConfig?: { maxBits?: number } },
  script: { scenes: unknown[] }
): { total: number; perScene: number[] } {
  const total = planMaxBits(plan)
  const count = Math.max(1, script.scenes.length)
  const base = Math.floor(total / count)
  const remainder = total % count
  const perScene = Array.from(
    { length: script.scenes.length },
    (_, i) => base + (i < remainder ? 1 : 0)
  )
  return { total, perScene }
}
