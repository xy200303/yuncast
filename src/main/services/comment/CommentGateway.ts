import type { CommentGatewayStatus, LiveComment } from '../../../shared/types'
import { getDouyinLaunchContext } from './launchContext'
import { DouyinPipeClient } from './douyinPipeClient'
import type { CommentSimulator } from '../CommentSimulator'

/**
 * 评论网关（M7）：PipeSDK（直播伴侣）与模拟器二选一。
 * 评论统一走 onComment 回调交给上层（进 EventBus 的 comment.new，由触发器体系接管），
 * 网关自己不直接喂主播。
 * 断线 5s 后自动重连（可重连时）。
 */
export class CommentGateway {
  private client: DouyinPipeClient | null = null
  private running = false
  private source: CommentGatewayStatus['source'] = 'none'
  private lastError: string | null = null
  private receivedCount = 0
  private restartTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly simulator: CommentSimulator,
    private readonly onComment: (comment: LiveComment, source: 'pipe' | 'simulator') => void
  ) {}

  status(): CommentGatewayStatus {
    return {
      running: this.running,
      source: this.source,
      lastError: this.lastError,
      receivedCount: this.receivedCount
    }
  }

  /** 伴侣启动参数存在时自动接 PipeSDK；否则 403 式提示，让调用方决定开不开模拟器 */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true }
    try {
      const launch = getDouyinLaunchContext()
      if (!launch || launch.mode !== 'pipe') {
        throw new Error('未收到直播伴侣启动参数。从伴侣的「互动工具」入口启动本软件即可自动接入评论；开发调试可用模拟评论。')
      }
      this.client = new DouyinPipeClient(
        (comment) => this.ingest(comment, 'pipe'),
        (message) => this.handleConnectionError(message),
        () => this.handleDisconnected()
      )
      this.source = 'pipe'
      await this.client.start()
      this.running = true
      this.lastError = null
      console.error('[AgentAnchor] 评论网关已启动（PipeSDK）')
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.client?.stop()
      this.client = null
      this.source = 'none'
      this.lastError = message
      console.error('[AgentAnchor] 评论网关启动失败:', message)
      return { ok: false, error: message }
    }
  }

  stop(): void {
    this.running = false
    this.source = 'none'
    this.client?.stop()
    this.client = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private ingest(comment: LiveComment, source: 'pipe' | 'simulator'): void {
    this.receivedCount += 1
    this.onComment(comment, source)
  }

  private handleConnectionError(message: string): void {
    this.lastError = message
    if (!this.running) return
    if (!this.client?.reconnectable) return
    this.client.stop()
    this.client = null
    console.error('[AgentAnchor] 评论连接异常，5s 后重连:', message)
    this.restartTimer = setTimeout(() => {
      void this.start()
    }, 5000)
  }

  private handleDisconnected(): void {
    // 伴侣关闭了互动工具：网关停止，不连带退出应用（新旧行为差异：旧版直接 quit）
    this.stop()
  }
}
