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
  unitCaption,
  type ProgramAudioUnit
} from '../../lib/audioUnits'
import { audition } from '../../lib/audition'
import type { DraftUnit, Persona, Program, Script } from '../../../../shared/types'
import { stripSpeechTags } from '../../../../shared/speechTags'
import { ContentItem, ContentList } from './ContentItem'
import { Button } from '@/components/ui/button'

/** 超过这个字数才给「收起」（默认展开，长文也先给全文） */
const LONG_TEXT_CHARS = 600

/**
 * 预制节目（全部做好再播）的「接下来」内容（docs/REDESIGN 4.6）：段卡片列表占满。
 * 当前段/进度/seek/上一段下一段在底部 NowPlayingBar（三模式统一），这里只管点播与试听。
 *
 * 数据口径：段 = 合成单元（lib/audioUnits，与主进程 programUnits 同一划分）；
 * 当前播放段由话术池 playing 条目的 dedupeKey（rendered:<kind>:<id>）对应；
 * 段级跳转 = 跳播对应 speech_item（program.playUnit：提到队首 + 打断当前条目）。
 */
export function PreparedPanel({ program }: { program: Program }) {
  const pool = useAppStore((s) => s.pool)
  const [units, setUnits] = useState<ProgramAudioUnit[]>([])
  const [drafts, setDrafts] = useState<DraftUnit[]>([])
  const [castList, setCastList] = useState<Persona[]>([])
  const [busy, setBusy] = useState(false)
  /** 超长段落的折叠状态（默认展开：播的是全文，别一进来就藏） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    const [scripts, utterances] = await Promise.all([
      window.api.script.list(),
      window.api.utterance.list(program.id)
    ])
    const script: Script | null = scripts.find((s) => s.id === program.scriptId) ?? null
    setUnits(listProgramAudioUnits(program, script, utterances))
    setDrafts(utterances)
  }, [program])

  useEffect(() => {
    void load()
  }, [load])

  // 主播卡名单：章内段落按 presenter_id 汇总出「谁读这一章」
  useEffect(() => {
    if (!('api' in window)) return
    void window.api.persona.list().then(setCastList)
    const off = window.api.data.onChanged((payload) => {
      if (payload.scope === 'personas' || payload.scope === 'drafts') void load()
    })
    return off
  }, [load])

  // 预制音频资产变化（重合成完成/失败）实时刷新段状态
  useEffect(() => {
    return window.api.program.onAudioEvent((payload) => {
      if (payload.programId === program.id) void load()
    })
  }, [program.id, load])

  /** 这一章/这一段由谁读：汇总段落的 presenter_id → 卡名 */
  const chapterWho = (unit: ProgramAudioUnit): string => {
    const members =
      unit.kind === 'scene'
        ? drafts.filter((d) => d.sceneId === unit.id)
        : drafts.filter((d) => d.id === unit.id)
    const names = [
      ...new Set(
        members
          .map((d) => (d.presenterId ? castList.find((p) => p.id === d.presenterId)?.name : ''))
          .filter((name): name is string => Boolean(name))
      )
    ]
    return names.length > 0 ? `${names.join('、')} · ` : ''
  }

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  /** 待播的段条目（dedupeKey = rendered:<kind>:<id>；插播内容不算段） */
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

  /** 点段正文 = 试听这段（aux 槽，全局试听条）；右侧 ▷ 跳播是另一个动作 */
  const auditionUnit = (unit: ProgramAudioUnit): void => {
    if (!unit.audioPath) {
      toast.warning('这段还没合成', { description: '先在节目页生成节目音频，合成好了点正文就能听' })
      return
    }
    audition.toggle({ key: `unit:${unit.kind}:${unit.id}`, title: unit.title, audioPath: unit.audioPath })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 段列表：标题 / 时长 / 状态，当前播放高亮；ready 的段点 ▷ 跳播、点正文试听 */}
      <p className="shrink-0 px-4 pt-2 pb-1 text-xs text-muted-foreground">
        内容 · {units.length} 段 · 已合成 {units.filter((unit) => unit.status === 'ready').length}/{units.length}
        （点就绪的段立即跳播）
      </p>
      {units.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <ListMusic className="size-10" strokeWidth={1.25} />
          <p className="text-sm">这个节目还没有节目文稿，先到节目页写稿并生成节目音频</p>
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
                    {unit.kind === 'scene' && (
                      <span className="flex shrink-0 items-center gap-1 font-medium text-foreground" title={unit.title}>
                        <ListMusic className="size-3" />
                        <span className="truncate">{unit.title}</span>
                      </span>
                    )}
                    {queuedKeys.has(`rendered:${unit.kind}:${unit.id}`) && !isCurrent && (
                      <Badge variant="outline">待播</Badge>
                    )}
                    {isCurrent && <Badge>播报中</Badge>}
                  </>
                }
                meta={`${chapterWho(unit)}${unitCaption(program, unit, index, units.length)} · ${
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
                      title={isCurrent ? '正在播这一段' : '跳播这一段'}
                    >
                      <Play className="size-3.5" />
                    </Button>
                  ) : undefined
                }
                text={unit.text}
                onTextClick={() => auditionUnit(unit)}
                longTextThreshold={LONG_TEXT_CHARS}
              />
            )
          })}
        </ContentList>
      )}
    </div>
  )
}
