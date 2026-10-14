import { randomUUID } from 'node:crypto'

/**
 * 直播间动态收件箱（docs/10 §5.3 / §15.3）：评论/礼物/关注/进场/内容类触发器通知统一进箱。
 * 系统只负责收集、去重、过滤、归组、聚合唤醒、防轰炸；逐条回、合并回、延迟还是忽略由主播 Agent 自主决定。
 * 没有新动态时不唤醒 Agent、不产生 LLM 请求——flush 只由事件驱动。
 *
 * 处理顺序（§15.3）：连接器事件 id 去重 → 基础过滤（纯表情/单字刷屏/同人同内容刷屏）→
 * 相同内容归组计数 → 高优先级识别 → 自适应聚合 → 单批上限与超量摘要 → TTL 过期。
 */

// ---------- 保护参数（§15.3 要求的硬护栏；内部常量，不暴露到 UI） ----------

/** 单批最大事件数：超出的不丢，但批次文本只带增量摘要，不全量重带 */
const MAX_EVENTS_PER_BATCH = 20
/** 单批事件正文合计字符上限：同上，超量折进摘要 */
const MAX_CHARS_PER_BATCH = 1500
/** 每分钟最大 Agent 唤醒次数：超限继续攒，等限速窗口空出槽位 */
const MAX_WAKES_PER_MIN = 6
/** 未处理事件最长保留时间：new/seen 超过它还没被标记就置 expired，不会在很久以后突然补答 */
const EVENT_TTL_MS = 5 * 60_000
/** 高优先级事件且当前空闲时的唤醒延迟：低频重要评论不固定等满一个聚合窗口 */
const HIGH_PRIORITY_DELAY_MS = 2_000
/** 普通事件聚合窗口下限：低频时每批至少攒这么久（也是空闲时的基准延迟） */
const MIN_BATCH_WINDOW_MS = 5_000
/** 聚合窗口上限：高峰再密一批也只等这么久 */
const MAX_BATCH_WINDOW_MS = 30_000
/** 速率统计窗口：按最近这段时间的到达速率自适应聚合窗口 */
const RATE_WINDOW_MS = 30_000
/** 速率→窗口换算系数：最近 30s 每秒约 3 条时窗口顶到上限（窗口 = 下限 + 速率 × 系数） */
const WINDOW_RATE_FACTOR_MS = (MAX_BATCH_WINDOW_MS - MIN_BATCH_WINDOW_MS) / 3
/** Agent 忙碌时的 flush 重试间隔：忙时事件继续攒，重试不算唤醒、不占限速额度 */
const BUSY_RETRY_MS = 3_000
/** 连接器事件 id 去重窗口容量（LRU）：连接器重连后重投的重复事件不再进箱 */
const DEDUP_CAPACITY = 3000
/** 同一作者同一内容的刷屏窗口：窗口内重复不再新建事件，只给已有事件补计数 */
const SPAM_REPEAT_WINDOW_MS = 30_000
/** 过期/终态清扫间隔 */
const SWEEP_INTERVAL_MS = 30_000
/** 箱内事件条数上限（含终态）：超出裁掉最旧的终态事件，内存有界 */
const MAX_KEPT_EVENTS = 500

/**
 * 高优先级特征词（提问/价格/售后类）：第一版规则简陋——纯子串命中，
 * 「吗」「退」这类词误伤面不小，后续可换模型识别；命中只影响唤醒快慢，不影响送达。
 */
const HIGH_PRIORITY_HINTS = ['?', '？', '吗', '怎么', '如何', '多少', '价格', '多少钱', '售后', '退', '质量', '发货']

export type LiveEventState = 'new' | 'seen' | 'handled' | 'ignored' | 'expired'
export type LiveInboxKind = 'comment' | 'gift' | 'follow' | 'entrance' | 'trigger'

