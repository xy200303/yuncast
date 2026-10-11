import { useState } from 'react'
import { AudioLines, Brain, Cable, MessageSquareText, Monitor, Moon, Palette, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import {
  LLM_PROVIDER_META,
  LLM_PROVIDERS,
  ttsConfigured,
  type AppTheme,
  type LlmConfig,
  type LlmProvider,
  type StreamConfig,
  type StreamMode,
  type TtsConfig,
  type TtsProvider
} from '../../../shared/types'

type Pane = 'appearance' | 'llm' | 'tts' | 'stream' | 'comment'

const PANES: { id: Pane; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'llm', label: '语言模型', icon: Brain },
  { id: 'tts', label: '语音合成', icon: AudioLines },
  { id: 'stream', label: '推流', icon: Cable },
  { id: 'comment', label: '评论接入', icon: MessageSquareText }
]

const THEME_OPTIONS: { id: AppTheme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor }
]

/** 设置：全局弹窗（对齐 TermPilot），左侧栏目、右侧当前项。从侧边栏底部入口打开。 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const [pane, setPane] = useState<Pane>('appearance')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton
        className="flex h-[min(640px,85vh)] w-[min(880px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-44 shrink-0 flex-col gap-1 border-r bg-muted/40 p-3">
            <div className="px-2 py-1.5 text-sm font-medium">设置</div>
            {PANES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                  pane === item.id ? 'bg-background font-medium shadow-sm' : 'hover:bg-background/70'
                )}
                onClick={() => setPane(item.id)}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {pane === 'appearance' && <AppearancePane />}
            {pane === 'llm' && <div className="max-w-xl"><LlmSection /></div>}
            {pane === 'tts' && <div className="max-w-xl"><TtsSection /></div>}
            {pane === 'stream' && <div className="max-w-xl"><StreamSection /></div>}
            {pane === 'comment' && <div className="max-w-xl"><CommentGatewayCard /></div>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  return (
    <section>
      <h2 className="text-sm font-medium">外观</h2>
      <div className="mt-3 flex items-center justify-between rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-[13px]">主题</p>
          <p className="text-xs text-muted-foreground">界面配色，跟随系统时随系统自动切换</p>
        </div>
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(v) => {
            if (!v) return
            setTheme(v as AppTheme).catch((e) =>
              toast.error('保存主题失败', { description: e instanceof Error ? e.message : String(e) })
            )
          }}
          className="rounded-lg bg-muted p-0.5"
        >
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon
            return (
              <ToggleGroupItem
                key={option.id}
                value={option.id}
                className="h-7 gap-1.5 rounded-md px-3 text-[13px] data-[state=on]:bg-background data-[state=on]:shadow-sm"
              >
                <Icon className="size-3.5" />
                {option.label}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
      </div>
    </section>
  )
}

/** 推流表单：伴侣模式（推荐）或 FFmpeg 直推 RTMP */
function StreamSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const stream = useAppStore((s) => s.stream)
  const [form, setForm] = useState<StreamConfig>({ ...config.stream })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.stream)
  const patch = (part: Partial<StreamConfig>) => setForm((prev) => ({ ...prev, ...part }))

  const save = () => {
    setSaving(true)
    saveConfig({ stream: form })
      .then(() => toast.success('推流配置已保存'))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  const toggleStream = () => {
    void (stream.state === 'live' ? window.api.stream.stop() : window.api.stream.start()).then((result) => {
      if (result && 'ok' in result && !result.ok) {
        toast.error('开播失败', { description: result.error })
      }
    })
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">推流</p>
          <p className="text-xs text-muted-foreground">伴侣模式只出声（推荐）；直推模式 FFmpeg 静态帧 + 混音推 RTMP</p>
        </div>
        <div className="flex items-center gap-2">
          {stream.state === 'live' && (
            <Badge variant="secondary">推流中 · {stream.bitrateKbps} kbps</Badge>
          )}
          <Button variant={stream.state === 'live' ? 'secondary' : 'default'} size="sm" onClick={toggleStream}>
            {stream.state === 'live' ? '停止推流' : '开始推流'}
          </Button>
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">模式</Label>
          <ToggleGroup
            type="single"
            value={form.mode}
            onValueChange={(v) => v && patch({ mode: v as StreamMode })}
            className="rounded-lg bg-muted p-0.5"
          >
            <ToggleGroupItem value="companion" className="h-7 px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
              伴侣模式（只出声）
            </ToggleGroupItem>
            <ToggleGroupItem value="direct" className="h-7 px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
              直推 RTMP
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {form.mode === 'direct' && (
          <>
            <Field label="服务器地址" value={form.serverUrl} onChange={(v) => patch({ serverUrl: v })} placeholder="rtmp://…" />
            <Field label="推流密钥" value={form.streamKey} onChange={(v) => patch({ streamKey: v })} type="password" />
          </>
        )}
      </div>
      {form.mode === 'direct' && (!form.serverUrl || !form.streamKey) && (
        <p className="mt-3 text-xs text-muted-foreground">直推模式需要服务器地址和推流密钥（抖音开播页可复制）</p>
      )}
    </div>
  )
}

