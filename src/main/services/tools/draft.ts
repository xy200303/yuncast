import { Type } from 'typebox'
import type { DraftUnitSource } from '../../../shared/types'
import { defineTool } from './types'
import {
  MARKUP_HINT,
  DRAFT_STATUS,
  activeProgramId,
  requireProgram,
  draftCapHit,
  draftStockLine,
  sceneTitleOf,
  currentSceneId,
  bitTypeMonotony,
  resolveCastVoice
} from './util'

/**
 * 底稿域：底稿库（开播前写好的桥段，轮播的骨架）的看/补/写/改/删/清。
 * 合并自旧 list_drafts/edit_draft/add_draft/remove_draft/clear_drafts/write_bits。
 */
export const draftTools = [
  defineTool({
    name: 'draft_list',
    label: '看底稿',
    domain: 'draft',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看本场底稿库（开播前写好的桥段，轮播的骨架）：按关键词搜，或看当前场景的。改/删底稿前先用它拿条目 id。' +
      '返回每条的 id/场景/状态/类型和前 100 字概要（只读不改任何东西）；要看全文用 draft_get。',
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: '按文本内容过滤，比如旧价格、卖点词' })),
      scope: Type.Optional(
        Type.Union([Type.Literal('scene'), Type.Literal('all')], {
          description: 'scene=当前场景+全场通用（默认），all=全节目'
        })
      )
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const all = ctx.draftUnits.list(activeProgramId(ctx)!)
      const sceneId = currentSceneId(ctx)
      let list = params.scope === 'all' ? all : all.filter((u) => u.sceneId === sceneId || u.sceneId === '')
      const kw = params.keyword?.trim()
      if (kw) list = list.filter((u) => u.text.includes(kw))
      if (list.length === 0) return kw ? `没有包含「${kw}」的底稿` : '这个范围还没有底稿'
      const shown = list.slice(0, 30)
      // 列表只给前 100 字（拿 id 和概要用；要看全文用 draft_get，改稿按 id 改）——
      // 底稿一多全文塞进来一条结果就是几万 token，上下文 compression 会被它顶爆
      const brief = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)
      const leadPersonaName = (u: { personaId?: string; voiceId: string }) => {
        const card = u.personaId
          ? ctx.persona.list().find((p) => p.id === u.personaId)
          : ctx.persona.programPersonas().find((p) => p.voiceId === u.voiceId)
        return card?.name ?? ''
      }
      return (
        `共 ${list.length} 条${list.length > 30 ? '，只列前 30 条' : ''}：\n` +
        shown
          .map(
            (u) =>
              `${u.id}｜${sceneTitleOf(ctx, u.sceneId)}｜${DRAFT_STATUS[u.status]}｜${leadPersonaName(u) ? `主播：${leadPersonaName(u)}｜` : ''}${u.bitType ? `[${u.bitType}] ` : ''}${brief(u.text)}` +
              (u.delivery ? `（演法：${u.delivery}）` : '')
          )
          .join('\n')
      )
    }
  }),

  defineTool({
    name: 'draft_get',
    label: '读底稿全文',
    domain: 'draft',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '读一条底稿的完整内容：全文+场景+合成状态+类型/演法/语速/音调参数（只读不改）。' +
      'draft_list 只给前 100 字概要，改稿前用它看全文。unitId 从 draft_list 拿。',
    parameters: Type.Object({
      unitId: Type.String({ description: '底稿条目 id（draft_list 拿）' })
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const found = ctx.draftUnits.list(activeProgramId(ctx)!).find((u) => u.id === params.unitId.trim())
      if (!found) return `找不到底稿 ${params.unitId}（用 draft_list 拿正确的 unitId）`
      return JSON.stringify({
        unitId: found.id,
        场景: sceneTitleOf(ctx, found.sceneId),
        场景id: found.sceneId,
        状态: DRAFT_STATUS[found.status],
        类型: found.bitType || '（旧式单句）',
        演法: found.delivery || '（未设定）',
        语速: found.rate ?? '默认',
        音调: found.pitch ?? '默认',
        段后停顿: found.pauseAfterMs !== undefined ? `${found.pauseAfterMs}ms` : '连续播',
        主播: (() => {
          const card = found.personaId
            ? ctx.persona.list().find((p) => p.id === found.personaId)
            : ctx.persona.programPersonas().find((p) => p.voiceId === found.voiceId)
          if (card) return `${card.name}（personaId=${card.id}）`
          return found.voiceId ? found.voiceId : '默认（卡司第一张）'
        })(),
        personaId: found.personaId ?? '',
        参考来源: found.sources.map((s) => `${s.name}：${s.snippet}`),
        全文: found.text
      })
    }
  }),

  defineTool({
    name: 'draft_add',
    label: '补底稿',
    domain: 'draft',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '把一段新内容记进底稿库（默认记到当前场景）：入库后后台自动合成，好了进入轮播（不出声，不是现场播报）。' +
      '现场临时编的好桥段值得记；想现在就播直接用 speak，别用它。返回入库确认和归属场景。',
    parameters: Type.Object({
      text: Type.String({ description: `底稿文本（桥段就整段，单句就一句）。${MARKUP_HINT}` }),
      type: Type.Optional(
        Type.String({
          description:
            '桥段类型（hook/story/scene/math/compare/punchline/interact/cta/transition/closer/general；closer=收尾段，不进自动轮播）'
        })
      ),
      personaId: Type.Optional(Type.String({ description: '这段归哪位：主播卡 id（persona_list / program_get 卡司里的 id）；不传 = 合成时用卡司第一张' })),
      delivery: Type.Optional(Type.String({ description: '表演指示，一句话' })),
      rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3），不传用默认' })),
      pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守），不传用默认' })),
      pauseAfterMs: Type.Optional(
        Type.Number({ description: '播完这段后的停顿毫秒（0~10000，默认连续播）。播放时调度，不进合成' })
      ),
      sceneId: Type.Optional(
        Type.String({ description: '记到哪个场景（scene_list 拿 id）；不传记到当前场景，节目还没有编排则记为全场通用' })
      )
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const capped = draftCapHit(ctx)
      if (capped) return capped
      const programId = activeProgramId(ctx)!
      const sceneId = params.sceneId?.trim() ?? currentSceneId(ctx)
      const siblings = ctx.draftUnits.list(programId).filter((u) => u.sceneId === sceneId)
      const variantIdx = siblings.reduce((max, u) => Math.max(max, u.variantIdx + 1), 0)
      const programVoice = resolveCastVoice(ctx.persona, params.personaId)
      if (programVoice.error) return programVoice.error
      ctx.draftUnits.save({
        programId,
        sceneId,
        variantIdx,
        text: params.text,
        bitType: params.type?.trim() ?? '',
        delivery: params.delivery?.trim() ?? '',
        rate: params.rate,
        pitch: params.pitch,
        pauseAfterMs:
          params.pauseAfterMs === undefined
            ? undefined
            : Math.max(0, Math.min(10000, Math.floor(Number(params.pauseAfterMs) || 0))),
        personaId: programVoice.personaId,
        voiceId: programVoice.voiceId ?? '',
        source: 'initial',
        sources: []
      })
      void ctx.draftUnits.kickSynthesis(programId)
      return `已记进底稿（${sceneTitleOf(ctx, sceneId)}），后台合成完成后进入轮播；想现在就说请用 speak`
    }
  }),

  defineTool({
    name: 'draft_write',
    label: '写桥段',
    domain: 'draft',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '写稿入库：把为某个场景写好的桥段存进底稿库（一次 1~4 段；场景 sceneId 从 scene_list 拿）。' +
      '桥段 = 一段 30~90 秒的连续讲述（多句、150~350 字），是合成和播放的最小单元——写成一个有起承转合的整体，别拆成单句。' +
      'type 标内容形态：hook 开场钩 / story 故事 / scene 场景化 / math 算账 / compare 对比 / punchline 包袱（歇后语、顺口溜、段子）/ interact 互动 / cta 催单 / transition 转场 / closer 收尾（不进自动轮播，收尾时你用 speak 说出去）/ general 通用。' +
      'delivery 写表演指示（一句话：情绪、语速、哪里停顿，比如「压低声音像说悄悄话，报价格前停一拍」）。' +
      'sources 填每段参考过的来源名（商品名/文件名），没参考就空数组。' +
      '不自动合成：入库是待合成状态，导演审完统一预合成，不用你管音频。返回入库段数和该场景库存；一批全是同一类型时会提醒换形态。',
    parameters: Type.Object({
      sceneId: Type.String({ description: '写到哪个场景（scene_list 拿 id）' }),
      items: Type.Array(
        Type.Object({
          type: Type.String({ description: '桥段类型（见工具描述），自定义类型也行' }),
          text: Type.String({ description: `桥段全文：多句连续口语，150~350 字，有铺垫有落点。${MARKUP_HINT}` }),
          personaId: Type.Optional(
            Type.String({ description: '这段归哪位：主播卡 id（persona_list / program_get 卡司里的 id）；双主持/多角色节目逐段指定，不传 = 卡司第一张' })
          ),
          delivery: Type.Optional(Type.String({ description: '表演指示，一句话' })),
          rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3），不传用默认' })),
          pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守），不传用默认' })),
          pauseAfterMs: Type.Optional(
            Type.Number({ description: '播完这段后的停顿毫秒（0~10000，默认连续播）。播放时调度，不进合成' })
          ),
          sources: Type.Optional(
            Type.Array(
              Type.Object({
                type: Type.Union([Type.Literal('file'), Type.Literal('url'), Type.Literal('product')]),
                name: Type.String({ description: '来源名（商品名/文件名/网址）' }),
                snippet: Type.String({ description: '引用的关键信息，一句话' })
              }),
              { description: '这段参考的来源' }
            )
          )
        }),
        { description: '本批桥段（1~4 段）' }
      )
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const capped = draftCapHit(ctx)
      if (capped) return capped
      // 先校验全部 personaId，别写一半才发现卡司名写错
      const podcastVoices = params.items.map((item) => resolveCastVoice(ctx.persona, item.personaId))
      const castError = podcastVoices.find((entry) => entry.error)
      if (castError?.error) return castError.error
      const saved = ctx.draftUnits.saveMany(
        activeProgramId(ctx)!,
        params.sceneId.trim(),
        params.items.map((item, index) => ({
          text: item.text,
          bitType: item.type,
          personaId: podcastVoices[index].personaId,
          voiceId: podcastVoices[index].voiceId,
          delivery: item.delivery,
          rate: item.rate,
          pitch: item.pitch,
          pauseAfterMs:
            item.pauseAfterMs === undefined
              ? undefined
              : Math.max(0, Math.min(10000, Math.floor(Number(item.pauseAfterMs) || 0))),
          sources: (item.sources ?? []).map(
            (s): DraftUnitSource => ({ type: s.type, id: '', name: s.name, snippet: s.snippet })
          )
        }))
      )
      // 不自动合成：写稿阶段量大，审阅后由「预合成全部」统一跑（draft_edit/draft_add 的单条急用才自动合成）
      const sceneCount = ctx.draftUnits.list(activeProgramId(ctx)!).filter((u) => u.sceneId === params.sceneId.trim()).length
      const monotony = bitTypeMonotony(params.items.map((item) => item.type))
      return (
        `已入库 ${saved.length} 段到「${sceneTitleOf(ctx, params.sceneId.trim())}」（待合成；本场景现有 ${sceneCount} 段${draftStockLine(ctx)}）` +
        (monotony ? `\n注意：${monotony}——一场戏全是同一种形态会很平，下批换类型（故事/算账/包袱/场景化穿插着来）` : '')
      )
    }
  }),

  defineTool({
    name: 'draft_edit',
    label: '改底稿',
    domain: 'draft',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '改一条底稿（长期生效）：文本、类型、表演指示都能改（导演口径调整/价格修正/说法优化）。' +
      '副作用：改完旧音频作废、后台自动重新合成，好了之后轮播/装载就用新版；已经在池里没播的副本不受影响，要改用 pool_revise。' +
      'unitId 从 draft_list 拿，改前用 draft_get 看全文。',
    parameters: Type.Object({
      unitId: Type.String({ description: '底稿条目 id（draft_list 拿）' }),
      text: Type.String({ description: `新文本（桥段就传整段，单句就传一句）。${MARKUP_HINT}` }),
      type: Type.Optional(Type.String({ description: '桥段类型（不改不传）' })),
      personaId: Type.Optional(Type.String({ description: '改归哪位（主播卡 id）；不改不传' })),
      delivery: Type.Optional(Type.String({ description: '表演指示（不改不传）' })),
      rate: Type.Optional(Type.Number({ description: '语速倍率（不改不传）' })),
      pitch: Type.Optional(Type.Number({ description: '音调倍率（不改不传）' })),
      pauseAfterMs: Type.Optional(Type.Number({ description: '播完这段后的停顿毫秒（0~10000，0 = 连续播；不改不传）' }))
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const programId = activeProgramId(ctx)!
      const existing = ctx.draftUnits.list(programId).find((u) => u.id === params.unitId.trim())
      if (!existing) return `找不到底稿 ${params.unitId}（用 draft_list 拿正确的 unitId）`
      const programVoice = resolveCastVoice(ctx.persona, params.personaId)
      if (programVoice.error) return programVoice.error
      ctx.draftUnits.save(
        {
          programId,
          sceneId: existing.sceneId,
          variantIdx: existing.variantIdx,
          text: params.text,
          bitType: params.type?.trim() ?? existing.bitType,
          delivery: params.delivery?.trim() ?? existing.delivery,
          rate: params.rate ?? existing.rate,
          pitch: params.pitch ?? existing.pitch,
          pauseAfterMs:
            params.pauseAfterMs === undefined
              ? existing.pauseAfterMs
              : Math.max(0, Math.min(10000, Math.floor(Number(params.pauseAfterMs) || 0))),
          personaId: programVoice.personaId ?? existing.personaId,
          voiceId: programVoice.voiceId ?? existing.voiceId,
          source: existing.source,
          sources: existing.sources
        },
        existing.id
      )
      void ctx.draftUnits.kickSynthesis(programId)
      return `已改：「${params.text.slice(0, 40)}${params.text.length > 40 ? '…' : ''}」。旧音频作废，后台重新合成中，好了之后轮播/装载就用新版`
    }
  }),

  defineTool({
    name: 'draft_remove',
    label: '删底稿',
    domain: 'draft',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '删一条底稿（说法过时/违规/不想再播，删掉不可恢复）。unitId 从 draft_list 拿。' +
      '已经在池里没播的副本不受影响，要撤用 pool_revise 或等它播完；大批量删除用 draft_clear，别逐条调本工具。',
    parameters: Type.Object({
      unitId: Type.String({ description: '底稿条目 id（draft_list 拿）' })
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const programId = activeProgramId(ctx)!
      const existing = ctx.draftUnits.list(programId).find((u) => u.id === params.unitId.trim())
      if (!existing) return `找不到底稿 ${params.unitId}（用 draft_list 拿正确的 unitId）`
      ctx.draftUnits.remove(existing.id)
      return `已删底稿：「${existing.text}」`
    }
  }),

  defineTool({
    name: 'draft_clear',
    label: '清空底稿',
    domain: 'draft',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '一次清空底稿库（全部或指定场景），清完不可恢复。只有导演明确说「清空 / 全部删掉 / 清稿重写」才用。' +
      '大批量删除必须用它——逐条 draft_remove 删几百条会把上下文顶爆，还慢。返回清掉的段数。',
    parameters: Type.Object({
      sceneId: Type.Optional(Type.String({ description: '只清某个场景（draft_list/scene_list 里的场景 id）；不传 = 全场清空' }))
    }),
    handler: (ctx, params) => {
      const noPlan = requireProgram(ctx)
      if (noPlan) return noPlan
      const programId = activeProgramId(ctx)!
      const sceneId = params.sceneId?.trim()
      const before = ctx.draftUnits.list(programId).filter((u) => sceneId === undefined || u.sceneId === sceneId).length
      if (before === 0) return sceneId ? `「${sceneTitleOf(ctx, sceneId)}」本来就没有底稿` : '底稿库本来就是空的'
      ctx.draftUnits.clear(programId, sceneId)
      return sceneId
        ? `已清空「${sceneTitleOf(ctx, sceneId)}」的 ${before} 段底稿（已在池里没播的副本不受影响，要撤用 pool_revise 或等它播完）`
        : `已清空全场 ${before} 段底稿（已在池里没播的副本不受影响）。段数归零，可以重新写稿了`
    }
  })
]
