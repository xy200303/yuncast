import { APP_THEMES, DEFAULT_CONFIG, type AppTheme } from '../../../shared/types'

const CACHE_KEY = 'agent-anchor.appearance'

export type ResolvedAppTheme = 'light' | 'dark'

export function resolveAppTheme(app: AppTheme): ResolvedAppTheme {
  if (app === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return app
}

export function readCachedTheme(): AppTheme {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return DEFAULT_CONFIG.theme
    const theme = (JSON.parse(raw) as { theme?: unknown }).theme
    return APP_THEMES.find((id) => id === theme) ?? DEFAULT_CONFIG.theme
  } catch {
    return DEFAULT_CONFIG.theme
  }
}

/** 立刻切 <html> 的 dark class。persist 为真时记下这次选择，下次启动先用它，避免闪一下。 */
export function applyAppearance(theme: AppTheme, persist = true): ResolvedAppTheme {
  const resolved = resolveAppTheme(theme)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
  if (persist) localStorage.setItem(CACHE_KEY, JSON.stringify({ theme }))
  return resolved
}
