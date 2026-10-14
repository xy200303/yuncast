import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type TSchema } from 'typebox'
import {
  BROADCAST_MODE_LABELS,
  CONTENT_TYPE_LABELS,
  TTS_PROVIDER_SHORT,
  type AgentStatus,
  type ProduceAudioResult,
  type ProducePlanInfo,
  type Program,
  type Script,
  type VoiceRecord
} from '../../shared/types'
import { audioProgress, listAudioUnits } from './programUnits'
import type { StorageService } from './StorageService'
import type { ScriptService } from './ScriptService'
import type { PersonaService } from './PersonaService'
import type { UtteranceService } from './UtteranceService'
import type { SpeechPool } from './SpeechPool'
import type { VoiceService } from './VoiceService'
import type { TriggerRuntime } from './TriggerRuntime'
import type { ConnectorService } from './ConnectorService'
import type { StreamService } from './stream/StreamService'
import type { ExportService } from './ExportService'

/**
 * 主播 Agent 的系统控制工具（docs/10 §10.1-10.5，P2）。
 * 与 anchorTools（说话/写稿/播出控制）分工：这里管系统资源——节目/剧本/主播/音色/触发器/全局状态。
 * 三层语义：
 * - 只读发现（list_x / get_x 系列）：直接执行；
 * - 可逆写入（save_x / set_x / rename_voice）：结构化参数 + 服务层校验 + expectedUpdatedAt 并发保护；
 * - 破坏性/外部副作用（delete_x / clear_x / start_x）：先向导演发确认卡，导演确认后带 confirmed=true 重调才执行；
 *   emergency_stop 是例外（安全优先，直接执行并通知导演）。
 * 业务逻辑都在服务层，这里只做参数校验、引用检查和结果组装。
 */

function defineTool<TParameters extends TSchema>(def: AgentTool<TParameters>): AgentTool<TParameters> {
  return def
}

export interface AnchorSystemToolDeps {
  storage: StorageService
  script: ScriptService
  persona: PersonaService
  utterances: UtteranceService
  pool: SpeechPool
  /** Agent 运行状态（会话态/开播态/资产是否过期） */
  getStatus: () => AgentStatus
  /** 会话绑定的节目（删除保护用）：无会话返回 null */
  getSessionInfo: () => { programId: string; purpose: 'live' | 'prep' } | null
  /** 当前主播卡 id */
  getActivePersonaId: () => string
  /** 切换当前主播（走 AgentService.handoff 原子换人机制） */
  handoffPersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>
  /** 请示导演确认卡（与 anchorTools 的 ask_director 同一机制） */
  onDirectorAsk?: (ask: {
    text: string
    options: string[]
    timeoutSec: number
    defaultAction?: string
  }) => void
  /** 系统旁白上对话时间线（emergency_stop 执行后通知导演） */
  notifyTimeline?: (text: string) => void
  /** 选中节目后让主播就位的预热（与 UI 的 programSetActive 同语义） */
  warmupProgram?: (programId: string) => void
  /** 紧急停止的总闸（index.ts 接上：掐声音+停播放循环+停会话） */
  onEmergencyStop?: () => Promise<void>
  getConnector: () => ConnectorService | null
  getVoices: () => VoiceService | null
  getTriggers: () => TriggerRuntime | null
  getStream: () => StreamService | null
  /** 节目音频导出（export_program 工具；没接上时让导演走界面导出弹窗） */
  getExporter?: () => ExportService | null
  /** 统一音频生产入口（produce_program_audio 工具）：rolling=提前合成全部；prepared=生成节目音频（有外部费用） */
  produceProgramAudio?: (programId: string) => Promise<ProduceAudioResult>
  /** 生产前的合成计划摘要（确认卡用：范围/预计时长/模型与声音快照） */
  describeProducePlan?: (programId: string) => ProducePlanInfo
}

const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABELS) as (keyof typeof CONTENT_TYPE_LABELS)[]
const BROADCAST_MODES = Object.keys(BROADCAST_MODE_LABELS) as (keyof typeof BROADCAST_MODE_LABELS)[]

