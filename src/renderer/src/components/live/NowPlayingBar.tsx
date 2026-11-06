import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { RecordIndicator } from './RecordControl'
import { AudioOutputDialog } from './AudioOutputDialog'
import { useAppStore } from '../../stores/useAppStore'
import { useLiveStore } from '../../stores/useLiveStore'
import { audioEngine } from '../../audio/engine'
import { pauseBroadcast, resumeBroadcast } from '../../audio/liveControl'
import { listProgramAudioUnits, type ProgramAudioUnit } from '../../lib/audioUnits'
import type { Program, Script, SessionConfig } from '../../../../shared/types'
import { stripSpeechTags } from '../../../../shared/speechTags'

/**
 * 直播台吸底播放条（docs/12 §7/§9）：像音乐播放器——**不放节目/角色选择**，
 * 只回答「播到哪、还能撑多久」和播出操作：播放/暂停、上一段/下一段、分量进度、音量、更多、结束本场。
 * 本场配置（语言/预设）在顶栏；这里不重复。
 */

/** 粗估时长：中文 4.5 字/秒，只用于「还能播多久」 */
function secondsOf(text: string): number {
  return Math.max(1, Math.round(stripSpeechTags(text).trim().length / 4.5))
}

function mmss(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, '0')} 秒`
}

export function NowPlayingBar({
  program,
  launchAction,
  endAction
}: {
  program: Program | null
  /** 未开播时左侧主 CTA（启动直播） */
  launchAction?: ReactNode
  /** 右侧「结束本场」 */
  endAction?: ReactNode
}) {
  const pool = useAppStore((s) => s.pool)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const agent = useAppStore((s) => s.agent)
  const activeProgramId = useAppStore((s) => s.config.live.activeProgramId)
  const history = useLiveStore((s) => s.history)
  const drafts = useLiveStore((s) => s.drafts)

  const [prepared, setPrepared] = useState(false)
  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(null)
  const masterVolume = useAppStore((s) => s.masterVolume)
  const setMasterVolume = useAppStore((s) => s.setMasterVolume)
  const [audioOpen, setAudioOpen] = useState(false)

  useEffect(() => {
    if (!('api' in window)) return
    const load = async () => {
      if (!activeProgramId) {
        setPrepared(false)
        setSessionConfig(null)
        return
      }
      const session = await window.api.sessionConfig.latest(activeProgramId)
      setPrepared(session?.synthMode === 'pre')
      setSessionConfig(session)
    }
    void load()
    return window.api.data.onChanged((payload) => {
      if (payload.scope === 'scripts') void load()
    })
  }, [activeProgramId, agent.live])

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  const running = agent.live === true

  // —— 预制节目的段级进度（按合成单元列的段列表） ——
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  const [progress, setProgress] = useState<{ itemId: string; positionMs: number } | null>(null)
  const [dragMs, setDragMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!program) return
    const [scripts, draftUnits] = await Promise.all([
      window.api.program.plans(),
      window.api.draftUnit.list(program.id)
    ])
    const script: Script | null = scripts.find((s) => s.id === program.id) ?? null
    setUnits(listProgramAudioUnits(program, script, draftUnits, sessionConfig))
  }, [program, sessionConfig])

  useEffect(() => {
    if (prepared) void load()
  }, [prepared, load])

  useEffect(() => {
    if (!prepared || !program) return
    return window.api.program.onAudioEvent((payload) => {
      if (payload.programId === program.id) void load()
    })
  }, [prepared, program, load])

  useEffect(() => {
    if (!prepared) return
    return window.api.audio.onProgress((payload) => {
      if (!payload.active) setProgress(null)
      else setProgress({ itemId: payload.itemId, positionMs: payload.positionMs })
    })
  }, [prepared])

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
    if (busy || !program) return
    setBusy(true)
    try {
      const result = await window.api.program.playUnit(program.id, { kind: unit.kind, id: unit.id })
      if (!result.ok) toast.error('没能跳过去', { description: result.error })
    } finally {
      setBusy(false)
    }
  }

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

  // —— 播放条上的水位：已播 / 就绪 / 待合成三段 ——
  const readyItems = pool.items.filter((item) => item.status === 'ready' || item.status === 'playing')
  const pendingItems = pool.items.filter((item) => item.status === 'pending' || item.status === 'synthesizing')
  const total = running ? history.length + readyItems.length + pendingItems.length : drafts.length
  const playedCount = running ? history.length : 0
  const readyCount = running ? readyItems.length : 0
  const pendingCount = running ? pendingItems.length : drafts.length
  const readySec = readyItems.reduce((sum, item) => sum + secondsOf(item.text), 0)
  const currentNo = running ? Math.min(playedCount + (playing ? 1 : 0), total) : 0
  const playedPct = total > 0 ? (playedCount / total) * 100 : 0
  const readyPct = total > 0 ? (readyCount / total) * 100 : 0

  const seekable = prepared && Boolean(playing && currentUnit) && durationMs > 0
  const playedPctOfUnit = durationMs > 0 ? Math.min(100, (shownMs / durationMs) * 100) : 0
  const seekFromEvent = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    return ratio * durationMs
  }

  return (
    <div className="shrink-0 bg-card/60">
      {/* 预制音频的细进度线（有确定时长才出现）：拖动 seek */}
      {seekable && (
        <div
          className="group relative h-1 cursor-pointer bg-muted/70"
          title="按住拖动跳到指定位置"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragMs(seekFromEvent(event))
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return
            setDragMs(seekFromEvent(event))
          }}
          onPointerUp={(event) => {
            const target = seekFromEvent(event)
            setDragMs(null)
            seek(target)
          }}
        >
          <div className="pointer-events-none h-full bg-primary" style={{ width: `${playedPctOfUnit}%` }} />
          <div
            className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${playedPctOfUnit}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* 左：未开播 = 启动直播；直播中 = 播放/暂停 */}
        {!running ? (
          launchAction
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-primary"
            onClick={() => (loopRunning ? pauseBroadcast() : resumeBroadcast())}
            title={loopRunning ? '暂停：停播报，也让导演先别生成新话术' : '继续播报'}
          >
            {loopRunning ? <Pause className="size-5" /> : <Play className="size-5" />}
          </Button>
        )}

        {/* 序号 03/23 */}
        <span className="w-14 shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
          {running ? `${String(currentNo).padStart(2, '0')}/${String(total).padStart(2, '0')}` : '未开播'}
        </span>

        {/* 水位进度条：已播 / 就绪 / 待合成（三段平滑填充 + 当前位置圆点） */}
        <div
          className="relative flex h-5 min-w-[140px] flex-1 items-center"
          title={
            running
              ? `已播 ${playedCount} 段 · 就绪 ${readyCount} 段 · 待合成 ${pendingCount} 段`
              : `${pendingCount} 段底稿待播`
          }
        >
          <div className="relative h-[6px] w-full overflow-hidden rounded-full bg-muted/80 shadow-[inset_0_1px_1px_rgba(0,0,0,.06)]">
            <div
              className="absolute inset-y-0 left-0 bg-foreground/20"
              style={{ width: `${playedPct}%` }}
            />
            <div
              className="absolute inset-y-0 bg-gradient-to-r from-primary/40 to-primary/60"
              style={{ left: `${playedPct}%`, width: `${readyPct}%` }}
            />
            <div
              className="absolute inset-y-0 bg-gradient-to-r from-muted-foreground/[0.06] to-muted-foreground/[0.14]"
              style={{ left: `${playedPct + readyPct}%`, right: 0 }}
            />
          </div>
          {running && total > 0 && (
            <span
              className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-sm"
              style={{ left: `${playedPct}%` }}
            />
          )}
        </div>

        {/* 还能播多久 */}
        <span className="w-28 shrink-0 text-[12px] text-muted-foreground">
          {running
            ? readySec > 0
              ? `还能播 ${mmss(readySec)}`
              : '缓冲见底'
            : `${drafts.length} 段待播`}
        </span>

        <RecordIndicator />

        {/* 音量 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAudioOpen(true)}
            title="声音输出：选择设备、调各自音量"
          >
            {masterVolume > 0 ? <Volume2 /> : <VolumeX />}
          </Button>
          <Slider
            className="w-24"
            value={[masterVolume]}
            min={0}
            max={100}
            step={1}
            aria-label="主音量"
            onValueChange={([v]) => setMasterVolume(v)}
          />
        </div>

        {/* 传输控制：上一段（预制）/ 下一段 / 队列 / 结束 */}
        {running && (
          <div className="flex shrink-0 items-center gap-0.5">
            {prepared && (
              <Button variant="ghost" size="icon-sm" disabled={busy || !hasPrev} onClick={() => jumpBy(-1)} title="上一段">
                <SkipBack />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy || (!prepared && !playing) || (prepared && !hasNext)}
              onClick={() => {
                if (prepared && hasNext) {
                  jumpBy(1)
                  return
                }
                audioEngine.stopCurrent()
                toast.message('已跳过当前这条', { description: '接着播队列里的下一条' })
              }}
              title={prepared ? '下一段' : '跳过当前这条，播下一条'}
            >
              {busy && prepared ? <Loader2 className="animate-spin" /> : <SkipForward />}
            </Button>
          </div>
        )}

        {running && endAction}
      </div>

      <AudioOutputDialog open={audioOpen} onOpenChange={setAudioOpen} />
    </div>
  )
}
