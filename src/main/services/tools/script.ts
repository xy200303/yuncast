import { Type } from 'typebox'
import type { Program } from '../../../shared/types'
import { defineTool, type ToolCtx } from './types'

/** 引用某剧本的节目 */
function programsUsingScript(ctx: ToolCtx, scriptId: string): Program[] {
  return ctx.script.listPrograms().filter((p) => p.scriptId === scriptId)
}

/**
 * 破坏性操作的两段确认（docs/10 §10.2/§15.15）：
 * 没带 confirmed=true 时只发导演确认卡（卡里写清做什么/影响什么/能否恢复/被谁引用）；
 * 导演确认后带 confirmed=true 重调才真正执行。
 */
function askConfirm(ctx: ToolCtx, summary: string): string {
  if (!ctx.onDirectorAsk) return '确认通道没接上（ask_director 不可用）：破坏性操作不能执行，让导演在界面手动操作'
  ctx.onDirectorAsk({
    text: summary,
    options: ['确认执行', '取消'],
    timeoutSec: 300,
    defaultAction: '不执行，保持现状'
  })
  return (
    `这是破坏性/对外操作，已向导演发确认卡（5 分钟内有效）：\n${summary}\n` +
    `导演答复「确认执行」后，带 confirmed=true 重新调用本工具才真正执行；导演没确认前不要重复调用，保持现状`
  )
}

/**
 * 剧本域：剧本本体的列/看/存/删（场景编排归 scene 域）。
 * 合并自旧 list_scripts/get_script/save_script/delete_script。
 */
export const scriptTools = [
  defineTool({
    name: 'script_list',
    domain: 'script',
    label: '剧本列表',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description: '列出全部剧本：名称、主题、场景数、被哪些节目引用、版本号。拿剧本 id 或挑剧本绑给节目用它。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const scripts = ctx.script.listScripts()
      if (scripts.length === 0) return '还没有剧本：用 script_save 新建一个'
      return JSON.stringify(
        scripts.map((s) => ({
          id: s.id,
          名称: s.title,
          主题: s.theme || '（未设定）',
          场景数: s.scenes.length,
          被节目引用: programsUsingScript(ctx, s.id).map((p) => p.name),
          版本号: s.updatedAt
        }))
      )
    }
  }),

  defineTool({
    name: 'script_get',
    label: '看剧本',
    domain: 'script',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看一本剧本的完整内容：场景序列（id/目标/要点/时长）、被哪些节目引用、版本号（改它时作 expectedUpdatedAt 用）。只读不改。' +
      '不传 scriptId 看当前节目绑定的剧本；调整场景顺序（scene_reorder）前先用它拿全部场景 id。剧本 id 从 script_list 拿。',
    parameters: Type.Object({
      scriptId: Type.Optional(Type.String({ description: '剧本 id（script_list 拿）；不传 = 当前节目绑定的剧本' }))
    }),
    handler: (ctx, params) => {
      const id = params.scriptId?.trim()
      const found = id ? ctx.script.getScript(id) : ctx.script.getActive().script
      if (!found) {
        return id
          ? `剧本 ${params.scriptId} 不存在（用 script_list 拿正确的 id）`
          : '当前节目没绑剧本：传 scriptId 看指定剧本（script_list 拿 id），或用 scene_create 给当前节目自编一本'
      }
      return JSON.stringify({
        id: found.id,
        名称: found.title,
        主题: found.theme || '（未设定）',
        场景: found.scenes.map((s, i) => ({
          序号: i + 1,
          id: s.id,
          标题: s.title,
          目标: s.goal,
          要点: s.keyPoints,
          预计分钟: s.estDurationMin
        })),
        被节目引用: programsUsingScript(ctx, found.id).map((p) => ({ id: p.id, 名称: p.name })),
        版本号: found.updatedAt
      })
    }
  }),

  defineTool({
    name: 'script_save',
    label: '存剧本',
    domain: 'script',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '新建剧本或给剧本改名/改主题（场景内容不动）。带 id 是改名/改主题，不带 id 是新建（title 必填，场景允许后补——绑给节目后用 scene_create 逐场编排）。' +
      '修改时建议带 expectedUpdatedAt（script_get 里的版本号）做并发保护。剧本 id 从 script_list 拿。返回剧本 id、场景数和版本号。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '剧本 id：修改时必传（script_list 拿），不传 = 新建' })),
      title: Type.String({ description: '剧本名称' }),
      theme: Type.Optional(Type.String({ description: '主题/方向（不传保持原样）' })),
      expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
    }),
    handler: (ctx, params) => {
      if (!params.id) {
        const dup = ctx.script.listScripts().find((s) => s.title === params.title.trim())
        if (dup) return `已存在同名剧本「${dup.title}」（id=${dup.id}）：要改它带 id 调用，别重复建`
      }
      const saved = ctx.script.saveScriptMeta(
        { title: params.title, theme: params.theme },
        params.id?.trim() || undefined,
        params.expectedUpdatedAt
      )
      return `${params.id ? '已更新' : '已新建'}剧本「${saved.title}」（id=${saved.id}，${saved.scenes.length} 个场景，版本号 ${saved.updatedAt}）`
    }
  }),

  defineTool({
    name: 'script_delete',
    label: '删剧本',
    domain: 'script',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '删除一本剧本（场景定义一起删，不可恢复；底稿条目不动）。被节目引用的剧本删不了——先 program_save 把引用它的节目 scriptId 传空字符串解绑。' +
      '两段确认：第一次调用不传 confirmed，向导演发确认卡；导演确认后带 confirmed=true 重调才执行。剧本 id 从 script_list 拿。',
    parameters: Type.Object({
      scriptId: Type.String({ description: '剧本 id（script_list 拿）' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
    }),
    handler: (ctx, params) => {
      const found = ctx.script.getScript(params.scriptId.trim())
      if (!found) return `剧本 ${params.scriptId} 不存在（用 script_list 拿正确的 id）`
      const referencing = programsUsingScript(ctx, found.id)
      if (referencing.length > 0) {
        return (
          `删不了：剧本「${found.title}」正被 ${referencing.map((p) => `「${p.name}」`).join('、')} 引用。\n` +
          `先用 program_save 把这些节目的 scriptId 传空字符串解绑，再删除`
        )
      }
      if (!params.confirmed) {
        return askConfirm(
          ctx,
          `删除剧本「${found.title}」：${found.scenes.length} 个场景一并删除。\n` +
            `当前没有任何节目引用它；各节目的底稿条目不受影响。\n不可恢复`
        )
      }
      ctx.script.deleteScript(found.id)
      return `已删除剧本「${found.title}」（${found.scenes.length} 个场景）`
    }
  })
]
