import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type TSchema } from 'typebox'
import type { EntryKind, LiveComment, Persona, PlaybackControlAction, Script, UtteranceSource } from '../../shared/types'
import { ENTRY_KINDS, UTTERANCE_STATUS_LABEL } from '../../shared/types'
import type { SpeechPool } from './SpeechPool'
import type { ConnectorService } from './ConnectorService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import type { UtteranceService } from './UtteranceService'
import { fetchUrlGuarded, webSearchGuarded } from './fetchUrl'

/**
 * 主播 Agent 的工具表（docs/01 §3.3）。
 * 抽成独立工厂是为结构而抽：依赖注入让工具层与会话装配解耦，换引擎/读逻辑都只看这一层。
 */

/** defineTool：AgentTool 对象字面量的 typing 辅助（pi-agent-core 没有自带） */
function defineTool<TParameters extends TSchema>(def: AgentTool<TParameters>): AgentTool<TParameters> {
  return def
}

/** 主播的来源 id（话术池限流按来源算） */
export const AGENT_SOURCE_ID = 'anchor'

/**
 * 底稿库段数硬上限（成本闸，第一版不暴露）：写稿规模由 Agent 自己决定，
 * 这个上限不进节目配置、不在 UI 出现，只防写稿失控把合成账单烧穿。
 * ProgramPlaybackService 的循环闸门也用同一个上限。
 */
export const DRAFT_HARD_CAP = 200

/** 编剧模式：role 名 → 角色音色。音色优先级（docs/07 §8.5）：显式 voice > 本场运行态音色 > 角色音色 > 人设卡音色。都没有返回 undefined（合成路由会因此报错，不兜底） */
export function resolveVoice(
  persona: Persona,
  role?: string,
  voice?: string,
  programVoice?: string
): string | undefined {
  if (voice?.trim()) return voice.trim()
  if (programVoice?.trim()) return programVoice.trim()
  if (role?.trim()) {
    const found = persona.roles.find((r) => r.name === role.trim())
    if (found?.voiceId) return found.voiceId
  }
  return persona.voiceId || undefined
}

export interface AnchorToolDeps {
  pool: SpeechPool
  knowledge: KnowledgeService
  memory: MemoryService
  persona: PersonaService
  script: ScriptService
  /** 节目底稿库（list/edit/add/remove_draft：导演口径调整落到底稿，长期生效） */
  utterances: UtteranceService
  /** insert_next 挂 replyTo 用的最近评论 */
  getLastComment: () => LiveComment | null
  /** 场景推进后通知 AgentService 广播状态（提词器刷新） */
  onSceneChanged: () => void
  /** 本场运行态音色（节目加载时写入；热切换 set_voice 也改它） */
  getProgramVoice?: () => string
  /** 场景切换后装载新场景话术库（AgentService 转发给 ProgramPlaybackService） */
  onSceneAdvanced?: (sceneIndex: number) => void
  /** 请示导演（ask_director）：进对话面板高亮卡片，不阻塞直播（docs/07 §8.8.6 ④） */
  onDirectorAsk?: (ask: {
    text: string
    options: string[]
    timeoutSec: number
    defaultAction?: string
  }) => void
  /** 运行态换音色（set_voice） */
  setProgramVoice?: (voiceId: string) => void
  /** 运行态调段间留白（set_gap）：0 = 回系统默认 */
  setProgramGap?: (gapMs: number) => void
  /** 播报控制（pause/resume/skip）：广播到渲染进程执行 */
  onPlaybackControl?: (action: PlaybackControlAction) => void
  /** 播报是否被暂停：暂停期间 say / insert_next 直接拒（说出去的话收不回） */
  getSpeakingPaused?: () => boolean
  /** 会话用途：prep=写稿备播（say/insert_next 关闭，产出只走 write_drafts），live=直播中 */
  getPurpose?: () => 'prep' | 'live'
  /** 标记直播间动态批次的处理结果（mark_live_events）：handled=回过 / ignored=不理 */
  markLiveEvents?: (ids: string[], state: 'handled' | 'ignored') => string
  /** 正式启动当前节目开播（start_live）：返回开播结果或预检拦截原因 */
  onGoLive?: () => Promise<string>
  /** 从连接器同步商品入库（sync_products）：KnowledgeService.syncFromConnector 已包好 */
  syncProducts?: () => Promise<{ added: number; updated: number; total: number }>
  /** 平台连接器（MCP 客户端）：agent 列工具/调工具用；未接线时工具返回提示 */
  connector?: ConnectorService | null
}

