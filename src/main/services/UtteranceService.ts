import { randomUUID } from 'node:crypto'
import type { Utterance, UtteranceInput } from '../../shared/types'
import { PARAGRAPH_MAX_CHARS, PARAGRAPH_MIN_ITEMS } from '../../shared/paragraph'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import type { PersonaService } from './PersonaService'

/**
 * 场次话术库（docs/07 §3 utterances）：场次底稿库，长期存在、可反复用、可编辑。
 * 与运行态 speech_items 分工：开播时按轮播规则从这里取件入池；
 * 直播中的改写不回写底稿（复盘采纳才回写，source='adopted'）。
 */
export class UtteranceService {
  /** 单条状态变化广播（index.ts 接 broadcastUtterance；预合成与底稿改后重合成共用） */
  onEvent: ((u: Utterance) => void) | null = null
  /** 一批合成结束广播（id='' 的特殊事件，UI 整体刷新） */
  onBatchDone: ((planId: string) => void) | null = null
  /** 正在后台合成的场次（重入转 dirty，跑完补一轮） */
  private readonly synthRunning = new Set<string>()
  private readonly synthDirty = new Set<string>()

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly persona: PersonaService
  ) {}

  /**
   * 后台把场次里 pending/failed 的条目合成就绪（带场次锁）：
   * 预合成按钮、主播改/补底稿后的重合成都走这里。同时在跑就标 dirty，本轮结束自动补跑一轮。
   */
  async kickSynthesis(planId: string): Promise<void> {
    if (this.synthRunning.has(planId)) {
      this.synthDirty.add(planId)
      return
    }
    this.synthRunning.add(planId)
    try {
      do {
        this.synthDirty.delete(planId)
        try {
          await this.synthesizeAll(planId, (u) => this.onEvent?.(u))
        } catch (error) {
          console.warn(`[话术库] 后台合成中断：${error instanceof Error ? error.message : String(error)}`)
        }
      } while (this.synthDirty.has(planId))
    } finally {
      this.synthRunning.delete(planId)
      this.onBatchDone?.(planId)
    }
  }

  list(planId: string): Utterance[] {
    return this.storage.utteranceList(planId)
  }

  /** 生成 Agent 的 write_bits 工具走这里：一次写一场景的一批桥段 */
  saveMany(
    planId: string,
    sceneId: string,
    items: { text: string; bitType?: string; delivery?: string; sources?: Utterance['sources'] }[]
  ): Utterance[] {
    const existing = this.storage.utteranceList(planId).filter((u) => u.sceneId === sceneId)
    let variantIdx = existing.reduce((max, u) => Math.max(max, u.variantIdx + 1), 0)
    return items
      .filter((item) => item.text.trim().length > 0)
      .map((item) =>
        this.save({
          planId,
          sceneId,
          variantIdx: variantIdx++,
          text: item.text.trim(),
          bitType: item.bitType?.trim() ?? '',
          delivery: item.delivery?.trim() ?? '',
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
      ? (this.storage.utteranceList(input.planId).find((u) => u.id === id) ?? null)
      : null
    const textChanged = existing !== null && existing.text !== input.text.trim()
    const utterance: Utterance = {
      id: id ?? `ut-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      planId: input.planId,
      sceneId: input.sceneId,
      variantIdx: input.variantIdx,
      // 创作序号：编辑保留原序号；新增自动排到场景末尾（装池按它恢复叙事顺序）
      seq: input.seq ?? existing?.seq ?? this.storage.utteranceNextSeq(input.planId, input.sceneId),
      text: input.text.trim(),
      bitType: input.bitType?.trim() ?? existing?.bitType ?? '',
      delivery: input.delivery?.trim() ?? existing?.delivery ?? '',
      voiceId: input.voiceId ?? '',
      audioPath: textChanged ? null : (existing?.audioPath ?? null),
      status: textChanged ? 'pending' : (existing?.status ?? 'pending'),
      error: textChanged ? undefined : existing?.error,
      source: input.source ?? 'initial',
      sources: input.sources ?? [],
      createdAt: existing?.createdAt ?? Date.now()
    }
    this.storage.utteranceSave(utterance)
    // 文本变了，旧段落归属一并作废（下次预合成重新分组）
    if (textChanged) this.storage.utteranceSetPara([utterance.id], '')
    return utterance
  }

  remove(id: string): void {
    this.storage.utteranceDelete(id)
  }

  /** 清空场次话术库（重生成前）；给 sceneId 只清某场景 */
  clear(planId: string, sceneId?: string): void {
    this.storage.utteranceDeleteWhere(planId, sceneId)
  }

  /**
   * 批量预合成（docs/07 §4 ④）：把场次里 pending/failed 的条目合成就绪。
   * 桥段（bitType 非空）：一条 = 一整段连续讲述 = 一次合成，不拆不分组——
   * 播放/合成/缓存单元对齐，请求数比单句时代少一个量级，语气由 TTS 按整段上下文处理。
   * 旧式单句（桥段制之前的底稿）：维持同场景同音色连续条目拼段落整组合成再切句，
   * 段落对不上句数就整组回退逐条。逐条串行（TTS 限流安全），onProgress 逐条回报。
   */
  async synthesizeAll(
    planId: string,
    onProgress?: (u: Utterance) => void,
    signal?: AbortSignal
  ): Promise<{ done: number; failed: number }> {
    const plan = this.storage.planList().find((p) => p.id === planId) ?? null
    const pending = this.storage
      .utteranceList(planId)
      .filter((u) => u.status === 'pending' || u.status === 'failed')
    // 合成用的音色与开播装载时的判定口径一致（场次音色优先于人设音色）
    const voiceOf = (u: Utterance) => this.persona.resolvePlanVoice(plan, undefined, u.voiceId) ?? ''

    // 桥段自成一组（整段一次合成）；旧式单句按原规则拼段落
    const groups: Utterance[][] = []
    let current: Utterance[] = []
    let currentChars = 0
    const flush = () => {
      if (current.length > 0) groups.push(current)
      current = []
      currentChars = 0
    }
    for (const u of pending) {
      if (u.bitType) {
        flush()
        groups.push([u])
        continue
      }
      const voice = voiceOf(u)
      const continues =
        current.length > 0 &&
        current[0].sceneId === u.sceneId &&
        voiceOf(current[0]) === voice &&
        currentChars + u.text.length <= PARAGRAPH_MAX_CHARS
      if (continues) {
        current.push(u)
        currentChars += u.text.length
      } else {
        flush()
        current = [u]
        currentChars = u.text.length
      }
    }
    flush()

    let done = 0
    let failed = 0
    // 合成队列节奏（config.tts）：请求最小间隔对付服务商频率限制；瞬时错误退避重试
    const { synthIntervalMs, synthRetries } = this.storage.getConfig().tts
    let lastRequestAt = 0
    const pace = async () => {
      const waitMs = synthIntervalMs - (Date.now() - lastRequestAt)
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
      lastRequestAt = Date.now()
    }
    for (const group of groups) {
      if (signal?.aborted) break
      if (group.length >= PARAGRAPH_MIN_ITEMS) {
        const ok = await this.synthesizeParagraphGroup(group, voiceOf(group[0]), onProgress, signal)
        if (ok) {
          done += group.length
          continue
        }
        if (signal?.aborted) break
        // 段落没成：落回逐条（下面这组逐条走完）
      }
      for (const u of group) {
        if (signal?.aborted) break
        const voice = voiceOf(u)
        this.storage.utteranceSetAudio(u.id, 'synthesizing', u.audioPath)
        onProgress?.({ ...u, status: 'synthesizing' })
        try {
          await pace()
          const audioPath = await this.synthesizeWithRetry(u, voice, synthRetries, signal)
          this.storage.utteranceSetPara([u.id], '')
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
        return await this.tts.synthesize(`utterance-${u.id}`, u.text, voice || undefined, signal)
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (signal?.aborted || hardError(message) || attempt === retries) break
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * 一组连续条目整段合成：成功后每条拿到自己的切片 wav 和共同的 paraId。
   * 任一步失败（句数对不上 / 接口报错）返回 false，调用方整组回退逐条合成。
   */
  private async synthesizeParagraphGroup(
    group: Utterance[],
    voice: string,
    onProgress?: (u: Utterance) => void,
    signal?: AbortSignal
  ): Promise<boolean> {
    for (const u of group) {
      this.storage.utteranceSetAudio(u.id, 'synthesizing', u.audioPath)
      onProgress?.({ ...u, status: 'synthesizing' })
    }
    try {
      const { paths, paraId } = await this.tts.synthesizeParagraph(
        group.map((u) => ({ itemId: `utterance-${u.id}`, text: u.text })),
        voice || undefined,
        signal
      )
      this.storage.utteranceSetPara(
        group.map((u) => u.id),
        paraId
      )
      group.forEach((u, i) => {
        this.storage.utteranceSetAudio(u.id, 'ready', paths[i], undefined, voice)
        onProgress?.({ ...u, status: 'ready', audioPath: paths[i], synthVoice: voice, paraId })
      })
      return true
    } catch (error) {
      console.warn(
        `[话术库] 段落合成没成，回退逐条：${error instanceof Error ? error.message : String(error)}`
      )
      this.storage.utteranceSetPara(
        group.map((u) => u.id),
        ''
      )
      for (const u of group) {
        const restored = u.audioPath ? 'ready' : 'pending'
        this.storage.utteranceSetAudio(u.id, restored, u.audioPath)
        onProgress?.({ ...u, status: restored })
      }
      return false
    }
  }
}
