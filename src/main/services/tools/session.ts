import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/**
 * 破坏性操作两段确认：内置主播（agent 侧）没 confirmed 时只发导演确认卡；
 * 外部调用（MCP/CLI）本身就是导演角色，没有确认卡机制，直接放行（返回 null）。
 */
function askConfirm(ctx: ToolCtx, summary: string): string | null {
  if (ctx.caller === 'external') return null
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
 * 场次域：历史场次的场记查询（复盘用）。
 * 合并自旧 session_history（实现原样照搬）。
 */
export const sessionTools = [
  defineTool({
    name: 'session_history',
    label: '查场次记录',
    domain: 'session',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '查历史场次的场记：每场播了什么、观众怎么互动、下播复盘摘要。只读无副作用。' +
      '不传 sessionId 返回最近场次列表（id/节目/时间/统计），详情要哪场就把列表里的 id 传进 sessionId；' +
      '传 sessionId 返回那场的详情（复盘摘要、统计、互动观众、评论与播出话术抽样）。复盘/写新稿想参考哪场，自己决定。',
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: '场次 id（列表里的）；不传 = 列最近场次' })),
      limit: Type.Optional(Type.Number({ description: '列表条数，默认 10', default: 10 }))
    }),
    handler: (ctx, params) => {
      const { storage } = ctx
      const fmtTime = (ts: number) =>
        new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      if (!params.sessionId) {
        const sessions = storage.sessionList().slice(0, params.limit ?? 10)
        if (sessions.length === 0) return '还没有任何场次记录'
        return sessions
          .map(
            (s) =>
              `${s.id}｜${s.programName}｜${fmtTime(s.startedAt)}｜播出 ${s.stats.played} · 评论 ${s.stats.comments} · 回复 ${s.stats.replies}` +
              (s.summary ? '｜有复盘' : '')
          )
          .join('\n')
      }
      const session = storage.sessionGet(params.sessionId)
      if (!session) return `没有找到场次 ${params.sessionId}`
      const lines: string[] = [
        `场次 ${session.id}｜${session.programName}｜${fmtTime(session.startedAt)} 开播` +
          (session.endedAt ? `，播了 ${Math.max(1, Math.round((session.endedAt - session.startedAt) / 60000))} 分钟` : '，进行中'),
        `统计：播出 ${session.stats.played} 条 · 评论 ${session.stats.comments} 条 · 回复 ${session.stats.replies} 条`
      ]
      if (session.summary) lines.push(`复盘摘要：${session.summary}`)
      const viewers = storage.sessionViewerAgg(session.id)
      if (viewers.length > 0) {
        lines.push(
          '互动观众：' +
            viewers.slice(0, 10).map((v) => `${v.name}（${v.count} 条）`).join('、')
        )
      }
      const comments = storage
        .sessionEvents(session.id)
        .filter((e) => e.kind === 'comment')
        .slice(-20)
      if (comments.length > 0) {
        lines.push('评论抽样（最近 20 条）：')
        for (const c of comments) lines.push(`- ${String(c.payload.author ?? '匿名')}：${String(c.payload.content ?? '')}`)
      }
      const played = storage
        .sessionSpeechItems(session.id)
        .filter((item) => item.status === 'done' || item.status === 'interrupted')
        .slice(0, 15)
      if (played.length > 0) {
        lines.push('播出话术抽样（前 15 条）：')
        for (const item of played) lines.push(`- ${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}`)
      }
      return lines.join('\n')
    }
  }),

  defineTool({
    name: 'session_export',
    label: '导出场次',
    domain: 'session',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '把某个历史场次实际播出的音频导出到本机目录：数据源是当场播出的音频文件，不重新调 TTS。' +
      'mode=merged 合并成一个文件（默认，复盘/上传播客平台用）/ separate 按播出顺序分文件；format=mp3（默认）/ wav；loudness=true 做响度归一（默认开）。' +
      '流式播报的条目没有音频文件，不在导出范围内（返回会报跳过条数）。' +
      '对外副作用：往磁盘写文件。内置主播第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。外部调用直接执行。' +
      'sessionId 从 session_history 拿，outputDir 必填（本机绝对路径）。',
    parameters: Type.Object({
      sessionId: Type.String({ description: '场次 id（session_history 拿）' }),
      outputDir: Type.String({ description: '输出目录的本机绝对路径（如 D:/out/复盘）' }),
      mode: Type.Optional(
        Type.Union([Type.Literal('merged'), Type.Literal('separate')], { description: 'merged 合并成一个文件（默认）/ separate 分文件' })
      ),
      format: Type.Optional(Type.Union([Type.Literal('mp3'), Type.Literal('wav')], { description: '默认 mp3' })),
      loudness: Type.Optional(Type.Boolean({ description: '响度归一，默认 true' })),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: async (ctx, params) => {
      const exporter = ctx.exporter
      if (!exporter) return '导出服务还没接上，让导演在界面的场次详情里用导出功能'
      const session = ctx.storage.sessionGet(params.sessionId.trim())
      if (!session) return `没有找到场次 ${params.sessionId}（用 session_history 列场次拿 id）`
      const mode = params.mode ?? 'merged'
      const format = params.format ?? 'mp3'
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `导出场次「${session.programName}」（${new Date(session.startedAt).toLocaleString('zh-CN')} 开播）的播出音频：\n` +
            `- ${mode === 'merged' ? '合并成一个文件' : '按播出顺序分文件'}，格式 ${format}，输出到 ${params.outputDir.trim()}\n` +
            `- 不重新调 TTS，不产生费用；流式播报条目无音频文件会被跳过`
        )
        if (msg) return msg
      }
      const result = await exporter.exportSession({
        sessionId: session.id,
        mode,
        format,
        outputDir: params.outputDir.trim(),
        loudness: params.loudness ?? true
      })
      if (!result.ok) return `导不了：${result.error}`
      const files = result.files ?? []
      return (
        `已导出到 ${result.outputDir ?? params.outputDir.trim()}：${files.length} 个文件` +
        (result.skippedStream ? `（${result.skippedStream} 条流式播报没有音频文件，已跳过）` : '') +
        (result.warning ? `\n注意：${result.warning}` : '') +
        `\n${files.slice(0, 20).join('\n')}${files.length > 20 ? `\n…共 ${files.length} 个` : ''}`
      )
    }
  }),

  defineTool({
    name: 'session_delete',
    label: '删场次',
    domain: 'session',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '删除一个历史场次的记录（场记/评论/播出条目一起删，不可恢复；节目本体和底稿不受影响）。' +
      '内置主播第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。外部调用直接执行。' +
      'sessionId 从 session_history 拿。',
    parameters: Type.Object({
      sessionId: Type.String({ description: '场次 id（session_history 拿）' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: (ctx, params) => {
      const session = ctx.storage.sessionGet(params.sessionId.trim())
      if (!session) return `没有找到场次 ${params.sessionId}（用 session_history 列场次拿 id）`
      if (!session.endedAt) return `这场还在播（${session.programName}），不能删：先下播再删`
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `删除场次「${session.programName}」（${new Date(session.startedAt).toLocaleString('zh-CN')} 开播）：\n` +
            `- 场记、评论记录、播出条目一起删除，不可恢复\n` +
            `- 节目本体和底稿不受影响`
        )
        if (msg) return msg
      }
      ctx.storage.sessionDelete(session.id)
      return `已删除场次「${session.programName}」（${new Date(session.startedAt).toLocaleString('zh-CN')}）的全部记录`
    }
  })
]
