import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Type } from 'typebox'
import { TTS_PROVIDER_SHORT, type VoiceRecord } from '../../../shared/types'
import { defineTool, type ToolCtx } from './types'
import { compareVoiceMetrics } from '../audio/voiceMetrics'

/**
 * 音色域：音色库查/改名/改风格指令/删/克隆 + 外部合成。
 * 合并自旧 list_voices/get_voice/rename_voice/delete_voice/start_voice_clone
 * 与 MCP tts_voices/tts_synthesize/tts_connections。
 */

function voiceStatusLabel(v: VoiceRecord): string {
  if (v.status === 'ready') return '可用'
  if (v.status === 'failed') return `失败（${v.error || '原因未知'}）`
  return '训练中'
}

/** 列表行的公共形状（voice_list/voice_get 共用）：MCP 的 voiceId/name/provider/model/status/cloned + 记录 id 与接入名 */
function voiceRow(ctx: ToolCtx, v: VoiceRecord): Record<string, unknown> {
  return {
    id: v.id,
    voiceId: v.voiceType,
    name: v.name,
    provider: v.provider,
    providerLabel: TTS_PROVIDER_SHORT[v.provider] ?? v.provider,
    model: v.model,
    status: v.status,
    statusLabel: voiceStatusLabel(v),
    cloned: true,
    instruction: v.instruction || undefined,
    connection: ctx.storage.ttsConnectionGet(v.connectionId)?.name ?? `${v.connectionId}（已删除）`,
    error: v.error || undefined,
    updatedAt: v.updatedAt
  }
}

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

