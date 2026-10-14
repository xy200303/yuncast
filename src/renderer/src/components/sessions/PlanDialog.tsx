import { useState } from 'react'
import { FileText, Package } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DEFAULT_MODE_ID,
  DEFAULT_PLAN_GEN_CONFIG,
  DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  DEFAULT_PLANNED_MINUTES,
  type KnowledgeFile,
  type LiveMode,
  type LivePlan,
  type LivePlanInput,
  type Persona,
  type Product,
  type Script
} from '../../../../shared/types'

/** 场次新建/编辑弹窗（人设（必选）/模式/剧本/知识库/成本阀；音色归主播自己定，生成时长语气归生成弹窗） */
export function PlanDialog({
  open,
  plan,
  scripts,
  personas,
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
  products: Product[]
  files: KnowledgeFile[]
  modes: LiveMode[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<LivePlanInput>({
    name: plan?.name ?? '',
    theme: plan?.theme ?? '',
    // 场次必须绑主播：默认跟当前主播（列表按 active DESC 排，第一个就是；旧表单值优先）
    personaId: plan?.personaId ?? personas[0]?.id ?? null,
    styleHint: plan?.styleHint ?? '',
    modeId: plan?.modeId || DEFAULT_MODE_ID,
    plannedMinutes: plan?.plannedMinutes ?? DEFAULT_PLANNED_MINUTES,
    scriptId: plan?.scriptId ?? null,
    genConfig: plan?.genConfig ?? DEFAULT_PLAN_GEN_CONFIG,
    knowledgeScope: plan?.knowledgeScope ?? DEFAULT_PLAN_KNOWLEDGE_SCOPE,
    voiceId: plan?.voiceId ?? ''
  })
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
    if (!form.personaId) {
      toast.error('场次必须绑定主播人设卡')
      return
    }
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
              <Label className="mb-1">主播人设卡（必选）</Label>
              <Select
                value={form.personaId ?? ''}
                onValueChange={(v) => setForm({ ...form, personaId: v || null })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择主播" />
                </SelectTrigger>
                <SelectContent>
                  {personas.map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">音色由主播自己定（人设默认音色 + 直播中可自己换）</p>
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
                  '演出形式已并入模式：模式决定怎么接外部事件、按什么角色定位演；自定义去「模式库」'}
              </p>
            </div>
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
                  <SelectItem value="none">不绑定（主播自己编）</SelectItem>
                  {scripts.map((script) => (
                    <SelectItem key={script.id} value={script.id}>
                      {script.title}（{script.scenes.length} 场）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {scripts.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">还没有剧本，去「知识库」页底部建一个；不绑主播也能自己编</p>
              )}
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
