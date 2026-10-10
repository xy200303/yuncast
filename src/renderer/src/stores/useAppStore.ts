import { create } from 'zustand'
import {
  APP_THEMES,
  DEFAULT_CONFIG,
  llmConfigured,
  ttsConfigured,
  type AgentStatus,
  type AppConfig,
  type AppTheme,
  type PartialDeep,
  type PoolSnapshot
} from '../../../shared/types'
import { applyAppearance, readCachedTheme, resolveAppTheme, type ResolvedAppTheme } from '../theme/applyAppearance'

/** 五个导航页（设置是全局弹窗，不在页面流里）。key 同时用作路由和 store 状态。 */
export const NAV_PAGES = ['live', 'anchors', 'knowledge', 'sessions', 'stats'] as const
export type NavPage = (typeof NAV_PAGES)[number]

// 启动时先用 localStorage 缓存的主题，避免等 IPC 回来闪一下白/黑
const bootTheme = readCachedTheme()

interface AppState {
  page: NavPage
  setPage: (page: NavPage) => void

  /** 设置弹窗开关（设置不是页面，是全局弹窗，对齐 TermPilot） */
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  theme: AppTheme
  resolvedApp: ResolvedAppTheme
  setTheme: (theme: AppTheme) => Promise<void>
  syncSystemTheme: () => void

  config: AppConfig
  loadConfig: () => Promise<void>
  saveConfig: (patch: PartialDeep<AppConfig>) => Promise<void>

  /** 话术池快照（主进程广播驱动） */
  pool: PoolSnapshot
  setPool: (snapshot: PoolSnapshot) => void

  /** 播放循环开关 */
  loopRunning: boolean
  setLoopRunning: (running: boolean) => void

  /** 音频引擎电平 */
  levels: { tts: number; master: number }
  setLevels: (levels: { tts: number; master: number }) => void

  /** 主播 Agent 状态（含生成中预览 draft） */
  agent: AgentStatus
  setAgent: (status: AgentStatus) => void

  /** 评论模拟器开关 */
  simRunning: boolean
  setSimRunning: (running: boolean) => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  page: 'live',
  setPage: (page) => set({ page }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  theme: bootTheme,
  resolvedApp: resolveAppTheme(bootTheme),

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme, resolvedApp: applyAppearance(theme) })
    try {
      const saved = await window.api.config.set({ theme })
      set({ theme: saved.theme, resolvedApp: applyAppearance(saved.theme) })
    } catch (error) {
      set({ theme: prev, resolvedApp: applyAppearance(prev) })
      throw error
    }
  },

  syncSystemTheme: () => {
    if (get().theme !== 'system') return
    set({ resolvedApp: applyAppearance(get().theme, false) })
  },

  config: DEFAULT_CONFIG,
  loadConfig: async () => {
    const config = await window.api.config.get()
    const theme = APP_THEMES.find((id) => id === config.theme) ?? DEFAULT_CONFIG.theme
    set({ config, theme, resolvedApp: applyAppearance(theme) })
  },

  saveConfig: async (patch) => {
    const prev = get().config
    const saved = await window.api.config.set(patch)
    set({ config: saved })
    if (saved.theme !== prev.theme) {
      set({ theme: saved.theme, resolvedApp: applyAppearance(saved.theme) })
    }
  },

  pool: { items: [], failed: [] },
  setPool: (pool) => set({ pool }),

  loopRunning: false,
  setLoopRunning: (loopRunning) => set({ loopRunning }),

  levels: { tts: 0, master: 0 },
  setLevels: (levels) => set({ levels }),

  agent: { state: 'stopped', draft: '' },
  setAgent: (agent) => set({ agent }),

  simRunning: false,
  setSimRunning: (simRunning) => set({ simRunning })
}))

/** TTS 是否已配置（状态栏徽章用） */
export function selectTtsReady(config: AppConfig): boolean {
  return ttsConfigured(config.tts)
}

/** LLM 是否已配置（状态栏徽章用） */
export function selectLlmReady(config: AppConfig): boolean {
  return llmConfigured(config.llm)
}
