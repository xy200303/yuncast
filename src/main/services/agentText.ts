import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * AgentService 的纯文本/估算助手（从 AgentService 抽出：消息文本抽取、token 粗估、压缩钳制、一行摘要）。
 * 全是纯函数：不碰状态，单测/复用都方便。
 */

/** 压缩保留区的超大消息钳制：单条文本超过这个长度就截断（只动文本，不动消息结构） */
const CLAMP_MESSAGE_CHARS = 4000

/**
 * 超大消息截断：一条巨型工具结果（全量列表/长文）就能把压完的上下文重新顶过阈值造成死循环。
 * 只截文本内容，角色、toolCall/toolResult 配对等结构原样保留。
 */
export function clampOversizedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const m = message as { content?: unknown }
    if (typeof m.content === 'string') {
      return m.content.length > CLAMP_MESSAGE_CHARS
        ? ({ ...message, content: `${m.content.slice(0, CLAMP_MESSAGE_CHARS)}…（超长已截断）` } as AgentMessage)
        : message
    }
    if (!Array.isArray(m.content)) return message
    let changed = false
    const content = m.content.map((part) => {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string' && p.text.length > CLAMP_MESSAGE_CHARS) {
        changed = true
        return { ...(part as Record<string, unknown>), text: `${p.text.slice(0, CLAMP_MESSAGE_CHARS)}…（超长已截断）` }
      }
      return part
    })
    return changed ? ({ ...message, content } as AgentMessage) : message
  })
}

/** 单条消息的粗估 tokens：中文按字算（≈1 token/字），其余按 4 字符 ≈ 1 token。
 *  pi-ai 的 estimateMessageTokens 是 chars/4，对中文小三倍不止，切分保留额度会虚放大。 */
export function estimateMsgTokens(message: AgentMessage): number {
  const m = message as { content?: unknown }
  let text = ''
  if (typeof m.content === 'string') {
    text = m.content
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; name?: string; arguments?: unknown }
      if (p.type === 'text' && p.text) text += p.text
      else if (p.type === 'toolCall') text += (p.name ?? '') + JSON.stringify(p.arguments ?? '')
    }
  }
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x2e7f) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4) + 8
}

/** 把一条消息渲染成摘要模型看得懂的一行（压缩时喂旧对话用） */
export function renderMessageForSummary(message: AgentMessage): string {
  const m = message as { role?: string; content?: unknown; toolName?: string }
  const roleLabel =
    m.role === 'user' ? '导演/观众' : m.role === 'assistant' ? '主播' : m.role === 'toolResult' ? `工具结果(${m.toolName ?? ''})` : '系统'
  const parts: string[] = []
  if (typeof m.content === 'string') {
    parts.push(m.content)
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const p = part as { type?: string; text?: string; name?: string }
      if (p.type === 'text' && p.text) parts.push(p.text)
      else if (p.type === 'toolCall') parts.push(`[调用工具 ${p.name ?? ''}]`)
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return `${roleLabel}: ${text.slice(0, 300)}`
}

/**
 * 把工具的入参/结果压成一行短摘要给工具卡片用（渲染层只展示一行，全文放 title）。
 * 工具结果是 `{ content: [{ type: 'text', text }] }`，直接抽文本比 JSON 好读得多。
 */
export function oneLine(value: unknown, max: number): string {
  let raw: string
  if (typeof value === 'string') {
    raw = value
  } else if (Array.isArray(value)) {
    raw = value.map((item) => oneLine(item, max)).join(' ')
  } else if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content
    if (Array.isArray(content)) {
      raw = content
        .map((part) => {
          const text = (part as { text?: unknown })?.text
          return typeof text === 'string' ? text : ''
        })
        .filter(Boolean)
        .join(' ')
    } else {
      try {
        raw = JSON.stringify(value) ?? String(value)
      } catch {
        raw = String(value)
      }
    }
  } else {
    raw = String(value)
  }
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
