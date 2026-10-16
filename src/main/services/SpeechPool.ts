import { randomUUID } from 'node:crypto'
import {
  LIBRARY_SOURCE_ID,
  POOL_LIMITS,
  SPEECH_LANES,
  SPEECH_SOURCE_KINDS,
  type PoolSayInput,
  type PoolSnapshot,
  type PoolStatus,
  type SpeechItem,
  type SpeechLane
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'
import { toSpeechText } from './speechText'
import { friendlyError } from './errorTranslate'

/**
 * 话术池（docs/01 §3.2/3.3）：任何声音进直播间的唯一入口。
 * - 排序：lane 序（interrupt > next > normal > filler）→ 话轮原子性（同 turnId 不拆）→ sortOrder/createdAt
 * - 预合成窗口：队列前 5 条 pending 自动送 TTS；排序变化重算，被挤出的取消回 pending
 * - 去重（dedupeKey 命中未播条目合并）、时效（expiresAt 过期清理）、容量上限 50、每来源每分钟限 20 条
 * - DB 是唯一事实来源，每次变更落库并广播快照
 */

/** 场记：没开播时条目归到这个占位会话（开播后由 SessionRecorder 给出真实场次 id） */
const DEFAULT_SESSION_ID = 'default'

const LANE_RANK: Record<SpeechLane, number> = {
  interrupt: 0,
  next: 1,
  normal: 2,
  filler: 3
}

/** 播放顺序：lane → 话轮锚点（组内最早条目）→ 话轮内 seq */
function orderedForPlay(items: SpeechItem[]): SpeechItem[] {
  const groups = new Map<string, SpeechItem[]>()
  for (const item of items) {
    const key = `${item.lane}:${item.turnId}`
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  const keyOf = (item: SpeechItem) => item.sortOrder ?? item.createdAt
  const anchored = [...groups.values()].map((group) => {
    group.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
    return { lane: group[0].lane, anchor: Math.min(...group.map(keyOf)), group }
  })
  anchored.sort((a, b) => LANE_RANK[a.lane] - LANE_RANK[b.lane] || a.anchor - b.anchor)
  return anchored.flatMap((entry) => entry.group)
}

/** 失败条目给 UI 看的原因（过错误翻译层：技术原文翻成人话，人话原样放行） */
function errorMessage(error: unknown): string {
  return friendlyError(error)
}

/**
 * 实时合成开启后仍然预合成的话术类型：文本在入池时就已确定（剧本/暖场），
 * 提前合成好则播出零延迟；动态生成的回复类内容才值得为"最快首包"牺牲预合成。
 */
/** 实时通道（双向 WS）的最小探针接口（避免与 TtsRealtimeService 强耦合，便于测试替身） */
export interface RealtimeChannelProbe {
  available(voiceId?: string): boolean
  unavailableReason(voiceId?: string): string
}

const PRE_SYNTH_KINDS: SpeechItem['source']['kind'][] = ['scene', 'filler']

export class SpeechPool {
  /** 预合成任务的取消令牌（被挤出窗口时 abort） */
  private synthJobs = new Map<string, AbortController>()
  /** 最近一次实时通道降级原因（诊断用） */
  private lastRealtimeFallback = '' 
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  /** 音频就绪预热钩子（index.ts 接 BlobStore.warm：开播装池/合成完成时把文件读进 OS 页面缓存） */
  onWarmCache: ((path: string) => void) | null = null

  /** 场记：当前场次 id（index.ts 在开播/收播时设置）；null = 没开播，条目归占位会话 */
  sessionId: string | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly broadcast: (snapshot: PoolSnapshot) => void,
    /** 实时通道（双向 WS）；协议未核对期间恒不可用，动态内容走 SSE 流式 */
    private readonly realtime: RealtimeChannelProbe = {
      available: () => false,
      unavailableReason: () => '实时通道未接入'
    },
    /** 当前在场主播的生效音色（index.ts 接 agent.currentVoice）：播放取件的音色匹配用 */
    private readonly voiceProvider: () => string = () => ''
  ) {
    // 重启后上次留下的未播完条目全部作废——音频可能还在但播放上下文没了
    for (const item of this.storage.speechActive()) {
      this.storage.speechUpdate(item.id, { status: 'skipped', error: '应用重启，队列重置' })
    }
    // 时效清扫兜底（正常路径在每次 refresh 里做）
    this.sweepTimer = setInterval(() => this.refresh(), 5000)
    this.sweepTimer.unref?.()
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const controller of this.synthJobs.values()) controller.abort()
    this.synthJobs.clear()
  }

  // ---------- 入池 ----------

  say(input: PoolSayInput): SpeechItem {
    // 显示稿与语音稿分离：display 带 @昵称，送 TTS 的转成自然称呼（见 speechText.ts）
    const speechText = toSpeechText(input.text)
    const text = input.text.trim()
    if (!text) throw new Error('话术内容为空')
    if (text.length > POOL_LIMITS.textMaxLength) {
      throw new Error(`单条话术最多 ${POOL_LIMITS.textMaxLength} 字`)
    }
    const lane = input.lane && SPEECH_LANES.includes(input.lane) ? input.lane : 'normal'
    const sourceKind =
      input.sourceKind && SPEECH_SOURCE_KINDS.includes(input.sourceKind) ? input.sourceKind : 'manual'
    const sourceAgentId = input.sourceAgentId?.trim() || 'human'

    // 限流：主播/人工/触发器每来源每分钟 20 条；底稿库装载（library）走宽松档——
    // 场景底稿按波次重装（容量 50 一波），整版底稿一轮要装得下
    const limit =
      sourceAgentId === LIBRARY_SOURCE_ID
        ? POOL_LIMITS.libraryPerSourcePerMinute
        : POOL_LIMITS.perSourcePerMinute
    const recent = this.storage.speechCountBySourceSince(sourceAgentId, sourceKind, Date.now() - 60_000)
    if (recent >= limit) {
      throw new Error(`该来源发言过于频繁（每分钟最多 ${limit} 条），稍后再试`)
    }

    // 去重：dedupeKey 命中未播条目直接合并（pending 可更新文本，合成中/就绪保持原样）
    if (input.dedupeKey) {
      const existing = this.storage.speechFindActiveByDedupeKey(input.dedupeKey)
      if (existing) {
        if (existing.status === 'pending' && existing.text !== text) {
          this.storage.speechUpdate(existing.id, { text, expiresAt: input.expiresAt ?? existing.expiresAt })
          this.refresh()
        }
        return this.storage.speechGet(existing.id) ?? existing
      }
    }

    // 容量上限
    if (this.storage.speechActive().length >= POOL_LIMITS.capacity) {
      throw new Error(`话术池已满（${POOL_LIMITS.capacity} 条），等播出一部分再丢`)
    }

    const item: SpeechItem = {
      id: `sp-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionId: this.sessionId ?? DEFAULT_SESSION_ID,
      text,
      turnId: input.turnId?.trim() || `turn-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      seq: input.seq ?? 0,
      voiceId: input.voiceId?.trim() ?? '',
      source: { agentId: sourceAgentId, kind: sourceKind },
      lane,
      dedupeKey: input.dedupeKey,
      expiresAt: input.expiresAt,
      replyTo: input.replyTo,
      speechText: speechText !== text ? speechText : undefined,
      delivery: input.delivery?.trim() || undefined,
      rate: input.rate,
      pitch: input.pitch,
      originUtteranceId: input.originUtteranceId,
      sortOrder: input.sortOrder,
      // 场次装载：库里的预合成音频直接复用，开播零延迟（未预合成才进合成窗口）
      audioPath: input.audioPath?.trim() || undefined,
      status: input.audioPath?.trim() ? 'ready' : 'pending',
      createdAt: Date.now()
    }
    this.storage.speechInsert(item)
    if (item.audioPath) this.onWarmCache?.(item.audioPath)
    this.refresh()
    return item
  }

  /** insert_next：评论回复走 next 道，当前播完即播 */
  insertNext(input: Omit<PoolSayInput, 'lane'>): SpeechItem {
    return this.say({ ...input, lane: 'next' })
  }

  // ---------- 池管理 ----------

  /** 修订未播条目：作废旧音频重合成。playing/done 不可改——说出去的话泼出去的水。 */
  revise(id: string, newText: string): SpeechItem {
    const item = this.mustGet(id)
    const text = newText.trim()
    if (!text) throw new Error('话术内容为空')
    if (item.status === 'playing' || item.status === 'done' || item.status === 'interrupted') {
      throw new Error('这条已经在播或播完了，不能改')
    }
    this.cancelSynth(id)
    const isStreamItem = item.stream && !item.audioPath
    this.storage.speechUpdate(id, {
      text,
      speechText: toSpeechText(text),
      status: isStreamItem ? 'ready' : 'pending',
      audioPath: undefined,
      error: undefined
    })
    // 流式条目文本即声音，改完就是新的；预合成条目回 pending，由合成窗口重新合成
    this.refresh()
    return this.mustGet(id)
  }

  /** 撤销未播条目 */
  revoke(id: string): void {
    const item = this.mustGet(id)
    if (item.status === 'playing' || item.status === 'done' || item.status === 'interrupted') {
      throw new Error('这条已经在播或播完了，不能撤销')
    }
    this.cancelSynth(id)
    this.storage.speechUpdate(id, { status: 'skipped' })
    this.refresh()
  }

  /** 手动排序：给出的 id 顺序即新的播出顺序（只对未播条目生效） */
  reorder(ids: string[]): void {
    const active = new Set(this.storage.speechActive().map((item) => item.id))
    ids.forEach((id, index) => {
      if (active.has(id)) this.storage.speechUpdate(id, { sortOrder: index + 1 })
    })
    this.refresh()
  }

  /**
   * 开播前清"别的节目的存货"：条目来自某段底稿（originUtteranceId），而那段底稿不属于本节目 → 撤掉。
   * 不清的话，预制/单篇节目的「播完即停」永远等不到池空（池里还压着上一场的词），
   * 播完自己的内容会接着念别的节目的稿子——最难看的一种错位。没来源的现场话术（人工播报/导演 say）不动。
   */
  dropForeignOrigins(allowedUtteranceIds: Set<string>): number {
    let n = 0
    for (const item of this.storage.speechActive()) {
      const origin = item.originUtteranceId
      if (!origin || allowedUtteranceIds.has(origin)) continue
      if (item.status === 'playing') continue
      this.cancelSynth(item.id)
      this.storage.speechUpdate(item.id, { status: 'skipped' })
      n++
    }
    if (n > 0) this.refresh()
    return n
  }

  /** 清空某条车道上的未播条目（不动正在播的） */
  clearLane(lane: SpeechLane): void {
    if (!SPEECH_LANES.includes(lane)) throw new Error('未知车道')
    for (const item of this.storage.speechActive()) {
      if (item.lane !== lane || item.status === 'playing') continue
      this.cancelSynth(item.id)
      this.storage.speechUpdate(item.id, { status: 'skipped' })
    }
    this.refresh()
  }

  /**
   * 换主播/换音色后的重嗓音（docs/07 §8.5）：未播条目里音色不匹配的作废音频、
   * 换新嗓音重合成（文本不动）。通配条目（voiceId=''）和已匹配的不动；
   * 正在播的收不回（说出去的话泼出去的水），播完的不管。返回重置条数。
   */
  reVoice(voice: string): number {
    const target = voice.trim()
    if (!target) return 0
    let n = 0
    for (const item of this.storage.speechActive()) {
      if (item.voiceId === '' || item.voiceId === target) continue
      if (item.status === 'playing' || item.status === 'done') continue
      this.cancelSynth(item.id)
      this.storage.speechUpdate(item.id, { status: 'pending', audioPath: undefined, stream: false, voiceId: target })
      n++
    }
    if (n > 0) this.refresh()
    return n
  }

  // ---------- 播放出口 ----------

  /** 看一眼播出顺序上的第一个 ready 条目（不取走）：播放循环用它判断下一条急不急，决定要不要留白 */
  peek(): SpeechItem | null {
    this.sweepExpired()
    return (
      orderedForPlay(this.storage.speechActive()).find(
        (entry) => entry.status === 'ready' && this.playable(entry)
      ) ?? null
    )
  }

  /** 取播出顺序上第一个 ready 条目并置 playing；没有就返回 null（调用方等待重试） */
  next(): SpeechItem | null {
    this.sweepExpired()
    const ordered = orderedForPlay(this.storage.speechActive())
    let item = ordered.find((entry) => entry.status === 'ready' && this.playable(entry))
    if (!item) {
      // 有就绪但音色全不匹配（改人设卡音色后重启之类）：自愈重嗓音，别干躺着等死
      const ready = ordered.filter((entry) => entry.status === 'ready')
      const voice = this.voiceProvider()
      if (ready.length > 0 && voice && ready.every((entry) => !this.playable(entry))) {
        this.reVoice(voice)
        item = orderedForPlay(this.storage.speechActive()).find(
          (entry) => entry.status === 'ready' && this.playable(entry)
        )
      }
    }
    if (!item) return null
    this.storage.speechUpdate(item.id, { status: 'playing' })
    this.refresh()
    return this.storage.speechGet(item.id)
  }

  /** 音色匹配：条目没标音色（通配）或当前无生效音色都照播；标了且不匹配的取不走（等 reVoice 重合成） */
  private playable(item: SpeechItem): boolean {
    const voice = this.voiceProvider()
    if (!item.voiceId || !voice) return true
    return item.voiceId === voice
  }

  /** 播放中断（暂停/急停/退出）：正在播的条目退回 ready，等恢复从头重播 */
  requeue(id: string): void {
    const item = this.storage.speechGet(id)
    if (!item || item.status !== 'playing') return
    this.storage.speechUpdate(id, { status: 'ready' })
    this.refresh()
  }

  /**
   * 按 dedupeKey 把某条未播条目提到播出顺序的最前（预制节目按章跳播用）。
   * 返回 false = 池里没有这条（调用方负责重新装载后再提）。
   */
  jumpTo(dedupeKey: string): boolean {
    const item = this.storage.speechFindActiveByDedupeKey(dedupeKey)
    if (!item || item.status === 'playing') return false
    const active = this.storage.speechActive()
    const minAnchor = Math.min(...active.map((entry) => entry.sortOrder ?? entry.createdAt))
    this.storage.speechUpdate(item.id, { sortOrder: minAnchor - 1 })
    this.refresh()
    return true
  }

  /** 播报完成回报 */
  markDone(id: string): void {
    const item = this.storage.speechGet(id)
    if (!item) return
    this.storage.speechUpdate(id, { status: 'done', playedAt: Date.now() })
    this.storage.speechPrune()
    this.refresh()
  }

  /** 播放/合成失败：记下具体原因，条目置 failed（快照广播出去，界面照实提示，不当成播出成功） */
  markFailed(id: string, error: string): void {
    const item = this.storage.speechGet(id)
    if (!item || item.status === 'done' || item.status === 'failed') return
    console.error(`[AgentAnchor] 播报失败（${id}）: ${error}`)
    this.storage.speechUpdate(id, { status: 'failed', error })
    this.refresh()
  }

  // ---------- 自查 ----------

  getStatus(): PoolStatus {
    this.sweepExpired()
    const active = this.storage.speechActive()
    const byLane: Record<SpeechLane, number> = { interrupt: 0, next: 0, normal: 0, filler: 0 }
    for (const item of active) byLane[item.lane] += 1
    return {
      active: active.length,
      byLane,
      playing: active.find((item) => item.status === 'playing') ?? null
    }
  }

  getRecentPlayed(n: number): SpeechItem[] {
    return this.storage.speechRecentPlayed(Math.max(1, Math.min(n, 50)))
  }

  snapshot(): PoolSnapshot {
    const active = this.storage.speechActive()
    return {
      items: orderedForPlay(active),
      failed: this.storage.speechFailedSince(Date.now() - 5 * 60_000)
    }
  }

  // ---------- 内部 ----------

  private mustGet(id: string): SpeechItem {
    const item = this.storage.speechGet(id)
    if (!item) throw new Error('条目不存在')
    return item
  }

  private cancelSynth(id: string): void {
    const controller = this.synthJobs.get(id)
    if (controller) {
      controller.abort()
      this.synthJobs.delete(id)
    }
  }

  /** 过期条目置 expired（不播），并取消它们的合成任务 */
  private sweepExpired(): void {
    const now = Date.now()
    for (const item of this.storage.speechActive()) {
      if (item.expiresAt && item.expiresAt <= now && item.status !== 'playing') {
        this.cancelSynth(item.id)
        this.storage.speechUpdate(item.id, { status: 'expired' })
      }
    }
  }

  /** 任何状态变迁的收口：扫时效 → 重算合成窗口 → 广播快照 */
  private refresh(): void {
    this.sweepExpired()
    this.refreshSynthWindow()
    this.broadcast(this.snapshot())
  }

  /** 预合成窗口：前 5 条 pending 自动送 TTS；被挤出窗口的合成中条目取消回 pending */
  private refreshSynthWindow(): void {
    const queued = orderedForPlay(this.storage.speechActive()).filter((item) =>
      ['pending', 'synthesizing', 'ready'].includes(item.status)
    )
    const windowIds = new Set(queued.slice(0, POOL_LIMITS.synthWindow).map((item) => item.id))

    for (const [id, controller] of [...this.synthJobs]) {
      if (!windowIds.has(id)) {
        controller.abort()
        this.synthJobs.delete(id)
        this.storage.speechUpdate(id, { status: 'pending' })
      }
    }

    for (const item of queued.slice(0, POOL_LIMITS.synthWindow)) {
      if (item.status === 'pending' && !this.synthJobs.has(item.id)) void this.synthesize(item)
    }
  }

  private async synthesize(item: SpeechItem): Promise<void> {
    // 通道按内容挑（用户在接入上只开了「实时合成」这一个开关，不是选通道）：
    // - 文本已知的剧情/暖场话术 → 照常预合成成文件（提前备好，播出零延迟）
    // - 文本动态的回复/互动/播报 → 标 ready+stream，播出时边走边合成（首包延迟最低）
    // 走哪条接入、那个模型支不支持流式，全由这条话术的音色路由决定
    const streamable = (() => {
      if (PRE_SYNTH_KINDS.includes(item.source.kind)) return false
      try {
        const route = this.tts.routeForVoice(item.voiceId || undefined)
        return Boolean(route.model.streaming && route.connection.realtime)
      } catch {
        // 路由不通就别标 stream：等真正合成时会把中文原因记在条目上
        return false
      }
    })()
    if (streamable && !this.realtime.available(item.voiceId || undefined)) {
      // 真正的双向实时通道还没接（协议待核对），这里走 SSE 流式；记一次原因便于诊断
      this.lastRealtimeFallback = this.realtime.unavailableReason(item.voiceId || undefined)
    }
    if (streamable) {
      // 修订后的条目同样走这里：无需合成，只要文本已是新的（revise 已改），标 ready 即可
      this.storage.speechUpdate(item.id, { status: 'ready', stream: true, audioPath: undefined })
      this.broadcast(this.snapshot())
      return
    }
    const controller = new AbortController()
    this.synthJobs.set(item.id, controller)
    // 合成期间的文本版本：完成时若已被 revise 改动，这份音频作废重来
    const textAtStart = item.text
    this.storage.speechUpdate(item.id, { status: 'synthesizing' })
    this.broadcast(this.snapshot())
    try {
      const audioPath = await this.tts.synthesize(
        item.id,
        item.speechText || textAtStart,
        item.voiceId || undefined,
        controller.signal,
        { instruction: item.delivery, rate: item.rate, pitch: item.pitch },
        // 用量归属当前节目（用量看板按节目分摊）
        this.storage.getConfig().live.activeProgramId || undefined
      )
      if (controller.signal.aborted) return
      const current = this.storage.speechGet(item.id)
      if (!current || current.text !== textAtStart) {
        // 文本在合成期间被修订：丢弃旧音频，回 pending 让窗口重合成
        this.storage.speechUpdate(item.id, { status: 'pending', audioPath: undefined, stream: false })
        this.refresh()
        return
      }
      this.storage.speechUpdate(item.id, { status: 'ready', audioPath, stream: false })
      this.onWarmCache?.(audioPath)
    } catch (error) {
      if (controller.signal.aborted) {
        // 被挤出窗口：回 pending 等下次进窗口再合成
        this.storage.speechUpdate(item.id, { status: 'pending' })
      } else {
        // 合成失败不阻塞池：条目置 failed，错误随快照广播出去
        console.error(`[AgentAnchor] TTS 合成失败（${item.id}）:`, error)
        this.storage.speechUpdate(item.id, { status: 'failed', error: errorMessage(error) })
      }
    } finally {
      this.synthJobs.delete(item.id)
      if (!controller.signal.aborted) this.refresh()
    }
  }
}
