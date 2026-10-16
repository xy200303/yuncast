/**
 * 稿内演法标记：统一语法 + 按目标模型单向编译。
 *
 * 稿子（agent 写 / 人工写）里只有三种标准标记，与服务商无关，agent 只需学这一套：
 * - <cot text=情绪描述>要演的句子</cot>  作用域演法：给包住的句子套情绪/语气
 * - <fx>音效名</fx>                      点位拟声：在当前位置插入音效（笑声/叹息/清嗓…）
 * - <pause>600</pause>                   句间停顿（毫秒）
 *
 * 合成时按音色路由编译成目标模型的方言（TtsService.markupFor）：
 * - volcano-cot：火山复刻 2.0 expressive——cot 原样透传（需 additions.use_tag_parser，
 *   TtsService 自动开）；fx 翻译成「带情绪读拟声词」（火山没有无文本音效原语）；
 *   pause 翻译成省略号（大模型把 …… 自然读成停顿）
 * - bailian-brackets：百炼 Qwen-Audio 系（manifest 标 inlineTags）——cot 情绪描述按关键词
 *   映射成官方控制标签（[whispers]…），fx 映射成官方拟声标签（[laughing]…）；映射不上的
 *   剥掉留正文，不硬编；pause 同翻译成省略号
 * - plain：其余模型全剥，cot 留正文、fx 留拟声词（"哈哈"被正常念出来，比消失自然）
 *
 * 界面显示用 parseSpeechMarkup 做可视化渲染（SpeechText 组件）；
 * 纯文本场景（标题、字幕）用 stripSpeechTags。
 */

export type SpeechSegment =
  | { kind: 'text'; text: string }
  | { kind: 'cot'; style: string; text: string }
  | { kind: 'fx'; name: string }
  | { kind: 'pause'; ms: number }

/** 编译目标：火山 cot 方言 / 百炼方括号方言 / 全剥纯文本 */
export type SpeechCompileTarget = 'volcano-cot' | 'bailian-brackets' | 'plain'

/** 音效名 → 百炼拟声标签 + 火山/纯文本用的拟声词与读法 */
const FX_TABLE: Record<string, { bailian: string; word: string; style: string }> = {
  笑声: { bailian: 'laughing', word: '哈哈', style: '开怀地笑出声' },
  大笑: { bailian: 'laughing', word: '哈哈', style: '开怀大笑' },
  咯咯笑: { bailian: 'giggles', word: '呵呵', style: '咯咯地轻笑' },
  轻笑: { bailian: 'giggles', word: '呵呵', style: '轻轻笑了一声' },
  叹息: { bailian: 'sighing', word: '唉', style: '无奈地叹一口气' },
  叹气: { bailian: 'sighing', word: '唉', style: '无奈地叹一口气' },
  倒吸气: { bailian: 'gasp', word: '嘶', style: '惊讶地倒吸一口气' },
  清嗓: { bailian: 'clears throat', word: '咳咳', style: '清清嗓子' },
  咳嗽: { bailian: 'cough', word: '咳咳', style: '咳嗽两声' },
  哼声: { bailian: 'snorts', word: '哼', style: '不屑地哼了一声' },
  嗤笑: { bailian: 'snorts', word: '哼', style: '嗤笑一声' }
}

