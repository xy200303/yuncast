import { useMemo, useState } from 'react'
import { Clock3, MoreHorizontal, Pencil, Play, SkipForward, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../stores/useAppStore'
import { mergeRows, useLiveStore, type CardRow } from '../../stores/useLiveStore'
import { audition, auditionTitle } from '../../lib/audition'
import { stripSpeechTags } from '../../../../shared/speechTags'
import type { Persona, PoolItem, PoolItemStatus } from '../../../../shared/types'

/**
 * 本场卡片流（docs/12 第七、八、十节）：
 * 一段一张卡，正文全文可见；已播、在读、合成中、失败都在同一条流里，靠颜色和左侧竖条区分。
 * 历史（pool.recent-played）与未播队列（快照）合并成一列，解决"看不到历史"。
 * 每张卡只有一个 ⋯ 入口，动作收在菜单里，不铺按钮。
 */

const SPEAKER_COLORS = ['#1d4ed8', '#b45309', '#15803d', '#6d28d9']

const STATUS_TEXT: Record<PoolItemStatus, string> = {
  pending: '待合成',
  synthesizing: '合成中',
  ready: '就绪',
  playing: '在播',
  done: '已播',
  interrupted: '被打断',
  skipped: '已跳过',
  failed: '失败',
  expired: '已过期'
}

/** 粗估时长：中文按 4.5 字/秒（只用于"还能播多久"，不作为事实展示） */
function estimateMs(text: string): number {
  return Math.round((stripSpeechTags(text).trim().length / 4.5) * 1000)
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function CardStream({ personas }: { personas: Persona[] }) {
  const pool = useAppStore((s) => s.pool)
  const history = useLiveStore((s) => s.history)
  const density = useLiveStore((s) => s.density)
  const displayMode = useLiveStore((s) => s.displayMode)
  const setDensity = useLiveStore((s) => s.setDensity)
  const setDisplayMode = useLiveStore((s) => s.setDisplayMode)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const live = useAppStore((s) => s.agent.live === true)
  /** 未开播时展示的是「节目底稿」= 还没播的内容，状态一律未播/待合成（放 store，水位条也要用） */
  const drafts = useLiveStore((s) => s.drafts)
  const [busyId, setBusyId] = useState('')

  const rows = useMemo<CardRow[]>(() => {
    // 失败条目单独一路：它们既不在未播队列里，也不该被"未开播就只看底稿"藏起来
    const failedRows: CardRow[] = pool.failed.map((item) => ({ item, played: false }))
    if (live) {
      const base = mergeRows(history, pool.items)
      const seen = new Set(base.map((row) => row.item.id))
      return [...base, ...failedRows.filter((row) => !seen.has(row.item.id))]
    }
    // 未开播：底稿就是待播内容（结束本场后自动回到这里，不会停在"已播"），失败条目照常列出
    const draftRows = drafts.map((draft) => ({
      item: {
        id: draft.id,
        sessionId: '',
        text: draft.text,
        textZh: draft.textZh,
        turnId: '',
        seq: draft.seq,
        voiceId: draft.voiceId ?? '',
        source: { agentId: 'draft', kind: 'manual' },
        lane: 'normal',
        status: (draft.rendered?.status === 'ready' ? 'ready' : 'pending') as PoolItemStatus,
        audioPath: draft.rendered?.audioPath
      } as PoolItem,
      played: false
    }))
    const seen = new Set(draftRows.map((row) => row.item.id))
    return [...draftRows, ...failedRows.filter((row) => !seen.has(row.item.id))]
  }, [live, history, pool.items, pool.failed, drafts])
  const speakerOf = (item: PoolItem): { name: string; color: string } => {
    // 说话人靠音色反查（条目上现只有 voiceId 快照；personaId 随资产解耦一起进）
    const index = personas.findIndex((persona) => persona.voiceId && persona.voiceId === item.voiceId)
    if (index < 0) return { name: '', color: SPEAKER_COLORS[0] }
    return { name: personas[index].name, color: SPEAKER_COLORS[index % SPEAKER_COLORS.length] }
  }
  const multiSpeaker = personas.length > 1

  const saveEdit = async (row: CardRow): Promise<void> => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text || text === row.item.text) {
      setEditing(null)
      return
    }
    setBusyId(row.item.id)
    const result = await window.api.pool.revise(row.item.id, text)
    setBusyId('')
    if (!result.ok) {
      toast.error('改稿失败', { description: result.error })
      return
    }
    setEditing(null)
    toast.success('已改稿，正在重新合成')
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <span className="text-sm">本场还没有话术</span>
        <span>开播后主播会按剧本逐段生成，或者按 Ctrl+J 让导演写一段</span>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', density === 'compact' ? 'gap-1.5 p-2' : 'gap-2.5 p-3')}>
      <div className="flex shrink-0 items-center gap-2 pb-1 text-[11px] text-muted-foreground">
        <span>
          {rows.length} 段 · {live ? `已播 ${history.length}` : '未开播'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 hover:bg-muted', displayMode === 'target' && 'bg-muted text-foreground')}
            onClick={() => setDisplayMode('target')}
          >
            原文
          </button>
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 hover:bg-muted', displayMode === 'zh' && 'bg-muted text-foreground')}
            onClick={() => setDisplayMode('zh')}
          >
            译文
          </button>
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 hover:bg-muted', displayMode === 'both' && 'bg-muted text-foreground')}
            onClick={() => setDisplayMode('both')}
          >
            双显
          </button>
          <span className="mx-1 h-3 w-px bg-border" />
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-muted"
            onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
            title={density === 'compact' ? '切到舒适密度' : '切到紧凑密度'}
          >
            {density === 'compact' ? '紧凑' : '舒适'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {rows.map((row, index) => {
          const item = row.item
          const playing = item.status === 'playing'
          const failed = item.status === 'failed'
          const ready = item.status === 'ready'
          const dim = row.played
          const speaker = speakerOf(item)
          const text = stripSpeechTags(item.text)
          const translation = item.textZh?.trim() || undefined
          const isEditing = editing?.id === item.id
          const fromUnit = item.source.kind === 'scene'
          // 只有"没有正文的纯标题"才降级成提示条（场景名/节奏标记那种）；
          // 合成单位是整章时它本身就有一大段正文，照常出卡片。
          const isMarker = fromUnit && text.trim().length <= 24 && !/[。！？.!?]/.test(text)
          if (isMarker) {
            return (
              <div key={item.id} className="flex items-center gap-2 py-1 pl-1 text-[12px] text-muted-foreground">
                <span className="h-px w-4 bg-border" />
                <span className={cn('truncate', dim && 'opacity-60')}>{text}</span>
                <span className="h-px flex-1 bg-border/60" />
              </div>
            )
          }

          return (
            <div
              key={item.id}
              data-playing={playing ? 'true' : undefined}
              className={cn(
                'rounded-[10px] border bg-card px-3.5 py-3 transition-colors',
                playing && 'border-primary/30 bg-primary/[0.03] ring-1 ring-primary/20',
                failed && 'border-amber-300/70 bg-amber-50/40',
                !playing && !failed && 'border-black/[0.08] hover:bg-[#fcfcfb]'
              )}
            >
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {playing && <span className="h-3 w-[3px] shrink-0 rounded-full bg-primary" />}
                {failed && <span className="h-3 w-[3px] shrink-0 rounded-full bg-amber-500" />}
                {multiSpeaker && speaker.name && (
                  <span className="flex shrink-0 items-center gap-1">
                    <i className="size-1.5 rounded-full" style={{ background: speaker.color }} />
                    <span className="text-foreground/70">{speaker.name}</span>
                  </span>
                )}
                {fromUnit && (
                  <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">章节</span>
                )}
                <span className="tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                <span className="truncate">
                  {!live
                    ? item.status === 'ready'
                      ? '未播 · 有音频'
                      : '未播'
                    : STATUS_TEXT[item.status]}
                </span>
                {ready && <span className="tabular-nums">{mmss(estimateMs(text))}</span>}
                {playing && <span className="text-primary">◉ 在播</span>}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {ready && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="试听这条"
                      onClick={() => {
                        if (!item.audioPath) {
                          toast.error('这条还没有音频')
                          return
                        }
                        audition.toggle({ key: `pool:${item.id}`, title: auditionTitle(text), audioPath: item.audioPath })
                      }}
                    >
                      <Play />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" title="更多">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem
                        disabled={!item.audioPath}
                        onSelect={() =>
                          item.audioPath &&
                          audition.toggle({ key: `pool:${item.id}`, title: auditionTitle(text), audioPath: item.audioPath })
                        }
                      >
                        <Play /> 试听这条
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={row.played || playing}
                        onSelect={async () => {
                          const result = await window.api.pool.promote(item.id)
                          if (!result.ok) toast.error('操作失败', { description: result.error })
                          else toast.success('已提到队首')
                        }}
                      >
                        <Clock3 /> 提到队首
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={row.played || playing} onSelect={() => setEditing({ id: item.id, text })}>
                        <Pencil /> 改稿
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={row.played || playing}
                        onSelect={async () => {
                          const result = await window.api.pool.revoke(item.id)
                          if (!result.ok) toast.error('撤销失败', { description: result.error })
                          else toast.success('已跳过')
                        }}
                      >
                        <SkipForward /> 跳过这条
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {isEditing ? (
                <div className="mt-2 space-y-2">
                  <Textarea
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                    rows={Math.min(8, Math.max(3, Math.ceil(editing.text.length / 40)))}
                    className="text-[15px] leading-7"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={busyId === item.id} onClick={() => void saveEdit(row)}>
                      {busyId === item.id ? '保存中…' : '保存并重合成'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p
                    className={cn(
                      'mt-1.5 whitespace-pre-wrap text-[15px] leading-[1.75]',
                      dim && 'text-foreground/45'
                    )}
                  >
                    {displayMode === 'zh' ? (translation || '—') : text}
                  </p>
                  {displayMode !== 'target' && translation && displayMode === 'both' && (
                    <p className="mt-1.5 border-l-2 border-[#c9d4ea] pl-2 text-[13px] leading-[1.7] text-foreground/60">
                      {translation}
                    </p>
                  )}
                </>
              )}

              {failed && (
                <div className="mt-2 flex items-center gap-2 rounded-md bg-amber-100/60 px-2 py-1 text-[12px] text-amber-900">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.error || '合成失败'}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[12px]"
                    onClick={async () => {
                      const result = await window.api.pool.revise(item.id, item.text)
                      if (!result.ok) toast.error('重试失败', { description: result.error })
                      else toast.success('已重新排队合成')
                    }}
                  >
                    <Trash2 className="hidden" />
                    重试
                  </Button>
                </div>
              )}

            </div>
          )
        })}
      </div>
    </div>
  )
}
