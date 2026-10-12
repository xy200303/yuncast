import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { LiveComment, Persona, PlaybackControlAction } from '../../shared/types'
import type { SpeechPool } from './SpeechPool'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'

/**
 * 主播 Agent 的工具表（docs/01 §3.3）。
 * 抽成独立工厂是为了无头测试：不建会话也能直接调 execute 验证逻辑。
 */

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
}

export function buildAnchorTools(deps: AnchorToolDeps): ToolDefinition[] {
  const {
    pool,
    knowledge,
    memory,
    persona,
    script,
    getLastComment,
    onSceneChanged,
    getPlanVoice,
    onSceneAdvanced,
    onDirectorAsk,
    setPlanVoice,
    onPlaybackControl,
    getSpeakingPaused
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
      description: '插播一句话：当前正在播的内容播完后立即播这条。只在回复观众评论或紧急情况使用。',
      parameters: Type.Object({
        text: Type.String({ description: '要插播的话，一句' }),
        voice: Type.Optional(Type.String({ description: '音色 id，不传就用当前主播的音色' })),
        role: Type.Optional(Type.String({ description: '角色名（编剧模式）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (getSpeakingPaused?.()) return '播报已暂停：插播也播不出去，等导演恢复'
          const comment = getLastComment()
          const replyTo = comment ? { commentId: comment.id, author: comment.author } : undefined
          pool.insertNext({
            text: params.text,
            voiceId: resolveVoice(persona.get(), params.role, params.voice, getPlanVoice?.()),
            sourceAgentId: AGENT_SOURCE_ID,
            sourceKind: 'reply',
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
            .map((item) => ({ id: item.id, lane: item.lane, status: item.status, text: item.text }))
          return JSON.stringify({
            未播总数: status.active,
            分车道: status.byLane,
            正在播: status.playing ? { id: status.playing.id, text: status.playing.text } : null,
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
    })
  ]
}

/** 主播工具名清单（createAgentSession 的 tools allowlist 要逐项点名） */
export const ANCHOR_TOOL_NAMES = [
  'say',
  'insert_next',
  'get_pool_status',
  'get_recent_played',
  'revise_item',
  'advance_scene',
  'goto_scene',
  'set_voice',
  'pause_broadcast',
  'resume_broadcast',
  'skip_current',
  'search_knowledge',
  'check_price',
  'lookup_viewer',
  'remember_viewer',
  'ask_director'
]