/** cot 情绪描述 → 百炼控制标签：按关键词命中，从上到下先赢；命中不了返回空（剥掉留正文） */
const COT_STYLE_TO_BAILIAN: [RegExp, string][] = [
  [/asmr/i, 'asmr'],
  [/悄悄话|耳语|压低声音|小声/, 'whispers'],
  [/深沉.*呐喊|呐喊/, 'deep and loud shouting'],
  [/大喊|喊|吆喝|叫卖/, 'shouting'],
  [/颤抖|发抖/, 'trembling'],
  [/哭|哽咽|啜泣/, 'crying'],
  [/伤心|难过|悲伤|委屈/, 'sad'],
  [/愤怒|生气|发火|恼火/, 'angry'],
  [/兴奋|激动|热血|高亢|亢奋/, 'excited'],
  [/惊叹|惊讶|吃惊|震惊/, 'amazed'],
  [/讽刺|阴阳怪气|挖苦/, 'sarcastic'],
  [/轻蔑|不屑|鄙视/, 'scornful'],
  [/好奇|疑惑/, 'curious'],
  [/阴森|德古拉|恐怖/, 'like dracula'],
  [/无聊|倦怠|没劲/, 'bored'],
  [/疲惫|疲倦|累了/, 'tired'],
  [/恐慌|慌张|惊慌|紧张/, 'panicked'],
  [/调皮|俏皮|顽皮/, 'mischievously'],
  [/共情|温柔|体贴|安慰|暖心/, 'empathetic'],
  [/不情愿|勉强|无奈/, 'reluctantly'],
  [/严肃|认真|郑重|正经/, 'serious'],
  [/非常慢|很慢|缓慢|慢慢|放缓/, 'very slowly'],
  [/非常快|很快|急促|飞快|加快|语速快/, 'very fast']
]

/** 统一语法 tokenizer：cot 开/闭、fx、pause */
const MARKUP_RE =
  /<cot\s+text=(?:"([^"]*)"|'([^']*)'|([^\s>]+))\s*>|<\/cot\s*>|<fx>([\s\S]*?)<\/fx>|<pause>\s*(\d{1,5})\s*<\/pause>/gi

/** 停顿毫秒 → 省略号个数：大模型把 …… 读成停顿，约 500ms 一拍，最多三拍 */
function pauseToEllipsis(ms: number): string {
  const beats = Math.max(1, Math.min(3, Math.round(ms / 500)))
  return '……'.repeat(beats)
}

/**
 * 解析稿子为段序列。容错约定（LLM 生成不必完美）：
 * - cot 不闭合：作用到当前句末（。！？；…）为止，找不到句末就作用到结尾
 * - cot 嵌套：内层标签拍平忽略，外层继续（官方本来也只支持单层）
 * - 落单的 </cot> 直接忽略
 * - cot 文本超过 64 字（官方上限）：从句末/停顿标点处拆成多个 cot 块，演法延续
 */
export function parseSpeechMarkup(raw: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  let cursor = 0
  let cotStyle: string | null = null
  let cotStart = 0
  const pushText = (text: string) => {
    if (text) segments.push({ kind: 'text', text })
  }
  for (const match of raw.matchAll(MARKUP_RE)) {
    const index = match.index
    const [full, dq, sq, bare, fxName, pauseMs] = match
    if (full.startsWith('<cot ')) {
      if (cotStyle !== null) continue // 嵌套：内层开标签忽略，外层继续
      pushText(raw.slice(cursor, index))
      cotStyle = (dq ?? sq ?? bare ?? '').trim()
      cotStart = index + full.length
      cursor = index + full.length
    } else if (full.startsWith('</cot')) {
      if (cotStyle === null) {
        // 落单闭标签：跳过标签本身，别让它漏进正文
        pushText(raw.slice(cursor, index))
        cursor = index + full.length
        continue
      }
      pushCot(segments, cotStyle, raw.slice(cotStart, index))
      cotStyle = null
      cursor = index + full.length
    } else if (full.startsWith('<fx>')) {
      if (cotStyle !== null) continue // cot 内的 fx 忽略
      pushText(raw.slice(cursor, index))
      const name = (fxName ?? '').trim()
      if (name) segments.push({ kind: 'fx', name })
      cursor = index + full.length
    } else {
      // <pause>毫秒</pause>：cot 内也生效（停顿是点位，不包正文）
      const ms = Math.min(5000, Math.max(100, Number(pauseMs) || 0))
      if (cotStyle !== null) {
        pushCot(segments, cotStyle, raw.slice(cotStart, index))
        cotStart = index + full.length
      } else {
        pushText(raw.slice(cursor, index))
      }
      if (ms > 0) segments.push({ kind: 'pause', ms })
      cursor = index + full.length
    }
  }
  if (cotStyle !== null) {
    // 未闭合：先作用到句末标点，剩余的退回正文
    const rest = raw.slice(cotStart)
    const end = rest.search(/[。！？；…!?;]/)
    if (end >= 0) {
      pushCot(segments, cotStyle, rest.slice(0, end + 1))
      pushText(rest.slice(end + 1))
    } else {
      pushCot(segments, cotStyle, rest)
    }
  } else {
    pushText(raw.slice(cursor))
  }
  return segments
}

