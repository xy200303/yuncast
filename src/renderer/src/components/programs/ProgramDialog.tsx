import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, Package, Zap } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../stores/useAppStore'
import {
  BROADCAST_MODE_LABELS,
  CONTENT_TYPE_LABELS,
  DEFAULT_PROGRAM_INPUT,
  PROGRAM_LANGUAGE_LABELS,
  type BroadcastMode,
  type ContentType,
  type KnowledgeFile,
  type Persona,
  type Product,
  type Program,
  type ProgramInput,
  type ProgramLanguage,
  type Script,
  type Trigger
} from '../../../../shared/types'

/** 内容类型的一句话说明（docs/10 §4.1） */
const CONTENT_TYPE_DESC: Record<ContentType, string> = {
  solo: '一个主播从头讲到尾：带货、宣讲、陪聊都适合',
  conversation: '几个人你一言我一语地聊，像播客对谈',
  reading: '照着现成的稿子念：文章朗读、有声书',
  roleplay: '主播分饰多角演剧本，每个角色可以有自己的声音'
}

/** 播出方式的一句话说明（docs/10 §4.2） */
const BROADCAST_MODE_DESC: Record<BroadcastMode, string> = {
  improvised: '主播看着直播间动态临场说，无需底稿',
  rolling: '一边播前面的、一边合成后面的，可随时改稿插播',
  prepared: '先把音频全部做好，再播放或导出，适合有声书、播客'
}

/** 事件分组（docs/10 §4.3）：按事件名前缀归到三组勾选项 */
type EventGroup = 'live' | 'program' | 'business'

const EVENT_GROUP_LABEL: Record<EventGroup, string> = {
  live: '直播间事件',
  program: '节目状态',
  business: '业务事件'
}

function eventGroupOf(event: string): EventGroup {
  const prefix = event.split('.')[0]
  if (['comment', 'viewer', 'gift', 'like'].includes(prefix)) return 'live'
  if (['pool', 'stream', 'timer', 'scene', 'chapter', 'program'].includes(prefix)) return 'program'
  return 'business'
}

