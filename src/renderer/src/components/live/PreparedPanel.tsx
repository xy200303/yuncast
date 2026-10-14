import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  ListMusic,
  Loader2,
  Play,
  SkipBack,
  SkipForward
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../stores/useAppStore'
import {
  formatDurationMs,
  listProgramAudioUnits,
  type ProgramAudioUnit
} from '../../lib/audioUnits'
import type { Program, Script } from '../../../../shared/types'

/**
 * 预制节目（全部做好再播）的播控台中间区（docs/10 §11.5）：
 * 长音频播放器（当前章 / 时间 / 进度条 / seek / 上一章 / 下一章）+ 章节列表。
 *
 * 数据口径：章节 = 合成单元（lib/audioUnits，与主进程 programUnits 同一划分）；
 * 当前播放章由话术池 playing 条目的 dedupeKey（rendered:<kind>:<id>）对应；
 * 进度由主进程 AudioPipeline 按 250ms 节流推来（audio.onProgress）；
 * 章内 seek 走主进程 ffmpeg -ss 重启解码（audio.seekMain），章级跳转 = 跳播对应
 * speech_item（program.playUnit：提到队首 + 打断当前条目），都不是假 UI。
 */
export function PreparedPanel({ program }: { program: Program }) {
  const pool = useAppStore((s) => s.pool)
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  /** 主槽播放进度（itemId 对得上当前 playing 条目才采用） */
  const [progress, setProgress] = useState<{ itemId: string; positionMs: number } | null>(null)
  /** 拖动中的预览位置（松手才真正 seek，避免拖一路发一路 IPC） */
  const [dragMs, setDragMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [scripts, utterances] = await Promise.all([
      window.api.script.list(),
      window.api.utterance.list(program.id)
    ])
    const script: Script | null = scripts.find((s) => s.id === program.scriptId) ?? null
    setUnits(listProgramAudioUnits(program, script, utterances))
  }, [program])

  useEffect(() => {
    void load()
  }, [load])

  // 预制音频资产变化（重合成完成/失败）实时刷新章节状态
  useEffect(() => {
    return window.api.program.onAudioEvent((payload) => {
      if (payload.programId === program.id) void load()
    })
  }, [program.id, load])

  // 主进程播放进度（250ms 一拍）
  useEffect(() => {
    return window.api.audio.onProgress((payload) => {
      if (!payload.active) setProgress(null)
      else setProgress({ itemId: payload.itemId, positionMs: payload.positionMs })
    })
  }, [])

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  /** 待播的章节条目（dedupeKey = rendered:<kind>:<id>；插播内容不算章） */
  const queuedKeys = new Set(
    pool.items.filter((item) => item.status !== 'playing').map((item) => item.dedupeKey)
  )
  const currentIdx = playing
    ? units.findIndex((unit) => `rendered:${unit.kind}:${unit.id}` === playing.dedupeKey)
    : -1
  const currentUnit = currentIdx >= 0 ? units[currentIdx] : null

  const durationMs = currentUnit?.durationMs ?? 0
  const positionMs = progress && playing && progress.itemId === playing.id ? progress.positionMs : 0
  const shownMs = Math.min(dragMs ?? positionMs, durationMs || Number.MAX_SAFE_INTEGER)

  const seek = (ms: number): void => {
    setDragMs(null)
    void window.api.audio.seekMain(ms).then((result) => {
      if (!result.ok) toast.error('没能拖过去', { description: result.error })
    })
  }

  const playUnit = async (unit: ProgramAudioUnit): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.program.playUnit(program.id, { kind: unit.kind, id: unit.id })
      if (!result.ok) toast.error('没能跳过去', { description: result.error })
    } finally {
      setBusy(false)
    }
  }

  /** 上一章/下一章：当前没章在播时，「下一章」= 第一个就绪章 */
  const jumpBy = (delta: 1 | -1): void => {
    const readyIdxs = units.map((unit, i) => (unit.status === 'ready' ? i : -1)).filter((i) => i >= 0)
    if (readyIdxs.length === 0) return
    const targetIdx =
      currentIdx >= 0
        ? currentIdx + delta
        : delta > 0
          ? readyIdxs[0]
          : readyIdxs[readyIdxs.length - 1]
    const target = units[targetIdx]
    if (!target || target.status !== 'ready') return
    void playUnit(target)
  }

  const hasPrev = currentIdx > 0 && units.slice(0, currentIdx).some((unit) => unit.status === 'ready')
  const hasNext =
    currentIdx >= 0
      ? units.slice(currentIdx + 1).some((unit) => unit.status === 'ready')
      : units.some((unit) => unit.status === 'ready')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 长音频播放器：当前章 + 时间 + 进度条 + 章级跳转 */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ListMusic className="size-4 shrink-0 text-primary" />
          {playing ? (
            <>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={playing.text}>
                {currentUnit ? currentUnit.title : playing.text}
              </span>
              {!currentUnit && <Badge variant="secondary">插播内容</Badge>}
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              没有在播的章节——点下面某一章立即播，或从顶部启动节目
            </span>
          )}
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {formatDurationMs(shownMs)} / {durationMs > 0 ? formatDurationMs(durationMs) : '--:--'}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={busy || !hasPrev}
            onClick={() => jumpBy(-1)}
            title="上一章"
          >
            <SkipBack />
          </Button>
          <Slider
            className="flex-1"
            value={[durationMs > 0 ? Math.min(100, (shownMs / durationMs) * 100) : 0]}
            disabled={!playing || !currentUnit || durationMs <= 0}
            onValueChange={([v]) => setDragMs((v / 100) * durationMs)}
            onValueCommit={([v]) => seek((v / 100) * durationMs)}
          />
          <Button
            variant="outline"
            size="icon-sm"
            disabled={busy || !hasNext}
            onClick={() => jumpBy(1)}
            title="下一章"
          >
            <SkipForward />
          </Button>
        </div>
        {playing && !currentUnit && (
          <p className="mt-1 text-xs text-muted-foreground">
            正在播插播内容：进度条只对本节目的章节音频有效
          </p>
        )}
      </div>

      {/* 章节列表：标题 / 时长 / 状态，当前播放高亮；ready 的章点了就跳过去播 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 px-4 pt-2 pb-1 text-xs text-muted-foreground">
          章节 · {units.length}（点就绪的章立即跳播）
        </p>
        {units.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListMusic className="size-10" strokeWidth={1.25} />
            <p className="text-sm">这个节目还没有章节文稿，先到节目页写稿并生成节目音频</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
            {units.map((unit, index) => {
              const isCurrent = currentIdx === index
              const playable = unit.status === 'ready'
              return (
                <button
                  key={`${unit.kind}:${unit.id}`}
                  type="button"
                  disabled={!playable || busy}
                  onClick={() => void playUnit(unit)}
                  title={playable ? '跳播这一章' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-left transition-colors',
                    playable ? 'hover:bg-accent' : 'cursor-default opacity-80',
                    isCurrent && 'border-primary/50 bg-primary/5'
                  )}
                >
                  {unit.status === 'ready' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                  ) : unit.status === 'synthesizing' ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                  ) : unit.status === 'failed' ? (
                    <CircleAlert className="size-4 shrink-0 text-red-600" />
                  ) : unit.status === 'stale' ? (
                    <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{index + 1}</span>
                  <span
                    className={cn('min-w-0 flex-1 truncate text-[13px]', isCurrent && 'font-medium text-primary')}
                  >
                    {unit.title}
                  </span>
                  {queuedKeys.has(`rendered:${unit.kind}:${unit.id}`) && !isCurrent && (
                    <Badge variant="outline">待播</Badge>
                  )}
                  {isCurrent && <Badge>播报中</Badge>}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {unit.status === 'ready'
                      ? unit.durationMs
                        ? formatDurationMs(unit.durationMs)
                        : '已完成'
                      : unit.status === 'synthesizing'
                        ? '合成中…'
                        : unit.status === 'failed'
                          ? `失败：${unit.error || '合成失败'}`
                          : unit.status === 'stale'
                            ? '文稿已修改'
                            : '等待合成'}
                  </span>
                  {playable && !isCurrent && <Play className="size-3.5 shrink-0 text-muted-foreground/60" />}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
