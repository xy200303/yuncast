import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Utterance, UtteranceInput } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import type { PersonaService } from './PersonaService'

/**
 * 节目话术库（docs/07 §3 utterances）：节目底稿库，长期存在、可反复用、可编辑。
 * 与运行态 speech_items 分工：开播时按轮播规则从这里取件入池；
 * 直播中的改写不回写底稿（复盘采纳才回写，source='adopted'）。
 */
export class UtteranceService {
  /** 单条状态变化广播（index.ts 接 broadcastUtterance；预合成与底稿改后重合成共用） */
  onEvent: ((u: Utterance) => void) | null = null
  /** 一批合成结束广播（id='' 的特殊事件，UI 整体刷新） */
  onBatchDone: ((programId: string) => void) | null = null
  /** 正在后台合成的节目（重入转 dirty，跑完补一轮） */
  private readonly synthRunning = new Set<string>()
  private readonly synthDirty = new Set<string>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly persona: PersonaService
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
    return items
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
  }

  /** 新建/编辑。文本变了则作废旧音频（待重新预合成）。 */
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
      source: input.source ?? 'initial',
      sources: input.sources ?? [],
      createdAt: existing?.createdAt ?? Date.now()
    }
    this.storage.utteranceSave(utterance)
    return utterance
  }

  remove(id: string): void {
    const existing = this.storage.utteranceGet(id)
    this.storage.utteranceDelete(id)
    this.deleteOrphanAudio([existing?.audioPath])
  }

  /** 清空节目话术库（重生成前）；给 sceneId 只清某场景。连缓存音频一起清（不被别处引用的才删） */
  clear(programId: string, sceneId?: string): void {
    const doomed = this.storage
      .utteranceList(programId)
      .filter((u) => sceneId === undefined || u.sceneId === sceneId)
      .map((u) => u.audioPath)
    this.storage.utteranceDeleteWhere(programId, sceneId)
    this.deleteOrphanAudio(doomed)
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
    const { synthIntervalMs, synthRetries } = this.storage.getConfig().tts
    let lastRequestAt = 0
    const pace = async (voice: string) => {
      const interval = synthIntervalMs > 0 ? synthIntervalMs : this.tts.synthIntervalFor(voice || undefined)
      const waitMs = interval - (Date.now() - lastRequestAt)
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
      lastRequestAt = Date.now()
    }
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
