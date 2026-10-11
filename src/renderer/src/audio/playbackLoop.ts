import { audioEngine } from './engine'
import { streamPlayer } from './streamPlayer'

/**
 * 播放循环（渲染进程，话术池的唯一消费者）。
 * 循环：取池里播出顺序上第一个 ready 条目 → audioEngine 播放 → 播完回报 markDone。
 * 没有 ready 条目就睡眠等快照事件唤醒（池里来了新话术 / 合成完成都会广播）。
 * 直推混音器（FFmpeg）M2 不做，音频只出本机声卡。
 */

const IDLE_WAIT_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class PlaybackLoop {
  private running = false
  private waker: (() => void) | null = null

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    audioEngine.stopCurrentTts()
    streamPlayer.stop()
    this.kick()
  }

  /** 流式播放一条话术：主进程按真实速率推 PCM，首块到达即出声 */
  private async playStream(itemId: string, text: string, voiceId?: string): Promise<void> {
    const sessionId = `stream-${itemId}`
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        offChunk()
        offEnd()
        // 等已排队的音频播完（若被 stop 打断则立即返回）
        const remainMs = streamPlayer.end()
        if (!this.running || remainMs <= 0) resolve()
        else setTimeout(resolve, remainMs)
      }
      const offChunk = window.api.ttsStream.onChunk((payload) => {
        if (payload.sessionId !== sessionId) return
        streamPlayer.push(
          new Int16Array(payload.pcm.buffer, payload.pcm.byteOffset, payload.pcm.byteLength / 2),
          payload.sampleRate
        )
      })
      const offEnd = window.api.ttsStream.onEnd((payload) => {
        if (payload.sessionId !== sessionId) return
        if (payload.error) console.warn('流式合成失败:', payload.error)
        finish()
      })
      void window.api.ttsStream.start(sessionId, text, voiceId)
    })
  }

  /** 池快照更新时叫醒循环，不用等满一个睡眠周期 */
  kick(): void {
    this.waker?.()
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
      let item
      try {
        item = await window.api.pool.next()
      } catch {
        await sleep(IDLE_WAIT_MS)
        continue
      }
      if (!this.running) {
        // 停了但刚取出条目：还回去不至于——标 done 会骗人，让它留在 playing 由下次重启清理
        break
      }
      if (!item) {
        await this.wait(IDLE_WAIT_MS)
        continue
      }

      // 实时合成条目：不读文件，由主进程流式推 PCM，这里边收边排播
      if (item.stream && !item.audioPath) {
        await this.playStream(item.id, item.text, item.voiceId || undefined)
        if (!this.running) break
        await window.api.pool.markDone(item.id)
        continue
      }

      if (!item.audioPath) {
        await this.wait(IDLE_WAIT_MS)
        continue
      }
      // 直推模式下音频还要进主进程混音器（没在推流时主进程直接丢弃）
      void window.api.stream.pushTts(item.audioPath)
      await audioEngine.playTts(item.audioPath)
      if (!this.running) break
      await window.api.pool.markDone(item.id)
    }
  }
}

export const playbackLoop = new PlaybackLoop()