export function buildAnchorSystemTools(deps: AnchorSystemToolDeps): AgentTool[] {
  const {
    storage,
    script,
    persona,
    utterances,
    pool,
    getStatus,
    getSessionInfo,
    getActivePersonaId,
    handoffPersona,
    onDirectorAsk,
    notifyTimeline,
    warmupProgram,
    onEmergencyStop,
    getConnector,
    getVoices,
    getTriggers,
    getStream,
    getExporter,
    produceProgramAudio,
    describeProducePlan
  } = deps

  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })
  const guardTool = (fn: () => string) => {
    try {
      return ok(fn())
    } catch (error) {
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

  // ---------- 共用助手 ----------
  const activeProgramId = (): string => storage.getConfig().live.activeProgramId
  const findProgram = (id: string): Program | undefined =>
    script.listPrograms().find((p) => p.id === id.trim())
  const findScript = (id: string): Script | null => script.getScript(id.trim())
  /** 节目底稿统计（引用统计：底稿数/音频就绪数） */
  const draftStats = (programId: string): { total: number; ready: number; pending: number; failed: number } => {
    const all = utterances.list(programId)
    return {
      total: all.length,
      ready: all.filter((u) => u.status === 'ready').length,
      pending: all.filter((u) => u.status === 'pending' || u.status === 'synthesizing').length,
      failed: all.filter((u) => u.status === 'failed').length
    }
  }
  /** 引用某剧本的节目 */
  const programsUsingScript = (scriptId: string): Program[] =>
    script.listPrograms().filter((p) => p.scriptId === scriptId)
  /** 启用某触发器的节目 */
  const programsUsingTrigger = (triggerId: string): Program[] =>
    script.listPrograms().filter((p) => p.enabledTriggerIds.includes(triggerId))
  /** 音色显示名：克隆音色按 voiceType 反查音色库，查不到原样显示标识 */
  const voiceLabel = (voiceId: string): string => {
    if (!voiceId.trim()) return '（未设置）'
    const found = getVoices()?.list().find((v) => v.voiceType === voiceId.trim())
    return found ? `${found.name}（${voiceId.trim()}）` : voiceId.trim()
  }
  /** 触发器显示名（查不到标注已删除） */
  const triggerLabel = (id: string): string => {
    const found = getTriggers()?.list().find((t) => t.id === id)
    return found ? found.name : `${id}（已不存在）`
  }

  /**
   * 破坏性操作的两段确认（docs/10 §10.2/§15.15）：
   * 没带 confirmed=true 时只发导演确认卡（卡里写清做什么/影响什么/能否恢复/被谁引用），返回 null 之外的文案；
   * 导演确认后 Agent 带 confirmed=true 重调才真正执行。
   */
  const askConfirm = (summary: string): string => {
    if (!onDirectorAsk) return '确认通道没接上（ask_director 不可用）：破坏性操作不能执行，让导演在界面手动操作'
    onDirectorAsk({
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

  return [
    // ==================== 只读发现 ====================
    defineTool({
      name: 'list_programs',
      label: '看节目列表',
      description:
        '列出全部节目：名称、内容类型、播出方式、底稿数/音频就绪数、是不是当前节目、版本号（改它时作 expectedUpdatedAt 用）。要了解系统里有哪些节目、或拿节目 id 用它。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const programs = script.listPrograms()
          if (programs.length === 0) return '还没有节目：用 save_program 新建一个'
          const activeId = activeProgramId()
          return JSON.stringify(
            programs.map((p) => {
              const stats = draftStats(p.id)
              return {
                id: p.id,
                名称: p.name,
                内容类型: CONTENT_TYPE_LABELS[p.contentType],
                播出方式: BROADCAST_MODE_LABELS[p.broadcastMode],
                底稿: stats.total,
                音频就绪: stats.ready,
                当前节目: p.id === activeId,
                版本号: p.updatedAt
              }
            })
          )
        })
    }),
    defineTool({
      name: 'get_program',
      label: '看节目详情',
      description:
        '看一个节目的完整配置：内容类型/播出方式/播完策略/事件规则/声音安排/绑的剧本/知识范围/场景进度，附底稿与音频就绪统计和版本号（updatedAt）。改节目之前先用它读一遍。',
      parameters: Type.Object({
        programId: Type.String({ description: '节目 id（list_programs 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const program = findProgram(params.programId)
          if (!program) return `节目 ${params.programId} 不存在（用 list_programs 拿正确的 id）`
          const bound = program.scriptId ? findScript(program.scriptId) : null
          const stats = draftStats(program.id)
          const audio = program.audioConfig
          // 节目音频进度（预制音频资产，docs/10 §7.7）：单元总数/ready/synthesizing/failed/stale/pending
          const renderedProgress = audioProgress(program, bound, utterances.list(program.id))
          return JSON.stringify({
            id: program.id,
            名称: program.name,
            主题: program.theme || '（未设定）',
            内容类型: CONTENT_TYPE_LABELS[program.contentType],
            播出方式: BROADCAST_MODE_LABELS[program.broadcastMode],
            播完以后: program.broadcastMode === 'improvised' ? '不适用（即兴）' : program.finishMode === 'loop' ? '循环播放' : '播完停止',
            直播间动态提供给主播: program.allowLiveEvents,
            启用触发器: program.enabledTriggerIds.map((id) => ({ id, 名称: triggerLabel(id) })),
            声音配置:
              audio.mode === 'follow-presenter'
                ? '跟随当前主播'
                : {
                    模式: '自定义节目声音',
                    合成接入: audio.ttsConnectionId
                      ? (storage.ttsConnectionGet(audio.ttsConnectionId)?.name ?? `${audio.ttsConnectionId}（已不存在）`)
                      : '（未指定）',
                    合成模型: audio.ttsModelId ?? '（未指定）',
                    角色音色: (audio.cast ?? []).map((m) => `${m.roleName}→${voiceLabel(m.voiceId)}`)
                  },
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
            当前节目: program.id === activeProgramId(),
            版本号: program.updatedAt
          })
        })
    }),
    defineTool({
      name: 'list_scripts',
      label: '看剧本列表',
      description: '列出全部剧本：名称、主题、场景数、被哪些节目引用、版本号。拿剧本 id 或挑剧本绑给节目用它。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const scripts = script.listScripts()
          if (scripts.length === 0) return '还没有剧本：用 save_script 新建一个'
          return JSON.stringify(
            scripts.map((s) => ({
              id: s.id,
              名称: s.title,
              主题: s.theme || '（未设定）',
              场景数: s.scenes.length,
              被节目引用: programsUsingScript(s.id).map((p) => p.name),
              版本号: s.updatedAt
            }))
          )
        })
    }),
    defineTool({
      name: 'get_script',
      label: '看剧本详情',
      description: '看一本剧本的完整内容：场景序列（id/目标/要点/时长）和被哪些节目引用。改场景顺序（reorder_scenes）前先用它拿全部场景 id。',
      parameters: Type.Object({
        scriptId: Type.String({ description: '剧本 id（list_scripts 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const found = findScript(params.scriptId)
          if (!found) return `剧本 ${params.scriptId} 不存在（用 list_scripts 拿正确的 id）`
          return JSON.stringify({
            id: found.id,
            名称: found.title,
            主题: found.theme || '（未设定）',
            场景: found.scenes.map((s, i) => ({
              序号: i + 1,
              id: s.id,
              标题: s.title,
              目标: s.goal,
              要点: s.keyPoints,
              预计分钟: s.estDurationMin
            })),
            被节目引用: programsUsingScript(found.id).map((p) => ({ id: p.id, 名称: p.name })),
            版本号: found.updatedAt
          })
        })
    }),
    defineTool({
      name: 'list_personas',
      label: '看主播团',
      description: '列出全部主播卡：名字、语言模型、音色、角色数、是不是当前主播、版本号。换主播（set_active_persona）或改主播卡（save_persona）前用它拿 id。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const list = persona.list()
          const activeId = getActivePersonaId()
          return JSON.stringify(
            list.map((p) => {
              const conn = p.modelConnectionId ? storage.connectionGet(p.modelConnectionId) : null
              return {
                id: p.id,
                名称: p.name,
                语言模型: conn ? `${conn.name} · ${p.model || '（未选模型）'}` : '（未配置）',
                音色: voiceLabel(p.voiceId),
                角色数: p.roles.length,
                当前主播: p.id === activeId,
                版本号: p.updatedAt
              }
            })
          )
        })
    }),
    defineTool({
      name: 'get_persona',
      label: '看主播卡详情',
      description: '看一张主播卡的完整内容：人格/口癖/背景/禁区/语言模型/音色/角色表，附版本号。改主播卡（save_persona）之前先读它。',
      parameters: Type.Object({
        personaId: Type.String({ description: '主播卡 id（list_personas 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const found = persona.list().find((p) => p.id === params.personaId.trim())
          if (!found) return `主播卡 ${params.personaId} 不存在（用 list_personas 拿正确的 id）`
          const conn = found.modelConnectionId ? storage.connectionGet(found.modelConnectionId) : null
          return JSON.stringify({
            id: found.id,
            名称: found.name,
            性格: found.personality,
            口癖: found.catchphrases,
            背景: found.background,
            禁区: found.taboos,
            音色: voiceLabel(found.voiceId),
            语言模型接入: conn ? { id: conn.id, 名称: conn.name, 服务商: conn.providerId } : null,
            模型: found.model || '（未选）',
            角色: found.roles.map((r) => ({ 名称: r.name, 音色: voiceLabel(r.voiceId), 口吻: r.style })),
            当前主播: found.id === getActivePersonaId(),
            版本号: found.updatedAt
          })
        })
    }),
    defineTool({
      name: 'list_voices',
      label: '看音色库',
      description: '列出音色库全部音色：名称、服务商、模型、训练状态（训练中/可用/失败）、所属接入、版本号。换音色或删音色前用它拿 id。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const svc = getVoices()
          if (!svc) return '音色服务还没初始化'
          const list = svc.list()
          if (list.length === 0) return '音色库是空的：音色由导演在音色库页录制/克隆'
          return JSON.stringify(list.map((v) => voiceRow(v, storage)))
        })
    }),
    defineTool({
      name: 'get_voice',
      label: '看音色详情',
      description:
        '看一个音色的完整信息和引用关系：哪些主播卡/角色在用、哪些节目的声音安排在用、多少条底稿用它、未播队列里有没有它。删音色（delete_voice）前必须先查这个。',
      parameters: Type.Object({
        voiceId: Type.String({ description: '音色 id（list_voices 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const svc = getVoices()
          if (!svc) return '音色服务还没初始化'
          const voice = svc.list().find((v) => v.id === params.voiceId.trim())
          if (!voice) return `音色 ${params.voiceId} 不存在（用 list_voices 拿正确的 id）`
          const usage = svc.usage(voice.id)
          const queueRefs = voice.voiceType
            ? pool.snapshot().items.filter((i) => i.voiceId === voice.voiceType).length
            : 0
          return JSON.stringify({
            ...voiceRow(voice, storage),
            音色标识: voice.voiceType || '（训练未完成，还没有标识）',
            失败原因: voice.error || undefined,
            授权时间: voice.authorizedAt ? new Date(voice.authorizedAt).toLocaleString() : '（未记录）',
            引用: {
              主播卡: usage.personas.map((p) => (p.role ? `${p.name} 的角色「${p.role}」` : p.name)),
              节目声音安排: usage.programs.map((p) => p.name),
              底稿条目数: usage.utteranceCount,
              底稿示例: usage.utteranceSamples.map((s) => `「${s.programName}」${s.text.slice(0, 40)}`),
              未播队列条目数: queueRefs
            },
            版本号: voice.updatedAt
          })
        })
    }),
    defineTool({
      name: 'list_triggers',
      label: '看触发器库',
      description: '列出全局触发器库：名称、事件、模式（tool=模板直连/steer=插一句/task=派任务）、全局是否启用、被哪些节目勾选。给节目配事件规则（set_program_triggers）前用它拿 id。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const runtime = getTriggers()
          if (!runtime) return '触发器运行时还没初始化'
          const list = runtime.list()
          if (list.length === 0) return '触发器库是空的'
          return JSON.stringify(
            list.map((t) => ({
              id: t.id,
              名称: t.name,
              事件: t.on.event,
              模式: t.target.mode,
              全局启用: t.enabled,
              启用它的节目: programsUsingTrigger(t.id).map((p) => p.name)
            }))
          )
        })
    }),
    defineTool({
      name: 'get_trigger',
      label: '看触发器详情',
      description: '看一个触发器的完整定义：事件条件、聚合/冷却/单场预算、执行内容（模板或提示词），以及被哪些节目启用。',
      parameters: Type.Object({
        triggerId: Type.String({ description: '触发器 id（list_triggers 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const runtime = getTriggers()
          if (!runtime) return '触发器运行时还没初始化'
          const found = runtime.list().find((t) => t.id === params.triggerId.trim())
          if (!found) return `触发器 ${params.triggerId} 不存在（用 list_triggers 拿正确的 id）`
          return JSON.stringify({
            id: found.id,
            名称: found.name,
            全局启用: found.enabled,
            事件: found.on.event,
            条件过滤: found.on.filter ?? null,
            模式: found.target.mode,
            执行内容: found.target.mode === 'tool' ? found.target.toolAction ?? null : found.target.promptTemplate ?? null,
            节流: found.throttle ?? null,
            启用它的节目: programsUsingTrigger(found.id).map((p) => ({ id: p.id, 名称: p.name }))
          })
        })
    }),
    defineTool({
      name: 'get_system_status',
      label: '看系统状态',
      description:
        '系统健康总览：当前节目/主播/播出状态、语言模型接入、语音合成接入、评论连接器、RTMP 推流、音频输出，附可操作的修复建议。' +
        '排查「为什么没动静/说不出话/收不到评论」先调它。密钥只报「已配置/未配置」，谁都读不到明文。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const status = getStatus()
          const cfg = storage.getConfig()
          const active = activeProgramId() ? findProgram(activeProgramId()) : undefined
          const current = persona.get()
          const llmConnections = storage.connectionListSafe().map((c) => ({
            id: c.id,
            名称: c.name,
            服务商: c.providerId,
            密钥: c.hasSecret ? '已配置' : '未配置',
            可用: c.ready,
            模型数: c.models.length
          }))
          const ttsConnections = storage.ttsConnectionListSafe().map((c) => ({
            id: c.id,
            名称: c.name,
            服务商: TTS_PROVIDER_SHORT[c.providerId] ?? c.providerId,
            密钥: c.hasSecret ? '已配置' : '未配置',
            可用: c.ready,
            可用模型: c.usableModels
          }))
          const connector = getConnector()?.status() ?? null
          const stream = getStream()?.getStats() ?? null
          const poolStatus = pool.getStatus()

          const suggestions: string[] = []
          if (!active) suggestions.push('还没有选中节目：用 list_programs 挑一个，set_active_program 选中')
          if (!llmConnections.some((c) => c.可用)) {
            suggestions.push('没有可用的语言模型接入：让导演到设置 → 语言模型添加接入并填密钥')
          }
          if (!current.modelConnectionId || !current.model) {
            suggestions.push(`当前主播「${current.name}」还没选模型：用 save_persona 给它选接入和模型（接入 id 见上面的语言模型接入列表）`)
          }
          if (!current.voiceId) {
            suggestions.push(`当前主播「${current.name}」还没选音色：用 list_voices 挑一个，save_persona 配上`)
          }
          if (!ttsConnections.some((c) => c.可用)) {
            suggestions.push('没有可用的语音合成接入：让导演到设置 → 语音合成补齐凭据')
          }
          if (cfg.tts.lastTestAt === 0) suggestions.push('还没测过发音：让导演在设置 → 语音合成点一次「测试发音」')
          if (connector && connector.state !== 'connected') {
            suggestions.push(`评论连接器未连接${connector.error ? `（${connector.error}）` : ''}：确认连接器在运行、设置里的端口和 Token 正确`)
          }
          if (cfg.stream.mode === 'direct' && (!cfg.stream.serverUrl || !cfg.stream.streamKey)) {
            suggestions.push('直推模式还没配推流地址/密钥：让导演到设置 → 接入 → 推流补齐')
          }
          if (status.assetsStale) suggestions.push('主播卡/节目配置在会话启动后改过：改动要重开会话才生效（导演重启会话或下次开播）')

          return JSON.stringify({
            节目: {
              当前节目: active ? active.name : null,
              播出中: status.live === true,
              主播会话: status.state === 'stopped' ? '未启动' : `${status.state}（${status.purpose === 'prep' ? '写稿备播' : '直播'}）`,
              未播队列: poolStatus.active,
              正在播: poolStatus.playing?.text ?? null
            },
            当前主播: { 名称: current.name, 模型: current.model || '（未选）', 音色: voiceLabel(current.voiceId) },
            语言模型接入: llmConnections,
            语音合成接入: ttsConnections,
            评论连接器: connector
              ? { 状态: connector.state, 端口: connector.port, 已收事件: connector.receivedCount, 错误: connector.error }
              : '未初始化',
            RTMP推流: stream
              ? {
                  模式: cfg.stream.mode === 'direct' ? '直推' : '伴侣采集',
                  状态: stream.state,
                  推流地址: cfg.stream.serverUrl ? '已配置' : '未配置',
                  推流密钥: cfg.stream.streamKey ? '已配置' : '未配置',
                  连接口令: cfg.comment.connectorToken ? '已配置' : '未配置',
                  码率kbps: stream.bitrateKbps,
                  错误: stream.error
                }
              : '未初始化',
            音频输出: '本机出声走系统默认输出设备（主进程音频管线，不枚举声卡）；直播伴侣采集系统声音',
            修复建议: suggestions.length > 0 ? suggestions : ['一切就绪']
          })
        })
    }),

    // ==================== 可逆写入 ====================
    defineTool({
      name: 'save_program',
      label: '存节目',
      description:
        '新建或修改节目配置（名称/主题/内容类型/播出方式/播完策略/事件开关/剧本绑定/知识范围/声音安排）。' +
        '带 id 是修改（没传的字段保持原样），不带 id 是新建（name 必填）。' +
        '修改时建议带 expectedUpdatedAt（get_program 里的版本号）：期间有人改过了会拒绝并告诉你新版本号，重新读取后再改，不会悄悄覆盖别人的修改。' +
        '改的是当前节目且会话在跑时，配置下次重开会话/开播才生效（返回值会明说）。',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: '节目 id：修改时必传（list_programs 拿），不传 = 新建' })),
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
        enabledTriggerIds: Type.Optional(Type.Array(Type.String(), { description: '启用的事件触发器 id（全量替换，list_triggers 拿）' })),
        scriptId: Type.Optional(Type.String({ description: '绑定的剧本 id（list_scripts 拿）；传空字符串 = 解绑' })),
        knowledgeScope: Type.Optional(
          Type.Object({
            products: Type.Optional(Type.Union([Type.Literal('*'), Type.Array(Type.String())], { description: '知识条目范围：* = 全部，否则 id 白名单' })),
            files: Type.Optional(Type.Union([Type.Literal('*'), Type.Array(Type.String())], { description: '知识文件范围' }))
          })
        ),
        audioConfig: Type.Optional(
          Type.Object({
            mode: Type.Optional(Type.String({ description: 'follow-presenter=跟随当前主播 / custom=自定义节目声音' })),
            ttsConnectionId: Type.Optional(Type.String({ description: '合成接入 id（custom 模式；get_system_status 的语音合成接入列表拿）' })),
            ttsModelId: Type.Optional(Type.String({ description: '合成模型 id' })),
            cast: Type.Optional(
              Type.Array(
                Type.Object({
                  roleId: Type.String(),
                  roleName: Type.String({ description: '角色名（旁白/主持人A…）' }),
                  voiceId: Type.String({ description: '音色标识（list_voices/get_voice 拿）' })
                }),
                { description: '角色音色安排（custom 模式）' }
              )
            )
          })
        ),
        expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）：不一致就拒绝，不会覆盖别人的修改' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const existing = params.id ? findProgram(params.id) : undefined
          if (params.id && !existing) return `节目 ${params.id} 不存在（用 list_programs 拿正确的 id）`
          if (!existing && !params.name?.trim()) return '新建节目必须给名称（name）'
          if (!existing) {
            const dup = script.listPrograms().find((p) => p.name === params.name!.trim())
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
          const am = pickEnum(params.audioConfig?.mode, ['follow-presenter', 'custom'] as const, '声音模式')
          if (am.error) return am.error

          const scriptId = params.scriptId === undefined ? (existing?.scriptId ?? null) : params.scriptId.trim() || null
          if (scriptId && !findScript(scriptId)) return `剧本 ${scriptId} 不存在（用 list_scripts 拿正确的 id）`
          if (params.audioConfig?.ttsConnectionId?.trim() && !storage.ttsConnectionGet(params.audioConfig.ttsConnectionId.trim())) {
            return `语音合成接入 ${params.audioConfig.ttsConnectionId} 不存在（用 get_system_status 看现有接入）`
          }

          const saved = script.saveProgram(
            {
              name: params.name?.trim() ?? existing?.name ?? '',
              theme: params.theme ?? existing?.theme ?? '',
              contentType: ct.value ?? existing?.contentType ?? 'solo',
              broadcastMode: bm.value ?? existing?.broadcastMode ?? 'rolling',
              finishMode: fm.value ?? existing?.finishMode ?? 'loop',
              allowLiveEvents: params.allowLiveEvents ?? existing?.allowLiveEvents ?? true,
              enabledTriggerIds: params.enabledTriggerIds ?? existing?.enabledTriggerIds ?? [],
              audioConfig: params.audioConfig
                ? {
                    mode: am.value ?? existing?.audioConfig.mode ?? 'follow-presenter',
                    ttsConnectionId: params.audioConfig.ttsConnectionId?.trim() ?? existing?.audioConfig.ttsConnectionId,
                    ttsModelId: params.audioConfig.ttsModelId?.trim() ?? existing?.audioConfig.ttsModelId,
                    cast: params.audioConfig.cast ?? existing?.audioConfig.cast
                  }
                : (existing?.audioConfig ?? { mode: 'follow-presenter' }),
              scriptId,
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
          const runningNote =
            saved.id === activeProgramId() && getStatus().state !== 'stopped'
              ? '。注意：这是当前节目且主播会话在跑——配置改动要重开会话/重新开播才生效，正在进行的会话不受影响'
              : ''
          return `${existing ? '已更新' : '已新建'}节目「${saved.name}」（id=${saved.id}，版本号 ${saved.updatedAt}）${runningNote}`
        })
    }),
    defineTool({
      name: 'save_script',
      label: '存剧本',
      description:
        '新建剧本或给剧本改名/改主题（场景内容不动）。带 id 是改名/改主题，不带 id 是新建（title 必填，场景允许后补——绑给节目后用 create_scene 逐场编排）。' +
        '修改时建议带 expectedUpdatedAt（get_script 里的版本号）做并发保护。',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: '剧本 id：修改时必传（list_scripts 拿），不传 = 新建' })),
        title: Type.String({ description: '剧本名称' }),
        theme: Type.Optional(Type.String({ description: '主题/方向（不传保持原样）' })),
        expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          if (!params.id) {
            const dup = script.listScripts().find((s) => s.title === params.title.trim())
            if (dup) return `已存在同名剧本「${dup.title}」（id=${dup.id}）：要改它带 id 调用，别重复建`
          }
          const saved = script.saveScriptMeta({ title: params.title, theme: params.theme }, params.id?.trim() || undefined, params.expectedUpdatedAt)
          return `${params.id ? '已更新' : '已新建'}剧本「${saved.title}」（id=${saved.id}，${saved.scenes.length} 个场景，版本号 ${saved.updatedAt}）`
        })
    }),
    defineTool({
      name: 'reorder_scenes',
      label: '调场景顺序',
      description:
        '调整剧本场景顺序：sceneIds 必须恰好包含全部场景 id 的一个排列（先用 get_script 拿当前场景列表）。只调顺序，场景内容不动。',
      parameters: Type.Object({
        scriptId: Type.String({ description: '剧本 id' }),
        sceneIds: Type.Array(Type.String(), { description: '全部场景 id 按新顺序排列' }),
        expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const saved = script.reorderScenes(params.scriptId, params.sceneIds, params.expectedUpdatedAt)
          return `已调整「${saved.title}」的场景顺序：\n${saved.scenes.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`
        })
    }),
    defineTool({
      name: 'save_persona',
      label: '存主播卡',
      description:
        '新建或修改主播卡（名字/人格/口癖/背景/禁区/语言模型/音色/角色表）。带 id 是修改（没传的字段保持原样），不带 id 是新建（name 必填，新卡会自动成为当前主播）。' +
        '改的是当前主播且会话在跑时：改模型/接入要重开会话才生效；改音色只影响之后新说出的内容；改人格文本当前会话不自动刷新——返回值会明说属于哪种。' +
        '修改时建议带 expectedUpdatedAt（get_persona 里的版本号）做并发保护。',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: '主播卡 id：修改时必传（list_personas 拿），不传 = 新建' })),
        name: Type.Optional(Type.String({ description: '主播名字（新建必填）' })),
        personality: Type.Optional(Type.String({ description: '性格' })),
        catchphrases: Type.Optional(Type.String({ description: '口癖/口头禅' })),
        background: Type.Optional(Type.String({ description: '背景故事' })),
        taboos: Type.Optional(Type.String({ description: '禁区（绝不能说的话题/承诺）' })),
        voiceId: Type.Optional(Type.String({ description: '音色标识（list_voices 拿）；传空字符串 = 清空' })),
        modelConnectionId: Type.Optional(Type.String({ description: '语言模型接入 id（get_system_status 拿）；传空字符串 = 清空' })),
        model: Type.Optional(Type.String({ description: '模型 id，必须在接入的模型列表里' })),
        roles: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ description: '角色名' }),
              voiceId: Type.String({ description: '角色音色标识' }),
              style: Type.String({ description: '口吻提示' })
            }),
            { description: '编剧模式角色表（全量替换）' }
          )
        ),
        expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的版本号（并发保护）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const existing = params.id ? persona.list().find((p) => p.id === params.id!.trim()) : undefined
          if (params.id && !existing) return `主播卡 ${params.id} 不存在（用 list_personas 拿正确的 id）`
          if (!existing && !params.name?.trim()) return '新建主播卡必须给名字（name）'
          if (!existing) {
            const dup = persona.list().find((p) => p.name === params.name!.trim())
            if (dup) return `已存在同名主播「${dup.name}」（id=${dup.id}）：要改它带 id 调用，别重复建`
          }
          const modelConnectionId =
            params.modelConnectionId === undefined ? (existing?.modelConnectionId ?? null) : params.modelConnectionId.trim() || null
          const model = params.model === undefined ? (existing?.model ?? '') : params.model.trim()
          const connection = modelConnectionId ? storage.connectionGet(modelConnectionId) : null
          if (modelConnectionId && !connection) return `语言模型接入 ${modelConnectionId} 不存在（用 get_system_status 看现有接入）`
          if (model && connection && !connection.models.includes(model)) {
            return `模型 ${model} 不在接入「${connection.name}」的模型列表里（现有：${connection.models.join('、')}）`
          }
          const saved = persona.save(
            {
              name: params.name?.trim() ?? existing?.name ?? '',
              personality: params.personality ?? existing?.personality ?? '',
              catchphrases: params.catchphrases ?? existing?.catchphrases ?? '',
              background: params.background ?? existing?.background ?? '',
              taboos: params.taboos ?? existing?.taboos ?? '',
              voiceId: params.voiceId === undefined ? (existing?.voiceId ?? '') : params.voiceId.trim(),
              modelConnectionId,
              model,
              roles: (params.roles ?? existing?.roles ?? [])
                .map((r) => ({ name: r.name.trim(), voiceId: r.voiceId.trim(), style: r.style.trim() }))
                .filter((r) => r.name)
            },
            existing?.id,
            params.expectedUpdatedAt
          )
          if (!existing) {
            return `已新建主播「${saved.name}」（id=${saved.id}）并设为当前主播（新卡默认上场）；要换回原来的用 set_active_persona`
          }
          // 运行态保护提示（docs/10 §10.3.9/§10.4）：改的是当前主播且会话在跑时，明说生效方式
          if (existing.id !== getActivePersonaId() || getStatus().state === 'stopped') {
            return `已更新主播卡「${saved.name}」（版本号 ${saved.updatedAt}）——不是当前在场主播，不影响正在跑的会话`
          }
          const effects: string[] = []
          if (existing.modelConnectionId !== saved.modelConnectionId || existing.model !== saved.model) {
            effects.push('模型/接入变了：需要重开会话才生效（导演重启会话，或下次开播自动生效）')
          }
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
          return (
            `已更新当前主播「${saved.name}」（版本号 ${saved.updatedAt}）` +
            (effects.length > 0 ? `。${effects.join('；')}` : '。改动对当前会话立即生效')
          )
        })
    }),
    defineTool({
      name: 'rename_voice',
      label: '音色改名',
      description: '给音色库里的音色改显示名（只改名字，平台侧的复刻音色标识不动，不影响引用）。',
      parameters: Type.Object({
        voiceId: Type.String({ description: '音色 id（list_voices 拿）' }),
        name: Type.String({ description: '新名字' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const svc = getVoices()
          if (!svc) return '音色服务还没初始化'
          const result = svc.rename(params.voiceId, params.name)
          return result.ok ? `已改名为「${params.name.trim()}」` : `改名失败：${result.error}`
        })
    }),
    defineTool({
      name: 'set_program_triggers',
      label: '配节目事件规则',
      description:
        '设置一个节目启用哪些触发器（全量替换 enabledTriggerIds；触发器定义在全局库，节目只存勾选）。id 必须来自 list_triggers，不存在的会被拒绝。',
      parameters: Type.Object({
        programId: Type.String({ description: '节目 id' }),
        triggerIds: Type.Array(Type.String(), { description: '启用的触发器 id 列表（空数组 = 全关）' }),
        expectedUpdatedAt: Type.Optional(Type.Number({ description: '你读到的节目版本号（并发保护）' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const saved = script.setProgramTriggers(params.programId, params.triggerIds, params.expectedUpdatedAt)
          const names = saved.enabledTriggerIds.map((id) => triggerLabel(id))
          const runningNote =
            saved.id === activeProgramId() && getStatus().state !== 'stopped'
              ? '。注意：这是当前节目且会话在跑——事件规则要重开会话/重新开播才生效'
              : ''
          return `节目「${saved.name}」已启用 ${names.length} 项事件规则${names.length > 0 ? `：${names.join('、')}` : ''}${runningNote}`
        })
    }),
    defineTool({
      name: 'set_active_program',
      label: '选中节目',
      description:
        '把某个节目设为当前节目（主播的上下文、底稿工具都跟着它走；选中后主播就位于该节目，接着它原来的对话记录）。正在播出的节目不受影响——播出中想换节目要先结束再开播。',
      parameters: Type.Object({
        programId: Type.String({ description: '节目 id（list_programs 拿）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const program = findProgram(params.programId)
          if (!program) return `节目 ${params.programId} 不存在（用 list_programs 拿正确的 id）`
          if (program.id === activeProgramId()) return `「${program.name}」已经是当前节目`
          script.setActiveProgram(program.id)
          warmupProgram?.(program.id)
          const liveNote = getStatus().live ? '（当前正在播出的节目不受影响：这场结束后开播才用新选择）' : '（主播已就位于这个节目）'
          return `已选中节目「${program.name}」${liveNote}`
        })
    }),
    defineTool({
      name: 'set_active_persona',
      label: '换当前主播',
      description:
        '切换当前主播（原子换人：会话上下文和节目历史保留，未播的旧音色话术用新主播嗓音重合成，已播/预制音频不动）。直播中和写稿中都能切。',
      parameters: Type.Object({
        personaId: Type.String({ description: '主播卡 id（list_personas 拿）' })
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const target = persona.list().find((p) => p.id === params.personaId.trim())
          if (!target) return `主播卡 ${params.personaId} 不存在（用 list_personas 拿正确的 id）`
          if (target.id === getActivePersonaId()) return `「${target.name}」就是当前主播，不用换`
          const result = await handoffPersona(target.id)
          if (!result.ok) return `换主播失败：${result.error}`
          return `已把当前主播换成「${target.name}」：这场的历史她都接得住，接下来用她的大脑和嗓音继续`
        })
    }),

    // ==================== 破坏性/外部副作用（先确认） ====================
    defineTool({
      name: 'produce_program_audio',
      label: '生成节目音频',
      description:
        '生成节目音频（docs/10 §7.5 统一生产入口）。预制节目：按合成计划全量生产（逐章/逐段），' +
        '会真实调用语音合成服务产生费用——必须先向导演发确认卡（卡里写清范围、预计时长、将用的模型和音色快照），' +
        '导演确认后带 confirmed=true 重调才执行。滚动节目是「提前合成全部」（边播边合成的节目本来就要蒸，不加确认），可直接调用。' +
        '已开始合成后把节目 audioConfig 冻结成声音快照写进产物，之后换主播不改写已有音频。',
      parameters: Type.Object({
        programId: Type.Optional(Type.String({ description: '节目 id，不传 = 当前节目' })),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；预制节目不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const programId = params.programId?.trim() || activeProgramId()
          if (!programId) return '没有指定节目，也没有当前节目'
          const program = findProgram(programId)
          if (!program) return `节目 ${programId} 不存在（用 list_programs 拿正确的 id）`
          if (!produceProgramAudio || !describeProducePlan) return '音频生产入口没接上，让导演在界面操作'
          // 滚动/即兴：提前合成全部不是门禁、也没有额外决策，直接跑（§7.5）
          if (program.broadcastMode !== 'prepared') {
            const result = await produceProgramAudio(program.id)
            return result.ok
              ? `已开始为「${program.name}」提前合成全部文稿（后台逐段跑，不是播放门禁；进度见底稿状态）`
              : `发起失败：${result.error}`
          }
          // 预制：全量合成有外部费用，先确认（确认卡显示范围/预计时长/模型与音色快照）
          const plan = describeProducePlan(program.id)
          if (!plan.ok) return `没法生成：${plan.error}`
          if (!params.confirmed) {
            return askConfirm(
              `生成节目音频「${program.name}」（预制播出）：\n` +
                `- 范围：${plan.scenes && plan.scenes > 0 ? `${plan.scenes} 章 / ` : ''}${plan.units} 个合成单元（共 ${plan.segments} 段、约 ${plan.totalChars} 字）\n` +
                `- 预计时长：约 ${plan.estMinutes} 分钟（按字数粗估，不是承诺）\n` +
                `- 合成模型：${plan.modelDesc}\n` +
                `- 声音快照：${plan.voiceDesc}\n` +
                `${plan.notice ? `- 说明：${plan.notice}\n` : ''}` +
                `注意：会真实调用语音合成服务产生费用；已就绪且文稿没改过的单元会跳过不重蒸`
            )
          }
          const result = await produceProgramAudio(program.id)
          if (!result.ok && result.error) return `合成没跑起来：${result.error}`
          return (
            `节目音频生产完成：成功 ${result.done} / 跳过已就绪 ${result.skipped} / 失败 ${result.failed}（共 ${result.total} 个单元）` +
            `${result.notice ? `\n说明：${result.notice}` : ''}` +
            `${result.failed > 0 ? '\n有失败单元：用 get_program 看音频进度，失败原因在节目文稿页逐章标注，修好后再调一次本工具即可续跑' : ''}`
          )
        })
    }),
    defineTool({
      name: 'delete_program',
      label: '删节目',
      description:
        '删除一个节目：底稿、已合成音频、该节目的对话记录一起删除，不可恢复（剧本/音色/知识等全局资产不动）。' +
        '正在播出的节目删不了（先结束节目）。第一次调用不传 confirmed：向导演发确认卡；导演确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        programId: Type.String({ description: '节目 id（list_programs 拿）' }),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const program = findProgram(params.programId)
          if (!program) return `节目 ${params.programId} 不存在（用 list_programs 拿正确的 id）`
          const status = getStatus()
          if (status.live && activeProgramId() === program.id) {
            return '删不了：这个节目正在播出。先结束节目（导演在播控台点结束），再删除'
          }
          const session = getSessionInfo()
          if (session?.purpose === 'live' && session.programId === program.id) {
            return '删不了：这个节目的直播会话还在跑。先结束节目再删除'
          }
          const stats = draftStats(program.id)
          const isActive = activeProgramId() === program.id
          if (!params.confirmed) {
            return askConfirm(
              `删除节目「${program.name}」：\n` +
                `- 底稿 ${stats.total} 段（含已合成音频 ${stats.ready} 段）一并删除\n` +
                `- 该节目的对话记录一并删除\n` +
                `- ${isActive ? '它是当前节目，删除后当前节目选择清空\n- ' : ''}` +
                `绑定的剧本/音色/知识等全局资产不动\n` +
                `不可恢复`
            )
          }
          script.deleteProgram(program.id)
          return `已删除节目「${program.name}」：${stats.total} 段底稿与音频、对话记录一并清除${isActive ? '，当前节目选择已清空' : ''}`
        })
    }),
    defineTool({
      name: 'delete_script',
      label: '删剧本',
      description:
        '删除一本剧本（场景定义一起删，不可恢复；底稿条目不动）。被节目引用的剧本删不了——先把引用它的节目解绑。' +
        '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        scriptId: Type.String({ description: '剧本 id（list_scripts 拿）' }),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const found = findScript(params.scriptId)
          if (!found) return `剧本 ${params.scriptId} 不存在（用 list_scripts 拿正确的 id）`
          const referencing = programsUsingScript(found.id)
          if (referencing.length > 0) {
            return (
              `删不了：剧本「${found.title}」正被 ${referencing.map((p) => `「${p.name}」`).join('、')} 引用。\n` +
              `先用 save_program 把这些节目的 scriptId 传空字符串解绑，再删除`
            )
          }
          if (!params.confirmed) {
            return askConfirm(
              `删除剧本「${found.title}」：${found.scenes.length} 个场景一并删除。\n` +
                `当前没有任何节目引用它；各节目的底稿条目不受影响。\n不可恢复`
            )
          }
          script.deleteScript(found.id)
          return `已删除剧本「${found.title}」（${found.scenes.length} 个场景）`
        })
    }),
    defineTool({
      name: 'delete_persona',
      label: '删主播卡',
      description:
        '删除一张主播卡（不可恢复；它已生成的音频保留）。当前主播正在会话中时删不了——先用 set_active_persona 换别人上场。' +
        '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        personaId: Type.String({ description: '主播卡 id（list_personas 拿）' }),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const target = persona.list().find((p) => p.id === params.personaId.trim())
          if (!target) return `主播卡 ${params.personaId} 不存在（用 list_personas 拿正确的 id）`
          const isActive = target.id === getActivePersonaId()
          if (isActive && getStatus().state !== 'stopped') {
            return `删不了：「${target.name}」是当前主播且会话正在跑。先用 set_active_persona 换别人上场，再删这张卡`
          }
          if (!params.confirmed) {
            const rest = persona.list().filter((p) => p.id !== target.id)
            return askConfirm(
              `删除主播卡「${target.name}」：\n` +
                `- 人格/模型/音色配置一并删除\n` +
                `- ${isActive ? `它是当前主播，删除后自动切到「${rest[0]?.name ?? '无（会自动建默认卡）'}」\n- ` : ''}` +
                `它已合成的节目音频保留，音色与知识不受影响\n不可恢复`
            )
          }
          persona.remove(target.id)
          const nowActive = persona.get()
          return `已删除主播卡「${target.name}」${isActive ? `，当前主播已切到「${nowActive.name}」` : ''}`
        })
    }),
    defineTool({
      name: 'delete_voice',
      label: '删音色',
      description:
        '从音色库删除一个音色（登记删除，不可恢复；已生成的音频文件保留，后续合成需重选音色）。' +
        '被主播卡/角色/节目声音安排/未播队列引用的音色删不了——返回值会列出谁在引用、先怎么解。' +
        '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        voiceId: Type.String({ description: '音色 id（list_voices 拿）' }),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const svc = getVoices()
          if (!svc) return '音色服务还没初始化'
          const voice = svc.list().find((v) => v.id === params.voiceId.trim())
          if (!voice) return `音色 ${params.voiceId} 不存在（用 list_voices 拿正确的 id）`
          const usage = svc.usage(voice.id)
          const queueRefs = voice.voiceType
            ? pool.snapshot().items.filter((i) => i.voiceId === voice.voiceType).length
            : 0
          const blockers: string[] = []
          if (usage.personas.length > 0) {
            blockers.push(`主播卡：${usage.personas.map((p) => (p.role ? `${p.name} 的角色「${p.role}」` : p.name)).join('、')}`)
          }
          if (usage.programs.length > 0) blockers.push(`节目声音安排：${usage.programs.map((p) => p.name).join('、')}`)
          if (queueRefs > 0) blockers.push(`未播队列：${queueRefs} 条`)
          if (blockers.length > 0) {
            return (
              `删不了：音色「${voice.name}」还在被引用——\n${blockers.map((b) => `- ${b}`).join('\n')}\n` +
              `先解掉引用（save_persona 换音色 / save_program 改声音安排 / revise_item 修订队列条目），再删除`
            )
          }
          if (!params.confirmed) {
            return askConfirm(
              `删除音色「${voice.name}」（${TTS_PROVIDER_SHORT[voice.provider] ?? voice.provider} / ${voice.model}，${voiceStatusLabel(voice)}）：\n` +
                `- 没有被主播/节目/队列引用；${usage.utteranceCount > 0 ? `底稿库里有 ${usage.utteranceCount} 条旧底稿用过它（不受影响，重播时按当前音色合成）` : '底稿库也没有引用'}\n` +
                `- 已生成的音频文件保留\n不可恢复的是音色登记本身`
            )
          }
          const result = await svc.remove(voice.id)
          return result.ok ? `已删除音色「${voice.name}」（已生成的音频文件保留）` : `删除失败：${result.error}`
        })
    }),
    defineTool({
      name: 'clear_program_content',
      label: '清空节目内容',
      description:
        '清空一个节目的全部底稿和已合成音频（不可恢复；节目配置/剧本绑定保留）。整节目推倒重写时用；正在播出的节目清不了。' +
        '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        programId: Type.Optional(Type.String({ description: '节目 id，不传 = 当前节目' })),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const programId = params.programId?.trim() || activeProgramId()
          if (!programId) return '没有指定节目，也没有当前节目'
          const program = findProgram(programId)
          if (!program) return `节目 ${programId} 不存在（用 list_programs 拿正确的 id）`
          if (getStatus().live && activeProgramId() === program.id) {
            return '清不了：这个节目正在播出，播着的内容不能清。先结束节目再清'
          }
          const stats = draftStats(program.id)
          if (stats.total === 0) return `「${program.name}」本来就是空的`
          if (!params.confirmed) {
            return askConfirm(
              `清空节目「${program.name}」的全部内容：\n` +
                `- ${stats.total} 段底稿删除（含 ${stats.ready} 段已合成音频，音频文件一并清理）\n` +
                `- 节目配置与剧本绑定保留\n不可恢复`
            )
          }
          utterances.clear(program.id)
          return `已清空「${program.name}」的 ${stats.total} 段底稿（含 ${stats.ready} 段音频）。段数归零，可以重新写稿了`
        })
    }),
    defineTool({
      name: 'start_voice_clone',
      label: '发起声音克隆',
      description:
        '发起音色克隆训练（对外副作用：消耗服务商克隆额度，克隆音色首次合成即可能计费）。' +
        '合规底线：authorized 必须为 true（导演确认已获得录音人授权），否则拒绝。' +
        '第一次调用不传 confirmed：向导演发确认卡（写清接入/模型/样本/计费提示）；确认后带 confirmed=true 重调才真正提交。',
      parameters: Type.Object({
        name: Type.String({ description: '新音色名称' }),
        connectionId: Type.String({ description: '用哪条语音合成接入的凭据克隆（get_system_status 的语音合成接入列表拿）' }),
        model: Type.String({ description: '克隆目标模型 id（该接入下支持复刻的模型，如火山 seed-icl 系）' }),
        samplePath: Type.Optional(Type.String({ description: '本地样本音频路径（火山必填；导演提供）' })),
        sampleUrl: Type.Optional(Type.String({ description: '公网可访问的样本地址（百炼必填）' })),
        authorized: Type.Boolean({ description: '导演已确认获得录音人授权 = true，否则拒绝' }),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const svc = getVoices()
          if (!svc) return '音色服务还没初始化'
          if (!params.authorized) {
            return '拒绝：克隆必须先确认「已获得录音人授权」（authorized=true）。没有授权不能发起克隆'
          }
          if (!params.samplePath?.trim() && !params.sampleUrl?.trim()) {
            return '需要样本：本地样本路径 samplePath（火山）或公网地址 sampleUrl（百炼）——让导演在音色库页录制/上传后给你路径'
          }
          const connection = storage.ttsConnectionGet(params.connectionId.trim())
          if (!connection) return `语音合成接入 ${params.connectionId} 不存在（用 get_system_status 看现有接入）`
          if (!params.confirmed) {
            return askConfirm(
              `发起声音克隆：\n` +
                `- 音色名「${params.name.trim()}」，接入「${connection.name}」，模型 ${params.model}\n` +
                `- 样本：${params.samplePath?.trim() || params.sampleUrl?.trim()}\n` +
                `- 已确认获得录音人授权\n` +
                `注意：会消耗服务商克隆额度，克隆音色首次合成即可能计费（后付费模式）`
            )
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
          return `已发起克隆训练：「${result.voice.name}」（id=${result.voice.id}），状态训练中——用 get_voice 查进度，ready 就能用`
        })
    }),
    defineTool({
      name: 'start_rtmp',
      label: '启动 RTMP 推流',
      description:
        '启动 RTMP 直推（对外副作用：开始向已配置的推流地址推送音频流，观众侧可见）。伴侣模式下不需要也调不了（声音由直播伴侣采集）。' +
        '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。推流地址/密钥只能由导演在设置里填。',
      parameters: Type.Object({
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const stream = getStream()
          if (!stream) return '推流服务还没初始化'
          const stats = stream.getStats()
          if (stats.streaming) return '推流已经在进行中，不用重复启动'
          const cfg = storage.getConfig().stream
          if (cfg.mode === 'companion') {
            return '当前是伴侣模式：不需要启动推流进程，声音由直播伴侣采集系统声音。要直推 RTMP 得让导演在设置 → 接入 → 推流改成直推模式并填地址/密钥'
          }
          if (!cfg.serverUrl || !cfg.streamKey) {
            return '直推模式还没配推流地址或密钥：让导演到设置 → 接入 → 推流补齐（密钥我只看得到配没配，读不到也改不了内容）'
          }
          if (!params.confirmed) {
            return askConfirm('启动 RTMP 直推：开始向已配置的推流地址推送音频流。\n对外副作用：观众侧可见。可随时在播控台停止。')
          }
          const result = await stream.start()
          return result.ok ? 'RTMP 推流已启动（直播中）' : `推流启动失败：${result.error}`
        })
    }),
    defineTool({
      name: 'export_program',
      label: '导出节目音频',
      description:
        '导出预制节目已生成的音频到本机目录（docs/10 §8.3）：数据源是节目单元的预制音频资产，不重新调 TTS，导出和播放用同一批音频。' +
        '第一版范围 = 全部章节；方式 = 分章文件（separate）或合并为一个文件（merged）；格式 MP3/WAV；可选响度归一（loudnorm）。' +
        '部分章节缺音频时默认阻断并列出缺哪些，明确带 onlyReady=true 才只导出已完成部分（不静默跳过）。' +
        '对外副作用（往磁盘写文件），第一次调用不传 confirmed：向导演发确认卡（范围/方式/格式/输出目录/预计文件数）；确认后带 confirmed=true 重调才执行。',
      parameters: Type.Object({
        programId: Type.Optional(Type.String({ description: '节目 id，不传 = 当前节目' })),
        mode: Type.Optional(Type.String({ description: 'separate=分章文件 / merged=合并为一个文件；默认 separate' })),
        format: Type.Optional(Type.String({ description: 'mp3 / wav；默认 mp3' })),
        loudness: Type.Optional(Type.Boolean({ description: '响度归一（ffmpeg loudnorm 一遍法）' })),
        onlyReady: Type.Optional(Type.Boolean({ description: '部分章节缺音频时，只导出已完成部分（默认阻断）' })),
        outputDir: Type.Optional(Type.String({ description: '输出目录绝对路径；不传 = 应用数据目录下 exports/节目名-时间戳' })),
        confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const exporter = getExporter?.()
          if (!exporter) return '导出服务还没接上，让导演在界面用导出弹窗（播控台顶栏/节目卡）'
          const programId = params.programId?.trim() || activeProgramId()
          if (!programId) return '没有指定节目，也没有当前节目'
          const program = findProgram(programId)
          if (!program) return `节目 ${programId} 不存在（用 list_programs 拿正确的 id）`
          const plan = exporter.describeExportPlan(program.id)
          if (!plan.ok) return `导不了：${plan.error}`
          const missing = plan.missing ?? []
          if (missing.length > 0 && !params.onlyReady) {
            return (
              `导不了：还有 ${missing.length} 个单元缺音频——\n` +
              missing.map((item) => `- ${item.title}（${item.reason}）`).join('\n') +
              '\n先用 produce_program_audio 补齐合成，或明确带 onlyReady=true 只导出已完成部分'
            )
          }
          const mode = params.mode === 'merged' ? ('merged' as const) : ('separate' as const)
          const format = params.format === 'wav' ? ('wav' as const) : ('mp3' as const)
          const readyCount = plan.ready ?? 0
          const fileCount = mode === 'merged' ? 1 : readyCount
          if (!params.confirmed) {
            return askConfirm(
              `导出节目音频「${program.name}」：\n` +
                `- 范围：全部 ${plan.total} 章${missing.length > 0 ? `（缺 ${missing.length} 章，仅导出已完成 ${readyCount} 章）` : ''}\n` +
                `- 方式：${mode === 'merged' ? '合并为一个文件' : '分章文件'} · 格式 ${format.toUpperCase()}${params.loudness ? ' · 响度归一' : ''}\n` +
                `- 输出目录：${params.outputDir?.trim() || '默认 exports 目录（应用数据目录下，执行后返回实际路径）'}\n` +
                `- 预计文件数：${fileCount} 个\n` +
                `注意：往本机磁盘写文件；不改动节目与音频资产，删掉产出文件即可恢复`
            )
          }
          const result = await exporter.export({
            programId: program.id,
            mode,
            format,
            outputDir: params.outputDir?.trim() ?? '',
            loudness: params.loudness === true,
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
        })
    }),
    defineTool({
      name: 'emergency_stop',
      label: '紧急停止',
      description:
        '紧急停止：安全优先，直接执行不用确认——掐断所有声音、暂停播报、停止我的会话，并立即通知导演。' +
        '说错话/内容违规/导演喊停时用。恢复播出由导演确认后重新启动节目。',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          await onEmergencyStop?.()
          notifyTimeline?.('—— 主播执行了紧急停止：声音已掐断、播报已暂停、会话已停止。恢复播出请导演确认后重新启动节目 ——')
          return ok('已紧急停止：所有声音掐断、播报暂停、会话停止。已立即执行并通知导演')
        } catch (error) {
          return ok(`紧急停止执行出错：${error instanceof Error ? error.message : String(error)}（请导演立即在播控台手动停止）`)
        }
      }
    })
  ]
}

/** 列表行的公共形状（list_voices/get_voice 共用） */
function voiceRow(v: VoiceRecord, storage: StorageService): Record<string, unknown> {
  return {
    id: v.id,
    名称: v.name,
    服务商: TTS_PROVIDER_SHORT[v.provider] ?? v.provider,
    模型: v.model,
    状态: voiceStatusLabel(v),
    所属接入: storage.ttsConnectionGet(v.connectionId)?.name ?? `${v.connectionId}（已删除）`,
    版本号: v.updatedAt
  }
}

function voiceStatusLabel(v: VoiceRecord): string {
  if (v.status === 'ready') return '可用'
  if (v.status === 'failed') return `失败（${v.error || '原因未知'}）`
  return '训练中'
}
