import { rm } from 'node:fs/promises'
import { decodeToPcm } from './stream/ffmpeg/mixer'
import type { TtsService } from './TtsService'

/**
 * 实时 TTS 流式合成服务（M9）。
 *
 * 目标：话术不再"整段合成完才播"，而是**边合成边播**，把首包延迟从「整段合成时间」压到「首块到达时间」。
 *
 * 当前实现分两层：
 * 1. **流式管线（已实现，可验证）**：一次合成 → FFmpeg 解码为 PCM → 按 100ms 块**按真实速率节拍**吐给消费方。
 *    这条路径打通了「PCM 分块 → 渲染进程 WebAudio 无缝排播 → 混音器直通」，播放确实是"边收边播"。
 * 2. **供应商真流式（待接入）**：把 1 换成服务商的流式接口（火山 WS 二进制协议 / 百炼 DashScope stream），
 *    只需替换本文件 `streamChunks()` 的取数方式，下游一行不用改。⚠ 流式协议细节未核对（同 docs/06 口径），
 *    核对清单见 docs/06-TTS克隆接口核对.md 末节。
 */

/** 每块的音频时长（PCM 16bit 单声道 48k 下 ≈ 100ms 一帧，与混音器帧率对齐） */
const CHUNK_MS = 100
const SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000

export interface TtsStreamSession {
  sessionId: string
  /** 收到一块 PCM（s16le 48k mono） */
  onChunk: (pcm: Buffer) => void
  /** 播放队列已排满、可以开始播的时刻（首块到达） */
  onFirstChunk?: () => void
  onEnd: () => void
  onError: (error: string) => void
}

export class TtsStreamService {
  private sessions = new Map<string, { abort: AbortController }>()

  constructor(private readonly tts: TtsService) {}

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 开始一次流式合成；返回 sessionId。chunk 以 onChunk 回调吐出，节奏按真实播放速率。 */
  async start(
    sessionId: string,
    text: string,
    voiceId: string | undefined,
    handlers: Omit<TtsStreamSession, 'sessionId'>
  ): Promise<void> {
    const abort = new AbortController()
    this.sessions.set(sessionId, { abort })

    let firstChunkSent = false
    try {
      for await (const chunk of this.streamChunks(text, voiceId, abort.signal)) {
        if (abort.signal.aborted) break
        if (!firstChunkSent) {
          firstChunkSent = true
          handlers.onFirstChunk?.()
        }
        handlers.onChunk(chunk)
      }
      if (abort.signal.aborted) return
      handlers.onEnd()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!abort.signal.aborted) handlers.onError(message)
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.abort.abort()
    this.sessions.delete(sessionId)
  }

  stopAll(): void {
    for (const [, session] of this.sessions) session.abort.abort()
    this.sessions.clear()
  }

  /**
   * 产出 PCM 块流。
   * 现在：一次合成 → 解码 → 切片 → 按真实速率节拍吐出（模拟流式，管线真实）。
   * 将来：替换为服务商流式接口的读取循环（火山 WS / 百炼 stream），签名不变。
   */
  private async *streamChunks(
    text: string,
    voiceId: string | undefined,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    let tempFile = ''
    try {
      // 一次合成到缓存（将来这里换成服务商流式读取循环，下游不变）
      tempFile = await this.tts.synthesize(`stream-${Date.now()}`, text, voiceId, signal)
      if (signal.aborted) return
      const pcm = await decodeToPcm(tempFile)
      for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
        if (signal.aborted) return
        yield pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length))
        // 按真实播放速率节拍吐块：消费方一边收一边播，队列水位不会被灌满
        await sleep(CHUNK_MS)
      }
    } catch (error) {
      console.warn('流式合成失败:', error)
      throw error
    } finally {
      if (tempFile) void rm(tempFile, { force: true }).catch(() => undefined)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}


