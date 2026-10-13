/**
 * 底稿规模推算（开播向导与生成 Agent 共用一套账）：
 * 预设直播时长 → 需要多少条底稿；就绪条数 → 大概能播多久。
 * 预检拿「能播多久 vs 预设时长」决定要不要拦住先去补底稿。
 */

/** 一条口播平均时长（秒）：单条上限 60 字、正常带货语速约 8 秒 */
export const AVG_LINE_SECONDS = 8
/**
 * 每分钟实际口播条数：播报之间有停顿，还要穿插回复评论/互动，
 * 纯连播约 7 条/分，稀释后按 4 条/分预算
 */
export const LINES_PER_MINUTE = 4

/** 这么多条底稿大概能播多久（分钟） */
export function coveredMinutes(lines: number): number {
  return (lines * AVG_LINE_SECONDS) / 60
}

/** 按预设时长推算本场底稿目标：总量 + 逐场分摊（前面的场次多摊余数，开场通常更费话） */
export function planTargetLines(
  plan: { plannedMinutes: number },
  script: { scenes: unknown[] }
): { total: number; perScene: number[] } {
  const total = Math.max(1, Math.ceil(plan.plannedMinutes * LINES_PER_MINUTE))
  const count = Math.max(1, script.scenes.length)
  const base = Math.floor(total / count)
  const remainder = total % count
  const perScene = Array.from(
    { length: script.scenes.length },
    (_, i) => base + (i < remainder ? 1 : 0)
  )
  return { total, perScene }
}
