import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import type {
  ProduceAudioResult,
  ProducePlanInfo,
  Program,
  RenderedAudioRef,
  Utterance,
  UtteranceInput
} from '../../shared/types'
import { stableHash, utteranceFingerprint, sceneFingerprint } from '../../shared/fingerprint'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import { getTtsProvider, ttsModelBlocker, ttsModelSpec } from './providers/registry'
import { getFfmpegPath } from './stream/ffmpeg/bin'
import { listAudioUnits, narrativeOrder, type AudioUnit } from './programUnits'

/** 外部音频允许导入的格式（与克隆样本的交集一致） */
const IMPORT_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a'])

/** 粗估时长：中文 TTS 约 4.5 字/秒（确认卡的「预计时长」用，不是承诺） */
const CHARS_PER_SECOND = 4.5

/**
 * 节目话术库（docs/07 §3 utterances）+ 节目音频统一生产入口（docs/10 §7.5）。
 * 与运行态 speech_items 分工：开播时按轮播规则从这里取件入池；
 * 直播中的改写不回写底稿（复盘采纳才回写，source='adopted'）。
 *
 * P4 起这里同时是 capability 驱动的节目音频生产入口：
 * - rolling：行为同原 synthesizeAll（逐段提前合成，非门禁）；
 * - prepared：按内容类型划分合成单元（场景类节目=每章一个单元，solo=每段一个单元），
 *   逐段合成后整章用 ffmpeg 拼接挂 Scene.rendered，段级产物挂 Utterance.rendered；
 *   开始时把节目 audioConfig 冻结成声音快照写进产物（§9.6），切换主播不改写已有音频。
 * longform/podcast 适配器是 P6：manifest 没有这些能力时预制一律走 standard 逐段+拼接，
 * 文案只承诺「分段合成并拼接」，不承诺连续表演效果。
 */
