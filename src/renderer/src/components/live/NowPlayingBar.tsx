import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ListMusic, Loader2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { RecordIndicator } from './RecordControl'
import type { Persona } from '../../../../shared/types'
import { useAppStore } from '../../stores/useAppStore'
import { voiceRouteSummary } from '../../lib/voice'
import { audioEngine } from '../../audio/engine'
import { pauseBroadcast, resumeBroadcast } from '../../audio/liveControl'
import { formatDurationMs, listProgramAudioUnits, type ProgramAudioUnit } from '../../lib/audioUnits'
import type { Program, Script } from '../../../../shared/types'

/**
 * 直播台吸底的 NowPlayingBar（docs/REDESIGN 4.6）：音乐播放器式，三种播出模式统一。
 * 状态 + 当前内容摘要 + 统一控制（暂停/继续、跳过、急停声音、主音量）；
 * 预制节目（prepared）额外有段级进度条 + seek + 上一段/下一段，
 * 数据口径与原 PreparedPanel 播放器一致（dedupeKey = rendered:<kind>:<id>，onProgress 250ms 一拍）。
 */
export function NowPlayingBar({
  program,
  actions,
  onFocusQueue,
  programPicker,
  launchAction,
  endAction
}: {
  program: Program | null
  /** 播放条最右的额外动作槽（直播台把「⋯」菜单放这儿） */
  actions?: ReactNode
  /** 点「队列」跳到直播台主体列表（[接下来] tab） */
  onFocusQueue?: () => void
  /** 左槽副标题里的节目选择（未开播可换，直播中只读） */
  programPicker?: ReactNode
  /** 中槽：未开播时替代传输控制的主 CTA（启动节目） */
  launchAction?: ReactNode
  /** 中槽右侧：直播中的「结束本场」（红字 + 二次确认） */
  endAction?: ReactNode
}) {
  const pool = useAppStore((s) => s.pool)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const agent = useAppStore((s) => s.agent)
  const voices = useAppStore((s) => s.voices)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const activeProgramId = useAppStore((s) => s.config.live.activeProgramId)
  /** 节目卡司第一张：名字与嗓音必须同源（别再拿全局默认卡的声音配卡司的名字） */
  const [castCard, setCastCard] = useState<Persona | null>(null)
  const [masterVolume, setMasterVolume] = useState(Math.round(audioEngine.volume * 100))
  /** 上一次"有声"的音量：点静音再点回来时恢复它 */
  const lastAudible = useRef(masterVolume > 0 ? masterVolume : 100)

  /**
   * 音量统一入口（滑杆与图标开关共用）：本机监听（渲染层增益）与推流那一路（主进程混音）
   * 一起改；收到 0 时按"紧急静音"处理——AI 两路一起哑，麦克风人声不受影响。
   */
  const applyVolume = (value: number): void => {
    const next = Math.max(0, Math.min(100, Math.round(value)))
    setMasterVolume(next)
    audioEngine.setMasterVolume(next / 100)
    void window.api.audio.setMasterVolume(next / 100)
    void window.api.audio.setMuted(next === 0)
    if (next > 0) lastAudible.current = next
  }

  useEffect(() => {
    if (!('api' in window)) return
    const load = async () => {
      const [programs, personas] = await Promise.all([window.api.program.list(), window.api.persona.list()])
      const program = programs.find((p) => p.id === activeProgramId)
      const first = program?.presenterIds[0]
      setCastCard(first ? (personas.find((p) => p.id === first) ?? null) : null)
    }
    void load()
    return window.api.data.onChanged((payload) => {
      if (payload.scope === 'personas' || payload.scope === 'programs') void load()
    })
  }, [activeProgramId])

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  const running = agent.live === true
  /** 节目卡司第一张的嗓音名（与上面的名字同源；路由断了就只显示人名） */
  const voiceName = castCard
    ? (() => {
        const route = voiceRouteSummary(voices, ttsProviders, ttsConnections, castCard.voiceId)
        return route.broken ? '' : route.voiceName
      })()
    : ''
  const prepared = program?.broadcastMode === 'prepared'

  // —— 预制节目的段级进度（口径同 PreparedPanel 段列表）——
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  /** 主槽播放进度（itemId 对得上当前 playing 条目才采用） */
  const [progress, setProgress] = useState<{ itemId: string; positionMs: number } | null>(null)
  /** 拖动中的预览位置（松手才真正 seek，避免拖一路发一路 IPC） */
  const [dragMs, setDragMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!program) return
    const [scripts, utterances] = await Promise.all([
      window.api.script.list(),
      window.api.utterance.list(program.id)
    ])
    const script: Script | null = scripts.find((s) => s.id === program.scriptId) ?? null
    setUnits(listProgramAudioUnits(program, script, utterances))
  }, [program])

  useEffect(() => {
    if (prepared) void load()
  }, [prepared, load])

  // 预制音频资产变化（重合成完成/失败）实时刷新章节状态
  useEffect(() => {
    if (!prepared || !program) return
    return window.api.program.onAudioEvent((payload) => {
      if (payload.programId === program.id) void load()
    })
  }, [prepared, program, load])

  // 主进程播放进度（250ms 一拍）
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

  /** 上一段/下一段：当前没段在播时，「下一段」= 第一个就绪段 */
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

  /** 顶部那条进度线（只有确定时长的预制段音频才有）：拖动 seek，松手才真跳 */
  const seekable = prepared && Boolean(playing && currentUnit) && durationMs > 0
  const playedPct = durationMs > 0 ? Math.min(100, (shownMs / durationMs) * 100) : 0
  const seekFromEvent = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    return ratio * durationMs
  }

  // 副标题只放"谁在播"与预制章节的进度时间；正在播什么由内容区负责（播放条不重复铺稿子）
  const presenterLine = [
    castCard?.name ?? agent.castName ?? '未选主播',
    voiceName
  ]
    .filter(Boolean)
    .join(' · ')
  const progressLine = seekable
    ? `${formatDurationMs(shownMs)} / ${formatDurationMs(durationMs)}`
    : prepared && playing && !currentUnit
      ? '插播内容'
      : ''

  return (
    <div className="shrink-0 border-t bg-card/60">
      {/* 顶部整条进度线（网易云那种贴边细线）：播客/即兴没有确定时长，整条不显示 */}
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
          <div className="pointer-events-none h-full bg-primary" style={{ width: `${playedPct}%` }} />
          <div
            className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${playedPct}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-4 px-4 py-4">
        {/* 左：节目名（可换）+ 卡司嗓音——像播放器的曲名/歌手位，不铺稿子文字（稿子看内容区） */}
        <div className="flex w-[32%] min-w-0 flex-col justify-center">
          <div className="flex min-w-0 items-center text-sm font-medium">
            {programPicker ?? <span className="truncate text-muted-foreground">未选节目</span>}
          </div>
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{presenterLine}</span>
            {progressLine && <span className="shrink-0">· {progressLine}</span>}
          </div>
        </div>

        {/* 中：未开播 = 启动节目（主 CTA）；直播中 = 上一段 / 暂停继续 / 下一段 / 队列 / 结束本场 */}
        <div className="flex flex-1 items-center justify-center gap-1.5">
          {!running ? (
            launchAction
          ) : (
            <>
              {/* 上一段只在预制节目里有意义（那里才有"段"）；现场发挥/边播边准备没有可回退的单元，
                  以前这个按钮在这种模式下永远灰着——留着像坏了，直接不显示 */}
              {prepared && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || !hasPrev}
                  onClick={() => jumpBy(-1)}
                  title="上一段"
                >
                  <SkipBack />
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!running}
                onClick={() => (loopRunning ? pauseBroadcast() : resumeBroadcast())}
                title={loopRunning ? '暂停：停播报，也让主播先别生成新话术' : '继续播报'}
              >
                {loopRunning ? <Pause /> : <Play />}
                {loopRunning ? '暂停' : '继续'}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy || !playing || (prepared && !hasNext)}
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
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onFocusQueue?.()}
                title={playing ? '定位到正在播的那条（在 [接下来] 里）' : '看队列：接下来播什么'}
              >
                <ListMusic />
              </Button>
              {endAction}
            </>
          )}
        </div>

        {/* 右：录屏指示（只在录制中占位）/ 音量（图标＝静音开关）/ ⋯ 动作菜单 */}
        <div className="flex w-[32%] items-center justify-end gap-2">
          <RecordIndicator />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => applyVolume(masterVolume > 0 ? 0 : lastAudible.current)}
            title={masterVolume > 0 ? `静音（当前 ${masterVolume}%）：AI 两路一起哑，麦克风人声不受影响` : '取消静音，恢复到原音量'}
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
            onValueChange={([v]) => applyVolume(v)}
          />
          {actions}
        </div>
      </div>
    </div>
  )
}
