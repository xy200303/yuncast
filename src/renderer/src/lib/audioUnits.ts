import type { ContentType, Program, RenderedAudioStatus, Script, DraftUnit } from '../../../shared/types'
import { programStyleSalt, sceneFingerprint, draftUnitFingerprint } from '../../../shared/fingerprint'
import { stripSpeechTags } from '../../../shared/speechTags'

/**
 * 预制节目合成单元的渲染层镜像（docs/10 §7.6-§7.7）：
 * 与主进程 services/programUnits.ts 同一份划分口径（场景类节目每章一个单元、
 * 一个人讲每段一个单元、没挂场景的段落退化为段级单元），只读数据渲染层自己拿得到
 * （script.list / draftUnit.list），不新增 IPC。
 *
 * 与主进程的唯一差异：渲染层查不了文件是否还在磁盘上（existsSync）。
 * 「ready 但文件丢了」这种行由门禁 failures 覆盖显示（ProgramAudioPanel 里合并）。
 */

export interface ProgramAudioUnit {
  kind: 'scene' | 'draftUnit'
  /** sceneId 或 draftUnitId */
  id: string
  /** 展示标题：章用场景名，段用文本开头 */
  title: string
  /** 这一章的完整文稿（章=该场景全部段落按叙事顺序拼接；段=该段文本）：列表里要给人看全文 */
  text: string
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

/**
 * 段卡片的 caption（docs/11 第一部分）：只回答"这是什么位置"（类型 + 序号），
 * 不引入内容语义（"开场""高潮"这类交给 agent 写进标题）。
 * total 用于区分 solo 单段（一篇短文 → 正文）与多段（第 N 段）。
 */
export function unitCaption(program: Program, unit: ProgramAudioUnit, index: number, total = 1): string {
  if (program.contentType === 'solo') return total <= 1 ? '正文' : `第 ${index + 1} 段`
  if (unit.kind === 'draftUnit') return '散段'
  if (program.contentType === 'reading') return `第 ${index + 1} 章`
  if (program.contentType === 'roleplay') return `第 ${index + 1} 场`
  return `环节 ${index + 1}`
}

/** 段落在单元内的叙事顺序：创作序号优先，其次入库时间（与主进程 narrativeOrder 一致） */
function narrativeOrder(list: DraftUnit[]): DraftUnit[] {
  return [...list].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

function segmentTitle(text: string): string {
  const clean = stripSpeechTags(text)
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean
}

/** 列出节目的全部合成单元，并算出每个单元的当前有效状态 */
export function listProgramAudioUnits(
  program: Program,
  script: Script | null,
  draftUnits: DraftUnit[]
): ProgramAudioUnit[] {
  // 与主进程 listAudioUnits 同口径：节目级风格指令进指纹盐（空盐时与旧版一致）
  const styleSalt = programStyleSalt(program)
  const unitOf = (
    kind: ProgramAudioUnit['kind'],
    id: string,
    title: string,
    text: string,
    fingerprint: string,
    rendered?: DraftUnit['rendered']
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
      text,
      status,
      durationMs: rendered?.durationMs,
      error: rendered?.error,
      external: rendered?.external,
      audioPath: rendered?.audioPath
    }
  }

  if (program.contentType === 'solo') {
    return draftUnits.map((u) => unitOf('draftUnit', u.id, segmentTitle(u.text), u.text, draftUnitFingerprint(u, styleSalt), u.rendered))
  }
  const byScene = new Map<string, DraftUnit[]>()
  for (const u of draftUnits) {
    const list = byScene.get(u.sceneId) ?? []
    list.push(u)
    byScene.set(u.sceneId, list)
  }
  const units: ProgramAudioUnit[] = []
  for (const scene of script?.scenes ?? []) {
    const list = narrativeOrder(byScene.get(scene.id) ?? [])
    if (list.length === 0) continue // 没有文稿的场景不产生单元（没有要合成的声音）
    units.push(unitOf('scene', scene.id, scene.title, list.map((u) => u.text).join('\n'), sceneFingerprint(list, styleSalt), scene.rendered))
  }
  // 全场通用段（没挂场景）：场景类节目里它们是独立的段级单元
  for (const u of narrativeOrder(byScene.get('') ?? [])) {
    units.push(unitOf('draftUnit', u.id, segmentTitle(u.text), u.text, draftUnitFingerprint(u, styleSalt), u.rendered))
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
