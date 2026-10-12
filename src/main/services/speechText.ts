/**
 * 显示稿 → 语音稿（TTS 只念语音稿）。
 *
 * 直播间里 agent 写的话常带 @昵称（回复某位观众），直接念会变成"艾特桃子"很怪，
 * 也可能被 TTS 读成乱码。规则集中在这里，agent 只写一句带 @ 的话即可。
 */

/** 泛称：昵称不适合直接称呼时用 */
const GENERIC = '这位朋友'

/** 昵称里不该念出来的字符：emoji、装饰符号、空白 */
const UNSPEAKABLE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}·•_\-—~!！?？@#￥%…&*+=|/\\<>\[\]{}()（）「」""'']/u

function isSpeakableName(name: string): boolean {
  if (!name) return false
  if (name.length > 8) return false
  // 纯数字 / 纯英文 / **含阿拉伯数字** / 含不可念字符 → 不适合直接称呼
  // （含数字的昵称念出来是"用户一二三"，很怪）
  if (/\d/.test(name)) return false
  if (/^[a-zA-Z\s.]+$/.test(name)) return false
  if (UNSPEAKABLE.test(name)) return false
  return true
}

/**
 * 把一句带 @ 的回复转成自然口语。
 *
 *   "@桃子 一套 199，今天直播间专属价"  →  "桃子朋友，一套 199，今天直播间专属价"
 *   "@用户123 你好"                    →  "这位朋友，你好"
 *   "@🍑 在的"                        →  "这位朋友，在的"
 */
export function toSpeechText(display: string): string {
  const text = display.trim()
  if (!text) return text
  // 句首的 @昵称（允许 @ 前后有空白）
  const match = text.match(/^\s*@\s*(\S+)\s*([\s\S]*)$/)
  if (!match) return text
  const rawName = match[1]
  const rest = match[2].trim()
  const name = isSpeakableName(rawName) ? `${rawName}朋友` : GENERIC
  if (!rest) return `${name}，`
  // 避免"桃子朋友，，xxx"这类重复标点
  const joiner = /^[，,。.！!？?；;：:]/.test(rest) ? '' : '，'
  return `${name}${joiner}${rest}`
}

/** 价格等数字是否转中文（实测某家 TTS 读不好时开启） */
export function numberToChinese(text: string): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  return text.replace(/\d+(\.\d+)?/g, (raw) => {
    if (raw.includes('.')) {
      const [int, dec] = raw.split('.')
      return `${groupToChinese(int)}点${dec.split('').map((d) => digits[Number(d)] ?? d).join('')}`
    }
    return groupToChinese(raw)
  })
}

function groupToChinese(int: string): string {
  if (int.length > 6) return int
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const units = ['', '十', '百', '千', '万', '十万']
  const chars = int.split('').reverse()
  let out = ''
  let zero = false
  chars.forEach((c, i) => {
    const n = Number(c)
    if (n === 0) {
      zero = true
      return
    }
    out = digits[n] + units[i] + (zero ? '零' : '') + out
    zero = false
  })
  // 10-19 的中文习惯：一十五 → 十五
  return out.replace(/^一十/, '十') || '零'
}
