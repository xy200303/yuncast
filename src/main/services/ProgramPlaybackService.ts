import { existsSync } from 'node:fs'
import {
  LIBRARY_SOURCE_ID,
  TTS_PROVIDER_SHORT,
  type LaunchResult,
  type PreflightItem,
  type Program,
  type ProgramAudioProgress,
  type ProgramGateResult,
  type DraftUnit
} from '../../shared/types'
import { DRAFT_HARD_CAP } from './tools/util'
import type { AgentService } from './AgentService'
import type { ConnectorService } from './ConnectorService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import type { SpeechPool } from './SpeechPool'
import type { StorageService } from './StorageService'
import type { StreamService } from './stream/StreamService'
import type { TtsService } from './TtsService'
import type { DraftUnitService } from './DraftUnitService'
import { resolveModelForDirector } from './llmModel'
import { friendlyError } from './errorTranslate'
import { getLlmProvider } from './providers/registry'
import { findCloneVoice } from '../../shared/voiceProvider'
import { audioProgress, evaluateGate, listAudioUnits, narrativeOrder } from './programUnits'
import { policyFor } from './broadcastPolicy'

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
 * 节目播出（docs/07 §8.5 + docs/10 §9）：直播台唯一的开播路径。
 * 顺序 = 加载节目配置 → 应用身份（人设） → 应用音色 → 预检 → 装载话术库 → 让导演会话就位。
 * 预检把缺失项分成阻断/警告；装载只取 ready 条目（未就绪的等合成完由池接管）；失败回滚人设。
 */
export class ProgramPlaybackService {
  /** 场记记录器（index.ts 迟接线）：开播成功时建场次，收播由 index.ts 的三个收播点统一 end */
  recorder: {
    begin(
      programId: string,
      programName: string,
      snapshot: { directorModelDesc: string; personas: { personaId: string; personaName: string; voiceDesc: string }[] }
    ): string
    end(reason: 'crash'): void
  } | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly script: ScriptService,
    private readonly persona: PersonaService,
    private readonly draftUnits: DraftUnitService,
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

    // ① 卡司：出谁由节目卡司决定（没配卡司 = 导演逐条用 personaId 指定）
    const personas = this.persona.programPersonasOf(programId)
    items.push({
      level: 'ok',
      label:
        personas.length > 0
          ? `卡司：${personas.map((p) => p.name).join('、')}（没配嗓音的卡写词时会报错，先用 voice_list 配上）`
          : '卡司：导演自选（未配卡司，写词时逐条用 personaId 指定）'
    })

