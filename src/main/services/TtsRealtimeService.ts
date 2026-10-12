import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'

/**
 * 实时语音通道（双向 WebSocket 的 Realtime 模型）——**不是另一套配置，而是语音接入的另一种通道**。
 *
 * 三种通道（都在同一条接入下）：
 *   HTTP 整段（预合成成文件）→ 文本已知的剧本/暖场话术，播出零延迟
 *   HTTP + SSE 流式        → 动态内容的默认通道，边合成边播
 *   WebSocket 双向实时      → 文本可流式喂入，首包更低；未来承载双向语音对话
 * 通道由引擎按内容挑（见 SpeechPool），用户在接入上只回答「动态内容要不要边走边合成」。
 * 凭据、模型、参数全都来自该音色路由到的那条接入，这里不单独配置任何东西。
 *
 * ⚠ 协议状态：端点与模型名已按官方文档（help.aliyun.com/zh/model-studio/qwen-tts-realtime）确认，
 * 但 **WS 事件帧的具体格式尚未核对**，所以 `available()` 恒为 false，上层降级到 SSE 流式。
 * 核对文档后只需补齐 `connect()` 与帧解析，其余（路由、降级、播放）都已就位。
 */

export interface RealtimeChunk {
  pcm: Buffer
  sampleRate: number
}

export interface RealtimeHandlers {
  onChunk: (chunk: RealtimeChunk) => void
  onEnd: () => void
  onError: (error: string) => void
}

export class TtsRealtimeService {
  private sockets = new Map<string, WebSocket>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService
  ) {}

  /**
   * 实时通道用的凭据：这条音色路由到的那条接入（与语音合成同一份凭据，不用再填一遍）。
   * 没有音色或路由不通就返回 null。
   */
  connectionParams(voiceId?: string): Record<string, string | number | boolean> | null {
    try {
      return this.tts.routeForVoice(voiceId).connection.params
    } catch {
      return null
    }
  }

  /** 实时通道是否可用（协议已核对 + 凭据齐）。协议未核对期间恒为 false，池会降级到 SSE 流式。 */
  available(voiceId?: string): boolean {
    if (!this.connectionParams(voiceId)) return false
    // TODO(协议核对后置为 true)：见文件头说明
    return false
  }

  /** 不可用原因（给诊断/日志用的人话） */
  unavailableReason(voiceId?: string): string {
    if (!this.connectionParams(voiceId)) {
      return '这条音色还没有可用的接入（凭据不齐）：动态内容走整段或流式合成'
    }
    return '实时通道协议尚未核对（已隔离在 TtsRealtimeService）；动态内容降级到流式合成'
  }

  /**
   * 双向 WS 合成的协议实现位（待核对）：
   * 需要补齐：握手事件、文本帧、音频帧解析、结束帧、错误帧；
   * 百炼实时语音为 24kHz/48kHz PCM（文档：最高 48kHz，PCM/WAV/MP3/Opus）。
   */
  async start(sessionId: string, _text: string, handlers: RealtimeHandlers): Promise<void> {
    handlers.onError(
      `${this.unavailableReason()}；已降级为流式合成（语音合成通道）`
    )
    this.sockets.delete(sessionId)
  }

  stop(sessionId: string): void {
    const socket = this.sockets.get(sessionId)
    if (socket) {
      try {
        socket.close()
      } catch {
        // 忽略关闭异常
      }
      this.sockets.delete(sessionId)
    }
  }

  stopAll(): void {
    for (const id of [...this.sockets.keys()]) this.stop(id)
  }
}
