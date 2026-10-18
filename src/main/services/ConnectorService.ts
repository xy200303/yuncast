import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { ConnectorState, ConnectorStatus, LiveEvent } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { EventBus } from './EventBus'

/**
 * 平台连接器客户端（docs/04 v2：单一 MCP 协议）。
 * MCP Client 连 http://127.0.0.1:<port>/mcp（Bearer Token），
 * 事件经 notifications/live_event 注入 EventBus；出站动作用 callTool。
 * 断线自动重连（指数退避 1s→30s 封顶）。
 */

/** 事件推送的 notification 方法名（连接器协议，见 connectors/docs/protocol.md） */
export const LIVE_EVENT_NOTIFICATION = 'notifications/live_event'

const LiveEventNotificationSchema = z.looseObject({
  method: z.literal(LIVE_EVENT_NOTIFICATION),
  params: z.looseObject({
    id: z.string(),
    type: z.string(),
    source: z.string(),
    payload: z.record(z.string(), z.unknown()),
    ts: z.number()
  })
})

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

export class ConnectorService {
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null
  private state: ConnectorState = 'idle'
  private error: string | undefined
  private receivedCount = 0
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private connecting = false

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
    void this.connect()
  }

  stop(): void {
    this.running = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    void this.transport?.close().catch(() => undefined)
    this.transport = null
    this.client = null
    this.setState('idle')
  }

  /** 配置变更（端口/token 改了）时调用：断开重连 */
  restart(): void {
    if (!this.running) return
    void this.transport?.close().catch(() => undefined)
    this.transport = null
    this.client = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryAttempt = 0
    void this.connect()
  }

  /** 出站动作口（CompanionBridge 并入这里）：调连接器工具。未连接时抛清晰错误。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client || this.state !== 'connected') {
      throw new Error('连接器未连接（先确认连接器在运行、设置里的端口和 Token 对）')
    }
    const result = await this.client.callTool({ name, arguments: args })
    const content = result.content as { type: string; text?: string }[] | undefined
    return content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(result)
  }

  /** 发现连接器提供的工具（同步商品这类能力探测用）；未连接返回空 */
  async listTools(): Promise<{ name: string; description?: string }[]> {
    if (!this.client || this.state !== 'connected') return []
    const result = await this.client.listTools()
    return result.tools.map((t) => ({ name: t.name, description: t.description }))
  }

  // ---------- 内部 ----------

  private setState(state: ConnectorState, error?: string): void {
    this.state = state
    this.error = error
    this.onStatus(this.status())
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return
    this.connecting = true
    const { connectorPort, connectorToken } = this.storage.getConfig().comment
    this.setState('connecting')
    try {
      const client = new Client({ name: 'yuncast', version: '0.1.0' })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${connectorPort}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${connectorToken}` } } }
      )
      // 事件推送入 EventBus
      client.setNotificationHandler(LiveEventNotificationSchema, (notification) => {
        const event = notification.params as LiveEvent
        this.receivedCount += 1
        this.bus.emit(event.type, event.payload, 'pipe')
        this.onStatus(this.status())
      })
      transport.onclose = () => {
        if (this.transport !== transport) return
        this.client = null
        this.transport = null
        if (this.running) this.scheduleRetry('连接断开')
      }
      transport.onerror = (error) => {
        // SDK 传输层自带 SSE 重连且不认 404（旧会话僵尸）——传输错误统一按连接失败处理：
        // 关掉旧传输，走我们的退避重连（每次重连都是全新 MCP 会话）
        console.error('[YunCast] 连接器传输错误:', error.message)
        if (this.transport !== transport) return
        this.client = null
        this.transport = null
        void transport.close().catch(() => undefined)
        if (this.running) this.scheduleRetry(error.message)
      }
      await client.connect(transport)
      this.client = client
      this.transport = transport
      this.retryAttempt = 0
      const info = client.getServerVersion()
      this.setState('connected')
      console.error(`[YunCast] 连接器已连接：${info?.name ?? '?'} ${info?.version ?? ''}，端口 ${connectorPort}`)
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : String(error))
    } finally {
      this.connecting = false
    }
  }

  private scheduleRetry(reason: string): void {
    if (!this.running || this.retryTimer) return // 退避中不叠加（onerror/onclose 可能前后脚到）
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.retryAttempt)
    this.retryAttempt += 1
    this.setState('error', `${reason}，${Math.round(delay / 1000)}s 后重试`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }
}
