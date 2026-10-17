import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WebContents } from 'electron'
import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { IPC } from '../../shared/ipc-channels'
import {
  MCP_DEFAULT_PORT,
  MCP_HOST,
  type DirectorTimelineEvent,
  type DirectorTimelineReset,
  type LaunchResult,
  type McpConfig,
  type McpRuntime
} from '../../shared/types'
import { callTool, mcpToolList, schemaText, toolsText } from './tools/catalog'
import type { ToolCtx } from './tools/types'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import type { SpeechPool } from './SpeechPool'
import type { AgentService } from './AgentService'
import type { PersonaService } from './PersonaService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { ScriptService } from './ScriptService'
import type { StreamService } from './stream/StreamService'
import type { DraftUnitService } from './DraftUnitService'
import type { ProgramPlaybackService } from './ProgramPlaybackService'
import type { ExportService } from './ExportService'
import type { RecordingService } from './RecordingService'
import type { AudioStyleService } from './AudioStyleService'
import type { VoiceService } from './VoiceService'
import type { ConnectorService } from './ConnectorService'
import type { TriggerRuntime } from './TriggerRuntime'
import type { EventHub } from './EventHub'

/** agent_chat 的等待者：订阅对话时间线，等本轮 final:true 的文本条目 */
interface ChatWaiter {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** entryId → 已累积文本（append 流式增量拼接） */
  texts: Map<string, string>
}

/** 播出控制三件套 + 开播编排：由 main/index.ts 注入（复用主进程里的同一批服务实例） */
export interface McpHooks {
  /** 开播编排与 IPC.programLaunch 完全同口径（开播事件、收尾复位、低水位顶稿） */
  launchProgram: (programId: string, allowPartial: boolean) => Promise<LaunchResult>
  /** 暂停/恢复播报（停播报循环 + 停主播产出） */
  setPaused: (paused: boolean) => void
  /** 跳过当前这条（掐音频，条目按播完处理） */
  skipCurrent: () => void
}

export interface McpDeps {
  storage: StorageService
  tts: TtsService
  pool: SpeechPool
  agent: AgentService
  persona: PersonaService
  knowledge: KnowledgeService
  memory: MemoryService
  script: ScriptService
  stream: StreamService
  draftUnits: DraftUnitService
  programPlayback: ProgramPlaybackService
  exporter: ExportService
  recorder: RecordingService
  voices: VoiceService | null
  getAudioStyle?: () => AudioStyleService | null
  eventHub: EventHub
  getConnector?: () => ConnectorService | null
  getTriggers?: () => TriggerRuntime | null
  hooks: McpHooks
  getSender: () => WebContents | null
}

/**
 * 本机开放接口（MCP 协议 + 命令行 + SSE 事件流，docs 参照同作者 TermPilot）。
 * 只绑 127.0.0.1，每个请求都要带 Bearer 令牌。工具目录与内置主播 agent 共用
 * tools/ 下的同一份定义（TypeBox schema 直出 JSON Schema，不再经 zod 转换）。
 * /mcp = 标准 MCP（Streamable HTTP）；/cli = 命令行简化 JSON RPC；/events = SSE 事件流。
 */
export class McpService {
  private http: Server | null = null
  private transports = new Map<string, StreamableHTTPServerTransport>()
  private waiters = new Set<ChatWaiter>()
  private token = ''
  private runtime: McpRuntime = { running: false, port: MCP_DEFAULT_PORT, clients: 0 }
  /** apply 串行化：并发开关/保存时避免 stop-listen 交错导致的假「端口占用」 */
  private applying: Promise<void> = Promise.resolve()

  constructor(private readonly deps: McpDeps) {}

  state(): McpRuntime {
    return this.runtime
  }

  apply(settings: McpConfig): Promise<void> {
    const run = this.applying.then(() => this.doApply(settings))
    this.applying = run.catch(() => undefined)
    return run
  }

  private async doApply(settings: McpConfig): Promise<void> {
    await this.stop()
    if (!settings.enabled) {
      this.publish({ running: false, port: settings.port, clients: 0 })
      console.log('[YunCast] MCP 未启用')
      return
    }
    this.token = settings.token
    try {
      await this.listen(settings.port)
      this.publish({ running: true, port: settings.port, clients: 0 })
      console.log(`[YunCast] MCP listening on http://${MCP_HOST}:${settings.port}/mcp`)
    } catch (error) {
      const message = listenError(error, settings.port)
      this.publish({ running: false, port: settings.port, clients: 0, error: message })
      throw new Error(message)
    }
  }

