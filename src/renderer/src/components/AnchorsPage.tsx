import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2, Play, Plus, Square, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AssetStaleBanner } from '@/components/AssetStaleBanner'
import { ProviderIcon } from '@/components/ProviderIcon'
import { VoiceProviderHint } from '@/components/VoiceProviderHint'
import { groupVoicesByProvider } from '../lib/voice'
import {
  effectiveModel,
  selectLlmReady,
  useAppStore,
  type LlmProviderManifest
} from '../stores/useAppStore'
import type { ModelConnectionSafe, Persona, Trigger, TriggerMode } from '../../../shared/types'

/** 下拉里「接入 + 模型」两级值的分隔符（接入 id 里不会有冒号） */
const MODEL_VALUE_SEP = '::'

function brainValue(connectionId: string, model: string): string {
  return `${connectionId}${MODEL_VALUE_SEP}${model}`
}

function parseBrainValue(value: string): { modelConnectionId: string; model: string } {
  const index = value.indexOf(MODEL_VALUE_SEP)
  if (index < 0) return { modelConnectionId: '', model: '' }
  return {
    modelConnectionId: value.slice(0, index),
    model: value.slice(index + MODEL_VALUE_SEP.length)
  }
}

/** 卡片摘要里的「大脑」：接入名 · 模型；没选或接入已删就明说，不再有「默认（…）」的包装 */
function brainLabelOf(connections: ModelConnectionSafe[], persona: Persona): string {
  const bound = persona.modelConnectionId
    ? connections.find((item) => item.id === persona.modelConnectionId)
    : undefined
  if (!bound) return persona.modelConnectionId ? '接入已删除' : '未选（点开这张卡选一个）'
  return `${bound.name} · ${persona.model || '未选模型'}`
}

const AGENT_STATE_LABEL: Record<string, string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '出错'
}

const MODE_LABEL: Record<TriggerMode, string> = {
  tool: '模板直连',
  steer: '引导',
  task: '任务'
}

const MODE_BADGE_VARIANT: Record<TriggerMode, 'outline' | 'secondary' | 'default'> = {
  tool: 'outline',
  steer: 'secondary',
  task: 'default'
}

type PersonaForm = Omit<Persona, 'id' | 'updatedAt'>

