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
 * 场次播报的成本阀（段数上限）：控制底稿库能存多少段。
 * 写满上限 write_bits/add_draft 就拒，开播后池空了循环已有底稿（音频复用零重合成）；
 * 0 = 无限——不封顶，主播可以一直续写新段（低水位补给会一直生产新内容）。
 * 注意这不是底稿的属性：底稿可反复生成、反复改，阀管的是「这场播出同时存多少段」。
 */
export function planBroadcastCap(plan: { genConfig?: { maxBits?: number } }): number {
  const explicit = plan.genConfig?.maxBits ?? 0
  return explicit > 0 ? Math.floor(explicit) : Number.POSITIVE_INFINITY
}

/** 这么多个就绪桥段大概能播多久（分钟） */
export function coveredMinutes(bits: number): number {
  return (bits * AVG_BIT_SECONDS) / 60
}

/** 本次生成的底稿目标：总量 + 逐场分摊（前面的场次多摊余数，开场通常更费话）。
 *  总量由「生成时填的预生成时长」推算（一次性配置），再被场次播报成本阀截顶 */
export function planTargetBits(
  plan: { plannedMinutes: number; genConfig?: { maxBits?: number } },
  script: { scenes: unknown[] }
): { total: number; perScene: number[] } {
  const target = Math.max(1, Math.ceil(plan.plannedMinutes * BITS_PER_MINUTE))
  const total = Math.min(target, planBroadcastCap(plan))
  const count = Math.max(1, script.scenes.length)
  const base = Math.floor(total / count)
  const remainder = total % count
  const perScene = Array.from(
    { length: script.scenes.length },
    (_, i) => base + (i < remainder ? 1 : 0)
  )
  return { total, perScene }
}