    // ② 导演大脑的凭据（模型解析和开播时用的完全是同一处逻辑）。
    // 引擎与导演解耦：模型不配只影响"要不要写新内容"（补货/互动），存量的合成音频照播——降级为警告
    const director = cfg.director
    const brain = director.modelConnectionId
      ? this.storage.connectionGet(director.modelConnectionId)
      : null
    if (director.modelConnectionId && !brain) {
      items.push({
        level: 'warn',
        code: 'director-brain',
        label: '导演大脑选的接入已被删除：播照常，没有智能补货/互动',
        detail: '到设置 → 语言模型给导演重选接入和模型'
      })
    } else if (!(director.modelConnectionId && director.model.trim())) {
      items.push({
        level: 'warn',
        code: 'director-brain',
        label: '导演大脑还没配：播照常，没有智能补货/互动',
        detail: '到设置 → 语言模型给导演配大脑'
      })
    } else {
      try {
        const resolved = resolveModelForDirector(this.storage, director)
        const name = resolved.connectionId
          ? (this.storage.connectionGet(resolved.connectionId)?.name ?? resolved.providerId)
          : (getLlmProvider(resolved.providerId)?.label ?? resolved.providerId)
        items.push({
          level: 'ok',
          label: `导演大脑：${name} · ${resolved.model}`
        })
      } catch (error) {
        items.push({
          level: 'warn',
          code: 'director-brain',
          label: '没有可用的语言模型：播照常，没有智能补货/互动',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // ②a 语音合成：只认节目显式配置的声音（或合成弹窗里明确选的声音），走和运行时完全相同的合成路由。
    // 没音色 = 新内容合不成，存量音频照播——降级为警告
    const effectiveVoice = this.persona.programVoiceOf(programId)
    let ttsReady = false
    if (!effectiveVoice) {
      items.push({
        level: 'warn',
        code: 'voice-missing',
        label: '还没给主播选音色：存量照播，新内容没法合成',
        detail: '到主播团给卡司里的卡配音色（或在节目里配自定义声音），新话术才有声音'
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
          code: 'tts-broken',
          label: '语音合成不可用：存量照播，新内容没法合成',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (ttsReady) {
      if (cfg.tts.lastTestAt === 0) {
        items.push({
          level: 'warn',
          code: 'voice-test',
          label: '还没测过发音',
          detail: '设置 → 语音合成点一次「测试发音」，先确认声音真出得来'
        })
      } else if (Date.now() - cfg.tts.lastTestAt > VOICE_TEST_STALE_MS) {
        const hours = Math.round((Date.now() - cfg.tts.lastTestAt) / 3600_000)
        items.push({ level: 'warn', code: 'voice-test', label: `上次测试发音在 ${hours} 小时前`, detail: '凭据可能已失效，建议重测' })
      } else {
        items.push({ level: 'ok', label: '发音测试通过（24 小时内）' })
      }
    }

    // ③ 编排（节目的场景序列）
    const script = this.script.getScript(program.id)
    if (!script) {
      items.push({ level: 'warn', code: 'script-missing', label: '节目还没有编排', detail: '主播只能自由发挥，节奏容易散' })
    } else if (script.scenes.length === 0) {
      items.push({ level: 'warn', code: 'script-missing', label: '编排里没有场景', detail: '编排至少要有一场' })
    } else {
      items.push({ level: 'ok', label: `编排：${script.title}（${script.scenes.length} 场）` })
    }

    // ④ 话术库（整库装载，不分场景）；即兴播出不要求底稿（docs/10 §7.1），跳过底稿检查
    const library = this.draftUnits.list(program.id)
    const ready = library.filter((u) => u.status === 'ready')
    if (program.broadcastMode === 'improvised') {
      items.push({
        level: 'ok',
        label: '即兴播出：无需底稿',
        detail: '主播根据导演指令和直播间动态现场发挥；没动静时允许自然安静'
      })
    } else {
    if (library.length === 0) {
      items.push({
        level: 'warn',
        label: '话术库是空的',
        detail: '节目页让主播预生成整版底稿，开播才有骨架'
      })
    } else if (ready.length === 0) {
      items.push({
        level: 'warn',
        label: `没有就绪话术（共 ${library.length} 段）`,
        detail: '可以先批量预合成，或让主播现场补货'
      })
    } else {
      items.push({
        level: 'ok',
        label: `话术库：就绪 ${ready.length} 段`,
        detail: `全场 ${library.length} 段，开播整库装载进池、后台滚动合成`
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
          : '先给节目配一份编排，主播才能按场景出整版底稿'
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
        : { level: 'warn', code: 'connector', label: '评论接入未连接', detail: '收不到真实评论、也回不出去，声音照播' }
    )
    const stats = this.stream.getStats()
    items.push(
      stats.streaming
        ? { level: 'ok', label: '推流中', detail: `码率 ${stats.bitrateKbps} kbps` }
        : {
            level: 'warn',
            code: 'stream',
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
        failures: [{ unitKind: 'draftUnit', unitId: '', title: '', status: 'missing', reason: '节目不存在' }]
      }
    }
    return evaluateGate(program, this.script.getScript(program.id), this.draftUnits.list(programId))
  }

  /** 节目音频进度（program:audio-progress 的后端；单元总数/ready/synthesizing/failed/stale/pending） */
  audioProgress(programId: string): ProgramAudioProgress {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { total: 0, ready: 0, synthesizing: 0, pending: 0, failed: 0, stale: 0 }
    return audioProgress(program, this.script.getScript(program.id), this.draftUnits.list(programId))
  }

  /**
   * 启动节目：预检有阻断项就拒绝；否则按序应用并装载。出谁由节目卡司决定。
   * 引擎与 agent 解耦：agent 起不来（模型挂了等）只降级——话术池照常装载播报，
   * 智能补货/互动等 agent 就位后自然接上（pool.low 等事件沿总线等着她）。
   *
   * 播出方式的行为差异全部在 BroadcastPolicy（broadcastPolicy.ts）：
   * 装载、滚动合成、水位决策、续写都走策略，这里只编排顺序——装载 → 合成 → 开播态 → agent 就位。
   * 预制节目先过正式播放门禁（缺项返回结构化 gate，不静默跳过；
   * opts.allowPartial = 用户选了「仅播放已完成部分」）。
   */
  async launch(programId: string, opts?: { allowPartial?: boolean }): Promise<LaunchResult> {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    // 正在播出别的节目时不许直接开新场：开播态（agent.status().live）是唯一权威，agent 会话对换场早退，
    // 放过去会造成池/场记是 B、agent 还是 A 的状态撕裂
    if (this.agent.status().live) {
      const currentId = this.storage.getConfig().live.activeProgramId
      if (currentId !== program.id) {
        const current = this.storage.programList().find((p) => p.id === currentId)
        return { ok: false, error: `正在播出《${current?.name ?? '另一个节目'}》，先结束当前场次再开播新节目` }
      }
    }
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

    let sessionBegan = false
    try {
      this.script.setActiveProgram(program.id)
      // 场记：场次先于装载建立——首批装池条目就要带上场次 id（播出事实留档）
      if (this.recorder) {
        const cfg = this.storage.getConfig()
        const allPersonas = this.persona.list()
        const configuredCast = program.personaIds
          .map((id) => allPersonas.find((item) => item.id === id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
        const actualCast = configuredCast.length > 0 ? configuredCast : this.persona.list()
        const directorModelDesc = cfg.director.modelConnectionId && cfg.director.model
          ? `${cfg.director.name} · ${cfg.director.model}`
          : `${cfg.director.name} · 未配置大脑`
        const sid = this.recorder.begin(program.id, program.name, {
          directorModelDesc,
          personas: actualCast.map((item) => ({
            personaId: item.id,
            personaName: item.name,
            voiceDesc: item.voiceId || '未选择音色'
          }))
        })
        this.pool.sessionId = sid
        // 复盘摘要挂场次：收播可能先 end 再 stop（finishRoundStop 不等复盘），记在 agent 上才丢不了
        this.agent.broadcastSessionId = sid
        sessionBegan = true
      }
      // 清掉上一场别的节目的存货：不然「播完即停」等不到池空，会接着念别的节目的稿子（错位）
      const ownDraftUnitIds = new Set(this.draftUnits.list(program.id).map((u) => u.id))
      const cleared = this.pool.dropForeignOrigins(ownDraftUnitIds)
      if (cleared > 0) console.log(`[YunCast] 开播清池：撤掉 ${cleared} 条别的节目的存货`)
      const policy = policyFor(program, this)
      const loaded = policy.load(program, { allowPartial: opts?.allowPartial === true })
      // 滚动节目：有没合成的底稿就后台开蒸（0 就绪也允许开播，边合成边补装）；
      // 预制节目不在开播时自动合成（生产走「生成节目音频」入口），即兴节目没有底稿可蒸
      policy.kickSynthesis(program)
      // 引擎先行：这场算开播了（播放循环只认话术池，不依赖 agent 会话）
      // 开播前先把改过的资产应用上：文本层热替换（不断片），脑层变了才重开会话（此刻还没置开播态，
      // 重开不会触发下播复盘），导演带着本场的卡司与节目上下文中上场；否则她会按上一套写词
      if (this.agent.status().state !== 'stopped' && this.agent.status().assetsStale !== 'none') {
        await this.agent.applyAssets().catch(() => undefined)
      }
      this.agent.setLiveActive(true)
      // 导演会话尽力就位：起不来不拖垮播报，带警告回去让用户知道
      let warning: string | undefined
      try {
        // 全局单会话：开播不动会话——会话在跑就只刷新事件接线（新节目的 wiring 冻结进来）；
        // 没在跑就带着存档消息就位（开播不再是换会话的理由）
        if (this.agent.status().state === 'stopped') {
          await this.agent.start()
        } else {
          this.agent.refreshProgramGate()
        }
      } catch (error) {
        warning = `主播没起来（${friendlyError(error)}）：存量的合成音频照播，补货/互动等她就位后恢复`
      }
      return { ok: true, loaded, warning, gate }
    } catch (error) {
      // 场记已开但开播失败：这场不算数，按崩溃补尾，池场次标记摘掉
      if (sessionBegan) {
        this.pool.sessionId = null
        this.recorder?.end('crash')
      }
      return { ok: false, error: friendlyError(error) }
    }
  }

  /**
   * 预制节目装播（docs/10 §7.9）：按 Scene/DraftUnit 顺序把 rendered.audioPath 生成
   * pool_items 装池，一章/一期一个队列条目（标题用 Scene.title）。
   * 播放引擎只关心标题、audioPath、顺序和状态，不理解有声书语义。
   * allowPartial=true = 「仅播放已完成部分」：只装 ready 且指纹一致、文件在的单元。
   * 播出策略（broadcastPolicy）在启动装载和循环重装时都走这里。
   */
  loadPreparedUnits(program: Program, allowPartial: boolean): number {
    const script = this.script.getScript(program.id)
    const units = listAudioUnits(program, script, this.draftUnits.list(program.id))
    let loaded = 0
    for (const unit of units) {
      const rendered = unit.rendered
      const usable =
        rendered?.status === 'ready' &&
        rendered.sourceFingerprint === unit.fingerprint &&
        existsSync(rendered.audioPath)
      if (!usable) {
        // 门禁已过（完整播放）时不该走到这；部分播放就跳过未完成单元
        if (!allowPartial) console.warn(`[YunCast] 预制单元不可播，跳过：${unit.title}`)
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
          originDraftUnitId: unit.kind === 'draftUnit' ? unit.id : undefined,
          // 章级单元：章后停顿取章内最后一段的配置（章内段间停顿已烘进合并音频，轮不到播放层）
          pauseAfterMs: narrativeOrder(unit.draftUnits).at(-1)?.pauseAfterMs
        })
        loaded += 1
      } catch (error) {
        // 池满/单条不合规都不该炸开播：记一笔继续装下一条
        console.error(`[YunCast] 预制音频装载失败（${unit.id}）:`, error)
      }
    }
    return loaded
  }

  /** 后台滚动合成委托（播出策略 kickSynthesis 用）：rolling 有欠账就蒸，别的模式策略层不会调到 */
  kickSynthesis(programId: string): Promise<void> {
    return this.draftUnits.kickSynthesis(programId)
  }

  /** 预制节目循环重装：复用 rendered 音频（只装就绪单元），不重新合成 */
  reloadPreparedUnits(programId: string): number {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program || program.broadcastMode !== 'prepared') return 0
    return this.loadPreparedUnits(program, true)
  }

  /** 预制节目还有音频在出（生成中）：pool.empty 的收播决策区分「真播完」和「音频在路上」 */
  hasIncomingRendered(programId: string): boolean {
    return this.playGate(programId).synthesizing > 0
  }

  /**
   * 把节目的话术库整库载入池：只装 ready 条目，骨架先就位。
   * 剧本场景只是写稿时的范式约束（句式/结构），不做播放分区——启动场次默认全量装载，
   * 后台 kickSynthesis 滚动补合成。预合成音频在音色没变过时直接复用（开播零延迟），音色变过就让池重新合成。
   */
  loadProgramDraftUnits(programId: string): number {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return 0
    // closer（收尾段）不进自动轮播：播到一半来句「下回接着聊」就穿帮了——主播要收尾时自己 say 出去
    const ready = this.loadableDraftUnits(programId)
    // 叙事顺序：场景在剧本里的先后 → 场景内创作序号 seq（铺垫→展开→落点不乱）；
    // 轮播公平：主键「最久没进池」（队尾不饿死），首轮全部 lastLoaded=0，等于严格按叙事顺序播
    const script = this.script.getScript(program.id)
    const sceneOrder = new Map((script?.scenes ?? []).map((s, i) => [s.id, i]))
    const orderOf = (sceneId: string): number => sceneOrder.get(sceneId) ?? Number.MAX_SAFE_INTEGER
    const lastLoaded = this.storage.poolItemLastLoadedByOrigin()
    ready.sort(
      (a, b) =>
        (lastLoaded.get(a.id) ?? 0) - (lastLoaded.get(b.id) ?? 0) ||
        orderOf(a.sceneId) - orderOf(b.sceneId) ||
        a.seq - b.seq ||
        a.createdAt - b.createdAt
    )

    let loaded = 0
    for (const u of ready) {
      // 口径与生产一致：卡 id（personaId）→ 卡上的当前音色 > 段落音色快照 > 卡司第一张
      const cardVoice = u.personaId
        ? (this.persona.list().find((p) => p.id === u.personaId)?.voiceId ?? '').trim()
        : ''
      const voice = cardVoice || (this.persona.resolveProgramVoice(u.voiceId) ?? '')
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
          dedupeKey: `ut:${u.id}`,
          originDraftUnitId: u.id,
          pauseAfterMs: u.pauseAfterMs,
          audioPath: reusable ? (u.audioPath ?? undefined) : undefined
        })
        loaded += 1
      } catch (error) {
        // 池满/单条不合规都不该炸开播：记一笔继续装下一条
        console.error(`[YunCast] 话术装载失败（${u.id}）:`, error)
      }
    }
    return loaded
  }

  /** 补装钩子（就绪补装/场景推进/池见底）：没在播就跟当前节目走；整库已装过时靠池内去重自然落空 */
  loadActiveSceneDraftUnits(): number {
    const activeProgramId = this.storage.getConfig().live.activeProgramId
    if (!activeProgramId) return 0
    return this.loadProgramDraftUnits(activeProgramId)
  }

  /**
   * 预制节目按章跳播（docs/10 §11.5：上一章/下一章/章节点播，章级跳转 = 跳播对应 speech_item）。
   * 池里有这一章的未播条目就提到队首；已播完被清出池的按 launch 同口径重新装载再提队首。
   * 只负责把目标章排到下一个播；打断当前条目由调用方做（already=true 时目标正在播，别打断）。
   */
  playUnit(
    programId: string,
    target: { kind: 'scene' | 'draftUnit'; id: string }
  ): { ok: boolean; title?: string; already?: boolean; error?: string } {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    if (program.broadcastMode !== 'prepared') return { ok: false, error: '只有预制节目支持按章跳播' }
    const script = this.script.getScript(program.id)
    const unit = listAudioUnits(program, script, this.draftUnits.list(program.id)).find(
      (entry) => entry.kind === target.kind && entry.id === target.id
    )
    if (!unit) return { ok: false, error: '这个章节不存在' }
    const rendered = unit.rendered
    const usable =
      rendered?.status === 'ready' &&
      rendered.sourceFingerprint === unit.fingerprint &&
      existsSync(rendered.audioPath)
    if (!usable) return { ok: false, error: `「${unit.title}」的音频还没就绪，先完成合成` }
    const dedupeKey = `rendered:${unit.kind}:${unit.id}`
    if (this.pool.getStatus().playing?.dedupeKey === dedupeKey) {
      return { ok: true, title: unit.title, already: true }
    }
    try {
      if (!this.pool.jumpTo(dedupeKey)) {
        // 这一章已播完被清出池：按装播同口径重新入池（dedupeKey 不命中未播条目就是新条目）
        this.pool.say({
          text: unit.title,
          lane: 'normal',
          sourceKind: 'scene',
          sourceAgentId: LIBRARY_SOURCE_ID,
          dedupeKey,
          audioPath: rendered!.audioPath,
          originDraftUnitId: unit.kind === 'draftUnit' ? unit.id : undefined,
          pauseAfterMs: narrativeOrder(unit.draftUnits).at(-1)?.pauseAfterMs
        })
        this.pool.jumpTo(dedupeKey)
      }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
    return { ok: true, title: unit.title }
  }

  /** 节目可自动轮播的底稿（就绪 + 非 closer）：不分场景整库装载——剧本场景只约束写稿范式，不做播放分区 */
  private loadableDraftUnits(programId: string): DraftUnit[] {
    return this.draftUnits
      .list(programId)
      .filter((u) => u.status === 'ready' && u.bitType !== 'closer')
  }

  /**
   * 还有没进过池的可播底稿（首轮没播完）：补它叫「接着播」，不是循环。
   * 循环闸门用：全进过池了再装就是重播，只有到段数上限才允许
   */
  hasFreshDraftUnits(programId: string): boolean {
    const lastLoaded = this.storage.poolItemLastLoadedByOrigin()
    return this.loadableDraftUnits(programId).some((u) => !lastLoaded.has(u.id))
  }

  /** 底稿是否到段数上限（到顶才允许循环重播；上限是防失控的成本闸，写稿规模由主播自己定） */
  atDraftCap(programId: string): boolean {
    return this.draftUnits.list(programId).length >= DRAFT_HARD_CAP
  }

  /**
   * 还有没就绪但正在排队/合成中的可播底稿：池空了先等它们出炉（允许冷场），
   * 不算整轮播完——finishMode=stop 的「播完即停」决策用它区分「真播完了」和「内容还在路上」。
   */
  hasIncomingDraftUnits(programId: string): boolean {
    return this.draftUnits
      .list(programId)
      .some((u) => (u.status === 'pending' || u.status === 'synthesizing') && u.bitType !== 'closer')
  }
}
