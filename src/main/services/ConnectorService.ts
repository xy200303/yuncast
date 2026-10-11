import type { ConnectorState, ConnectorStatus, LiveEvent } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { EventBus } from './EventBus'

/**
 * 平台连接器客户端（docs/04）：主应用不内置任何平台 SDK。
 * 订阅本地连接器的 WS 事件流（NDJSON，每行一个 LiveEvent），原样注入 EventBus。
 * 断线自动重连（指数退避 1s→30s 封顶）。连接器只绑 127.0.0.1。
 */

export type { ConnectorState, ConnectorStatus }

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

export class ConnectorService {
  private ws: WebSocket | null = null
  private state: ConnectorState = 'idle'
  private error: string | undefined
  private receivedCount = 0
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lineBuffer = ''
  private running = false

  constructor(
    private readonly storage: StorageService,
    private readonly bus: EventBus,
    private readonly onStatus: (status: ConnectorStatus) => void
  ) {}

  status(): ConnectorStatus {
    return {
      state: this.state,
      port: this.storage.getConfig().comment.connectorPort,
      error: this.error,
      receivedCount: this.receivedCount
    }
  }

  /** 开始连接循环（幂等）。连接器不在就一直退避重试，状态如实上报。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.retryAttempt = 0
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
    this.setState('idle')
  }

  /** 配置变更（端口改了）时调用：断开重连 */
  restart(): void {
    if (!this.running) return
    this.ws?.close()
    this.ws = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryAttempt = 0
    this.connect()
  }

  // ---------- 内部 ----------

  private setState(state: ConnectorState, error?: string): void {
    this.state = state
    this.error = error
    this.onStatus(this.status())
  }

  private connect(): void {
    if (!this.running) return
    const port = this.storage.getConfig().comment.connectorPort
    this.setState('connecting')
    let settled = false
    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : String(error))
      return
    }

    this.ws.onopen = () => {
      settled = true
      this.retryAttempt = 0
      this.lineBuffer = ''
      this.setState('connected')
      console.error('[AgentAnchor] 连接器已连接，端口', port)
    }
    this.ws.onmessage = (event) => {
      this.feedLines(typeof event.data === 'string' ? event.data : '')
    }
    this.ws.onerror = () => {
      // onclose 随后会到，统一在那里处理
    }
    this.ws.onclose = () => {
      this.ws = null
      if (!this.running) return
      this.scheduleRetry(settled ? '连接断开' : (this.error ?? '连接被拒（连接器没在运行？）'))
    }
  }

  private scheduleRetry(reason: string): void {
    if (!this.running) return
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.retryAttempt)
    this.retryAttempt += 1
    this.setState('error', `${reason}，${Math.round(delay / 1000)}s 后重试`)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  /** NDJSON 逐行解析：攒半行、一行一个 LiveEvent、坏行跳过记日志 */
  private feedLines(chunk: string): void {
    this.lineBuffer += chunk
    for (;;) {
      const nl = this.lineBuffer.indexOf('\n')
      if (nl < 0) return
      const line = this.lineBuffer.slice(0, nl).trim()
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (!line) continue
      let event: LiveEvent
      try {
        event = JSON.parse(line) as LiveEvent
      } catch {
        console.error('[AgentAnchor] 连接器事件解析失败:', line.slice(0, 120))
        continue
      }
      if (!event.type || typeof event.type !== 'string') continue
      this.receivedCount += 1
      this.bus.emit(
        event.type,
        event.payload && typeof event.payload === 'object' ? event.payload : {},
        'pipe'
      )
      // 状态里带计数刷新
      this.onStatus(this.status())
    }
  }
}
