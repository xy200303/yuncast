import type { SpeechItem } from '../../../shared/types'
import type { SpeechPool } from '../SpeechPool'
import type { TtsStreamService } from '../TtsStreamService'
import type { AudioPipeline, PlayResult } from './AudioPipeline'

/**
 * 播放循环（**主进程**，话术池的唯一消费者）。
 *
 * 以前这条循环在渲染层：取池里的 ready 条目 → 渲染层用 `<audio>` 播 → 回报 markDone。
 * 音频归一后它搬到这里：主进程取条目 → AudioPipeline 解码/排播（同时喂推流与本机监听）→ 播完 markDone。
 * 渲染层不再参与播放调度，只把管路推来的 PCM 丢给声卡。
 *
 * 循环语义与迁移前保持一致：没有 ready 条目就睡眠等快照事件唤醒（kick）。
 */

const IDLE_WAIT_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class PlaybackLoop {
  private running = false
  private waker: (() => void) | null = null
  /** 正在播的条目 id：被打断时退回 ready，别让它永远卡在「播报中」 */
  private current: string | null = null

  constructor(
    private readonly pool: SpeechPool,
    private readonly ttsStream: () => TtsStreamService | null,
    private readonly pipeline: AudioPipeline,
    /** 桥段间留白（毫秒，读 config.live.bitGapMs）：下一条是正常/兜底车道才留，插播不等 */
    private readonly gapMs: () => number = () => 0
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** 暂停/结束场次：停播报 + 把正在播的这条退回 ready（恢复后从头重播） */
  stop(): void {
    const interrupted = this.current
    this.current = null
    this.running = false
    // 先掐音频，再掐流式合成（同步还在跑的合成），否则它会把剩下的 PCM 继续推过来
    this.pipeline.stopAll()
    this.ttsStream()?.stopAll()
    if (interrupted) this.pool.requeue(interrupted)
    this.kick()
  }

  setRunning(running: boolean): void {
    if (running) this.start()
    else this.stop()
  }

  /** 池快照更新时叫醒循环，不用等满一个睡眠周期 */
  kick(): void {
    this.waker?.()
  }

  dispose(): void {
    this.running = false
    this.current = null
    this.pipeline.stopAll()
    this.ttsStream()?.stopAll()
    this.kick()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waker = null
        resolve()
      }, ms)
      this.waker = () => {
        clearTimeout(timer)
        this.waker = null
        resolve()
      }
    })
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let item: SpeechItem | null
      try {
        item = this.pool.next()
      } catch (error) {
        console.warn('[播放] 取件失败：', error instanceof Error ? error.message : String(error))
        await sleep(IDLE_WAIT_MS)
        continue
      }
      if (!this.running) break
      if (!item) {
        await this.wait(IDLE_WAIT_MS)
        continue
      }
      this.current = item.id

      const result = await this.play(item)
      // stop() 已经把这条退回 ready 了，别再改它的状态
      if (!this.running) break
      if (result.ok) this.pool.markDone(item.id)
      else if (result.stopped) this.pool.markDone(item.id)
      else this.pool.markFailed(item.id, result.error ?? '播放失败')
      this.current = null
      // 桥段间留白：播完一条正常/兜底内容后留口气（真人主播段与段之间有停顿）。
      // 下一条是插播/打断车道（回评论/急事）不等；池子有任何变化（新话术进来）都会提前叫醒
      if (result.ok) {
        const gap = this.gapMs()
        const next = gap > 0 ? this.pool.peek() : null
        if (next && (next.lane === 'normal' || next.lane === 'filler')) {
          await this.wait(gap)
          if (!this.running) break
        }
      }
    }
  }

  private async play(item: SpeechItem): Promise<PlayResult> {
    // 实时合成条目：不读文件，由 TtsStreamService 边合成边推 PCM，管线边收边播
    if (item.stream && !item.audioPath) {
      const service = this.ttsStream()
      if (!service) return { ok: false, error: '流式合成服务不可用' }
      const session = this.pipeline.beginStream(item.id, { slot: 'main' })
      void service.start(
        `stream-${item.id}`,
        item.speechText || item.text,
        item.voiceId || undefined,
        {
          onChunk: (pcm, sampleRate) => session.push(pcm, sampleRate),
          onEnd: () => session.end(),
          onError: (error) => session.fail(error)
        },
        item.delivery
      )
      return session.done
    }

    if (!item.audioPath) {
      return { ok: false, error: '这条话术没有音频文件，也没有可流式合成的文本' }
    }
    const request = this.pipeline.playFile(item.id, item.audioPath, { slot: 'main' })
    return request.done
  }
}
