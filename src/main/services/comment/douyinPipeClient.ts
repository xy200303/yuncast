import { randomUUID } from 'node:crypto'
import type { LiveComment } from '../../../shared/types'
import { getDouyinLaunchContext, type DouyinPipeLaunchContext } from './launchContext'
import { loadPipeNativeBinding, PipeEventType, resolvePipeSdkDllPath } from './pipeNative'

/**
 * 抖音直播伴侣 PipeSDK 客户端（搬迁自旧版 douyinPipeClient）。
 * 经伴侣「互动工具」入口启动时拿到 pipeName 等参数，订阅 OPEN_LIVE_DATA 拿评论。
 */

interface OpenLiveDataItem {
  msg_id?: string | number
  msg_type?: number
  msg_type_str?: string
  nickname?: string
  content?: string
  timestamp?: number
}

interface PipeMessage {
  reqId?: string
  code?: number
  message?: string
  eventName?: string
  params?: { payload?: OpenLiveDataItem[] }
}

const log = console

export class DouyinPipeClient {
  readonly reconnectable = true
  private readonly launch: DouyinPipeLaunchContext
  private readonly onComment: (comment: LiveComment) => void
  private readonly onError: (message: string) => void
  private readonly onDisconnected: () => void
  private subscriptionRequestId = ''
  private messageId = 1
  private stopped = true
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null
  private seenMessageIds = new Set<string>()
  private seenMessageQueue: string[] = []

  constructor(
    onComment: (comment: LiveComment) => void,
    onError: (message: string) => void,
    onDisconnected: () => void
  ) {
    const launch = getDouyinLaunchContext()
    if (!launch || launch.mode !== 'pipe') {
      throw new Error('未收到直播伴侣 PipeSDK 参数，请从直播伴侣的互动工具入口启动本软件')
    }
    this.launch = launch
    this.onComment = onComment
    this.onError = onError
    this.onDisconnected = onDisconnected
  }

  async start(): Promise<void> {
    this.stopped = false
    const native = loadPipeNativeBinding()
    const version = native.start(
      resolvePipeSdkDllPath(),
      this.launch.pipeName,
      this.launch.maxChannels,
      (eventType, messageId, data) => this.handleEvent(eventType, messageId, data)
    )
    log.info('[AgentAnchor] PipeSDK 已初始化', version || 'unknown')

    await new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
      this.startTimer = setTimeout(() => {
        this.failStart(new Error('连接直播伴侣超时，请从互动工具入口重新启动软件'))
      }, 10_000)
      if (native.isConnected()) this.subscribeOpenLiveData()
    })
  }

  stop(): void {
    this.stopped = true
    this.clearStartWaiters()
    loadPipeNativeBinding().stop()
  }

  private handleEvent(eventType: number, _messageId: number, rawData: string): void {
    if (this.stopped) return
    if (eventType === PipeEventType.Connected) {
      this.subscribeOpenLiveData()
      return
    }
    if (eventType === PipeEventType.Message) {
      this.handleMessage(rawData)
      return
    }
    if (eventType === PipeEventType.Disconnected) {
      this.stopped = true
      this.clearStartWaiters()
      loadPipeNativeBinding().stop()
      log.info('[AgentAnchor] 直播伴侣已关闭互动工具')
      this.onDisconnected()
      return
    }
    if (eventType === PipeEventType.Broken || eventType === PipeEventType.ConnectionReset) {
      const message = eventType === PipeEventType.Broken ? 'PipeSDK 管道已断开' : 'PipeSDK 连接已重置'
      this.failStart(new Error(message))
      this.onError(message)
    }
  }

  private subscribeOpenLiveData(): void {
    if (this.stopped || this.subscriptionRequestId) return
    this.subscriptionRequestId = randomUUID()
    const payload = JSON.stringify({
      type: 'request',
      reqId: this.subscriptionRequestId,
      method: 'x.subscribeEvent',
      params: { eventName: 'OPEN_LIVE_DATA', timestamp: Date.now() }
    })
    const sent = loadPipeNativeBinding().sendMessage(this.messageId++, payload)
    if (!sent) this.failStart(new Error('订阅直播间评论数据失败'))
  }

  private handleMessage(rawData: string): void {
    const normalized = rawData.replace(/ +$/, '').trim()
    if (!normalized) return
    let message: PipeMessage
    try {
      message = JSON.parse(normalized) as PipeMessage
    } catch (error) {
      log.warn('[AgentAnchor] PipeSDK 消息解析失败:', error)
      return
    }

    if (message.reqId === this.subscriptionRequestId && typeof message.code === 'number') {
      if (message.code === 1) {
        this.clearStartTimer()
        this.startResolve?.()
        this.startResolve = null
        this.startReject = null
        log.info('[AgentAnchor] 已订阅直播伴侣 OPEN_LIVE_DATA')
      } else {
        this.failStart(new Error(message.message || `订阅直播间数据失败，错误码 ${message.code}`))
      }
      return
    }

    if (message.eventName !== 'OPEN_LIVE_DATA') return
    const payload = Array.isArray(message.params?.payload) ? message.params.payload : []
    for (const item of payload) {
      if (item.msg_type !== 2 && item.msg_type_str !== 'live_comment') continue
      const comment = this.toComment(item)
      if (comment && this.rememberMessage(comment.id)) this.onComment(comment)
    }
  }

  private toComment(item: OpenLiveDataItem): LiveComment | null {
    const content = item.content?.trim() ?? ''
    if (!content) return null
    const timestamp = item.timestamp ?? Date.now()
    return {
      id: String(item.msg_id ?? `${timestamp}-${randomUUID()}`),
      author: item.nickname?.trim() || '匿名',
      content,
      ts: timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
    }
  }

  private rememberMessage(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return false
    this.seenMessageIds.add(messageId)
    this.seenMessageQueue.push(messageId)
    if (this.seenMessageQueue.length > 5000) {
      const expired = this.seenMessageQueue.shift()
      if (expired) this.seenMessageIds.delete(expired)
    }
    return true
  }

  private failStart(error: Error): void {
    this.clearStartTimer()
    this.startReject?.(error)
    this.startResolve = null
    this.startReject = null
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private clearStartWaiters(): void {
    this.clearStartTimer()
    this.startResolve = null
    this.startReject = null
  }
}
