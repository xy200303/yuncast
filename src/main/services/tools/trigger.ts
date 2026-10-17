import { Type } from 'typebox'
import type { Program } from '../../../shared/types'
import { defineTool, type ToolCtx } from './types'

/**
 * 触发器域：全局触发器库的查 + 节目级事件规则勾选。
 * 合并自旧 list_triggers/get_trigger/set_program_triggers。
 */

/** 启用某触发器的节目 */
const programsUsingTrigger = (ctx: ToolCtx, triggerId: string): Program[] =>
  ctx.script.listPrograms().filter((p) => p.enabledTriggerIds.includes(triggerId))

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
          启用它的节目: programsUsingTrigger(ctx, t.id).map((p) => p.name)
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
        启用它的节目: programsUsingTrigger(ctx, found.id).map((p) => ({ id: p.id, 名称: p.name }))
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
      '设置一个节目启用哪些触发器（全量替换 enabledTriggerIds；触发器定义在全局库，节目只存勾选）。' +
      'id 必须来自 trigger_list，不存在的会被拒绝。改的是当前节目且会话在跑时，事件规则要重开会话/重新开播才生效（返回值会明说）。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' }),
      triggerIds: Type.Array(Type.String(), { description: '启用的触发器 id 列表（空数组 = 全关）' }),
      expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的节目版本号（并发保护）' }))
    }),
    handler: (ctx, params) => {
      const saved = ctx.script.setProgramTriggers(params.programId, params.triggerIds, params.expectedUpdatedAt)
      const names = saved.enabledTriggerIds.map((id) => triggerLabel(ctx, id))
      const status = ctx.getStatus?.()
      const runningNote =
        saved.id === ctx.storage.getConfig().live.activeProgramId && status && status.state !== 'stopped'
          ? '。注意：这是当前节目且会话在跑——事件规则要重开会话/重新开播才生效'
          : ''
      return `节目「${saved.name}」已启用 ${names.length} 项事件规则${names.length > 0 ? `：${names.join('、')}` : ''}${runningNote}`
    }
  })
]