  async stop(): Promise<void> {
    const closing = [...this.transports.values()].map((transport) => transport.close().catch(() => undefined))
    this.transports.clear()
    await Promise.all(closing)
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('应用正在退出'))
    }
    this.waiters.clear()
    const http = this.http
    this.http = null
    if (!http) return
    http.closeAllConnections?.()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  /** 对话时间线喂进来（main 在广播时顺带调）：agent_chat 的等待者从这里收回复 */
  feedTimeline(event: DirectorTimelineEvent | DirectorTimelineReset): void {
    if (this.waiters.size === 0) return
    if ('type' in event && event.type === 'reset') return
    const { entry } = event as DirectorTimelineEvent
    if (entry.type !== 'text') return
    for (const waiter of this.waiters) {
      const prev = waiter.texts.get(entry.id) ?? ''
      waiter.texts.set(entry.id, entry.append ? prev + entry.text : entry.text)
      if (!entry.final) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve(waiter.texts.get(entry.id) ?? '')
    }
  }

  /** 外部调用的工具上下文：每次现组装，动态服务（连接器/触发器）取到最新引用 */
  private ctx(): ToolCtx {
    const d = this.deps
    return {
      caller: 'external',
      pool: d.pool,
      knowledge: d.knowledge,
      memory: d.memory,
      persona: d.persona,
      script: d.script,
      storage: d.storage,
      draftUnits: d.draftUnits,
      tts: d.tts,
      agent: d.agent,
      programPlayback: d.programPlayback,
      connector: d.getConnector?.() ?? null,
      voices: d.voices,
      audioStyle: d.getAudioStyle?.() ?? null,
      triggers: d.getTriggers?.() ?? null,
      stream: d.stream,
      exporter: d.exporter,
      recorder: d.recorder,
      launchProgram: (programId, allowPartial) => d.hooks.launchProgram(programId, allowPartial),
      setPaused: (paused) => d.hooks.setPaused(paused),
      skipCurrent: () => d.hooks.skipCurrent(),
      agentChat: (text, timeoutMs) => this.agentChat(text, timeoutMs),
      eventsRecent: (limit, kinds) => d.eventHub.recent(limit, kinds),
      getStatus: () => d.agent.status(),
      produceProgramAudio: (programId) => d.draftUnits.produceProgramAudio(programId),
      describeProducePlan: (programId) => d.draftUnits.describeProducePlan(programId),
      // 外部 agent 持令牌即导演身份：确认卡落成日志，工具返回指引后带 confirmed=true 重调即可执行
      onDirectorAsk: (ask) => console.log('[YunCast] 外部调用触发确认卡:', ask.text)
    }
  }

  private publish(next: McpRuntime): void {
    this.runtime = next
    const wc = this.deps.getSender()
    if (!wc || wc.isDestroyed()) return
    wc.send(IPC.mcpStateEvent, next)
  }

  private publishClients(): void {
    this.publish({ ...this.runtime, clients: this.transports.size, error: undefined })
  }

  private listen(port: number): Promise<void> {
    const http = createServer((req, res) => {
      void this.onRequest(req, res, port)
    })
    this.http = http
    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, MCP_HOST, () => {
        http.off('error', reject)
        resolve()
      })
    })
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    try {
      // 三层防护：Host 头 + 回环地址 + Bearer 令牌
      if (!hostAllowed(req, port) || !loopback(req)) {
        sendJson(res, 403, rpcError('Forbidden'))
        return
      }
      if (!authorized(header(req, 'authorization'), this.token)) {
        sendJson(res, 401, rpcError('Unauthorized'))
        return
      }
      const url = new URL(req.url ?? '/', `http://${MCP_HOST}:${port}`)
      if (url.pathname === '/cli') {
        await this.onCli(req, res)
        return
      }
      if (url.pathname === '/events') {
        this.onEvents(url, req, res)
        return
      }
      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        sendJson(res, 405, rpcError('Method not allowed'))
        return
      }

      const sessionId = header(req, 'mcp-session-id')
      let parsed: unknown
      if (req.method === 'POST') {
        const raw = await readBody(req)
        if (raw) {
          try {
            parsed = JSON.parse(raw)
          } catch {
            sendJson(res, 400, rpcError('Invalid JSON'))
            return
          }
        }
      }

      let transport = sessionId ? this.transports.get(sessionId) : undefined
      if (sessionId && !transport) {
        sendJson(res, 404, rpcError('Session not found'))
        return
      }
      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(parsed)) {
          sendJson(res, 400, rpcError('No valid session ID'))
          return
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.transports.set(id, transport!)
            this.publishClients()
          }
        })
        transport.onclose = () => {
          const id = transport?.sessionId
          if (id) this.transports.delete(id)
          this.publishClients()
        }
        const server = this.createServer()
        await server.connect(transport)
      }
      await transport.handleRequest(req, res, parsed)
    } catch (error) {
      console.error('[YunCast] MCP request failed:', error)
      if (!res.headersSent) sendJson(res, 500, rpcError('Internal server error'))
    }
  }

  /**
   * SSE 事件流：GET /events?kinds=comment.new,gift.received&after=<seq>
   * 断线重连带 Last-Event-ID 或 after 游标续传；游标过旧服务端发 gap 跳段。
   */
  private onEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, text: '只接受 GET' })
      return
    }
    const kindsParam = url.searchParams.get('kinds')
    const kinds = kindsParam
      ? new Set(kindsParam.split(',').map((k) => k.trim()).filter(Boolean))
      : null
    const afterRaw = url.searchParams.get('after') ?? header(req, 'last-event-id')
    const after = afterRaw !== null && afterRaw !== undefined && afterRaw !== '' ? Number(afterRaw) : undefined
    this.deps.eventHub.subscribeSse(res, kinds, Number.isFinite(after) ? after : undefined)
  }

  /** 低层 Server：工具目录的 TypeBox schema 直接作为 inputSchema 吐给客户端，不经 zod */
  private createServer(): McpLowLevelServer {
    const server = new McpLowLevelServer(
      { name: 'yuncast', version: '0.2.0' },
      { capabilities: { tools: { listChanged: true } } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mcpToolList().map(({ risk: _risk, ...tool }) => tool)
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      const result = await this.run(name, () => callTool(this.ctx(), name, (args ?? {}) as Record<string, unknown>))
      return result
    })
    return server
  }

  /** 导演指令 → 主播，等本轮 final 文本返回。正在生成时拒绝，别叠着发。 */
  private async agentChat(text: string, timeoutMs: number): Promise<string> {
    const { agent } = this.deps
    if (agent.status().busy) throw new Error('主播正在生成上一轮的回复，等她说完再发（可先 agent_status 看 busy）')
    const waiting = new Promise<string>((resolve, reject) => {
      const waiter: ChatWaiter = {
        resolve,
        reject,
        texts: new Map(),
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没说完。主播可能卡在工具调用上，用 agent_status 看看 busy`))
        }, timeoutMs)
      }
      this.waiters.add(waiter)
    })
    // ensureSession 没节目会抛错，如实返回给调用方
    await agent.chat(text)
    const reply = await waiting
    return reply.trim() || '（这轮没有文字回复，可能只做了动作；用 agent_status / pool_status 看结果）'
  }

  private async onCli(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, text: '只接受 POST' })
      return
    }
    let body: { op?: unknown; tool?: unknown; args?: unknown }
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { op?: unknown; tool?: unknown; args?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, text: 'Invalid JSON' })
      return
    }
    if (body.op === 'tools') {
      sendJson(res, 200, { ok: true, text: toolsText() })
      return
    }
    if (body.op === 'schema') {
      try {
        sendJson(res, 200, { ok: true, text: schemaText(typeof body.tool === 'string' ? body.tool : undefined) })
      } catch (error) {
        sendJson(res, 200, { ok: false, text: error instanceof Error ? error.message : '失败' })
      }
      return
    }
    if (body.op !== 'call' || typeof body.tool !== 'string' || !body.tool) {
      sendJson(res, 400, { ok: false, text: 'op 只能是 tools、schema 或 call' })
      return
    }
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {}
    const result = await this.run(body.tool, () => callTool(this.ctx(), body.tool as string, args))
    const text = result.content[0]?.text ?? ''
    sendJson(res, 200, { ok: result.isError !== true, text })
  }

  private async run(tool: string, fn: () => Promise<string>) {
    try {
      const text = await fn()
      console.log(`[YunCast] MCP ${tool} ✓`)
      return { content: [{ type: 'text' as const, text }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[YunCast] MCP ${tool} ✗ ${message}`)
      return { isError: true, content: [{ type: 'text' as const, text: message }] }
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = header(req, 'host')
  return host === `${MCP_HOST}:${port}` || host === `localhost:${port}`
}

function loopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1' || addr === '::1'
}

function authorized(headerValue: string | undefined, token: string): boolean {
  if (!headerValue?.startsWith('Bearer ') || !token) return false
  const got = Buffer.from(headerValue.slice('Bearer '.length))
  const expect = Buffer.from(token)
  if (got.length !== expect.length) return false
  return timingSafeEqual(got, expect)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
}

function listenError(error: unknown, port: number): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用：换个端口，或关掉占用它的程序`
  }
  return error instanceof Error ? error.message : String(error)
}