/** 评论接入状态卡：本地平台连接器（docs/04 解耦架构，主应用不内置平台 SDK） */
function CommentGatewayCard() {
  const connector = useAppStore((s) => s.connector)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [port, setPort] = useState(String(config.comment.connectorPort))
  const [token, setToken] = useState(config.comment.connectorToken)

  const STATE_LABEL: Record<string, string> = {
    idle: '未连接',
    connecting: '连接中…',
    connected: `已连接 · 收 ${connector.receivedCount} 条`,
    error: '连接失败（自动重试中）'
  }

  const saveAccess = () => {
    const next = Number(port)
    if (!Number.isInteger(next) || next <= 0 || next >= 65536) {
      toast.error('端口无效', { description: '填 1-65535 的整数' })
      return
    }
    void saveConfig({ comment: { connectorPort: next, connectorToken: token.trim() } }).then(() =>
      toast.success('连接器配置已保存并重连')
    )
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">评论接入（平台连接器）</p>
          <p className="text-xs text-muted-foreground">
            主应用不内置平台 SDK：连接器是独立 MCP server，事件经 notifications/live_event 推进来，出站动作走同一连接
          </p>
        </div>
        <Badge
          variant={connector.state === 'connected' ? 'secondary' : connector.state === 'error' ? 'destructive' : 'outline'}
          title={connector.error}
        >
          {STATE_LABEL[connector.state]}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div className="w-28">
          <Label className="mb-1">MCP 端口</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8102" />
        </div>
        <div className="col-span-3">
          <Label className="mb-1">Bearer Token（连接器「设置 → 智能体接口」里复制）</Label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="连接器的 MCP Token"
          />
        </div>
        <div className="col-span-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={port === String(config.comment.connectorPort) && token === config.comment.connectorToken}
            onClick={saveAccess}
          >
            保存并重连
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void window.api.connector.restart()}>
            立即重连
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        连接器没开时会自动退避重试；开发调试可单独运行连接器的独立模式（内置演示数据，走同一条事件总线）。
      </p>
    </div>
  )
}

