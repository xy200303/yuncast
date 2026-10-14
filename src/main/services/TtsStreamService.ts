import { rm } from 'node:fs/promises'
import { decodeToPcm } from './stream/ffmpeg/mixer'
import type { SynthPerformance, TtsService } from './TtsService'

/**
 * 实时 TTS 流式合成服务（M9）。
 *
 * 目标：话术不再"整段合成完才播"，而是**边合成边播**，把首包延迟从「整段合成时间」压到「首块到达时间」。
 *
 * 这一层只负责"产出 PCM 块"（s16le **单声道 48k**）：谁来播、按什么速率播、怎么混 BGM 都在
 * 主进程 AudioPipeline（本机监听 + 推流同一份 PCM）。所以这里不再自己 sleep 节流。
 *
 * 两条取数路径：
 * 1. 供应商真流式（百炼 SSE）：按服务端返回的块往外吐（采样率由模型参数决定，管线负责重采样）。
 * 2. 其余（火山整段合成 / 模型未开放流式）：整段合成到缓存 → ffmpeg 解码成 PCM → 切成块吐出。
 *    管线仍是流式的（首块到达即出声）。
 * 换成供应商流式接口只需替换 `streamChunks()` 的取数方式，下游一行不用改。
 */

/** 每块的音频时长：100ms（与混音器帧率对齐，块越小首包越快） */
const CHUNK_MS = 100
const SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000

export interface TtsStreamSession {
  sessionId: string
  /** 收到一块 PCM（s16le mono；采样率见第二个参数） */
  onChunk: (pcm: Buffer, sampleRate: number) => void
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

  /** 开始一次流式合成；返回 sessionId。chunk 以 onChunk 回调吐出，节奏按真实播放速率。
   *  perf：这次合成专用的演法（agent 的 say delivery/rate/pitch），按模型能力生效 */
  async start(
    sessionId: string,
    text: string,
    voiceId: string | undefined,
    handlers: Omit<TtsStreamSession, 'sessionId'>,
    perf?: SynthPerformance
  ): Promise<void> {
    const abort = new AbortController()
    this.sessions.set(sessionId, { abort })

    let firstChunkSent = false
    try {
      for await (const chunk of this.streamChunks(text, voiceId, abort.signal, perf)) {
        if (abort.signal.aborted) break
        if (!firstChunkSent) {
          firstChunkSent = true
          handlers.onFirstChunk?.()
        }
        handlers.onChunk(chunk.pcm, chunk.sampleRate)
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
   * 产出 PCM 块流（s16le 单声道；采样率随块给出）。
   * 速率节流由 AudioPipeline 负责：这里只管尽快把解码结果交出去。
   */
  private async *streamChunks(
    text: string,
    voiceId: string | undefined,
    signal: AbortSignal,
    perf?: SynthPerformance
  ): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    // 路由到百炼且模型标了 streaming 的音色直接用它的 SSE 真流式（接口已按官方文档核实）
    const route = this.tts.routeForVoice(voiceId)
    if (route.provider === 'bailian' && route.model.streaming && route.connection.realtime) {
      yield* this.tts.synthesizeBailianStream(text, voiceId, signal, perf)
      return
    }
    // 其余情况（火山整段合成 / 模型未开放流式）：整段合成 → 解码 → 切块
    yield* this.chunkedFallback(text, voiceId, signal, perf)
  }

  private async *chunkedFallback(
    text: string,
    voiceId: string | undefined,
    signal: AbortSignal,
    perf?: SynthPerformance
  ): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    let tempFile = ''
    try {
      // 一次合成到缓存（将来这里换成服务商流式读取循环，下游不变）
      tempFile = await this.tts.synthesize(`stream-${Date.now()}`, text, voiceId, signal, perf)
      if (signal.aborted) return
      // 解码成管线口径（48k 单声道），不在这里节流
      const pcm = await decodeToPcm(tempFile, { channels: 1 })
      for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
        if (signal.aborted) return
        yield { pcm: pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)), sampleRate: SAMPLE_RATE }
      }
    } catch (error) {
      console.warn('流式合成失败:', error)
      throw error
    } finally {
      if (tempFile) void rm(tempFile, { force: true }).catch(() => undefined)
    }
  }
}


