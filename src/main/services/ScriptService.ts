import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
  type Program,
  type ProgramInput,
  type Script,
  type ScriptScene
} from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 剧本与节目（docs/01 §4 剧本/剧情线；docs/10 §9 节目化）。
 * 剧本 = 场景序列（开场→痛点→讲解→互动→催单→收尾）；节目绑定剧本，
 * 当前节目持久化在 config.live.activeProgramId；场景推进进度落在 programs.current_scene_idx（断播能续）。
 */
export class ScriptService {
  /**
   * 场景内容被 Agent 改动后的回调（appendScene/updateScene/removeScene）：
   * index.ts 接到 DraftUnitService.refreshRenderedStaleness，让改稿入口触发预制音频的 stale 检测
   */
  onContentChanged: ((programId: string) => void) | null = null

  /**
   * 节目配置落库后的回调（saveProgram / 卡司、白名单、互动总闸等都在里面）：
   * index.ts 接到 AgentService.refreshProgramGate，让播出中改的自动响应白名单/互动总闸立即生效
   */
  onProgramsChanged: ((programId: string) => void) | null = null

  /**
   * 剧本被写后的统一通知：绑它的节目要做预制资产 stale 检测（onContentChanged），
   * 界面刷新由 storage.onDataChanged('programs') 兜底，这里只负责「引擎侧要不要重算」
   */
  constructor(private readonly storage: StorageService) {}

  // ---------- 编排（Scenes，已并入节目：不再有独立剧本资产，UI/工具只认节目） ----------

  /** 某节目的编排（场景序列）；节目还没编排过返回空数组（不是"剧本不存在"） */
  /** 编排视图：给沿用 Script 形状的老调用方（音频单元、导出）用，id = 节目 id */
  planOf(program: Program): Script {
    return {
      id: program.id,
      title: `${program.name} · 编排`,
      theme: program.theme,
      scenes: program.plan.scenes,
      createdAt: program.createdAt,
      updatedAt: program.updatedAt
    }
  }

  getScript(programId: string | null | undefined): Script | null {
    if (!programId) return null
    const program = this.storage.programList().find((p) => p.id === programId)
    return program ? this.planOf(program) : null
  }

  scenesOf(programId: string): ScriptScene[] {
    return this.storage.programList().find((p) => p.id === programId)?.plan.scenes ?? []
  }

  /**
   * 保存某节目的编排（场景序列）：节目没有编排载体时就地建一个，
   * 名字固定为「节目名 · 编排」——用户不需要再给编排起名，也没有"剧本库"可去翻。
   */
  saveScenes(programId: string, scenes: ScriptScene[]): ScriptScene[] {
    const program = this.storage.programList().find((p) => p.id === programId)
    if (!program) throw new Error('节目不存在')
    this.storage.programSave({ ...program, plan: { scenes }, updatedAt: Date.now() })
    this.onContentChanged?.(programId)
    this.onProgramsChanged?.(programId)
    return scenes
  }