export const voiceTools = [
  defineTool({
    name: 'voice_list',
    label: '音色列表',
    domain: 'voice',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出音色库全部音色：id（音色库记录 id，voice_get/voice_update/voice_delete 用它）、voiceId（合成用标识 voiceType，tts_synthesize 的 voiceId 和 speak 的 voiceId 从这里取）、' +
      '名称、服务商、模型、训练状态（training/ready/failed）、风格指令（instruction，没配则无此字段）、所属接入、版本号。换音色或删音色前用它拿 id。返回 JSON 数组。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const svc = ctx.voices
      if (!svc) return '音色服务还没初始化'
      const list = svc.list()
      if (list.length === 0) return '音色库是空的：音色由导演在音色库页录制/克隆（或用 voice_clone_start 发起克隆）'
      return JSON.stringify(list.map((v) => voiceRow(ctx, v)), null, 2)
    }
  }),

  defineTool({
    name: 'voice_get',
    label: '看音色',
    domain: 'voice',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看一个音色的完整信息和引用关系：哪些主播卡在用（卡司成员）、哪些节目卡司里有它、多少条底稿用它、未播队列里有没有它。' +
      '删音色（voice_delete）前必须先查这个。voiceId 参数传音色库记录 id（voice_list 的 id 字段）。',
    parameters: Type.Object({
      voiceId: Type.String({ description: '音色库记录 id（voice_list 返回的 id 字段，不是合成标识 voiceId）' })
    }),
    handler: (ctx, params) => {
      const svc = ctx.voices
      if (!svc) return '音色服务还没初始化'
      const voice = svc.list().find((v) => v.id === params.voiceId.trim())
      if (!voice) return `音色 ${params.voiceId} 不存在（用 voice_list 拿正确的 id）`
      const usage = svc.usage(voice.id)
      const queueRefs = voice.voiceType
        ? ctx.pool.snapshot().items.filter((i) => i.voiceId === voice.voiceType).length
        : 0
      return JSON.stringify(
        {
          ...voiceRow(ctx, voice),
          音色标识: voice.voiceType || '（训练未完成，还没有标识）',
          授权时间: voice.authorizedAt ? new Date(voice.authorizedAt).toLocaleString() : '（未记录）',
          引用: {
            主播卡: usage.personas.map((p) => p.name),
            在节目卡司里: usage.programs.map((p) => p.name),
            底稿条目数: usage.draftUnitCount,
            底稿示例: usage.draftUnitSamples.map((s) => `「${s.programName}」${s.text.slice(0, 40)}`),
            未播队列条目数: queueRefs
          }
        },
        null,
        2
      )
    }
  }),

  defineTool({
    name: 'voice_update',
    label: '改音色',
    domain: 'voice',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '改音色的显示名和/或风格指令（instruction：≤100 字的自然语言演法底色，如「年轻活泼的女性，语速较快，带货场景」）。' +
      '风格指令生效范围：阿里云百炼支持 instruction 的模型、火山 seed-tts-2.0（走语音指令）；火山复刻音色（seed-icl-2.0）不支持，写了也不发。' +
      '只影响之后的新合成（已合成的音频不动）；节目级/agent 逐条指定的指令优先级更高。name 和 instruction 至少传一个。voiceId 传音色库记录 id（voice_list 的 id 字段）。',
    parameters: Type.Object({
      voiceId: Type.String({ description: '音色库记录 id（voice_list 的 id 字段）' }),
      name: Type.Optional(Type.String({ description: '新显示名' })),
      instruction: Type.Optional(
        Type.String({ description: '风格指令（≤100 字；传空字符串 = 清除）' })
      )
    }),
    handler: (ctx, params) => {
      const svc = ctx.voices
      if (!svc) return '音色服务还没初始化'
      const patch: { name?: string; instruction?: string } = {}
      if (params.name !== undefined) patch.name = params.name
      if (params.instruction !== undefined) patch.instruction = params.instruction
      if (Object.keys(patch).length === 0) return 'name 和 instruction 至少传一个'
      const result = svc.update(params.voiceId, patch)
      if (!result.ok) return `改音色失败：${result.error}`
      const changed = [
        patch.name !== undefined ? `名字→「${patch.name.trim()}」` : null,
        patch.instruction !== undefined
          ? patch.instruction.trim()
            ? `风格指令→「${patch.instruction.trim()}」`
            : '风格指令已清除'
          : null
      ].filter(Boolean)
      return `已更新音色：${changed.join('，')}（对之后的新合成生效）`
    }
  }),

  defineTool({
    name: 'voice_delete',
    label: '删音色',
    domain: 'voice',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '从音色库删除一个音色（登记删除，不可恢复；已生成的音频文件保留，后续合成需重选音色）。' +
      '被主播卡/节目卡司/未播队列引用的音色删不了——返回值会列出谁在引用、先怎么解。删之前先用 voice_get 看引用。' +
      '内置主播第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。外部调用直接执行。voiceId 参数传音色库记录 id。',
    parameters: Type.Object({
      voiceId: Type.String({ description: '音色库记录 id（voice_list 的 id 字段）' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: async (ctx, params) => {
      const svc = ctx.voices
      if (!svc) return '音色服务还没初始化'
      const voice = svc.list().find((v) => v.id === params.voiceId.trim())
      if (!voice) return `音色 ${params.voiceId} 不存在（用 voice_list 拿正确的 id）`
      const usage = svc.usage(voice.id)
      const queueRefs = voice.voiceType
        ? ctx.pool.snapshot().items.filter((i) => i.voiceId === voice.voiceType).length
        : 0
      const blockers: string[] = []
      if (usage.personas.length > 0) {
        blockers.push(`主播卡：${usage.personas.map((p) => p.name).join('、')}`)
      }
      if (usage.programs.length > 0) blockers.push(`在节目卡司里：${usage.programs.map((p) => p.name).join('、')}`)
      if (queueRefs > 0) blockers.push(`未播队列：${queueRefs} 条`)
      if (blockers.length > 0) {
        return (
          `删不了：音色「${voice.name}」还在被引用——\n${blockers.map((b) => `- ${b}`).join('\n')}\n` +
          `先解掉引用（persona_save 换音色 / program_save 改卡司 / pool_revise 修订队列条目），再删除`
        )
      }
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `删除音色「${voice.name}」（${TTS_PROVIDER_SHORT[voice.provider] ?? voice.provider} / ${voice.model}，${voiceStatusLabel(voice)}）：\n` +
            `- 没有被主播/节目/队列引用；${usage.draftUnitCount > 0 ? `底稿库里有 ${usage.draftUnitCount} 条旧底稿用过它（不受影响，重播时按当前音色合成）` : '底稿库也没有引用'}\n` +
            `- 已生成的音频文件保留\n不可恢复的是音色登记本身`
        )
        if (msg) return msg
      }
      const result = await svc.remove(voice.id)
      return result.ok ? `已删除音色「${voice.name}」（已生成的音频文件保留）` : `删除失败：${result.error}`
    }
  }),

  defineTool({
    name: 'voice_clone_start',
    label: '克隆音色',
    domain: 'voice',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '发起音色克隆训练（对外副作用：消耗服务商克隆额度，克隆音色首次合成即可能计费）。' +
      '合规底线：authorized 必须为 true（确认已获得录音人授权），否则拒绝。' +
      '内置主播第一次调用不传 confirmed：向导演发确认卡（写清接入/模型/样本/计费提示）；确认后带 confirmed=true 重调才真正提交。外部调用直接提交。' +
      '返回新音色记录 id，状态训练中——用 voice_get 查进度，ready 就能用。',
    parameters: Type.Object({
      name: Type.String({ description: '新音色名称' }),
      connectionId: Type.String({ description: '用哪条语音合成接入的凭据克隆（tts_connections 或系统状态工具拿）' }),
      model: Type.String({ description: '克隆目标模型 id（该接入下支持复刻的模型，如火山 seed-icl 系）' }),
      samplePath: Type.Optional(Type.String({ description: '本地样本音频路径（火山必填；导演提供）' })),
      sampleUrl: Type.Optional(Type.String({ description: '公网可访问的样本地址（百炼必填）' })),
      authorized: Type.Boolean({ description: '已确认获得录音人授权 = true，否则拒绝' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: async (ctx, params) => {
      const svc = ctx.voices
      if (!svc) return '音色服务还没初始化'
      if (!params.authorized) {
        return '拒绝：克隆必须先确认「已获得录音人授权」（authorized=true）。没有授权不能发起克隆'
      }
      if (!params.samplePath?.trim() && !params.sampleUrl?.trim()) {
        return '需要样本：本地样本路径 samplePath（火山）或公网地址 sampleUrl（百炼）——让导演在音色库页录制/上传后给你路径'
      }
      const connection = ctx.storage.ttsConnectionGet(params.connectionId.trim())
      if (!connection) return `语音合成接入 ${params.connectionId} 不存在（用 tts_connections 看现有接入）`
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `发起声音克隆：\n` +
            `- 音色名「${params.name.trim()}」，接入「${connection.name}」，模型 ${params.model}\n` +
            `- 样本：${params.samplePath?.trim() || params.sampleUrl?.trim()}\n` +
            `- 已确认获得录音人授权\n` +
            `注意：会消耗服务商克隆额度，克隆音色首次合成即可能计费（后付费模式）`
        )
        if (msg) return msg
      }
      const result = await svc.clone({
        name: params.name,
        connectionId: connection.id,
        model: params.model,
        samplePath: params.samplePath?.trim() || undefined,
        sampleUrl: params.sampleUrl?.trim() || undefined,
        authorized: true
      })
      if (!result.ok) return `克隆没发起来：${result.error}`
      return `已发起克隆训练：「${result.voice.name}」（id=${result.voice.id}），状态训练中——用 voice_get 查进度，ready 就能用`
    }
  }),

  defineTool({
    name: 'voice_calibrate',
    label: '校准音色参数',
    domain: 'voice',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '克隆 AB 验收 + 参数校准：测目标样本（基频/语速/气声/停顿/响度），用**样本原话**让当前音色合成一遍并同样实测，' +
      '给 0~100 的相似分与逐维差异，自动迭代出最贴的 rate/pitch（语速进 8% 容差就停）。' +
      'applyInstruction=true 时把解析出的新指令写进音色；返回的 rate 就是该音色的"本速基准"（下次 speak/draft_write 传它）。' +
      'samplePath 本地文件会先上传临时文件站换公网直链。',
    parameters: Type.Object({
      voiceId: Type.String({ description: '音色库记录 id（voice_list 的 id）' }),
      samplePath: Type.Optional(Type.String({ description: '目标样本本地路径（mp3/wav/m4a）' })),
      sampleUrl: Type.Optional(Type.String({ description: '目标样本公网地址（和 samplePath 二选一）' })),
      text: Type.Optional(Type.String({ description: '探针文本（默认一句 25 字左右的朗读句）' })),
      instruction: Type.Optional(Type.String({ description: '本次合成用的指令（默认用音色上已有的）' })),
      rate: Type.Optional(Type.Number({ description: '本次合成语速倍率（默认 1.0）' })),
      pitch: Type.Optional(Type.Number({ description: '本次合成音调倍率（默认 1.0）' })),
      applyInstruction: Type.Optional(Type.Boolean({ description: '把解析出的新指令写进音色（默认 false）' })),
      useSampleText: Type.Optional(
        Type.Boolean({
          description: '用样本的原话做探针文本（默认 true，语速对比才严谨；false 用 text 或默认句）'
        })
      ),
      autoTune: Type.Optional(
        Type.Boolean({ description: '自动迭代：按建议 rate 再合一次并复测，直到语速进容差（默认 true，最多 2 轮）' })
      )
    }),
    handler: async (ctx, params) => {
      if (!ctx.audioStyle) return '音频风格解析服务没接上'
      if (!ctx.tts) return '语音合成服务没接上'
      const record = ctx.voices?.list().find((v) => v.id === params.voiceId.trim())
      if (!record) return `音色 ${params.voiceId} 不存在（用 voice_list 拿正确的 id）`
      const analysis = await ctx.audioStyle.analyze({
        samplePath: params.samplePath,
        sampleUrl: params.sampleUrl,
        scene: '真实节目/直播场景，正常发声位置与音量'
      })
      if (!analysis.ok) return `解析失败：${analysis.error}`
      const target = analysis.metrics
      if (!target) return '目标样本测量失败（可能是静音或格式不支持）'
      // 探针文本优先用样本原话：不同字数的句子语速不可比（"你好"和"今晚我们慢慢聊"字/秒差一大截）
      let text = params.text?.trim() ?? ''
      const useSampleText = params.useSampleText !== false
      if (!text && useSampleText) {
        const heard = await ctx.audioStyle.transcribe({
          samplePath: params.samplePath,
          sampleUrl: params.sampleUrl
        })
        if (heard.ok && heard.text.trim()) text = heard.text.trim()
      }
      if (!text) text = '晚上好，欢迎收听今晚的节目，我们慢慢聊，不着急。'
      // 探针文本里的演法标记会干扰测量（停顿/情绪不是音色本身），先剥掉
      const plainText = text.replace(/<[^>]+>/g, '')
      const chars = (plainText.match(/[一-鿿]/g) ?? []).length
      const instruction = params.instruction?.trim() || record.instruction || analysis.style
      let rate = params.rate ?? 1
      const pitch = params.pitch ?? 1

      const runProbe = async (): Promise<{ path: string; metrics: Awaited<ReturnType<typeof ctx.audioStyle.measure>>; cps: number }> => {
        const path = await ctx.tts!.synthesize(`calib-${Date.now()}`, plainText, record.voiceType, undefined, {
          instruction,
          rate,
          pitch
        })
        const metrics = await ctx.audioStyle!.measure(path)
        const cps = metrics.speechSeconds > 0 ? chars / metrics.speechSeconds : 0
        return { path, metrics, cps }
      }

      let probe = await runProbe()
      const rateLimit = { min: 0.85, max: 1.3 }
      const autoTune = params.autoTune !== false
      let rounds = 1
      let tunedRate: number | null = null
      // 自动迭代：语速差超过 8% 就按比例再合一遍，最多 2 轮（每次合成都是真花钱，别无限试）
      while (autoTune && rounds < 3 && target.charsPerSec > 0 && probe.cps > 0) {
        const ratio = target.charsPerSec / probe.cps
        if (Math.abs(ratio - 1) <= 0.08) break
        const next = Math.min(rateLimit.max, Math.max(rateLimit.min, Number((rate * ratio).toFixed(2))))
        if (next === rate) break
        rate = next
        tunedRate = next
        probe = await runProbe()
        rounds++
      }

      const comparison = compareVoiceMetrics(target, { ...probe.metrics, charsPerSec: Number(probe.cps.toFixed(2)) }, target.charsPerSec)
      // 语速撞到 TTS 的 rate 上下限还差一截：别假装调好了，给可执行的补偿办法（补停顿）
      const atRateEdge = rate <= rateLimit.min || rate >= rateLimit.max
      const cpsGap = target.charsPerSec > 0 && probe.cps > 0 ? target.charsPerSec / probe.cps : 1
      let speedNote = ''
      if (Math.abs(cpsGap - 1) > 0.08) {
        const sentences = Math.max(1, (plainText.match(/[。！？!?]/g) ?? []).length)
        const needMs = Math.round((chars / target.charsPerSec - chars / probe.cps) / sentences * 1000)
        const pctOff = Math.abs(Math.round((1 / cpsGap - 1) * 100))
        const core = atRateEdge
          ? `语速已到 rate ${rateLimit.min}~${rateLimit.max} 的边界（当前 ${rate}）仍差 ${pctOff}%：这个音色的本速和人声本来就差这么多，硬压会失真。`
          : `语速还差 ${pctOff}%：把 rate 改到 ${Math.min(rateLimit.max, Math.max(rateLimit.min, Number((rate * cpsGap).toFixed(2))))} 再合成。`
        speedNote =
          core +
          (needMs > 0
            ? `\n    更好的补偿：正文每句后加 <pause>${Math.min(800, Math.max(120, needMs))}</pause> 把气口补回来（目标停顿 ${Math.round((target.silenceRatio ?? 0) * 100)}%，实测 ${Math.round((probe.metrics.silenceRatio ?? 0) * 100)}%）。`
            : '')
      }
      const pitchRatio = target.f0Median && probe.metrics.f0Median ? target.f0Median / probe.metrics.f0Median : 1
      const pitchSuggestion =
        Math.abs(pitchRatio - 1) >= 0.03
          ? Math.min(1.1, Math.max(0.9, Number((pitchRatio * pitch).toFixed(2))))
          : null
      if (params.applyInstruction && analysis.style) {
        const updated = ctx.voices?.update(record.id, { instruction: analysis.style })
        if (updated && !updated.ok) return `音色指令写入失败：${updated.error}`
      }
      const fmt = (m: typeof target, label: string) =>
        `${label}：时长 ${m.duration}s / 发声 ${m.speechSeconds}s / 停顿 ${Math.round(m.silenceRatio * 100)}% / ` +
        `语速 ${m.charsPerSec} 字每秒 / 基频中位 ${m.f0Median ?? '—'}Hz（${m.f0P10 ?? '—'}~${m.f0P90 ?? '—'}） / ` +
        `浊音占比 ${m.voicedRatio ?? '—'} / 起伏 ${m.energyStd ?? '—'}dB`
      const dimLines = comparison.dims.map(
        (d) =>
          `- ${d.ok ? '✅' : '⚠️'} ${d.label}：目标 ${d.target ?? '—'} → 实测 ${d.actual ?? '—'}` +
          `（${d.ok ? '在容差内' : d.hint}）`
      )
      return [
        `克隆验收「${record.name}」（${analysis.model}）· 相似分 ${comparison.score}/100 —— ${comparison.verdict}`,
        fmt(target, '目标样本'),
        fmt({ ...probe.metrics, charCount: chars, charsPerSec: Number(probe.cps.toFixed(2)) }, `当前合成（rate=${rate}${rounds > 1 ? `，自动调过 ${rounds - 1} 轮` : ''}）`),
        '',
        '逐维对比：',
        ...dimLines,
        '',
        `建议：rate=${rate}${tunedRate ? '（已自动试到这个值）' : ''}，pitch=${pitchSuggestion ?? '保持 1.0'}` +
          `——rate 是这个音色的本速基准，之后 speak/draft_write 默认带它，只有要更急/更慢时才改`,
        speedNote,
        `探针文本（${chars} 字）：${plainText.slice(0, 60)}${plainText.length > 60 ? '…' : ''}`,
        analysis.style ? `解析出的指令：${analysis.style}${params.applyInstruction ? '（已写入音色）' : ''}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    }
  }),

  defineTool({
    name: 'voice_transcribe',
    label: '听音频转写',
    domain: 'voice',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '听一段人声，返回逐字转写 + 分句表演标注（每句什么语气/哪儿停顿/语速快慢）+ 整体听感。' +
      '和 voice_analyze_style 的分工：那个只产出下给 TTS 的表演指令（明确不许复述原文），' +
      '这个要的就是原文和现场演法，用来人工对照"复刻得像不像真人"、或从真人录音里提炼演法。' +
      'samplePath 是本地文件时会先上传临时文件站换公网直链（样本短暂公开可访问）。',
    parameters: Type.Object({
      samplePath: Type.Optional(Type.String({ description: '本地样本音频路径（mp3/wav/m4a）' })),
      sampleUrl: Type.Optional(Type.String({ description: '已有公网音频地址（和 samplePath 二选一）' })),
      model: Type.Optional(Type.String({ description: '音频理解模型（默认读设置 → 音频理解里的模型）' }))
    }),
    handler: async (ctx, params) => {
      if (!ctx.audioStyle) return '音频理解服务没接上'
      const result = await ctx.audioStyle.transcribe({
        samplePath: params.samplePath,
        sampleUrl: params.sampleUrl,
        model: params.model
      })
      if (!result.ok) return `转写失败：${result.error}`
      const lines: string[] = [`转写（${result.model}，${result.text.length} 字）：`, result.text]
      if (result.cues.length > 0) {
        lines.push('', '分句演法：')
        for (const cue of result.cues) {
          lines.push(`- ${cue.line}${cue.pauseMs ? ` 〔停顿 ${cue.pauseMs}ms〕` : ''} → ${cue.delivery || '（未标注）'}`)
        }
      }
      if (result.overall) lines.push('', `整体听感：${result.overall}`)
      if (result.sampleUrl) lines.push('', `本次样本地址：${result.sampleUrl}（临时，过期失效）`)
      lines.push('', '要落成合成参数：演法用 voice_update 的 instruction（或节目的 instruction），停顿写成正文里的 <pause>600</pause>，情绪用 <cot text=情绪>句子</cot>')
      return lines.join('\n')
    }
  }),

  defineTool({
    name: 'voice_analyze_style',
    label: '解析声音风格',
    domain: 'voice',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '听一段人声样本，用百炼 Qwen-Audio 解析她的演法，返回 ≤100 字的风格指令建议——可直接用 voice_update 写进音色 instruction，或用作节目风格指令（program_save 的 instruction）。' +
      'samplePath 是本地文件时会先上传临时文件站换公网直链（样本短暂公开可访问），sampleUrl 则直接用已有地址。' +
      'focus 可指定关注点（如「甜美系，重点听句尾和气息」）；model 默认 qwen3.8-omni-flash（可换 qwen3.5-omni-flash / qwen3-omni-flash）。',
    parameters: Type.Object({
      samplePath: Type.Optional(Type.String({ description: '本地样本音频路径（mp3/wav/m4a）' })),
      sampleUrl: Type.Optional(Type.String({ description: '已有公网音频地址（和 samplePath 二选一）' })),
      scene: Type.Optional(
        Type.String({ description: '真实使用场景（强烈建议传）：如「深夜治愈电台朗读，正常音量、正常发声位置，像日常说话」——按场景判断真实音量/语速，避免把气声当耳语' })
      ),
      focus: Type.Optional(Type.String({ description: '解析关注点，一句话，如「甜美治愈系，音色/语速/句尾习惯」' })),
      model: Type.Optional(Type.String({ description: '音频理解模型（默认 qwen3.8-omni-flash；也可 qwen3.5-omni-flash / qwen3-omni-flash）' }))
    }),
    handler: async (ctx, params) => {
      if (!ctx.audioStyle) return '音频风格解析服务没接上'
      const result = await ctx.audioStyle.analyze({
        samplePath: params.samplePath,
        sampleUrl: params.sampleUrl,
        scene: params.scene,
        focus: params.focus,
        model: params.model
      })
      if (!result.ok) return `解析失败：${result.error}`
      const lines = [`风格指令建议（${result.model}，${result.style.length} 字）：`, result.style]
      if (result.rate !== undefined || result.pitch !== undefined) {
        lines.push(
          `建议数值：rate=${result.rate ?? '默认'}${result.pitch !== undefined ? `，pitch=${result.pitch}` : ''}（合成/播报时作为逐条参数传，TTS 会钳制）`
        )
      }
      if (result.metrics) {
        const m = result.metrics
        lines.push(
          `客观测量：时长 ${m.duration}s / 有效发声 ${m.speechSeconds}s / 停顿占比 ${Math.round(m.silenceRatio * 100)}% / 字数 ${m.charCount} / 语速 ${m.charsPerSec} 字每秒` +
            (m.meanVolumeDb !== undefined ? ` / 平均响度 ${m.meanVolumeDb} dB` : '')
        )
      }
      if (result.sampleUrl) lines.push(`本次样本地址：${result.sampleUrl}（临时，过期自动失效）`)
      lines.push(
        '落到音色上用 voice_update（voiceId=音色记录 id、instruction=上面的句子）；整期基调用 program_save 的 instruction；rate/pitch 在 speak / draft_write / tts_synthesize 里传'
      )
      return lines.join('\n')
    }
  }),

  defineTool({
    name: 'tts_synthesize',
    label: '合成语音',
    domain: 'voice',
    risk: 'write',
    expose: { mcp: true },
    description:
      '合成一段语音到文件（真实调用语音合成服务，有费用）。voiceId 先 voice_list 拿（音色库里的 voiceId/voiceType 字段），不要自己编；也可以传手动复合串「接入id::模型id::音色」用系统音色。' +
      'instruction 是这条合成的风格指令（≤100 字，优先级高于节目级/音色级，只对支持语气指令的模型生效）。' +
      '产物默认落在应用内部缓存目录；传 outPath 会复制一份到该路径。返回最终路径。',
    parameters: Type.Object({
      text: Type.String({ description: '要合成的文本' }),
      voiceId: Type.String({ description: '音色标识（voice_list 返回的 voiceId 字段；或手动复合串「接入id::模型id::音色」）' }),
      instruction: Type.Optional(
        Type.String({ description: '风格指令（≤100 字，如「直播带货主播，语速偏快，像跟朋友聊天」）；只对支持语气指令的模型生效' })
      ),
      rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.5~2）' })),
      pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.5~1.5）' })),
      emotion: Type.Optional(
        Type.String({ description: '情感（仅火山模型生效）：happy / angry / sad / surprised 等；留空 = 接入默认' })
      ),
      emotionScale: Type.Optional(Type.Number({ description: '情感强度（火山 emotion_scale，1~5）：只在传了 emotion 时生效' })),
      languageType: Type.Optional(
        Type.String({ description: '语种提示（仅百炼 qwen3-tts 生效）：Auto / Chinese / English 等；留空 = 接入默认' })
      ),
      outPath: Type.Optional(Type.String({ description: '成品复制到的本机绝对路径（如 D:/out/a.mp3）；不传就只给缓存路径' }))
    }),
    handler: async (ctx, params) => {
      if (!ctx.tts) return '语音合成服务没接上'
      const audioPath = await ctx.tts.synthesize(`mcp-${randomUUID()}`, params.text, params.voiceId, undefined, {
        instruction: params.instruction,
        rate: params.rate,
        pitch: params.pitch,
        emotion: params.emotion,
        emotionScale: params.emotionScale,
        languageType: params.languageType
      })
      if (!params.outPath) {
        return `已合成：${audioPath}\n（缓存在应用内部目录；要落到指定位置就传 outPath 再合成一次，缓存命中不重复打接口）`
      }
      mkdirSync(dirname(params.outPath), { recursive: true })
      copyFileSync(audioPath, params.outPath)
      return `已合成并复制到：${params.outPath}`
    }
  }),

  defineTool({
    name: 'tts_connections',
    label: 'TTS 接入',
    domain: 'voice',
    risk: 'read',
    expose: { mcp: true },
    description:
      'TTS 接入清单：每条接入的 id、名称、服务商、启用/可用的模型、是否就绪。密钥不返回（只有 hasSecret 标记）。' +
      'voice_clone_start 的 connectionId 从这里取。返回 JSON 数组。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const list = ctx.storage.ttsConnectionListSafe().map((connection) => ({
        id: connection.id,
        name: connection.name,
        provider: connection.providerId,
        models: connection.models.map((model) => model.id),
        usableModels: connection.usableModels,
        ready: connection.ready,
        hasSecret: connection.hasSecret
      }))
      return JSON.stringify(list, null, 2)
    }
  })
]
