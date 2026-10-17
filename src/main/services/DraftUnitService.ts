import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import type {
  ProduceAudioResult,
  ProducePlanInfo,
  ProduceVoiceOverride,
  Program,
  RenderedAudioRef,
  DraftUnit,
  DraftUnitInput
} from '../../shared/types'
import { stableHash, programStyleSalt, utteranceFingerprint, sceneFingerprint } from '../../shared/fingerprint'
import { buildPodcastTurns } from '../../shared/podcast'
import { findCloneVoice, parseManualVoice } from '../../shared/voiceProvider'
import type { StorageService } from './StorageService'
import type { BlobStoreService } from './BlobStoreService'
import type { TtsService } from './TtsService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import { findTtsCatalogVoice, getTtsProvider, ttsModelBlocker, ttsModelCapabilities, ttsModelSpec } from './providers/registry'
import { getFfmpegPath } from './stream/ffmpeg/bin'
import { listAudioUnits, narrativeOrder, type AudioUnit } from './programUnits'

/** 外部音频允许导入的格式（与克隆样本的交集一致） */
const IMPORT_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a'])

/** 粗估时长：中文 TTS 约 4.5 字/秒（确认卡的「预计时长」用，不是承诺） */
const CHARS_PER_SECOND = 4.5

/**
 * 节目话术库（docs/07 §3 draftUnits）+ 节目音频统一生产入口（docs/10 §7.5）。
 * 与运行态 speech_items 分工：开播时按轮播规则从这里取件入池；
 * 直播中的改写不回写底稿（复盘采纳才回写，source='adopted'）。
 *
 * P4 起这里同时是 capability 驱动的节目音频生产入口：
 * - rolling：行为同原 synthesizeAll（逐段提前合成，非门禁）；
 * - prepared：按内容类型划分合成单元（场景类节目=每章一个单元，solo=每段一个单元），
 *   合成路线由模型 capability 决定（docs/10 §7.6）：
 *   standard → 逐段合成后整章用 ffmpeg 拼接挂 Scene.rendered，段级产物挂 DraftUnit.rendered；
 *   podcast  → 该单元文稿组装成双人轮次稿，一次合成整章/整期双人音频挂 Scene.rendered；
 *   开始时把卡司声音冻结成快照写进产物（§9.6），换卡司不改写已有音频。
 * standard 路线文案只承诺「分段合成并拼接」，不承诺连续表演效果（§15.10）；
 * podcast 路线失败显式报错，绝不无提示降级回 standard（§15.9）。
 */
export class DraftUnitService {
  /** 底稿变更（写/改/删/清空，含 agent 路径）：index.ts 接上 → 广播 { scope:'drafts', programId } */
  onDraftChanged: ((programId: string) => void) | null = null

