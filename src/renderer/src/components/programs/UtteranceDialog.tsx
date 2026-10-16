import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AudioWaveform,
  BookOpenText,
  Eraser,
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
import { ProgramAudioPanel } from './ProgramAudioPanel'
import { useAppStore } from '../../stores/useAppStore'
import {
  BIT_TYPES,
  BIT_TYPE_LABEL,
  UTTERANCE_STATUS_LABEL,
  type ProduceVoiceOverride,
  type Program,
  type Script,
  type Utterance,
  type UtteranceStatus
} from '../../../../shared/types'
import { ContentText } from '../ContentText'
import { VoicePickDialog } from '../VoicePickDialog'

const UTTERANCE_STATUS: Record<UtteranceStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  pending: { label: UTTERANCE_STATUS_LABEL.pending, variant: 'outline' },
  synthesizing: { label: UTTERANCE_STATUS_LABEL.synthesizing, variant: 'secondary' },
  ready: { label: UTTERANCE_STATUS_LABEL.ready, variant: 'default' },
  failed: { label: UTTERANCE_STATUS_LABEL.failed, variant: 'destructive' }
}

/**
 * 底稿库审阅表（docs/07 §4 ③④）：逐条可编辑/删除、来源留痕（外部来源高亮）、
 * 「生成底稿」走生成 Agent（工具循环）。
 * 合成入口按播出方式分流（docs/10 §7.5）：滚动=「提前合成全部」（走统一生产入口 produceAudio），
 * 预制=顶部节目音频进度区（ProgramAudioPanel，§7.7），即兴=不显示合成入口。
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
  const [creating, setCreating] = useState(false)
  const [newText, setNewText] = useState('')
  const [newDelivery, setNewDelivery] = useState('')

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
    synthesizing: items.filter((u) => u.status === 'synthesizing').length,
    pending: items.filter((u) => u.status === 'pending').length,
    failed: items.filter((u) => u.status === 'failed').length
  }

  const [draftAsk, setDraftAsk] = useState(false)
  const goDraft = async () => {
    if (items.length > 0) {
      const ok = await new Promise<boolean>((resolve) => {
        toast.warning(`已经有 ${items.length} 段底稿`, {
          description: '导演会在现有内容后继续写，不会覆盖你手动改过的内容',
          action: { label: '继续写', onClick: () => resolve(true) },
          cancel: { label: '取消', onClick: () => resolve(false) },
          duration: 8000
        })
      })
      if (!ok) return
    }
    const store = useAppStore.getState()
    store.openAgentPanel({ kind: 'draft', label: `底稿工作台 · ${program.name}`, programId: program.id })
    const result = await window.api.agent.draftStart(program.id)
    if (!result.ok) toast.error('导演没能开始写稿', { description: result.error })
  }

  /** 「提前合成全部」（滚动节目）：先弹声音选择弹窗（docs/REDESIGN 4.4），确认后走统一音频生产入口 */
  const [voicePickOpen, setVoicePickOpen] = useState(false)
  const startPresynth = async (voiceOverride?: ProduceVoiceOverride, rebuildAll?: boolean) => {
    setVoicePickOpen(false)
    setPresynthRunning(true)
    if (rebuildAll) await window.api.utterance.clearAudio(program.id)
    const result = await window.api.program.produceAudio(program.id, voiceOverride)
    if (!result.ok) {
      setPresynthRunning(false)
      toast.error('提前合成没能开始', { description: result.error })
    }
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

  const saveNew = async () => {
    const text = newText.trim()
    if (!text) return
    const result = await window.api.utterance.save({
      programId: program.id,
      sceneId: script?.scenes[0]?.id ?? '',
      variantIdx: 0,
      text,
      bitType: 'general',
      delivery: newDelivery.trim(),
      voiceId: '',
      source: 'initial',
      sources: []
    })
    if (!result.ok) {
      toast.error('新建失败', { description: result.error })
      return
    }
    setCreating(false)
    setNewText('')
    setNewDelivery('')
    await reload()
    await onChanged()
  }

  /** 一键清空（两击确认，防手滑）：整场底稿连音频缓存一起清，清完可让主播重写到上限 */
  const clearGuard = useTwoStepConfirm()
  const clearAll = async () => {
    if (!clearGuard.armed) {
      clearGuard.arm()
      return
    }
    clearGuard.disarm()
    const result = await window.api.utterance.clear(program.id)
    if (result.ok) {
      toast.success('已清空全部底稿', { description: '可以手动新建，或点「AI 写稿」让导演重写' })
      await reload()
      await onChanged()
    } else {
      toast.error('清空失败', { description: result.error })
    }
  }

  /** 只清音频不清文稿（两击确认）：换音色/演法后全部重蒸用；外部导入的音频不动 */
  const clearAudioGuard = useTwoStepConfirm()
  const clearAudio = async () => {
    if (!clearAudioGuard.armed) {
      clearAudioGuard.arm()
      return
    }
    clearAudioGuard.disarm()
    const result = await window.api.utterance.clearAudio(program.id)
    if (result.ok) {
      if (result.item > 0) {
        toast.success(`已清空 ${result.item} 段音频`, { description: '文稿保留，全部回到待合成' })
      } else {
        toast.info('没有可清空的音频')
      }
      await reload()
      await onChanged()
    } else {
      toast.error('清空音频失败', { description: result.error })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            底稿工作台 · {program.name}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {stats.total} 段 · 就绪 {stats.ready} · 合成中 {stats.synthesizing} · 待合成 {stats.pending}
              {stats.failed > 0 ? ` · 失败 ${stats.failed}` : ''}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          {program.broadcastMode !== 'improvised' && (
            <Button size="sm" onClick={() => setDraftAsk(true)}>
              <Sparkles />
              AI 写稿
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Pencil />
            手动新建
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant={clearGuard.armed ? 'destructive' : 'outline'}
              disabled={stats.total === 0}
              onClick={() => void clearAll()}
            >
              <Trash2 />
              {clearGuard.armed ? `再点一次确认清空（${clearGuard.left}s）` : '清空全部'}
            </Button>
            <Button
              size="sm"
              variant={clearAudioGuard.armed ? 'destructive' : 'outline'}
              disabled={stats.total === 0}
              title="只清掉已合成的音频（文稿保留，回到待合成）；换音色/演法后想全部重蒸时用，外部导入的音频不动"
              onClick={() => void clearAudio()}
            >
              <Eraser />
              {clearAudioGuard.armed ? `再点一次确认（${clearAudioGuard.left}s）` : '清空音频'}
            </Button>
            {program.broadcastMode === 'rolling' && (
              <Button
                size="sm"
                variant="outline"
                disabled={presynthRunning || stats.total === 0 || stats.ready === stats.total}
                onClick={() => setVoicePickOpen(true)}
                title="尽可能把全部文稿提前合成好；不点也行，播出时会边播边合成"
              >
                {presynthRunning ? <Loader2 className="animate-spin" /> : <AudioWaveform />}
                {presynthRunning ? '合成中…' : '提前合成全部'}
              </Button>
            )}
          </div>
        </div>

        {creating && (
          <div className="flex shrink-0 flex-col gap-2 rounded-lg border bg-muted/20 p-3">
            <Textarea
              value={newText}
              onChange={(event) => setNewText(event.target.value)}
              placeholder="输入一段底稿…"
              className="min-h-20 resize-none text-[13px]"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Input
                value={newDelivery}
                onChange={(event) => setNewDelivery(event.target.value)}
                placeholder="演法（可选）：情绪、语速、停顿"
                className="h-8 flex-1 text-xs"
              />
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>取消</Button>
              <Button size="sm" disabled={!newText.trim()} onClick={() => void saveNew()}>保存</Button>
            </div>
          </div>
        )}

        {/* 预制节目：音频进度区（docs/10 §7.7）。即兴节目没有合成入口（现场实时合成） */}
        {program.broadcastMode === 'prepared' && (
          <ProgramAudioPanel program={program} onChanged={onChanged} />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <BookOpenText className="size-8" strokeWidth={1.25} />
              <p className="text-xs">还没有底稿。你可以手动新建，或点「AI 写稿」让导演帮你写</p>
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
                                    <ContentText text={u.text} />
                                  </p>
                                  {u.delivery && (
                                    <p className="mt-0.5 text-xs text-muted-foreground">演法：{u.delivery}</p>
                                  )}
                                </>
                              )}
                              {u.error && <p className="mt-0.5 text-xs text-destructive">{u.error}</p>}
                              {u.sources.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {/* 来源的 id 由写稿 Agent 产出入库时一律为空串，用不上；type+name 是天然主键，也避免重排时错位复用 */}
                                  {u.sources.map((s) => (
                                    <Badge
                                      key={`${s.type}:${s.name}`}
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
        {/* 提前合成的声音选择弹窗（docs/REDESIGN 4.4） */}
        <VoicePickDialog
          program={program}
          open={voicePickOpen}
          onOpenChange={setVoicePickOpen}
          busy={presynthRunning}
          onConfirm={(override, rebuildAll) => startPresynth(override, rebuildAll)}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * 两击确认 + 倒计时（防手滑，也防"刚才到底点过没有"）：
 * 第一击只是"上膛"——按钮变红并显示剩余秒数，数完自动收回；再点才真的执行。
 */
function useTwoStepConfirm(seconds = 3): { armed: boolean; left: number; arm: () => void; disarm: () => void } {
  const [deadline, setDeadline] = useState<number | null>(null)
  const [left, setLeft] = useState(seconds)
  useEffect(() => {
    if (deadline === null) return
    const tick = (): void => {
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setLeft(remain)
      if (remain === 0) setDeadline(null)
    }
    tick()
    const timer = setInterval(tick, 200)
    return () => clearInterval(timer)
  }, [deadline])
  return {
    armed: deadline !== null,
    left,
    arm: () => setDeadline(Date.now() + seconds * 1000),
    disarm: () => setDeadline(null)
  }
}
