import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PLAN_GEN_CONFIG,
  DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  DEFAULT_PLANNED_MINUTES,
  MIN_PLANNED_MINUTES,
  type LivePlan,
  type LivePlanInput,
  type Script,
  type ScriptInput,
  type ScriptScene
} from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 剧本与场次（docs/01 §4 剧本/剧情线、§5 场次页）。
 * 剧本 = 场景序列（开场→痛点→讲解→互动→催单→收尾）；场次绑定剧本，
 * 当前场次持久化在 config.live.activePlanId；场景推进进度落在 live_plans.current_scene_idx（断播能续）。
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
    // 绑定该剧本的场次先解绑
    for (const plan of this.storage.planList()) {
      if (plan.scriptId === id) this.storage.planSave({ ...plan, scriptId: null, updatedAt: Date.now() })
    }
    this.storage.scriptDelete(id)
  }

  // ---------- 场次 ----------

  listPlans(): LivePlan[] {
    return this.storage.planList()
  }

  savePlan(input: LivePlanInput, id?: string): LivePlan {
    if (!input.name.trim()) throw new Error('场次名称不能为空')
    // 场次必须绑主播：音色/人格/模型都跟人设卡走，没有「用当前主播」这种模糊态
    if (!input.personaId) throw new Error('场次必须绑定主播人设卡')
    const existing = id ? (this.storage.planList().find((p) => p.id === id) ?? null) : null
    const planned = Math.round(Number(input.plannedMinutes))
    const plan: LivePlan = {
      id: id ?? `plan-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      name: input.name.trim(),
      theme: input.theme.trim(),
      personaId: input.personaId ?? null,
      styleHint: input.styleHint?.trim() ?? '',
      modeId: input.modeId?.trim() ?? '',
      // 下限保护：低于 5 分钟的「预设」没有推算意义（一场至少得有几条底稿）
      plannedMinutes: Math.max(
        MIN_PLANNED_MINUTES,
        Number.isFinite(planned) && planned > 0 ? planned : DEFAULT_PLANNED_MINUTES
      ),
      scriptId: input.scriptId,
      currentSceneIdx: existing?.currentSceneIdx ?? 0,
      genConfig: { ...DEFAULT_PLAN_GEN_CONFIG, ...input.genConfig },
      knowledgeScope: { ...DEFAULT_PLAN_KNOWLEDGE_SCOPE, ...input.knowledgeScope },
      voiceId: input.voiceId?.trim() ?? '',
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.storage.planSave(plan)
    return plan
  }

  deletePlan(id: string): void {
    this.storage.planDelete(id)
    if (this.storage.getConfig().live.activePlanId === id) this.setActivePlan('')
  }

  /** 设为当前场次（持久化进 config；空串 = 取消选择） */
  setActivePlan(id: string): void {
    this.storage.setConfig({ live: { activePlanId: id } })
  }

  /** 当前场次 + 它的剧本（主播启动时注入 system prompt 用） */
  getActive(): { plan: LivePlan | null; script: Script | null } {
    const id = this.storage.getConfig().live.activePlanId
    const plan = id ? (this.storage.planList().find((p) => p.id === id) ?? null) : null
    return { plan, script: this.getScript(plan?.scriptId) }
  }

  // ---------- 场景推进（主播 advance_scene 工具的后端） ----------

  /** 当前场景（含进度），无剧本/无场次返回 null */
  currentScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { plan, script } = this.getActive()
    if (!plan || !script || script.scenes.length === 0) return null
    const index = Math.min(plan.currentSceneIdx, script.scenes.length - 1)
    return { scene: script.scenes[index], index, total: script.scenes.length }
  }

  /** 推进到下一场景并落库；已经是最后一场返回 null（收尾/循环由主播自己判断） */
  advanceScene(): { scene: ScriptScene; index: number; total: number } | null {
    const { plan, script } = this.getActive()
    if (!plan || !script || script.scenes.length === 0) return null
    const next = plan.currentSceneIdx + 1
    if (next >= script.scenes.length) return null
    this.storage.planSetSceneIdx(plan.id, next)
    return { scene: script.scenes[next], index: next, total: script.scenes.length }
  }

  /** 跳转到指定场景（goto_scene 工具 / 直播台切场景按钮的后端）；越界返回 null */
  gotoScene(idx: number): { scene: ScriptScene; index: number; total: number } | null {
    const { plan, script } = this.getActive()
    if (!plan || !script || script.scenes.length === 0) return null
    if (idx < 0 || idx >= script.scenes.length) return null
    this.storage.planSetSceneIdx(plan.id, idx)
    return { scene: script.scenes[idx], index: idx, total: script.scenes.length }
  }

  /** 场景进度复位（重新开播时可用） */
  resetScene(planId: string): void {
    this.storage.planSetSceneIdx(planId, 0)
  }

  // ---------- 主播自编剧本（create_scene/update_scene/remove_scene 工具的后端） ----------

  /**
   * 确保场次绑着一本剧本：没绑就现场建一本「主播自编」并绑上。
   * 主播自己编排场景序列用——场次可以不预绑剧本，主播开播/备稿时自己搭架子。
   */
  ensurePlanScript(planId: string): { plan: LivePlan; script: Script; created: boolean } {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) throw new Error('场次不存在')
    const bound = this.getScript(plan.scriptId)
    if (bound) return { plan, script: bound, created: false }
    const script: Script = {
      id: `sc-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      title: `${plan.name} · 主播自编`,
      theme: plan.theme,
      scenes: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.storage.scriptSave(script)
    this.storage.planSave({ ...plan, scriptId: script.id, updatedAt: Date.now() })
    return { plan, script, created: true }
  }

  /** 加一场（position 省略 = 追加到末尾；序号从 1 数起）。返回新场景和全场序列 */
  appendScene(
    planId: string,
    scene: { title: string; goal: string; keyPoints: string; estDurationMin?: number },
    position?: number
  ): { script: Script; index: number; total: number } {
    const { script } = this.ensurePlanScript(planId)
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
    planId: string,
    index: number,
    patch: { title?: string; goal?: string; keyPoints?: string; estDurationMin?: number }
  ): { script: Script; index: number; total: number } {
    const { script } = this.ensurePlanScript(planId)
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
  removeScene(planId: string, index: number): { script: Script; total: number } {
    const { plan, script } = this.ensurePlanScript(planId)
    const i = Math.floor(index) - 1
    if (i < 0 || i >= script.scenes.length) throw new Error(`没有第 ${index} 场（现在共 ${script.scenes.length} 场）`)
    const scenes = script.scenes.filter((_, at) => at !== i)
    // 删到空剧本允许（主播自编可能推倒重来）：saveScript 校验至少要有一场，空序列直接落库
    if (scenes.length === 0) {
      this.storage.scriptSave({ ...script, scenes: [], updatedAt: Date.now() })
    } else {
      this.saveScript({ title: script.title, theme: script.theme, scenes }, script.id)
    }
    if (plan.currentSceneIdx > i) this.storage.planSetSceneIdx(planId, plan.currentSceneIdx - 1)
    return { script: this.getScript(script.id)!, total: scenes.length }
  }
}
