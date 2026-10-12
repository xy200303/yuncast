import {
  llmConfigured,
  ttsConfigured,
  type LaunchResult,
  type PreflightItem
} from '../../shared/types'
import type { AgentService } from './AgentService'
import type { ConnectorService } from './ConnectorService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import type { SpeechPool } from './SpeechPool'
import type { StorageService } from './StorageService'
import type { StreamService } from './stream/StreamService'
import type { UtteranceService } from './UtteranceService'

/** 装载进池的来源 id：不占主播自己的每分钟发言额度 */
const LIBRARY_SOURCE_ID = 'library'
/** 超过这么久没重测发音，预检提醒重测（docs/07 §8.5 语音可用性） */
const VOICE_TEST_STALE_MS = 24 * 3600_000

/**
 * 场次启动（docs/07 §8.5）：直播台唯一的开播路径。
 * 顺序 = 加载场次配置 → 应用身份（人设） → 应用音色 → 预检 → 装载话术库 → 启动主播。
 * 预检把缺失项分成阻断/警告；装载只取 ready 条目（未就绪的等合成完由池接管）；失败回滚人设。
 */
export class LaunchService {
  constructor(
    private readonly storage: StorageService,
    private readonly script: ScriptService,
    private readonly persona: PersonaService,
    private readonly utterances: UtteranceService,
    private readonly pool: SpeechPool,
    private readonly agent: AgentService,
    private readonly connector: ConnectorService,
    private readonly stream: StreamService
  ) {}

  /** 开播前预检：阻断项拦住开播，警告项交给导演判断（UI 里红色/黄色分列） */
  preflight(planId: string): PreflightItem[] {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return [{ level: 'block', label: '场次不存在', detail: '到场次页重新选一个' }]

    const items: PreflightItem[] = []
    const cfg = this.storage.getConfig()

    // ① 主播身份
    const persona = plan.personaId ? (this.persona.list().find((p) => p.id === plan.personaId) ?? null) : null
    if (!plan.personaId) {
      items.push({ level: 'block', label: '场次没有绑定人设卡', detail: '场次页编辑这场：人设决定谁在播' })
    } else if (!persona) {
      items.push({ level: 'block', label: '绑定的人设卡已不存在', detail: '重新选一张人设卡' })
    } else {
      const roles =
        persona.roles.length > 0 ? `（角色：${persona.roles.map((r) => r.name).join(' / ')}）` : ''
      items.push({ level: 'ok', label: `人设：${persona.name}${roles}` })
    }

    // ② 大脑与声音的凭据
    items.push(
      llmConfigured(cfg.llm)
        ? { level: 'ok', label: `语言模型：${cfg.llm.provider} / ${cfg.llm.model}` }
        : { level: 'block', label: '语言模型未配置', detail: '设置 → 语言模型：填 API Key 与模型' }
    )
    const ttsOk = ttsConfigured(cfg.tts)
    items.push(
      ttsOk
        ? {
            level: 'ok',
            label: `语音合成：${cfg.tts.provider === 'bailian' ? '阿里云百炼' : '火山引擎'} / ${cfg.tts.voiceId}`
          }
        : { level: 'block', label: '语音合成未配置', detail: '设置 → 语音合成：填凭据与默认音色（不然主播没声音）' }
    )
    if (ttsOk) {
      if (cfg.tts.lastTestAt === 0) {
        items.push({
          level: 'warn',
          label: '还没测过发音',
          detail: '设置 → 语音合成点一次「测试发音」，先确认声音真出得来'
        })
      } else if (Date.now() - cfg.tts.lastTestAt > VOICE_TEST_STALE_MS) {
        const hours = Math.round((Date.now() - cfg.tts.lastTestAt) / 3600_000)
        items.push({ level: 'warn', label: `上次测试发音在 ${hours} 小时前`, detail: '凭据可能已失效，建议重测' })
      } else {
        items.push({ level: 'ok', label: '发音测试通过（24 小时内）' })
      }
    }

    // ③ 剧本
    const script = this.script.getScript(plan.scriptId)
    if (!script) {
      items.push({ level: 'warn', label: '场次没绑定剧本', detail: '主播只能自由发挥，节奏容易散' })
    } else if (script.scenes.length === 0) {
      items.push({ level: 'warn', label: '剧本里没有场景', detail: '剧本至少要有一场' })
    } else {
      items.push({ level: 'ok', label: `剧本：${script.title}（${script.scenes.length} 场）` })
    }

    // ④ 话术库（当前场景能装载多少）
    const library = this.utterances.list(plan.id)
    const ready = library.filter((u) => u.status === 'ready')
    const sceneId = script?.scenes[this.sceneIndex(plan, script.scenes.length)]?.id ?? ''
    const sceneReady = ready.filter((u) => u.sceneId === sceneId || u.sceneId === '')
    if (library.length === 0) {
      items.push({
        level: 'warn',
        label: '话术库是空的',
        detail: '场次页用生成 Agent 预生成整场话术，开播才有骨架'
      })
    } else if (sceneReady.length === 0) {
      items.push({
        level: 'warn',
        label: `当前场景没有就绪话术（共 ${library.length} 条，就绪 ${ready.length} 条）`,
        detail: '可以先批量预合成，或让主播现场补货'
      })
    } else {
      items.push({
        level: 'ok',
        label: `话术库：当前场景就绪 ${sceneReady.length} 条`,
        detail: `全场就绪 ${ready.length}/${library.length} 条，开播直接装载`
      })
    }

    // ⑤ 接入与推流（都能降级：不打断开播）
    const connector = this.connector.status()
    items.push(
      connector.state === 'connected'
        ? { level: 'ok', label: `评论接入已连接（已收 ${connector.receivedCount} 条）` }
        : { level: 'warn', label: '评论接入未连接', detail: '收不到真实评论、也回不出去，声音照播' }
    )
    const stats = this.stream.getStats()
    items.push(
      stats.streaming
        ? { level: 'ok', label: '推流中', detail: `码率 ${stats.bitrateKbps} kbps` }
        : {
            level: 'warn',
            label: stats.mode === 'companion' ? '推流未启动（伴侣模式，正常）' : '推流未启动',
            detail:
              stats.mode === 'companion'
                ? '在直播伴侣里把本机声音/麦克风采进去就行'
                : '直推模式：开播后到推流设置点开始'
          }
    )

    return items
  }

