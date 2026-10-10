import { useEffect, useState } from 'react'
import { Bot, Loader2, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '../stores/useAppStore'
import type { Persona } from '../../../shared/types'

const AGENT_STATE_LABEL: Record<string, string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '出错'
}

type PersonaForm = Omit<Persona, 'id' | 'updatedAt'>

/** 主播团：人设卡编辑 + 主播 Agent 开关。M3 单主播，多张卡后续里程碑再做。 */
export function AnchorsPage() {
  const agent = useAppStore((s) => s.agent)
  const llmReady = useAppStore((s) => s.config.llm.apiKey !== '')
  const [persona, setPersona] = useState<PersonaForm | null>(null)
  const [busy, setBusy] = useState(false)

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
        <p className="text-xs text-muted-foreground">人设卡 · 主播开关</p>
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

      <div className="min-h-0 flex-1 overflow-auto p-4">
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
              <div className="flex justify-end">
                <Button size="sm" disabled={busy || !persona.name.trim()} onClick={() => void save()}>
                  保存人设
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
