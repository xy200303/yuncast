import {
  LIBRARY_SOURCE_ID,
  TTS_PROVIDER_SHORT,
  type LaunchResult,
  type PreflightItem,
  type Utterance
} from '../../shared/types'
import { coveredMinutes, planBroadcastCap } from '../../shared/planDuration'
import type { AgentService } from './AgentService'
import type { ConnectorService } from './ConnectorService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import type { SpeechPool } from './SpeechPool'
import type { StorageService } from './StorageService'
import type { StreamService } from './stream/StreamService'
import type { TtsService } from './TtsService'
import type { UtteranceService } from './UtteranceService'
import { resolveModelForPersona } from './llmModel'
import { getLlmProvider } from './providers/registry'
import { findCloneVoice } from '../../shared/voiceProvider'

/** 超过这么久没重测发音，预检提醒重测（docs/07 §8.5 语音可用性） */
const VOICE_TEST_STALE_MS = 24 * 3600_000

/** 分钟数展示：整数不带小数，半分钟保留一位 */
function formatMinutes(minutes: number): string {
  const value = Math.round(minutes * 10) / 10
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

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
    private readonly stream: StreamService,
    private readonly tts: TtsService
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

    // ② 大脑的凭据（模型解析和开播时用的完全是同一处逻辑）
    const brain = persona?.modelConnectionId
      ? this.storage.connectionGet(persona.modelConnectionId)
      : null
    if (persona && persona.modelConnectionId && !brain) {
      items.push({
        level: 'block',
        label: `主播卡「${persona.name}」选的接入已被删除：到主播团里重选一个接入和模型`
      })
    } else if (persona && !(persona.modelConnectionId && persona.model.trim())) {
      items.push({
        level: 'block',
        label: `主播卡「${persona.name}」还没选模型：到主播团里选一个`
      })
    } else {
      try {
        const resolved = resolveModelForPersona(this.storage, persona)
        const name = resolved.connectionId
          ? (this.storage.connectionGet(resolved.connectionId)?.name ?? resolved.providerId)
          : (getLlmProvider(resolved.providerId)?.label ?? resolved.providerId)
        items.push({
          level: 'ok',
          label: `语言模型：${name} · ${resolved.model}${persona ? `（来自主播卡「${persona.name}」）` : ''}`
        })
      } catch (error) {
        items.push({
          level: 'block',
          label: '没有可用的语言模型',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // ②a 语音合成：生效音色（人设卡默认音色）走和运行时完全相同的合成路由。
    // 没有默认音色也没有默认接入：没选音色就是阻断项，不做任何猜测。
    const effectiveVoice = (persona?.voiceId || '').trim()
    let ttsReady = false
    if (!effectiveVoice) {
      items.push({
        level: 'block',
        label: '还没给主播选音色',
        detail: persona
          ? `到主播团给「${persona.name}」选一个音色（场次里也能覆盖），不然主播没声音`
          : '到主播团选一张人设卡并给它选一个音色，不然主播没声音'
      })
    } else {
      try {
        const route = this.tts.routeForVoice(effectiveVoice)
        ttsReady = true
        const clone = findCloneVoice(this.storage.listVoices(), route.voice)
        items.push({
          level: 'ok',
          label: `语音合成：${TTS_PROVIDER_SHORT[route.provider]} / ${route.model.label} / ${route.voice}${
            clone ? `（${clone.name} · 克隆音色）` : ''
          }`
        })
      } catch (error) {
        items.push({
          level: 'block',
          label: '语音合成不可用',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (ttsReady) {
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
        label: `当前场景没有就绪话术（共 ${library.length} 段，就绪 ${ready.length} 段）`,
        detail: '可以先批量预合成，或让主播现场补货'
      })
    } else {
      items.push({
        level: 'ok',
        label: `话术库：当前场景就绪 ${sceneReady.length} 段`,
        detail: `全场就绪 ${ready.length}/${library.length} 段，开播直接装载`
      })
    }

    // ⑤ 底稿管线状态：没写（阻断，去生成）→ 写了没合成（警告，去预合成）→ 有就绪（通过）。
    // 0 就绪不是阻断：开场触发器会让主播现场 say、实时合成照样出声，只是不够平滑
    const covered = coveredMinutes(ready.length)
    if (library.length === 0) {
      items.push({
        code: 'draft-empty',
        level: 'block',
        label: '还没有底稿',
        detail: script
          ? '点下方「去生成底稿」，填预生成时长让主播写稿'
          : '先给场次绑一个剧本，生成 Agent 才能按场景出整版底稿'
      })
    } else if (ready.length === 0) {
      items.push({
        code: 'presynth',
        level: 'warn',
        label: `底稿 ${library.length} 段写好了，还没有合成音频`,
        detail: '点下方「预合成全部」（几分钟）；也可以直接开播，靠现场合成先顶着'
      })
    } else {
      items.push({
        code: 'coverage',
        level: 'ok',
        label: `底稿就绪 ${ready.length} 段（约能播 ${formatMinutes(covered)}）`,
        detail:
          ready.length < library.length
            ? `另有 ${library.length - ready.length} 段待合成，播完循环复用音频；池子水位低了主播会现场续写`
            : '播完循环复用音频；池子水位低了主播会现场续写'
      })
    }

    // ⑥ 接入与推流（都能降级：不打断开播）
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
      const loaded = this.loadSceneUtterances(plan.id)
      // 有没合成的底稿就后台开蒸：0 就绪也允许开播（预检只是警告），边合成边补装，不空转
      void this.utterances.kickSynthesis(plan.id)
      // 开播必须是干净的直播会话：写稿会话（prep）还挂着就先停掉，不带写稿上下文上场
      const status = this.agent.status()
      if (status.state !== 'stopped' && status.purpose === 'prep') await this.agent.stop()
      await this.agent.start('live')
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
    const library = this.utterances.list(plan.id)
    // closer（收尾段）不进自动轮播：播到一半来句「下回接着聊」就穿帮了——主播要收尾时自己 say 出去
    const ready = this.loadableUtterances(planId, sceneId)
    // 轮播公平 + 叙事顺序：主键「最久没进池」（队尾不饿死，底稿轮得到），
    // 同轮次内按创作序号 seq——首轮全部 lastLoaded=0，等于严格按写作顺序播，铺垫→展开→落点不乱
    const lastLoaded = this.storage.speechLastLoadedByOrigin()
    ready.sort(
      (a, b) => (lastLoaded.get(a.id) ?? 0) - (lastLoaded.get(b.id) ?? 0) || a.seq - b.seq || a.createdAt - b.createdAt
    )

    let loaded = 0
    for (const u of ready) {
      const voice = this.persona.resolvePlanVoice(plan, undefined, u.voiceId) ?? ''
      const reusable = Boolean(u.audioPath) && (u.synthVoice ?? '') === voice
      try {
        this.pool.say({
          text: u.text,
          voiceId: voice || undefined,
          delivery: u.delivery || undefined,
          rate: u.rate,
          pitch: u.pitch,
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

  /** 当前场景可自动轮播的底稿（就绪 + 非 closer + 本场景或通用） */
  private loadableUtterances(planId: string, sceneId: string): Utterance[] {
    return this.utterances
      .list(planId)
      .filter((u) => u.status === 'ready' && u.bitType !== 'closer' && (u.sceneId === sceneId || u.sceneId === ''))
  }

  /**
   * 当前场景还有没进过池的可播底稿（首轮没播完）：补它叫「接着播」，不是循环。
   * 循环闸门用：全进过池了再装就是重播，只有到段数上限才允许
   */
  hasFreshUtterances(planId: string): boolean {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return false
    const script = this.script.getScript(plan.scriptId)
    if (!script || script.scenes.length === 0) return false
    const sceneId = script.scenes[this.sceneIndex(plan, script.scenes.length)].id
    const lastLoaded = this.storage.speechLastLoadedByOrigin()
    return this.loadableUtterances(planId, sceneId).some((u) => !lastLoaded.has(u.id))
  }

  /** 底稿是否到段数上限（到顶才允许循环重播；无限 = 永不循环，等新内容） */
  atDraftCap(planId: string): boolean {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return false
    const cap = planBroadcastCap(plan)
    if (!Number.isFinite(cap)) return false
    return this.utterances.list(planId).length >= cap
  }

  /** 切场景（直播台按钮 / goto_scene 工具）：跳过去并把新场景话术库载入池 */
  gotoScene(planId: string, index: number): { ok: boolean; loaded: number; title?: string; error?: string } {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    if (!plan) return { ok: false, loaded: 0, error: '场次不存在' }
    if (this.storage.getConfig().live.activePlanId !== plan.id) this.script.setActivePlan(plan.id)
    const target = this.script.gotoScene(index)
    if (!target) return { ok: false, loaded: 0, error: '没有这个场景' }
    this.agent.notifySceneChanged()
    const loaded = this.loadSceneUtterances(plan.id)
    return { ok: true, loaded, title: target.scene.title }
  }

  private sceneIndex(plan: { currentSceneIdx: number }, totalScenes: number): number {
    if (totalScenes === 0) return 0
    return Math.min(Math.max(plan.currentSceneIdx, 0), totalScenes - 1)
  }
}