export class UtteranceService {
  /** 单条状态变化广播（index.ts 接 broadcastUtterance；预合成与底稿改后重合成共用） */
  onEvent: ((u: Utterance) => void) | null = null
  /** 一批合成结束广播（id='' 的特殊事件，UI 整体刷新） */
  onBatchDone: ((programId: string) => void) | null = null
  /** 预制音频资产变化广播（Scene.rendered / Utterance.rendered 更新；渲染层刷新节目音频进度） */
  onRenderedEvent: ((programId: string) => void) | null = null
  /** 正在后台合成的节目（重入转 dirty，跑完补一轮） */
  private readonly synthRunning = new Set<string>()
  private readonly synthDirty = new Set<string>()
  /** 正在预制生产的节目（与滚动合成共用一把锁，防两条流水线踩同一份文稿） */
  private readonly produceRunning = new Set<string>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly persona: PersonaService,
    private readonly script: ScriptService
  ) {}

  /**
   * 后台把节目里 pending/failed 的条目合成就绪（带节目锁）：
   * 预合成按钮、主播改/补底稿后的重合成都走这里。同时在跑就标 dirty，本轮结束自动补跑一轮。
   */
  async kickSynthesis(programId: string): Promise<void> {
    if (this.synthRunning.has(programId)) {
      this.synthDirty.add(programId)
      return
    }
    this.synthRunning.add(programId)
    try {
      do {
        this.synthDirty.delete(programId)
        try {
          await this.synthesizeAll(programId, (u) => this.onEvent?.(u))
        } catch (error) {
          console.warn(`[话术库] 后台合成中断：${error instanceof Error ? error.message : String(error)}`)
        }
      } while (this.synthDirty.has(programId))
    } finally {
      this.synthRunning.delete(programId)
      this.onBatchDone?.(programId)
    }
  }

  list(programId: string): Utterance[] {
    return this.storage.utteranceList(programId)
  }

  /** 生成 Agent 的 write_bits 工具走这里：一次写一场景的一批桥段 */
  saveMany(
    programId: string,
    sceneId: string,
    items: { text: string; bitType?: string; delivery?: string; rate?: number; pitch?: number; sources?: Utterance['sources'] }[]
  ): Utterance[] {
    const existing = this.storage.utteranceList(programId).filter((u) => u.sceneId === sceneId)
    let variantIdx = existing.reduce((max, u) => Math.max(max, u.variantIdx + 1), 0)
    const saved = items
      .filter((item) => item.text.trim().length > 0)
      .map((item) =>
        this.save({
          programId,
          sceneId,
          variantIdx: variantIdx++,
          text: item.text.trim(),
          bitType: item.bitType?.trim() ?? '',
          delivery: item.delivery?.trim() ?? '',
          rate: item.rate,
          pitch: item.pitch,
          voiceId: '',
          source: 'initial',
          sources: item.sources ?? []
        })
      )
    this.refreshRenderedStaleness(programId)
    return saved
  }

  /** 新建/编辑。文本变了则作废旧音频（待重新预合成）；预制资产走 stale 检测（指纹不一致置 stale，不删文件）。 */
  save(input: UtteranceInput, id?: string): Utterance {
    if (!input.text.trim()) throw new Error('话术文本不能为空')
    const existing = id
      ? (this.storage.utteranceList(input.programId).find((u) => u.id === id) ?? null)
      : null
    const textChanged = existing !== null && existing.text !== input.text.trim()
    const utterance: Utterance = {
      id: id ?? `ut-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      programId: input.programId,
      sceneId: input.sceneId,
      variantIdx: input.variantIdx,
      // 创作序号：编辑保留原序号；新增自动排到场景末尾（装池按它恢复叙事顺序）
      seq: input.seq ?? existing?.seq ?? this.storage.utteranceNextSeq(input.programId, input.sceneId),
      text: input.text.trim(),
      bitType: input.bitType?.trim() ?? existing?.bitType ?? '',
      delivery: input.delivery?.trim() ?? existing?.delivery ?? '',
      rate: input.rate ?? existing?.rate,
      pitch: input.pitch ?? existing?.pitch,
      voiceId: input.voiceId ?? '',
      audioPath: textChanged ? null : (existing?.audioPath ?? null),
      status: textChanged ? 'pending' : (existing?.status ?? 'pending'),
      error: textChanged ? undefined : existing?.error,
      // 预制资产不因编辑而丢：指纹不一致由 refreshRenderedStaleness 置 stale
      rendered: existing?.rendered,
      source: input.source ?? 'initial',
      sources: input.sources ?? [],
      createdAt: existing?.createdAt ?? Date.now()
    }
    this.storage.utteranceSave(utterance)
    this.refreshRenderedStaleness(input.programId)
    return utterance
  }

  remove(id: string): void {
    const existing = this.storage.utteranceGet(id)
    this.storage.utteranceDelete(id)
    this.deleteOrphanAudio([existing?.audioPath])
    if (existing) this.refreshRenderedStaleness(existing.programId)
  }

  /** 清空节目话术库（重生成前）；给 sceneId 只清某场景。连缓存音频一起清（不被别处引用的才删） */
  clear(programId: string, sceneId?: string): void {
    const doomed = this.storage
      .utteranceList(programId)
      .filter((u) => sceneId === undefined || u.sceneId === sceneId)
      .map((u) => u.audioPath)
    this.storage.utteranceDeleteWhere(programId, sceneId)
    this.deleteOrphanAudio(doomed)
    this.refreshRenderedStaleness(programId)
  }

  /**
   * 预制音频 stale 检测（docs/10 §15.6）：文稿（utterance.text/delivery/rate/pitch 或章内段落集合）
   * 变了则对应 rendered.sourceFingerprint 与当前指纹不一致 → 置 'stale'（不删文件）；
   * 改回来（指纹重新一致）则从 stale 恢复 ready。改稿入口（save/saveMany/remove/clear/
   * ScriptService 的场景编辑回调）都会走到这里。
   */
  refreshRenderedStaleness(programId: string): void {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return
    const all = this.storage.utteranceList(programId)
    for (const u of all) {
      const rendered = u.rendered
      if (!rendered) continue
      const match = rendered.sourceFingerprint === utteranceFingerprint(u)
      if (rendered.status === 'ready' && !match) {
        this.storage.utteranceSetRendered(u.id, { ...rendered, status: 'stale' })
      } else if (rendered.status === 'stale' && match) {
        this.storage.utteranceSetRendered(u.id, { ...rendered, status: 'ready' })
      }
    }
    const script = this.script.getScript(program.scriptId)
    if (!script) return
    for (const scene of script.scenes) {
      const rendered = scene.rendered
      if (!rendered) continue
      const current = sceneFingerprint(narrativeOrder(all.filter((u) => u.sceneId === scene.id)))
      const match = rendered.sourceFingerprint === current
      if (rendered.status === 'ready' && !match) {
        this.script.setSceneRendered(script.id, scene.id, { ...rendered, status: 'stale' })
      } else if (rendered.status === 'stale' && match) {
        this.script.setSceneRendered(script.id, scene.id, { ...rendered, status: 'ready' })
      }
    }
  }

  /**
   * 删孤儿音频：音频文件按内容寻址（同文同参共享一份），只有底稿库和话术池都不再引用时才删。
   * 路径归一化后比较（库里可能存正斜杠，join 出来是反斜杠）。后台异步，删失败不影响删稿。
   */
  private deleteOrphanAudio(paths: (string | null | undefined)[]): void {
    const candidates = [...new Set(paths.filter((p): p is string => Boolean(p)))]
    if (candidates.length === 0) return
    const normalize = (value: string) => resolve(value).toLowerCase()
    // 剩下的底稿（全节目，内容寻址跨节目共享）+ 池里条目还在引用的文件不能删
    const referenced = new Set(
      [...this.storage.utteranceAllAudioPaths(), ...this.storage.speechReferencedAudioPaths()].map(normalize)
    )
    for (const path of candidates) {
      if (referenced.has(normalize(path))) continue
      void rm(path, { force: true })
        .then(() => console.log(`[话术库] 底稿删除，孤儿音频一并清掉：${path}`))
        .catch(() => undefined)
    }
  }

  /**
   * 批量预合成（docs/07 §4 ④）：把节目里 pending/failed 的条目合成就绪。
   * 一条 = 一整段连续讲述 = 一次合成——播放/合成/缓存单元对齐（桥段制）。
   * 逐条串行 + 限流间隔 + 退避重试（TTS 频率限制安全），onProgress 逐条回报。
   */
  async synthesizeAll(
    programId: string,
    onProgress?: (u: Utterance) => void,
    signal?: AbortSignal
  ): Promise<{ done: number; failed: number }> {
    const pending = this.storage
      .utteranceList(programId)
      .filter((u) => u.status === 'pending' || u.status === 'failed')
    // 合成用的音色与开播装载时的判定口径一致（人设默认音色，u.voiceId 可单条覆盖）
    const voiceOf = (u: Utterance) => this.persona.resolveProgramVoice(undefined, u.voiceId) ?? ''

    let done = 0
    let failed = 0
    // 合成队列节奏（config.tts）：间隔 0 = 跟随服务商默认（按官方限流文档配在 manifest 里）；瞬时错误退避重试
    const { synthRetries } = this.storage.getConfig().tts
    const pace = this.makePacer()
    for (const u of pending) {
      if (signal?.aborted) break
      const voice = voiceOf(u)
      this.storage.utteranceSetAudio(u.id, 'synthesizing', u.audioPath)
      onProgress?.({ ...u, status: 'synthesizing' })
      try {
        await pace(voice)
        const audioPath = await this.synthesizeWithRetry(u, voice, synthRetries, signal)
        this.storage.utteranceSetAudio(u.id, 'ready', audioPath, undefined, voice)
        onProgress?.({ ...u, status: 'ready', audioPath, synthVoice: voice })
        done++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.storage.utteranceSetAudio(u.id, 'failed', null, message.slice(0, 200))
        onProgress?.({ ...u, status: 'failed', error: message })
        failed++
      }
    }
    return { done, failed }
  }

  // ---------- 节目音频统一生产入口（docs/10 §7.5，P4） ----------

  /**
   * 统一生产入口（program:produce-audio / produce_program_audio 工具的后端）：
   * - rolling/improvised：等同「提前合成全部」，后台逐段合成（不是播放门禁），立即返回；
   * - prepared：按合成计划逐单元生产（同步跑完返回汇总；进度走 onEvent / onRenderedEvent）。
   */
  async produceProgramAudio(programId: string): Promise<ProduceAudioResult> {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) {
      return { ok: false, mode: 'prepared', total: 0, done: 0, failed: 0, skipped: 0, error: '节目不存在' }
    }
    if (program.broadcastMode !== 'prepared') {
      void this.kickSynthesis(programId)
      return {
        ok: true,
        mode: program.broadcastMode,
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        notice: '滚动节目：后台逐段提前合成全部文稿（这不是播放门禁，边播边合成也可以）'
      }
    }
    if (this.synthRunning.has(programId) || this.produceRunning.has(programId)) {
      return {
        ok: false,
        mode: 'prepared',
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        error: '这个节目已有合成任务在进行，等它跑完再发起'
      }
    }
    this.produceRunning.add(programId)
    this.synthRunning.add(programId)
    try {
      return await this.producePrepared(program)
    } finally {
      this.produceRunning.delete(programId)
      this.synthRunning.delete(programId)
      this.onBatchDone?.(programId)
    }
  }

  /** 生产前的合成计划摘要（Agent 确认卡 / UI 确认弹窗用）：范围、预计时长、将用的模型与声音快照 */
  describeProducePlan(programId: string): ProducePlanInfo {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    if (program.broadcastMode !== 'prepared') {
      return { ok: false, error: '只有预制节目需要生成节目音频；滚动节目用「提前合成全部」即可' }
    }
    const script = this.script.getScript(program.scriptId)
    const units = listAudioUnits(program, script, this.storage.utteranceList(program.id))
    if (units.length === 0) return { ok: false, error: '节目还没有文稿：先让主播写稿，再生成节目音频' }
    let frozen: FrozenSnapshot
    try {
      frozen = this.resolveFrozenSnapshot(program)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const segments = units.reduce((sum, unit) => sum + unit.utterances.length, 0)
    const totalChars = units.reduce(
      (sum, unit) => sum + unit.utterances.reduce((s, u) => s + u.text.length, 0),
      0
    )
    return {
      ok: true,
      units: units.length,
      scenes: units.filter((unit) => unit.kind === 'scene').length,
      segments,
      totalChars,
      estMinutes: Math.round((totalChars / CHARS_PER_SECOND / 60) * 10) / 10,
      modelDesc: frozen.modelDesc,
      voiceDesc: frozen.voiceDesc,
      notice: this.standardPathNotice(program, units)
    }
  }

  /**
   * 预制节目的全量生产：逐单元合成并写 rendered（含冻结快照与文稿指纹）。
   * 场景类单元 = 该章所有段逐段合成后 ffmpeg 拼接成整章音频挂 Scene.rendered；
   * 拼接失败降级为只保留段级 rendered，error 里说明。单段失败不中断整批。
   */
  private async producePrepared(program: Program): Promise<ProduceAudioResult> {
    const script = this.script.getScript(program.scriptId)
    const units = listAudioUnits(program, script, this.storage.utteranceList(program.id))
    const base: ProduceAudioResult = {
      ok: false,
      mode: 'prepared',
      total: units.length,
      done: 0,
      failed: 0,
      skipped: 0
    }
    if (units.length === 0) return { ...base, error: '节目还没有文稿：先让主播写稿，再生成节目音频' }
    let frozen: FrozenSnapshot
    try {
      frozen = this.resolveFrozenSnapshot(program)
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
    const notice = this.standardPathNotice(program, units)
    const { synthRetries } = this.storage.getConfig().tts
    const pace = this.makePacer()

    const writeUnitRendered = (unit: AudioUnit, rendered: RenderedAudioRef) => {
      if (unit.kind === 'scene' && script) this.script.setSceneRendered(script.id, unit.id, rendered)
      else this.storage.utteranceSetRendered(unit.id, rendered)
      this.onRenderedEvent?.(program.id)
    }

    for (const unit of units) {
      const existing = unit.rendered
      // 外部音频是用户给的成品，永不重合成（stale 了也由用户决定要不要换）
      if (existing?.external) {
        base.skipped++
        continue
      }
      // 已就绪且指纹一致、文件还在：跳过重合成
      if (
        existing?.status === 'ready' &&
        existing.sourceFingerprint === unit.fingerprint &&
        existsSync(existing.audioPath)
      ) {
        base.skipped++
        continue
      }
      const voices = unit.utterances.map((u) => frozen.voiceFor(u))
      const snapshot = frozen.snapshotFor(voices)
      const pending: RenderedAudioRef = {
        audioPath: '',
        status: 'synthesizing',
        ...snapshot,
        sourceFingerprint: unit.fingerprint
      }
      writeUnitRendered(unit, pending)
      try {
        if (unit.kind === 'utterance') {
          const u = unit.utterances[0]
          await pace(voices[0])
          const audioPath = await this.synthesizeWithRetry(u, voices[0], synthRetries)
          this.storage.utteranceSetAudio(u.id, 'ready', audioPath, undefined, voices[0])
          this.onEvent?.({ ...u, status: 'ready', audioPath, synthVoice: voices[0] })
          writeUnitRendered(unit, { ...pending, status: 'ready', audioPath })
        } else {
          const audioPath = await this.produceSceneUnit(unit, voices, snapshot, pace, synthRetries)
          writeUnitRendered(unit, { ...pending, status: 'ready', audioPath })
        }
        base.done++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeUnitRendered(unit, { ...pending, status: 'failed', error: message.slice(0, 200) })
        base.failed++
      }
      this.onRenderedEvent?.(program.id)
    }
    return { ...base, ok: base.failed === 0, notice }
  }

  /**
   * 场景级单元生产：该章段落逐段合成（段级 rendered 同步写上），全部就绪后 ffmpeg 拼成整章。
   * 拼接失败抛错前段级产物已落库——调用方把章级 rendered 记 failed 并说明降级。
   */
  private async produceSceneUnit(
    unit: AudioUnit,
    voices: string[],
    snapshot: SnapshotFields,
    pace: (voice: string) => Promise<void>,
    retries: number
  ): Promise<string> {
    const segmentPaths: string[] = []
    for (let i = 0; i < unit.utterances.length; i++) {
      const u = unit.utterances[i]
      const voice = voices[i]
      const segmentSnapshot = {
        ttsConnectionId: snapshot.ttsConnectionId,
        ttsModelId: snapshot.ttsModelId,
        voiceOrCastFingerprint: stableHash(voice)
      }
      // 段音频已有就绪产物（滚动预合成/上次生产）就直接复用
      if (u.status === 'ready' && u.audioPath && existsSync(u.audioPath)) {
        segmentPaths.push(u.audioPath)
        if (u.rendered?.status !== 'ready' || u.rendered.sourceFingerprint !== utteranceFingerprint(u)) {
          this.storage.utteranceSetRendered(u.id, {
            audioPath: u.audioPath,
            status: 'ready',
            ...segmentSnapshot,
            sourceFingerprint: utteranceFingerprint(u)
          })
        }
        continue
      }
      this.storage.utteranceSetAudio(u.id, 'synthesizing', u.audioPath)
      this.onEvent?.({ ...u, status: 'synthesizing' })
      try {
        await pace(voice)
        const audioPath = await this.synthesizeWithRetry(u, voice, retries)
        this.storage.utteranceSetAudio(u.id, 'ready', audioPath, undefined, voice)
        this.storage.utteranceSetRendered(u.id, {
          audioPath,
          status: 'ready',
          ...segmentSnapshot,
          sourceFingerprint: utteranceFingerprint(u)
        })
        this.onEvent?.({ ...u, status: 'ready', audioPath, synthVoice: voice })
        segmentPaths.push(audioPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.storage.utteranceSetAudio(u.id, 'failed', null, message.slice(0, 200))
        this.storage.utteranceSetRendered(u.id, {
          audioPath: '',
          status: 'failed',
          ...segmentSnapshot,
          sourceFingerprint: utteranceFingerprint(u),
          error: message.slice(0, 200)
        })
        this.onEvent?.({ ...u, status: 'failed', error: message })
        throw error
      }
    }
    try {
      return await this.concatAudioFiles(
        segmentPaths,
        join(this.programAudioDir(), `scene-${unit.id}-${unit.fingerprint}.mp3`)
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`整章拼接失败：${message}（各段音频已就绪，可逐段试听）`)
    }
  }

  /**
   * 冻结声音快照（§9.6）：开始预制合成时把节目 audioConfig 解析成具体接入/模型/音色，
   * 连同音色（或角色表）指纹一起写进每个单元的 rendered；之后切换主播/改主播音色不改写已有产物。
   */
  private resolveFrozenSnapshot(program: Program): FrozenSnapshot {
    const cfg = program.audioConfig
    if (cfg.mode === 'custom') {
      const connectionId = cfg.ttsConnectionId?.trim() ?? ''
      const modelId = cfg.ttsModelId?.trim() ?? ''
      if (!connectionId || !modelId) {
        throw new Error('自定义节目声音还没选合成接入和模型：到节目设置里选「合成模型」')
      }
      const connection = this.storage.ttsConnectionGet(connectionId)
      if (!connection) throw new Error('节目声音配置里的合成接入已被删除：到节目设置里重选')
      const spec = ttsModelSpec(connection.providerId, modelId)
      if (!spec) throw new Error(`模型 ${modelId} 不在目录里：到节目设置里重选合成模型`)
      const blocker = ttsModelBlocker(connection, getTtsProvider(connection.providerId), modelId)
      if (blocker) throw new Error(`合成模型现在用不了：${blocker}（接入「${connection.name}」）`)
      // capability 钩子（§7.5，P6 接 longform/podcast 适配器后在此分流）：
      // manifest 未声明长文/播客能力的模型，预制一律走 standard 逐段（+整章拼接）路线
      const cast = (cfg.cast ?? []).filter((member) => member.voiceId.trim())
      const castFingerprint = stableHash(JSON.stringify(cast))
      return {
        voiceFor: (u) => {
          const voice = u.voiceId.trim() || cast[0]?.voiceId.trim() || ''
          if (!voice) throw new Error('自定义节目声音还没配角色音色：到节目设置里配声音安排')
          return voice
        },
        snapshotFor: () => ({
          ttsConnectionId: connection.id,
          ttsModelId: spec.id,
          voiceOrCastFingerprint: castFingerprint
        }),
        modelDesc: `${connection.name} / ${spec.label}`,
        voiceDesc:
          cast.length > 0
            ? cast.map((member) => `${member.roleName}→${member.voiceId}`).join('、')
            : '按段落指定音色'
      }
    }
    // 跟随当前主播：快照取当前主播音色路由出的接入/模型（只用于填充快照，不形成永久绑定）
    const persona = this.persona.get()
    return {
      voiceFor: (u) => {
        const voice = this.persona.resolveProgramVoice(undefined, u.voiceId)
        if (!voice) throw new Error('文稿没有可用音色：当前主播没选音色，段落也没单独指定')
        return voice
      },
      snapshotFor: (voices) => {
        const route = this.tts.routeForVoice(voices[0])
        return {
          ttsConnectionId: route.connection.id,
          ttsModelId: route.modelId,
          voiceOrCastFingerprint: stableHash([...new Set(voices)].sort().join(','))
        }
      },
      modelDesc: `跟随当前主播（「${persona.name}」音色路由）`,
      voiceDesc: persona.voiceId ? `当前主播「${persona.name}」的音色 ${persona.voiceId}` : '当前主播还没选音色'
    }
  }

  /** 分段路线的提示文案（§7.3/§15.10）：不承诺原生长文模型的连续表演效果 */
  private standardPathNotice(program: Program, units: AudioUnit[]): string | undefined {
    if (program.contentType === 'solo') return undefined
    if (!units.some((unit) => unit.kind === 'scene')) return undefined
    return '分段合成并拼接成整章：不承诺原生长文/播客模型的连续表演效果'
  }

  /** 预制音频目录（userData/program-audio）：整章拼接产物与导入的外部音频放这里——不进 audio-cache 的 LRU 清扫 */
  private programAudioDir(): string {
    const dir = join(app.getPath('userData'), 'program-audio')
    void mkdir(dir, { recursive: true }).catch(() => undefined)
    return dir
  }

  /** ffmpeg 拼接（concat demuxer + 统一转 mp3）：段文件格式可能混着 mp3/wav，重编码保证拼得出 */
  private async concatAudioFiles(files: string[], outPath: string): Promise<string> {
    const listPath = join(
      this.programAudioDir(),
      `concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    )
    const content = files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
    await writeFile(listPath, content, 'utf8')
    try {
      const result = await new Promise<{ code: number; stderr: string }>((resolvePromise) => {
        const proc = spawn(
          getFfmpegPath(),
          ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-q:a', '4', outPath],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )
        let stderr = ''
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        proc.on('error', (error) => resolvePromise({ code: -1, stderr: String(error) }))
        proc.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }))
      })
      if (result.code !== 0 || !existsSync(outPath)) {
        throw new Error(result.stderr.trim().split('\n').filter(Boolean)[0] || `ffmpeg 退出码 ${result.code}`)
      }
      return outPath
    } finally {
      await rm(listPath, { force: true }).catch(() => undefined)
    }
  }

  /**
   * 导入外部音频（§7.4，program:import-audio 的后端）：拷贝进预制音频目录，
   * 挂到指定 Scene/Utterance 的 rendered（status='ready'、external=true、快照字段记 'external'、
   * 指纹取当前文稿指纹）。外部音频不参与重新合成。
   */
  async importExternalAudio(
    programId: string,
    target: { kind: 'scene' | 'utterance'; id: string },
    sourcePath: string
  ): Promise<{ ok: true; audioPath: string } | { ok: false; error: string }> {
    try {
      const program = this.storage.programList().find((p) => p.id === programId) ?? null
      if (!program) return { ok: false, error: '节目不存在' }
      const ext = extname(sourcePath).toLowerCase()
      if (!IMPORT_AUDIO_EXTS.has(ext)) return { ok: false, error: '只支持 mp3 / wav / m4a 音频文件' }
      if (!existsSync(sourcePath)) return { ok: false, error: '文件不存在（可能已被移动）' }

      const all = this.storage.utteranceList(programId)
      let fingerprint: string
      if (target.kind === 'scene') {
        const script = this.script.getScript(program.scriptId)
        const scene = script?.scenes.find((s) => s.id === target.id)
        if (!script || !scene) return { ok: false, error: '场景不存在（节目没绑剧本或场景已删）' }
        fingerprint = sceneFingerprint(narrativeOrder(all.filter((u) => u.sceneId === scene.id)))
      } else {
        const utterance = all.find((u) => u.id === target.id)
        if (!utterance) return { ok: false, error: '文稿段落不存在（可能已删）' }
        fingerprint = utteranceFingerprint(utterance)
      }

      const safeName = basename(sourcePath, ext).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'audio'
      const audioPath = join(this.programAudioDir(), `import-${Date.now()}-${safeName}${ext}`)
      await copyFile(sourcePath, audioPath)
      const rendered: RenderedAudioRef = {
        audioPath,
        status: 'ready',
        ttsConnectionId: 'external',
        ttsModelId: 'external',
        voiceOrCastFingerprint: 'external',
        sourceFingerprint: fingerprint,
        external: true
      }
      if (target.kind === 'scene') {
        this.script.setSceneRendered(this.script.getScript(program.scriptId)!.id, target.id, rendered)
      } else {
        this.storage.utteranceSetRendered(target.id, rendered)
        const updated = this.storage.utteranceGet(target.id)
        if (updated) this.onEvent?.(updated)
      }
      this.onRenderedEvent?.(programId)
      console.log(`[话术库] 外部音频已导入：${sourcePath} → ${audioPath}（${target.kind} ${target.id}）`)
      return { ok: true, audioPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 合成队列节奏：间隔 0 = 跟随服务商默认（manifest 的官方限流档） */
  private makePacer(): (voice: string) => Promise<void> {
    const { synthIntervalMs } = this.storage.getConfig().tts
    let lastRequestAt = 0
    return async (voice: string) => {
      const interval = synthIntervalMs > 0 ? synthIntervalMs : this.tts.synthIntervalFor(voice || undefined)
      const waitMs = interval - (Date.now() - lastRequestAt)
      if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs))
      lastRequestAt = Date.now()
    }
  }

  /**
   * 带退避重试的单条合成：瞬时错误（网络抖动/限流 429/5xx）按 2s/4s 退避重来；
   * 鉴权与参数类硬错误（401/403/invalid）重试也没意义，一次就抛；中止信号立即抛。
   */
  private async synthesizeWithRetry(
    u: Utterance,
    voice: string,
    retries: number,
    signal?: AbortSignal
  ): Promise<string> {
    const hardError = (message: string) => /401|403|鉴权|凭据|invalid|unauthorized|forbidden/i.test(message)
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new Error('已中止')
      if (attempt > 0) {
        console.warn(`[话术库] 合成重试（${u.id} 第 ${attempt} 次）`)
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
      }
      try {
        // delivery（agent 写的表演指示）+ 语速/音调随这次合成发出去——演法真正落到声音上
        return await this.tts.synthesize(`utterance-${u.id}`, u.text, voice || undefined, signal, {
          instruction: u.delivery || undefined,
          rate: u.rate,
          pitch: u.pitch
        })
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (signal?.aborted || hardError(message) || attempt === retries) break
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

/** 冻结快照（一次预制生产的声音安排）：逐段取音色 + 单元级快照字段 + 确认卡展示文案 */
type SnapshotFields = Pick<RenderedAudioRef, 'ttsConnectionId' | 'ttsModelId' | 'voiceOrCastFingerprint'>

interface FrozenSnapshot {
  /** 这条文稿用哪个音色（没有就抛中文原因，不带兜底） */
  voiceFor: (u: Utterance) => string
  /** 单元级快照字段：接入/模型/音色或角色表指纹 */
  snapshotFor: (voices: string[]) => SnapshotFields
  modelDesc: string
  voiceDesc: string
}
