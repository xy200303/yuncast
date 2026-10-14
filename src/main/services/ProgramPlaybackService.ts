import { existsSync } from 'node:fs'
import {
  LIBRARY_SOURCE_ID,
  TTS_PROVIDER_SHORT,
  type LaunchResult,
  type PreflightItem,
  type Program,
  type ProgramAudioProgress,
  type ProgramGateResult,
  type Utterance
} from '../../shared/types'
import { DRAFT_HARD_CAP } from './anchorTools'
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
import { audioProgress, evaluateGate, listAudioUnits } from './programUnits'

/** 超过这么久没重测发音，预检提醒重测（docs/07 §8.5 语音可用性） */
const VOICE_TEST_STALE_MS = 24 * 3600_000

/** 一个桥段平均时长（秒）：150~350 字、正常带货语速（预检的「约能播多久」估算用） */
const AVG_BIT_SECONDS = 45

/** 分钟数展示：整数不带小数，半分钟保留一位 */
function formatMinutes(minutes: number): string {
  const value = Math.round(minutes * 10) / 10
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 节目播出（docs/07 §8.5 + docs/10 §9）：播控台唯一的开播路径。
 * 顺序 = 加载节目配置 → 应用身份（人设） → 应用音色 → 预检 → 装载话术库 → 启动主播。
 * 预检把缺失项分成阻断/警告；装载只取 ready 条目（未就绪的等合成完由池接管）；失败回滚人设。
 */
export class ProgramPlaybackService {
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
  preflight(programId: string): PreflightItem[] {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return [{ level: 'block', label: '节目不存在', detail: '到节目页重新选一个' }]

    const items: PreflightItem[] = []
    const cfg = this.storage.getConfig()

    // ① 主播身份：当前主播（主播团 active 的那张卡；节目不绑人，想换人直接切当前主播）
    const persona = this.persona.get()
    const personaRoles =
      persona.roles.length > 0 ? `（角色：${persona.roles.map((r) => r.name).join(' / ')}）` : ''
    items.push({ level: 'ok', label: `主播：${persona.name}${personaRoles}` })

    // ② 大脑的凭据（模型解析和开播时用的完全是同一处逻辑）。
    // 引擎与 agent 解耦：模型不配只影响智能层（补货/互动），存量的合成音频照播——降级为警告
    const brain = persona?.modelConnectionId
      ? this.storage.connectionGet(persona.modelConnectionId)
      : null
    if (persona && persona.modelConnectionId && !brain) {
      items.push({
        level: 'warn',
        label: `主播卡「${persona.name}」选的接入已被删除：播照常，没有智能补货/互动`,
        detail: '到主播团里重选一个接入和模型'
      })
    } else if (persona && !(persona.modelConnectionId && persona.model.trim())) {
      items.push({
        level: 'warn',
        label: `主播卡「${persona.name}」还没选模型：播照常，没有智能补货/互动`,
        detail: '到主播团里选一个'
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
          level: 'warn',
          label: '没有可用的语言模型：播照常，没有智能补货/互动',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // ②a 语音合成：生效音色（人设卡默认音色）走和运行时完全相同的合成路由。
    // 没音色 = 新内容合不成，存量音频照播——降级为警告
    const effectiveVoice = (persona?.voiceId || '').trim()
    let ttsReady = false
    if (!effectiveVoice) {
      items.push({
        level: 'warn',
        label: '还没给主播选音色：存量照播，新内容没法合成',
        detail: persona
          ? `到主播团给「${persona.name}」选一个音色，新话术才有声音`
          : '到主播团选一张人设卡并给它选一个音色'
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
          level: 'warn',
          label: '语音合成不可用：存量照播，新内容没法合成',
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
    const script = this.script.getScript(program.scriptId)
    if (!script) {
      items.push({ level: 'warn', label: '节目没绑定剧本', detail: '主播只能自由发挥，节奏容易散' })
    } else if (script.scenes.length === 0) {
      items.push({ level: 'warn', label: '剧本里没有场景', detail: '剧本至少要有一场' })
    } else {
      items.push({ level: 'ok', label: `剧本：${script.title}（${script.scenes.length} 场）` })
    }

    // ④ 话术库（当前场景能装载多少）；即兴播出不要求底稿（docs/10 §7.1），跳过底稿检查
    const library = this.utterances.list(program.id)
    const ready = library.filter((u) => u.status === 'ready')
    if (program.broadcastMode === 'improvised') {
      items.push({
        level: 'ok',
        label: '即兴播出：无需底稿',
        detail: '主播根据导演指令和直播间动态现场发挥；没动静时允许自然安静'
      })
    } else {
    const sceneId = script?.scenes[this.sceneIndex(program, script.scenes.length)]?.id ?? ''
    const sceneReady = ready.filter((u) => u.sceneId === sceneId || u.sceneId === '')
    if (library.length === 0) {
      items.push({
        level: 'warn',
        label: '话术库是空的',
        detail: '节目页让主播预生成整版底稿，开播才有骨架'
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
    const covered = (ready.length * AVG_BIT_SECONDS) / 60
    if (library.length === 0) {
      items.push({
        code: 'draft-empty',
        level: 'block',
        label: '还没有底稿',
        detail: script
          ? '点下方「去生成底稿」，让主播按场景写稿'
          : '先给节目绑一个剧本，主播才能按场景出整版底稿'
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
    }

    // ⑤b 预制节目：音频门禁摘要进预检（警告级——正式门禁在 launch，缺项不静默跳过）
    if (program.broadcastMode === 'prepared') {
      const gate = this.playGate(programId)
      items.push(
        gate.ok
          ? { level: 'ok', code: 'produce-gate', label: `节目音频全部就绪（${gate.ready}/${gate.total} 个单元）` }
          : {
              level: 'warn',
              code: 'produce-gate',
              label: `节目音频未就绪：已完成 ${gate.ready}/${gate.total} · 失败 ${gate.failed} · 待合成 ${gate.pending} · 合成中 ${gate.synthesizing} · 过期 ${gate.stale}`,
              detail: '先「生成节目音频」；正式播放前会再检查，缺项不会静默跳过'
            }
      )
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

  /**
   * 预制节目正式播放门禁（docs/10 §7.8，program:play-gate 的后端）：
   * 所选范围所有单元 rendered.status='ready' + 文件存在 + 指纹一致 + 非 stale 才算通过。
   * 返回结构化结果（各状态计数 + 失败原因列表），调用方不静默跳过——
   * 拿它给用户三选项：继续生成 / 重试失败 / 仅播放已完成部分（launch 带 allowPartial）。
   */
  playGate(programId: string): ProgramGateResult {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) {
      return {
        ok: false,
        programId,
        total: 0,
        ready: 0,
        synthesizing: 0,
        pending: 0,
        failed: 0,
        stale: 0,
        failures: [{ unitKind: 'utterance', unitId: '', title: '', status: 'missing', reason: '节目不存在' }]
      }
    }
    return evaluateGate(program, this.script.getScript(program.scriptId), this.utterances.list(programId))
  }

  /** 节目音频进度（program:audio-progress 的后端；单元总数/ready/synthesizing/failed/stale/pending） */
  audioProgress(programId: string): ProgramAudioProgress {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { total: 0, ready: 0, synthesizing: 0, pending: 0, failed: 0, stale: 0 }
    return audioProgress(program, this.script.getScript(program.scriptId), this.utterances.list(programId))
  }

  /**
   * 启动节目：预检有阻断项就拒绝；否则按序应用并装载。主播 = 当前主播，不在节目上。
   * 引擎与 agent 解耦：agent 起不来（模型挂了等）只降级——话术池照常装载播报，
   * 智能补货/互动等 agent 就位后自然接上（pool.low 等事件沿总线等着她）。
   *
   * 播出方式分流（docs/10 §7）：
   * - improvised：不要求底稿，不装载不预合成，播出队列只装主播现场说的；
   * - rolling：维持现有装池逻辑 + 后台提前合成；
   * - prepared：先过正式播放门禁（缺项返回结构化 gate，不静默跳过；
   *   opts.allowPartial = 用户选了「仅播放已完成部分」），按章/段把 rendered 音频装池。
   */
  async launch(programId: string, opts?: { allowPartial?: boolean }): Promise<LaunchResult> {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    const blocked = this.preflight(programId).filter((item) => item.level === 'block')
    if (blocked.length > 0) {
      return { ok: false, error: `预检未通过：${blocked.map((item) => item.label).join('；')}` }
    }

    // 预制节目正式播放门禁：未通过且用户没选「仅播放已完成部分」就拒绝，附上结构化结果
    let gate: ProgramGateResult | undefined
    if (program.broadcastMode === 'prepared') {
      gate = this.playGate(programId)
      if (!gate.ok && !opts?.allowPartial) {
        return {
          ok: false,
          error:
            `节目音频未就绪：已完成 ${gate.ready}/${gate.total} · 失败 ${gate.failed} · ` +
            `待合成 ${gate.pending} · 合成中 ${gate.synthesizing} · 过期 ${gate.stale}。` +
            `可以继续生成、重试失败项，或仅播放已完成部分`,
          gate
        }
      }
    }

    try {
      this.script.setActiveProgram(program.id)
      const loaded =
        program.broadcastMode === 'prepared'
          ? this.loadPreparedUnits(program, opts?.allowPartial === true)
          : program.broadcastMode === 'improvised'
            ? 0
            : this.loadSceneUtterances(program.id)
      // 滚动节目：有没合成的底稿就后台开蒸（0 就绪也允许开播，边合成边补装）；
      // 预制节目不在开播时自动合成（生产走「生成节目音频」入口），即兴节目没有底稿可蒸
      if (program.broadcastMode === 'rolling') void this.utterances.kickSynthesis(program.id)
      // 引擎先行：这场算开播了（播放循环只认话术池，不依赖 agent 会话）
      this.agent.setLiveActive(true)
      // 智能层尽力就位：起不来不拖垮播报，带警告回去让导演知道
      let warning: string | undefined
      try {
        // 开播必须是干净的直播会话：写稿会话（prep）还挂着就先停掉，不带写稿上下文上场
        const status = this.agent.status()
        if (status.state !== 'stopped' && status.purpose === 'prep') await this.agent.stop()
        await this.agent.start('live')
      } catch (error) {
        warning = `主播智能层没起来（${error instanceof Error ? error.message : String(error)}）：存量的合成音频照播，补货/互动等她就位后恢复`
      }
      return { ok: true, loaded, warning, gate }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 预制节目装播（docs/10 §7.9）：按 Scene/Utterance 顺序把 rendered.audioPath 生成
   * speech_items 装池，一章/一期一个队列条目（标题用 Scene.title）。
   * 播放引擎只关心标题、audioPath、顺序和状态，不理解有声书语义。
   * allowPartial=true = 「仅播放已完成部分」：只装 ready 且指纹一致、文件在的单元。
   */
  private loadPreparedUnits(program: Program, allowPartial: boolean): number {
    const script = this.script.getScript(program.scriptId)
    const units = listAudioUnits(program, script, this.utterances.list(program.id))
    let loaded = 0
    for (const unit of units) {
      const rendered = unit.rendered
      const usable =
        rendered?.status === 'ready' &&
        rendered.sourceFingerprint === unit.fingerprint &&
        existsSync(rendered.audioPath)
      if (!usable) {
        // 门禁已过（完整播放）时不该走到这；部分播放就跳过未完成单元
        if (!allowPartial) console.warn(`[AgentAnchor] 预制单元不可播，跳过：${unit.title}`)
        continue
      }
      try {
        this.pool.say({
          text: unit.title,
          lane: 'normal',
          sourceKind: 'scene',
          sourceAgentId: LIBRARY_SOURCE_ID,
          dedupeKey: `rendered:${unit.kind}:${unit.id}`,
          audioPath: rendered!.audioPath,
          originUtteranceId: unit.kind === 'utterance' ? unit.id : undefined
        })
        loaded += 1
      } catch (error) {
        // 池满/单条不合规都不该炸开播：记一笔继续装下一条
        console.error(`[AgentAnchor] 预制音频装载失败（${unit.id}）:`, error)
      }
    }
    return loaded
  }

  /**
   * 把当前场景的话术库载入池（docs/07 §8.5 ⑤）：只装 ready 条目，骨架先就位。
   * 预合成音频在音色没变过时直接复用（开播零延迟），音色变过就让池重新合成。
   */
  loadSceneUtterances(programId: string): number {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return 0
    const script = this.script.getScript(program.scriptId)
    if (!script || script.scenes.length === 0) return 0
    const sceneIndex = this.sceneIndex(program, script.scenes.length)
    const sceneId = script.scenes[sceneIndex].id
    // closer（收尾段）不进自动轮播：播到一半来句「下回接着聊」就穿帮了——主播要收尾时自己 say 出去
    const ready = this.loadableUtterances(programId, sceneId)
    // 轮播公平 + 叙事顺序：主键「最久没进池」（队尾不饿死，底稿轮得到），
    // 同轮次内按创作序号 seq——首轮全部 lastLoaded=0，等于严格按写作顺序播，铺垫→展开→落点不乱
    const lastLoaded = this.storage.speechLastLoadedByOrigin()
    ready.sort(
      (a, b) => (lastLoaded.get(a.id) ?? 0) - (lastLoaded.get(b.id) ?? 0) || a.seq - b.seq || a.createdAt - b.createdAt
    )

    let loaded = 0
    for (const u of ready) {
      const voice = this.persona.resolveProgramVoice(undefined, u.voiceId) ?? ''
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

  /** 场景切换后装载：agent 的 advance_scene 走这里（没在播就跟当前节目走） */
  loadActiveSceneUtterances(): number {
    const activeProgramId = this.storage.getConfig().live.activeProgramId
    if (!activeProgramId) return 0
    return this.loadSceneUtterances(activeProgramId)
  }

  /** 当前场景可自动轮播的底稿（就绪 + 非 closer + 本场景或通用） */
  private loadableUtterances(programId: string, sceneId: string): Utterance[] {
    return this.utterances
      .list(programId)
      .filter((u) => u.status === 'ready' && u.bitType !== 'closer' && (u.sceneId === sceneId || u.sceneId === ''))
  }

  /**
   * 当前场景还有没进过池的可播底稿（首轮没播完）：补它叫「接着播」，不是循环。
   * 循环闸门用：全进过池了再装就是重播，只有到段数上限才允许
   */
  hasFreshUtterances(programId: string): boolean {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return false
    const script = this.script.getScript(program.scriptId)
    if (!script || script.scenes.length === 0) return false
    const sceneId = script.scenes[this.sceneIndex(program, script.scenes.length)].id
    const lastLoaded = this.storage.speechLastLoadedByOrigin()
    return this.loadableUtterances(programId, sceneId).some((u) => !lastLoaded.has(u.id))
  }

  /** 底稿是否到段数上限（到顶才允许循环重播；上限是防失控的成本闸，写稿规模由主播自己定） */
  atDraftCap(programId: string): boolean {
    return this.utterances.list(programId).length >= DRAFT_HARD_CAP
  }

  /** 切场景（播控台按钮 / goto_scene 工具）：跳过去并把新场景话术库载入池 */
  gotoScene(programId: string, index: number): { ok: boolean; loaded: number; title?: string; error?: string } {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, loaded: 0, error: '节目不存在' }
    if (this.storage.getConfig().live.activeProgramId !== program.id) this.script.setActiveProgram(program.id)
    const target = this.script.gotoScene(index)
    if (!target) return { ok: false, loaded: 0, error: '没有这个场景' }
    this.agent.notifySceneChanged()
    const loaded = this.loadSceneUtterances(program.id)
    return { ok: true, loaded, title: target.scene.title }
  }

  private sceneIndex(program: { currentSceneIdx: number }, totalScenes: number): number {
    if (totalScenes === 0) return 0
    return Math.min(Math.max(program.currentSceneIdx, 0), totalScenes - 1)
  }
}