  /** 单条状态变化广播（index.ts 接 broadcastUtterance；预合成与底稿改后重合成共用） */
  onEvent: ((u: DraftUnit) => void) | null = null
  /** 一批合成结束广播（id='' 的特殊事件，UI 整体刷新） */
  onBatchDone: ((programId: string) => void) | null = null
  /** 预制音频资产变化广播（Scene.rendered / DraftUnit.rendered 更新；渲染层刷新节目音频进度） */
  onRenderedEvent: ((programId: string) => void) | null = null
  /** 正在后台合成的节目（重入转 dirty，跑完补一轮） */
  private readonly synthRunning = new Set<string>()
  private readonly synthDirty = new Set<string>()
  /** 最近一次后台合成带的声音覆盖（dirty 补跑沿用最后一次的选择） */
  private readonly synthOverride = new Map<string, ProduceVoiceOverride | undefined>()
  /** 正在预制生产的节目（与滚动合成共用一把锁，防两条流水线踩同一份文稿） */
  private readonly produceRunning = new Set<string>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly persona: PersonaService,
    private readonly script: ScriptService,
    private readonly blobs: BlobStoreService
  ) {}

  /**
   * 后台把节目里 pending/failed 的条目合成就绪（带节目锁）：
   * 预合成按钮、主播改/补底稿后的重合成都走这里。同时在跑就标 dirty，本轮结束自动补跑一轮。
   * voiceOverride：声音选择弹窗里用户显式选的声音（docs/REDESIGN 4.4），空 = 卡司第一张/段落指定。
   */
  async kickSynthesis(programId: string, voiceOverride?: ProduceVoiceOverride): Promise<void> {
    this.synthOverride.set(programId, voiceOverride)
    if (this.synthRunning.has(programId)) {
      this.synthDirty.add(programId)
      return
    }
    this.synthRunning.add(programId)
    try {
      do {
        this.synthDirty.delete(programId)
        try {
          await this.synthesizeAll(programId, (u) => this.onEvent?.(u), undefined, this.synthOverride.get(programId))
        } catch (error) {
          console.warn(`[话术库] 后台合成中断：${error instanceof Error ? error.message : String(error)}`)
        }
      } while (this.synthDirty.has(programId))
    } finally {
      this.synthRunning.delete(programId)
      this.synthOverride.delete(programId)
      this.onBatchDone?.(programId)
    }
  }

  list(programId: string): DraftUnit[] {
    return this.storage.draftUnitList(programId)
  }

  /** 生成 Agent 的 write_bits 工具走这里：一次写一场景的一批桥段 */
  saveMany(
    programId: string,
    sceneId: string,
    items: { text: string; bitType?: string; delivery?: string; rate?: number; pitch?: number; pauseAfterMs?: number; presenterId?: string; voiceId?: string; sources?: DraftUnit['sources'] }[]
  ): DraftUnit[] {
    const existing = this.storage.draftUnitList(programId).filter((u) => u.sceneId === sceneId)
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
          pauseAfterMs: item.pauseAfterMs,
          presenterId: item.presenterId?.trim() || undefined,
          voiceId: item.voiceId?.trim() ?? '',
          source: 'initial',
          sources: item.sources ?? []
        })
      )
    this.refreshRenderedStaleness(programId)
    return saved
  }

  /** 新建/编辑。文本变了则作废旧音频（待重新预合成）；预制资产走 stale 检测（指纹不一致置 stale，不删文件）。 */
  save(input: DraftUnitInput, id?: string): DraftUnit {
    if (!input.text.trim()) throw new Error('话术文本不能为空')
    const existing = id
      ? (this.storage.draftUnitList(input.programId).find((u) => u.id === id) ?? null)
      : null
    const textChanged = existing !== null && existing.text !== input.text.trim()
    const utterance: DraftUnit = {
      id: id ?? `ut-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      programId: input.programId,
      sceneId: input.sceneId,
      variantIdx: input.variantIdx,
      // 创作序号：编辑保留原序号；新增自动排到场景末尾（装池按它恢复叙事顺序）
      seq: input.seq ?? existing?.seq ?? this.storage.draftUnitNextSeq(input.programId, input.sceneId),
      text: input.text.trim(),
      bitType: input.bitType?.trim() ?? existing?.bitType ?? '',
      delivery: input.delivery?.trim() ?? existing?.delivery ?? '',
      rate: input.rate ?? existing?.rate,
      pitch: input.pitch ?? existing?.pitch,
      pauseAfterMs: input.pauseAfterMs ?? existing?.pauseAfterMs,
      presenterId: input.presenterId?.trim() || existing?.presenterId,
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
    this.storage.draftUnitSave(utterance)
    this.refreshRenderedStaleness(input.programId)
    this.onDraftChanged?.(input.programId)
    return utterance
  }

  remove(id: string): void {
    const existing = this.storage.draftUnitGet(id)
    this.storage.draftUnitDelete(id)
    this.deleteOrphanAudio([existing?.audioPath])
    if (existing) {
      this.refreshRenderedStaleness(existing.programId)
      this.onDraftChanged?.(existing.programId)
    }
  }

  /** 清空节目话术库（重生成前）；给 sceneId 只清某场景。连缓存音频一起清（不被别处引用的才删） */
  clear(programId: string, sceneId?: string): void {
    const doomed = this.storage
      .draftUnitList(programId)
      .filter((u) => sceneId === undefined || u.sceneId === sceneId)
      .map((u) => u.audioPath)
    this.storage.draftUnitDeleteWhere(programId, sceneId)
    this.deleteOrphanAudio(doomed)
    this.refreshRenderedStaleness(programId)
    this.onDraftChanged?.(programId)
  }

  /**
   * 清空已合成音频（文稿一个字不动）：滚动段回 pending 待重合成，预制资产摘除引用。
   * 换音色/换演法语法后想全部重蒸时用。外部导入的音频是用户自己的素材，不动。
   * 池里正在播的条目不受影响：文件仍被池引用的不会删，播完自然淘汰。
   * 返回清掉的音频段数（滚动段 + 预制单元）。
   */
  clearAudio(programId: string): number {
    const doomed: (string | null | undefined)[] = []
    let cleared = 0
    for (const u of this.storage.draftUnitList(programId)) {
      if (u.audioPath || u.status !== 'pending') {
        doomed.push(u.audioPath)
        this.storage.draftUnitSetAudio(u.id, 'pending', null, undefined, '')
        this.onEvent?.({ ...u, status: 'pending', audioPath: null, error: undefined, synthVoice: '' })
        if (u.audioPath) cleared++
      }
      if (u.rendered && !u.rendered.external) {
        doomed.push(u.rendered.audioPath)
        this.storage.draftUnitSetRendered(u.id, null)
        cleared++
      }
    }
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    const script = program ? this.script.getScript(program.scriptId) : null
    for (const scene of script?.scenes ?? []) {
      if (scene.rendered && !scene.rendered.external) {
        doomed.push(scene.rendered.audioPath)
        this.script.setSceneRendered(script!.id, scene.id, null)
        cleared++
      }
    }
    this.deleteOrphanAudio(doomed)
    this.onRenderedEvent?.(programId)
    return cleared
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
    const styleSalt = programStyleSalt(program)
    const all = this.storage.draftUnitList(programId)
    for (const u of all) {
      const rendered = u.rendered
      if (!rendered) continue
      const match = rendered.sourceFingerprint === utteranceFingerprint(u, styleSalt)
      if (rendered.status === 'ready' && !match) {
        this.storage.draftUnitSetRendered(u.id, { ...rendered, status: 'stale' })
      } else if (rendered.status === 'stale' && match) {
        this.storage.draftUnitSetRendered(u.id, { ...rendered, status: 'ready' })
      }
    }
    const script = this.script.getScript(program.scriptId)
    if (!script) return
    for (const scene of script.scenes) {
      const rendered = scene.rendered
      if (!rendered) continue
      const current = sceneFingerprint(narrativeOrder(all.filter((u) => u.sceneId === scene.id)), styleSalt)
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
      [...this.storage.draftUnitAllAudioPaths(), ...this.storage.poolItemReferencedAudioPaths()].map(normalize)
    )
    for (const path of candidates) {
      // blob 路径由引用钩子（行删除时已解除登记）+ 宽限期 GC 管，这里不直接删文件
      if (this.blobs.isBlobPath(path)) continue
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
    onProgress?: (u: DraftUnit) => void,
    signal?: AbortSignal,
    voiceOverride?: ProduceVoiceOverride
  ): Promise<{ done: number; failed: number }> {
    const pending = this.storage
      .draftUnitList(programId)
      .filter((u) => u.status === 'pending' || u.status === 'failed')
    // 合成用的音色：弹窗显式选的声音 > 段落指定的卡（presenterId）> 段落音色快照 > 目标节目的卡司第一张
    const explicit = voiceOverride?.voiceId?.trim() ?? ''
    const voiceOf = (u: DraftUnit) => {
      if (explicit) return explicit
      const byPresenter = u.presenterId
        ? (this.persona.list().find((p) => p.id === u.presenterId)?.voiceId.trim() ?? '')
        : ''
      return byPresenter || u.voiceId.trim() || this.persona.castVoiceOf(programId) || ''
    }

    let done = 0
    let failed = 0
    // 合成队列节奏（config.tts）：间隔 0 = 跟随服务商默认（按官方限流文档配在 manifest 里）；瞬时错误退避重试
    const { synthRetries } = this.storage.getConfig().tts
    const pace = this.makePacer()
    for (const u of pending) {
      if (signal?.aborted) break
      const voice = voiceOf(u)
      this.storage.draftUnitSetAudio(u.id, 'synthesizing', u.audioPath)
      onProgress?.({ ...u, status: 'synthesizing' })
      try {
        await pace(voice)
        const audioPath = await this.synthesizeWithRetry(u, voice, synthRetries, signal)
        this.storage.draftUnitSetAudio(u.id, 'ready', audioPath, undefined, voice)
        onProgress?.({ ...u, status: 'ready', audioPath, synthVoice: voice })
        done++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.storage.draftUnitSetAudio(u.id, 'failed', null, message.slice(0, 200))
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
   * voiceOverride：声音选择弹窗（docs/REDESIGN 4.4）里用户显式选的声音，本次合成冻结它，不改节目配置。
   */
  async produceProgramAudio(programId: string, voiceOverride?: ProduceVoiceOverride): Promise<ProduceAudioResult> {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) {
      return { ok: false, mode: 'prepared', total: 0, done: 0, failed: 0, skipped: 0, error: '节目不存在' }
    }
    if (program.broadcastMode !== 'prepared') {
      void this.kickSynthesis(programId, voiceOverride)
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
      return await this.producePrepared(program, voiceOverride)
    } finally {
      this.produceRunning.delete(programId)
      this.synthRunning.delete(programId)
      this.onBatchDone?.(programId)
    }
  }

  /**
   * 生产前的合成计划摘要（声音选择弹窗 / Agent 确认卡用）：
   * 范围、就绪与待合成计数、粗估时长、默认将用的模型与声音描述（弹窗里选「其他」会覆盖，见 ProduceVoiceOverride）。
   */
  describeProducePlan(programId: string): ProducePlanInfo {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    // 滚动/即兴：提前合成的计划 = 库里待合成段数 + 卡司第一张的声音描述
    if (program.broadcastMode !== 'prepared') {
      const all = this.storage.draftUnitList(program.id)
      if (all.length === 0) return { ok: false, error: '节目还没有文稿：先写稿，再提前合成' }
      const pending = all.filter((u) => u.status === 'pending' || u.status === 'failed')
      const ready = all.filter((u) => u.status === 'ready').length
      const totalChars = pending.reduce((sum, u) => sum + u.text.length, 0)
      const cast = this.persona.programCast()
      const first = cast[0]
      const voice = this.persona.castVoice()
      return {
        ok: true,
        segments: all.length,
        readyCount: ready,
        pendingSegments: pending.length,
        totalChars,
        estMinutes: Math.round((totalChars / CHARS_PER_SECOND / 60) * 10) / 10,
        modelDesc: '跟随节目卡司（卡司第一张的音色路由）',
        voiceDesc: voice
          ? `卡司第一张「${first?.name ?? '—'}」的音色：${this.voiceDisplayName(voice)}`
          : '卡司里的主播卡都还没选音色'
      }
    }
    const script = this.script.getScript(program.scriptId)
    const units = listAudioUnits(program, script, this.storage.draftUnitList(program.id))
    if (units.length === 0) return { ok: false, error: '节目还没有文稿：先让主播写稿，再生成节目音频' }
    let frozen: FrozenSnapshot
    try {
      frozen = this.resolveFrozenSnapshot(program)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const segments = units.reduce((sum, unit) => sum + unit.draftUnits.length, 0)
    // 已就绪且指纹一致、文件还在的单元本次会跳过：待合成段数/字数只算剩下的
    const pendingUnits = units.filter(
      (unit) =>
        !(
          unit.rendered?.status === 'ready' &&
          unit.rendered.sourceFingerprint === unit.fingerprint &&
          existsSync(unit.rendered.audioPath)
        )
    )
    const totalChars = pendingUnits.reduce(
      (sum, unit) => sum + unit.draftUnits.reduce((s, u) => s + u.text.length, 0),
      0
    )
    // 能力校验（§6.4）：双人播客模型拒绝三人以上内容，确认卡之前就把错报出来
    if (frozen.podcast) {
      const issue = this.podcastContentIssue(units, frozen.podcast)
      if (issue) return { ok: false, error: issue }
    }
    return {
      ok: true,
      units: units.length,
      scenes: units.filter((unit) => unit.kind === 'scene').length,
      segments,
      readyCount: units.length - pendingUnits.length,
      pendingSegments: pendingUnits.reduce((sum, unit) => sum + unit.draftUnits.length, 0),
      totalChars,
      estMinutes: Math.round((totalChars / CHARS_PER_SECOND / 60) * 10) / 10,
      modelDesc: frozen.modelDesc,
      voiceDesc: frozen.voiceDesc,
      notice: frozen.podcast ? undefined : this.standardPathNotice(program, units)
    }
  }

  /**
   * 预制节目的全量生产：逐单元合成并写 rendered（含冻结快照与文稿指纹）。
   * 场景类单元 = 该章所有段逐段合成后 ffmpeg 拼接成整章音频挂 Scene.rendered；
   * 拼接失败降级为只保留段级 rendered，error 里说明。单段失败不中断整批。
   */
  private async producePrepared(program: Program, voiceOverride?: ProduceVoiceOverride): Promise<ProduceAudioResult> {
    const script = this.script.getScript(program.scriptId)
    const units = listAudioUnits(program, script, this.storage.draftUnitList(program.id))
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
      frozen = this.resolveFrozenSnapshot(program, voiceOverride)
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
    // podcast 路线（§7.6）：单元文稿 → 双人轮次稿 → 一次合成整章/整期音频；失败显式报错不降级（§15.9）
    if (frozen.podcast) {
      const issue = this.podcastContentIssue(units, frozen.podcast)
      if (issue) return { ...base, error: issue }
      return this.producePreparedPodcast(program, units, frozen.podcast, base)
    }
    const notice = this.standardPathNotice(program, units)
    const { synthRetries } = this.storage.getConfig().tts
    const pace = this.makePacer()

    const writeUnitRendered = (unit: AudioUnit, rendered: RenderedAudioRef) => {
      if (unit.kind === 'scene' && script) this.script.setSceneRendered(script.id, unit.id, rendered)
      else this.storage.draftUnitSetRendered(unit.id, rendered)
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
      const voices = unit.draftUnits.map((u) => frozen.voiceFor(u))
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
          const u = unit.draftUnits[0]
          await pace(voices[0])
          const audioPath = await this.synthesizeWithRetry(u, voices[0], synthRetries)
          this.storage.draftUnitSetAudio(u.id, 'ready', audioPath, undefined, voices[0])
          this.onEvent?.({ ...u, status: 'ready', audioPath, synthVoice: voices[0] })
          writeUnitRendered(unit, { ...pending, status: 'ready', audioPath })
        } else {
          const audioPath = await this.produceSceneUnit(unit, voices, snapshot, pace, synthRetries, programStyleSalt(program))
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
   * podcast 路线的单元生产：把单元内文稿（场景 = 整章段落，段 = 单条）组装成双人轮次稿，
   * 调统一入口一次合成整期双人音频，产物复制进预制音频目录挂 rendered（含冻结快照与指纹）。
   * 单单元失败不中断整批；失败原因（审核/配额/中断）原样写进 rendered.error，不做任何降级。
   */
  private async producePreparedPodcast(
    program: Program,
    units: AudioUnit[],
    route: PodcastRouteInfo,
    base: ProduceAudioResult
  ): Promise<ProduceAudioResult> {
    const script = this.script.getScript(program.scriptId)
    const writeUnitRendered = (unit: AudioUnit, rendered: RenderedAudioRef) => {
      if (unit.kind === 'scene' && script) this.script.setSceneRendered(script.id, unit.id, rendered)
      else this.storage.draftUnitSetRendered(unit.id, rendered)
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
      const turns = buildPodcastTurns(
        unit.draftUnits.map((u) => ({
          voiceId: (u.presenterId ? this.persona.list().find((p) => p.id === u.presenterId)?.voiceId.trim() : '') || u.voiceId,
          text: u.text
        })),
        route.castVoices,
        route.speakers,
        route.maxCharsPerTurn
      )
      if (!turns || turns.length === 0) {
        writeUnitRendered(unit, {
          audioPath: '',
          status: 'failed',
          ttsConnectionId: route.connectionId,
          ttsModelId: route.modelId,
          voiceOrCastFingerprint: route.castFingerprint,
          sourceFingerprint: unit.fingerprint,
          error: '这一章没有可合成的文稿'
        })
        base.failed++
        continue
      }
      const pending: RenderedAudioRef = {
        audioPath: '',
        status: 'synthesizing',
        ttsConnectionId: route.connectionId,
        ttsModelId: route.modelId,
        voiceOrCastFingerprint: route.castFingerprint,
        sourceFingerprint: unit.fingerprint
      }
      writeUnitRendered(unit, pending)
      try {
        const result = await this.tts.synthesizeRequest(
          `podcast-${unit.id}`,
          {
            type: 'podcast',
            turns,
            speakers: route.speakers,
            useHeadMusic: route.useHeadMusic,
            useTailMusic: route.useTailMusic
          },
          { connectionId: route.connectionId, modelId: route.modelId },
          undefined,
          program.id
        )
        // 产物已是 blob（播客合成走 BlobStore 缓存）：直接挂 rendered，引用钩子随 writeUnitRendered 登记，不再复制一份
        writeUnitRendered(unit, { ...pending, status: 'ready', audioPath: result.audioPath, durationMs: result.durationMs })
        base.done++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeUnitRendered(unit, { ...pending, status: 'failed', error: message.slice(0, 200) })
        base.failed++
      }
      this.onRenderedEvent?.(program.id)
    }
    return { ...base, ok: base.failed === 0 }
  }

  /**
   * 能力校验（§6.4）：双人播客模型 maxSpeakers=2——文稿里出现两个主持人以外的音色就是
   * 三人以上内容，produce 前明确拒绝（不合成、不降级）。返回 null = 通过。
   */
  private podcastContentIssue(units: AudioUnit[], route: PodcastRouteInfo): string | null {
    const known = new Set([...route.castVoices, ...route.speakers])
    for (const unit of units) {
      for (const u of unit.draftUnits) {
        const cardVoice = u.presenterId
          ? (this.persona.list().find((p) => p.id === u.presenterId)?.voiceId ?? '').trim()
          : ''
        const voice = cardVoice || u.voiceId.trim()
        if (voice && !known.has(voice)) {
          return (
            `「${unit.title}」里有第三个音色（${voice}）：Podcast 双人播客模型只支持两个主持人。` +
            `把这段的音色改成主持人 A/B 之一（或清空按交替分配），或换一个支持多角色的模型`
          )
        }
      }
    }
    return null
  }

  /** 播客发音人解析：cast 里的音色输入 → 发给火山的 speaker id（克隆音色用训练产物 speaker_id；手动复合串取音色段） */
  private resolvePodcastSpeaker(voiceId: string): string {
    const voice = voiceId.trim()
    const clone = findCloneVoice(this.storage.listVoices(), voice)
    if (clone?.voiceType.trim()) return clone.voiceType.trim()
    const manual = parseManualVoice(voice)
    if (manual) return manual.voice
    return voice
  }

  /** 音色的人读名字（确认卡/弹窗展示用）：音色库克隆音色显示名字；手动复合串显示截断 ID；目录音色查目录名 */
  private voiceDisplayName(voiceId: string): string {
    const id = voiceId.trim()
    if (!id) return ''
    const clone = findCloneVoice(this.storage.listVoices(), id)
    if (clone) return clone.name
    const manual = parseManualVoice(id)
    if (manual) return `手动 ID · ${manual.voice.length > 12 ? `${manual.voice.slice(0, 12)}…` : manual.voice}`
    for (const hit of findTtsCatalogVoice(id)) {
      for (const group of hit.model.voices) {
        const found = group.voices.find((voice) => voice.id === id)
        if (found) return found.name
      }
    }
    return id
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
    retries: number,
    styleSalt = ''
  ): Promise<string> {
    const segmentPaths: string[] = []
    for (let i = 0; i < unit.draftUnits.length; i++) {
      const u = unit.draftUnits[i]
      const voice = voices[i]
      const segmentSnapshot = {
        ttsConnectionId: snapshot.ttsConnectionId,
        ttsModelId: snapshot.ttsModelId,
        voiceOrCastFingerprint: stableHash(this.voiceStyleSalt([voice]))
      }
      // 段音频已有就绪产物（滚动预合成/上次生产）且**演法指纹一致**才复用：
      // 只改 delivery/rate/pitch 而不改文本时，旧音频必须重合成，否则新演法永远不生效
      const segmentFresh =
        u.rendered?.status === 'ready' && u.rendered.sourceFingerprint === utteranceFingerprint(u, styleSalt)
      if (segmentFresh && u.status === 'ready' && u.audioPath && existsSync(u.audioPath)) {
        segmentPaths.push(u.audioPath)
        if (u.rendered?.status !== 'ready' || u.rendered.sourceFingerprint !== utteranceFingerprint(u, styleSalt)) {
          this.storage.draftUnitSetRendered(u.id, {
            audioPath: u.audioPath,
            status: 'ready',
            ...segmentSnapshot,
            sourceFingerprint: utteranceFingerprint(u, styleSalt)
          })
        }
        continue
      }
      this.storage.draftUnitSetAudio(u.id, 'synthesizing', u.audioPath)
      this.onEvent?.({ ...u, status: 'synthesizing' })
      try {
        await pace(voice)
        const audioPath = await this.synthesizeWithRetry(u, voice, retries)
        this.storage.draftUnitSetAudio(u.id, 'ready', audioPath, undefined, voice)
        this.storage.draftUnitSetRendered(u.id, {
          audioPath,
          status: 'ready',
          ...segmentSnapshot,
          sourceFingerprint: utteranceFingerprint(u, styleSalt)
        })
        this.onEvent?.({ ...u, status: 'ready', audioPath, synthVoice: voice })
        segmentPaths.push(audioPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.storage.draftUnitSetAudio(u.id, 'failed', null, message.slice(0, 200))
        this.storage.draftUnitSetRendered(u.id, {
          audioPath: '',
          status: 'failed',
          ...segmentSnapshot,
          sourceFingerprint: utteranceFingerprint(u, styleSalt),
          error: message.slice(0, 200)
        })
        this.onEvent?.({ ...u, status: 'failed', error: message })
        throw error
      }
    }
    try {
      // 整章拼接：产物落暂存区 → 入 BlobStore（同内容去重；引用随 writeUnitRendered 的钩子登记）
      const staged = this.blobs.tmpPath(`scene-${unit.id}-${unit.fingerprint}.mp3`)
      const concatPath = await this.concatAudioFiles(segmentPaths, staged)
      const put = await this.blobs.putFile(concatPath, 'mp3')
      return put.path
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`整章拼接失败：${message}（各段音频已就绪，可逐段试听）`)
    }
  }

  /**
   * 冻结声音快照（§9.6）：开始预制合成时把弹窗里的显式覆盖（优先）或节目卡司解析成具体接入/模型/音色，
   * 连同音色（或角色表）指纹一起写进每个单元的 rendered；之后换卡司/改音色不改写已有产物。
   * 覆盖优先级（docs/REDESIGN 4.4 声音选择弹窗）：castVoices（播客双主持）> voiceId（单音色）> 卡司第一张。
   */
  /** 音色级风格指令也进指纹：改 instruction 等于换了演法，预制音频要判过期重合成 */
  private voiceStyleSalt(voices: string[]): string {
    const list = this.storage.listVoices()
    return JSON.stringify(
      voices.map((voice) => [voice, list.find((item) => item.voiceType === voice)?.instruction?.trim() ?? ''])
    )
  }

  private resolveFrozenSnapshot(program: Program, override?: ProduceVoiceOverride): FrozenSnapshot {
    // 弹窗显式覆盖：播客双主持（两个音色必须路由到同一条接入、同一个播客模型）
    if (override?.castVoices) {
      const [voiceA, voiceB] = override.castVoices.map((voice) => voice.trim())
      if (!voiceA || !voiceB) throw new Error('播客双主持要选好两个音色：回到合成声音弹窗把两位主持人都选上')
      const routeA = this.tts.routeForVoice(voiceA)
      const routeB = this.tts.routeForVoice(voiceB)
      if (routeA.connection.id !== routeB.connection.id || routeA.modelId !== routeB.modelId) {
        throw new Error('两位主持人的音色要走同一条接入、同一个播客模型：回到合成声音弹窗重选')
      }
      const caps = ttsModelCapabilities(routeA.model)
      if (caps.kind !== 'podcast') {
        throw new Error(`模型「${routeA.model.label}」不是双人播客模型：回到合成声音弹窗换成 Podcast 模型或单音色`)
      }
      const speakers: [string, string] = [this.resolvePodcastSpeaker(voiceA), this.resolvePodcastSpeaker(voiceB)]
      const castFingerprint = stableHash(this.voiceStyleSalt(override.castVoices))
      // 配乐：弹窗里选了就按这次选的，没给就走服务商默认
      const useHeadMusic = override.useHeadMusic ?? true
      const useTailMusic = override.useTailMusic ?? false
      return {
        podcast: {
          connectionId: routeA.connection.id,
          modelId: routeA.modelId,
          speakers,
          castVoices: [voiceA, voiceB],
          castFingerprint,
          maxCharsPerTurn: caps.maxCharsPerTurn ?? 300,
          useHeadMusic,
          useTailMusic
        },
        voiceFor: () => {
          throw new Error('双人播客路线不按段落取音色（整期一次合成）')
        },
        snapshotFor: () => ({
          ttsConnectionId: routeA.connection.id,
          ttsModelId: routeA.modelId,
          voiceOrCastFingerprint: castFingerprint
        }),
        modelDesc: `Podcast 双人合成 · ${routeA.model.label}（${routeA.connection.name}）`,
        voiceDesc:
          `本次指定：主持人 A → ${this.voiceDisplayName(voiceA)}、` +
          `主持人 B → ${this.voiceDisplayName(voiceB)}` +
          `（${useHeadMusic ? '含' : '不含'}开场音乐 / ${useTailMusic ? '含' : '不含'}结尾音乐）`
      }
    }
    // 弹窗显式覆盖：单音色（全部段落都用它；接入/模型由音色路由反推冻结）
    if (override?.voiceId?.trim()) {
      const voice = override.voiceId.trim()
      const route = this.tts.routeForVoice(voice)
      return {
        voiceFor: () => voice,
        snapshotFor: () => ({
          ttsConnectionId: route.connection.id,
          ttsModelId: route.modelId,
          voiceOrCastFingerprint: stableHash(this.voiceStyleSalt([voice]))
        }),
        modelDesc: `${route.connection.name} / ${route.model.label}`,
        voiceDesc: `本次指定音色：${this.voiceDisplayName(voice)}`
      }
    }
    // 跟随节目卡司：卡司第一张的音色路由决定接入/模型；播客模型要求恰好两个卡司音色
    const castCards = this.persona.programCastOf(program.id).filter((p) => p.voiceId.trim())
    const firstVoice = castCards[0]?.voiceId.trim() ?? ''
    if (firstVoice) {
      const firstRoute = this.tts.routeForVoice(firstVoice)
      const caps = ttsModelCapabilities(firstRoute.model)
      if (caps.kind === 'podcast') {
        const voices = castCards.map((p) => p.voiceId.trim())
        if (voices.length < caps.maxSpeakers) {
          throw new Error(
            `「${firstRoute.model.label}」是双人播客模型，需要 ${caps.maxSpeakers} 个卡司音色：在节目卡司里配两张卡并都选好音色`
          )
        }
        const [voiceA, voiceB] = [voices[0], voices[1]]
        const routeB = this.tts.routeForVoice(voiceB)
        if (routeB.connection.id !== firstRoute.connection.id || routeB.modelId !== firstRoute.modelId) {
          throw new Error('两位主持人的音色要走同一条接入、同一个播客模型：回卡司里换音色')
        }
        const speakers: [string, string] = [this.resolvePodcastSpeaker(voiceA), this.resolvePodcastSpeaker(voiceB)]
        const castFingerprint = stableHash(this.voiceStyleSalt([voiceA, voiceB]))
        const useHeadMusic = override?.useHeadMusic ?? true
        const useTailMusic = override?.useTailMusic ?? false
        return {
          podcast: {
            connectionId: firstRoute.connection.id,
            modelId: firstRoute.modelId,
            speakers,
            castVoices: [voiceA, voiceB],
            castFingerprint,
            maxCharsPerTurn: caps.maxCharsPerTurn ?? 300,
            useHeadMusic,
            useTailMusic
          },
          voiceFor: () => {
            throw new Error('双人播客路线不按段落取音色（整期一次合成）')
          },
          snapshotFor: () => ({
            ttsConnectionId: firstRoute.connection.id,
            ttsModelId: firstRoute.modelId,
            voiceOrCastFingerprint: castFingerprint
          }),
          modelDesc: `Podcast 双人合成 · ${firstRoute.model.label}（${firstRoute.connection.name}）`,
          voiceDesc:
            `主持人 A → ${this.voiceDisplayName(voiceA)}、主持人 B → ${this.voiceDisplayName(voiceB)}` +
            `（${useHeadMusic ? '含' : '不含'}开场音乐 / ${useTailMusic ? '含' : '不含'}结尾音乐）`
        }
      }
    }
    // 跟随节目卡司：快照取卡司第一张音色路由出的接入/模型（只用于填充快照，不形成永久绑定）
    return {
      voiceFor: (u) => {
        const byPresenter = u.presenterId
          ? (this.persona.list().find((p) => p.id === u.presenterId)?.voiceId.trim() ?? '')
          : ''
        const voice = byPresenter || u.voiceId.trim() || this.persona.castVoiceOf(program.id)
        if (!voice) throw new Error('文稿没有可用音色：卡司没选音色（先在合成弹窗里选一个）')
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
      modelDesc: '跟随节目卡司（卡司第一张的音色路由）',
      voiceDesc: (() => {
        const cast = this.persona.programCastOf(program.id)
        const voice = this.persona.castVoiceOf(program.id)
        if (!voice) return '卡司里的主播卡都还没选音色'
        return `卡司第一张（${cast[0]?.name ?? '—'}）的音色：${this.voiceDisplayName(voice)}`
      })()
    }
  }

  /** 分段路线的提示文案（§7.3/§15.10）：不承诺原生长文模型的连续表演效果 */
  private standardPathNotice(program: Program, units: AudioUnit[]): string | undefined {
    if (program.contentType === 'solo') return undefined
    if (!units.some((unit) => unit.kind === 'scene')) return undefined
    return '分段合成并拼接成整章：不承诺原生长文/播客模型的连续表演效果'
  }

  /** ffmpeg 拼接（concat demuxer + 统一转 mp3）：段文件格式可能混着 mp3/wav，重编码保证拼得出；清单文件落暂存区 */
  private async concatAudioFiles(files: string[], outPath: string): Promise<string> {
    const listPath = this.blobs.tmpPath(`concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    await mkdir(dirname(listPath), { recursive: true }).catch(() => undefined)
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
   * 导入外部音频（§7.4，program:import-audio 的后端）：单流复制入 BlobStore（不动用户原文件），
   * 挂到指定 Scene/DraftUnit 的 rendered（status='ready'、external=true、快照字段记 'external'、
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

      const all = this.storage.draftUnitList(programId)
      const styleSalt = programStyleSalt(program)
      let fingerprint: string
      if (target.kind === 'scene') {
        const script = this.script.getScript(program.scriptId)
        const scene = script?.scenes.find((s) => s.id === target.id)
        if (!script || !scene) return { ok: false, error: '场景不存在（节目没绑剧本或场景已删）' }
        fingerprint = sceneFingerprint(narrativeOrder(all.filter((u) => u.sceneId === scene.id)), styleSalt)
      } else {
        const utterance = all.find((u) => u.id === target.id)
        if (!utterance) return { ok: false, error: '文稿段落不存在（可能已删）' }
        fingerprint = utteranceFingerprint(utterance, styleSalt)
      }

      const put = await this.blobs.putFile(sourcePath, ext.replace(/^\./, ''), { move: false })
      const audioPath = put.path
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
        this.storage.draftUnitSetRendered(target.id, rendered)
        const updated = this.storage.draftUnitGet(target.id)
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
    u: DraftUnit,
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
        }, u.programId)
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (signal?.aborted || hardError(message) || attempt === retries) break
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

