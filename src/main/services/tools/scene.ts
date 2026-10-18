import { Type } from 'typebox'
import type { Script } from '../../../shared/types'
import { defineTool } from './types'
import { activeProgramId } from './util'
import type { ToolCtx } from './types'

/**
 * 场景工具的「目标节目」：显式 programId 优先（MCP/批量编排时常常还没切换当前节目），
 * 否则回落到当前节目。以前只认当前节目——没切换就调用，会把场景加到别的节目的编排上（实测踩过）。
 */
function targetProgram(ctx: ToolCtx, programId?: string): { id: string; name: string } | string {
  const wanted = programId?.trim()
  if (wanted) {
    const found = ctx.storage.programList().find((p) => p.id === wanted)
    if (!found) return `节目 ${wanted} 不存在（用 program_list 拿正确的 id）`
    return { id: found.id, name: found.name }
  }
  const active = activeProgramId(ctx)
  if (!active) return '当前没有节目：先 program_save 建一个并 program_activate，或给这个工具传 programId'
  const program = ctx.storage.programList().find((p) => p.id === active)
  return { id: active, name: program?.name ?? active }
}

/** 编排工具的统一回报：动作结果 + 最新场景序列（system prompt 里的清单是出生时快照，改完以这里为准） */
function sceneListReport(action: string, script: Script): string {
  if (script.scenes.length === 0) return `${action}。这个节目还没有编排，用 scene_create 重新搭`
  const list = script.scenes
    .map((s, i) => `${i + 1}. ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}`)
    .join('\n')
  return `${action}。最新场景序列（system prompt 里那份是开播时的快照，以这份为准）：\n${list}`
}

/**
 * 场景域：节目编排（场景序列）的查看/推进/跳转/编辑。
 * 合并自旧 advance_scene/goto_scene/create_scene/update_scene/remove_scene + anchorSystemTools 的 reorder_scenes。
 */
