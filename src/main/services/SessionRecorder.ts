import { randomUUID } from 'node:crypto'
import type { BroadcastEndReason, BroadcastSession, BroadcastSessionCastMember, LiveEvent } from '../../shared/types'
import { listEventTypes, type EventBus } from './EventBus'
import type { StorageService } from './StorageService'

const EVENT_LABELS = new Map(listEventTypes().map((entry) => [entry.type, entry.label]))

/** 不进场记时间线的事件：节拍器纯噪声，开播/收播由场次行本身表达 */
const SKIP_EVENT_TYPES = new Set(['timer.interval', 'stream.started', 'stream.ended'])

/**
 * 场记（场次记录）：一次开播的完整留档。
 * - begin：开播成功时建场次行，并挂事件总线镜像（评论/事件 → broadcast_events）；
 *   话术播出事实由 SpeechPool 把条目打上 session_id（音频不复制，blob_refs 保活）
 * - end：收播三处（自动/手动/紧急）统一收口，结算统计；重复调用幂等
 * - fixUnfinished：启动时给上次崩溃遗留的「还在播」场次补 end_reason='crash'
 */
export class SessionRecorder {
  /** 场次开始/结束：index.ts 接上 → 广播 data:changed('sessions')，场次/统计页自动重拉 */
  onChanged: (() => void) | null = null

  private activeId: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly bus: EventBus
  ) {}

  /** 当前活跃场次 id（没开播为 null）；SpeechPool 装池/合成时打在条目上 */
  current(): string | null {
    return this.activeId
  }

  /** 开播：建场次 + 开始镜像事件。已有活跃场次（异常路径）先按崩溃补尾再开新的 */
  begin(
    programId: string,
    programName: string,
    snapshot: { directorModelDesc: string; cast: BroadcastSessionCastMember[] }
  ): string {
    if (this.activeId) this.end('crash')
    const session: BroadcastSession = {
      id: `bs-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      programId,
      programName,
      directorModelDesc: snapshot.directorModelDesc,
      cast: snapshot.cast,
      startedAt: Date.now(),
      endedAt: 0,
      endReason: '',
      stats: { played: 0, comments: 0, replies: 0 },
      summary: ''
    }
    this.storage.sessionInsert(session)
    // 池里可能还有上一场的存货（收播不清池）：改挂到这场，谁播的算谁的
    this.storage.poolItemRestampActive(session.id)
    this.activeId = session.id
    this.unsubscribe = this.bus.subscribe((event) => this.mirror(event))
    this.onChanged?.()
    return session.id
  }

  /** 收播：结算统计 + 摘镜像。幂等——没活跃场次直接返回 */
  end(reason: BroadcastEndReason): void {
    this.onChanged?.()
    const id = this.activeId
    this.unsubscribe?.()
    this.unsubscribe = null
    this.activeId = null
    if (!id) return
    this.storage.sessionFinish(id, reason)
  }

  /** 启动补尾：上次进程没来得及收播的场次全部按 crash 结算 */
  fixUnfinished(): void {
    for (const session of this.storage.sessionListUnfinished()) {
      this.storage.sessionFinish(session.id, 'crash')
    }
  }

  /** 事件镜像：有活跃场次才落库；评论单独成 kind，其余事件带类型标签 */
  private mirror(event: LiveEvent): void {
    const sessionId = this.activeId
    if (!sessionId || SKIP_EVENT_TYPES.has(event.type)) return
    const payload: Record<string, unknown> =
      event.type === 'comment.new'
        ? { author: String(event.payload.author ?? '匿名'), content: String(event.payload.content ?? '') }
        : { type: event.type, label: EVENT_LABELS.get(event.type) ?? event.type, ...event.payload }
    this.storage.broadcastEventInsert({
      id: `be-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionId,
      ts: event.ts,
      kind: event.type === 'comment.new' ? 'comment' : 'event',
      payload
    })
  }
}