/** 冻结快照（一次预制生产用的卡司声音）：逐段取音色 + 单元级快照字段 + 确认卡展示文案 */
type SnapshotFields = Pick<RenderedAudioRef, 'ttsConnectionId' | 'ttsModelId' | 'voiceOrCastFingerprint'>

/** podcast 路线的冻结信息：两个主持人（原始音色输入 + 解析后的 speaker id）与音乐开关 */
interface PodcastRouteInfo {
  connectionId: string
  modelId: string
  /** 发给模型的两个发音人 id（顺序 = 主持人 A/B） */
  speakers: [string, string]
  /** cast 里的原始音色输入（文稿段落 voiceId 匹配用） */
  castVoices: [string, string]
  castFingerprint: string
  maxCharsPerTurn: number
  useHeadMusic: boolean
  useTailMusic: boolean
}

interface FrozenSnapshot {
  /** 模型是双人播客时有值：producePrepared 走 podcast 路线（整期一次合成） */
  podcast?: PodcastRouteInfo
  /** 这条文稿用哪个音色（没有就抛中文原因，不带兜底） */
  voiceFor: (u: DraftUnit) => string
  /** 单元级快照字段：接入/模型/音色或角色表指纹 */
  snapshotFor: (voices: string[]) => SnapshotFields
  modelDesc: string
  voiceDesc: string
}
