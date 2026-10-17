import type { ViewerProfile } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 记忆服务（docs/01 §3.6）。
 * 长期记忆 = 老粉画像 viewer_profiles；下播复盘摘要直接写进场次（live_sessions.summary）。
 * 场内记忆由 pi 会话上下文 + 自动压缩天然覆盖，不用单独做。
 */

/** asks / notes 各保留最近 20 条 */
const HISTORY_CAP = 20

export class MemoryService {
  constructor(private readonly storage: StorageService) {}

  /** 查观众画像；没见过返回 null（新客） */
  lookupViewer(name: string): ViewerProfile | null {
    return this.storage.viewerGet(name.trim())
  }

  /** 评论来了记一次互动（questions 进 asks），返回更新后的画像 */
  touchViewer(name: string, question?: string): ViewerProfile {
    const profile = this.ensure(name)
    profile.interactions += 1
    profile.lastSeenAt = Date.now()
    if (question?.trim()) {
      profile.asks = [question.trim(), ...profile.asks].slice(0, HISTORY_CAP)
    }
    this.storage.viewerSave(profile)
    return profile
  }

  /** 主播主动记一笔：remember_viewer 工具。互动计数 +1，note 进 notes */
  rememberViewer(name: string, note: string): ViewerProfile {
    const trimmed = note.trim()
    if (!trimmed) throw new Error('要记住的内容为空')
    const profile = this.ensure(name)
    profile.interactions += 1
    profile.lastSeenAt = Date.now()
    profile.notes = [trimmed, ...profile.notes].slice(0, HISTORY_CAP)
    this.storage.viewerSave(profile)
    return profile
  }

  /** 画像 → 给主播看的一句话摘要（注入评论 prompt 用） */
  describeViewer(profile: ViewerProfile): string {
    const parts = [`互动 ${profile.interactions} 次`]
    if (profile.asks.length > 0) parts.push(`问过：${profile.asks.slice(0, 3).join('；')}`)
    if (profile.tags.length > 0) parts.push(`标签：${profile.tags.join('、')}`)
    if (profile.notes.length > 0) parts.push(`你记过：${profile.notes.slice(0, 3).join('；')}`)
    return parts.join('，')
  }

  /** 下播复盘摘要写进场次（场记详情与 session_history 工具都读 live_sessions.summary） */
  saveSessionSummary(sessionId: string, summary: string): void {
    const text = summary.trim()
    if (text) this.storage.sessionSetSummary(sessionId, text)
  }

  private ensure(name: string): ViewerProfile {
    const key = name.trim()
    return (
      this.storage.viewerGet(key) ?? {
        name: key,
        interactions: 0,
        asks: [],
        tags: [],
        notes: [],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now()
      }
    )
  }
}