  /**
   * 清理孤儿编排（一键迁移用）：没人引用的剧本导出成 JSON 后删除，返回 { exported, removed }。
   * 自动建剧本留下的垃圾就是从这里清的。
   */
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
      // 新节目默认全勾内建（已启用）触发器，用户之后可在开播确认页/节目编辑里减掉（docs/REDESIGN §7）
      enabledTriggerIds: existing
        ? [...new Set((input.enabledTriggerIds ?? []).map((t) => t.trim()).filter(Boolean))]
        : (input.enabledTriggerIds?.length
            ? [...new Set(input.enabledTriggerIds.map((t) => t.trim()).filter(Boolean))]
            : this.storage.triggerList().filter((t) => t.enabled).map((t) => t.id)),
      personaIds: [...new Set((input.personaIds ?? []).map((p) => p.trim()).filter(Boolean))],
      instruction: input.instruction?.trim() || undefined,
      language: input.language ?? existing?.language ?? 'auto',
      plan: input.plan ?? existing?.plan ?? { scenes: [] },
      currentSceneIdx: existing?.currentSceneIdx ?? 0,
      knowledgeScope: { ...DEFAULT_PROGRAM_KNOWLEDGE_SCOPE, ...input.knowledgeScope },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.storage.programSave(program)
    // 播出中也允许改（自动响应白名单 / 互动总闸 / 卡司）：配置一变就刷新引擎侧接线，不必等下播
    this.onProgramsChanged?.(program.id)
    return program
  }

  deleteProgram(id: string): void {
    this.storage.programDelete(id)
    // 节目的持久对话（会话 entries + 对话时间线）跟着节目一起走
    this.storage.deleteProgramSession(id)
    this.storage.timelineClear(id)
    if (this.storage.getConfig().live.activeProgramId === id) this.setActiveProgram('')
    // agent/MCP 删节目后界面也要刷新（setActiveProgram('') 已通知一次，这里补 id 删除场景）
    this.onProgramsChanged?.(id)
  }

  /**
   * 剧本元信息保存（save_script 工具的后端）：新建（允许空场景，场景后补）或改名/改主题。
   * 与 saveScript 分工：saveScript 是全场景编辑（UI 表单用，校验至少一场），这里只管名称/主题。
   */
  /** 场景排序：orderedIds 必须恰好是全部场景 id 的一个排列 */
  reorderScenes(programId: string, orderedIds: string[], expectedUpdatedAt?: number): Script {
    const program = this.storage.programList().find((p) => p.id === programId)
    if (!program) throw new Error('节目不存在')
    assertFresh(expectedUpdatedAt, program.updatedAt, `节目「${program.name}」编排`)
    const base = program.plan.scenes
    const ids = orderedIds.map((id) => id.trim()).filter(Boolean)
    if (ids.length !== base.length || !base.every((scene) => ids.includes(scene.id))) {
      throw new Error(`顺序列表必须恰好包含全部 ${base.length} 个场景的 id（先用 scene_list 拿当前场景列表）`)
    }
    const scenes = ids.map((id) => base.find((scene) => scene.id === id)!)
    this.saveScenes(programId, scenes)
    return this.getScript(programId)!
  }

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
    this.onProgramsChanged?.(programId)
    return next
  }

  /** 设为当前节目（持久化进 config；空串 = 取消选择） */
  setActiveProgram(id: string): void {
    this.storage.setConfig({ live: { activeProgramId: id } })
    // 界面要立刻跟着切（agent/MCP 调 program_activate 时也走这里）
    this.onProgramsChanged?.(id)
  }

  /** 当前节目 + 它的剧本（主播启动时注入 system prompt 用） */
  getActive(): { program: Program | null; script: Script | null } {
    const id = this.storage.getConfig().live.activeProgramId
    const program = id ? (this.storage.programList().find((p) => p.id === id) ?? null) : null
    return { program, script: program ? this.planOf(program) : null }
  }

  // ---------- 场景推进（主播 advance_scene 工具的后端） ----------

  /** 当前场景（含进度），无剧本/无节目返回 null */
  currentScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { program } = this.getActive()
    const scenes = program?.plan.scenes ?? []
    if (!program || scenes.length === 0) return null
    const index = Math.min(program.currentSceneIdx, scenes.length - 1)
    return { scene: scenes[index], index, total: scenes.length }
  }

  /** 推进到下一场景并落库；已经是最后一场返回 null（收尾/循环由主播自己判断） */
  advanceScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { program } = this.getActive()
    const scenes = program?.plan.scenes ?? []
    if (!program || scenes.length === 0) return null
    const next = program.currentSceneIdx + 1
    if (next >= scenes.length) return null
    this.storage.programSetSceneIdx(program.id, next)
    return { scene: scenes[next], index: next, total: scenes.length }
  }

  /** 跳转到指定场景（goto_scene 工具 / 直播台切场景按钮的后端）；越界返回 null */
  gotoScene(idx: number): { scene: ScriptScene; index: number; total: number } | null {
    const { program } = this.getActive()
    const scenes = program?.plan.scenes ?? []
    if (!program || scenes.length === 0) return null
    if (idx < 0 || idx >= scenes.length) return null
    this.storage.programSetSceneIdx(program.id, idx)
    return { scene: scenes[idx], index: idx, total: scenes.length }
  }

  // ---------- 预制音频（Scene.rendered，docs/10 §9.6） ----------

  /**
   * 写/清某场景的整章预制音频引用（存在 scripts.scenes JSON 内）。
   * 走 storage 的专用通道（带 blob 引用钩子）；不动 updatedAt：预制产物更新不是用户编辑剧本，不该触发版本冲突误判。
   */
  setSceneRendered(programId: string, sceneId: string, rendered: ScriptScene['rendered'] | null): void {
    const program = this.storage.programList().find((p) => p.id === programId)
    if (!program) return
    const scenes = program.plan.scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, ...(rendered ? { rendered } : { rendered: undefined }) } : scene
    )
    this.storage.programSave({ ...program, plan: { scenes }, updatedAt: Date.now() })
  }

  // ---------- 主播自编剧本（create_scene/update_scene/remove_scene 工具的后端） ----------

  /**
   * 确保节目绑着一本剧本：没绑就现场建一本「主播自编」并绑上。
   * 主播自己编排场景序列用——节目可以不预绑剧本，主播开播/备稿时自己搭架子。
   */
  appendScene(
    programId: string,
    scene: { title: string; goal: string; keyPoints: string; estDurationMin?: number },
    position?: number
  ): { script: Script; index: number; total: number } {
    const script = this.getScript(programId)
    if (!scene.title.trim()) throw new Error('场景名不能为空')
    const scenes: ScriptScene[] = [...(script?.scenes ?? [])]
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
    this.saveScenes(programId, scenes)
    return { script: this.getScript(programId)!, index: insertAt, total: scenes.length }
  }

  /** 改某一场（序号从 1 数起）；只传要改的字段 */
  updateScene(
    programId: string,
    index: number,
    patch: { title?: string; goal?: string; keyPoints?: string; estDurationMin?: number }
  ): { script: Script; index: number; total: number } {
    const script = this.getScript(programId)
    const base: ScriptScene[] = script?.scenes ?? []
    const i = Math.floor(index) - 1
    if (!script || i < 0 || i >= base.length) throw new Error(`没有第 ${index} 场（现在共 ${base.length} 场）`)
    const scenes = base.map((s, at) =>
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
    this.saveScenes(programId, scenes)
    return { script: this.getScript(programId)!, index: i, total: scenes.length }
  }

  /** 删某一场（序号从 1 数起）；当前进度在被删场之后则回退一格 */
  removeScene(programId: string, index: number): { script: Script; total: number } {
    const program = this.storage.programList().find((p) => p.id === programId)
    const script = this.getScript(programId)
    const base: ScriptScene[] = script?.scenes ?? []
    const i = Math.floor(index) - 1
    if (!program || i < 0 || i >= base.length) throw new Error(`没有第 ${index} 场（现在共 ${base.length} 场）`)
    // 被删场挂着预制音频的，释放 blob 引用（scriptSave 是通用整存，不过钩子，这里显式补）
    const removedPath = base[i].rendered?.audioPath
    if (removedPath) this.storage.onAudioPathChange?.('scene_rendered', base[i].id, removedPath, null)
    const scenes = base.filter((_, at) => at !== i)
    // 删到空剧本允许（主播自编可能推倒重来）：saveScript 校验至少要有一场，空序列直接落库
    this.saveScenes(programId, scenes)
    if (program.currentSceneIdx > i) this.storage.programSetSceneIdx(programId, program.currentSceneIdx - 1)
    return { script: this.getScript(programId)!, total: scenes.length }
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