/** LLM 表单：主播 Agent 的大脑。provider 切换时带出默认模型和默认地址 */
function LlmSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [form, setForm] = useState<LlmConfig>({ ...config.llm })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.llm)
  const patch = (part: Partial<LlmConfig>) => setForm((prev) => ({ ...prev, ...part }))
  const meta = LLM_PROVIDER_META[form.provider]

  const save = () => {
    setSaving(true)
    saveConfig({ llm: form })
      .then(() => toast.success('LLM 配置已保存', { description: '已启动的主播重启后使用新配置' }))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">语言模型（LLM）</p>
          <p className="text-xs text-muted-foreground">主播 Agent 的大脑，DeepSeek / 通义 / 豆包 / Kimi / 智谱</p>
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">服务商</Label>
          <Select
            value={form.provider}
            onValueChange={(v) => {
              const provider = v as LlmProvider
              // 切换服务商时如果模型还是上一个服务商的默认值，跟随换默认值
              const followDefault =
                !form.model || form.model === LLM_PROVIDER_META[form.provider].defaultModel
              patch({
                provider,
                model: followDefault ? LLM_PROVIDER_META[provider].defaultModel : form.model
              })
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {LLM_PROVIDER_META[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field
          label="API Key"
          value={form.apiKey}
          onChange={(v) => patch({ apiKey: v })}
          type="password"
          placeholder="sk-…"
        />
        <Field
          label="模型"
          value={form.model}
          onChange={(v) => patch({ model: v })}
          placeholder={meta.defaultModel}
        />
        <div className="col-span-2">
          <Field
            label="自定义 API 地址（留空走默认）"
            value={form.baseUrl}
            onChange={(v) => patch({ baseUrl: v })}
            placeholder={meta.defaultBaseUrl}
          />
        </div>
      </div>

      {!form.apiKey && (
        <p className="mt-3 text-xs text-muted-foreground">填好 API Key 后，到「主播团」启动主播</p>
      )}
    </div>
  )
}

/** TTS 双通道表单（火山引擎 / 阿里云百炼） */
function TtsSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [form, setForm] = useState<TtsConfig>({ ...config.tts })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.tts)
  const patch = (part: Partial<TtsConfig>) => setForm((prev) => ({ ...prev, ...part }))

  const save = () => {
    setSaving(true)
    saveConfig({ tts: form })
      .then(() => toast.success('TTS 配置已保存'))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  const test = () => {
    if (testing) return
    setTesting(true)
    void window.api.tts
      .test('你好，欢迎来到直播间，这里是 Agent Anchor 智能体主播。')
      .then(async (result) => {
        if (result.ok && result.audioPath) {
          toast.success('合成成功，正在播放')
          await audioEngine.playTts(result.audioPath)
        } else {
          toast.error('合成失败', { description: result.error })
        }
      })
      .finally(() => setTesting(false))
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">语音合成（TTS）</p>
          <p className="text-xs text-muted-foreground">火山引擎与阿里云百炼双通道，二选一</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={testing} onClick={test}>
            {testing ? '合成中…' : '测试发音'}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">服务商</Label>
          <Select value={form.provider} onValueChange={(v) => patch({ provider: v as TtsProvider })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="volcano">火山引擎（豆包语音）</SelectItem>
              <SelectItem value="bailian">阿里云百炼（Qwen-TTS）</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {form.provider === 'volcano' ? (
          <>
            <Field label="AppId" value={form.appId} onChange={(v) => patch({ appId: v })} placeholder="控制台 → 语音技术 → 应用管理" />
            <Field label="Access Token" value={form.accessToken} onChange={(v) => patch({ accessToken: v })} type="password" />
            <Field label="接入集群 Cluster" value={form.cluster} onChange={(v) => patch({ cluster: v })} placeholder="volcano_tts" />
            <Field label="语速" value={String(form.speed)} onChange={(v) => patch({ speed: Number(v) || 1.0 })} placeholder="1.0" />
          </>
        ) : (
          <>
            <Field label="API Key" value={form.apiKey} onChange={(v) => patch({ apiKey: v })} type="password" placeholder="sk-…" />
            <Field label="模型" value={form.model} onChange={(v) => patch({ model: v })} placeholder="qwen3-tts-flash" />
            <Field label="API 地址" value={form.baseUrl} onChange={(v) => patch({ baseUrl: v })} placeholder="https://dashscope.aliyuncs.com/api/v1" />
            <Field label="语种" value={form.languageType} onChange={(v) => patch({ languageType: v })} placeholder="Chinese" />
          </>
        )}
        <div className="col-span-2">
          <Field
            label="默认音色 voiceId"
            value={form.voiceId}
            onChange={(v) => patch({ voiceId: v })}
            placeholder={form.provider === 'volcano' ? '火山 voice_type，例如 zh_female_…' : '百炼 voice，例如 Cherry'}
          />
        </div>
      </div>

      {!ttsConfigured(form) && (
        <p className="mt-3 text-xs text-muted-foreground">
          还没配齐：{form.provider === 'volcano' ? 'AppId / Access Token / 音色' : 'API Key / 模型 / 音色'} 都是必填
        </p>
      )}
    </div>
  )
}

function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div>
      <Label className="mb-1">{props.label}</Label>
      <Input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}
