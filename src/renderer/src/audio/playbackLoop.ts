import { audioEngine } from './engine'

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
    this.kick()
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
      if (!item?.audioPath) {
        await this.wait(IDLE_WAIT_MS)
        continue
      }
      await audioEngine.playTts(item.audioPath)
      if (!this.running) break
      await window.api.pool.markDone(item.id)
    }
  }
}

export const playbackLoop = new PlaybackLoop()
