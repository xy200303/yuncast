import { Type } from 'typebox'
import type { PoolLane } from '../../../shared/types'
import { defineTool } from './types'
import { MARKUP_HINT, resolveVoice } from './util'

const LANE_DESC = '车道：queue 排队顺序播（默认）/ next 当前这条播完就插播（回评论、急事用）/ interrupt 打断当前立刻说 / filler 垫底（没东西播时才轮到）'
const SPEAKER_DESC = '这句是谁的词：填主播卡 id（persona_list 的 id / program_get「卡司」里的 id）。不传 = 卡司第一张；没配卡司时必须传'
const VOICE_DESC = '直接指定音色 id（voice_list 返回的 voiceType）：一般不用传，用它就不看 speaker 的卡了'

/**
 * 播报域：开口说话 + 话术池管理 + 播出控制。
 * 合并自旧 say/insert_next/agent_say_on_air/get_pool_status/get_recent_played/revise_item/
 * pause_broadcast/resume_broadcast/skip_current/mark_live_events（set_gap 已随全局留白一起移除，段后停顿走 pauseAfterMs）。
 */
export const speechTools = [
  defineTool({
    name: 'speak',
    label: '说',
    domain: 'speech',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '开口说话：排进话术池播出，会真的出声，直播间观众听得到。' +
      '回评论/过渡/互动用一句完整口语；完整桥段（故事/讲解，多句 150~350 字）整段一次传入，别拆成单句多次调（语气会断）。' +
      '内置主播注意：没开播或播报暂停时会被拒，备稿用 draft_add/draft_write。' +
      '外部调用可用 speaker（主播卡 id）指定卡司里的哪张卡出声，或 voiceId 直接指定音色。返回队列条目 id，没播前想改用 pool_revise。',
    parameters: Type.Object({
      text: Type.String({ description: `要说的话：一句短评，或一整段桥段。${MARKUP_HINT}` }),
      lane: Type.Optional(
        Type.Union([Type.Literal('queue'), Type.Literal('next'), Type.Literal('interrupt'), Type.Literal('filler')], {
          description: LANE_DESC
        })
      ),
      speaker: Type.Optional(Type.String({ description: SPEAKER_DESC })),
      voiceId: Type.Optional(Type.String({ description: VOICE_DESC })),
      delivery: Type.Optional(
        Type.String({ description: '表演指示（情绪/语气，一句话，如「压低声音像说悄悄话」）——会真的拿去控制合成语气，模型支持语气指令才生效' })
      ),
      rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3）：催单加快、讲故事放慢' })),
      pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守）：激动拔高、悄悄话压低' })),
      emotion: Type.Optional(
        Type.String({ description: '情感（仅火山模型生效）：happy / angry / sad / surprised 等，留空 = 接入默认' })
      ),
      emotionScale: Type.Optional(
        Type.Number({ description: '情感强度（火山 emotion_scale，1~5，默认 4）：只在传了 emotion 时生效' })
      ),
      languageType: Type.Optional(
        Type.String({ description: '语种提示（仅百炼 qwen3-tts 生效）：Auto / Chinese / English 等，留空 = 接入默认' })
      ),
      pauseAfterMs: Type.Optional(
        Type.Number({
          description:
            '播完这条后的停顿毫秒（0~10000，默认 0 = 紧接着播下一条）。播放时调度，不进合成；段内停顿用 <pause> 演法标记。章节换气/悬念留白用它'
        })
      )
    }),
    handler: (ctx, params) => {
      if (ctx.caller === 'agent') {
        if (!ctx.isLiveActive?.()) return '还没开播：播出通道关着，备稿用 draft_write/draft_add 入库'
        if (ctx.getSpeakingPaused?.()) return '播报已暂停：说的话暂时播不出去，等导演恢复再说'
      }
      const voiceId = resolveVoice(ctx.persona, params.speaker, params.voiceId)
      if (!voiceId) {
        return '没指定谁说的，节目也没配卡司：speak 传 speaker（主播卡 id），或先给节目配卡司'
      }
      const lane = params.lane ?? 'queue'
      const pauseAfterMs =
        params.pauseAfterMs === undefined
          ? undefined
          : Math.max(0, Math.min(10000, Math.floor(Number(params.pauseAfterMs) || 0)))
      if (lane === 'next') {
        const comment = ctx.getLastComment?.()
        const replyTo = comment ? { commentId: comment.id, author: comment.author } : undefined
        const item = ctx.pool.insertNext({
          text: params.text,
          voiceId,
          delivery: params.delivery,
          rate: params.rate,
          pitch: params.pitch,
          emotion: params.emotion,
          emotionScale: params.emotionScale,
          languageType: params.languageType,
          pauseAfterMs,
          sourceAgentId: ctx.caller === 'agent' ? 'anchor' : undefined,
          sourceKind: 'reply' as const,
          replyTo
        })
        return `已插播（条目 ${item.id}）：「${params.text}」`
      }
      const item = ctx.pool.say({
        text: params.text,
        voiceId,
        delivery: params.delivery,
        rate: params.rate,
        pitch: params.pitch,
        emotion: params.emotion,
        emotionScale: params.emotionScale,
        languageType: params.languageType,
        pauseAfterMs,
        lane: lane as PoolLane,
        sourceAgentId: ctx.caller === 'agent' ? 'anchor' : undefined,
        sourceKind: ctx.caller === 'agent' ? 'scene' : 'manual'
      })
      return `已排进队列（条目 ${item.id}，车道 ${item.lane}）：「${params.text}」${params.speaker ? `（${params.speaker}）` : ''}${pauseAfterMs ? `，播完停 ${pauseAfterMs}ms` : ''}`
    }
  }),

  defineTool({
    name: 'pool_status',
    label: '看话术池',
    domain: 'speech',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '查看话术池：各车道未播条数、正在播什么、未播条目的 id 和文本（pool_revise 要用 id）。队列快空了就主动补货。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const status = ctx.pool.getStatus()
      const pending = ctx.pool
        .snapshot()
        .items.filter((item) => item.status !== 'playing')
        .slice(0, 10)
        .map((item) => ({ id: item.id, lane: item.lane, status: item.status, text: item.text, pauseAfterMs: item.pauseAfterMs }))
      return JSON.stringify({
        未播总数: status.active,
        分车道: status.byLane,
        正在播: status.playing ? { id: status.playing.id, text: status.playing.text } : null,
        未播条目: pending
      })
    }
  }),

  defineTool({
    name: 'pool_recent',
    label: '回看已播',
    domain: 'speech',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description: '回看最近播出的 n 条话术，避免重复和自相矛盾。',
    parameters: Type.Object({
      n: Type.Optional(Type.Number({ description: '条数，默认 5', default: 5 }))
    }),
    handler: (ctx, params) => {
      const played = ctx.pool.getRecentPlayed(params.n ?? 5)
      if (played.length === 0) return '还没有播过任何话术'
      return played.map((item, i) => `${i + 1}. ${item.text}`).join('\n')
    }
  }),

  defineTool({
    name: 'pool_revise',
    label: '修订未播话术',
    domain: 'speech',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '修订话术池里还没播的条目：作废旧音频重合成。价格/库存/口径变了就用它改腹稿；也可以只调段后停顿（pauseAfterMs）。正在播和已播的不能改（说出去的话泼出去的水）。条目 id 从 pool_status 拿。',
    parameters: Type.Object({
      itemId: Type.String({ description: '要修订的条目 id' }),
      text: Type.String({ description: '修订后的文本' }),
      pauseAfterMs: Type.Optional(
        Type.Number({ description: '播完这条后的停顿毫秒（0~10000，0 = 连续播）；不传 = 保持原值' })
      )
    }),
    handler: (ctx, params) => {
      const pauseAfterMs =
        params.pauseAfterMs === undefined
          ? undefined
          : Math.max(0, Math.min(10000, Math.floor(Number(params.pauseAfterMs) || 0)))
      ctx.pool.revise(params.itemId, params.text, pauseAfterMs !== undefined ? { pauseAfterMs } : undefined)
      return `已修订 ${params.itemId}：「${params.text}」${pauseAfterMs !== undefined ? `（段后停顿 ${pauseAfterMs}ms）` : ''}`
    }
  }),

  defineTool({
    name: 'pool_revoke',
    label: '撤条目',
    domain: 'speech',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '撤销一条还没播的话术：从池里撤掉不播了（标为 skipped，可逆性等同删除队列条目，原底稿不受影响）。' +
      '在播或播完的撤不了——在播的要掐用 broadcast_control skip。条目 id 从 pool_status 的未播条目里拿。',
    parameters: Type.Object({
      itemId: Type.String({ description: '要撤销的队列条目 id（pool_status 拿）' })
    }),
    handler: (ctx, params) => {
      const id = params.itemId.trim()
      const item = ctx.pool.snapshot().items.find((i) => i.id === id)
      if (!item) return `队列里没有条目 ${id}（用 pool_status 看未播条目；已播完的条目撤不了也不用撤）`
      try {
        ctx.pool.revoke(id)
      } catch (err) {
        return `撤不了：${err instanceof Error ? err.message : String(err)}`
      }
      return `已撤销条目 ${id}：「${item.text.slice(0, 40)}${item.text.length > 40 ? '…' : ''}」不会播了`
    }
  }),

  defineTool({
    name: 'pool_reorder',
    label: '调顺序',
    domain: 'speech',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '调整未播话术的播出顺序：把要排的条目 id 按想要的顺序传入，没传的未播条目按原顺序跟在后面。' +
      '只对未播条目生效（在播/已播的不动）。条目 id 从 pool_status 拿。把某条提前 = 把它放 ids 第一个。',
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: '未播条目 id 按新顺序排列（pool_status 拿 id）' })
    }),
    handler: (ctx, params) => {
      const given = params.ids.map((id) => id.trim()).filter(Boolean)
      if (given.length === 0) return 'ids 是空的：把 pool_status 里的未播条目 id 按新顺序传进来'
      const activeIds = ctx.pool
        .snapshot()
        .items.filter((i) => i.status !== 'playing')
        .map((i) => i.id)
      const valid = given.filter((id) => activeIds.includes(id))
      if (valid.length === 0) return `传入的 id 都不在未播队列里（用 pool_status 拿当前未播条目的 id）`
      const ordered = [...valid, ...activeIds.filter((id) => !valid.includes(id))]
      ctx.pool.reorder(ordered)
      return `已重排未播条目：${valid.length} 条按给出的顺序排前${ordered.length > valid.length ? `，其余 ${ordered.length - valid.length} 条按原顺序跟在后面` : ''}`
    }
  }),

  defineTool({
    name: 'broadcast_control',
    label: '播出控制',
    domain: 'speech',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '播出控制：pause 暂停播报（池里内容保留，主播产出一起停）/ resume 恢复接着播 / skip 掐掉正在播的这条直接播下一条（说错了、卡住了、内容过时了用）/ ' +
      'clear 清空某条车道的未播条目（在播的不受影响；返工重来、换内容方向时用，清空后记得用 speak/draft 补货，不然冷场）。直接影响正在播出或待播出的内容。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('pause'), Type.Literal('resume'), Type.Literal('skip'), Type.Literal('clear')], {
        description: 'pause 暂停 / resume 恢复 / skip 跳过当前这条 / clear 清空车道未播条目'
      }),
      lane: Type.Optional(
        Type.Union([Type.Literal('queue'), Type.Literal('next'), Type.Literal('interrupt'), Type.Literal('filler')], {
          description: 'action=clear 时清哪条车道，默认 queue（正常排队车道）'
        })
      )
    }),
    handler: (ctx, params) => {
      if (params.action === 'clear') {
        const laneMap = { queue: 'normal', next: 'next', interrupt: 'interrupt', filler: 'filler' } as const
        const lane = laneMap[params.lane ?? 'queue']
        const count = ctx.pool.snapshot().items.filter((i) => i.lane === lane && i.status !== 'playing').length
        ctx.pool.clearLane(lane)
        return `已清空 ${params.lane ?? 'queue'} 车道的 ${count} 条未播条目（在播的不受影响）——记得补货，不然要冷场`
      }
      if (ctx.caller === 'agent') {
        if (!ctx.onPlaybackControl) return '播出控制没接上，让导演在界面操作'
        ctx.onPlaybackControl(params.action)
      } else {
        if (params.action === 'pause') ctx.setPaused?.(true)
        else if (params.action === 'resume') ctx.setPaused?.(false)
        else ctx.skipCurrent?.()
      }
      return params.action === 'pause'
        ? '已暂停播报（池里的内容保留）——主播现在说不出去，等恢复'
        : params.action === 'resume'
          ? '已恢复播报'
          : '已跳过当前这条'
    }
  }),

  defineTool({
    name: 'inbox_mark',
    label: '标记动态',
    domain: 'speech',
    risk: 'write',
    expose: { agent: true },
    description:
      '标记直播间动态批次的处理结果：回过的标 handled，不想理的标 ignored。不标也行——5 分钟后自动过期，不会再提醒。事件 id 在每批动态列表每条的 [方括号] 里。',
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: '动态 id 列表（批次里每条的 [le-xxx]）' }),
      state: Type.Union([Type.Literal('handled'), Type.Literal('ignored')], {
        description: 'handled=已回应，ignored=不理'
      })
    }),
    handler: (ctx, params) => ctx.markLiveEvents?.(params.ids, params.state) ?? '收件箱没接上'
  })
]
