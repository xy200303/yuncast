import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpenText,
  CalendarDays,
  Check,
  Copy,
  FileText,
  Globe,
  Loader2,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  AudioWaveform,
  Drama
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ProviderIcon } from '@/components/ProviderIcon'
import { VoiceProviderHint } from '@/components/VoiceProviderHint'
import { DraftMinutesDialog } from '@/components/DraftMinutesDialog'
import { flattenModelCatalog, groupCloneVoices } from '../lib/voice'
import { useAppStore } from '../stores/useAppStore'
import {
  BIT_TYPES,
  BIT_TYPE_LABEL,
  DEFAULT_MODE_ID,
  DEFAULT_PLAN_GEN_CONFIG,
  DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  DEFAULT_PLANNED_MINUTES,
  type KnowledgeFile,
  type LiveMode,
  type LiveModeInput,
  type LiveModeWiring,
  type LivePlan,
  type LivePlanInput,
  type Persona,
  type Product,
  type Script,
  type Utterance,
  type UtteranceStatus,
  type VoiceRecord
} from '../../../shared/types'

const UTTERANCE_STATUS: Record<UtteranceStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  pending: { label: '待合成', variant: 'outline' },
  synthesizing: { label: '合成中', variant: 'secondary' },
  ready: { label: '就绪', variant: 'default' },
  failed: { label: '失败', variant: 'destructive' }
}