export interface LiveInboxEvent {
  id: string
  /** 连接器事件 id（去重用；触发器通知没有） */
  connectorEventId?: string
  kind: LiveInboxKind
  author: string
  /** 评论文本 / 礼物描述 / 触发器通知文本 */
  content: string
  /** 老粉画像（评论用，入箱时已拼好） */
  profileHint?: string
  /** 提问/价格/售后类识别为 high */
  priority: 'high' | 'normal'
  state: LiveEventState
  /** 相同内容归组计数 */
  count: number
  receivedAt: number
}

export interface LiveInboxPush {
  connectorEventId?: string
  kind: LiveInboxKind
  author: string
  content: string
  profileHint?: string
  /** 调用方显式指定优先级；不给就按关键词识别 */
  priority?: 'high' | 'normal'
}

export interface LiveInboxDeps {
  /** 批次出口：批次文本（分组计数/画像/优先级已标注）+ 本批事件。由 AgentService 包模板派给主播 */
  flush: (batchText: string, events: LiveInboxEvent[]) => void
  /** Agent 是否正在说话/处理上一批：忙时事件继续攒，不并发轰炸 */
  isAgentBusy: () => boolean
}

const KIND_LABEL: Record<LiveInboxKind, string> = {
  comment: '评论',
  gift: '礼物',
  follow: '关注',
  entrance: '进场',
  trigger: '系统通知'
}

