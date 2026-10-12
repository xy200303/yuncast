import { create } from 'zustand'
import {
  APP_ACCENTS,
  APP_THEMES,
  DEFAULT_CONFIG,
  INITIAL_STREAM_STATS,
  llmReady,
  ttsProviderConfigured,
  type AgentStatus,
  type AppAccent,
  type AppConfig,
  type AppTheme,
  type ConnectorStatus,
  type ModelConnectionSafe,
  type PartialDeep,
  type Persona,
  type PoolSnapshot,
  type TtsConnectionSafe,
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

/** 服务商清单的纯数据形态：类型从 preload 暴露的 API 反推，渲染层不 import 主进程模块 */
export type LlmProviderManifest = Awaited<ReturnType<typeof window.api.providers.llmList>>[number]
/** 语音合成服务商清单（能力位 + 配置字段） */
export type TtsProviderManifest = Awaited<ReturnType<typeof window.api.providers.ttsList>>[number]
/** manifest 驱动的配置字段（LLM 与 TTS 的 configFields 结构相同） */
export type ProviderFieldSpec = LlmProviderManifest['configFields'][number]

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

  /** 供应商接入 + 服务商清单（设置 → 语言模型；状态栏徽章与主播卡的「大脑」下拉都读它） */
  connections: ModelConnectionSafe[]
  llmProviders: LlmProviderManifest[]
  /** 语音合成服务商清单（设置 → 语音合成表单与音色分组都读它） */
  ttsProviders: TtsProviderManifest[]
  /** 语音合成的供应商接入（一家一条）：音色提示、筛选标记都按「这条接入在不在」判断 */
  ttsConnections: TtsConnectionSafe[]
  /** 当前主播卡（状态栏的 LLM 徽章按它选的接入与模型判定） */
  persona: Persona | null
  loadModelLibrary: () => Promise<void>
  /** 接入库变了就调它：当前主播卡引用的接入可能已失效，徽章要跟着变 */
  refreshPersona: () => Promise<void>
  setConnections: (connections: ModelConnectionSafe[]) => void
  setTtsConnections: (connections: TtsConnectionSafe[]) => void
  setPersona: (persona: Persona | null) => void
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
  setVoices: (voices) => set({ voices }),

  connections: [],
  llmProviders: [],
  ttsProviders: [],
  ttsConnections: [],
  persona: null,
  loadModelLibrary: async () => {
    if (!('api' in window)) return
    const [connections, llmProviders, ttsProviders, ttsConnections, persona] = await Promise.all([
      window.api.model.list(),
      window.api.providers.llmList(),
      window.api.providers.ttsList(),
      window.api.tts.connections(),
      window.api.persona.get()
    ])
    set({ connections, llmProviders, ttsProviders, ttsConnections, persona })
  },
  refreshPersona: async () => {
    if (!('api' in window)) return
    set({ persona: await window.api.persona.get() })
  },
  setConnections: (connections) => set({ connections }),
  setTtsConnections: (ttsConnections) => set({ ttsConnections }),
  setPersona: (persona) => set({ persona })
}))

/** TTS 是否已配置（状态栏徽章用）：默认服务商那条接入配齐了才算 */
export function selectTtsReady(
  config: AppConfig,
  connections: TtsConnectionSafe[]
): boolean {
  return ttsProviderConfigured(connections, config.tts.providerId)
}

/** 当前主播卡的语言模型是否就绪（状态栏徽章用）：卡上选的接入与模型都可用才算 */
export function selectLlmReady(
  connections: ModelConnectionSafe[],
  persona: Persona | null | undefined
): boolean {
  return llmReady(connections, persona)
}

/** 服务商显示名（拿不到 manifest 就退回 id） */
export function providerLabel(providers: LlmProviderManifest[], providerId: string): string {
  return providers.find((item) => item.id === providerId)?.label ?? providerId
}

/** 接入实际用的模型（默认模型 → 列表第一个 → 服务商默认模型），与主进程的取用口径一致 */
export function effectiveModel(
  connection: ModelConnectionSafe,
  providers: LlmProviderManifest[]
): string {
  if (connection.defaultModel) return connection.defaultModel
  return (
    connection.models[0] ??
    providers.find((item) => item.id === connection.providerId)?.defaultModel ??
    ''
  )
}
