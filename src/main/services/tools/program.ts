import { Type } from 'typebox'
import {
  BROADCAST_MODE_LABELS,
  CONTENT_TYPE_LABELS,
  PROGRAM_LANGUAGE_LABELS,
  type Program
} from '../../../shared/types'
import { audioProgress } from '../programUnits'
import { defineTool, type ToolCtx } from './types'

/**
 * 节目域：节目配置/选中/开播/音频生产/导出。
 * 合并自旧 list_programs/get_program/save_program/set_active_program/delete_program/
 * clear_program_content/produce_program_audio/export_program/start_live 与
 * MCP program_list/program_launch/program_preflight/program_produce_audio/
 * program_audio_progress/program_export。
 */

const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABELS) as (keyof typeof CONTENT_TYPE_LABELS)[]
const BROADCAST_MODES = Object.keys(BROADCAST_MODE_LABELS) as (keyof typeof BROADCAST_MODE_LABELS)[]

// ---------- 本域共用助手 ----------

const activeId = (ctx: ToolCtx): string => ctx.storage.getConfig().live.activeProgramId

const findProgram = (ctx: ToolCtx, id: string): Program | undefined =>
  ctx.script.listPrograms().find((p) => p.id === id.trim())

/** 节目底稿统计（底稿数/音频就绪数） */
const draftStats = (ctx: ToolCtx, programId: string): { total: number; ready: number; pending: number; failed: number } => {
  const all = ctx.draftUnits.list(programId)
  return {
    total: all.length,
    ready: all.filter((u) => u.status === 'ready').length,
    pending: all.filter((u) => u.status === 'pending' || u.status === 'synthesizing').length,
    failed: all.filter((u) => u.status === 'failed').length
  }
}

/** 音色显示名：克隆音色按 voiceType 反查音色库，查不到原样显示标识 */
const voiceLabel = (ctx: ToolCtx, voiceId: string): string => {
  if (!voiceId.trim()) return '（未设置）'
  const found = ctx.voices?.list().find((v) => v.voiceType === voiceId.trim())
  return found ? `${found.name}（${voiceId.trim()}）` : voiceId.trim()
}