/** 场次：一场直播的完整配置（人设/形式/剧本/知识库/话术库/声音）。开播的唯一入口在直播台。 */
export function SessionsPage() {
  const config = useAppStore((s) => s.config)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const [plans, setPlans] = useState<LivePlan[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [voices, setVoices] = useState<VoiceRecord[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [modes, setModes] = useState<LiveMode[]>([])
  /** 每个场次的话术库统计（卡片上显示） */
  const [utteranceStats, setUtteranceStats] = useState<Record<string, { total: number; ready: number }>>({})
  const [editing, setEditing] = useState<{ plan?: LivePlan } | null>(null)
  const [deleting, setDeleting] = useState<LivePlan | null>(null)
  const [reviewing, setReviewing] = useState<LivePlan | null>(null)
  const [modesOpen, setModesOpen] = useState(false)

  const activePlanId = config.live.activePlanId

  const reload = useCallback(async () => {
    const [p, s, pe, v, pr, f, m] = await Promise.all([
      window.api.plan.list(),
      window.api.script.list(),
      window.api.persona.list(),
      window.api.voice.list(),
      window.api.knowledge.listProducts(),
      window.api.knowledge.listFiles(),
      window.api.mode.list()
    ])
    setPlans(p)
    setScripts(s)
    setPersonas(pe)
    setVoices(v)
    setProducts(pr)
    setFiles(f)
    setModes(m)
    const stats: Record<string, { total: number; ready: number }> = {}
    for (const plan of p) {
      const list = await window.api.utterance.list(plan.id)
      stats[plan.id] = { total: list.length, ready: list.filter((u) => u.status === 'ready').length }
    }
    setUtteranceStats(stats)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setActive = (id: string) => {
    void window.api.plan.setActive(id === activePlanId ? '' : id).then(async () => {
      await loadConfig() // 主进程写的 config，拉回来同步渲染端缓存
      await reload()
      toast.success(id === activePlanId ? '已取消当前场次' : '已设为当前场次', {
        description: id === activePlanId ? undefined : '下次开播按这个场次就位'
      })
    })
  }

  const scriptName = (id: string | null) => scripts.find((s) => s.id === id)?.title ?? null
  const personaName = (id: string | null) => personas.find((p) => p.id === id)?.name ?? null
  const modeName = (id: string) =>
    modes.find((m) => m.id === (id || DEFAULT_MODE_ID))?.name ??
    modes.find((m) => m.id === DEFAULT_MODE_ID)?.name ??
    null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <CalendarDays className="size-4 text-primary" />
        <h1 className="text-sm font-medium">场次</h1>
        <p className="text-xs text-muted-foreground">一场直播的完整配置：人设 + 形式 + 模式 + 剧本 + 知识库 + 话术库</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setModesOpen(true)}>
            <Drama />
            模式库
          </Button>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus />
            新建场次
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {plans.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <CalendarDays className="size-10" strokeWidth={1.25} />
            <p className="text-sm">还没有场次。建一个场次，把这场要用的人设、剧本、话术库都装进去</p>
          </div>
        ) : (
          <div className="grid max-w-4xl grid-cols-2 gap-3">
            {plans.map((plan) => {
              const active = plan.id === activePlanId
              const stats = utteranceStats[plan.id]
              return (
                <Card key={plan.id} className={active ? 'border-primary/50' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="min-w-0 truncate text-sm">{plan.name}</CardTitle>
                      {active && <Badge>当前场次</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                      {plan.theme || '（没写主题）'}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {personaName(plan.personaId) ? (
                        <Badge variant="secondary">{personaName(plan.personaId)}</Badge>
                      ) : (
                        <span>未绑人设</span>
                      )}
                      {plan.styleHint && <Badge variant="outline">{plan.styleHint}</Badge>}
                      {modeName(plan.modeId) && <Badge variant="outline">{modeName(plan.modeId)}</Badge>}
                      {scriptName(plan.scriptId) ? (
                        <Badge variant="secondary">{scriptName(plan.scriptId)}</Badge>
                      ) : (
                        <Badge variant="outline">未绑剧本</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <BookOpenText className="size-3.5" />
                      {stats && stats.total > 0 ? (
                        <span>
                          话术库 {stats.total} 段 · 就绪 {stats.ready}
                        </span>
                      ) : (
                        <span>话术库为空（点「话术库」生成）</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        variant={active ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setActive(plan.id)}
                      >
                        <Check />
                        {active ? '取消当前' : '设为当前'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setReviewing(plan)}>
                        <BookOpenText />
                        话术库
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditing({ plan })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(plan)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <PlanDialog
        key={editing?.plan?.id ?? 'new'}
        open={editing !== null}
        plan={editing?.plan}
        scripts={scripts}
        personas={personas}
        voices={voices}
        products={products}
        files={files}
        modes={modes}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      <ModesDialog open={modesOpen} modes={modes} onOpenChange={setModesOpen} onChanged={reload} />
      {reviewing && (
        <UtteranceDialog
          plan={reviewing}
          script={scripts.find((s) => s.id === reviewing.scriptId) ?? null}
          open
          onOpenChange={(open) => {
            if (!open) setReviewing(null)
          }}
          onChanged={reload}
        />
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除场次</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？本场话术库会一起删掉，绑定的剧本和人设卡不受影响。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                void window.api.plan.remove(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await loadConfig() // 删的可能是当前场次，拉一次同步
                    await reload()
                  } else toast.error('删除失败', { description: result.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 场次新建/编辑弹窗（docs/07 §8.5 场次完整清单的可配置子集） */
function PlanDialog({
  open,
  plan,
  scripts,
  personas,
  voices,
  products,
  files,
  modes,
  onOpenChange,
  onSaved
}: {
  open: boolean
  plan?: LivePlan
  scripts: Script[]
  personas: Persona[]
  voices: VoiceRecord[]
  products: Product[]
  files: KnowledgeFile[]
  modes: LiveMode[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<LivePlanInput>({
    name: plan?.name ?? '',
    theme: plan?.theme ?? '',
    personaId: plan?.personaId ?? null,
    styleHint: plan?.styleHint ?? '',
    modeId: plan?.modeId || DEFAULT_MODE_ID,
    plannedMinutes: plan?.plannedMinutes ?? DEFAULT_PLANNED_MINUTES,
    scriptId: plan?.scriptId ?? null,
    genConfig: plan?.genConfig ?? DEFAULT_PLAN_GEN_CONFIG,
    knowledgeScope: plan?.knowledgeScope ?? DEFAULT_PLAN_KNOWLEDGE_SCOPE,
    voiceId: plan?.voiceId ?? ''
  })
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const [busy, setBusy] = useState(false)

  const toggleScope = (kind: 'products' | 'files', id: string, checked: boolean) => {
    const current = form.knowledgeScope[kind]
    const list = current === '*' ? (kind === 'products' ? products : files).map((x) => x.id) : [...current]
    const next = checked ? [...new Set([...list, id])] : list.filter((x) => x !== id)
    setForm({ ...form, knowledgeScope: { ...form.knowledgeScope, [kind]: next } })
  }

  const scopeAll = (kind: 'products' | 'files', all: boolean) => {
    setForm({
      ...form,
      knowledgeScope: { ...form.knowledgeScope, [kind]: all ? '*' : [] }
    })
  }

  const submit = () => {
    if (!form.name.trim() || busy) return
    setBusy(true)
    void window.api.plan
      .save(form, plan?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(plan ? '场次已更新' : '场次已创建', {
            description: plan ? '结构性改动下次开播生效' : '接着去「话术库」生成内容'
          })
          onOpenChange(false)
          await onSaved()
        } else {
          toast.error('保存失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{plan ? '编辑场次' : '新建场次'}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">场次名称</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：周五晚 · 锅具专场"
              />
            </div>
            <div>
              <Label className="mb-1">主题方向</Label>
              <Input
                value={form.theme}
                onChange={(e) => setForm({ ...form, theme: e.target.value })}
                placeholder="这场播什么、什么氛围"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">主播人设卡</Label>
              <Select
                value={form.personaId ?? 'none'}
                onValueChange={(v) => setForm({ ...form, personaId: v === 'none' ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不绑定（用当前主播）</SelectItem>
                  {personas.map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1">演出形式</Label>
              <Input
                value={form.styleHint}
                onChange={(e) => setForm({ ...form, styleHint: e.target.value })}
                placeholder="单口 / 对口相声 / 幽默风…"
              />
            </div>
          </div>

          <div>
            <Label className="mb-1">直播模式</Label>
            <Select
              value={form.modeId || DEFAULT_MODE_ID}
              onValueChange={(v) => setForm({ ...form, modeId: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes.map((mode) => (
                  <SelectItem key={mode.id} value={mode.id}>
                    {mode.name}
                    {mode.builtIn ? '（内置）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {modes.find((m) => m.id === (form.modeId || DEFAULT_MODE_ID))?.description ??
                '模式决定主播怎么接外部事件、按什么角色定位演；自定义模式去「模式库」建'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">绑定剧本</Label>
              <Select
                value={form.scriptId ?? 'none'}
                onValueChange={(v) => setForm({ ...form, scriptId: v === 'none' ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不绑定（自由发挥）</SelectItem>
                  {scripts.map((script) => (
                    <SelectItem key={script.id} value={script.id}>
                      {script.title}（{script.scenes.length} 场）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {scripts.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">还没有剧本，去「知识库」页底部建一个</p>
              )}
            </div>
            <div>
              <Label className="mb-1">场次音色（覆盖人设音色）</Label>
              <Select
                value={form.voiceId || 'none'}
                onValueChange={(v) => setForm({ ...form, voiceId: v === 'none' ? '' : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不覆盖</SelectItem>
                  {groupCloneVoices(
                    voices.filter((v) => v.status === 'ready' && v.voiceType),
                    ttsConnections,
                    flattenModelCatalog(ttsProviders)
                  ).map((group) => (
                    <SelectGroup key={group.key}>
                      <SelectLabel className="flex items-center gap-2">
                        <ProviderIcon providerId={group.provider} size="sm" />
                        <span>
                          {group.connectionLabel} · {group.modelLabel}
                        </span>
                      </SelectLabel>
                      {group.voices.map((voice) => (
                        <SelectItem key={voice.id} value={voice.voiceType}>
                          {voice.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                列出音色库所有已就绪的克隆音色（按服务商分组）：没配接入的那家选中后会就地提示
              </p>
              <VoiceProviderHint voiceId={form.voiceId} />
            </div>
          </div>

          <ScopePicker
            label="本场可用商品"
            icon={<Package className="size-3.5" />}
            items={products.map((p) => ({ id: p.id, name: p.name }))}
            value={form.knowledgeScope.products}
            onToggle={(id, checked) => toggleScope('products', id, checked)}
            onAll={(all) => scopeAll('products', all)}
          />
          <ScopePicker
            label="本场可用资料文件"
            icon={<FileText className="size-3.5" />}
            items={files.map((f) => ({ id: f.id, name: f.name }))}
            value={form.knowledgeScope.files}
            onToggle={(id, checked) => toggleScope('files', id, checked)}
            onAll={(all) => scopeAll('files', all)}
          />

          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium">播报成本阀（管这场播出同时存多少段，不管底稿怎么写）</p>
            <div>
              <Label className="mb-1 text-xs text-muted-foreground">段数上限（0 = 无限）</Label>
              <Input
                type="number"
                min={0}
                max={2000}
                value={form.genConfig.maxBits}
                onChange={(e) =>
                  setForm({
                    ...form,
                    genConfig: { ...form.genConfig, maxBits: Math.max(0, Math.floor(Number(e.target.value) || 0)) }
                  })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                写满上限就停，开播后池空了循环已有底稿（音频复用，不重新合成）；
                无限 = 不封顶，主播低水位会一直续写新段。生成时长和语气在「生成底稿」时填，是一次性配置
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!form.name.trim() || busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 知识库范围选择器：全选开关 + 逐项勾选 */
function ScopePicker({
  label,
  icon,
  items,
  value,
  onToggle,
  onAll
}: {
  label: string
  icon: React.ReactNode
  items: { id: string; name: string }[]
  value: '*' | string[]
  onToggle: (id: string, checked: boolean) => void
  onAll: (all: boolean) => void
}) {
  const all = value === '*'
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <p className="text-xs font-medium">{label}</p>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={all} onCheckedChange={(v) => onAll(v === true)} aria-label="全选" />
          全部
        </label>
      </div>
      {!all && items.length > 0 && (
        <div className="grid max-h-28 grid-cols-2 gap-1.5 overflow-y-auto">
          {items.map((item) => (
            <label key={item.id} className="flex min-w-0 items-center gap-1.5 text-xs">
              <Checkbox
                checked={value.includes(item.id)}
                onCheckedChange={(v) => onToggle(item.id, v === true)}
              />
              <span className="truncate">{item.name}</span>
            </label>
          ))}
        </div>
      )}
      {!all && items.length === 0 && <p className="text-xs text-muted-foreground">（还没有可选条目）</p>}
      {all && <p className="text-xs text-muted-foreground">当前与将来新增的都会纳入</p>}
    </div>
  )
}

/**
 * 话术库审阅表（docs/07 §4 ③④）：逐条可编辑/删除、来源留痕（外部来源高亮）、
 * 「生成话术库」走生成 Agent（工具循环）、「预合成」批量 TTS。
 */
function UtteranceDialog({
  plan,
  script,
  open,
  onOpenChange,
  onChanged
}: {
  plan: LivePlan
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
    setItems(await window.api.utterance.list(plan.id))
  }, [plan.id])

  useEffect(() => {
    void reload()
  }, [reload])

  // 预合成进度订阅（主播写稿入库走直播台时间线，这里只关心音频状态变化）
  useEffect(() => {
    const offUt = window.api.utterance.onEvent((u) => {
      if (u.planId !== plan.id) return
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
  }, [plan.id, reload, onChanged])

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

  // 「生成话术库」：先问预生成时长（一次性输入，不是场次属性），再跳直播台派主播写稿
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
    const result = await window.api.agent.draftStart(plan.id)
    if (!result.ok) toast.error('派写稿任务失败', { description: result.error })
  }

  const startPresynth = async () => {
    setPresynthRunning(true)
    await window.api.utterance.presynth(plan.id)
  }

  const saveEdit = async (u: Utterance) => {
    const result = await window.api.utterance.save(
      {
        planId: u.planId,
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
    const result = await window.api.utterance.clear(plan.id)
    if (result.ok) {
      toast.success('已清空全部底稿', { description: '点「生成话术库」让主播重写' })
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
            话术库 · {plan.name}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {stats.total} 段 · 就绪 {stats.ready}
              {stats.failed > 0 ? ` · 失败 ${stats.failed}` : ''}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setDraftAsk(true)}>
            <Sparkles />
            {items.length > 0 ? '去直播台续写' : '生成话术库'}
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
                还没有话术。点「生成话术库」，主播会在直播台写稿——过程看得见，随时可以插话改口径
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
          plan={plan}
          open={draftAsk}
          onOpenChange={setDraftAsk}
          onConfirm={() => void goDraft()}
        />
      </DialogContent>
    </Dialog>
  )
}

/** 评论接入方式的展示名 */
const COMMENTS_LABEL: Record<LiveModeWiring['comments'], string> = {
  off: '不接评论',
  batched: '评论攒批',
  full: '逐条即派'
}
const ENTRANCES_LABEL: Record<LiveModeWiring['entrances'], string> = {
  off: '不理进场',
  fans: '只欢迎老粉',
  all: '都欢迎'
}

/** 模式库：内置模式随代码升级（只能复制），自定义模式自由增删改。场次只存 modeId，改模式对所有场次生效。 */
function ModesDialog({
  open,
  modes,
  onOpenChange,
  onChanged
}: {
  open: boolean
  modes: LiveMode[]
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}) {
  /** null=列表视图；{input, id?}=编辑/新建视图 */
  const [draft, setDraft] = useState<{ input: LiveModeInput; id?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (next: boolean) => {
    if (!next) setDraft(null)
    onOpenChange(next)
  }

  const startEdit = (mode: LiveMode) => {
    setDraft({
      id: mode.id,
      input: {
        name: mode.name,
        description: mode.description,
        wiring: { ...mode.wiring },
        promptModule: mode.promptModule
      }
    })
  }

  const startNew = () => {
    setDraft({
      input: {
        name: '',
        description: '',
        wiring: { comments: 'batched', commentBatchSec: 15, entrances: 'fans', triggers: true },
        promptModule: ''
      }
    })
  }

  const submit = () => {
    if (!draft || !draft.input.name.trim() || busy) return
    setBusy(true)
    void window.api.mode
      .save(draft.input, draft.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(draft.id ? '模式已更新' : '模式已创建', {
            description: '用它的场次下次开播生效'
          })
          setDraft(null)
          await onChanged()
        } else toast.error('保存失败', { description: result.error })
      })
      .finally(() => setBusy(false))
  }

  const duplicate = (mode: LiveMode) => {
    void window.api.mode.duplicate(mode.id).then(async (result) => {
      if (result.ok) {
        toast.success('已复制，可以随便改了')
        await onChanged()
      } else toast.error('复制失败', { description: result.error })
    })
  }

  const remove = (mode: LiveMode) => {
    void window.api.mode.remove(mode.id).then(async (result) => {
      if (result.ok) {
        toast.success('已删除', { description: '引用它的场次会回落到默认互动模式' })
        await onChanged()
      } else toast.error('删除失败', { description: result.error })
    })
  }

  const wiringSummary = (w: LiveModeWiring) =>
    `${COMMENTS_LABEL[w.comments]}${w.comments === 'batched' ? `（${w.commentBatchSec}s）` : ''} · ${ENTRANCES_LABEL[w.entrances]} · 触发器${w.triggers ? '开' : '关'}`

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.id ? '编辑模式' : '新建模式') : '直播模式库'}</DialogTitle>
        </DialogHeader>
        {draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1">模式名称</Label>
                <Input
                  value={draft.input.name}
                  onChange={(e) => setDraft({ ...draft, input: { ...draft.input, name: e.target.value } })}
                  placeholder="例如：深夜情感场"
                />
              </div>
              <div>
                <Label className="mb-1">一句话说明</Label>
                <Input
                  value={draft.input.description}
                  onChange={(e) =>
                    setDraft({ ...draft, input: { ...draft.input, description: e.target.value } })
                  }
                  placeholder="这场怎么播，给谁看"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="mb-1">评论接入</Label>
                <Select
                  value={draft.input.wiring.comments}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: { ...draft.input.wiring, comments: v as LiveModeWiring['comments'] }
                      }
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">不接（纯直播）</SelectItem>
                    <SelectItem value="batched">攒批派给主播</SelectItem>
                    <SelectItem value="full">逐条即派</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1">攒批窗口（秒）</Label>
                <Input
                  type="number"
                  min={3}
                  max={120}
                  disabled={draft.input.wiring.comments !== 'batched'}
                  value={draft.input.wiring.commentBatchSec}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: {
                          ...draft.input.wiring,
                          commentBatchSec: Math.max(3, Math.min(120, Number(e.target.value) || 15))
                        }
                      }
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1">进场事件</Label>
                <Select
                  value={draft.input.wiring.entrances}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: { ...draft.input.wiring, entrances: v as LiveModeWiring['entrances'] }
                      }
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">不理</SelectItem>
                    <SelectItem value="fans">只欢迎老粉</SelectItem>
                    <SelectItem value="all">都欢迎</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.input.wiring.triggers}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    input: {
                      ...draft.input,
                      wiring: { ...draft.input.wiring, triggers: checked === true }
                    }
                  })
                }
              />
              自动化触发器（冷场自救/整点带节奏/价格提醒…；关掉主播就不被任何外部事件打扰）
            </label>

            <div className="flex min-h-0 flex-1 flex-col">
              <Label className="mb-1">角色定位提示词模块（拼进主播 system prompt 的「本场直播」段）</Label>
              <Textarea
                className="min-h-40 flex-1 font-mono text-xs"
                value={draft.input.promptModule}
                onChange={(e) =>
                  setDraft({ ...draft, input: { ...draft.input, promptModule: e.target.value } })
                }
                placeholder={'- 直播模式：xxx。这场怎么演…\n- 节奏/形态上的特别要求…'}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                只写「怎么演」的定位和节奏要求；具体内容仍由主播自编自导
              </p>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                返回
              </Button>
              <Button onClick={submit} disabled={!draft.input.name.trim() || busy}>
                {busy && <Loader2 className="animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {modes.map((mode) => (
              <div key={mode.id} className="flex items-start gap-2 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{mode.name}</span>
                    {mode.builtIn && <Badge variant="secondary">内置</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{mode.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{wiringSummary(mode.wiring)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" title="复制一份再改" onClick={() => duplicate(mode)}>
                    <Copy />
                  </Button>
                  {!mode.builtIn && (
                    <>
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => startEdit(mode)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => remove(mode)}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            <div className="pt-1">
              <Button size="sm" variant="outline" onClick={startNew}>
                <Plus />
                新建模式
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