/** 节目新建/配置弹窗（docs/10 §11.3）：基本信息 / 播出方式 / 事件规则（栏内页）/ 知识范围 */
export function ProgramDialog({
  open,
  program,
  scripts,
  products,
  files,
  onOpenChange,
  onSaved
}: {
  open: boolean
  program?: Program
  scripts: Script[]
  products: Product[]
  files: KnowledgeFile[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<ProgramInput>(() =>
    program
      ? {
          name: program.name,
          theme: program.theme,
          contentType: program.contentType,
          broadcastMode: program.broadcastMode,
          finishMode: program.finishMode,
          allowLiveEvents: program.allowLiveEvents,
          enabledTriggerIds: program.enabledTriggerIds,
          presenterIds: program.presenterIds,
          instruction: program.instruction ?? '',
          language: program.language ?? 'auto',
          scriptId: program.scriptId,
          knowledgeScope: program.knowledgeScope
        }
      : { ...DEFAULT_PROGRAM_INPUT, knowledgeScope: { ...DEFAULT_PROGRAM_INPUT.knowledgeScope } }
  )
  const [busy, setBusy] = useState(false)
  /** 栏内视图：事件规则不开嵌套弹窗，dialog 内切换（docs/10 §11.4） */
  const [view, setView] = useState<'main' | 'events'>('main')
  /** 卡司候选（全部主播卡）：打开弹窗时拉一次 */
  const [personaOptions, setPersonaOptions] = useState<Persona[]>([])
  useEffect(() => {
    if (!open || !('api' in window)) return
    void window.api.persona.list().then(setPersonaOptions)
  }, [open])

  const patch = (part: Partial<ProgramInput>) => setForm((prev) => ({ ...prev, ...part }))

  const toggleScope = (kind: 'products' | 'files', id: string, checked: boolean) => {
    const current = form.knowledgeScope[kind]
    const list = current === '*' ? (kind === 'products' ? products : files).map((x) => x.id) : [...current]
    const next = checked ? [...new Set([...list, id])] : list.filter((x) => x !== id)
    patch({ knowledgeScope: { ...form.knowledgeScope, [kind]: next } })
  }

  const scopeAll = (kind: 'products' | 'files', all: boolean) => {
    patch({ knowledgeScope: { ...form.knowledgeScope, [kind]: all ? '*' : [] } })
  }

  const toggleTrigger = (id: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...form.enabledTriggerIds, id])]
      : form.enabledTriggerIds.filter((x) => x !== id)
    patch({ enabledTriggerIds: next })
  }

  const togglePresenter = (id: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...form.presenterIds, id])]
      : form.presenterIds.filter((x) => x !== id)
    patch({ presenterIds: next })
  }

  const submit = () => {
    if (!form.name.trim() || busy) return
    /**
     * 节目不存任何声音配置：谁出声由卡司决定（卡司卡上的音色），合成时也可在弹窗里临时换一把。
     * 这里只配节目级风格指令——整期默认演法，覆盖音色默认风格、低于 agent 逐条 delivery，进预制音频指纹。
     */
    setBusy(true)
    const input: ProgramInput = {
      ...form,
      name: form.name.trim(),
      finishMode: form.broadcastMode === 'improvised' ? 'stop' : form.finishMode,
      instruction: form.instruction?.trim() || undefined
    }
    void window.api.program
      .save(input, program?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(program ? '节目已更新' : '节目已创建', {
            description: program ? '结构性改动下次开播生效' : '接着去「底稿库」生成内容'
          })
          onOpenChange(false)
          await onSaved()
        } else {
          toast.error('保存失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  const enabledCount = form.enabledTriggerIds.length + (form.allowLiveEvents ? 1 : 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {view === 'events' && (
              <Button variant="ghost" size="icon-sm" onClick={() => setView('main')} title="返回节目配置">
                <ChevronLeft />
              </Button>
            )}
            {view === 'events' ? `事件规则 · ${form.name || '未命名节目'}` : program ? '节目配置' : '新建节目'}
          </DialogTitle>
        </DialogHeader>

        {view === 'events' ? (
          <EventsView form={form} onToggleTrigger={toggleTrigger} onToggleLiveEvents={(v) => patch({ allowLiveEvents: v })} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1">节目名称</Label>
                <Input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="例如：周五晚 · 锅具专场"
                />
              </div>
              <div>
                <Label className="mb-1">剧本 / 文章</Label>
                <Select
                  value={form.scriptId ?? 'none'}
                  onValueChange={(v) => patch({ scriptId: v === 'none' ? null : v })}
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

            <div>
              <Label className="mb-1.5">内容类型</Label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(CONTENT_TYPE_LABELS) as ContentType[]).map((type) => (
                  <ChoiceCard
                    key={type}
                    selected={form.contentType === type}
                    label={CONTENT_TYPE_LABELS[type]}
                    desc={CONTENT_TYPE_DESC[type]}
                    onClick={() => patch({ contentType: type })}
                  />
                ))}
              </div>
            </div>

            <div>
              <Label className="mb-1">主题与节目说明</Label>
              <Textarea
                value={form.theme}
                onChange={(e) => patch({ theme: e.target.value })}
                placeholder="这个节目播什么、什么氛围；会作为节目上下文交给导演"
                className="min-h-16 resize-none"
              />
            </div>

            {/* 节目级风格指令：整期默认演法（覆盖卡司嗓音的默认风格，agent 逐条演法优先） */}
            <div>
              <Label className="mb-1">节目风格指令（可选，≤100 字）</Label>
              <Input
                value={form.instruction ?? ''}
                onChange={(e) => patch({ instruction: e.target.value })}
                maxLength={100}
                placeholder="年轻活泼的女性，语速较快，带货场景"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                整期默认演法：覆盖卡司嗓音的默认风格，agent 逐条指定的 delivery 优先。改动后已合成的预制音频会判过期，重新合成
              </p>
            </div>

            {/* 播出语言（多语言节目/跨境电商） */}
            <div>
              <Label className="mb-1">播出语言</Label>
              <Select
                value={form.language ?? 'auto'}
                onValueChange={(value) => patch({ language: value as ProgramLanguage })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROGRAM_LANGUAGE_LABELS) as ProgramLanguage[]).map((language) => (
                    <SelectItem key={language} value={language}>
                      {PROGRAM_LANGUAGE_LABELS[language]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                非中文节目：写稿要求用该语言撰写，合成时给 TTS 传语种提示（仅百炼 qwen3-tts 生效）；跨境电商/多语种播报用
              </p>
            </div>

            {/* 播出方式 */}
            <div>
              <Label className="mb-1.5">播出方式</Label>
              <div className="flex flex-col gap-2">
                {(Object.keys(BROADCAST_MODE_LABELS) as BroadcastMode[]).map((mode) => (
                  <ChoiceCard
                    key={mode}
                    selected={form.broadcastMode === mode}
                    label={BROADCAST_MODE_LABELS[mode]}
                    desc={BROADCAST_MODE_DESC[mode]}
                    onClick={() => patch({ broadcastMode: mode })}
                  />
                ))}
              </div>
              {form.broadcastMode !== 'improvised' && (
                <div className="mt-2 flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">播完以后</Label>
                  <div className="flex gap-2">
                    {(
                      [
                        { id: 'stop', label: '播完停止' },
                        { id: 'loop', label: '循环播放' }
                      ] as const
                    ).map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        variant={form.finishMode === option.id ? 'secondary' : 'outline'}
                        onClick={() => patch({ finishMode: option.id })}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 事件规则：一行摘要，点进栏内页勾选 */}
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
              onClick={() => setView('events')}
            >
              <Zap className="size-3.5 shrink-0 text-primary" />
              <span className="text-[13px] font-medium">事件规则</span>
              <span className="text-xs text-muted-foreground">现场发生什么时主播要做什么</span>
              <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                已开启 {enabledCount} 项
                <ChevronRight className="size-3.5" />
              </span>
            </button>

            {/* 卡司：导演手下有哪些人设可用（空 = 导演自选，全部主播卡都是候选人） */}
            <div>
              <Label className="mb-1.5">卡司</Label>
              <div className="rounded-lg border p-3">
                {personaOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">还没有主播卡，去「主播团」建一张；不选 = 导演自选</p>
                ) : (
                  <div className="grid max-h-28 grid-cols-2 gap-1.5 overflow-y-auto">
                    {personaOptions.map((p) => (
                      <label key={p.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={form.presenterIds.includes(p.id)}
                          onCheckedChange={(v) => togglePresenter(p.id, v === true)}
                        />
                        <span className="truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {form.presenterIds.length === 0
                    ? '不选 = 导演自选：全部主播卡都是候选人'
                    : `已选 ${form.presenterIds.length} 位：导演只在这些卡里挑人出镜`}
                </p>
              </div>
            </div>

            {/* 知识范围 */}
            <ScopePicker
              label="本节目可用商品"
              icon={<Package className="size-3.5" />}
              items={products.map((p) => ({ id: p.id, name: p.name }))}
              value={form.knowledgeScope.products}
              onToggle={(id, checked) => toggleScope('products', id, checked)}
              onAll={(all) => scopeAll('products', all)}
            />
            <ScopePicker
              label="本节目可用资料文件"
              icon={<FileText className="size-3.5" />}
              items={files.map((f) => ({ id: f.id, name: f.name }))}
              value={form.knowledgeScope.files}
              onToggle={(id, checked) => toggleScope('files', id, checked)}
              onAll={(all) => scopeAll('files', all)}
            />
          </div>
        )}

        <DialogFooter>
          {view === 'events' ? (
            <Button variant="outline" onClick={() => setView('main')}>
              返回节目配置
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
          <Button disabled={!form.name.trim() || busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 单选卡片：标签 + 一句话说明 */
function ChoiceCard({
  selected,
  label,
  desc,
  onClick
}: {
  selected: boolean
  label: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent/40',
        selected && 'border-primary/60 bg-primary/5'
      )}
    >
      <p className="text-[13px] font-medium">{label}</p>
      <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{desc}</p>
    </button>
  )
}

/** 事件规则栏内页（docs/10 §11.4）：三组勾选项，勾选数据来自全局触发器库 */
function EventsView({
  form,
  onToggleTrigger,
  onToggleLiveEvents
}: {
  form: ProgramInput
  onToggleTrigger: (id: string, checked: boolean) => void
  onToggleLiveEvents: (checked: boolean) => void
}) {
  const [triggers, setTriggers] = useState<Trigger[] | null>(null)

  useEffect(() => {
    void window.api.trigger.list().then(setTriggers)
  }, [])

  if (triggers === null) return <div className="py-8 text-center text-xs text-muted-foreground">加载中…</div>

  const groups: { id: EventGroup; items: Trigger[] }[] = (['live', 'program', 'business'] as const).map(
    (id) => ({ id, items: triggers.filter((t) => eventGroupOf(t.on.event) === id) })
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {triggers.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          触发器库还是空的——先到触发器库创建规则，再回到这里勾选这个节目要启用哪些
        </p>
      )}
      {groups.map((group) => (
        <div key={group.id}>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{EVENT_GROUP_LABEL[group.id]}</p>
          <div className="flex flex-col gap-1 rounded-lg border p-2">
            {group.id === 'live' && (
              <label className="flex items-center gap-2 px-1 py-1 text-[13px]">
                <Checkbox
                  checked={form.allowLiveEvents}
                  onCheckedChange={(v) => onToggleLiveEvents(v === true)}
                />
                <span className="min-w-0 flex-1">
                  将评论/动态提供给主播
                  <span className="block text-xs text-muted-foreground">
                    关掉后主播看不到直播间里发生什么，直播台也不再显示直播间动态
                  </span>
                </span>
              </label>
            )}
            {group.items.map((trigger) => (
              <label key={trigger.id} className="flex items-center gap-2 px-1 py-1 text-[13px]">
                <Checkbox
                  checked={form.enabledTriggerIds.includes(trigger.id)}
                  onCheckedChange={(v) => onToggleTrigger(trigger.id, v === true)}
                />
                <span className="min-w-0 flex-1 truncate">{trigger.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{trigger.on.event}</span>
              </label>
            ))}
            {group.items.length === 0 && group.id !== 'live' && (
              <p className="px-1 py-1 text-xs text-muted-foreground">（这组还没有规则）</p>
            )}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        冷却时间、话术模板等高级参数在全局触发器库调；这里只决定这个节目启用哪几项。
      </p>
    </div>
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