/** 主播团：人设卡 / 触发器两个选项卡 + 主播 Agent 开关。多张卡各自可设为当前主播（开播时由场次带着切换）。 */
export function AnchorsPage() {
  const agent = useAppStore((s) => s.agent)
  const connections = useAppStore((s) => s.connections)
  const persona = useAppStore((s) => s.persona)
  const setPersona = useAppStore((s) => s.setPersona)
  const llmReady = selectLlmReady(connections, persona)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [activeId, setActiveId] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'persona' | 'triggers'>('persona')
  /** 编辑器：undefined=关闭；{id?}=编辑某张卡；{}=新建 */
  const [editing, setEditing] = useState<{ persona?: Persona } | null>(null)

  const reload = useCallback(async () => {
    const [list, current] = await Promise.all([
      window.api.persona.list(),
      window.api.persona.get()
    ])
    setPersonas(list)
    setActiveId(current?.id ?? '')
    setPersona(current)
  }, [setPersona])

  useEffect(() => {
    void reload()
  }, [reload])

  const openEditor = (persona?: Persona) => setEditing(persona ? { persona } : {})

  /** 保存后不偷偷重启会话：人设/模型是出生时冻结的，改了靠黄条上的「立即应用」显式生效 */
  const afterSaved = (okText: string) => {
    if (useAppStore.getState().agent.state === 'running') {
      toast.success(okText, { description: '本场主播用的还是开播时的版本，改动下次开播生效（可点黄条立即应用）' })
    } else {
      toast.success(okText)
    }
  }

  const toggleAgent = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (agent.state === 'running' || agent.state === 'starting') {
        await window.api.agent.stop()
        toast.message('主播已下播', { description: '话术池里的存货会继续播完' })
      } else {
        const result = await window.api.agent.start()
        if (result.ok) toast.success('主播已开播', { description: '开场白正在路上' })
        else toast.error('主播启动失败', { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AssetStaleBanner />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Bot className="size-4 text-primary" />
        <h1 className="text-sm font-medium">主播团</h1>
        <p className="text-xs text-muted-foreground">人设卡 · 触发器 · 主播开关</p>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={agent.state === 'running' ? 'secondary' : agent.state === 'error' ? 'destructive' : 'outline'}>
            {AGENT_STATE_LABEL[agent.state]}
            {agent.model ? ` · ${agent.model}` : ''}
          </Badge>
          <Button
            variant={agent.state === 'running' || agent.state === 'starting' ? 'secondary' : 'default'}
            size="sm"
            disabled={busy}
            onClick={() => void toggleAgent()}
            title={llmReady ? undefined : '当前主播卡还没选好大脑：点开卡片选一个接入和模型'}
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : agent.state === 'running' || agent.state === 'starting' ? (
              <Square />
            ) : (
              <Play />
            )}
            {agent.state === 'running' || agent.state === 'starting' ? '停止主播' : '启动主播'}
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="persona" className="px-3">人设卡</TabsTrigger>
            <TabsTrigger value="triggers" className="px-3">触发器</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="persona" className="overflow-auto p-4">
          {agent.state === 'error' && agent.error && (
            <div className="mb-3 max-w-2xl rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {agent.error}
              {!llmReady && ' — 先点开这张人设卡，给它选一个接入和模型'}
            </div>
          )}

          <div className="mb-3 flex items-center gap-2">
            <p className="text-xs text-muted-foreground">主播团 · {personas.length} 位</p>
            <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => openEditor()}>
              <Plus className="size-3.5" />
              新建人设卡
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {personas.map((item) => {
              const active = item.id === activeId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openEditor(item)}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40',
                    active && 'border-primary'
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary">
                      {item.name.trim().slice(0, 1) || '主'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.name}</span>
                    {active && <Badge variant="secondary" className="shrink-0">当前主播</Badge>}
                  </div>
                  <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                    {item.personality || '（还没写性格）'}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    大脑：{brainLabelOf(connections, item)} · 嗓子：
                    {item.voiceId || 'TTS 默认'}
                  </p>
                  <VoiceProviderHint voiceId={item.voiceId} />
                  <div className="flex flex-wrap gap-1">
                    {item.roles.slice(0, 2).map((role) => (
                      <Badge key={role.name} variant="outline" className="text-[11px]">
                        角色 · {role.name || '未命名'}
                      </Badge>
                    ))}
                    {item.voiceId && (
                      <Badge variant="outline" className="text-[11px]">
                        音色 {item.voiceId.slice(0, 10)}
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="triggers" className="overflow-auto p-4">
          <TriggerSection />
        </TabsContent>
      </Tabs>
      {/* 人设卡编辑器 */}
      <PersonaEditorDialog
        key={editing?.persona?.id ?? 'new'}
        editing={editing}
        isActive={editing?.persona?.id === activeId}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={async (text) => {
          setEditing(null)
          await reload()
          afterSaved(text)
        }}
        onDeleted={async () => {
          setEditing(null)
          await reload()
        }}
      />
    </div>
  )
}

/** 人设卡编辑器：点击卡片弹出，含设为当前主播与删除 */
function PersonaEditorDialog({
  editing,
  isActive,
  onOpenChange,
  onSaved,
  onDeleted
}: {
  editing: { persona?: Persona } | null
  isActive: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (okText: string) => void | Promise<void>
  onDeleted: () => void | Promise<void>
}) {
  const open = editing !== null
  const source = editing?.persona
  const connections = useAppStore((s) => s.connections)
  const providers = useAppStore((s) => s.llmProviders)
  const [form, setForm] = useState<PersonaForm>(() => ({
    name: source?.name ?? '',
    personality: source?.personality ?? '',
    catchphrases: source?.catchphrases ?? '',
    background: source?.background ?? '',
    taboos: source?.taboos ?? '',
    voiceId: source?.voiceId ?? '',
    modelConnectionId: source?.modelConnectionId ?? null,
    model: source?.model ?? '',
    roles: source?.roles ?? []
  }))
  const [busy, setBusy] = useState(false)
  const [voicePickerOpen, setVoicePickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 绑定的接入可能已被删掉：那时按「没选」显示，让用户重新挑一条
  const boundConnection = form.modelConnectionId
    ? connections.find((item) => item.id === form.modelConnectionId)
    : undefined
  const selectedBrain =
    boundConnection && form.model ? brainValue(boundConnection.id, form.model) : ''

  const patch = (part: Partial<PersonaForm>) => setForm((prev) => ({ ...prev, ...part }))

  const save = async (alsoActivate: boolean) => {
    if (busy) return
    if (!form.name.trim()) {
      toast.warning('请填写主播名字')
      return
    }
    if (!boundConnection || !form.model.trim()) {
      toast.warning('给这张卡选个大脑：选一个接入和模型')
      return
    }
    setBusy(true)
    try {
      const saved = await window.api.persona.save(form, source?.id)
      if (alsoActivate) await window.api.persona.setActive(saved.id)
      await onSaved(alsoActivate ? '已保存并设为当前主播' : '人设已保存')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source ? `人设卡 · ${source.name || '未命名'}` : '新建人设卡'}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">名字</Label>
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="如：小陶 / 小助理" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label>默认音色（留空用 TTS 默认）</Label>
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setVoicePickerOpen(true)}>
                  从音色库选择
                </Button>
              </div>
              <Input
                value={form.voiceId}
                onChange={(e) => patch({ voiceId: e.target.value })}
                placeholder="voiceId"
              />
              <VoiceProviderHint voiceId={form.voiceId} />
            </div>
          </div>

          <div>
            <Label className="mb-1">大脑（模型）</Label>
            {connections.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                还没有供应商接入，去「设置 → 语言模型」加一条（选服务商、填一次密钥、把那家能用的模型放进列表）。
              </p>
            ) : (
              <Select value={selectedBrain} onValueChange={(value) => patch(parseBrainValue(value))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个模型" />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((item) => (
                    <SelectGroup key={item.id}>
                      <SelectLabel className="flex items-center gap-2">
                        <ProviderIcon providerId={item.providerId} size="sm" />
                        <span className="truncate">
                          {item.name}
                          {item.ready ? '' : '（未配齐）'}
                        </span>
                      </SelectLabel>
                      {item.models.length === 0 ? (
                        <SelectItem value={brainValue(item.id, '')} disabled>
                          （这条接入还没有模型）
                        </SelectItem>
                      ) : (
                        item.models.map((model) => (
                          <SelectItem key={model} value={brainValue(item.id, model)}>
                            <span className="flex items-center gap-2">
                              <span className="truncate">{model}</span>
                              {model === effectiveModel(item, providers) && (
                                <span className="text-muted-foreground">· 接入默认</span>
                              )}
                            </span>
                          </SelectItem>
                        ))
                      )}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <Label className="mb-1">性格</Label>
            <Textarea
              value={form.personality}
              onChange={(e) => patch({ personality: e.target.value })}
              className="min-h-16 resize-none"
            />
          </div>
          <div>
            <Label className="mb-1">口癖（口头禅、语气词）</Label>
            <Input value={form.catchphrases} onChange={(e) => patch({ catchphrases: e.target.value })} />
          </div>
          <div>
            <Label className="mb-1">背景</Label>
            <Textarea
              value={form.background}
              onChange={(e) => patch({ background: e.target.value })}
              className="min-h-16 resize-none"
            />
          </div>
          <div>
            <Label className="mb-1">禁区（绝不能说的话题/承诺）</Label>
            <Textarea
              value={form.taboos}
              onChange={(e) => patch({ taboos: e.target.value })}
              className="min-h-16 resize-none"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label>角色（编剧模式多音色）</Label>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => patch({ roles: [...form.roles, { name: '', voiceId: '', style: '' }] })}
              >
                加一个角色
              </Button>
            </div>
            {form.roles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                没有角色时主播一个人说。加了角色（比如「小助理」），主播可以用 say 的 role 参数写它的台词，按角色音色播出。
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {form.roles.map((role, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={role.name}
                        onChange={(e) =>
                          patch({ roles: form.roles.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })
                        }
                        placeholder="角色名"
                        className="h-7 w-28 shrink-0 text-xs"
                      />
                      <Input
                        value={role.voiceId}
                        onChange={(e) =>
                          patch({ roles: form.roles.map((r, j) => (j === i ? { ...r, voiceId: e.target.value } : r)) })
                        }
                        placeholder="音色 voiceId"
                        className="h-7 w-40 shrink-0 text-xs"
                      />
                      <Input
                        value={role.style}
                        onChange={(e) =>
                          patch({ roles: form.roles.map((r, j) => (j === i ? { ...r, style: e.target.value } : r)) })
                        }
                        placeholder="口吻提示，例如：活泼的捧哏小助理"
                        className="h-7 min-w-0 flex-1 text-xs"
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="删除角色"
                        onClick={() => patch({ roles: form.roles.filter((_, j) => j !== i) })}
                      >
                        ×
                      </Button>
                    </div>
                    <VoiceProviderHint voiceId={role.voiceId} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            保存后作为 system prompt 注入；当前主播在跑时会自动重启会话生效。
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {source && (
              <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                删除
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            {!isActive && source && (
              <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
                保存并设为当前
              </Button>
            )}
            <Button disabled={busy} onClick={() => void save(false)}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogFooter>

        <VoicePickerDialog
          open={voicePickerOpen}
          onOpenChange={setVoicePickerOpen}
          onPick={(voiceType) => {
            patch({ voiceId: voiceType })
            setVoicePickerOpen(false)
            toast.success('已填入音色标识', { description: '保存后生效' })
          }}
        />

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除人设卡</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              确认删除「{source?.name}」？删掉当前主播时会自动切到剩余的第一张卡。
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const id = source?.id
                  setConfirmDelete(false)
                  if (!id) return
                  void window.api.persona.remove(id).then(async () => {
                    toast.success('已删除')
                    await onDeleted()
                  })
                }}
              >
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

/** 从音色库挑选（只列训练完成的音色）；按归属分组，缺凭据的组照常可选并就地提示 */
function VoicePickerDialog({
  open,
  onOpenChange,
  onPick
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (voiceType: string) => void
}) {
  const voices = useAppStore((s) => s.voices)
  const tts = useAppStore((s) => s.config.tts)
  const groups = groupVoicesByProvider(
    voices.filter((v) => v.status === 'ready' && v.voiceType),
    tts
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>从音色库选择</DialogTitle>
        </DialogHeader>
        {groups.every((group) => group.voices.length === 0) ? (
          <p className="text-sm text-muted-foreground">
            音色库还没有就绪的克隆音色。到「音色库」新建一个（训练完成后即可选）。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) =>
              group.voices.length === 0 ? null : (
                <div key={group.provider} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ProviderIcon providerId={group.provider} size="sm" />
                    <span>
                      {group.label}
                      {group.hasCredentials ? '' : '（缺凭据）'}
                    </span>
                  </div>
                  {group.voices.map((voice) => (
                    <button
                      key={voice.id}
                      type="button"
                      className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-left text-[13px] hover:bg-accent"
                      onClick={() => onPick(voice.voiceType)}
                    >
                      <span className="min-w-0 truncate">{voice.name}</span>
                      <Badge variant="outline">{voice.voiceType.slice(0, 12)}…</Badge>
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 触发器：事件驱动的自动反应规则（docs/01 §3.5）。开关即存，点卡片展开编辑。 */
function TriggerSection() {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.trigger.list().then(setTriggers)
  }, [])

  const toggle = (trigger: Trigger, enabled: boolean) => {
    void window.api.trigger.toggle(trigger.id, enabled).then(setTriggers)
  }

  return (
    <section className="max-w-2xl">
      <div className="mb-2 flex items-center gap-2">
        <Zap className="size-4 text-primary" />
        <h2 className="text-sm font-medium">触发器</h2>
        <span className="text-xs text-muted-foreground">现场事件发生时的自动反应</span>
      </div>
      <div className="flex flex-col gap-2">
        {triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            expanded={expandedId === trigger.id}
            onExpand={() => setExpandedId(expandedId === trigger.id ? null : trigger.id)}
            onToggle={(enabled) => toggle(trigger, enabled)}
            onSaved={setTriggers}
          />
        ))}
      </div>
    </section>
  )
}

function TriggerCard({
  trigger,
  expanded,
  onExpand,
  onToggle,
  onSaved
}: {
  trigger: Trigger
  expanded: boolean
  onExpand: () => void
  onToggle: (enabled: boolean) => void
  onSaved: (triggers: Trigger[]) => void
}) {
  const [cooldownSec, setCooldownSec] = useState(String((trigger.throttle?.cooldownMs ?? 0) / 1000))
  const [maxPerSession, setMaxPerSession] = useState(String(trigger.throttle?.maxPerSession ?? ''))
  const [template, setTemplate] = useState(
    trigger.target.mode === 'tool'
      ? (trigger.target.toolAction?.template ?? '')
      : (trigger.target.promptTemplate ?? '')
  )

  useEffect(() => {
    setCooldownSec(String((trigger.throttle?.cooldownMs ?? 0) / 1000))
    setMaxPerSession(String(trigger.throttle?.maxPerSession ?? ''))
    setTemplate(
      trigger.target.mode === 'tool'
        ? (trigger.target.toolAction?.template ?? '')
        : (trigger.target.promptTemplate ?? '')
    )
  }, [trigger])

  const save = () => {
    const cooldownMs = Math.max(0, Number(cooldownSec) * 1000 || 0)
    const budget = Number(maxPerSession) || undefined
    const next: Trigger = {
      ...trigger,
      throttle: {
        ...trigger.throttle,
        cooldownMs: cooldownMs || undefined,
        maxPerSession: budget
      },
      target:
        trigger.target.mode === 'tool'
          ? { ...trigger.target, toolAction: { ...trigger.target.toolAction, template } }
          : { ...trigger.target, promptTemplate: template }
    }
    void window.api.trigger.save(next).then((list) => {
      onSaved(list)
      toast.success(`「${trigger.name}」已保存`)
    })
  }

  return (
    <div className={cn('rounded-lg border bg-card', !trigger.enabled && 'opacity-60')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onExpand}>
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
          <span className="truncate text-[13px] font-medium">{trigger.name}</span>
          <Badge variant="outline">{trigger.on.event}</Badge>
          <Badge variant={MODE_BADGE_VARIANT[trigger.target.mode]}>{MODE_LABEL[trigger.target.mode]}</Badge>
        </button>
        <Switch checked={trigger.enabled} onCheckedChange={(v) => onToggle(v)} aria-label={`开关 ${trigger.name}`} />
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 border-t px-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 text-xs">冷却（秒）</Label>
              <Input
                type="number"
                min={0}
                value={cooldownSec}
                onChange={(e) => setCooldownSec(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div>
              <Label className="mb-1 text-xs">单场预算（次，留空不限）</Label>
              <Input
                type="number"
                min={0}
                value={maxPerSession}
                onChange={(e) => setMaxPerSession(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div>
            <Label className="mb-1 text-xs">
              {trigger.target.mode === 'tool' ? '话术模板（直接播出，支持 {{payload.xxx}} 插值）' : '提示模板（发给主播，支持 {{payload.xxx}} / {{aggregated.list}} 插值）'}
            </Label>
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="min-h-16 resize-none text-xs"
            />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={save}>
              保存
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
