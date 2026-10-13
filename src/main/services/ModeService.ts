import { randomUUID } from 'node:crypto'
import { BUILTIN_MODES, DEFAULT_MODE_ID, type LiveMode, type LiveModeInput } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 直播模式（三层架构的「模式层」）：数据化预设包 = 事件接线 + 角色定位提示词模块 + 节奏预设。
 * 基座工具层不含「该怎么播」的意志，怎么播由模式包决定；内容本身仍是 agent 自编自导。
 * - 内置模式随代码发布：启动时按 id 整行覆盖播种（用户在库里改不动它们，要改复制一份）
 * - 自定义模式自由增删改；场次只存 modeId，运行时现查——改模式对所有用它的场次生效（重开会话）
 */
export class ModeService {
  private cache: LiveMode[] = []

  constructor(private readonly storage: StorageService) {
    this.seedBuiltins()
    this.reload()
  }

  /** 内置模式整行覆盖播种：内置包的内容是代码资产，跟着版本升级；用户想要自己的版本就复制 */
  private seedBuiltins(): void {
    for (const input of BUILTIN_MODES) {
      this.storage.modeSave({ ...input, builtIn: true, updatedAt: Date.now() })
    }
  }

  private reload(): void {
    this.cache = this.storage.modeList()
  }

  list(): LiveMode[] {
    return this.cache
  }

  get(id: string): LiveMode | null {
    return this.cache.find((m) => m.id === id) ?? null
  }

  /** 解析场次该用的模式：没选/选了已删的都回落到默认互动模式（兜底再落第一个内置包） */
  resolve(modeId: string | null | undefined): LiveMode {
    return (
      this.get(modeId || DEFAULT_MODE_ID) ??
      this.get(DEFAULT_MODE_ID) ??
      this.cache.find((m) => m.builtIn) ??
      this.cache[0]
    )
  }

  /** 保存自定义模式（内置模式不许原地改——改内置请复制一份） */
  save(input: LiveModeInput, id?: string): LiveMode {
    if (!input.name.trim()) throw new Error('模式名称不能为空')
    if (id) {
      const existing = this.get(id)
      if (!existing) throw new Error('模式不存在')
      if (existing.builtIn) throw new Error('内置模式不能原地改，复制一份再改')
    }
    const mode: LiveMode = {
      id: id ?? `mode-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      name: input.name.trim(),
      description: input.description.trim(),
      wiring: { ...input.wiring },
      promptModule: input.promptModule,
      builtIn: false,
      updatedAt: Date.now()
    }
    this.storage.modeSave(mode)
    this.reload()
    return mode
  }

  /** 复制一份（内置模式的主要定制入口）：新模式是普通自定义模式 */
  duplicate(id: string): LiveMode {
    const source = this.get(id)
    if (!source) throw new Error('模式不存在')
    return this.save({
      name: `${source.name} 副本`,
      description: source.description,
      wiring: { ...source.wiring },
      promptModule: source.promptModule
    })
  }

  /** 删自定义模式；引用它的场次运行时自动回落默认模式 */
  remove(id: string): void {
    const mode = this.get(id)
    if (!mode) return
    if (mode.builtIn) throw new Error('内置模式不能删除')
    this.storage.modeDelete(id)
    this.reload()
  }

  /** 模式内容指纹：改模式 = 改了主播的演法，活着的会话要标「资产已变」（重开会话生效） */
  fingerprint(modeId: string | null | undefined): string {
    const mode = this.resolve(modeId)
    return JSON.stringify([mode.id, mode.wiring, mode.promptModule])
  }
}
