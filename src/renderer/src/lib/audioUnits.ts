import type { ContentType, Program, RenderedAudioStatus, Script, Utterance } from '../../../shared/types'
import { sceneFingerprint, utteranceFingerprint } from '../../../shared/fingerprint'

/**
 * 预制节目合成单元的渲染层镜像（docs/10 §7.6-§7.7）：
 * 与主进程 services/programUnits.ts 同一份划分口径（场景类节目每章一个单元、
 * 一个人讲每段一个单元、没挂场景的段落退化为段级单元），只读数据渲染层自己拿得到
 * （script.list / utterance.list），不新增 IPC。
 *
 * 与主进程的唯一差异：渲染层查不了文件是否还在磁盘上（existsSync）。
 * 「ready 但文件丢了」这种行由门禁 failures 覆盖显示（ProgramAudioPanel 里合并）。
 */

export interface ProgramAudioUnit {
  kind: 'scene' | 'utterance'
  /** sceneId 或 utteranceId */
  id: string
  /** 展示标题：章用场景名，段用文本开头 */
  title: string
  status: RenderedAudioStatus
  /** 就绪单元的音频时长（毫秒） */
  durationMs?: number
  /** 失败原因（中文，合成时写入） */
  error?: string
  /** 用户导入的外部音频（不参与重新合成） */
  external?: boolean
  audioPath?: string
}

/** 合成单元的称呼（节目音频进度文案用）：跟着内容类型走，不出现工程术语 */
export const AUDIO_UNIT_LABEL: Record<ContentType, string> = {
  solo: '段',
  conversation: '个环节',
  reading: '章',
  roleplay: '场'
}

/** 段落在单元内的叙事顺序：创作序号优先，其次入库时间（与主进程 narrativeOrder 一致） */
function narrativeOrder(list: Utterance[]): Utterance[] {
  return [...list].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

function segmentTitle(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text
}

/** 列出节目的全部合成单元，并算出每个单元的当前有效状态 */
export function listProgramAudioUnits(
  program: Program,
  script: Script | null,
  utterances: Utterance[]
): ProgramAudioUnit[] {
  const unitOf = (
    kind: ProgramAudioUnit['kind'],
    id: string,
    title: string,
    fingerprint: string,
    rendered?: Utterance['rendered']
  ): ProgramAudioUnit => {
    // 就绪但文稿指纹已不一致 → 按过期展示（不落库也拦得住，与主进程 unitStatus 同口径）
    const status: RenderedAudioStatus = !rendered
      ? 'pending'
      : rendered.status === 'ready' && rendered.sourceFingerprint !== fingerprint
        ? 'stale'
        : rendered.status
    return {
      kind,
      id,
      title,
      status,
      durationMs: rendered?.durationMs,
      error: rendered?.error,
      external: rendered?.external,
      audioPath: rendered?.audioPath
    }
  }

  if (program.contentType === 'solo') {
    return utterances.map((u) => unitOf('utterance', u.id, segmentTitle(u.text), utteranceFingerprint(u), u.rendered))
  }
  const byScene = new Map<string, Utterance[]>()
  for (const u of utterances) {
    const list = byScene.get(u.sceneId) ?? []
    list.push(u)
    byScene.set(u.sceneId, list)
  }
  const units: ProgramAudioUnit[] = []
  for (const scene of script?.scenes ?? []) {
    const list = narrativeOrder(byScene.get(scene.id) ?? [])
    if (list.length === 0) continue // 没有文稿的场景不产生单元（没有要合成的声音）
    units.push(unitOf('scene', scene.id, scene.title, sceneFingerprint(list), scene.rendered))
  }
  // 全场通用段（没挂场景）：场景类节目里它们是独立的段级单元
  for (const u of narrativeOrder(byScene.get('') ?? [])) {
    units.push(unitOf('utterance', u.id, segmentTitle(u.text), utteranceFingerprint(u), u.rendered))
  }
  return units
}

/** 时长展示：28:40 / 1:12:03 */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}
