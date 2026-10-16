import { DEFAULT_PERSONA, type Persona } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 主播卡服务（docs/REDESIGN §2 主播团）。
 * 主播卡是纯数据卡（人设口吻 + 嗓音），没有大脑——想的事全归导演（directorConfig）。
 * 库里没有就播种默认卡；保存即更新，改动经「资产已变」黄条显式重开会话后生效。
 */
export class PersonaService {
  constructor(private readonly storage: StorageService) {}

  /** 取当前主播卡，不存在就播种内置默认卡 */
  get(): Persona {
    const existing = this.storage.personaGet()
    if (existing) return existing
    const seeded: Persona = {
      id: 'anchor-default',
      ...DEFAULT_PERSONA,
      updatedAt: Date.now()
    }
    this.storage.personaSave(seeded)
    return seeded
  }

  /** 主播团：全部主播卡 */
  list(): Persona[] {
    const list = this.storage.personaList()
    if (list.length > 0) return list
    this.get() // 空库播种默认卡
    return this.storage.personaList()
  }

  /** 保存：带 id 更新，不带则新建一张（新建不自动设为当前——静默换主播会让正在跑的会话风格/嗓音/用量归属错位；
   *  人要新卡上场走 setActive 或渲染端显式调用）。id 只认参数：input 里混进来的 id 不生效。
   *  expectedUpdatedAt：并发保护（docs/10 §10.3.5）——与库里的 updatedAt 不一致说明刚被别处改过，拒绝覆盖 */
  save(input: Omit<Persona, 'id' | 'updatedAt'>, id?: string, expectedUpdatedAt?: number): Persona {
    if (id && expectedUpdatedAt !== undefined) {
      const current = this.storage.personaList().find((p) => p.id === id)
      if (current && current.updatedAt !== expectedUpdatedAt) {
        throw new Error(
          `保存冲突：主播卡「${current.name}」在你读取后刚被改过（当前版本号 ${current.updatedAt}）。先重新读取，再带新的版本号重试，不要强行覆盖`
        )
      }
    }
    const persona: Persona = {
      ...input,
      id: id ?? `anchor-${Date.now().toString(36)}`,
      updatedAt: Date.now()
    }
    this.storage.personaSave(persona)
    return persona
  }

  /** 设为当前主播卡（现场 say 不传 role 时的嗓音与风格卡） */
  setActive(id: string): Persona | null {
    this.storage.personaSetActive(id)
    return this.storage.personaGet()
  }

  /** 删除；删掉的是当前主播卡时自动改指到剩余的第一张 */
  remove(id: string): void {
    const wasActive = this.storage.personaGet()?.id === id
    this.storage.personaDelete(id)
    if (wasActive) {
      const rest = this.storage.personaList()
      const next = rest[0]
      if (next) this.storage.personaSetActive(next.id)
    }
  }

  /** 本场生效的音色：显式指定（底稿上标记的 / 合成弹窗选的）> 当前主播卡音色。预合成与开播装载共用同一判定 */
  resolveProgramVoice(voice?: string): string | undefined {
    return voice?.trim() || this.get().voiceId || undefined
  }

  /** 节目卡司里的卡（没定卡司 = 全部主播卡都是候选人）：写稿时告诉导演手上有人设 */
  programCast(): Persona[] {
    const activeProgramId = this.storage.getConfig().live.activeProgramId
    const program = activeProgramId
      ? this.storage.programList().find((item) => item.id === activeProgramId)
      : null
    const all = this.storage.personaList()
    const ids = program?.presenterIds ?? []
    return ids.length > 0 ? ids.map((id) => all.find((item) => item.id === id)).filter((x): x is Persona => Boolean(x)) : all
  }
}
