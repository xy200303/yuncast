import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  ListMusic,
  Loader2,
  Play
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../stores/useAppStore'
import {
  formatDurationMs,
  listProgramAudioUnits,
  type ProgramAudioUnit
} from '../../lib/audioUnits'
import type { Program, Script } from '../../../../shared/types'
import { stripSpeechTags } from '../../../../shared/speechTags'
import { ContentItem, ContentList } from './ContentItem'
import { Button } from '@/components/ui/button'

/** 超过这个字数才给「收起」（默认展开，长文也先给全文） */
const LONG_TEXT_CHARS = 600

/**
 * 预制节目（全部做好再播）的「接下来」内容（docs/REDESIGN 4.6）：章节列表占满。
 * 当前章/进度/seek/上一章下一章在底部 NowPlayingBar（三模式统一），这里只管点播。
 *
 * 数据口径：章节 = 合成单元（lib/audioUnits，与主进程 programUnits 同一划分）；
 * 当前播放章由话术池 playing 条目的 dedupeKey（rendered:<kind>:<id>）对应；
 * 章级跳转 = 跳播对应 speech_item（program.playUnit：提到队首 + 打断当前条目）。
 */
export function PreparedPanel({ program }: { program: Program }) {
  const pool = useAppStore((s) => s.pool)
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  const [busy, setBusy] = useState(false)
  /** 超长章节的折叠状态（默认展开：播的是全文，别一进来就藏） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

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

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  /** 待播的章节条目（dedupeKey = rendered:<kind>:<id>；插播内容不算章） */
  const queuedKeys = new Set(
    pool.items.filter((item) => item.status !== 'playing').map((item) => item.dedupeKey)
  )
  const currentIdx = playing
    ? units.findIndex((unit) => `rendered:${unit.kind}:${unit.id}` === playing.dedupeKey)
    : -1

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 章节列表：标题 / 时长 / 状态，当前播放高亮；ready 的章点了就跳过去播 */}
      <p className="shrink-0 px-4 pt-2 pb-1 text-xs text-muted-foreground">
        章节 · {units.length}（点就绪的章立即跳播）
      </p>
      {units.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <ListMusic className="size-10" strokeWidth={1.25} />
          <p className="text-sm">这个节目还没有章节文稿，先到节目页写稿并生成节目音频</p>
        </div>
      ) : (
        <ContentList>
          {units.map((unit, index) => {
            const isCurrent = currentIdx === index
            const playable = unit.status === 'ready'
            return (
              <ContentItem
                key={`${unit.kind}:${unit.id}`}
                current={isCurrent}
                status={
                  unit.status === 'ready' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                  ) : unit.status === 'synthesizing' ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                  ) : unit.status === 'failed' ? (
                    <CircleAlert className="size-4 shrink-0 text-red-600" />
                  ) : unit.status === 'stale' ? (
                    <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-muted-foreground/50" />
                  )
                }
                header={
                  <>
                    <span className="flex shrink-0 items-center gap-1 font-medium text-foreground" title={unit.title}>
                      <ListMusic className="size-3" />
                      <span className="truncate">{unit.title}</span>
                    </span>
                    {queuedKeys.has(`rendered:${unit.kind}:${unit.id}`) && !isCurrent && (
                      <Badge variant="outline">待播</Badge>
                    )}
                    {isCurrent && <Badge>播报中</Badge>}
                  </>
                }
                meta={`第 ${index + 1} 章 · ${
                  unit.status === 'ready'
                    ? unit.durationMs
                      ? formatDurationMs(unit.durationMs)
                      : '已完成'
                    : unit.status === 'synthesizing'
                      ? '合成中…'
                      : unit.status === 'failed'
                        ? `失败：${unit.error || '合成失败'}`
                        : unit.status === 'stale'
                          ? '文稿已修改'
                          : '等待合成'
                }`}
                actions={
                  playable ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => void playUnit(unit)}
                      title={isCurrent ? '正在播这一章' : '跳播这一章'}
                    >
                      <Play className="size-3.5" />
                    </Button>
                  ) : undefined
                }
                text={unit.text}
                longTextThreshold={LONG_TEXT_CHARS}
              />
            )
          })}
        </ContentList>
      )}
    </div>
  )
}