/** 触发器显示名（查不到标注已删除） */
const triggerLabel = (ctx: ToolCtx, id: string): string => {
  const found = ctx.triggers?.list().find((t) => t.id === id)
  return found ? found.name : `${id}（已不存在）`
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

export const programTools = [
  defineTool({
    name: 'program_list',
    label: '节目列表',
    domain: 'program',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出全部节目：id、名称、主题、内容类型、播出方式、播完策略、底稿数/音频就绪数、是不是当前节目、版本号（updatedAt，program_save 作 expectedUpdatedAt 用）。' +
      '要了解系统里有哪些节目、或拿节目 id 用它。返回 JSON 数组。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const programs = ctx.script.listPrograms()
      if (programs.length === 0) return '还没有节目：用 program_save 新建一个'
      const active = activeId(ctx)
      return JSON.stringify(
        programs.map((p) => {
          const stats = draftStats(ctx, p.id)
          return {
            id: p.id,
            name: p.name,
            theme: p.theme,
            contentType: p.contentType,
            broadcastMode: p.broadcastMode,
            finishMode: p.finishMode,
            active: p.id === active,
            drafts: stats.total,
            audioReady: stats.ready,
            updatedAt: p.updatedAt
          }
        })
      )
    }
  }),

  defineTool({
    name: 'program_get',
    label: '看节目',
    domain: 'program',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '看一个节目的完整配置：内容类型/播出方式/播完策略/事件规则/卡司/节目风格指令/绑的剧本/知识范围/场景进度，附底稿与音频就绪统计和版本号（updatedAt）。' +
      '改节目（program_save）之前先用它读一遍。programId 从 program_list 拿。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' })
    }),
    handler: (ctx, params) => {
      const program = findProgram(ctx, params.programId)
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      const bound = program.scriptId ? ctx.script.getScript(program.scriptId) : null
      const stats = draftStats(ctx, program.id)
      const renderedProgress = audioProgress(program, bound, ctx.draftUnits.list(program.id))
      return JSON.stringify({
        id: program.id,
        名称: program.name,
        主题: program.theme || '（未设定）',
        内容类型: CONTENT_TYPE_LABELS[program.contentType],
        播出方式: BROADCAST_MODE_LABELS[program.broadcastMode],
        播完以后: program.broadcastMode === 'improvised' ? '不适用（即兴）' : program.finishMode === 'loop' ? '循环播放' : '播完停止',
        播出语言: PROGRAM_LANGUAGE_LABELS[program.language ?? 'auto'] ?? '自动识别',
        直播间动态提供给主播: program.allowLiveEvents,
        启用触发器: program.enabledTriggerIds.map((id) => ({ id, 名称: triggerLabel(ctx, id) })),
        卡司:
          program.presenterIds.length > 0
            ? program.presenterIds.map((id) => {
                const card = ctx.persona.list().find((p) => p.id === id)
                return card ? `${card.name}（${card.id}）` : `${id}（已不存在）`
              })
            : '（导演自选：全部主播卡都是候选人）',
        节目风格指令: program.instruction || '（未配置：整期用卡司嗓音的默认风格）',
        剧本: bound ? { id: bound.id, 名称: bound.title, 场景数: bound.scenes.length } : null,
        场景进度: `第 ${program.currentSceneIdx + 1} 场`,
        知识范围: {
          条目: program.knowledgeScope.products === '*' ? '全部' : `${program.knowledgeScope.products.length} 个`,
          文件: program.knowledgeScope.files === '*' ? '全部' : `${program.knowledgeScope.files.length} 个`
        },
        底稿统计: stats,
        节目音频进度: {
          单元总数: renderedProgress.total,
          就绪: renderedProgress.ready,
          合成中: renderedProgress.synthesizing,
          待合成: renderedProgress.pending,
          失败: renderedProgress.failed,
          已过期: renderedProgress.stale
        },
        当前节目: program.id === activeId(ctx),
        版本号: program.updatedAt
      })
    }
  }),

  defineTool({
    name: 'program_save',
    label: '存节目',
    domain: 'program',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '新建或修改节目配置（名称/主题/内容类型/播出方式/播完策略/事件开关/卡司/剧本绑定/知识范围/节目风格指令）。' +
      '带 id 是修改（没传的字段保持原样），不带 id 是新建（name 必填）。' +
      '修改时建议带 expectedUpdatedAt（program_get/program_list 里的版本号）：期间有人改过了会拒绝并告诉你新版本号，重新读取后再改，不会悄悄覆盖别人的修改。' +
      '改的是当前节目且会话在跑时，配置下次重开会话/开播才生效（返回值会明说）。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '节目 id：修改时必传（program_list 拿），不传 = 新建' })),
      name: Type.Optional(Type.String({ description: '节目名称（新建必填）' })),
      theme: Type.Optional(Type.String({ description: '主题/节目说明' })),
      contentType: Type.Optional(
        Type.String({ description: `内容类型：${CONTENT_TYPES.map((t) => `${t}=${CONTENT_TYPE_LABELS[t]}`).join(' / ')}` })
      ),
      broadcastMode: Type.Optional(
        Type.String({ description: `播出方式：${BROADCAST_MODES.map((m) => `${m}=${BROADCAST_MODE_LABELS[m]}`).join(' / ')}` })
      ),
      finishMode: Type.Optional(Type.String({ description: '播完以后：stop=播完停止 / loop=循环播放' })),
      allowLiveEvents: Type.Optional(Type.Boolean({ description: '是否把直播间动态（评论/礼物/进场）提供给主播' })),
      enabledTriggerIds: Type.Optional(Type.Array(Type.String(), { description: '启用的事件触发器 id（全量替换，trigger_list 拿）' })),
      presenterIds: Type.Optional(
        Type.Array(Type.String(), { description: '节目卡司：主播卡 id 数组（全量替换，persona_list 拿）；空数组 = 导演自选（全部主播卡可用）' })
      ),
      scriptId: Type.Optional(Type.String({ description: '绑定的剧本 id（剧本列表工具拿）；传空字符串 = 解绑' })),
      knowledgeScope: Type.Optional(
        Type.Object({
          products: Type.Optional(Type.Union([Type.Literal('*'), Type.Array(Type.String())], { description: '知识条目范围：* = 全部，否则 id 白名单' })),
          files: Type.Optional(Type.Union([Type.Literal('*'), Type.Array(Type.String())], { description: '知识文件范围' }))
        })
      ),
      instruction: Type.Optional(
        Type.String({ description: '节目级风格指令（≤100 字，整期默认演法）：覆盖卡司嗓音的默认风格，低于 agent 逐条 delivery' })
      ),
      language: Type.Optional(
        Type.String({
          description:
            '播出语言（多语言节目用）：auto=自动 / Chinese / English / Japanese / Korean / German / French / Russian / Italian / Spanish / Portuguese。改它会让写稿 prompt 要求该语言撰写并给 TTS 传语种提示（仅百炼 qwen3-tts 生效）'
        })
      ),
      expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）：不一致就拒绝，不会覆盖别人的修改' }))
    }),
    handler: (ctx, params) => {
      const existing = params.id ? findProgram(ctx, params.id) : undefined
      if (params.id && !existing) return `节目 ${params.id} 不存在（用 program_list 拿正确的 id）`
      if (!existing && !params.name?.trim()) return '新建节目必须给名称（name）'
      if (!existing) {
        const dup = ctx.script.listPrograms().find((p) => p.name === params.name!.trim())
        if (dup) return `已存在同名节目「${dup.name}」（id=${dup.id}）：要改它带 id 调用，别重复建`
      }
      const pickEnum = <T extends string>(
        value: string | undefined,
        allowed: readonly T[],
        label: string
      ): { value?: T; error?: string } => {
        if (value === undefined) return {}
        return (allowed as readonly string[]).includes(value)
          ? { value: value as T }
          : { error: `${label}只能是：${allowed.join(' / ')}` }
      }
      const ct = pickEnum(params.contentType, CONTENT_TYPES, '内容类型')
      if (ct.error) return ct.error
      const bm = pickEnum(params.broadcastMode, BROADCAST_MODES, '播出方式')
      if (bm.error) return bm.error
      const fm = pickEnum(params.finishMode, ['stop', 'loop'] as const, '播完策略')
      if (fm.error) return fm.error
      const lang = pickEnum(
        params.language,
        ['auto', 'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Italian', 'Spanish', 'Portuguese'] as const,
        '播出语言'
      )
      if (lang.error) return lang.error

      const scriptId = params.scriptId === undefined ? (existing?.scriptId ?? null) : params.scriptId.trim() || null
      if (scriptId && !ctx.script.getScript(scriptId)) return `剧本 ${scriptId} 不存在（用剧本列表工具拿正确的 id）`
      if (params.presenterIds) {
        const known = new Set(ctx.persona.list().map((p) => p.id))
        const bad = params.presenterIds.map((id) => id.trim()).filter((id) => id && !known.has(id))
        if (bad.length > 0) return `卡司里有不存在的主播卡：${bad.join('、')}（用 persona_list 拿正确的 id）`
      }

      const saved = ctx.script.saveProgram(
        {
          name: params.name?.trim() ?? existing?.name ?? '',
          theme: params.theme ?? existing?.theme ?? '',
          contentType: ct.value ?? existing?.contentType ?? 'solo',
          broadcastMode: bm.value ?? existing?.broadcastMode ?? 'rolling',
          finishMode: fm.value ?? existing?.finishMode ?? 'loop',
          allowLiveEvents: params.allowLiveEvents ?? existing?.allowLiveEvents ?? true,
          enabledTriggerIds: params.enabledTriggerIds ?? existing?.enabledTriggerIds ?? [],
          presenterIds: params.presenterIds ?? existing?.presenterIds ?? [],
          instruction: params.instruction === undefined ? (existing?.instruction ?? '') : params.instruction.trim(),
          scriptId,
          language: lang.value ?? existing?.language ?? 'auto',
          knowledgeScope: params.knowledgeScope
            ? {
                products: params.knowledgeScope.products ?? existing?.knowledgeScope.products ?? '*',
                files: params.knowledgeScope.files ?? existing?.knowledgeScope.files ?? '*'
              }
            : (existing?.knowledgeScope ?? { products: '*', files: '*' })
        },
        existing?.id,
        params.expectedUpdatedAt
      )
      const status = ctx.getStatus?.()
      const runningNote =
        saved.id === activeId(ctx) && status && status.state !== 'stopped'
          ? '。注意：这是当前节目且主播会话在跑——配置改动要重开会话/重新开播才生效，正在进行的会话不受影响'
          : ''
      return `${existing ? '已更新' : '已新建'}节目「${saved.name}」（id=${saved.id}，版本号 ${saved.updatedAt}）${runningNote}`
    }
  }),

  defineTool({
    name: 'program_delete',
    label: '删节目',
    domain: 'program',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '删除一个节目：底稿、已合成音频、该节目的对话记录一起删除，不可恢复（剧本/音色/知识等全局资产不动）。' +
      '正在播出的节目删不了（先结束节目）。内置主播第一次调用不传 confirmed：向导演发确认卡；导演确认后带 confirmed=true 重调才执行。' +
      '外部调用没有确认卡、直接执行。programId 从 program_list 拿。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' }),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: (ctx, params) => {
      const program = findProgram(ctx, params.programId)
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      const status = ctx.getStatus?.()
      if (status?.live && activeId(ctx) === program.id) {
        return '删不了：这个节目正在播出。先结束节目（导演在直播台点结束），再删除'
      }
      const session = ctx.getSessionInfo?.()
      if (session?.purpose === 'live' && session.programId === program.id) {
        return '删不了：这个节目的直播会话还在跑。先结束节目再删除'
      }
      const stats = draftStats(ctx, program.id)
      const isActive = activeId(ctx) === program.id
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `删除节目「${program.name}」：\n` +
            `- 底稿 ${stats.total} 段（含已合成音频 ${stats.ready} 段）一并删除\n` +
            `- 该节目的对话记录一并删除\n` +
            `- ${isActive ? '它是当前节目，删除后当前节目选择清空\n- ' : ''}` +
            `绑定的剧本/音色/知识等全局资产不动\n` +
            `不可恢复`
        )
        if (msg) return msg
      }
      ctx.script.deleteProgram(program.id)
      return `已删除节目「${program.name}」：${stats.total} 段底稿与音频、对话记录一并清除${isActive ? '，当前节目选择已清空' : ''}`
    }
  }),

  defineTool({
    name: 'program_activate',
    label: '选中节目',
    domain: 'program',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '把某个节目设为当前节目（主播的上下文、底稿工具都跟着它走；选中后主播就位于该节目——预热，接着它原来的对话记录）。' +
      '正在播出的节目不受影响——播出中想换节目要先结束再开播。programId 从 program_list 拿。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' })
    }),
    handler: (ctx, params) => {
      const program = findProgram(ctx, params.programId)
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      if (program.id === activeId(ctx)) return `「${program.name}」已经是当前节目`
      ctx.script.setActiveProgram(program.id)
      ctx.warmupProgram?.(program.id)
      const liveNote = ctx.getStatus?.()?.live
        ? '（当前正在播出的节目不受影响：这场结束后开播才用新选择）'
        : '（主播已就位于这个节目）'
      return `已选中节目「${program.name}」${liveNote}`
    }
  }),

  defineTool({
    name: 'program_clear_content',
    label: '清空节目内容',
    domain: 'program',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '清空一个节目的全部底稿和已合成音频（不可恢复；节目配置/剧本绑定保留）。整节目推倒重写时用；正在播出的节目清不了。' +
      '内置主播第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。外部调用直接执行。',
    parameters: Type.Object({
      programId: Type.Optional(Type.String({ description: '节目 id（program_list 拿），不传 = 当前节目' })),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: (ctx, params) => {
      const programId = params.programId?.trim() || activeId(ctx)
      if (!programId) return '没有指定节目，也没有当前节目（programId 从 program_list 拿）'
      const program = findProgram(ctx, programId)
      if (!program) return `节目 ${programId} 不存在（用 program_list 拿正确的 id）`
      if (ctx.getStatus?.()?.live && activeId(ctx) === program.id) {
        return '清不了：这个节目正在播出，播着的内容不能清。先结束节目再清'
      }
      const stats = draftStats(ctx, program.id)
      if (stats.total === 0) return `「${program.name}」本来就是空的`
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `清空节目「${program.name}」的全部内容：\n` +
            `- ${stats.total} 段底稿删除（含 ${stats.ready} 段已合成音频，音频文件一并清理）\n` +
            `- 节目配置与剧本绑定保留\n不可恢复`
        )
        if (msg) return msg
      }
      ctx.draftUnits.clear(program.id)
      return `已清空「${program.name}」的 ${stats.total} 段底稿（含 ${stats.ready} 段音频）。段数归零，可以重新写稿了`
    }
  }),

  defineTool({
    name: 'program_preflight',
    label: '开播预检',
    domain: 'program',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '开播前预检：返回检查项清单（ok/warn/block 三级），block 项存在时 program_launch 会拒绝。开播前先用它看缺什么，按 detail 提示补齐。programId 从 program_list 拿。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' })
    }),
    handler: (ctx, params) => {
      if (!ctx.programPlayback) return '播出服务没接上，让导演在界面做开播预检'
      return JSON.stringify(ctx.programPlayback.preflight(params.programId.trim()), null, 2)
    }
  }),

  defineTool({
    name: 'program_launch',
    label: '开播',
    domain: 'program',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '正式启动节目开播（装载底稿、打开播出通道、开始接评论）。会真的开播。预检不过返回缺什么（先 program_preflight 看清单）。' +
      '内置主播只有导演明说开播才用（备稿、闲聊、彩排阶段别碰），开播的是当前节目，不用传 programId；' +
      '外部调用必须传 programId，allowPartial=true 表示预制节目音频没全就绪时只播已完成部分（默认 false=拒绝）。',
    parameters: Type.Object({
      programId: Type.Optional(Type.String({ description: '节目 id（program_list 拿）。外部调用必填；内置主播不用传（当前节目）' })),
      allowPartial: Type.Optional(Type.Boolean({ description: '预制节目音频没全就绪时，是否只播已完成部分（默认 false=拒绝）。仅外部调用有效' }))
    }),
    handler: async (ctx, params) => {
      if (ctx.caller === 'agent') {
        if (ctx.isLiveActive?.()) return '已经在直播了，不用重复开播'
        if (!ctx.onGoLive) return '开播通道没接上，让导演从界面点「启动节目」'
        return await ctx.onGoLive()
      }
      const programId = params.programId?.trim()
      if (!programId) return '外部调用必须传 programId（program_list 拿）'
      if (!ctx.launchProgram) return '开播编排没接上，让导演从界面点「启动节目」'
      const result = await ctx.launchProgram(programId, params.allowPartial ?? false)
      return JSON.stringify(result, null, 2)
    }
  }),

  defineTool({
    name: 'program_produce_audio',
    label: '生产音频',
    domain: 'program',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '生成节目音频（统一生产入口）。rolling 边播边准备的节目是「提前合成全部」：立即返回、后台逐段跑（进度看 program_audio_progress）；' +
      'prepared 预制节目全量合成、同步跑完才返回汇总，段数多要等很久，且会真实调用语音合成服务、有外部费用。' +
      '内置主播跑预制节目必须先向导演发确认卡（卡里写清范围、预计时长、将用的模型和音色快照），导演确认后带 confirmed=true 重调；外部调用本身是导演角色，直接执行。' +
      '开始合成时把卡司声音冻结成快照写进产物，之后换卡司不改写已有音频。已就绪且文稿没改过的单元会跳过不重蒸。programId 不传 = 当前节目。',
    parameters: Type.Object({
      programId: Type.Optional(Type.String({ description: '节目 id（program_list 拿），不传 = 当前节目' })),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；预制节目不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: async (ctx, params) => {
      const programId = params.programId?.trim() || activeId(ctx)
      if (!programId) return '没有指定节目，也没有当前节目（programId 从 program_list 拿）'
      const program = findProgram(ctx, programId)
      if (!program) return `节目 ${programId} 不存在（用 program_list 拿正确的 id）`
      const produce = ctx.produceProgramAudio ?? ((id: string) => ctx.draftUnits.produceProgramAudio(id))
      // 滚动/即兴：提前合成全部不是门禁、也没有额外决策，直接跑
      if (program.broadcastMode !== 'prepared') {
        const result = await produce(program.id)
        return result.ok
          ? `已开始为「${program.name}」提前合成全部文稿（后台逐段跑，不是播放门禁；进度用 program_audio_progress 看）`
          : `发起失败：${result.error}`
      }
      // 预制：全量合成有外部费用。内置主播先确认（确认卡显示范围/预计时长/模型与音色快照）；外部调用直接执行
      if (ctx.caller === 'agent') {
        if (!ctx.describeProducePlan) return '音频生产入口没接上，让导演在界面操作'
        const plan = ctx.describeProducePlan(program.id)
        if (!plan.ok) return `没法生成：${plan.error}`
        if (!params.confirmed) {
          const msg = askConfirm(
            ctx,
            `生成节目音频「${program.name}」（预制播出）：\n` +
              `- 范围：${plan.scenes && plan.scenes > 0 ? `${plan.scenes} 章 / ` : ''}${plan.units} 个合成单元（共 ${plan.segments} 段、约 ${plan.totalChars} 字）\n` +
              `- 预计时长：约 ${plan.estMinutes} 分钟（按字数粗估，不是承诺）\n` +
              `- 合成模型：${plan.modelDesc}\n` +
              `- 声音快照：${plan.voiceDesc}\n` +
              `${plan.notice ? `- 说明：${plan.notice}\n` : ''}` +
              `注意：会真实调用语音合成服务产生费用；已就绪且文稿没改过的单元会跳过不重蒸`
          )
          if (msg) return msg
        }
      } else if (ctx.describeProducePlan) {
        const plan = ctx.describeProducePlan(program.id)
        if (!plan.ok) return `没法生成：${plan.error}`
      }
      const result = await produce(program.id)
      if (!result.ok && result.error) return `合成没跑起来：${result.error}`
      return (
        `节目音频生产完成：成功 ${result.done} / 跳过已就绪 ${result.skipped} / 失败 ${result.failed}（共 ${result.total} 个单元）` +
        `${result.notice ? `\n说明：${result.notice}` : ''}` +
        `${result.failed > 0 ? '\n有失败单元：用 program_get 看音频进度，失败原因在节目文稿页逐章标注，修好后再调一次本工具即可续跑' : ''}`
      )
    }
  }),

  defineTool({
    name: 'program_audio_progress',
    label: '音频进度',
    domain: 'program',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '节目音频进度：合成单元总数 / ready / synthesizing / pending / failed / stale（已过期=文稿改过的旧音频）。' +
      'program_produce_audio 后台跑的时候用它盯进度。programId 从 program_list 拿。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' })
    }),
    handler: (ctx, params) => {
      if (!ctx.programPlayback) return '播出服务没接上，让导演在界面看音频进度'
      const program = findProgram(ctx, params.programId)
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      return JSON.stringify(ctx.programPlayback.audioProgress(program.id), null, 2)
    }
  }),

  defineTool({
    name: 'program_export',
    label: '导出音频',
    domain: 'program',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '导出预制节目已生成的音频到本机目录：数据源是节目单元的预制音频资产，不重新调 TTS，导出和播放用同一批音频。' +
      '范围 = 全部章节；mode=separate 分章文件（默认）/ merged 合并为一个文件；format=mp3（默认）/ wav。' +
      '部分章节缺音频时默认阻断并列出缺哪些，明确带 onlyReady=true 才只导出已完成部分（不静默跳过）。' +
      '对外副作用：往磁盘写文件。内置主播第一次调用不传 confirmed：向导演发确认卡（范围/方式/格式/输出目录/预计文件数）；确认后带 confirmed=true 重调才执行。外部调用直接执行。' +
      'programId 从 program_list 拿，outputDir 必填（本机绝对路径）。',
    parameters: Type.Object({
      programId: Type.String({ description: '节目 id（program_list 拿）' }),
      outputDir: Type.String({ description: '输出目录的本机绝对路径（如 D:/out/节目名）' }),
      mode: Type.Optional(
        Type.Union([Type.Literal('separate'), Type.Literal('merged')], { description: 'separate 分章文件（默认）/ merged 合并成一个文件' })
      ),
      format: Type.Optional(Type.Union([Type.Literal('mp3'), Type.Literal('wav')], { description: '默认 mp3' })),
      onlyReady: Type.Optional(Type.Boolean({ description: '只导出已完成部分（缺音频章节不静默跳过，默认 false=缺了报错）' })),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧）' }))
    }),
    handler: async (ctx, params) => {
      const exporter = ctx.exporter
      if (!exporter) return '导出服务还没接上，让导演在界面用导出弹窗（直播台顶栏/节目卡）'
      const program = findProgram(ctx, params.programId)
      if (!program) return `节目 ${params.programId} 不存在（用 program_list 拿正确的 id）`
      const plan = exporter.describeExportPlan(program.id)
      if (!plan.ok) return `导不了：${plan.error}`
      const missing = plan.missing ?? []
      if (missing.length > 0 && !params.onlyReady) {
        return (
          `导不了：还有 ${missing.length} 个单元缺音频——\n` +
          missing.map((item) => `- ${item.title}（${item.reason}）`).join('\n') +
          '\n先用 program_produce_audio 补齐合成，或明确带 onlyReady=true 只导出已完成部分'
        )
      }
      const mode = params.mode === 'merged' ? ('merged' as const) : ('separate' as const)
      const format = params.format === 'wav' ? ('wav' as const) : ('mp3' as const)
      const readyCount = plan.ready ?? 0
      const fileCount = mode === 'merged' ? 1 : readyCount
      if (!params.confirmed) {
        const msg = askConfirm(
          ctx,
          `导出节目音频「${program.name}」：\n` +
            `- 范围：全部 ${plan.total} 章${missing.length > 0 ? `（缺 ${missing.length} 章，仅导出已完成 ${readyCount} 章）` : ''}\n` +
            `- 方式：${mode === 'merged' ? '合并为一个文件' : '分章文件'} · 格式 ${format.toUpperCase()}\n` +
            `- 输出目录：${params.outputDir.trim()}\n` +
            `- 预计文件数：${fileCount} 个\n` +
            `注意：往本机磁盘写文件；不改动节目与音频资产，删掉产出文件即可恢复`
        )
        if (msg) return msg
      }
      const result = await exporter.export({
        programId: program.id,
        mode,
        format,
        outputDir: params.outputDir.trim(),
        loudness: false,
        onlyReady: params.onlyReady === true
      })
      if (!result.ok) {
        return result.cancelled ? `导出已取消：${result.error}` : `导出失败：${result.error}`
      }
      return (
        `导出完成：${result.files?.length ?? 0} 个文件 → ${result.outputDir}\n` +
        (result.files ?? []).map((file) => `- ${file}`).join('\n') +
        (result.warning ? `\n警告：${result.warning}` : '')
      )
    }
  })
]
