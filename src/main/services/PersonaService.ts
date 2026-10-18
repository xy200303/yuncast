import type { Persona } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 主播卡服务（docs/REDESIGN §2 主播团）。
 * 主播卡是纯数据卡（人设口吻 + 嗓音），没有大脑——想的事全归导演（directorConfig）。
 * 没有「当前出镜」这个全局指针：一场出谁由节目卡司（personaIds）决定，
 * 没配卡司就由导演逐条用 personaId 指定；speak 不传 personaId 时用节目卡司第一张的嗓音。
 */
export class PersonaService {
  /** 人设卡变更（保存/删除）：index.ts 接上 → 广播给所有窗口，agent/MCP 改动也能即时刷新界面 */
  onChanged: ((personaId: string) => void) | null = null

  constructor(private readonly storage: StorageService) {}

  /** 主播团：全部主播卡（空库就是空——没有「默认卡」这种东西，出谁由节目卡司决定） */
  list(): Persona[] {
    return this.storage.personaList()
  }

  /** 保存：带 id 更新，不带则新建一张。id 只认参数：input 里混进来的 id 不生效。
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
      id: id ?? `persona-${Date.now().toString(36)}`,
      updatedAt: Date.now()
    }
    this.storage.personaSave(persona)
    this.onChanged?.(persona.id)
    return persona
  }

  remove(id: string): void {
    this.storage.personaDelete(id)
    this.onChanged?.(id)
  }

  /** 节目卡司（没定卡司 = 全部主播卡都是候选人）：写稿时告诉导演手上有人设 */
  programPersonas(): Persona[] {
    return this.programPersonasOf(this.activeProgram()?.id ?? '')
  }

  /** 指定节目的卡司：合成/预检必须按**目标节目**解析，不能依赖"当前选中节目" */
  programPersonasOf(programId: string): Persona[] {
    const all = this.storage.personaList()
    const program = programId ? (this.storage.programList().find((item) => item.id === programId) ?? null) : null
    const ids = program?.personaIds ?? []
    return ids.length > 0 ? ids.map((id) => all.find((item) => item.id === id)).filter((x): x is Persona => Boolean(x)) : all
  }

  /** 节目卡司里显式配置的第一张卡（没配卡司 = null，不存在全局默认卡） */
  leadPersonaOf(programId: string): Persona | null {
    const program = this.storage.programList().find((item) => item.id === programId)
    const id = program?.personaIds[0]
    if (!id) return null
    return this.storage.personaList().find((item) => item.id === id) ?? null
  }

  leadPersona(): Persona | null {
    const id = this.activeProgram()?.id
    return id ? this.leadPersonaOf(id) : null
  }

  /** 指定节目的默认嗓音：卡司第一张（合成/预检用，目标节目优先） */
  programVoiceOf(programId: string): string {
    // 只认节目卡司里显式配置的卡；没配卡司就是空——不存在「全局默认卡」兜底
    const program = this.storage.programList().find((item) => item.id === programId)
    const ids = program?.personaIds ?? []
    if (ids.length === 0) return ''
    const all = this.storage.personaList()
    for (const id of ids) {
      const voice = all.find((item) => item.id === id)?.voiceId?.trim()
      if (voice) return voice
    }
    return ''
  }

  /** 当前节目的卡司第一张嗓音（展示/触发器用；合成请用 programVoiceOf(programId)） */
  programVoice(): string {
    return this.programVoiceOf(this.activeProgram()?.id ?? '')
  }

  /** 生效音色：显式指定（底稿上标记的 / 合成弹窗选的）> 卡司第一张。都没有 = undefined（调用方必须报错） */
  resolveProgramVoice(voice?: string): string | undefined {
    return voice?.trim() || this.programVoice() || undefined
  }

  private activeProgram(): ReturnType<StorageService['programList']>[number] | null {
    const activeProgramId = this.storage.getConfig().live.activeProgramId
    if (!activeProgramId) return null
    return this.storage.programList().find((item) => item.id === activeProgramId) ?? null
  }
}