export function buildAnchorTools(deps: AnchorToolDeps): AgentTool[] {
  const {
    pool,
    knowledge,
    memory,
    persona,
    script,
    utterances,
    getLastComment,
    onSceneChanged,
    getProgramVoice,
    onSceneAdvanced,
    onDirectorAsk,
    setProgramVoice,
    setProgramGap,
    onPlaybackControl,
    getSpeakingPaused,
    getPurpose,
    markLiveEvents,
    onGoLive,
    syncProducts,
    connector
  } = deps
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })
  const guardTool = (fn: () => string) => {
    try {
      return ok(fn())
    } catch (error) {
      // 池/护栏错误如实告诉主播，让它换策略而不是崩溃
      return ok(`操作被拒绝：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const guardToolAsync = async (fn: () => Promise<string>) => {
    try {
      return ok(await fn())
    } catch (error) {
      return ok(`操作被拒绝：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---------- 底稿工具共用 ----------
  const DRAFT_STATUS = UTTERANCE_STATUS_LABEL
  const activeProgramId = (): string | null => script.getActive().program?.id ?? null
  const currentSceneId = (): string => script.currentScene()?.scene.id ?? ''
  const sceneTitleOf = (sceneId: string): string => {
    if (sceneId === '') return '全场通用'
    const bound = script.getActive().script
    return bound?.scenes.find((s) => s.id === sceneId)?.title ?? sceneId
  }
  const requireProgram = (): string | null => {
    const programId = activeProgramId()
    return programId ? null : '当前没有节目，没有底稿可管'
  }
  /**
   * 底稿库段数硬上限（成本闸）：写满就停，开播后池空了循环已有底稿（音频复用零重合成）。
   * 写稿规模由主播自己决定，这里只兜底防失控。到顶返回提示文案，没到返回 null。
   */
  const draftCapHit = (): string | null => {
    const programId = activeProgramId()
    if (!programId) return null
    const count = utterances.list(programId).length
    return count >= DRAFT_HARD_CAP
      ? `底稿库已到硬上限（${count}/${DRAFT_HARD_CAP} 段）——这是成本闸：开播后池子空了会循环已有底稿（音频复用，不重新合成）。要加新说法先 remove_draft 腾位置`
      : null
  }
  /** 结果行里的库存展示：只报数（上限是内部成本闸，不暴露给主播当目标） */
  const draftStockLine = (): string => {
    const programId = activeProgramId()
    if (!programId) return ''
    const total = utterances.list(programId).length
    return `；全场 ${total} 段`
  }

  return [
    defineTool({
      name: 'say',
      label: '说',
      description:
        '说内容给观众听，排进话术池队列等待播出。现场短句（回评论/过渡/互动）一次说一句完整口语；' +
        '要播一个完整桥段（故事/讲解/包袱，多句 150~350 字）就把整段一次传进来——整段合成语气连贯，别拆成单句多次调。' +
        'role 参数用于编剧模式：以某个角色的口吻写台词。' +
        'delivery 写这句话的表演指示（情绪/语气，一句话，如「压低声音像说悄悄话」）——会真的拿去控制合成语气，模型支持语气指令才生效。',
      parameters: Type.Object({
        text: Type.String({ description: '要说的话：一句短评，或一整段桥段' }),
        voice: Type.Optional(Type.String({ description: '音色 id，不传就用当前主播的音色' })),
        role: Type.Optional(Type.String({ description: '角色名（编剧模式），台词按该角色音色播出' })),
        delivery: Type.Optional(Type.String({ description: '表演指示（情绪/语气，一句话），随这次合成发给模型' })),
        rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3）：催单加快、讲故事放慢' })),
        pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守）：激动拔高、悄悄话压低' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (getPurpose?.() === 'prep') return '写稿模式：播出通道关着，底稿用 write_bits 入库'
          if (getSpeakingPaused?.()) return '播报已暂停：说的话暂时播不出去，等导演恢复再说'
          const voiceId = resolveVoice(persona.get(), params.role, params.voice, getProgramVoice?.())
          pool.say({
            text: params.text,
            voiceId,
            delivery: params.delivery,
            rate: params.rate,
            pitch: params.pitch,
            sourceAgentId: AGENT_SOURCE_ID,
            sourceKind: 'scene'
          })
          return `已排进队列：「${params.text}」${params.role ? `（角色：${params.role}）` : ''}`
        })
    }),
    defineTool({
      name: 'insert_next',
      label: '插播一句',
      description:
        '插播一句话：当前正在播的这条（桥段是整段原子单位）播完后播这条。只在回复观众评论或紧急情况使用。',
      parameters: Type.Object({
        text: Type.String({ description: '要插播的话，一句' }),
        voice: Type.Optional(Type.String({ description: '音色 id，不传就用当前主播的音色' })),
        role: Type.Optional(Type.String({ description: '角色名（编剧模式）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (getPurpose?.() === 'prep') return '写稿模式：播出通道关着，底稿用 write_bits 入库'
          if (getSpeakingPaused?.()) return '播报已暂停：插播也播不出去，等导演恢复'
          const comment = getLastComment()
          const replyTo = comment ? { commentId: comment.id, author: comment.author } : undefined
          pool.insertNext({
            text: params.text,
            voiceId: resolveVoice(persona.get(), params.role, params.voice, getProgramVoice?.()),
            sourceAgentId: AGENT_SOURCE_ID,
            sourceKind: 'reply' as const,
            replyTo
          })
          return `已插播：「${params.text}」`
        })
    }),
    defineTool({
      name: 'get_pool_status',
      label: '查看话术池状态',
      description: '查看话术池：各车道未播条数、正在播什么、未播条目的 id 和文本（revise_item 要用 id）。队列快空了就主动补货。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const status = pool.getStatus()
          const pending = pool
            .snapshot()
            .items.filter((item) => item.status !== 'playing')
            .slice(0, 10)
            .map((item) => ({
              id: item.id,
              lane: item.lane,
              status: item.status,
              text: item.text
            }))
          return JSON.stringify({
            未播总数: status.active,
            分车道: status.byLane,
            正在播: status.playing
              ? { id: status.playing.id, text: status.playing.text }
              : null,
            未播条目: pending
          })
        })
    }),
    defineTool({
      name: 'get_recent_played',
      label: '回看最近播过的话',
      description: '回看最近播出的 n 条话术，避免重复和自相矛盾。',
      parameters: Type.Object({
        n: Type.Optional(Type.Number({ description: '条数，默认 5', default: 5 }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const played = pool.getRecentPlayed(params.n ?? 5)
          if (played.length === 0) return '还没有播过任何话术'
          return played.map((item, i) => `${i + 1}. ${item.text}`).join('\n')
        })
    }),
    defineTool({
      name: 'revise_item',
      label: '修订未播话术',
      description:
        '修订话术池里还没播的条目：作废旧音频重合成。价格/库存/口径变了就用它改腹稿。正在播和已播的不能改（说出去的话泼出去的水）。条目 id 从 get_pool_status 拿。',
      parameters: Type.Object({
        itemId: Type.String({ description: '要修订的条目 id' }),
        newText: Type.String({ description: '修订后的文本' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          pool.revise(params.itemId, params.newText)
          return `已修订 ${params.itemId}：「${params.newText}」`
        })
    }),
    defineTool({
      name: 'list_drafts',
      label: '看底稿',
      description:
        '看本场底稿库（开播前写好的桥段，轮播的骨架）：按关键词搜，或看当前场景的。改/删底稿前先用它拿条目 id。',
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: '按文本内容过滤，比如旧价格、卖点词' })),
        scope: Type.Optional(
          Type.Union([Type.Literal('scene'), Type.Literal('all')], {
            description: 'scene=当前场景+全场通用（默认），all=全节目'
          })
        )
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const all = utterances.list(activeProgramId()!)
          const sceneId = currentSceneId()
          let list =
            params.scope === 'all'
              ? all
              : all.filter((u) => u.sceneId === sceneId || u.sceneId === '')
          const kw = params.keyword?.trim()
          if (kw) list = list.filter((u) => u.text.includes(kw))
          if (list.length === 0) return kw ? `没有包含「${kw}」的底稿` : '这个范围还没有底稿'
          const shown = list.slice(0, 30)
          // 列表只给前 100 字（拿 id 和概要用；要看全文去话术库，改稿按 id 改）——
          // 底稿一多全文塞进来一条结果就是几万 token，上下文 compression 会被它顶爆
          const brief = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)
          return (
            `共 ${list.length} 条${list.length > 30 ? '，只列前 30 条' : ''}：\n` +
            shown
              .map(
                (u) =>
                  `${u.id}｜${sceneTitleOf(u.sceneId)}｜${DRAFT_STATUS[u.status]}｜${u.bitType ? `[${u.bitType}] ` : ''}${brief(u.text)}` +
                  (u.delivery ? `（演法：${u.delivery}）` : '')
              )
              .join('\n')
          )
        })
    }),
    defineTool({
      name: 'edit_draft',
      label: '改底稿',
      description:
        '改一条底稿（长期生效）：文本、类型、表演指示都能改（导演口径调整/价格修正/说法优化）。改完旧音频作废、后台自动重新合成；已经在池里没播的副本不受影响，要改用 revise_item。',
      parameters: Type.Object({
        id: Type.String({ description: '底稿条目 id（list_drafts 拿）' }),
        text: Type.String({ description: '新文本（桥段就传整段，单句就传一句）' }),
        type: Type.Optional(Type.String({ description: '桥段类型（不改不传）' })),
        delivery: Type.Optional(Type.String({ description: '表演指示（不改不传）' })),
        rate: Type.Optional(Type.Number({ description: '语速倍率（不改不传）' })),
        pitch: Type.Optional(Type.Number({ description: '音调倍率（不改不传）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const programId = activeProgramId()!
          const existing = utterances.list(programId).find((u) => u.id === params.id.trim())
          if (!existing) return `找不到底稿 ${params.id}（用 list_drafts 拿正确的 id）`
          utterances.save(
            {
              programId,
              sceneId: existing.sceneId,
              variantIdx: existing.variantIdx,
              text: params.text,
              bitType: params.type?.trim() ?? existing.bitType,
              delivery: params.delivery?.trim() ?? existing.delivery,
              rate: params.rate ?? existing.rate,
              pitch: params.pitch ?? existing.pitch,
              voiceId: existing.voiceId,
              source: existing.source,
              sources: existing.sources
            },
            existing.id
          )
          void utterances.kickSynthesis(programId)
          return `已改：「${params.text.slice(0, 40)}${params.text.length > 40 ? '…' : ''}」。旧音频作废，后台重新合成中，好了之后轮播/装载就用新版`
        })
    }),
    defineTool({
      name: 'add_draft',
      label: '补底稿',
      description:
        '把一段新内容记进底稿库（默认记到当前场景），合成完进入轮播。现场临时编的好桥段值得记；想现在就播直接用 say，别用它。',
      parameters: Type.Object({
        text: Type.String({ description: '底稿文本（桥段就整段，单句就一句）' }),
        type: Type.Optional(Type.String({ description: '桥段类型（hook/story/scene/math/compare/punchline/interact/cta/transition/closer/general；closer=收尾段，不进自动轮播）' })),
        delivery: Type.Optional(Type.String({ description: '表演指示，一句话' })),
        rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3），不传用默认' })),
        pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守），不传用默认' })),
        sceneId: Type.Optional(Type.String({ description: '记到哪个场景；不传记到当前场景，没有剧本则记为全场通用' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const capped = draftCapHit()
          if (capped) return capped
          const programId = activeProgramId()!
          const sceneId = params.sceneId?.trim() ?? currentSceneId()
          const siblings = utterances.list(programId).filter((u) => u.sceneId === sceneId)
          const variantIdx = siblings.reduce((max, u) => Math.max(max, u.variantIdx + 1), 0)
          utterances.save({
            programId,
            sceneId,
            variantIdx,
            text: params.text,
            bitType: params.type?.trim() ?? '',
            delivery: params.delivery?.trim() ?? '',
            rate: params.rate,
            pitch: params.pitch,
            voiceId: '',
            source: 'initial',
            sources: []
          })
          void utterances.kickSynthesis(programId)
          return `已记进底稿（${sceneTitleOf(sceneId)}），后台合成完成后进入轮播；想现在就说请用 say`
        })
    }),
    defineTool({
      name: 'remove_draft',
      label: '删底稿',
      description: '删一条底稿（说法过时/违规/不想再播）。已经在池里没播的副本不受影响，要撤用 revise_item 或等它播完。',
      parameters: Type.Object({
        id: Type.String({ description: '底稿条目 id（list_drafts 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const programId = activeProgramId()!
          const existing = utterances.list(programId).find((u) => u.id === params.id.trim())
          if (!existing) return `找不到底稿 ${params.id}（用 list_drafts 拿正确的 id）`
          utterances.remove(existing.id)
          return `已删底稿：「${existing.text}」`
        })
    }),
    defineTool({
      name: 'clear_drafts',
      label: '清空底稿',
      description:
        '一次清空底稿库（全部或指定场景）。只有导演明确说「清空 / 全部删掉 / 清稿重写」才用；清完不可恢复。' +
        '大批量删除必须用它——逐条 remove_draft 删几百条会把上下文顶爆，还慢。',
      parameters: Type.Object({
        sceneId: Type.Optional(Type.String({ description: '只清某个场景（list_drafts 里的 sceneId）；不传 = 全场清空' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const programId = activeProgramId()!
          const sceneId = params.sceneId?.trim()
          const before = utterances.list(programId).filter((u) => sceneId === undefined || u.sceneId === sceneId).length
          if (before === 0) return sceneId ? `「${sceneTitleOf(sceneId)}」本来就没有底稿` : '底稿库本来就是空的'
          utterances.clear(programId, sceneId)
          return sceneId
            ? `已清空「${sceneTitleOf(sceneId)}」的 ${before} 段底稿（已在池里没播的副本不受影响，要撤用 revise_item 或等它播完）`
            : `已清空全场 ${before} 段底稿（已在池里没播的副本不受影响）。段数归零，可以重新写稿了`
        })
    }),
    defineTool({
      name: 'write_bits',
      label: '写桥段',
      description:
        '编剧模式批量入库：把为某个场景写好的桥段存进底稿库（一次 1~4 段，写稿任务书里有各场景的 sceneId）。' +
        '桥段 = 一段 30~90 秒的连续讲述（多句、150~350 字），是合成和播放的最小单元——写成一个有起承转合的整体，别拆成单句。' +
        'type 标内容形态：hook 开场钩 / story 故事 / scene 场景化 / math 算账 / compare 对比 / punchline 包袱（歇后语、顺口溜、段子）/ interact 互动 / cta 催单 / transition 转场 / closer 收尾（不进自动轮播，收尾时你自己 say 出去）/ general 通用。' +
        'delivery 写表演指示（一句话：情绪、语速、哪里停顿，比如「压低声音像说悄悄话，报价格前停一拍」）。' +
        'sources 填每段参考过的来源名（商品名/文件名），没参考就空数组。入库是待合成状态，导演审完统一预合成，不用你管音频。',
      parameters: Type.Object({
        sceneId: Type.String({ description: '写到哪个场景（写稿任务书里的 sceneId）' }),
        items: Type.Array(
          Type.Object({
            type: Type.String({ description: '桥段类型（见工具描述），自定义类型也行' }),
            text: Type.String({ description: '桥段全文：多句连续口语，150~350 字，有铺垫有落点' }),
            delivery: Type.Optional(Type.String({ description: '表演指示，一句话' })),
            rate: Type.Optional(Type.Number({ description: '语速倍率（1.0 基准，0.85~1.3），不传用默认' })),
            pitch: Type.Optional(Type.Number({ description: '音调倍率（1.0 基准，0.9~1.1 保守），不传用默认' })),
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
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requireProgram()
          if (noPlan) return noPlan
          const capped = draftCapHit()
          if (capped) return capped
          const saved = utterances.saveMany(
            activeProgramId()!,
            params.sceneId.trim(),
            params.items.map((item) => ({
              text: item.text,
              bitType: item.type,
              delivery: item.delivery,
              rate: item.rate,
              pitch: item.pitch,
              sources: (item.sources ?? []).map(
                (s): UtteranceSource => ({ type: s.type, id: '', name: s.name, snippet: s.snippet })
              )
            }))
          )
          // 不自动合成：写稿阶段量大，审阅后由「预合成全部」统一跑（edit_draft/add_draft 的单条急用才自动合成）
          const sceneCount = utterances
            .list(activeProgramId()!)
            .filter((u) => u.sceneId === params.sceneId.trim()).length
          const monotony = bitTypeMonotony(params.items.map((item) => item.type))
          return (
            `已入库 ${saved.length} 段到「${sceneTitleOf(params.sceneId.trim())}」（待合成；本场景现有 ${sceneCount} 段${draftStockLine()}）` +
            (monotony ? `\n注意：${monotony}——一场戏全是同一种形态会很平，下批换类型（故事/算账/包袱/场景化穿插着来）` : '')
          )
        })
    }),
    defineTool({
      name: 'advance_scene',
      label: '推进剧本场景',
      description: '把剧本推进到下一场景。返回新场景的目标和要点。已经是最后一场时返回提示——收尾还是循环由你自己判断。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const next = script.advanceScene()
          if (!next) return '已经是最后一场了（或没有绑定剧本），收尾还是从头循环由你判断'
          onSceneChanged()
          // 新场景的话术库自动装载进池（骨架接上，不用等补货）
          onSceneAdvanced?.(next.index)
          return `进入第 ${next.index + 1}/${next.total} 场「${next.scene.title}」\n目标：${next.scene.goal}\n要点：${next.scene.keyPoints}`
        })
    }),
    defineTool({
      name: 'search_knowledge',
      label: '查知识库',
      description: '检索商品资料和上传的知识文件（卖点/FAQ/资料描述）。观众问到商品细节先查再答，不要凭印象编。',
      parameters: Type.Object({
        query: Type.String({ description: '检索关键词，比如商品名、材质、功效' }),
        limit: Type.Optional(Type.Number({ description: '返回条数，默认 3', default: 3 }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const hits = knowledge.searchKnowledge(params.query, params.limit ?? 3)
          if (hits.length === 0) return '知识库里没有相关内容，别编，含糊带过或引导观众看小黄车'
          return hits
            .map(
              (hit, i) =>
                `${i + 1}. [${hit.source === 'product' ? '商品' : '资料'}] ${hit.name}` +
                `${hit.price !== undefined ? `（¥${hit.price}）` : ''}\n${hit.snippet}`
            )
            .join('\n')
        })
    }),
    defineTool({
      name: 'save_knowledge_entry',
      label: '存知识条目',
      description:
        '往知识库写/更新一个条目（商品/书籍/话题/自定义）：观众提到的新商品、导演口头给的新卖点、你自己查到的资料。同名自动更新（按名字找，找到就覆盖）。' +
        '直播里要长期记住的商品信息用它落库，别只记在对话里。',
      parameters: Type.Object({
        name: Type.String({ description: '条目名（商品名/书名/话题名）' }),
        kind: Type.Optional(
          Type.String({ description: `类型：${ENTRY_KINDS.join('/')}（商品默认 product）` })
        ),
        price: Type.Optional(Type.Number({ description: '价格（元），只有商品有意义' })),
        sellingPoints: Type.Optional(Type.String({ description: '要点：商品=卖点；书籍=内容要点；话题=节目要点' })),
        faq: Type.Optional(Type.String({ description: '问答/备注' })),
        author: Type.Optional(Type.String({ description: '作者（书籍类用）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const kind = (ENTRY_KINDS as readonly string[]).includes(params.kind ?? '')
            ? (params.kind as EntryKind)
            : 'product'
          const existing = knowledge.listProducts().find((p) => p.name === params.name.trim())
          const saved = knowledge.saveProduct(
            {
              name: params.name,
              kind,
              price: params.price ?? existing?.price ?? 0,
              sellingPoints: params.sellingPoints ?? existing?.sellingPoints ?? '',
              faq: params.faq ?? existing?.faq ?? '',
              externalId: existing?.externalId ?? '',
              meta: {
                ...(existing?.meta ?? {}),
                ...(params.author?.trim() ? { author: params.author.trim() } : {})
              }
            },
            existing?.id
          )
          return `${existing ? '已更新' : '已新建'}知识条目「${saved.name}」（${saved.kind}）${saved.price > 0 ? `，¥${saved.price}` : ''}`
        })
    }),
    defineTool({
      name: 'remove_knowledge_entry',
      label: '删知识条目',
      description: '按名字删一个知识库条目（过时/下架/录错）。只有导演明确说删才用。',
      parameters: Type.Object({
        name: Type.String({ description: '条目名' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const found = knowledge.listProducts().find((p) => p.name === params.name.trim())
          if (!found) return `知识库里没有「${params.name}」`
          knowledge.deleteProduct(found.id)
          return `已删知识条目：「${found.name}」`
        })
    }),
    defineTool({
      name: 'sync_products',
      label: '同步商品',
      description:
        '从抖音商城（连接器）同步商品数据进知识库：拉绑定商品列表，按外部 id 去重更新。上架/改价/换卖点后用这个拿最新数据。',
      parameters: Type.Object({}),
      execute: async () =>
        guardToolAsync(async () => {
          if (!syncProducts) return '同步通道没接上，让导演在知识库页点「同步商品」'
          const r = await syncProducts()
          return `同步完成：新增 ${r.added}、更新 ${r.updated}，共 ${r.total} 个商品`
        })
    }),
    defineTool({
      name: 'list_connector_tools',
      label: '看连接器能力',
      description: '列出抖音连接器提供的外部工具（商城/订单/数据类），想知道连接器能干什么用它探测。',
      parameters: Type.Object({}),
      execute: async () =>
        guardToolAsync(async () => {
          if (!connector) return '连接器没接线'
          const tools = await connector.listTools()
          if (tools.length === 0) return '连接器没连上（或它没有提供工具）：先在设置里确认端口/Token'
          return tools.map((t, i) => `${i + 1}. ${t.name}：${t.description ?? '无描述'}`).join('\n')
        })
    }),
    defineTool({
      name: 'call_connector_tool',
      label: '调连接器工具',
      description:
        '调抖音连接器的外部工具（查订单/商品数据/直播数据等，工具名从 list_connector_tools 拿）。外部数据不能全信，涉及价格/承诺以知识库为准。',
      parameters: Type.Object({
        name: Type.String({ description: '工具名' }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '参数对象，缺省 {}' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          if (!connector) return '连接器没接线'
          const text = await connector.callTool(params.name.trim(), params.args ?? {})
          return text.slice(0, 3000)
        })
    }),
    defineTool({
      name: 'fetch_url',
      label: '看网页',
      description:
        '抓取一个网页的正文（官网说明/评测/资料页）。结果标注「外部信息，需人工确认」：数字/功效以知识库为准，别直接照搬进承诺。',
      parameters: Type.Object({
        url: Type.String({ description: 'http/https 链接' })
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const text = await fetchUrlGuarded(params.url.trim())
          return `【外部信息，需人工确认】\n${text}`
        })
    }),
    defineTool({
      name: 'web_search',
      label: '搜网络',
      description:
        '联网搜索（前 5 条：标题/链接/摘要）：查商品行情、竞品信息、外部资料。结果标注「外部信息，需人工确认」。',
      parameters: Type.Object({
        query: Type.String({ description: '搜索关键词' })
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const hits = await webSearchGuarded(params.query)
          const body = hits
            .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet.slice(0, 150)}`)
            .join('\n')
          return `【外部信息，需人工确认】\n${body}`
        })
    }),
    defineTool({
      name: 'check_price',
      label: '查价格（护栏）',
      description:
        '查商品价格。硬性规则：直播里报的任何价格/优惠数字必须来自这个工具的返回，查不到就说不确定，绝不许编造。',
      parameters: Type.Object({
        product: Type.Optional(Type.String({ description: '商品名（模糊匹配），不传返回全部商品价格表' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const rows = knowledge.checkPrice(params.product)
          if (rows.length === 0) return '没查到这个商品，价格不确定，不要在直播里报价'
          return rows.map((row) => `${row.name}：¥${row.price}`).join('\n')
        })
    }),
    defineTool({
      name: 'lookup_viewer',
      label: '查观众画像',
      description: '查一位观众的画像：互动次数、问过什么、你记过的偏好。用来认出老粉。',
      parameters: Type.Object({
        name: Type.String({ description: '观众昵称' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const profile = memory.lookupViewer(params.name)
          if (!profile) return `${params.name} 是新观众，没有画像`
          return `${profile.name}：${memory.describeViewer(profile)}`
        })
    }),
    defineTool({
      name: 'remember_viewer',
      label: '记住观众',
      description: '给观众记一笔偏好/特征（比如「家里有小孩」「预算 200 以内」），下次他来直播你能认出他。',
      parameters: Type.Object({
        name: Type.String({ description: '观众昵称' }),
        note: Type.String({ description: '要记住的内容，一句话' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          memory.rememberViewer(params.name, params.note)
          return `已记住 ${params.name}：${params.note}`
        })
    }),
    defineTool({
      name: 'ask_director',
      label: '请示导演',
      description:
        '需要人拍板时问导演：指令有歧义（「把报价改一下」但本场有两个商品）、场景该推进还是循环、观众追问知识库没有的参数、准备做超出知识库的承诺。' +
        '问完立刻按 default 继续播，不要停下等回答——导演的回答会作为新指令进来。' +
        '不许问的（自己定）：回哪条评论、要不要插播、冷场怎么救、语气怎么调。',
      parameters: Type.Object({
        question: Type.String({ description: '要请示的问题，一两句话，说清背景' }),
        options: Type.Optional(
          Type.Array(Type.String(), { description: '给导演的快捷选项（2-3 个），导演点一下就能答' })
        ),
        timeoutSec: Type.Optional(Type.Number({ description: '等多久没答就算过期，默认 60 秒' })),
        defaultAction: Type.Optional(Type.String({ description: '没等到回答时你按什么继续，比如「先含糊带过」' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const timeoutSec = Math.min(Math.max(Math.round(params.timeoutSec ?? 60), 10), 600)
          onDirectorAsk?.({
            text: params.question,
            options: (params.options ?? []).filter((o) => o.trim()).slice(0, 4),
            timeoutSec,
            defaultAction: params.defaultAction?.trim() || undefined
          })
          return (
            `已请示导演（${timeoutSec} 秒没答就算过期）。继续按你的默认策略播，不要停：` +
            `${params.defaultAction?.trim() || '照原节奏继续'}`
          )
        })
    }),
    defineTool({
      name: 'goto_scene',
      label: '跳到指定场景',
      description: '直接跳到剧本里某一场景（序号从 1 数起）：要跳过某场或回到前面某场时用；按顺序推进用 advance_scene。',
      parameters: Type.Object({
        index: Type.Number({ description: '目标场景序号，从 1 开始' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const target = script.gotoScene(Math.floor(params.index) - 1)
          if (!target) return '没有这个场景（或本场没绑剧本），序号从 1 数起'
          onSceneChanged()
          onSceneAdvanced?.(target.index)
          return `已跳到第 ${target.index + 1}/${target.total} 场「${target.scene.title}」\n目标：${target.scene.goal}\n要点：${target.scene.keyPoints}`
        })
    }),
    defineTool({
      name: 'create_scene',
      label: '加一场（自编剧本）',
      description:
        '给本场剧本加一场景：节目没绑剧本时自动建一本你自编的剧本并绑上。你自己编排直播结构用——' +
        '先想清楚这场直播分几幕（开场留人/痛点/讲解/互动/催单/收尾），逐场建好，再按场景写稿或播讲。position 省略 = 追加到末尾。',
      parameters: Type.Object({
        title: Type.String({ description: '场景名，比如「痛点共鸣」「催单收尾」' }),
        goal: Type.String({ description: '这场要达成什么，一句话' }),
        keyPoints: Type.String({ description: '必讲要点，一行一条' }),
        estDurationMin: Type.Optional(Type.Number({ description: '预计时长（分钟），默认 5' })),
        position: Type.Optional(Type.Number({ description: '插到第几场（序号从 1 数起），省略 = 追加到末尾' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const programId = activeProgramId()
          if (!programId) return '当前没有节目，没法编剧本'
          const result = script.appendScene(
            programId,
            {
              title: params.title,
              goal: params.goal,
              keyPoints: params.keyPoints,
              estDurationMin: params.estDurationMin
            },
            params.position
          )
          onSceneChanged()
          return sceneListReport('已加一场', result.script)
        })
    }),
    defineTool({
      name: 'update_scene',
      label: '改一场（自编剧本）',
      description: '改某一场的名字/目标/要点/时长（序号从 1 数起，只传要改的字段）。临场调整剧本结构用。',
      parameters: Type.Object({
        index: Type.Number({ description: '第几场（序号从 1 数起）' }),
        title: Type.Optional(Type.String({ description: '场景名' })),
        goal: Type.Optional(Type.String({ description: '这场要达成什么' })),
        keyPoints: Type.Optional(Type.String({ description: '必讲要点，一行一条' })),
        estDurationMin: Type.Optional(Type.Number({ description: '预计时长（分钟）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const programId = activeProgramId()
          if (!programId) return '当前没有节目，没法改剧本'
          const result = script.updateScene(programId, params.index, {
            title: params.title,
            goal: params.goal,
            keyPoints: params.keyPoints,
            estDurationMin: params.estDurationMin
          })
          onSceneChanged()
          return sceneListReport(`已改第 ${result.index + 1} 场`, result.script)
        })
    }),
    defineTool({
      name: 'remove_scene',
      label: '删一场（自编剧本）',
      description: '删掉某一场（序号从 1 数起）。写在这个场景里的底稿不会跟着删（变成孤儿段，可按 sceneId 清理）。',
      parameters: Type.Object({
        index: Type.Number({ description: '第几场（序号从 1 数起）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const programId = activeProgramId()
          if (!programId) return '当前没有节目，没法改剧本'
          const result = script.removeScene(programId, params.index)
          onSceneChanged()
          return sceneListReport('已删一场', result.script)
        })
    }),
    defineTool({
      name: 'set_voice',
      label: '换音色',
      description:
        '把本场音色换成另一个（voiceId 从音色库来；传空字符串回到人设卡音色）。换完之后新说出的每一句都用新音色，池里还没播的旧音色音频会自动用新嗓音重合成（正在播和已播完的不受影响）。',
      parameters: Type.Object({
        voiceId: Type.String({ description: '音色 id，留空 = 回到人设卡音色' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const voiceId = String(params.voiceId ?? '').trim()
          setProgramVoice?.(voiceId)
          const effective = voiceId || persona.get().voiceId
          const reVoiced = pool.reVoice(effective)
          const tail = reVoiced > 0 ? `，${reVoiced} 条未播的旧音色话术已加入重合成` : ''
          return voiceId ? `本场音色已换成 ${voiceId}，后面新说的都用它${tail}` : `已清掉本场音色，回到人设卡的音色${tail}`
        })
    }),
    defineTool({
      name: 'set_gap',
      label: '调段间留白',
      description:
        '调直播的段间留白（毫秒）：正常内容播完一条后的停顿。秒杀/快节奏调小（比如 400），讲故事/宣讲调大（比如 2000）；' +
        '传 0 回到系统默认。插播/回评论永远不等留白，不用你操心。',
      parameters: Type.Object({
        gapMs: Type.Number({ description: '留白毫秒数，0 = 回系统默认' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const ms = Math.max(0, Math.min(10000, Math.floor(Number(params.gapMs) || 0)))
          setProgramGap?.(ms)
          return ms > 0 ? `段间留白已调成 ${ms}ms，下一条正常内容开始生效` : '已回系统默认留白'
        })
    }),
    defineTool({
      name: 'pause_broadcast',
      label: '暂停播报',
      description:
        '暂停播报：停住播放，你也暂时不许说新话术（评论/触发器不再进来）。导演要接管麦克风或要求安静时用，恢复用 resume_broadcast。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          onPlaybackControl?.('pause')
          return '已暂停播报（池里的内容保留）——你现在说不出去，等恢复'
        })
    }),
    defineTool({
      name: 'resume_broadcast',
      label: '恢复播报',
      description: '恢复播报，接着播池里没播完的内容，你也可以重新开口了。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          onPlaybackControl?.('resume')
          return '已恢复播报'
        })
    }),
    defineTool({
      name: 'skip_current',
      label: '跳过当前这条',
      description: '掐掉正在播的这条，直接播下一条（说错了、卡住了、内容过时了就用）。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          onPlaybackControl?.('skip')
          return '已跳过当前这条'
        })
    }),
    defineTool({
      name: 'mark_live_events',
      label: '标记直播间动态',
      description:
        '标记直播间动态批次的处理结果：回过的标 handled，不想理的标 ignored。不标也行——5 分钟后自动过期，不会再提醒。事件 id 在每批动态列表每条的 [方括号] 里。',
      parameters: Type.Object({
        ids: Type.Array(Type.String(), { description: '动态 id 列表（批次里每条的 [le-xxx]）' }),
        state: Type.Union([Type.Literal('handled'), Type.Literal('ignored')], {
          description: 'handled=已回应，ignored=不理'
        })
      }),
      execute: async (_id, params) =>
        guardTool(() => markLiveEvents?.(params.ids, params.state) ?? '收件箱没接上')
    }),
    defineTool({
      name: 'start_live',
      label: '开始直播',
      description:
        '正式启动当前节目开播（装载底稿、打开播出通道、开始接评论）。只有导演明确说「开播 / 开始直播」才用；备稿、闲聊、彩排阶段别碰。预检不过会返回缺什么，按提示补齐后再试。',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          if (getPurpose?.() === 'live') return ok('已经在直播了，不用重复开播')
          if (!onGoLive) return ok('开播通道没接上，让导演从界面点「启动节目」')
          return ok(await onGoLive())
        } catch (error) {
          return ok(`开播失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  ]
}

/**
 * 形态单调性检测（write_bits 的软反馈）：一批桥段全是同一种类型（≥3 段）就提醒换形态——
 * 一场戏全是叫卖或全是故事都平，类型穿插才有起伏。
 */
function bitTypeMonotony(types: string[]): string | null {
  if (types.length < 3) return null
  const first = types[0].trim()
  if (!first) return null
  if (types.every((t) => t.trim() === first)) return `这批 ${types.length} 段全是「${first}」类型`
  return null
}

/** 剧本工具的统一回报：动作结果 + 最新场景序列（system prompt 里的清单是出生时快照，改完以这里为准） */
function sceneListReport(action: string, script: Script): string {
  if (script.scenes.length === 0) return `${action}。剧本现在是空的，用 create_scene 重新编排`
  const list = script.scenes
    .map((s, i) => `${i + 1}. ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}`)
    .join('\n')
  return `${action}。最新场景序列（system prompt 里那份是开播时的快照，以这份为准）：\n${list}`
}
