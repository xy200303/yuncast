import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type TSchema } from 'typebox'
import type { LiveComment, Persona, PlaybackControlAction, UtteranceSource, UtteranceStatus } from '../../shared/types'
import type { SpeechPool } from './SpeechPool'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import type { UtteranceService } from './UtteranceService'

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

/** 编剧模式：role 名 → 角色音色。音色优先级（docs/07 §8.5）：显式 voice > 场次音色 > 角色音色 > 人设卡音色。都没有返回 undefined（合成路由会因此报错，不兜底） */
export function resolveVoice(
  persona: Persona,
  role?: string,
  voice?: string,
  planVoice?: string
): string | undefined {
  if (voice?.trim()) return voice.trim()
  if (planVoice?.trim()) return planVoice.trim()
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
  /** 场次底稿库（list/edit/add/remove_draft：导演口径调整落到底稿，长期生效） */
  utterances: UtteranceService
  /** insert_next 挂 replyTo 用的最近评论 */
  getLastComment: () => LiveComment | null
  /** 场景推进后通知 AgentService 广播状态（提词器刷新） */
  onSceneChanged: () => void
  /** 当前场次指定音色（运行态，场次加载时写入；热切换 set_voice 也改它） */
  getPlanVoice?: () => string
  /** 场景切换后装载新场景话术库（AgentService 转发给 LaunchService） */
  onSceneAdvanced?: (sceneIndex: number) => void
  /** 请示导演（ask_director）：进对话面板高亮卡片，不阻塞直播（docs/07 §8.8.6 ④） */
  onDirectorAsk?: (ask: {
    text: string
    options: string[]
    timeoutSec: number
    defaultAction?: string
  }) => void
  /** 运行态换音色（set_voice） */
  setPlanVoice?: (voiceId: string) => void
  /** 播报控制（pause/resume/skip）：广播到渲染进程执行 */
  onPlaybackControl?: (action: PlaybackControlAction) => void
  /** 播报是否被暂停：暂停期间 say / insert_next 直接拒（说出去的话收不回） */
  getSpeakingPaused?: () => boolean
  /** 会话用途：prep=写稿备播（say/insert_next 关闭，产出只走 write_drafts），live=直播中 */
  getPurpose?: () => 'prep' | 'live'
  /** 正式启动当前场次开播（start_live）：返回开播结果或预检拦截原因 */
  onGoLive?: () => Promise<string>
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
    getPlanVoice,
    onSceneAdvanced,
    onDirectorAsk,
    setPlanVoice,
    onPlaybackControl,
    getSpeakingPaused,
    getPurpose,
    onGoLive
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

  // ---------- 底稿工具共用 ----------
  const DRAFT_STATUS: Record<UtteranceStatus, string> = {
    pending: '待合成',
    synthesizing: '合成中',
    ready: '就绪',
    failed: '失败'
  }
  const activePlanId = (): string | null => script.getActive().plan?.id ?? null
  const currentSceneId = (): string => script.currentScene()?.scene.id ?? ''
  const sceneTitleOf = (sceneId: string): string => {
    if (sceneId === '') return '全场通用'
    const bound = script.getActive().script
    return bound?.scenes.find((s) => s.id === sceneId)?.title ?? sceneId
  }
  const requirePlan = (): string | null => {
    const planId = activePlanId()
    return planId ? null : '当前没有场次，没有底稿可管'
  }

  return [
    defineTool({
      name: 'say',
      label: '说一句',
      description:
        '说一句常规话术，排进话术池队列等待播出。每次只说一句完整的话（40 字以内最佳），口语化。role 参数用于编剧模式：以某个角色的口吻写台词。',
      parameters: Type.Object({
        text: Type.String({ description: '要说的话，一句' }),
        voice: Type.Optional(Type.String({ description: '音色 id，不传就用当前主播的音色' })),
        role: Type.Optional(Type.String({ description: '角色名（编剧模式），台词按该角色音色播出' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (getPurpose?.() === 'prep') return '写稿模式：播出通道关着，底稿用 write_drafts 入库'
          if (getSpeakingPaused?.()) return '播报已暂停：说的话暂时播不出去，等导演恢复再说'
          const voiceId = resolveVoice(persona.get(), params.role, params.voice, getPlanVoice?.())
          pool.say({
            text: params.text,
            voiceId,
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
        '插播一句话：当前正在播的内容播完后播这条。只在回复观众评论或紧急情况使用。' +
        'when 默认 now（当前这条播完就播）；不着急的补充可以传 paragraph_end，' +
        '等当前这段连贯讲解整体播完再插，别在一段话中间拦腰砍。',
      parameters: Type.Object({
        text: Type.String({ description: '要插播的话，一句' }),
        voice: Type.Optional(Type.String({ description: '音色 id，不传就用当前主播的音色' })),
        role: Type.Optional(Type.String({ description: '角色名（编剧模式）' })),
        when: Type.Optional(
          Type.Union([Type.Literal('now'), Type.Literal('paragraph_end')], {
            description: 'now=当前这条播完就播（默认）；paragraph_end=等当前连贯段落播完再插'
          })
        )
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (getPurpose?.() === 'prep') return '写稿模式：播出通道关着，底稿用 write_drafts 入库'
          if (getSpeakingPaused?.()) return '播报已暂停：插播也播不出去，等导演恢复'
          const comment = getLastComment()
          const replyTo = comment ? { commentId: comment.id, author: comment.author } : undefined
          const input = {
            text: params.text,
            voiceId: resolveVoice(persona.get(), params.role, params.voice, getPlanVoice?.()),
            sourceAgentId: AGENT_SOURCE_ID,
            sourceKind: 'reply' as const,
            replyTo
          }
          if (params.when === 'paragraph_end') {
            pool.insertAfterParagraph(input)
            return `已插播（等这段讲完）：「${params.text}」`
          }
          pool.insertNext(input)
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
              // 连贯段落位置（如 2/5）：整段合成的一组，语气连贯，插话尽量等段尾
              ...(item.paraId ? { 段: `${item.paraPos ?? '?'}/${item.paraLen ?? '?'}` } : {}),
              text: item.text
            }))
          return JSON.stringify({
            未播总数: status.active,
            分车道: status.byLane,
            正在播: status.playing
              ? {
                  id: status.playing.id,
                  ...(status.playing.paraId
                    ? { 段: `${status.playing.paraPos ?? '?'}/${status.playing.paraLen ?? '?'}` }
                    : {}),
                  text: status.playing.text
                }
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
        '看本场底稿库（开播前生成的话术底稿，轮播的骨架）：按关键词搜，或看当前场景的。改/删底稿前先用它拿条目 id。',
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: '按文本内容过滤，比如旧价格、卖点词' })),
        scope: Type.Optional(
          Type.Union([Type.Literal('scene'), Type.Literal('all')], {
            description: 'scene=当前场景+全场通用（默认），all=全场次'
          })
        )
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requirePlan()
          if (noPlan) return noPlan
          const all = utterances.list(activePlanId()!)
          const sceneId = currentSceneId()
          let list =
            params.scope === 'all'
              ? all
              : all.filter((u) => u.sceneId === sceneId || u.sceneId === '')
          const kw = params.keyword?.trim()
          if (kw) list = list.filter((u) => u.text.includes(kw))
          if (list.length === 0) return kw ? `没有包含「${kw}」的底稿` : '这个范围还没有底稿'
          const shown = list.slice(0, 30)
          return (
            `共 ${list.length} 条${list.length > 30 ? '，只列前 30 条' : ''}：\n` +
            shown
              .map((u) => `${u.id}｜${sceneTitleOf(u.sceneId)}｜${DRAFT_STATUS[u.status]}｜${u.text}`)
              .join('\n')
          )
        })
    }),
    defineTool({
      name: 'edit_draft',
      label: '改底稿',
      description:
        '改一条底稿的文本，长期生效（导演口径调整/价格修正/说法优化）。改完旧音频作废、后台自动重新合成；已经在池里没播的副本不受影响，要改用 revise_item。',
      parameters: Type.Object({
        id: Type.String({ description: '底稿条目 id（list_drafts 拿）' }),
        text: Type.String({ description: '新文本，一句完整口语' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requirePlan()
          if (noPlan) return noPlan
          const planId = activePlanId()!
          const existing = utterances.list(planId).find((u) => u.id === params.id.trim())
          if (!existing) return `找不到底稿 ${params.id}（用 list_drafts 拿正确的 id）`
          utterances.save(
            {
              planId,
              sceneId: existing.sceneId,
              variantIdx: existing.variantIdx,
              text: params.text,
              voiceId: existing.voiceId,
              source: existing.source,
              sources: existing.sources
            },
            existing.id
          )
          void utterances.kickSynthesis(planId)
          return `已改：「${params.text}」。旧音频作废，后台重新合成中，好了之后轮播/装载就用新版`
        })
    }),
    defineTool({
      name: 'add_draft',
      label: '补底稿',
      description:
        '把一个新说法记进底稿库（默认记到当前场景），合成完进入轮播。现场临时编的好说法值得记；想现在就播直接用 say，别用它。',
      parameters: Type.Object({
        text: Type.String({ description: '底稿文本，一句完整口语' }),
        sceneId: Type.Optional(Type.String({ description: '记到哪个场景；不传记到当前场景，没有剧本则记为全场通用' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requirePlan()
          if (noPlan) return noPlan
          const planId = activePlanId()!
          const sceneId = params.sceneId?.trim() ?? currentSceneId()
          const siblings = utterances.list(planId).filter((u) => u.sceneId === sceneId)
          const variantIdx = siblings.reduce((max, u) => Math.max(max, u.variantIdx + 1), 0)
          utterances.save({
            planId,
            sceneId,
            variantIdx,
            text: params.text,
            voiceId: '',
            source: 'initial',
            sources: []
          })
          void utterances.kickSynthesis(planId)
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
          const noPlan = requirePlan()
          if (noPlan) return noPlan
          const planId = activePlanId()!
          const existing = utterances.list(planId).find((u) => u.id === params.id.trim())
          if (!existing) return `找不到底稿 ${params.id}（用 list_drafts 拿正确的 id）`
          utterances.remove(existing.id)
          return `已删底稿：「${existing.text}」`
        })
    }),
    defineTool({
      name: 'write_drafts',
      label: '批量写底稿',
      description:
        '编剧模式批量入库：把为某个场景写好的一批底稿存进底稿库（每批 10~15 条，写稿任务书里有逐场目标条数和 sceneId）。' +
        'sources 填每条参考过的来源名（商品名/文件名），没参考就空数组。入库是待合成状态，导演审完统一预合成，不用你管音频。',
      parameters: Type.Object({
        sceneId: Type.String({ description: '写到哪个场景（写稿任务书里的 sceneId）' }),
        items: Type.Array(
          Type.Object({
            text: Type.String({ description: '一条底稿，一句完整口语' }),
            sources: Type.Optional(
              Type.Array(
                Type.Object({
                  type: Type.Union([Type.Literal('file'), Type.Literal('url'), Type.Literal('product')]),
                  name: Type.String({ description: '来源名（商品名/文件名/网址）' }),
                  snippet: Type.String({ description: '引用的关键信息，一句话' })
                }),
                { description: '这条参考的来源' }
              )
            )
          }),
          { description: '本批底稿（10~15 条）' }
        )
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const noPlan = requirePlan()
          if (noPlan) return noPlan
          const saved = utterances.saveMany(
            activePlanId()!,
            params.sceneId.trim(),
            params.items.map((item) => ({
              text: item.text,
              sources: (item.sources ?? []).map(
                (s): UtteranceSource => ({ type: s.type, id: '', name: s.name, snippet: s.snippet })
              )
            }))
          )
          // 不自动合成：写稿阶段量大，审阅后由「预合成全部」统一跑（edit_draft/add_draft 的单条急用才自动合成）
          const sceneCount = utterances
            .list(activePlanId()!)
            .filter((u) => u.sceneId === params.sceneId.trim()).length
          const monotony = openingMonotony(saved.map((u) => u.text))
          return (
            `已入库 ${saved.length} 条到「${sceneTitleOf(params.sceneId.trim())}」（待合成；本场景现有 ${sceneCount} 条）` +
            (monotony
              ? `\n注意：这批有 ${monotony}——底稿是轮播的，开头全一样播出来像复读机，下一批换开头（品名/数字/提问/场景直接切入，称呼少带）`
              : '')
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
        index: Type.Number({ description: '目标场次序号，从 1 开始' })
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
      name: 'set_voice',
      label: '换音色',
      description:
        '把本场音色换成另一个（voiceId 从音色库来；传空字符串回到人设卡音色）。换完之后新说出的每一句都用新音色，已经在池里的旧音频不受影响。',
      parameters: Type.Object({
        voiceId: Type.String({ description: '音色 id，留空 = 回到人设卡音色' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const voiceId = String(params.voiceId ?? '').trim()
          setPlanVoice?.(voiceId)
          return voiceId ? `本场音色已换成 ${voiceId}，后面新说的都用它` : '已清掉场次音色，回到人设卡的音色'
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
      name: 'start_live',
      label: '开始直播',
      description:
        '正式启动当前场次开播（装载底稿、打开播出通道、开始接评论）。只有导演明确说「开播 / 开始直播」才用；备稿、闲聊、彩排阶段别碰。预检不过会返回缺什么，按提示补齐后再试。',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          if (getPurpose?.() === 'live') return ok('已经在直播了，不用重复开播')
          if (!onGoLive) return ok('开播通道没接上，让导演从界面点「启动场次」')
          return ok(await onGoLive())
        } catch (error) {
          return ok(`开播失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  ]
}

/**
 * 开头单调性检测（write_drafts 的软反馈）：批量写稿时模型容易锁定同一个开头模板，
 * 检测两种形态——同一前 3 字开头占比超过四成；相邻两条同开头。命中返回提示文字，否则 null。
 */
function openingMonotony(texts: string[]): string | null {
  if (texts.length < 4) return null
  const openings = texts.map((text) => text.trim().slice(0, 3))
  const counts = new Map<string, number>()
  for (const opening of openings) counts.set(opening, (counts.get(opening) ?? 0) + 1)
  let top = ''
  let topCount = 0
  for (const [opening, count] of counts) {
    if (count > topCount) {
      top = opening
      topCount = count
    }
  }
  if (topCount >= Math.ceil(texts.length * 0.4)) {
    return `${topCount}/${texts.length} 条都是「${top}…」开头`
  }
  for (let i = 1; i < openings.length; i++) {
    if (openings[i] === openings[i - 1]) return `相邻两条都是「${openings[i]}…」开头`
  }
  return null
}
