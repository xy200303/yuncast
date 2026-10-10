import { create } from 'zustand'
import { APP_THEMES, DEFAULT_CONFIG, type AppTheme } from '../../../shared/types'
import { applyAppearance, readCachedTheme, resolveAppTheme, type ResolvedAppTheme } from '../theme/applyAppearance'

/** 六个导航页。key 同时用作路由和 store 状态。 */
export const NAV_PAGES = ['live', 'anchors', 'knowledge', 'sessions', 'stats', 'settings'] as const
export type NavPage = (typeof NAV_PAGES)[number]

// 启动时先用 localStorage 缓存的主题，避免等 IPC 回来闪一下白/黑
const bootTheme = readCachedTheme()

interface AppState {
  page: NavPage
  setPage: (page: NavPage) => void
  theme: AppTheme
  resolvedApp: ResolvedAppTheme
  loadConfig: () => Promise<void>
  setTheme: (theme: AppTheme) => Promise<void>
  syncSystemTheme: () => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  page: 'live',
  theme: bootTheme,
  resolvedApp: resolveAppTheme(bootTheme),

  setPage: (page) => set({ page }),

  loadConfig: async () => {
    const config = await window.api.config.get()
    const theme = APP_THEMES.find((id) => id === config.theme) ?? DEFAULT_CONFIG.theme
    set({ theme, resolvedApp: applyAppearance(theme) })
  },

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
  }
}))