  /** 启动场次：预检有阻断项就拒绝；否则按序应用并装载，失败回滚人设 */
  async launch(planId: string): Promise<LaunchResult> {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return { ok: false, error: '场次不存在' }
    const blocked = this.preflight(planId).filter((item) => item.level === 'block')
    if (blocked.length > 0) {
      return { ok: false, error: `预检未通过：${blocked.map((item) => item.label).join('；')}` }
    }

    const personaBefore = this.persona.get().id
    let switched = false
    try {
      this.script.setActivePlan(plan.id)
      if (plan.personaId && plan.personaId !== personaBefore) {
        this.persona.setActive(plan.personaId)
        switched = true
      }
      this.agent.setPlanVoice(plan.voiceId)
      const loaded = this.loadSceneUtterances(plan.id)
      await this.agent.start()
      return { ok: true, loaded }
    } catch (error) {
      if (switched) this.persona.setActive(personaBefore)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 把当前场景的话术库载入池（docs/07 §8.5 ⑤）：只装 ready 条目，骨架先就位。
   * 预合成音频在音色没变过时直接复用（开播零延迟），音色变过就让池重新合成。
   */
  loadSceneUtterances(planId: string): number {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return 0
    const script = this.script.getScript(plan.scriptId)
    if (!script || script.scenes.length === 0) return 0
    const sceneIndex = this.sceneIndex(plan, script.scenes.length)
    const sceneId = script.scenes[sceneIndex].id
    const ready = this.utterances
      .list(plan.id)
      .filter((u) => u.status === 'ready' && (u.sceneId === sceneId || u.sceneId === ''))

    let loaded = 0
    for (const u of ready) {
      const voice = this.persona.resolvePlanVoice(plan, undefined, u.voiceId) ?? ''
      const reusable = Boolean(u.audioPath) && (u.synthVoice ?? '') === voice
      try {
        this.pool.say({
          text: u.text,
          voiceId: voice || undefined,
          lane: 'normal',
          sourceKind: 'scene',
          sourceAgentId: LIBRARY_SOURCE_ID,
          dedupeKey: `ut:${u.id}:s${sceneIndex}`,
          originUtteranceId: u.id,
          audioPath: reusable ? (u.audioPath ?? undefined) : undefined
        })
        loaded += 1
      } catch (error) {
        // 池满/单条不合规都不该炸开播：记一笔继续装下一条
        console.error(`[AgentAnchor] 话术装载失败（${u.id}）:`, error)
      }
    }
    return loaded
  }

  /** 场景切换后装载：agent 的 advance_scene 走这里（没在播就跟当前场次走） */
  loadActiveSceneUtterances(): number {
    const activePlanId = this.storage.getConfig().live.activePlanId
    if (!activePlanId) return 0
    return this.loadSceneUtterances(activePlanId)
  }

  private sceneIndex(plan: { currentSceneIdx: number }, totalScenes: number): number {
    if (totalScenes === 0) return 0
    return Math.min(Math.max(plan.currentSceneIdx, 0), totalScenes - 1)
  }
}