/** cot 块入列：超 64 字优先从句末/停顿标点拆开（演法延续），窗口内没标点就硬切 64 字 */
function pushCot(segments: SpeechSegment[], style: string, text: string): void {
  // 嵌套容错：cot 正文里残留的标记（内层 cot / fx / pause）拍平清掉，不能发给模型
  let rest = text
    .replace(/<\/?cot\b[^>]*>/gi, '')
    .replace(/<fx>[\s\S]*?<\/fx>/gi, '')
    .replace(/<pause>\s*\d{1,5}\s*<\/pause>/gi, '')
  while ([...rest].length > 64) {
    const chars = [...rest]
    const window = chars.slice(0, 64).join('')
    const at = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('；'),
      window.lastIndexOf('，'),
      window.lastIndexOf('、')
    )
    const cut = at > 0 ? at + 1 : 64 // 没标点可拆：硬切
    const head = chars.slice(0, cut).join('')
    if (head.trim()) segments.push({ kind: 'cot', style, text: head })
    rest = chars.slice(cut).join('')
  }
  if (rest.trim()) segments.push({ kind: 'cot', style, text: rest })
}

/** 编译到目标模型方言（单向；详见文件头注释） */
export function compileSpeechMarkup(raw: string, target: SpeechCompileTarget): string {
  const segments = parseSpeechMarkup(raw)
  const out: string[] = []
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out.push(seg.text)
    } else if (seg.kind === 'pause') {
      out.push(pauseToEllipsis(seg.ms))
    } else if (seg.kind === 'cot') {
      if (target === 'volcano-cot') {
        out.push(`<cot text=${seg.style}>${seg.text}</cot>`)
      } else if (target === 'bailian-brackets') {
        const tag = bailianControlTag(seg.style)
        out.push(tag ? `[${tag}]${seg.text}` : seg.text)
      } else {
        out.push(seg.text)
      }
    } else {
      const fx = FX_TABLE[seg.name]
      if (!fx) continue // 不认识的音效名：丢弃（瞎猜一个音效比没有更糟）
      if (target === 'volcano-cot') out.push(`<cot text=${fx.style}>${fx.word}</cot>`)
      else if (target === 'bailian-brackets') out.push(`[${fx.bailian}]`)
      else out.push(fx.word)
    }
  }
  return out.join('')
}

function bailianControlTag(style: string): string {
  for (const [re, tag] of COT_STYLE_TO_BAILIAN) {
    if (re.test(style)) return tag
  }
  return ''
}

/**
 * 纯文本化：cot 留正文、fx/pause 整个去掉（标题/字幕场景"哈哈"和省略号是噪音）。
 * 合成用的纯文本目标是 compileSpeechMarkup(raw, 'plain')（fx 留拟声词、pause 留省略号），
 * 两者语义不同别混用。
 */
export function stripSpeechTags(raw: string): string {
  if (!raw.includes('<')) return raw
  return parseSpeechMarkup(raw)
    .filter(
      (seg): seg is Extract<SpeechSegment, { kind: 'text' | 'cot' }> =>
        seg.kind === 'text' || seg.kind === 'cot'
    )
    .map((seg) => seg.text)
    .join('')
}

export function hasSpeechMarkup(raw: string): boolean {
  return /<cot\s+text=|<fx>|<pause>/.test(raw)
}