export const sceneTools = [
  defineTool({
    name: 'scene_list',
    label: '看节目编排',
    domain: 'scene',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看当前节目的编排（场景序列）：序号/标题/目标/预计时长，标出当前演到哪场，附每场 sceneId（draft_write/draft_add 的 sceneId 从这拿）。' +
      '只读不改。场景变了想推进用 scene_advance，想跳场用 scene_goto。',
    parameters: Type.Object({
      programId: Type.Optional(Type.String({ description: '看哪个节目的编排（program_list 拿 id）；不传 = 当前节目' }))
    }),
    handler: (ctx, params) => {
      const wanted = params.programId?.trim()
      const target = wanted
        ? (ctx.storage.programList().find((item) => item.id === wanted) ?? null)
        : ctx.script.getActive().program
      if (wanted && !target) return `节目 ${wanted} 不存在（用 program_list 拿正确的 id）`
      const program = target
      const script = program ? ctx.script.getScript(program.id) : null
      if (!program) return '当前没有节目：先在界面里选中一个节目（或外部调 program_activate），再看场景'
      if (!script || script.scenes.length === 0) {
        return '当前节目还没有编排：scene_create 加第一场就会就地建起来'
      }
      const current = ctx.script.currentScene()
      return (
        `编排「${script.title}」共 ${script.scenes.length} 场：\n` +
        script.scenes
          .map(
            (s, i) =>
              `${i + 1}. [${s.id}] ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}${current && current.index === i ? ' ← 当前场' : ''}`
          )
          .join('\n')
      )
    }
  }),

  defineTool({
    name: 'scene_advance',
    label: '推进场景',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '把节目编排推进到下一场景：当前场讲完了用。副作用：提词器刷新、装载新场景话术库。' +
      '返回新场景的目标和要点；已经是最后一场时返回提示——收尾还是循环由你自己判断。要跳场用 scene_goto。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const next = ctx.script.advanceScene()
      if (!next) return '已经是最后一场了（或这个节目还没有编排），收尾还是从头循环由你判断'
      ctx.onSceneChanged?.()
      // 补装兜底：装池是整库的，正常早已装好；这里有新就绪的顺带进池（去重落空）
      ctx.onSceneAdvanced?.(next.index)
      return `进入第 ${next.index + 1}/${next.total} 场「${next.scene.title}」\n目标：${next.scene.goal}\n要点：${next.scene.keyPoints}`
    }
  }),

  defineTool({
    name: 'scene_goto',
    label: '跳到场景',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '直接跳到编排里的某一场景（序号从 1 数起，scene_list 拿序号）：要跳过某场或回到前面某场时用；按顺序推进用 scene_advance。' +
      '副作用：提词器刷新、装载目标场景话术库。返回目标场的目标和要点。',
    parameters: Type.Object({
      index: Type.Number({ description: '目标场景序号，从 1 开始' })
    }),
    handler: (ctx, params) => {
      const target = ctx.script.gotoScene(Math.floor(params.index) - 1)
      if (!target) return '没有这个场景（或本场还没有编排），序号从 1 数起'
      ctx.onSceneChanged?.()
      ctx.onSceneAdvanced?.(target.index)
      return `已跳到第 ${target.index + 1}/${target.total} 场「${target.scene.title}」\n目标：${target.scene.goal}\n要点：${target.scene.keyPoints}`
    }
  }),

  defineTool({
    name: 'scene_create',
    label: '加一场',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '给本场编排加一场景：节目没绑编排时自动建一本你自编的编排并绑上。你自己编排直播结构用——' +
      '先想清楚这场直播分几幕（开场留人/痛点/讲解/互动/催单/收尾），逐场建好，再按场景用 draft_write 写稿或播讲。position 省略 = 追加到末尾。' +
      '副作用：提词器刷新。返回最新场景序列。',
    parameters: Type.Object({
      title: Type.String({ description: '场景名，比如「痛点共鸣」「催单收尾」' }),
      goal: Type.String({ description: '这场要达成什么，一句话' }),
      keyPoints: Type.String({ description: '必讲要点，一行一条' }),
      estDurationMin: Type.Optional(Type.Number({ description: '预计时长（分钟），默认 5' })),
      position: Type.Optional(Type.Number({ description: '插到第几场（序号从 1 数起），省略 = 追加到末尾' })),
      programId: Type.Optional(
        Type.String({ description: '给哪个节目的编排加场（program_list 拿 id）；不传 = 当前节目' })
      )
    }),
    handler: (ctx, params) => {
      const program = targetProgram(ctx, params.programId)
      if (typeof program === 'string') return program
      const programId = program.id
      const result = ctx.script.appendScene(
        programId,
        {
          title: params.title,
          goal: params.goal,
          keyPoints: params.keyPoints,
          estDurationMin: params.estDurationMin
        },
        params.position
      )
      ctx.onSceneChanged?.()
      return sceneListReport('已加一场', result.script)
    }
  }),

  defineTool({
    name: 'scene_update',
    label: '改一场',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '改某一场的名字/目标/要点/时长（序号从 1 数起，scene_list 拿序号，只传要改的字段）。临场调整编排结构用。' +
      '副作用：提词器刷新。返回最新场景序列。',
    parameters: Type.Object({
      index: Type.Number({ description: '第几场（序号从 1 数起）' }),
      title: Type.Optional(Type.String({ description: '场景名' })),
      goal: Type.Optional(Type.String({ description: '这场要达成什么' })),
      keyPoints: Type.Optional(Type.String({ description: '必讲要点，一行一条' })),
      estDurationMin: Type.Optional(Type.Number({ description: '预计时长（分钟）' })),
      programId: Type.Optional(Type.String({ description: '改哪个节目的编排（program_list 拿 id）；不传 = 当前节目' }))
    }),
    handler: (ctx, params) => {
      const program = targetProgram(ctx, params.programId)
      if (typeof program === 'string') return program
      const programId = program.id
      const result = ctx.script.updateScene(programId, params.index, {
        title: params.title,
        goal: params.goal,
        keyPoints: params.keyPoints,
        estDurationMin: params.estDurationMin
      })
      ctx.onSceneChanged?.()
      return sceneListReport(`已改第 ${result.index + 1} 场`, result.script)
    }
  }),

  defineTool({
    name: 'scene_remove',
    label: '删一场',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '删掉某一场（序号从 1 数起，scene_list 拿序号）。副作用：提词器刷新；写在这个场景里的底稿不会跟着删（变成孤儿段，可按 sceneId 用 draft_clear 清理）。' +
      '返回最新场景序列。',
    parameters: Type.Object({
      index: Type.Number({ description: '第几场（序号从 1 数起）' }),
      programId: Type.Optional(Type.String({ description: '删哪个节目的编排（program_list 拿 id）；不传 = 当前节目' }))
    }),
    handler: (ctx, params) => {
      const program = targetProgram(ctx, params.programId)
      if (typeof program === 'string') return program
      const programId = program.id
      const result = ctx.script.removeScene(programId, params.index)
      ctx.onSceneChanged?.()
      return sceneListReport('已删一场', result.script)
    }
  }),

  defineTool({
    name: 'scene_reorder',
    label: '场景排序',
    domain: 'scene',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '调整编排场景顺序：sceneIds 必须恰好包含全部场景 id 的一个排列（先用 script_get 拿当前场景列表）。只调顺序，场景内容不动。' +
      '返回排完的新顺序列表。',
    parameters: Type.Object({
      programId: Type.Optional(Type.String({ description: '哪个节目的编排（program_list 拿）；不传 = 当前节目' })),
      sceneIds: Type.Array(Type.String(), { description: '全部场景 id 按新顺序排列' }),
      expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
    }),
    handler: (ctx, params) => {
      const program = targetProgram(ctx, params.programId)
      if (typeof program === 'string') return program
      const saved = ctx.script.reorderScenes(program.id, params.sceneIds, params.expectedUpdatedAt)
      return `已调整「${saved.title}」的场景顺序：\n${saved.scenes.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`
    }
  })
]
