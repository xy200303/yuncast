import { create } from 'zustand'
import type { DraftUnit, PoolItem } from '../../../shared/types'

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

// v2：默认改成「双显」，换键让老用户也吃到新默认（旧 v1 里存的 target 不再生效）
const PREFS_KEY = 'yuncast.live.prefs:v2'

type Prefs = { displayMode: DisplayMode; density: Density }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '')
    if (raw?.displayMode && raw?.density) return raw as Prefs
  } catch {
    // 没存过或存坏了：用默认
  }
  return { displayMode: 'both', density: 'comfortable' }
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
  /** 未开播时展示的底稿（开播前就是"待播内容"） */
  drafts: DraftUnit[]
  history: PoolItem[]
  historyLoading: boolean
  displayMode: DisplayMode
  density: Density
  setDisplayMode: (mode: DisplayMode) => void
  setDensity: (density: Density) => void
  /** 拉最近已播（切回直播台/开播后调用；失败不抛，界面按空历史处理） */
  loadHistory: (count?: number) => Promise<void>
  /** 拉节目底稿（未开播时卡片流与水位条都看它） */
  loadDrafts: (programId: string) => Promise<void>
}

export const useLiveStore = create<LiveState>((set, get) => ({
  drafts: [],
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
  loadDrafts: async (programId) => {
    if (!('api' in window) || !programId) {
      set({ drafts: [] })
      return
    }
    try {
      set({ drafts: await window.api.draftUnit.list(programId) })
    } catch {
      set({ drafts: [] })
    }
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

/** 本场卡片流的一行：位置固定跟着稿子，播放状态跟着池 */
export type CardRow = {
  item: PoolItem
  played: boolean
  /** 未开播时这一行对应的话术库条目（改稿改它，不是改话术池） */
  draft?: DraftUnit
}

/**
 * 稿子位置：卡片流按它排序，播放怎么跳（上一段/循环）都不会改写列表顺序。
 * 章级条目（预制场景单元）落在该章第一段的位置。
 */
function scriptRanks(drafts: DraftUnit[]): { byDraft: Map<string, number>; byScene: Map<string, number> } {
  const byDraft = new Map<string, number>()
  const byScene = new Map<string, number>()
  drafts.forEach((draft, index) => {
    byDraft.set(draft.id, index)
    if (draft.sceneId && !byScene.has(draft.sceneId)) byScene.set(draft.sceneId, index)
  })
  return { byDraft, byScene }
}

/** 一条池条目的稿子位置；-1 = 稿子里找不到（现场插话、评论回复这类） */
function rankOf(
  item: PoolItem,
  ranks: { byDraft: Map<string, number>; byScene: Map<string, number> }
): number {
  if (item.originDraftUnitId) {
    const index = ranks.byDraft.get(item.originDraftUnitId)
    if (index !== undefined) return index
  }
  const key = item.dedupeKey ?? ''
  if (key.startsWith('rendered:scene:')) {
    const index = ranks.byScene.get(key.slice('rendered:scene:'.length))
    if (index !== undefined) return index
  }
  return -1
}

/** 去重键：同一段稿子在「已播历史」和「未播队列」里各出现一次时只留一条（队列优先） */
function rowKey(item: PoolItem): string {
  return item.dedupeKey || item.originDraftUnitId || item.id
}

/**
 * 本场卡片流：历史 + 队列合成一列，按稿子顺序排。
 * 以前按「历史在前、队列在后」拼，播完一轮回卷后同一批稿子会重新出现在下面、序号整体改写；
 * 现在位置只由稿子决定，循环/上一段只改这一行的状态。
 */
export function mergeRows(history: PoolItem[], queue: PoolItem[], drafts: DraftUnit[] = []): CardRow[] {
  const ranks = scriptRanks(drafts)
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]))
  const rows = new Map<string, CardRow>()
  for (const item of [...history, ...queue]) {
    const key = rowKey(item)
    const draft = item.originDraftUnitId ? draftById.get(item.originDraftUnitId) : undefined
    const next: CardRow = { item, played: item.status === 'done', draft }
    const prev = rows.get(key)
    // 队列里还有这条（没播完/刚回卷）就以队列为准，历史那份是上一轮的
    if (!prev || prev.played) rows.set(key, next)
  }
  const anchor = (row: CardRow): number => {
    const index = rankOf(row.item, ranks)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...rows.values()].sort(
    (a, b) => anchor(a) - anchor(b) || a.item.createdAt - b.item.createdAt
  )
}
