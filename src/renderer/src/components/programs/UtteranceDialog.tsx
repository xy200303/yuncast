import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AudioWaveform,
  BookOpenText,
  FileText,
  Globe,
  Loader2,
  Package,
  Pencil,
  Sparkles,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { DraftMinutesDialog } from '@/components/DraftMinutesDialog'
import { useAppStore } from '../../stores/useAppStore'
import {
  BIT_TYPES,
  BIT_TYPE_LABEL,
  UTTERANCE_STATUS_LABEL,
  type Program,
  type Script,
  type Utterance,
  type UtteranceStatus
} from '../../../../shared/types'

const UTTERANCE_STATUS: Record<UtteranceStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  pending: { label: UTTERANCE_STATUS_LABEL.pending, variant: 'outline' },
  synthesizing: { label: UTTERANCE_STATUS_LABEL.synthesizing, variant: 'secondary' },
  ready: { label: UTTERANCE_STATUS_LABEL.ready, variant: 'default' },
  failed: { label: UTTERANCE_STATUS_LABEL.failed, variant: 'destructive' }
}

/**
 * 底稿库审阅表（docs/07 §4 ③④）：逐条可编辑/删除、来源留痕（外部来源高亮）、
 * 「生成底稿」走生成 Agent（工具循环）、「预合成」批量 TTS。
 */
