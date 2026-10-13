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
}
