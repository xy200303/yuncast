import { useEffect, useMemo, useState } from 'react'
import { AudioWaveform, Clock3, Mic, MoreHorizontal, Pencil, Play, SkipForward, Trash2, TriangleAlert } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { cn } from '@/lib/utils'
import { ContentText } from '@/components/ContentText'
import { useAppStore } from '../../stores/useAppStore'
import { mergeRows, useLiveStore, type CardRow } from '../../stores/useLiveStore'
import { audition, auditionTitle } from '../../lib/audition'
import { voiceRouteSummary } from '../../lib/voice'
import { stripSpeechTags } from '../../../../shared/speechTags'
import type { PoolItem, PoolItemStatus } from '../../../../shared/types'

/**
 * 本场卡片流（docs/12 第七、八、十节）：
 * 一段一张卡，正文全文可见；已播、在读、合成中、失败都在同一条流里，靠颜色和左侧竖条区分。
 * 历史（pool.recent-played）与未播队列（快照）合并成一列，解决"看不到历史"。
 * 每张卡只有一个 ⋯ 入口，动作收在菜单里，不铺按钮。
 */

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

export function CardStream() {
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
  /** 单独合成：当前选中的底稿行 + 音色 */
  const [synthRow, setSynthRow] = useState<CardRow | null>(null)
  const [synthVoice, setSynthVoice] = useState('')
  const [synthDelivery, setSynthDelivery] = useState('')
  const [synthRate, setSynthRate] = useState('')
  const [synthPitch, setSynthPitch] = useState('')
  const [synthBusy, setSynthBusy] = useState(false)

  // 每张卡要显示「这一段用谁的嗓子、什么演法」：段落没指定音色时落到本场默认音色
  const voices = useAppStore((s) => s.voices)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const activeProgramId = useAppStore((s) => s.config.live.activeProgramId)
  const [defaultVoiceId, setDefaultVoiceId] = useState('')
  useEffect(() => {
    if (!activeProgramId) {
      setDefaultVoiceId('')
      return
    }
    let alive = true
    void window.api.sessionConfig
      .latest(activeProgramId)
      .then((session) => {
        if (alive) setDefaultVoiceId((session?.voiceId ?? '').trim())
      })
      .catch(() => {
        if (alive) setDefaultVoiceId('')
      })
    return () => {
      alive = false
    }
  }, [activeProgramId, live, pool.items.length])

  const rows = useMemo<CardRow[]>(() => {
    // 失败条目单独一路：它们既不在未播队列里，也不该被"未开播就只看底稿"藏起来
    const failedRows: CardRow[] = pool.failed.map((item) => ({ item, played: false }))
    if (live) {
      const base = mergeRows(history, pool.items, drafts)
      const seen = new Set(base.map((row) => row.item.id))
      return [...base, ...failedRows.filter((row) => !seen.has(row.item.id))]
    }
    // 未开播：底稿就是待播内容（结束本场后自动回到这里，不会停在"已播"），失败条目照常列出
    const draftRows = drafts.map((draft) => ({
      item: {
        id: draft.id,
        sessionId: '',
        scriptId: draft.programId,
        text: draft.text,
        textZh: draft.textZh,
        turnId: '',
        seq: draft.seq,
        voiceId: draft.voiceId ?? '',
        delivery: draft.delivery || undefined,
        source: { agentId: 'draft', kind: 'manual' },
        lane: 'normal',
        // 合成状态以底稿自身为准（rendered 是预制资产，不是单段合成结果）
        status: (draft.status === 'ready' && draft.audioPath
          ? 'ready'
          : draft.status === 'failed'
            ? 'failed'
            : 'pending') as PoolItemStatus,
        audioPath: draft.audioPath ?? draft.rendered?.audioPath
      } as PoolItem,
      played: false,
      draft
    }))
    const seen = new Set(draftRows.map((row) => row.item.id))
    return [...draftRows, ...failedRows.filter((row) => !seen.has(row.item.id))]
  }, [live, history, pool.items, pool.failed, drafts])
  const speakerOf = (_row: CardRow): { name: string; color: string } => ({ name: '', color: '#1d4ed8' })
  const multiSpeaker = false

  const saveEdit = async (row: CardRow): Promise<void> => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text || text === row.item.text) {
      setEditing(null)
      return
    }
    setBusyId(row.item.id)
    if (row.draft) {
      const result = await window.api.draftUnit.save(
        { ...row.draft, text, seq: undefined } as Parameters<typeof window.api.draftUnit.save>[0],
        row.draft.id
      )
      setBusyId('')
      if (!result.ok) {
        toast.error('改稿失败', { description: result.error })
        return
      }
      setEditing(null)
      await useLiveStore.getState().loadDrafts(row.draft.programId)
      toast.success('已改稿，正在重新合成')
      return
    }
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
        <span className="text-sm">本场还没有话术</span>
        <span>让导演按项目安排逐段写稿，写完可以逐段试听、改稿，再统一合成</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex min-h-0 w-full flex-1 flex-col',
        density === 'compact' ? 'gap-1.5 p-2' : 'gap-2.5 p-3'
      )}
    >
      <div className="flex shrink-0 items-center gap-2 pb-1 text-[11px] text-muted-foreground">
        <span>
          {rows.length} 段 · {live ? `已播 ${rows.filter((row) => row.played).length}` : '未开播'}
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
          const speaker = speakerOf(row)
          const text = stripSpeechTags(item.text)
          // 译文只用于显示：老数据里可能带着 <cot>/<pause> 标记，渲染前剥掉
          const translation = item.textZh?.trim() ? stripSpeechTags(item.textZh.trim()) : undefined
          // 这一段用谁的嗓子、什么演法：段落没指定就落到本场默认音色
          const voiceId = (item.voiceId || defaultVoiceId).trim()
          const voiceName = voiceId ? voiceRouteSummary(voices, ttsProviders, ttsConnections, voiceId).voiceName : ''
          const delivery = item.delivery?.trim() || row.draft?.delivery?.trim() || ''
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
                  {!live ? (
                    item.status === 'ready' ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        未播 · 已合成
                      </span>
                    ) : item.status === 'failed' ? (
                      <span className="text-amber-600">未播 · 合成失败</span>
                    ) : (
                      '未播 · 待合成'
                    )
                  ) : (
                    STATUS_TEXT[item.status]
                  )}
                </span>
                {ready && <span className="tabular-nums">{mmss(estimateMs(text))}</span>}
                {playing && <span className="text-primary">◉ 在播</span>}
                {voiceName && (
                  <span className="flex min-w-0 shrink items-center gap-1" title={`本段音色：${voiceName}`}>
                    <Mic className="size-3 shrink-0" />
                    <span className="max-w-24 truncate">{voiceName}</span>
                  </span>
                )}
                {delivery && (
                  <span
                    className="min-w-0 max-w-[40%] truncate text-muted-foreground/80"
                    title={`演法：${delivery}`}
                  >
                    演法 · {delivery}
                  </span>
                )}
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
                        <Play /> 重听
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={row.played || playing || Boolean(row.draft)}
                        onSelect={async () => {
                          const result = await window.api.pool.playOnly(item.id)
                          if (!result.ok) toast.error('操作失败', { description: result.error })
                          else toast.success('已插到当前条之后，播完这条队列照原顺序继续')
                        }}
                      >
                        <Play /> 仅播此条
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={row.played || playing || Boolean(row.draft)}
                        onSelect={async () => {
                          const result = await window.api.pool.promote(item.id)
                          if (!result.ok) toast.error('操作失败', { description: result.error })
                          else toast.success('已改成从这里往下播')
                        }}
                      >
                        <Clock3 /> 从此处播
                      </DropdownMenuItem>
                      {row.draft && (
                        <DropdownMenuItem
                          disabled={synthBusy}
                          onSelect={() => {
                            setSynthRow(row)
                            setSynthVoice(row.draft?.voiceId ?? '')
                            setSynthDelivery(row.draft?.delivery ?? '')
                            setSynthRate(row.draft?.rate !== undefined ? String(row.draft.rate) : '')
                            setSynthPitch(row.draft?.pitch !== undefined ? String(row.draft.pitch) : '')
                          }}
                        >
                          <AudioWaveform /> 单独合成
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={row.played || playing}
                        onSelect={() => setEditing({ id: item.id, text: item.text })}
                      >
                        <Pencil /> 改稿
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={row.played || playing || Boolean(row.draft)}
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
                    <span className="text-[11px] text-muted-foreground">
                      编辑的是原文，演法标记（&lt;cot&gt; / &lt;pause&gt; / &lt;fx&gt;）照常保留
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  {displayMode === 'zh' ? (
                    <p
                      className={cn(
                        'mt-1.5 whitespace-pre-wrap text-[15px] leading-[1.75]',
                        dim && 'text-foreground/45'
                      )}
                    >
                      {translation || '—'}
                    </p>
                  ) : (
                    // 演法标记按 chip 渲染：<cot> 情绪小标、<pause> 停顿、<fx> 音效
                    <ContentText
                      text={item.text}
                      className={cn('mt-1.5 whitespace-pre-wrap', dim && 'text-foreground/45')}
                    />
                  )}
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

      {/* 单独合成：一段一个声音，试听满意再批量 */}
      <Dialog open={synthRow !== null} onOpenChange={(next) => !next && !synthBusy && setSynthRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>合成这一段</DialogTitle>
          </DialogHeader>
          <p className="max-h-24 overflow-y-auto rounded-md bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            {synthRow ? stripSpeechTags(synthRow.item.text) : ''}
          </p>
          <div className="space-y-1.5">
            <p className="text-[12px] text-muted-foreground">音色（留空 = 本场默认）</p>
            <UnifiedVoicePicker
              voiceId={synthVoice}
              onPick={setSynthVoice}
              emptyLabel="本场默认音色"
              placeholder="选择音色"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] text-muted-foreground">表演指示（情绪/语气/哪里停顿，一句话）</p>
            <Textarea
              value={synthDelivery}
              rows={2}
              placeholder="如：压低声音像说悄悄话，报价格前停一拍"
              onChange={(event) => setSynthDelivery(event.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <p className="text-[12px] text-muted-foreground">语速（1.0 基准，0.85~1.3）</p>
              <Input
                value={synthRate}
                inputMode="decimal"
                placeholder="默认"
                onChange={(event) => setSynthRate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-[12px] text-muted-foreground">音调（1.0 基准，0.9~1.1）</p>
              <Input
                value={synthPitch}
                inputMode="decimal"
                placeholder="默认"
                onChange={(event) => setSynthPitch(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={synthBusy} onClick={() => setSynthRow(null)}>
              取消
            </Button>
            <Button
              disabled={synthBusy}
              onClick={async () => {
                if (!synthRow?.draft) return
                setSynthBusy(true)
                const result = await window.api.draftUnit.synthesize(
                  synthRow.draft.id,
                  synthVoice.trim() || undefined,
                  {
                    delivery: synthDelivery.trim(),
                    rate: synthRate.trim() ? Number(synthRate) : undefined,
                    pitch: synthPitch.trim() ? Number(synthPitch) : undefined
                  }
                )
                setSynthBusy(false)
                if (!result.ok) {
                  toast.error('合成失败', { description: result.error })
                  return
                }
                toast.success('这一段合成好了', { description: '点卡片左边的播放试听' })
                void useLiveStore.getState().loadDrafts(synthRow.draft.programId)
                setSynthRow(null)
              }}
            >
              <AudioWaveform />
              {synthBusy ? '合成中…' : '开始合成'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
