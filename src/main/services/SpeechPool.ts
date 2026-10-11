import { randomUUID } from 'node:crypto'
import {
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

/**
 * 话术池（docs/01 §3.2/3.3）：任何声音进直播间的唯一入口。
 * - 排序：lane 序（interrupt > next > normal > filler）→ 话轮原子性（同 turnId 不拆）→ sortOrder/createdAt
 * - 预合成窗口：队列前 5 条 pending 自动送 TTS；排序变化重算，被挤出的取消回 pending
 * - 去重（dedupeKey 命中未播条目合并）、时效（expiresAt 过期清理）、容量上限 50、每来源每分钟限 20 条
 * - DB 是唯一事实来源，每次变更落库并广播快照
 */

/** M2 还没有场次系统，先归到一个固定会话 */
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 实时合成开启后仍然预合成的话术类型：文本在入池时就已确定（剧本/暖场），
 * 提前合成好则播出零延迟；动态生成的回复类内容才值得为"最快首包"牺牲预合成。
 */
/** 实时语音通道的最小探针接口（避免与 TtsRealtimeService 强耦合，便于测试替身） */
export interface RealtimeChannelProbe {
  available(): boolean
  unavailableReason(): string
}

const PRE_SYNTH_KINDS: SpeechItem['source']['kind'][] = ['scene', 'filler']

export class SpeechPool {
  /** 预合成任务的取消令牌（被挤出窗口时 abort） */
  private synthJobs = new Map<string, AbortController>()
  /** 最近一次实时通道降级原因（诊断用） */
  private lastRealtimeFallback = '' 
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService,
    private readonly broadcast: (snapshot: PoolSnapshot) => void,
    /** 实时语音通道（双向 WS）；不可用时动态内容降级到流式合成 */
    private readonly realtime: RealtimeChannelProbe = { available: () => false, unavailableReason: () => '实时语音未接入' }
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
    const text = input.text.trim()
    if (!text) throw new Error('话术内容为空')
    if (text.length > POOL_LIMITS.textMaxLength) {
      throw new Error(`单条话术最多 ${POOL_LIMITS.textMaxLength} 字`)
    }
    const lane = input.lane && SPEECH_LANES.includes(input.lane) ? input.lane : 'normal'
    const sourceKind =
      input.sourceKind && SPEECH_SOURCE_KINDS.includes(input.sourceKind) ? input.sourceKind : 'manual'
    const sourceAgentId = input.sourceAgentId?.trim() || 'human'

    // 限流：每来源每分钟 20 条
    const recent = this.storage.speechCountBySourceSince(sourceAgentId, sourceKind, Date.now() - 60_000)
    if (recent >= POOL_LIMITS.perSourcePerMinute) {
      throw new Error('该来源发言过于频繁（每分钟最多 20 条），稍后再试')
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
      sessionId: DEFAULT_SESSION_ID,
      text,
      turnId: input.turnId?.trim() || `turn-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      seq: input.seq ?? 0,
      voiceId: input.voiceId?.trim() ?? '',
      source: { agentId: sourceAgentId, kind: sourceKind },
      lane,
      dedupeKey: input.dedupeKey,
      expiresAt: input.expiresAt,
      replyTo: input.replyTo,
      status: 'pending',
      createdAt: Date.now()
    }
    this.storage.speechInsert(item)
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

  // ---------- 播放出口 ----------

  /** 取播出顺序上第一个 ready 条目并置 playing；没有就返回 null（调用方等待重试） */
  next(): SpeechItem | null {
    this.sweepExpired()
    const item = orderedForPlay(this.storage.speechActive()).find((entry) => entry.status === 'ready')
    if (!item) return null
    this.storage.speechUpdate(item.id, { status: 'playing' })
    this.refresh()
    return this.storage.speechGet(item.id)
  }

  /** 播报完成回报 */
  markDone(id: string): void {
    const item = this.storage.speechGet(id)
    if (!item) return
    this.storage.speechUpdate(id, { status: 'done', playedAt: Date.now() })
    this.storage.speechPrune()
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
    // 混合策略（tts.realtime 开启时）：
    // - 文本已知的剧情/暖场话术 → 照常预合成成文件（提前备好，播出零延迟）
    // - 文本动态的回复/互动/播报 → 标 ready+stream，播出时流式合成（首包延迟最低）
    const cfg = this.storage.getConfig()
    if (cfg.ttsRealtime.enabled && !this.realtime.available()) {
      // 实时语音通道不可用：记一次原因，动态内容降级到「语音合成」的流式
      this.lastRealtimeFallback = this.realtime.unavailableReason()
    }
    if (
      !PRE_SYNTH_KINDS.includes(item.source.kind) &&
      (this.realtime.available() || cfg.tts.realtime)
    ) {
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
      const audioPath = await this.tts.synthesize(item.id, textAtStart, item.voiceId || undefined, controller.signal)
      if (controller.signal.aborted) return
      const current = this.storage.speechGet(item.id)
      if (!current || current.text !== textAtStart) {
        // 文本在合成期间被修订：丢弃旧音频，回 pending 让窗口重合成
        this.storage.speechUpdate(item.id, { status: 'pending', audioPath: undefined, stream: false })
        this.refresh()
        return
      }
      this.storage.speechUpdate(item.id, { status: 'ready', audioPath, stream: false })
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
