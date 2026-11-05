import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/**
 * 触发器域：全局触发器库的查 + 本场事件规则勾选。
 * 触发器定义在全局库；勾选属于本场配置（assets 之间零引用，docs/12）。
 */

/** 最近一次本场配置里启用了某触发器的节目 */
const sessionsUsingTrigger = (ctx: ToolCtx, triggerId: string): { id: string; name: string }[] =>
  ctx.script
    .listPrograms()
    .filter((p) => ctx.storage.sessionConfigLatest(p.id)?.enabledTriggerIds.includes(triggerId))
    .map((p) => ({ id: p.id, name: p.name }))

/** 触发器显示名（查不到标注已删除） */
const triggerLabel = (ctx: ToolCtx, id: string): string => {
  const found = ctx.triggers?.list().find((t) => t.id === id)
  return found ? found.name : `${id}（已不存在）`
}

export const triggerTools = [
  defineTool({
    name: 'trigger_list',
    label: '触发器列表',
    domain: 'trigger',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出全局触发器库：id、名称、事件、模式（tool=模板直连/steer=插一句/task=派任务）、全局是否启用、被哪些节目勾选。' +
      '给节目配事件规则（trigger_set）前用它拿 id。返回 JSON 数组。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const runtime = ctx.triggers
      if (!runtime) return '触发器运行时还没初始化'
      const list = runtime.list()
      if (list.length === 0) return '触发器库是空的'
      return JSON.stringify(
        list.map((t) => ({
          id: t.id,
          名称: t.name,
          事件: t.on.event,
          模式: t.target.mode,
          全局启用: t.enabled,
          最近本场启用它的节目: sessionsUsingTrigger(ctx, t.id).map((p) => p.name)
        }))
      )
    }
  }),

  defineTool({
    name: 'trigger_get',
    label: '看触发器',
    domain: 'trigger',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看一个触发器的完整定义：事件条件、聚合/冷却/单场预算、执行内容（模板或提示词），以及被哪些节目启用。triggerId 从 trigger_list 拿。',
    parameters: Type.Object({
      triggerId: Type.String({ description: '触发器 id（trigger_list 拿）' })
    }),
    handler: (ctx, params) => {
      const runtime = ctx.triggers
      if (!runtime) return '触发器运行时还没初始化'
      const found = runtime.list().find((t) => t.id === params.triggerId.trim())
      if (!found) return `触发器 ${params.triggerId} 不存在（用 trigger_list 拿正确的 id）`
      return JSON.stringify({
        id: found.id,
        名称: found.name,
        全局启用: found.enabled,
        事件: found.on.event,
        条件过滤: found.on.filter ?? null,
        模式: found.target.mode,
        执行内容: found.target.mode === 'tool' ? (found.target.toolAction ?? null) : (found.target.promptTemplate ?? null),
        节流: found.throttle ?? null,
        最近本场启用它的节目: sessionsUsingTrigger(ctx, found.id)
      })
    }
  }),

  defineTool({
    name: 'trigger_set',
    label: '设触发器',
    domain: 'trigger',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '设置一个节目最近一次本场配置启用哪些触发器（全量替换；触发器定义在全局库，本场只存勾选）。' +
      'id 必须来自 trigger_list，不存在的会被拒绝。还没做过开播配置时无法设置——先在直播台做开播配置。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' }),
      triggerIds: Type.Array(Type.String(), { description: '启用的触发器 id 列表（空数组 = 全关）' })
    }),
    handler: (ctx, params) => {
      const program = ctx.script.listPrograms().find((p) => p.id === params.programId.trim())
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      const known = new Set(ctx.triggers?.list().map((t) => t.id) ?? [])
      const ids = [...new Set(params.triggerIds.map((id) => id.trim()).filter(Boolean))]
      const unknown = ids.filter((id) => !known.has(id))
      if (unknown.length > 0) return `这些触发器 id 不在全局触发器库：${unknown.join('、')}`
      const saved = ctx.storage.sessionConfigPatch(program.id, { enabledTriggerIds: ids })
      if (!saved) return `「${program.name}」还没做过开播配置：先在直播台做一次开播配置，再设本场事件规则`
      const names = saved.enabledTriggerIds.map((id) => triggerLabel(ctx, id))
      return `节目「${program.name}」本场已启用 ${names.length} 项事件规则${names.length > 0 ? `：${names.join('、')}` : ''}`
    }
  })
]
