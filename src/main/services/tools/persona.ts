import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/**
 * 主播卡域：人设资料的查/存/删。
 * 没有「当前出镜」概念：一场出谁由节目卡司（personaIds）决定，
 * 没配卡司就由导演逐条用 personaId 指定；主播卡只是纯资料（人设 + 嗓音）。
 */

/** 音色显示名：克隆音色按 voiceType 反查音色库，查不到原样显示标识 */
const voiceLabel = (ctx: ToolCtx, voiceId: string): string => {
  if (!voiceId.trim()) return '（未设置）'
  const found = ctx.voices?.list().find((v) => v.voiceType === voiceId.trim())
  return found ? `${found.name}（${voiceId.trim()}）` : voiceId.trim()
}

/** 这张卡是不是当前节目的卡司成员（没有卡司 = 全部卡都是候选人） */
const inProgram = (ctx: ToolCtx, personaId: string): boolean =>
  ctx.persona.programPersonas().some((p) => p.id === personaId)

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

export const personaTools = [
  defineTool({
    name: 'persona_list',
    label: '主播卡列表',
    domain: 'persona',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出全部主播卡：id、名字、性格、音色（voiceId 是合成用标识）、是否在本节目卡司里、版本号（updatedAt）。' +
      '改主播卡（persona_save）前用它拿 id。返回 JSON 数组。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const list = ctx.persona.list()
      return JSON.stringify(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          personality: p.personality,
          voiceId: p.voiceId,
          voice: voiceLabel(ctx, p.voiceId),
          inProgram: inProgram(ctx, p.id),
          updatedAt: p.updatedAt
        }))
      )
    }
  }),

  defineTool({
    name: 'persona_get',
    label: '看主播卡',
    domain: 'persona',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看一张主播卡的完整内容：人格/口癖/背景/禁区/音色，附版本号（updatedAt）。改主播卡（persona_save）之前先读它。personaId 从 persona_list 拿。',
    parameters: Type.Object({
      personaId: Type.String({ description: '主播卡 id（persona_list 拿）' })
    }),
    handler: (ctx, params) => {
      const found = ctx.persona.list().find((p) => p.id === params.personaId.trim())
      if (!found) return `主播卡 ${params.personaId} 不存在（用 persona_list 拿正确的 id）`
      return JSON.stringify({
        id: found.id,
        名称: found.name,
        性格: found.personality,
        口癖: found.catchphrases,
        背景: found.background,
        禁区: found.taboos,
        音色: voiceLabel(ctx, found.voiceId),
        在本节目卡司里: inProgram(ctx, found.id),
        版本号: found.updatedAt
      })
    }
  }),

  defineTool({
    name: 'persona_save',
    label: '存主播卡',
    domain: 'persona',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '新建或修改主播卡（名字/人格/口癖/背景/禁区/音色）。主播卡是纯资料：大脑是导演的，不在这里配；' +
      '谁上场由节目卡司决定（节目配置 personaIds），没配卡司就由你逐条用 personaId 指定。' +
      '带 personaId 是修改（没传的字段保持原样），不带 personaId 是新建（name 必填）。' +
      '改音色只影响之后新说出的内容；改人格文本当前会话不自动刷新（重开会话生效）。' +
      '修改时建议带 expectedUpdatedAt（persona_get 里的版本号）做并发保护。',
    parameters: Type.Object({
      personaId: Type.Optional(Type.String({ description: '主播卡 id：修改时必传（persona_list 拿），不传 = 新建' })),
      name: Type.Optional(Type.String({ description: '主播名字（新建必填）' })),
      personality: Type.Optional(Type.String({ description: '性格' })),
      catchphrases: Type.Optional(Type.String({ description: '口癖/口头禅' })),
      background: Type.Optional(Type.String({ description: '背景故事' })),
      taboos: Type.Optional(Type.String({ description: '禁区（绝不能说的话题/承诺）' })),
      voiceId: Type.Optional(Type.String({ description: '音色标识（voice_list 的 voiceId 字段拿）；传空字符串 = 清空' })),
      expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
    }),
    handler: (ctx, params) => {
      const existing = params.personaId ? ctx.persona.list().find((p) => p.id === params.personaId!.trim()) : undefined
      if (params.personaId && !existing) return `主播卡 ${params.personaId} 不存在（用 persona_list 拿正确的 id）`
      if (!existing && !params.name?.trim()) return '新建主播卡必须给名字（name）'
      if (!existing) {
        const dup = ctx.persona.list().find((p) => p.name === params.name!.trim())
        if (dup) return `已存在同名主播「${dup.name}」（id=${dup.id}）：要改它带 personaId 调用，别重复建`
      }
      const saved = ctx.persona.save(
        {
          name: params.name?.trim() ?? existing?.name ?? '',
          personality: params.personality ?? existing?.personality ?? '',
          catchphrases: params.catchphrases ?? existing?.catchphrases ?? '',
          background: params.background ?? existing?.background ?? '',
          taboos: params.taboos ?? existing?.taboos ?? '',
          voiceId: params.voiceId === undefined ? (existing?.voiceId ?? '') : params.voiceId.trim()
        },
        existing?.id,
        params.expectedUpdatedAt
      )
      if (!existing) {
        const castHint = inProgram(ctx, saved.id)
          ? '它已在本节目卡司里，直接按名字用 role 写词'
          : '要让它上场：在节目配置里配卡司（program_save 的 personaIds），或写词时用 personaId 指定它'
        return `已新建主播「${saved.name}」（id=${saved.id}）；${castHint}`
      }
      const effects: string[] = []
      if (existing.voiceId !== saved.voiceId) {
        effects.push('音色变了：只影响之后新说出的内容；未播的旧音色条目按现有规则重合成，已生成/已播音频不动')
      }
      if (
        existing.personality !== saved.personality ||
        existing.catchphrases !== saved.catchphrases ||
        existing.background !== saved.background ||
        existing.taboos !== saved.taboos
      ) {
        effects.push('人格文本变了：当前会话仍是旧人格，立即应用需重开会话')
      }
      return `已更新主播卡「${saved.name}」（版本号 ${saved.updatedAt}）` + (effects.length > 0 ? `。${effects.join('；')}` : '。')
    }
  }),

  defineTool({
    name: 'persona_analyze_audio',
    label: '按样本写人设',
    domain: 'persona',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '听一段人声样本，解析出「音色演法 + 性格 + 口癖 + 背景」，并把这三项人设写进指定主播卡（名字/音色/禁区不动）。' +
      'applyInstruction=true 时同时把音色指令写进她挂的克隆音色（音色库里才生效）。' +
      'samplePath 本地文件会先上传临时文件站换公网直链（样本短暂公开可访问）。返回解析结果与写入摘要。',
    parameters: Type.Object({
      personaId: Type.String({ description: '主播卡 id（persona_list 拿）' }),
      samplePath: Type.Optional(Type.String({ description: '本地样本音频路径（mp3/wav/m4a）' })),
      sampleUrl: Type.Optional(Type.String({ description: '已有公网音频地址（和 samplePath 二选一）' })),
      focus: Type.Optional(Type.String({ description: '关注点，一句话，如「深夜治愈电台，甜美女声」' })),
      model: Type.Optional(Type.String({ description: '音频理解模型（默认读设置 → 音频理解里的模型）' })),
      applyInstruction: Type.Optional(
        Type.Boolean({ description: '同时把音色指令写进她挂的克隆音色（默认 false，只写人设三栏）' })
      )
    }),
    handler: async (ctx, params) => {
      if (!ctx.audioStyle) return '音频风格解析服务没接上'
      const target = ctx.persona.list().find((p) => p.id === params.personaId.trim())
      if (!target) return `主播卡 ${params.personaId} 不存在（用 persona_list 拿正确的 id）`
      const draft = await ctx.audioStyle.analyzePersona({
        samplePath: params.samplePath,
        sampleUrl: params.sampleUrl,
        focus: params.focus,
        model: params.model
      })
      if (!draft.ok) return `解析失败：${draft.error}`
      const saved = ctx.persona.save(
        {
          name: target.name,
          personality: draft.personality || target.personality,
          catchphrases: draft.catchphrases || target.catchphrases,
          background: draft.background || target.background,
          taboos: target.taboos,
          voiceId: target.voiceId
        },
        target.id
      )
      let voiceNote = ''
      if (params.applyInstruction && draft.instruction) {
        const record = ctx.voices?.list().find((v) => v.voiceType === saved.voiceId)
        if (record) {
          const updated = ctx.voices?.update(record.id, { instruction: draft.instruction })
          voiceNote = updated?.ok
            ? `\n音色指令已写入「${record.name}」`
            : '\n音色指令写入失败（音色库没接上或音色不支持）'
        } else {
          voiceNote = '\n音色指令没写：这张卡挂的不是音色库里的克隆音色'
        }
      }
      return [
        `已按样本更新人设「${saved.name}」（${draft.model}）`,
        `性格：${saved.personality}`,
        `口癖：${saved.catchphrases || '（无）'}`,
        `背景：${saved.background}`,
        draft.instruction ? `音色指令建议：${draft.instruction}` : '',
        voiceNote,
        '会话在跑的：人设文本下次重开会话生效（可点黄条「立即应用」）'
      ]
        .filter(Boolean)
        .join('\n')
    }
  }),

  defineTool({
    name: 'persona_delete',
    label: '删主播卡',
    domain: 'persona',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '删除一张主播卡（不可恢复；它已生成的音频保留）。' +
      '内置主播第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。外部调用直接执行。personaId 从 persona_list 拿。',
    parameters: Type.Object({
      personaId: Type.String({ description: '主播卡 id（persona_list 拿）' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: (ctx, params) => {
      const target = ctx.persona.list().find((p) => p.id === params.personaId.trim())
      if (!target) return `主播卡 ${params.personaId} 不存在（用 persona_list 拿正确的 id）`
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `删除主播卡「${target.name}」：\n` +
            `- 人格/音色配置一并删除\n` +
            (inProgram(ctx, target.id) ? '- 它在本节目卡司里，删掉后节目卡司会自动少一项\n' : '') +
            `它已合成的节目音频保留，音色与知识不受影响\n不可恢复`
        )
        if (msg) return msg
      }
      ctx.persona.remove(target.id)
      return `已删除主播卡「${target.name}」`
    }
  })
]
