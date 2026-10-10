/** main / preload / renderer 三方共用的基本类型 */

/** 应用界面主题：浅色、深色，或跟着系统。 */
export const APP_THEMES = ['light', 'dark', 'system'] as const
export type AppTheme = (typeof APP_THEMES)[number]

/** 持久化到 userData/config.json 的应用配置。M1 只有主题，后续里程碑往里加。 */
export interface AppConfig {
  theme: AppTheme
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system'
}

export function parseAppConfig(input: unknown): AppConfig {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return { theme: APP_THEMES.find((id) => id === row.theme) ?? DEFAULT_CONFIG.theme }
}

/** app.info() 返回的应用信息 */
export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}
