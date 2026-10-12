import { randomUUID } from 'node:crypto'
import type { Utterance, UtteranceInput } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { TtsService } from './TtsService'

/**
 * 场次话术库（docs/07 §3 utterances）：场次底稿库，长期存在、可反复用、可编辑。
 * 与运行态 speech_items 分工：开播时按轮播规则从这里取件入池；
 * 直播中的改写不回写底稿（复盘采纳才回写，source='adopted'）。
 */
export class UtteranceService {
  constructor(
    private readonly storage: StorageService,
    private readonly tts: TtsService
  ) {}

  list(planId: string): Utterance[] {
    return this.storage.utteranceList(planId)
  }

  /** 生成 Agent 的 save_utterances 工具走这里：一次写一场景的一批变体 */
  saveMany(planId: string, sceneId: string, items: { text: string; sources?: Utterance['sources'] }[]): Utterance[] {
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
      text: input.text.trim(),
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
    this.storage.utteranceDelete(id)
  }

  /** 清空场次话术库（重生成前）；给 sceneId 只清某场景 */
  clear(planId: string, sceneId?: string): void {
    this.storage.utteranceDeleteWhere(planId, sceneId)
  }

  /**
   * 批量预合成（docs/07 §4 ④）：把场次里 pending/failed 的条目逐条合成就绪。
   * 逐条串行（TTS 限流安全），onProgress 逐条回报驱动审阅表状态刷新。
   */
  async synthesizeAll(
    planId: string,
    onProgress?: (u: Utterance) => void,
    signal?: AbortSignal
  ): Promise<{ done: number; failed: number }> {
    const pending = this.storage
      .utteranceList(planId)
      .filter((u) => u.status === 'pending' || u.status === 'failed')
    let done = 0
    let failed = 0
    for (const u of pending) {
      if (signal?.aborted) break
      this.storage.utteranceSetAudio(u.id, 'synthesizing', u.audioPath)
      onProgress?.({ ...u, status: 'synthesizing' })
      try {
        const audioPath = await this.tts.synthesize(`utterance-${u.id}`, u.text, u.voiceId || undefined, signal)
        this.storage.utteranceSetAudio(u.id, 'ready', audioPath)
        onProgress?.({ ...u, status: 'ready', audioPath })
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
}
