import type { ServerResponse } from 'node:http'
import type { LiveEvent } from '../../shared/types'
import type { EventBus } from './EventBus'
import type { StorageService } from './StorageService'

/** 环形缓冲容量：游标在这窗口内的断线续传纯内存命中，更早的客户端走 gap 重同步 */
const CAP = 5000
/** 启动时从 event_log 回填的条数（重启后 SSE 客户端 Last-Event-ID 还能续上） */
const BOOT_SEED = 500
/** 慢客户端背压阈值（字节）：超过就跳积压发 gap，不拖垮主进程 */
const LAG_BYTES = 256 * 1024
/** 心跳间隔：防代理/网关掐空闲连接 */
const HEARTBEAT_MS = 15_000

interface HubEntry {
  seq: number
  type: string
  /** 预序列化的 SSE data 行（含 'data: ' 前缀和结尾两个换行），全客户端共享同一份字符串 */
  line: string
}

interface SseClient {
  res: ServerResponse
  kinds: Set<string> | null
  /** 已刷到的 seq（含） */
  flushed: number
  /** 慢客户端：跳过积压直接追最新 */
  lagging: boolean
  closed: boolean
}

/**
 * 事件分发中心（性能优先设计）：
 * - EventBus 的唯一订阅者，事件进来时 JSON.stringify 一次，N 个 SSE 客户端扇出同一字符串
 * - 内存环形缓冲是热路径：续传/近查全走内存，不回查数据库
 * - 同 tick 多事件攒批一次 write；慢客户端发 gap 跳过（可用 after 回补），心跳 15s
 * 端点：GET /events?kinds=comment.new,gift.received&after=<seq>（MCP 同一端口同一鉴权）
 */
export class EventHub {
  private buf: HubEntry[] = []
  private seq = 0
  private clients = new Set<SseClient>()
  private unsubscribe: (() => void) | null = null
  private flushScheduled = false
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly bus: EventBus,
    private readonly storage: StorageService
  ) {}

  start(): void {
    if (this.unsubscribe) return
    for (const event of this.storage.eventLogRecent(BOOT_SEED)) this.push(event)
    this.unsubscribe = this.bus.subscribe((event) => this.push(event))
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          if (!client.closed) client.res.write(`:hb ${Date.now()}\n\n`)
        } catch {
          this.drop(client)
        }
      }
    }, HEARTBEAT_MS)
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) this.drop(client)
    this.clients.clear()
    this.buf = []
  }

  clientCount(): number {
    return this.clients.size
  }

  /** 一次性近查（events_recent 工具 / CLI 无 follow 模式用） */
  recent(limit: number, kinds?: Set<string>): string {
    const picked: HubEntry[] = []
    for (let i = this.buf.length - 1; i >= 0 && picked.length < limit; i--) {
      const entry = this.buf[i]
      if (kinds && !kinds.has(entry.type)) continue
      picked.push(entry)
    }
    // line 形如 'data: {...}\n\n'，还原出 JSON 部分
    return JSON.stringify(
      picked.reverse().map((entry) => JSON.parse(entry.line.slice(6, -2))),
      null,
      2
    )
  }

  /** 事件类型清单（目录里的注册表 + 缓冲里实际见过的） */
  kinds(): string[] {
    return [...new Set(this.buf.map((entry) => entry.type))]
  }

  /** SSE 订阅：after 是客户端上次收到的 seq（Last-Event-ID），缺省/过旧从缓冲最旧处补 */
  subscribeSse(res: ServerResponse, kinds: Set<string> | null, after?: number): void {
    const oldest = this.buf.length > 0 ? this.buf[0].seq : this.seq + 1
    const client: SseClient = { res, kinds, flushed: 0, lagging: false, closed: false }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    if (after !== undefined && after >= oldest - 1) {
      client.flushed = after
    } else {
      // 游标过旧/缺省：告知跳段，从缓冲最旧处补齐
      client.flushed = oldest - 1
      if (after !== undefined && after < oldest - 1) {
        res.write(`event: gap\ndata: {"reason":"cursor too old","resumeFrom":${oldest}}\n\n`)
      }
    }
    this.clients.add(client)
    res.on('close', () => this.drop(client))
    this.flushClient(client)
  }

  private drop(client: SseClient): void {
    if (client.closed) return
    client.closed = true
    this.clients.delete(client)
    try {
      client.res.end()
    } catch {
      /* 已经断了 */
    }
  }

  private push(event: LiveEvent & { programId?: string }): void {
    const seq = ++this.seq
    const line = `data: ${JSON.stringify({
      seq,
      id: event.id,
      type: event.type,
      source: event.source,
      ts: event.ts,
      programId: event.programId ?? (this.storage.getConfig().live.activeProgramId || null),
      payload: event.payload
    })}\n\n`
    this.buf.push({ seq, type: event.type, line })
    // 摊销 O(1)：超容一半时一次性截掉旧段，不逐条 shift
    if (this.buf.length > CAP + 1000) this.buf.splice(0, this.buf.length - CAP)
    if (this.clients.size === 0) return
    if (this.flushScheduled) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      for (const client of this.clients) this.flushClient(client)
    })
  }

  /** 给单个客户端刷出它还没收到的缓冲段：预序列化行 join 后一次 write */
  private flushClient(client: SseClient): void {
    if (client.closed) return
    if (client.lagging) {
      // 慢客户端：跳过积压，发 gap 标记追到最新
      client.lagging = false
      client.flushed = this.seq
      try {
        client.res.write(`event: gap\ndata: {"reason":"slow consumer","resumeFrom":${this.seq}}\n\n`)
      } catch {
        this.drop(client)
      }
      return
    }
    const start = this.buf.findIndex((entry) => entry.seq > client.flushed)
    if (start === -1) return
    const parts: string[] = []
    let last = client.flushed
    for (let i = start; i < this.buf.length; i++) {
      const entry = this.buf[i]
      if (client.kinds && !client.kinds.has(entry.type)) continue
      parts.push(`id: ${entry.seq}\n`, entry.line)
      last = entry.seq
    }
    if (parts.length === 0) return
    try {
      client.res.write(parts.length === 1 ? parts[0] : parts.join(''))
      client.flushed = last
      if (client.res.writableLength > LAG_BYTES) client.lagging = true
    } catch {
      this.drop(client)
    }
  }
}