/** 归一化：去空白/标点/表情后小写——归组与刷屏判断共用；归组键不落字段，用时按 content 现算 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function groupKeyOf(event: Pick<LiveInboxEvent, 'kind' | 'content'>): string {
  return `${event.kind}|${normalize(event.content)}`
}

export class LiveEventInbox {
  private events: LiveInboxEvent[] = []
  /** 连接器事件 id 去重（LRU：Map 插入序，删了重插刷新热度，超容量淘汰最旧） */
  private readonly dedup = new Map<string, true>()
  /** 归组索引：state=new 的事件按「类型|归一化文本」定位 */
  private readonly pendingByNorm = new Map<string, string>()
  /** 刷屏记录：作者|归一化文本 → 最近一次时间与事件 id */
  private readonly spamSeen = new Map<string, { ts: number; eventId: string }>()
  /** 最近到达时间戳（自适应窗口的速率统计） */
  private arrivals: number[] = []
  /** 最近唤醒时间戳（每分钟限速） */
  private wakesAt: number[] = []
  private flushTimer: NodeJS.Timeout | null = null
  /** 已排唤醒的预计触发时刻（高优先级插队时判断是否值得提前改期） */
  private flushFireAt = 0
  private readonly sweepTimer: NodeJS.Timeout

  constructor(private readonly deps: LiveInboxDeps) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** 事件入箱：去重 → 过滤 → 归组 → 排唤醒。任何分支都不会抛（事件通路不能反过来影响直播） */
  push(input: LiveInboxPush): void {
    const now = Date.now()
    const content = input.content.trim()
    if (!content) return

    // 1. 连接器事件 id 去重：重连重投的重复事件不再进箱
    if (input.connectorEventId) {
      if (this.dedup.has(input.connectorEventId)) return
      this.dedup.delete(input.connectorEventId)
      this.dedup.set(input.connectorEventId, true)
      if (this.dedup.size > DEDUP_CAPACITY) {
        const oldest = this.dedup.keys().next().value
        if (oldest !== undefined) this.dedup.delete(oldest)
      }
    }

    // 2. 基础过滤：纯表情/无意义单字刷屏直接丢弃
    const normalized = normalize(content)
    if (normalized.length < 2) return

    const high = input.priority === 'high' || (input.priority === undefined && this.isHighPriority(content))

    // 3. 归组：归一化文本相同且还在等新的事件合并为一条，count 累加
    const groupKey = `${input.kind}|${normalized}`
    const existingId = this.pendingByNorm.get(groupKey)
    const existing = existingId
      ? this.events.find((e) => e.id === existingId && e.state === 'new')
      : undefined
    if (existing) {
      existing.count += 1
      existing.receivedAt = now
      if (high) existing.priority = 'high'
      if (input.profileHint) existing.profileHint = input.profileHint
      this.arrivals.push(now)
      this.scheduleWake(existing)
      return
    }

    // 同一作者同一内容短时间刷屏：原批次已送出（seen）时不再新建，只补计数
    const spamKey = `${input.author}|${normalized}`
    const spam = this.spamSeen.get(spamKey)
    if (spam && now - spam.ts < SPAM_REPEAT_WINDOW_MS) {
      const ev = this.events.find((e) => e.id === spam.eventId)
      if (ev) ev.count += 1
      spam.ts = now
      return
    }

    const event: LiveInboxEvent = {
      id: `le-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      connectorEventId: input.connectorEventId,
      kind: input.kind,
      author: input.author,
      content,
      profileHint: input.profileHint,
      priority: high ? 'high' : 'normal',
      state: 'new',
      count: 1,
      receivedAt: now
    }
    this.events.push(event)
    this.pendingByNorm.set(groupKey, event.id)
    this.spamSeen.set(spamKey, { ts: now, eventId: event.id })
    this.arrivals.push(now)
    this.scheduleWake(event)
  }

  /** Agent 一轮跑完（AgentService 在 agent_end 时叫）：忙时攒下的事件补排一个唤醒 */
  notifyIdle(): void {
    if (this.flushTimer) return
    const pending = this.events.filter((e) => e.state === 'new')
    if (pending.length === 0) return
    this.scheduleWake(pending.find((e) => e.priority === 'high') ?? pending[0])
  }

  /** Agent 处理后标记（mark_live_events 工具）；不标也行，TTL 到了自然过期 */
  markEvents(ids: string[], state: 'handled' | 'ignored'): string {
    let marked = 0
    let skipped = 0
    for (const raw of ids) {
      const event = this.events.find((e) => e.id === String(raw).trim())
      if (!event || event.state === 'expired' || event.state === 'handled' || event.state === 'ignored') {
        skipped += 1
        continue
      }
      event.state = state
      this.pendingByNorm.delete(groupKeyOf(event))
      marked += 1
    }
    const label = state === 'handled' ? '已回应' : '不理'
    return skipped > 0
      ? `已把 ${marked} 条标为「${label}」；${skipped} 个 id 不存在或已过期，无需处理`
      : `已把 ${marked} 条标为「${label}」`
  }

  /** 会话停了：箱内没送出/没处理的动态随场次清掉，定时器收干净 */
  clear(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.events = []
    this.pendingByNorm.clear()
    this.spamSeen.clear()
    this.arrivals = []
    this.wakesAt = []
  }

  // ---------- 内部 ----------

  private isHighPriority(content: string): boolean {
    return HIGH_PRIORITY_HINTS.some((hint) => content.includes(hint))
  }

  /**
   * 排一个唤醒：高优先级且空闲 → 短延迟；普通事件 → 按到达速率自适应窗口；每分钟唤醒超限就继续攒。
   * 已有定时器时默认复用（一批只触发一个 Agent 回合），除非新事件能明显提前唤醒（高优先级插队）。
   */
  private scheduleWake(latest: LiveInboxEvent): void {
    const now = Date.now()
    let delay =
      !this.deps.isAgentBusy() && latest.priority === 'high'
        ? HIGH_PRIORITY_DELAY_MS
        : this.adaptiveWindow(now)
    this.wakesAt = this.wakesAt.filter((ts) => now - ts < 60_000)
    if (this.wakesAt.length >= MAX_WAKES_PER_MIN) {
      delay = Math.max(delay, this.wakesAt[0] + 60_000 - now)
    }
    if (this.flushTimer) {
      // 已排的唤醒更晚才提前改期（500ms 内的差别不值得重置定时器）
      if (now + delay < this.flushFireAt - 500) this.reschedule(delay)
      return
    }
    this.reschedule(delay)
  }

  /** 自适应聚合窗口：按最近 30s 的到达速率，在 5s~30s 之间线性伸缩 */
  private adaptiveWindow(now: number): number {
    this.arrivals = this.arrivals.filter((ts) => now - ts < RATE_WINDOW_MS)
    const rate = this.arrivals.length / (RATE_WINDOW_MS / 1000)
    return Math.min(MAX_BATCH_WINDOW_MS, Math.round(MIN_BATCH_WINDOW_MS + rate * WINDOW_RATE_FACTOR_MS))
  }

  /** 到点 flush：批次内事件 new→seen，组装自然语言批次文本交给出口；忙/限速时改期不算唤醒 */
  private flushNow(): void {
    this.flushTimer = null
    this.sweep()
    const pending = this.events.filter((e) => e.state === 'new')
    if (pending.length === 0) return

    // Agent 正在说话/处理上一批：事件继续攒，稍后再试
    if (this.deps.isAgentBusy()) return this.reschedule(BUSY_RETRY_MS)
    // 唤醒限速双保险（攒批期间别的入口也可能排过唤醒）
    const now = Date.now()
    this.wakesAt = this.wakesAt.filter((ts) => now - ts < 60_000)
    if (this.wakesAt.length >= MAX_WAKES_PER_MIN) {
      return this.reschedule(Math.max(1000, this.wakesAt[0] + 60_000 - now))
    }

    // 高优先在前：批次截断时优先保住提问/价格/售后
    const ordered = [...pending].sort((a, b) =>
      a.priority === b.priority ? a.receivedAt - b.receivedAt : a.priority === 'high' ? -1 : 1
    )
    const included: LiveInboxEvent[] = []
    let chars = 0
    for (const event of ordered) {
      const len = event.author.length + event.content.length + (event.profileHint?.length ?? 0) + 16
      if (included.length >= MAX_EVENTS_PER_BATCH || chars + len > MAX_CHARS_PER_BATCH) break
      included.push(event)
      chars += len
    }
    // 单条巨型事件也不许把批次卡空
    if (included.length === 0) included.push(ordered[0])
    const overflow = ordered.slice(included.length)

    // flush 即 seen：超量部分不丢——以增量摘要进批次文本，下一批不再全量重带
    for (const event of ordered) {
      event.state = 'seen'
      this.pendingByNorm.delete(groupKeyOf(event))
    }

    let text = included.map((event) => this.formatLine(event)).join('\n')
    if (overflow.length > 0) {
      const overflowCount = overflow.reduce((sum, e) => sum + e.count, 0)
      const top = overflow
        .slice(0, 3)
        .map((e) => `「${e.content.slice(0, 20)}」（×${e.count}）`)
        .join('、')
      text += `\n另有 ${overflow.length} 条同类动态未逐条列出（共 ${overflowCount} 人次）：${top}${overflow.length > 3 ? '…' : ''}`
    }
    this.wakesAt.push(Date.now())
    this.deps.flush(text, ordered)
  }

  private reschedule(delay: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushFireAt = Date.now() + delay
    this.flushTimer = setTimeout(() => this.flushNow(), delay)
    this.flushTimer.unref?.()
  }

  /** 批次行：id（mark_live_events 用）+ 类型 + 优先级 + 作者 + 内容 + 计数 + 画像 */
  private formatLine(event: LiveInboxEvent): string {
    let line = `- [${event.id}]【${KIND_LABEL[event.kind]}${event.priority === 'high' ? '·优先' : ''}】${event.author}：「${event.content}」`
    if (event.count > 1) line += `（×${event.count}）`
    if (event.profileHint) line += `（${event.profileHint}）`
    return line
  }

  /** TTL 过期与内存裁剪：new/seen 超过保留时间置 expired（不会再补答）；箱内条数有界 */
  private sweep(): void {
    const now = Date.now()
    for (const event of this.events) {
      if ((event.state === 'new' || event.state === 'seen') && now - event.receivedAt > EVENT_TTL_MS) {
        event.state = 'expired'
        this.pendingByNorm.delete(groupKeyOf(event))
      }
    }
    if (this.events.length > MAX_KEPT_EVENTS) {
      this.events = this.events.filter(
        (e) => e.state === 'new' || e.state === 'seen' || now - e.receivedAt < EVENT_TTL_MS
      )
    }
    for (const [key, rec] of this.spamSeen) {
      if (now - rec.ts > SPAM_REPEAT_WINDOW_MS) this.spamSeen.delete(key)
    }
  }
}
