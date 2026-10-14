import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  FileAudio,
  Loader2,
  Play,
  RefreshCw,
  Square,
  AudioWaveform
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  type Program,
  type ProgramGateFailure,
  type ProgramGateResult,
  type Script
} from '../../../../shared/types'
import {
  AUDIO_UNIT_LABEL,
  formatDurationMs,
  listProgramAudioUnits,
  type ProgramAudioUnit
} from '../../lib/audioUnits'

/**
 * 预制节目的音频进度区（docs/10 §7.7）：挂在底稿库顶部。
 * 单元行（章/段）在渲染层按与主进程相同的口径算出来（lib/audioUnits），
 * 计数与「文件丢了」这类行级原因走正式门禁（program.playGate）的结果合并显示；
 * 合成进度靠 program.onAudioEvent 实时刷新。
 */
export function ProgramAudioPanel({
  program,
  onChanged
}: {
  program: Program
  /** 产物变化后通知父级刷新统计（节目卡摘要等） */
  onChanged?: () => void | Promise<void>
}) {
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  const [gate, setGate] = useState<ProgramGateResult | null>(null)
  const [producing, setProducing] = useState(false)
  const [previewingId, setPreviewingId] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const unitLabel = AUDIO_UNIT_LABEL[program.contentType]

  const load = useCallback(async () => {
    const [scripts, utterances, gateResult] = await Promise.all([
      window.api.script.list(),
      window.api.utterance.list(program.id),
      window.api.program.playGate(program.id)
    ])
    const script: Script | null = scripts.find((s) => s.id === program.scriptId) ?? null
    setUnits(listProgramAudioUnits(program, script, utterances))
    setGate(gateResult)
  }, [program])

  useEffect(() => {
    void load()
  }, [load])

  // 预制音频资产变化（合成中/完成/失败）实时刷新
  useEffect(() => {
    return window.api.program.onAudioEvent((payload) => {
      if (payload.programId === program.id) void load()
    })
  }, [program.id, load])

  // 卸载时停掉试听
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  /** 门禁 failures 按单元 id 索引：行显示以它为准（能覆盖「就绪但文件被移走」这种渲染层查不到的情况） */
  const failureOf = (unit: ProgramAudioUnit): ProgramGateFailure | undefined =>
    gate?.failures.find((f) => f.unitId === unit.id && f.unitKind === unit.kind)

  const produce = async () => {
    if (producing) return
    setProducing(true)
    try {
      const result = await window.api.program.produceAudio(program.id)
      if (!result.ok) {
        toast.error('生成节目音频没能完成', { description: result.error })
      } else if (result.failed > 0) {
        toast.warning(`生成完成，还有 ${result.failed} ${unitLabel}失败`, {
          description: `完成 ${result.done} · 跳过 ${result.skipped} · 失败 ${result.failed}，失败项点「重试」`
        })
      } else {
        toast.success('节目音频已全部生成', {
          description:
            `完成 ${result.done} · 跳过 ${result.skipped}` + (result.notice ? `；${result.notice}` : '')
        })
      }
    } finally {
      setProducing(false)
      await load()
      await onChanged?.()
    }
  }

  /** 重试失败项 / 重新合成过期项：统一入口会只重做失败、过期与未合成的单元，已就绪且文稿未改的自动跳过 */
  const redo = async () => {
    await produce()
  }

  const stopPreview = () => {
    audioRef.current?.pause()
    audioRef.current = null
    setPreviewingId('')
  }

  const togglePreview = (unit: ProgramAudioUnit) => {
    if (previewingId === unit.id) {
      stopPreview()
      return
    }
    stopPreview()
    if (!unit.audioPath) return
    // 渲染层直接放本地文件（打包版 file:// 页面可读）；dev server（http 源）读不了本地文件，走 error 提示
    const audio = new Audio(`file:///${encodeURI(unit.audioPath.replace(/\\/g, '/'))}`)
    audio.onended = () => stopPreview()
    audio.onerror = () => {
      stopPreview()
      toast.error('试听失败', {
        description: '音频文件打不开（可能已被移动或清理；开发模式下页面读不了本地文件，打包后正常）'
      })
    }
    audioRef.current = audio
    setPreviewingId(unit.id)
    void audio.play().catch(() => undefined)
  }

  const importExternal = async (unit: ProgramAudioUnit) => {
    setImportOpen(false)
    const result = await window.api.program.importAudio(program.id, { kind: unit.kind, id: unit.id })
    if (result.ok) {
      toast.success('已导入外部音频', { description: `挂到「${unit.title}」，跳过语音合成` })
      await load()
      await onChanged?.()
    } else if (result.error !== '已取消') {
      toast.error('导入失败', { description: result.error })
    }
  }

  const counts = gate ?? { total: units.length, ready: 0, synthesizing: 0, pending: 0, failed: 0, stale: 0 }

  return (
    <div className="shrink-0 rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-medium">
          节目音频：{counts.ready} / {counts.total} {unitLabel}完成
          {(counts.failed > 0 || counts.stale > 0 || counts.synthesizing > 0) && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {counts.synthesizing > 0 && `合成中 ${counts.synthesizing} · `}
              {counts.failed > 0 && `失败 ${counts.failed} · `}
              {counts.stale > 0 && `文稿已修改 ${counts.stale} · `}
              {counts.pending > 0 && `待合成 ${counts.pending}`}
            </span>
          )}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={counts.total === 0} onClick={() => setImportOpen(true)}>
            <FileAudio />
            导入外部音频
          </Button>
          <Button size="sm" disabled={producing || counts.total === 0} onClick={() => void produce()}>
            {producing ? <Loader2 className="animate-spin" /> : <AudioWaveform />}
            {producing ? '正在生成…' : counts.ready > 0 ? '继续生成节目音频' : '生成节目音频'}
          </Button>
        </div>
      </div>

      {units.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">还没有文稿，先让主播写稿，文稿定了再生成节目音频。</p>
      ) : (
        <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
          {units.map((unit) => (
            <UnitRow
              key={`${unit.kind}:${unit.id}`}
              unit={unit}
              failure={failureOf(unit)}
              producing={producing}
              previewing={previewingId === unit.id}
              onPreview={() => togglePreview(unit)}
              onRedo={() => void redo()}
            />
          ))}
        </div>
      )}

      {/* 导入外部音频：先选挂到哪一章/段，再由主进程弹文件选择框 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>导入外部音频</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            选一段现成的录音（mp3 / wav / m4a）挂到下面某个{unitLabel}：这一段跳过语音合成，直接进入试听、播放和导出。
          </p>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {units.map((unit) => (
              <button
                key={`${unit.kind}:${unit.id}`}
                type="button"
                onClick={() => void importExternal(unit)}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{unit.title}</span>
                {unit.external && <span className="shrink-0 text-xs text-muted-foreground">已是外部音频，会替换</span>}
                {unit.status === 'ready' && !unit.external && (
                  <span className="shrink-0 text-xs text-muted-foreground">已有音频，会替换</span>
                )}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function UnitRow({
  unit,
  failure,
  producing,
  previewing,
  onPreview,
  onRedo
}: {
  unit: ProgramAudioUnit
  failure?: ProgramGateFailure
  producing: boolean
  previewing: boolean
  onPreview: () => void
  onRedo: () => void
}) {
  // 门禁把「就绪但文件不在」也列为失败：以门禁的原因为准显示
  const failedReason =
    unit.status === 'failed' ? unit.error || '合成失败' : failure && unit.status === 'ready' ? failure.reason : undefined
  const actionable = unit.status === 'failed' || unit.status === 'stale'

  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
      {unit.status === 'ready' && !failedReason ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
      ) : unit.status === 'synthesizing' ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
      ) : unit.status === 'failed' || failedReason ? (
        <CircleAlert className="size-4 shrink-0 text-red-600" />
      ) : unit.status === 'stale' ? (
        <AlertTriangle className="size-4 shrink-0 text-amber-500" />
      ) : (
        <Circle className="size-4 shrink-0 text-muted-foreground/50" />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {unit.title}
        {unit.external && <span className="ml-1 text-xs text-muted-foreground">（外部音频）</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {unit.status === 'ready' && !failedReason
          ? unit.durationMs
            ? formatDurationMs(unit.durationMs)
            : '已完成'
          : unit.status === 'synthesizing'
            ? '合成中…'
            : failedReason
              ? `失败：${failedReason}`
              : unit.status === 'stale'
                ? '文稿已修改'
                : '等待合成'}
      </span>
      {unit.status === 'ready' && !failedReason && (
        <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={onPreview}>
          {previewing ? <Square /> : <Play />}
          {previewing ? '停止' : '试听'}
        </Button>
      )}
      {actionable && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={producing}
          onClick={onRedo}
          title="只重做失败和过期的部分，已完成的自动跳过"
        >
          <RefreshCw />
          {unit.status === 'stale' ? '重新合成' : '重试'}
        </Button>
      )}
    </div>
  )
}
