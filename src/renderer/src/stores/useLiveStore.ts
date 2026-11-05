import { create } from 'zustand'
import type { PoolItem } from '../../../shared/types'

/**
 * 直播台（工作台）的界面状态。
 *
 * 为什么要单独一个 store：以前这些都塞在 1800 行的 LivePage 里（useState 十几个），
 * 切页不卸载、事件订阅和派生数据混在一起，改一处经常牵连另一处。
 * 这里只放**本场界面状态**：
 * - history：已播条目（池快照只给未播，历史要靠 pool.recent-played 拉一次）
 * - displayMode / density：显示偏好（跨场记住）
 * 池快照本身仍归 useAppStore（全局一条广播流），避免两处真值。
 */

export type DisplayMode = 'target' | 'zh' | 'both'
export type Density = 'comfortable' | 'compact'

const PREFS_KEY = 'yuncast.live.prefs:v1'

type Prefs = { displayMode: DisplayMode; density: Density }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '')
    if (raw?.displayMode && raw?.density) return raw as Prefs
  } catch {
    // 没存过或存坏了：用默认
  }
  return { displayMode: 'target', density: 'comfortable' }
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 存不下就算了，不影响播放
  }
}

interface LiveState {
  /** 已播条目（新→旧，展示时再倒过来） */
  history: PoolItem[]
  historyLoading: boolean
  displayMode: DisplayMode
  density: Density
  setDisplayMode: (mode: DisplayMode) => void
  setDensity: (density: Density) => void
  /** 拉最近已播（切回直播台/开播后调用；失败不抛，界面按空历史处理） */
  loadHistory: (count?: number) => Promise<void>
}

export const useLiveStore = create<LiveState>((set, get) => ({
  history: [],
  historyLoading: false,
  ...readPrefs(),
  setDisplayMode: (displayMode) => {
    set({ displayMode })
    writePrefs({ displayMode, density: get().density })
  },
  setDensity: (density) => {
    set({ density })
    writePrefs({ displayMode: get().displayMode, density })
  },
  loadHistory: async (count = 30) => {
    if (!('api' in window)) return
    set({ historyLoading: true })
    try {
      const items = await window.api.pool.recentPlayed(count)
      set({ history: items })
    } catch {
      set({ history: [] })
    } finally {
      set({ historyLoading: false })
    }
  }
}))

/** 本场卡片流的一行：历史在前（旧→新）、队列在后 */
export type CardRow = { item: PoolItem; played: boolean }

export function mergeRows(history: PoolItem[], queue: PoolItem[]): CardRow[] {
  const played = [...history].reverse().map((item) => ({ item, played: true }))
  // 历史与队列理论上不重叠，但播完那一刻两者可能各有一份：按 id 去重，队列优先
  const seen = new Set(queue.map((item) => item.id))
  return [...played.filter((row) => !seen.has(row.item.id)), ...queue.map((item) => ({ item, played: false }))]
}