export function UtteranceDialog({
  program,
  script,
  open,
  onOpenChange,
  onChanged
}: {
  program: Program
  script: Script | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}) {
  const [items, setItems] = useState<Utterance[]>([])
  const [presynthRunning, setPresynthRunning] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editType, setEditType] = useState('')
  const [editDelivery, setEditDelivery] = useState('')

  const reload = useCallback(async () => {
    setItems(await window.api.utterance.list(program.id))
  }, [program.id])

  useEffect(() => {
    void reload()
  }, [reload])

  // 预合成进度订阅（主播写稿入库走直播台时间线，这里只关心音频状态变化）
  useEffect(() => {
    const offUt = window.api.utterance.onEvent((u) => {
      if (u.programId !== program.id) return
      if (u.id === '') {
        setPresynthRunning(false)
        void reload().then(onChanged)
        return
      }
      setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
    })
    return () => {
      offUt()
    }
  }, [program.id, reload, onChanged])

  const sceneTitle = useMemo(() => {
    const map = new Map<string, string>()
    for (const scene of script?.scenes ?? []) map.set(scene.id, scene.title)
    return (id: string) => map.get(id) ?? (id === '' ? '全场通用' : id)
  }, [script])

  const groups = useMemo(() => {
    const out: { sceneId: string; items: Utterance[] }[] = []
    for (const item of items) {
      const last = out[out.length - 1]
      if (last && last.sceneId === item.sceneId) last.items.push(item)
      else out.push({ sceneId: item.sceneId, items: [item] })
    }
    return out
  }, [items])

  const stats = {
    total: items.length,
    ready: items.filter((u) => u.status === 'ready').length,
    failed: items.filter((u) => u.status === 'failed').length
  }

  // 「生成底稿」：确认后跳播控台派主播写稿（写多少由主播自己判断，docs/10 §10）
  const [draftAsk, setDraftAsk] = useState(false)
  const goDraft = async () => {
    if (items.length > 0) {
      const ok = await new Promise<boolean>((resolve) => {
        toast.warning(`库里已有 ${items.length} 条底稿`, {
          description: '主播会在此基础上续写；想推倒重写，到直播台让它先清空再写',
          action: { label: '继续', onClick: () => resolve(true) },
          cancel: { label: '取消', onClick: () => resolve(false) },
          duration: 8000
        })
      })
      if (!ok) return
    }
    onOpenChange(false)
    useAppStore.getState().setPage('live')
    const result = await window.api.agent.draftStart(program.id)
    if (!result.ok) toast.error('派写稿任务失败', { description: result.error })
  }

  const startPresynth = async () => {
    setPresynthRunning(true)
    await window.api.utterance.presynth(program.id)
  }

  const saveEdit = async (u: Utterance) => {
    const result = await window.api.utterance.save(
      {
        programId: u.programId,
        sceneId: u.sceneId,
        variantIdx: u.variantIdx,
        text: editText,
        bitType: editType,
        delivery: editDelivery,
        voiceId: u.voiceId,
        source: u.source,
        sources: u.sources
      },
      u.id
    )
    if (result.ok) {
      setEditingId(null)
      toast.success(editText.trim() === u.text ? '已保存' : '已保存，音频作废待重新合成')
      await reload()
      await onChanged()
    } else {
      toast.error('保存失败', { description: result.error })
    }
  }

  /** 一键清空（两击确认，防手滑）：整场底稿连音频缓存一起清，清完可让主播重写到上限 */
  const [confirmClear, setConfirmClear] = useState(false)
  const clearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    setConfirmClear(false)
    const result = await window.api.utterance.clear(program.id)
    if (result.ok) {
      toast.success('已清空全部底稿', { description: '点「生成底稿」让主播重写' })
      await reload()
      await onChanged()
    } else {
      toast.error('清空失败', { description: result.error })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            底稿库 · {program.name}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {stats.total} 段 · 就绪 {stats.ready}
              {stats.failed > 0 ? ` · 失败 ${stats.failed}` : ''}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setDraftAsk(true)}>
            <Sparkles />
            {items.length > 0 ? '去播控台续写' : '生成底稿'}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant={confirmClear ? 'destructive' : 'outline'}
              disabled={stats.total === 0}
              onClick={() => void clearAll()}
            >
              <Trash2 />
              {confirmClear ? '再点一次确认清空' : '清空全部'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={presynthRunning || stats.total === 0 || stats.ready === stats.total}
              onClick={() => void startPresynth()}
            >
              {presynthRunning ? <Loader2 className="animate-spin" /> : <AudioWaveform />}
              {presynthRunning ? '合成中…' : '预合成全部'}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <BookOpenText className="size-8" strokeWidth={1.25} />
              <p className="text-xs">
                还没有话术。点「生成底稿」，主播会在直播台写稿——过程看得见，随时可以插话改口径
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pb-2">
              {groups.map((group) => (
                <div key={group.sceneId || '__common'}>
                  <p className="sticky top-0 mb-1 bg-popover py-1 text-xs font-medium text-muted-foreground">
                    {sceneTitle(group.sceneId)} · {group.items.length} 段
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {group.items.map((u) => (
                      <div key={u.id} className="rounded-lg border bg-card px-3 py-2">
                        {editingId === u.id ? (
                          <div className="flex flex-col gap-2">
                            <Textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              className="min-h-16 resize-none text-[13px]"
                              autoFocus
                            />
                            <div className="flex items-center gap-2">
                              <Select value={editType || 'general'} onValueChange={setEditType}>
                                <SelectTrigger className="h-7 w-28 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {BIT_TYPES.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                      {t.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Input
                                value={editDelivery}
                                onChange={(e) => setEditDelivery(e.target.value)}
                                placeholder="表演指示（可选）：情绪/语速/停顿"
                                className="h-7 flex-1 text-xs"
                              />
                              <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                                取消
                              </Button>
                              <Button size="sm" disabled={!editText.trim()} onClick={() => void saveEdit(u)}>
                                保存
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2">
                            <Badge variant={UTTERANCE_STATUS[u.status].variant} className="mt-0.5 shrink-0">
                              {UTTERANCE_STATUS[u.status].label}
                            </Badge>
                            <div className="min-w-0 flex-1">
                              {u.status === 'synthesizing' ? (
                                <Skeleton className="h-4 w-3/4" />
                              ) : (
                                <>
                                  <p className="text-[13px] leading-5">
                                    {u.bitType && (
                                      <span className="mr-1.5 inline-flex items-center rounded bg-accent/70 px-1 py-px text-[10px] font-medium">
                                        {BIT_TYPE_LABEL[u.bitType] ?? u.bitType}
                                      </span>
                                    )}
                                    {u.text}
                                  </p>
                                  {u.delivery && (
                                    <p className="mt-0.5 text-xs text-muted-foreground">演法：{u.delivery}</p>
                                  )}
                                </>
                              )}
                              {u.error && <p className="mt-0.5 text-xs text-destructive">{u.error}</p>}
                              {u.sources.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {u.sources.map((s, i) => (
                                    <Badge
                                      key={i}
                                      variant={s.type === 'url' ? 'secondary' : 'outline'}
                                      className={cn('text-[10px]', s.type === 'url' && 'border-amber-500/40 text-amber-600 dark:text-amber-400')}
                                      title={`${s.type === 'url' ? '外部信息，需人工确认：' : ''}${s.snippet}`}
                                    >
                                      {s.type === 'url' ? <Globe className="size-2.5" /> : s.type === 'product' ? <Package className="size-2.5" /> : <FileText className="size-2.5" />}
                                      {s.name}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0"
                              title="编辑"
                              onClick={() => {
                                setEditingId(u.id)
                                setEditText(u.text)
                                setEditType(u.bitType || 'general')
                                setEditDelivery(u.delivery)
                              }}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0"
                              title="删除"
                              onClick={() => {
                                void window.api.utterance.remove(u.id).then(async (result) => {
                                  if (result.ok) {
                                    await reload()
                                    await onChanged()
                                  } else toast.error('删除失败', { description: result.error })
                                })
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <DraftMinutesDialog
          program={program}
          open={draftAsk}
          onOpenChange={setDraftAsk}
          onConfirm={() => void goDraft()}
        />
      </DialogContent>
    </Dialog>
  )
}
