import {
  APP_ACCENTS,
  APP_ACCENT_META,
  APP_THEMES,
  DEFAULT_CONFIG,
  type AppAccent,
  type AppTheme
} from '../../../shared/types'

// 键带版本号：日后存的形状变了直接换 v2，旧值读不出来就回落默认值，不会崩
const CACHE_KEY = 'yuncast.appearance:v1'
// 旧的无版本键和旧品牌键都做读取兜底，老用户升级/换名后配色不丢；写只写新键
const LEGACY_CACHE_KEYS = ['yuncast.appearance', 'agent-anchor.appearance']

export type ResolvedAppTheme = 'light' | 'dark'

export function resolveAppTheme(app: AppTheme): ResolvedAppTheme {
  if (app === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return app
}

interface CachedAppearance {
  theme: AppTheme
  accent: AppAccent
}

function readCache(): CachedAppearance {
  const fallback: CachedAppearance = { theme: DEFAULT_CONFIG.theme, accent: DEFAULT_CONFIG.accent }
  try {
    const raw =
      localStorage.getItem(CACHE_KEY) ??
      LEGACY_CACHE_KEYS.map((key) => localStorage.getItem(key)).find((value) => value !== null) ??
      null
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { theme?: unknown; accent?: unknown }
    return {
      theme: APP_THEMES.find((id) => id === parsed.theme) ?? fallback.theme,
      accent: APP_ACCENTS.find((id) => id === parsed.accent) ?? fallback.accent
    }
  } catch {
    return fallback
  }
}

export function readCachedTheme(): AppTheme {
  return readCache().theme
}

export function readCachedAccent(): AppAccent {
  return readCache().accent
}

/** 把配色主题写进 CSS 变量（--primary / --sidebar-primary / --brand 同源） */
export function applyAccent(accent: AppAccent, resolved: ResolvedAppTheme): void {
  const meta = APP_ACCENT_META[accent] ?? APP_ACCENT_META.clay
  const color = resolved === 'dark' ? meta.dark : meta.light
  const root = document.documentElement
  root.style.setProperty('--primary', color)
  root.style.setProperty('--sidebar-primary', color)
  root.style.setProperty('--brand', color)
}

/** 立刻切 <html> 的 dark class 与配色变量。persist 为真时记下这次选择，下次启动先用它，避免闪一下。 */
export function applyAppearance(theme: AppTheme, accent?: AppAccent, persist = true): ResolvedAppTheme {
  const resolved = resolveAppTheme(theme)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
  const effectiveAccent = accent ?? readCache().accent
  applyAccent(effectiveAccent, resolved)
  if (persist) localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, accent: effectiveAccent }))
  return resolved
}
