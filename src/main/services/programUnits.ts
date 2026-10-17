import { existsSync } from 'node:fs'
import type {
  Program,
  ProgramAudioProgress,
  ProgramGateFailure,
  ProgramGateResult,
  RenderedAudioRef,
  Script,
  DraftUnit
} from '../../shared/types'
import { programStyleSalt, sceneFingerprint, utteranceFingerprint } from '../../shared/fingerprint'

/**
 * 预制节目的合成单元与门禁判定（docs/10 §7.5-§7.8）。
 * 纯函数模块：生产入口（DraftUnitService.produceProgramAudio）、播放门禁与装播
 * （ProgramPlaybackService）、Agent 工具的进度统计共用同一份单元划分与判定口径。
 *
 * 合成单元按内容类型划分（§7.6 可独立重试的自然内容单位）：
 * - reading/conversation/roleplay：每 Scene（章/环节/场）一个单元；
 * - solo：每段（DraftUnit）一个单元；
 * - 没挂到任何场景的段落（sceneId=''）在场景类节目里退化为独立的段级单元。
 * 没有文稿的场景不产生单元（没有要合成的声音）。
 */
export interface AudioUnit {
  kind: 'scene' | 'utterance'
  /** sceneId 或 utteranceId */
  id: string
  /** 展示标题：章用场景名，段用文本开头 */
  title: string
  /** 当前文稿指纹：与 rendered.sourceFingerprint 不一致 → 过期 */
  fingerprint: string
  /** 单元内段落（场景单元 = 该章全部段，按叙事顺序；段单元 = 单条） */
  draftUnits: DraftUnit[]
  /** 已有的预制音频资产 */
  rendered?: RenderedAudioRef
}

/** 段落在单元内的叙事顺序：创作序号优先，其次入库时间 */
export function narrativeOrder(list: DraftUnit[]): DraftUnit[] {
  return [...list].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

export function listAudioUnits(
  program: Program,
  script: Script | null,
  draftUnits: DraftUnit[]
): AudioUnit[] {
  // 节目级风格指令进指纹：改它 = 全部单元过期重合成（空盐时与旧版指纹一致）
  const styleSalt = programStyleSalt(program)
  if (program.contentType === 'solo') {
    return draftUnits.map((u) => ({
      kind: 'utterance' as const,
      id: u.id,
      title: u.text.length > 20 ? `${u.text.slice(0, 20)}…` : u.text,
      fingerprint: utteranceFingerprint(u, styleSalt),
      draftUnits: [u],
      rendered: u.rendered
    }))
  }
  const byScene = new Map<string, DraftUnit[]>()
  for (const u of draftUnits) {
    const list = byScene.get(u.sceneId) ?? []
    list.push(u)
    byScene.set(u.sceneId, list)
  }
  const units: AudioUnit[] = []
  for (const scene of script?.scenes ?? []) {
    const list = narrativeOrder(byScene.get(scene.id) ?? [])
    if (list.length === 0) continue
    units.push({
      kind: 'scene',
      id: scene.id,
      title: scene.title,
      fingerprint: sceneFingerprint(list, styleSalt),
      draftUnits: list,
      rendered: scene.rendered
    })
  }
  // 全场通用段（没挂场景）：场景类节目里它们是独立段级单元
  for (const u of narrativeOrder(byScene.get('') ?? [])) {
    units.push({
      kind: 'utterance',
      id: u.id,
      title: u.text.length > 20 ? `${u.text.slice(0, 20)}…` : u.text,
      fingerprint: utteranceFingerprint(u, styleSalt),
      draftUnits: [u],
      rendered: u.rendered
    })
  }
  return units
}

/** 单元的当前有效状态：就绪但文稿指纹已不一致的按 stale 算（不落库也拦得住） */
function unitStatus(unit: AudioUnit): RenderedAudioRef['status'] | 'missing' {
  const rendered = unit.rendered
  if (!rendered) return 'pending'
  if (rendered.status === 'ready' && rendered.sourceFingerprint !== unit.fingerprint) return 'stale'
  return rendered.status
}

/** 节目音频进度统计（节目内进度展示 + get_program 工具） */
export function audioProgress(
  program: Program,
  script: Script | null,
  draftUnits: DraftUnit[]
): ProgramAudioProgress {
  const progress: ProgramAudioProgress = { total: 0, ready: 0, synthesizing: 0, pending: 0, failed: 0, stale: 0 }
  for (const unit of listAudioUnits(program, script, draftUnits)) {
    progress.total++
    const status = unitStatus(unit)
    if (status === 'ready') {
      // 文件真没了按失败计（外部音频被移走等情况）
      if (existsSync(unit.rendered!.audioPath)) progress.ready++
      else progress.failed++
    } else if (status === 'synthesizing') progress.synthesizing++
    else if (status === 'failed') progress.failed++
    else if (status === 'stale') progress.stale++
    else progress.pending++
  }
  return progress
}

/**
 * 预制节目正式播放门禁（docs/10 §7.8）：所有单元 ready + 文件真实存在 + 指纹一致才算通过。
 * 不通过时返回结构化结果（各状态计数 + 失败原因列表），调用方不静默跳过。
 */
export function evaluateGate(
  program: Program,
  script: Script | null,
  draftUnits: DraftUnit[]
): ProgramGateResult {
  const result: ProgramGateResult = {
    ok: false,
    programId: program.id,
    total: 0,
    ready: 0,
    synthesizing: 0,
    pending: 0,
    failed: 0,
    stale: 0,
    failures: []
  }
  const fail = (unit: AudioUnit, status: ProgramGateFailure['status'], reason: string) => {
    result.failures.push({ unitKind: unit.kind, unitId: unit.id, title: unit.title, status, reason })
  }
  for (const unit of listAudioUnits(program, script, draftUnits)) {
    result.total++
    const rendered = unit.rendered
    const status = unitStatus(unit)
    if (status === 'pending') {
      result.pending++
      fail(unit, rendered ? 'pending' : 'missing', '还没合成')
      continue
    }
    if (status === 'synthesizing') {
      result.synthesizing++
      fail(unit, 'synthesizing', '合成中，等它完成')
      continue
    }
    if (status === 'stale') {
      result.stale++
      fail(unit, 'stale', '文稿已修改，音频与当前文稿不一致（需重新合成或明确使用旧音频）')
      continue
    }
    if (status === 'failed') {
      result.failed++
      fail(unit, 'failed', rendered?.error || '合成失败')
      continue
    }
    // ready：文件必须真实存在
    if (!rendered || !existsSync(rendered.audioPath)) {
      result.failed++
      fail(unit, 'ready', '音频文件不存在（可能被移动或清理）')
      continue
    }
    result.ready++
  }
  if (result.total === 0) {
    result.failures.push({
      unitKind: 'utterance',
      unitId: '',
      title: '',
      status: 'missing',
      reason: '节目还没有文稿，没有可合成的音频'
    })
  }
  result.ok = result.total > 0 && result.ready === result.total
  return result
}
