import type { Program } from '../../../shared/types'
import { DRAFT_UNIT_STATUS_LABEL } from '../../../shared/types'
import type { PersonaService } from '../PersonaService'
import type { ToolCtx } from './types'

/**
 * 底稿库段数硬上限（成本闸）：写满就停，开播后池空了循环已有底稿（音频复用零重合成）。
 * 这个上限不进节目配置、不在 UI 出现，只防写稿失控把合成账单烧穿。
 * ProgramPlaybackService 的循环闸门也用同一个上限。
 */
export const DRAFT_HARD_CAP = 200

/**
 * 稿内演法标记的工具参数提示（speak/draft_write/draft_add/draft_edit 的 text 参数共用）：
 * 模型写稿时最常读的是工具 schema——分工写在这比写在手册里管用。
 * 完整教学在 system prompt 的「局部演法」段（PromptTemplateService.markupSection）。
 */
export const MARKUP_HINT =
  '正文里用演法标记做单句级表演：<cot text=情绪>句子</cot> 给关键句套情绪（桥段至少挑一处：报价/悬念/反转句）、<fx>笑声</fx> 插音效、<pause>600</pause> 停顿；delivery 只整段语气，两者都要写。不支持的音色合成时自动剥掉标记，放心写'

/**
 * personaId → 主播卡：写稿时用 personaId 指定这句归谁。personaId 必须是**主播卡 id**（稳定寻址：改名不失效、
 * 重名不歧义）；返回卡 id 与它当前音色。卡司里没有/没配音色都返回中文错误。
 */
export function resolveCastVoice(
  persona: PersonaService,
  personaId?: string
): { personaId?: string; voiceId?: string; error?: string } {
  if (!personaId?.trim()) return {}
  const key = personaId.trim()
  const target = persona.programPersonas().find((p) => p.id === key)
  if (!target) {
    const names = persona.programPersonas().map((p) => `${p.name}（${p.id}）`).join('、') || '（节目还没配卡司）'
    return { error: `卡司里没有「${personaId.trim()}」：现有 ${names}` }
  }
  const voiceId = target.voiceId.trim()
  if (!voiceId) return { error: `卡司「${target.name}」还没选音色：到主播团给它配一个` }
  return { personaId: target.id, voiceId }
}

/**
 * 音色优先级：显式 voiceId > personaId 指定的主播卡嗓音。都没有返回 undefined（调用方必须报错，不兜底）。
 */
export function resolveVoice(
  persona: PersonaService,
  personaId?: string,
  voice?: string
): string | undefined {
  if (voice?.trim()) return voice.trim()
  if (personaId?.trim()) {
    const found = persona.list().find((p) => p.id === personaId.trim())
    if (found?.voiceId) return found.voiceId
  }
  // 兜底：节目卡司第一张的嗓音（speak 的工具描述一直承诺「不传 = 卡司第一张」，
  // 代码这里以前直接返回 undefined，导致配了卡司的节目调 speak 还报「没配卡司」）
  const castVoice = persona.programVoice()
  if (castVoice.trim()) return castVoice.trim()
  // 真没卡司也没显式指定：调用方必须报错让 agent 补参数（不瞎猜）
  return undefined
}

// ---------- 底稿/场景工具共用的小工具 ----------

export const DRAFT_STATUS = DRAFT_UNIT_STATUS_LABEL

export function activeProgram(ctx: ToolCtx): Program | null {
  return ctx.script.getActive().program ?? null
}

export function activeProgramId(ctx: ToolCtx): string | null {
  return ctx.script.getActive().program?.id ?? null
}

/** 当前节目的知识范围（knowledge_search/price_check 只查节目配置的条目/文件；无节目 = 全库） */
export function knowledgeScope(ctx: ToolCtx) {
  return ctx.script.getActive().program?.knowledgeScope
}

export function currentSceneId(ctx: ToolCtx): string {
  return ctx.script.currentScene()?.scene.id ?? ''
}

export function sceneTitleOf(ctx: ToolCtx, sceneId: string): string {
  if (sceneId === '') return '全场通用'
  const bound = ctx.script.getActive().script
  return bound?.scenes.find((s) => s.id === sceneId)?.title ?? sceneId
}

/** 没选节目时的一句指引（返回 null = 有节目，放行） */
export function requireProgram(ctx: ToolCtx): string | null {
  return activeProgramId(ctx) ? null : '当前没有节目：先在界面里选中一个节目（或外部调 program_activate），再管理底稿'
}

/** 底稿库成本闸：到顶返回提示文案，没到返回 null */
export function draftCapHit(ctx: ToolCtx): string | null {
  const programId = activeProgramId(ctx)
  if (!programId) return null
  const count = ctx.draftUnits.list(programId).length
  return count >= DRAFT_HARD_CAP
    ? `底稿库已到硬上限（${count}/${DRAFT_HARD_CAP} 段）——这是成本闸：开播后池子空了会循环已有底稿（音频复用，不重新合成）。要加新说法先 draft_remove 腾位置`
    : null
}

/** 结果行里的库存展示：只报数（上限是内部成本闸，不暴露给主播当目标） */
export function draftStockLine(ctx: ToolCtx): string {
  const programId = activeProgramId(ctx)
  if (!programId) return ''
  const total = ctx.draftUnits.list(programId).length
  return `；全场 ${total} 段`
}

/**
 * 形态单调性检测（draft_write 的软反馈）：一批桥段全是同一种类型（≥3 段）就提醒换形态——
 * 一场戏全是叫卖或全是故事都平，类型穿插才有起伏。
 */
export function bitTypeMonotony(types: string[]): string | null {
  if (types.length < 3) return null
  const first = types[0].trim()
  if (!first) return null
  if (types.every((t) => t.trim() === first)) return `这批 ${types.length} 段全是「${first}」类型`
  return null
}
