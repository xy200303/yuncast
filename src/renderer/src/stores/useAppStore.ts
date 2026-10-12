import { create } from 'zustand'
import {
  APP_ACCENTS,
  APP_THEMES,
  DEFAULT_CONFIG,
  INITIAL_STREAM_STATS,
  llmConfigured,
  ttsConfigured,
  type AgentStatus,
  type AppAccent,
  type AppConfig,
  type AppTheme,
  type ConnectorStatus,
  type PartialDeep,
  type PoolSnapshot,
  type VoiceRecord,
  type StreamStats
} from '../../../shared/types'
import {
  applyAppearance,
  readCachedAccent,
  readCachedTheme,
  resolveAppTheme,
  type ResolvedAppTheme
} from '../theme/applyAppearance'

/** 五个导航页（设置是全局弹窗，不在页面流里）。key 同时用作路由和 store 状态。 */
export const NAV_PAGES = ['live', 'sessions', 'anchors', 'knowledge', 'voices', 'stats'] as const
export type NavPage = (typeof NAV_PAGES)[number]

// 启动时先用 localStorage 缓存的主题，避免等 IPC 回来闪一下白/黑
const bootTheme = readCachedTheme()
const bootAccent = readCachedAccent()

interface AppState {
  page: NavPage
  setPage: (page: NavPage) => void

  /** 设置弹窗开关（设置不是页面，是全局弹窗，对齐 TermPilot） */
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  theme: AppTheme
  accent: AppAccent
  resolvedApp: ResolvedAppTheme
  setTheme: (theme: AppTheme) => Promise<void>
  setAccent: (accent: AppAccent) => Promise<void>
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

  /** 推流状态（主进程广播驱动） */
  stream: StreamStats
  setStream: (stats: StreamStats) => void

  /** 平台连接器状态 */
  connector: ConnectorStatus
  setConnector: (status: ConnectorStatus) => void

  /** 音色库（主进程广播驱动，训练状态实时更新） */
  voices: VoiceRecord[]
  setVoices: (voices: VoiceRecord[]) => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  page: 'live',
  setPage: (page) => set({ page }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  theme: bootTheme,
  accent: bootAccent,
  resolvedApp: resolveAppTheme(bootTheme),

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme, resolvedApp: applyAppearance(theme, get().accent) })
    try {
      const saved = await window.api.config.set({ theme })
      set({ theme: saved.theme, resolvedApp: applyAppearance(saved.theme, saved.accent) })
    } catch (error) {
      set({ theme: prev, resolvedApp: applyAppearance(prev, get().accent) })
      throw error
    }
  },

  setAccent: async (accent) => {
    const prev = get().accent
    set({ accent })
    applyAppearance(get().theme, accent)
    try {
      const saved = await window.api.config.set({ accent })
      set({ accent: saved.accent })
      applyAppearance(saved.theme, saved.accent)
    } catch (error) {
      set({ accent: prev })
      applyAppearance(get().theme, prev)
      throw error
    }
  },

  syncSystemTheme: () => {
    if (get().theme !== 'system') return
    set({ resolvedApp: applyAppearance(get().theme, get().accent, false) })
  },

  config: DEFAULT_CONFIG,
  loadConfig: async () => {
    const config = await window.api.config.get()
    const theme = APP_THEMES.find((id) => id === config.theme) ?? DEFAULT_CONFIG.theme
    const accent = APP_ACCENTS.find((id) => id === config.accent) ?? DEFAULT_CONFIG.accent
    set({ config, theme, accent, resolvedApp: applyAppearance(theme, accent) })
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

  stream: INITIAL_STREAM_STATS,
  setStream: (stream) => set({ stream }),

  connector: { state: 'idle', port: 8102, receivedCount: 0 },
  setConnector: (connector) => set({ connector }),

  voices: [],
  setVoices: (voices) => set({ voices })
}))

/** TTS 是否已配置（状态栏徽章用） */
export function selectTtsReady(config: AppConfig): boolean {
  return ttsConfigured(config.tts)
}

/** LLM 是否已配置（状态栏徽章用） */
export function selectLlmReady(config: AppConfig): boolean {
  return llmConfigured(config.llm)
}
