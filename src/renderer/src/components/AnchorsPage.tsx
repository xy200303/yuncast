import { useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2, Play, Square, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import type { Persona, Trigger, TriggerMode } from '../../../shared/types'

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

/** 主播团：人设卡 / 触发器两个选项卡 + 主播 Agent 开关。M3 单主播，多张卡后续里程碑再做。 */
export function AnchorsPage() {
  const agent = useAppStore((s) => s.agent)
  const llmReady = useAppStore((s) => s.config.llm.apiKey !== '')
  const [persona, setPersona] = useState<PersonaForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'persona' | 'triggers'>('persona')

  useEffect(() => {
    void window.api.persona.get().then((p) => {
      const { id: _id, updatedAt: _at, ...form } = p
      setPersona(form)
    })
  }, [])

  const patch = (part: Partial<PersonaForm>) => setPersona((prev) => (prev ? { ...prev, ...part } : prev))

  const save = async () => {
    if (!persona || busy) return
    setBusy(true)
    try {
      await window.api.persona.save(persona)
      // 主播在跑就重启会话，让人设立即生效
      if (useAppStore.getState().agent.state === 'running') {
        const result = await window.api.agent.restart()
        if (result.ok) toast.success('人设已保存，主播已按新人设重启')
        else toast.error('人设已保存，但主播重启失败', { description: result.error })
      } else {
        toast.success('人设已保存')
      }
    } finally {
      setBusy(false)
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
            title={llmReady ? undefined : '先到「设置 → 接入」配置 LLM'}
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
              {!llmReady && ' — 去「设置 → 接入」配置 LLM 后再启动'}
            </div>
          )}
          {!persona ? (
            <p className="text-sm text-muted-foreground">加载人设卡…</p>
          ) : (
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle className="text-sm">人设卡</CardTitle>
              <CardDescription className="text-xs">
                主播的人格设定，保存后作为 system prompt 注入；主播在跑时会自动重启会话生效
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1">名字</Label>
                  <Input value={persona.name} onChange={(e) => patch({ name: e.target.value })} />
                </div>
                <div>
                  <Label className="mb-1">默认音色（留空用 TTS 默认）</Label>
                  <Input
                    value={persona.voiceId}
                    onChange={(e) => patch({ voiceId: e.target.value })}
                    placeholder="voiceId"
                  />
                </div>
              </div>
              <div>
                <Label className="mb-1">性格</Label>
                <Textarea
                  value={persona.personality}
                  onChange={(e) => patch({ personality: e.target.value })}
                  className="min-h-16 resize-none"
                />
              </div>
              <div>
                <Label className="mb-1">口癖（口头禅、语气词）</Label>
                <Input value={persona.catchphrases} onChange={(e) => patch({ catchphrases: e.target.value })} />
              </div>
              <div>
                <Label className="mb-1">背景</Label>
                <Textarea
                  value={persona.background}
                  onChange={(e) => patch({ background: e.target.value })}
                  className="min-h-16 resize-none"
                />
              </div>
              <div>
                <Label className="mb-1">禁区（绝不能说的话题/承诺）</Label>
                <Textarea
                  value={persona.taboos}
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
                    onClick={() =>
                      patch({ roles: [...persona.roles, { name: '', voiceId: '', style: '' }] })
                    }
                  >
                    加一个角色
                  </Button>
                </div>
                {persona.roles.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    没有角色时主播一个人说。加了角色（比如「小助理」），主播可以用 say 的 role 参数写它的台词，按角色音色播出。
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {persona.roles.map((role, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Input
                          value={role.name}
                          onChange={(e) =>
                            patch({ roles: persona.roles.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })
                          }
                          placeholder="角色名"
                          className="h-7 w-28 shrink-0 text-xs"
                        />
                        <Input
                          value={role.voiceId}
                          onChange={(e) =>
                            patch({ roles: persona.roles.map((r, j) => (j === i ? { ...r, voiceId: e.target.value } : r)) })
                          }
                          placeholder="音色 voiceId"
                          className="h-7 w-40 shrink-0 text-xs"
                        />
                        <Input
                          value={role.style}
                          onChange={(e) =>
                            patch({ roles: persona.roles.map((r, j) => (j === i ? { ...r, style: e.target.value } : r)) })
                          }
                          placeholder="口吻提示，例如：活泼的捧哏小助理"
                          className="h-7 min-w-0 flex-1 text-xs"
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="删除角色"
                          onClick={() => patch({ roles: persona.roles.filter((_, j) => j !== i) })}
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <Button size="sm" disabled={busy || !persona.name.trim()} onClick={() => void save()}>
                  保存人设
                </Button>
              </div>
            </CardContent>
          </Card>
          )}
        </TabsContent>

        <TabsContent value="triggers" className="overflow-auto p-4">
          <TriggerSection />
        </TabsContent>
      </Tabs>
    </div>
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
