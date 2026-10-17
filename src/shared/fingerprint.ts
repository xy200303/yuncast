/**
 * 文稿指纹（docs/10 §9.6/§15.6）：预制音频资产记着合成时的文稿指纹，
 * 文稿一改指纹就变 → 对应 rendered 置 stale，正式播放/导出前必须重新合成或明确用旧音频。
 *
 * 纯 TS 实现（不依赖 node:crypto）：shared 目录会被渲染层打包，不能引 node 模块。
 * cyrb53 双哈希拼 16 位十六进制——这里只要「稳定 + 变了能察觉」，不要加密强度。
 */

/** cyrb53 字符串哈希（公开域实现），输出 16 位十六进制 */
function hash16(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** 通用稳定哈希（音色集合/角色表等快照指纹用） */
export const stableHash = hash16

/**
 * 节目级风格指令盐（program.instruction）：不在文稿字段里但影响「听起来是什么」，
 * 并进指纹——改它 = 全部单元判过期重合成；空盐时指纹与旧版逐位一致（升级不标脏存量产物）
 */
export function programStyleSalt(program: { instruction?: string }): string {
  return program.instruction?.trim() ?? ''
}

/** 会影响「这段音频听起来是什么」的文稿字段 */
export interface FingerprintSource {
  text: string
  delivery?: string
  rate?: number
  pitch?: number
}

/** 单段（DraftUnit）级文稿指纹：文本 + 表演指示 + 语速/音调（+ 节目级风格指令盐） */
export function utteranceFingerprint(source: FingerprintSource, styleSalt = ''): string {
  return hash16(
    [source.text, source.delivery ?? '', source.rate ?? '', source.pitch ?? '', styleSalt].join('')
  )
}

/**
 * 整章/整期（Scene）级文稿指纹：该章全部段落的段指纹按叙事顺序串联。
 * 任何一段的文本/演法变动、段序变动、增删段都会改变它。
 */
export function sceneFingerprint(utterances: FingerprintSource[], styleSalt = ''): string {
  return hash16(utterances.map((u) => utteranceFingerprint(u, styleSalt)).join(','))
}
