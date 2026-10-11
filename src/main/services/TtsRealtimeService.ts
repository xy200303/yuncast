import type { StorageService } from './StorageService'

/**
 * 实时语音通道（双向 WebSocket 的 Realtime 模型）。
 *
 * 与「语音合成」通道的区别（见 docs/02-TTS选型调研 §三档）：
 *   语音合成：HTTP 批量（预合成）或 HTTP+SSE 流式输出 —— 文本整段给入
 *   实时语音：WebSocket 双向 —— 文本可流式喂入，进一步压首包延迟；未来可承载双向语音对话
 * 二者模型、端点、鉴权口径都不同（百炼实时端点形如
 *   wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference），
 * 因此配置上分成两组（config.tts 与 config.ttsRealtime）。
 *
 * ⚠ 协议状态：端点与模型名已按官方文档（help.aliyun.com/zh/model-studio/qwen-tts-realtime）确认，
 * 但**WS 事件帧的具体格式（握手/文本帧/音频帧/结束帧）尚未核对**（该页指向的 Realtime API 文档未取到）。
 * 因此本文件把协议细节集中在 `connect()` 内并明确抛错，由上层降级到 SSE 流式通道——
 * 核对文档后只需补齐 `connect()` 与帧解析，其余（配置、路由、降级、播放）都已就位。
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

  constructor(private readonly storage: StorageService) {}

  /** 实时通道是否可用（配置齐 + 协议已核对）。协议未核对期间恒为 false，池会降级到流式通道。 */
  available(): boolean {
    const cfg = this.storage.getConfig().ttsRealtime
    if (!cfg.enabled) return false
    // TODO(协议核对后置为 true)：见文件头说明
    return false
  }

  /** 不可用原因（给 UI/日志用的人话） */
  unavailableReason(): string {
    const cfg = this.storage.getConfig().ttsRealtime
    if (!cfg.enabled) return '未启用实时语音'
    if (!cfg.wsUrl) return '实时语音端点未配置（需要带业务空间 ID 的 wss 地址）'
    return '实时语音协议尚未核对（已隔离在 TtsRealtimeService，核对后即可启用）'
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
