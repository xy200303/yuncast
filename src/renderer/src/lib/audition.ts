import { create } from 'zustand'
import { toast } from 'sonner'
import { stripSpeechTags } from '../../../shared/speechTags'
import { useAppStore } from '../stores/useAppStore'

/**
 * 全局唯一试听（docs/11 第二部分）：段卡片/话术池/节目页/场次记录共用这一条。
 * 出声走主进程 aux 槽（不打断主播播报、不进推流）；状态只有一份，UI 是 App 级的 AuditionBar。
 *
 * 内部约定：
 * - 每条试听的 itemId 由这里生成（preview-audition-N），audio:end 按它精确收尾——
 *   顶掉上一条时旧会话的 end 事件带旧 id，不会误清当前状态；
 * - 暂停/继续走 audio.pauseAux（主进程 aux 槽用户级暂停）；
 * - 页面切换自动停（页面常驻不卸载，靠订阅 useAppStore.page 变化）。
 */

export interface AuditionState {
  /** 当前试听条目的调用方 key（unit:scene:xx / speech:xx / session:xx…），空 = 没在试听 */
  key: string
  title: string
  audioPath: string
  playing: boolean
  paused: boolean
}

export const useAuditionStore = create<AuditionState>(() => ({
  key: '',
  title: '',
  audioPath: '',
  playing: false,
  paused: false
}))

let itemSeq = 0
/** 当前试听会话的 itemId：end 事件只认它，顶掉旧试听时旧 id 的 end 不清新状态 */
let currentItemId = ''
let wired = false

function clear(): void {
  currentItemId = ''
  useAuditionStore.setState({ key: '', title: '', audioPath: '', playing: false, paused: false })
}

function wire(): void {
  if (wired || typeof window === 'undefined' || !('api' in window)) return
  wired = true
  window.api.audio.onEnd((payload) => {
    if (payload.itemId && payload.itemId === currentItemId) clear()
  })
  useAppStore.subscribe((state, prev) => {
    if (state.page !== prev.page) audition.stop()
  })
}

export const audition = {
  /** 点同一条 = 暂停/继续；点别的 = 顶掉当前 */
  toggle({ key, title, audioPath }: { key: string; title: string; audioPath: string }): void {
    wire()
    const state = useAuditionStore.getState()
    if (state.playing && state.key === key) {
      const paused = !state.paused
      useAuditionStore.setState({ paused })
      void window.api.audio.pauseAux(paused)
      return
    }
    const itemId = `preview-audition-${++itemSeq}`
    currentItemId = itemId
    useAuditionStore.setState({ key, title, audioPath, playing: true, paused: false })
    void window.api.audio.playFile(audioPath, itemId).then((result) => {
      if (!result.ok && currentItemId === itemId) {
        clear()
        toast.error('试听失败', { description: result.error ?? '音频文件打不开（可能已被移动或清理）' })
      }
    })
  },
  stop(): void {
    if (!useAuditionStore.getState().playing) return
    void window.api.audio.stopAux()
    clear()
  }
}

/** 试听条标题：正文前 20 字截断（与 audioUnits 的段标题同一口径） */
export function auditionTitle(text: string): string {
  const clean = stripSpeechTags(text).trim()
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean
}
