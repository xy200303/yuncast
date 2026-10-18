import { Type } from 'typebox'
import { defineTool } from './types'

/**
 * 统计域：用量看板 + 播出/互动统计 + 单场统计。
 * 对应 UI 统计页的四组查询（usageDashboard/statsGlobal/statsSession），
 * 对外部 agent 是做报表、核算成本的入口。
 */
export const statsTools = [
  defineTool({
    name: 'stats_query',
    label: '查统计',
    domain: 'stats',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '查用量与播出统计，只读无副作用。三种范围：' +
      'usage（默认）= LLM token 与 TTS 字符用量看板：今天/累计合计、近 30 天趋势、分节目用量——算成本、做用量报表用它；' +
      'global = 播出与互动统计：场次数/播出时长/评论数/互动观众、节目与主播排行、评论与话术热词——复盘选品、评估主播效果用它；' +
      'session = 单场统计：时长/播出段数/评论/观众/互动热度/来源构成/互动 TOP 观众，必须传 sessionId（session_history 拿）。' +
      'programId 可选，只统计某个节目。',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal('usage'), Type.Literal('global'), Type.Literal('session')], {
          description: 'usage 用量看板（默认）/ global 播出互动统计 / session 单场统计（要 sessionId）'
        })
      ),
      programId: Type.Optional(Type.String({ description: '只统计这个节目（program_list 拿 id）；不传 = 全部' })),
      sessionId: Type.Optional(Type.String({ description: 'scope=session 必填：场次 id（session_history 拿）' })),
      days: Type.Optional(Type.Number({ description: 'scope=global 的时间范围天数（默认 30，最大 90）', default: 30 }))
    }),
    handler: (ctx, params) => {
      const { storage } = ctx
      const scope = params.scope ?? 'usage'
      const programId = params.programId?.trim() || undefined

      if (scope === 'usage') {
        const dash = storage.usageDashboard(programId)
        return JSON.stringify(
          {
            今天: dash.today,
            累计: dash.total,
            近30天趋势: dash.trend,
            分节目: dash.byProgram
          },
          null,
          2
        )
      }

      if (scope === 'global') {
        const days = Math.max(1, Math.min(90, Math.floor(Number(params.days) || 30)))
        const stats = storage.statsGlobal({ from: Date.now() - days * 86400000, programId })
        return JSON.stringify(
          {
            范围天数: days,
            合计: stats.totals,
            播出趋势: stats.trend,
            互动趋势: stats.interactionTrend,
            节目排行: stats.byProgram,
            主播排行: stats.byCast,
            评论热词: stats.commentWords.slice(0, 20),
            话术热词: stats.speechWords.slice(0, 20)
          },
          null,
          2
        )
      }

      const sessionId = params.sessionId?.trim()
      if (!sessionId) return 'scope=session 必须传 sessionId（先用 session_history 列场次拿 id）'
      const stats = storage.statsSession(sessionId)
      if (!stats) return `场次 ${sessionId} 不存在或没有统计数据（用 session_history 拿正确的 id）`
      const hottest = [...stats.heat].sort((a, b) => b.comments + b.speech - (a.comments + a.speech)).slice(0, 10)
      return JSON.stringify(
        {
          时长分钟: Math.round(stats.durationMs / 60000),
          播出段数: stats.played,
          评论数: stats.comments,
          互动观众: stats.viewers,
          最热十分钟: hottest.map((h) => `第${h.offsetMin}分钟（评论${h.comments}·播出${h.speech}）`),
          来源构成: stats.sourceMix,
          互动TOP观众: stats.topViewers,
          评论热词: stats.commentWords.slice(0, 20)
        },
        null,
        2
      )
    }
  })
]
