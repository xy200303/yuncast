import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PROGRAM_AUDIO_CONFIG,
  DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
  type Program,
  type ProgramInput,
  type Script,
  type ScriptInput,
  type ScriptScene
} from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 剧本与节目（docs/01 §4 剧本/剧情线；docs/10 §9 节目化）。
 * 剧本 = 场景序列（开场→痛点→讲解→互动→催单→收尾）；节目绑定剧本，
 * 当前节目持久化在 config.live.activeProgramId；场景推进进度落在 programs.current_scene_idx（断播能续）。
 */
export class ScriptService {
  constructor(private readonly storage: StorageService) {}

  // ---------- 剧本 ----------

  listScripts(): Script[] {
    return this.storage.scriptList()
  }

  getScript(id: string | null | undefined): Script | null {
    if (!id) return null
    return this.storage.scriptList().find((s) => s.id === id) ?? null
  }

  saveScript(input: ScriptInput, id?: string): Script {
    if (!input.title.trim()) throw new Error('剧本名不能为空')
    if (input.scenes.length === 0) throw new Error('剧本至少要有一场')
    const existing = id ? this.getScript(id) : null
    const script: Script = {
      id: id ?? `sc-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      title: input.title.trim(),
      theme: input.theme.trim(),
      scenes: input.scenes.map((scene, i) => ({
        ...scene,
        id: scene.id || `scene-${i + 1}`,
        estDurationMin: Math.max(1, scene.estDurationMin || 5)
      })),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.storage.scriptSave(script)
    return script
  }

  deleteScript(id: string): void {
    // 绑定该剧本的节目先解绑
    for (const program of this.storage.programList()) {
      if (program.scriptId === id) this.storage.programSave({ ...program, scriptId: null, updatedAt: Date.now() })
    }
    this.storage.scriptDelete(id)
  }

  // ---------- 节目 ----------

  listPrograms(): Program[] {
    return this.storage.programList()
  }

  saveProgram(input: ProgramInput, id?: string, expectedUpdatedAt?: number): Program {
    if (!input.name.trim()) throw new Error('节目名称不能为空')
    const existing = id ? (this.storage.programList().find((p) => p.id === id) ?? null) : null
    assertFresh(expectedUpdatedAt, existing?.updatedAt, `节目「${existing?.name ?? ''}」`)
    const program: Program = {
      id: id ?? `prog-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      name: input.name.trim(),
      theme: input.theme.trim(),
      contentType: input.contentType,
      broadcastMode: input.broadcastMode,
      finishMode: input.finishMode,
      allowLiveEvents: input.allowLiveEvents !== false,
      enabledTriggerIds: [...new Set((input.enabledTriggerIds ?? []).map((t) => t.trim()).filter(Boolean))],
      audioConfig: { ...DEFAULT_PROGRAM_AUDIO_CONFIG, ...input.audioConfig },
      scriptId: input.scriptId,
      currentSceneIdx: existing?.currentSceneIdx ?? 0,
      knowledgeScope: { ...DEFAULT_PROGRAM_KNOWLEDGE_SCOPE, ...input.knowledgeScope },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.storage.programSave(program)
    return program
  }

  deleteProgram(id: string): void {
    this.storage.programDelete(id)
    // 节目的持久对话（会话 entries + 对话时间线）跟着节目一起走
    this.storage.deleteProgramSession(id)
    this.storage.timelineClear(id)
    if (this.storage.getConfig().live.activeProgramId === id) this.setActiveProgram('')
  }

  /**
   * 剧本元信息保存（save_script 工具的后端）：新建（允许空场景，场景后补）或改名/改主题。
   * 与 saveScript 分工：saveScript 是全场景编辑（UI 表单用，校验至少一场），这里只管名称/主题。
   */
  saveScriptMeta(input: { title: string; theme?: string }, id?: string, expectedUpdatedAt?: number): Script {
    if (!input.title.trim()) throw new Error('剧本名不能为空')
    const existing = id ? this.getScript(id) : null
    if (id && !existing) throw new Error('剧本不存在（可能已被删除）：用 list_scripts 拿正确的 id')
    assertFresh(expectedUpdatedAt, existing?.updatedAt, `剧本「${existing?.title ?? ''}」`)
    const script: Script = {
      id: id ?? `sc-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      title: input.title.trim(),
      theme: (input.theme ?? existing?.theme ?? '').trim(),
      scenes: existing?.scenes ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.storage.scriptSave(script)
    return script
  }

  /** 场景排序（reorder_scenes 工具的后端）：orderedIds 必须恰好是全部场景 id 的一个排列 */
  reorderScenes(scriptId: string, orderedIds: string[], expectedUpdatedAt?: number): Script {
    const script = this.getScript(scriptId)
    if (!script) throw new Error('剧本不存在：用 list_scripts 拿正确的 id')
    assertFresh(expectedUpdatedAt, script.updatedAt, `剧本「${script.title}」`)
    const ids = orderedIds.map((id) => id.trim()).filter(Boolean)
    if (new Set(ids).size !== ids.length) throw new Error('顺序列表里有重复的场景 id')
    if (ids.length !== script.scenes.length || !script.scenes.every((s) => ids.includes(s.id))) {
      throw new Error(`顺序列表必须恰好包含全部 ${script.scenes.length} 个场景的 id（先用 get_script 拿当前场景列表）`)
    }
    const scenes = ids.map((id) => script.scenes.find((s) => s.id === id)!)
    this.storage.scriptSave({ ...script, scenes, updatedAt: Date.now() })
    return this.getScript(scriptId)!
  }

  /** 节目触发器绑定（set_program_triggers 工具的后端）：只存启用项，触发器定义在全局库；id 必须先存在于全局库 */
  setProgramTriggers(programId: string, triggerIds: string[], expectedUpdatedAt?: number): Program {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) throw new Error('节目不存在：用 list_programs 拿正确的 id')
    assertFresh(expectedUpdatedAt, program.updatedAt, `节目「${program.name}」`)
    const ids = [...new Set(triggerIds.map((t) => t.trim()).filter(Boolean))]
    const known = new Set(this.storage.triggerList().map((t) => t.id))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(`这些触发器 id 不在全局触发器库：${unknown.join('、')}（先用 list_triggers 拿正确的 id）`)
    }
    const next: Program = { ...program, enabledTriggerIds: ids, updatedAt: Date.now() }
    this.storage.programSave(next)
    return next
  }

  /** 设为当前节目（持久化进 config；空串 = 取消选择） */
  setActiveProgram(id: string): void {
    this.storage.setConfig({ live: { activeProgramId: id } })
  }

  /** 当前节目 + 它的剧本（主播启动时注入 system prompt 用） */
  getActive(): { program: Program | null; script: Script | null } {
    const id = this.storage.getConfig().live.activeProgramId
    const program = id ? (this.storage.programList().find((p) => p.id === id) ?? null) : null
    return { program, script: this.getScript(program?.scriptId) }
  }

  // ---------- 场景推进（主播 advance_scene 工具的后端） ----------

  /** 当前场景（含进度），无剧本/无节目返回 null */
  currentScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { program, script } = this.getActive()
    if (!program || !script || script.scenes.length === 0) return null
    const index = Math.min(program.currentSceneIdx, script.scenes.length - 1)
    return { scene: script.scenes[index], index, total: script.scenes.length }
  }

  /** 推进到下一场景并落库；已经是最后一场返回 null（收尾/循环由主播自己判断） */
  advanceScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { program, script } = this.getActive()
    if (!program || !script || script.scenes.length === 0) return null
    const next = program.currentSceneIdx + 1
    if (next >= script.scenes.length) return null
    this.storage.programSetSceneIdx(program.id, next)
    return { scene: script.scenes[next], index: next, total: script.scenes.length }
  }

  /** 跳转到指定场景（goto_scene 工具 / 播控台切场景按钮的后端）；越界返回 null */
  gotoScene(idx: number): { scene: ScriptScene; index: number; total: number } | null {
    const { program, script } = this.getActive()
    if (!program || !script || script.scenes.length === 0) return null
    if (idx < 0 || idx >= script.scenes.length) return null
    this.storage.programSetSceneIdx(program.id, idx)
    return { scene: script.scenes[idx], index: idx, total: script.scenes.length }
  }

  /** 场景进度复位（重新开播时可用） */
  resetScene(programId: string): void {
    this.storage.programSetSceneIdx(programId, 0)
  }

  // ---------- 主播自编剧本（create_scene/update_scene/remove_scene 工具的后端） ----------

  /**
   * 确保节目绑着一本剧本：没绑就现场建一本「主播自编」并绑上。
   * 主播自己编排场景序列用——节目可以不预绑剧本，主播开播/备稿时自己搭架子。
   */
  ensureProgramScript(programId: string): { program: Program; script: Script; created: boolean } {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) throw new Error('节目不存在')
    const bound = this.getScript(program.scriptId)
    if (bound) return { program, script: bound, created: false }
    const script: Script = {
      id: `sc-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      title: `${program.name} · 主播自编`,
      theme: program.theme,
      scenes: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.storage.scriptSave(script)
    this.storage.programSave({ ...program, scriptId: script.id, updatedAt: Date.now() })
    return { program, script, created: true }
  }

  /** 加一场（position 省略 = 追加到末尾；序号从 1 数起）。返回新场景和全场序列 */
  appendScene(
    programId: string,
    scene: { title: string; goal: string; keyPoints: string; estDurationMin?: number },
    position?: number
  ): { script: Script; index: number; total: number } {
    const { script } = this.ensureProgramScript(programId)
    if (!scene.title.trim()) throw new Error('场景名不能为空')
    const scenes = [...script.scenes]
    const insertAt =
      position === undefined
        ? scenes.length
        : Math.min(Math.max(Math.floor(position) - 1, 0), scenes.length)
    // id 不跟序号走（插删后不重号）：取现有最大数字 +1
    const maxId = scenes.reduce((max, s) => {
      const m = /^scene-(\d+)$/.exec(s.id)
      return m ? Math.max(max, Number(m[1])) : max
    }, 0)
    scenes.splice(insertAt, 0, {
      id: `scene-${maxId + 1}`,
      title: scene.title.trim(),
      goal: scene.goal.trim(),
      keyPoints: scene.keyPoints.trim(),
      estDurationMin: Math.max(1, Math.round(scene.estDurationMin ?? 5))
    })
    this.saveScript({ title: script.title, theme: script.theme, scenes }, script.id)
    return { script: this.getScript(script.id)!, index: insertAt, total: scenes.length }
  }

  /** 改某一场（序号从 1 数起）；只传要改的字段 */
  updateScene(
    programId: string,
    index: number,
    patch: { title?: string; goal?: string; keyPoints?: string; estDurationMin?: number }
  ): { script: Script; index: number; total: number } {
    const { script } = this.ensureProgramScript(programId)
    const i = Math.floor(index) - 1
    if (i < 0 || i >= script.scenes.length) throw new Error(`没有第 ${index} 场（现在共 ${script.scenes.length} 场）`)
    const scenes = script.scenes.map((s, at) =>
      at === i
        ? {
            ...s,
            title: patch.title?.trim() || s.title,
            goal: patch.goal?.trim() ?? s.goal,
            keyPoints: patch.keyPoints?.trim() ?? s.keyPoints,
            estDurationMin:
              patch.estDurationMin !== undefined ? Math.max(1, Math.round(patch.estDurationMin)) : s.estDurationMin
          }
        : s
    )
    this.saveScript({ title: script.title, theme: script.theme, scenes }, script.id)
    return { script: this.getScript(script.id)!, index: i, total: scenes.length }
  }

  /** 删某一场（序号从 1 数起）；当前进度在被删场之后则回退一格 */
  removeScene(programId: string, index: number): { script: Script; total: number } {
    const { program, script } = this.ensureProgramScript(programId)
    const i = Math.floor(index) - 1
    if (i < 0 || i >= script.scenes.length) throw new Error(`没有第 ${index} 场（现在共 ${script.scenes.length} 场）`)
    const scenes = script.scenes.filter((_, at) => at !== i)
    // 删到空剧本允许（主播自编可能推倒重来）：saveScript 校验至少要有一场，空序列直接落库
    if (scenes.length === 0) {
      this.storage.scriptSave({ ...script, scenes: [], updatedAt: Date.now() })
    } else {
      this.saveScript({ title: script.title, theme: script.theme, scenes }, script.id)
    }
    if (program.currentSceneIdx > i) this.storage.programSetSceneIdx(programId, program.currentSceneIdx - 1)
    return { script: this.getScript(script.id)!, total: scenes.length }
  }
}

/**
 * 版本冲突检查（docs/10 §10.3.5 并发保护）：Agent 写入带着它读到时的 updatedAt，
 * 与库里的不一致说明用户/别处刚改过——拒绝保存并附当前版本号，让调用方重新读取后再改，不静默覆盖。
 */
function assertFresh(expectedUpdatedAt: number | undefined, current: number | undefined, what: string): void {
  if (expectedUpdatedAt === undefined) return
  if (current !== expectedUpdatedAt) {
    throw new Error(
      `保存冲突：${what}在你读取后刚被改过（当前版本号 ${current ?? 0}）。先重新读取，再带新的版本号重试，不要强行覆盖`
    )
  }
}
