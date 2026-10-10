import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, parseAppConfig, type AppConfig } from '../../shared/types'

/**
 * 应用配置的持久化。一个 JSON 文件（userData/config.json）够了，
 * 等配置多到要按表查的时候再换 sqlite。
 */
export class StorageService {
  private readonly file: string
  private config: AppConfig
  private listeners = new Set<(config: AppConfig) => void>()

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json')
    this.config = this.load()
  }

  private load(): AppConfig {
    try {
      if (!existsSync(this.file)) return { ...DEFAULT_CONFIG }
      return parseAppConfig(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      console.error('[AgentAnchor] 读取配置失败，用默认值:', error)
      return { ...DEFAULT_CONFIG }
    }
  }

  getConfig(): AppConfig {
    return this.config
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key]
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): AppConfig {
    this.config = { ...this.config, [key]: value }
    this.save()
    for (const listener of this.listeners) listener(this.config)
    return this.config
  }

  /** 配置变了就回调（主进程里用来同步窗口 chrome） */
  onChange(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf8')
    } catch (error) {
      console.error('[AgentAnchor] 写入配置失败:', error)
    }
  }
}
