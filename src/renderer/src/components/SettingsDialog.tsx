import { useEffect, useState } from 'react'
import {
  AudioLines,
  Brain,
  Cable,
  ExternalLink,
  MessageSquareText,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  Radio,
  Sun,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { flattenModelCatalog, type CatalogModel } from '@/lib/voice'
import { ProviderIcon } from '@/components/ProviderIcon'
import {
  providerLabel,
  useAppStore,
  type LlmProviderManifest,
  type ProviderFieldSpec,
  type TtsProviderManifest
} from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import {
  APP_ACCENTS,
  APP_ACCENT_META,
  type AppAccent,
  type AppTheme,
  type ModelConnectionSafe,
  type ParamSpec,
  type StreamConfig,
  type StreamMode,
  type TtsConnectionSafe,
  type TtsRealtimeConfig,
  type TtsProvider
} from '../../../shared/types'

type Pane = 'appearance' | 'llm' | 'tts' | 'realtime' | 'stream' | 'comment'

const PANES: { id: Pane; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'llm', label: '语言模型', icon: Brain },
  { id: 'tts', label: '语音合成', icon: AudioLines },
  { id: 'realtime', label: '实时语音', icon: Radio },
  { id: 'stream', label: '推流', icon: Cable },
  { id: 'comment', label: '连接器', icon: MessageSquareText }
]

const THEME_OPTIONS: { id: AppTheme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor }
]

/** 各家服务商的控制台与文档直达入口（凭据去哪儿拿）；本地服务没有控制台，故可以没有 */
const LLM_LINKS: Record<string, { console: string; docs: string } | undefined> = {
  deepseek: {
    console: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com/zh-cn/'
  },
  qwen: {
    console: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    docs: 'https://help.aliyun.com/zh/model-studio/getting-started/what-is-model-studio'
  },
  doubao: {
    console: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    docs: 'https://www.volcengine.com/docs/82379/1298454'
  },
  kimi: {
    console: 'https://platform.moonshot.cn/console/api-keys',
    docs: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api'
  },
  zai: {
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction'
  }
}

/** 跳转外链（主进程 setWindowOpenHandler 会交给系统浏览器打开） */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 一键直达入口：控制台拿凭据 / 查文档 */
function DocLinks({ items }: { items: { label: string; url: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => (
        <Button
          key={item.url}
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={() => openExternal(item.url)}
        >
          <ExternalLink className="size-3" />
          {item.label}
        </Button>
      ))}
    </div>
  )
}

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
            {pane === 'llm' && <div className="max-w-2xl"><LlmSection /></div>}
            {pane === 'tts' && <div className="max-w-3xl"><TtsSection /></div>}
            {pane === 'realtime' && <div className="max-w-xl"><RealtimeSection /></div>}
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
  const accent = useAppStore((s) => s.accent)
  const setTheme = useAppStore((s) => s.setTheme)
  const setAccent = useAppStore((s) => s.setAccent)

  const saveTheme = (value: AppTheme) => {
    setTheme(value).catch((e) =>
      toast.error('保存主题失败', { description: e instanceof Error ? e.message : String(e) })
    )
  }

  const saveAccent = (value: AppAccent) => {
    setAccent(value).catch((e) =>
      toast.error('保存配色失败', { description: e instanceof Error ? e.message : String(e) })
    )
  }

  return (
    <section>
      <h2 className="text-sm font-medium">外观</h2>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-[13px]">明暗模式</p>
          <p className="text-xs text-muted-foreground">跟随系统时随系统自动切换明暗</p>
        </div>
        <Select value={theme} onValueChange={(v) => saveTheme(v as AppTheme)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-[13px]">配色主题</p>
          <p className="text-xs text-muted-foreground">点缀色，作用于按钮、选中态与强调信息</p>
        </div>
        <Select value={accent} onValueChange={(v) => saveAccent(v as AppAccent)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_ACCENTS.map((id) => (
              <SelectItem key={id} value={id}>
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block size-3 rounded-full"
                    style={{ background: APP_ACCENT_META[id].light }}
                  />
                  {APP_ACCENT_META[id].label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      <div className="mt-3">
        <DocLinks
          items={[
            { label: '下载抖音直播伴侣', url: 'https://streamingtool.douyin.com/' },
            { label: '抖音开播页（复制推流地址）', url: 'https://creator.douyin.com/' }
          ]}
        />
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
          <p className="text-[13px] font-medium">平台连接器</p>
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

/**
 * 语言模型：供应商接入库（设置 = 库，用哪条由主播卡决定）。
 * 一条接入 = 一个服务商 + 一份凭据（只填一次）+ 一串这家能用的模型；
 * 字段由 provider 的 configFields 动态渲染，加一家服务商不用改这里。
 * 密钥字段只在落盘时加密，渲染层只看得到「填没填过」。
 */
function LlmSection() {
  const connections = useAppStore((s) => s.connections)
  const providers = useAppStore((s) => s.llmProviders)
  const setConnections = useAppStore((s) => s.setConnections)
  const refreshPersona = useAppStore((s) => s.refreshPersona)
  const [editing, setEditing] = useState<{ connection?: ModelConnectionSafe } | null>(null)
  const [deleting, setDeleting] = useState<ModelConnectionSafe | null>(null)
  /** 待删接入被几张主播卡引用（删除前查一次，用于提示） */
  const [usedBy, setUsedBy] = useState(0)
  const [testing, setTesting] = useState<ModelConnectionSafe | null>(null)

  const test = (connection: ModelConnectionSafe) => setTesting(connection)

  const askDelete = async (connection: ModelConnectionSafe) => {
    const personas = await window.api.persona.list()
    setUsedBy(personas.filter((item) => item.modelConnectionId === connection.id).length)
    setDeleting(connection)
  }

  const remove = () => {
    const connection = deleting
    if (!connection) return
    setDeleting(null)
    void window.api.model.remove(connection.id).then((result) => {
      setConnections(result.connections)
      void refreshPersona()
      toast.success(`已删除「${connection.name}」`)
    })
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">语言模型（LLM）</p>
          <p className="text-[13px] text-muted-foreground">
            主播 Agent 的大脑。一条 = 一个服务商的接入，密钥只填一次；模型列表里放这家能用的模型，
            用哪个由人设卡自己选（这里没有「默认模型」）
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus />
          新建接入
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {connections.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            还没有供应商接入。新建一条（选服务商、填一次 API Key、把这家能用的模型加进列表），主播才有大脑。
          </p>
        ) : (
          connections.map((connection) => (
            <div
              key={connection.id}
              className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2"
            >
              <ProviderIcon providerId={connection.providerId} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{connection.name}</span>
                  {!connection.ready && (
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">
                      未配齐
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {providerLabel(providers, connection.providerId)} · {connection.models.length} 个模型
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => test(connection)}
                >
                  测试
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="编辑"
                  onClick={() => setEditing({ connection })}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="删除"
                  onClick={() => void askDelete(connection)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        密钥落盘加密、运行时注入 pi（不落 pi 的盘），界面拿不到密钥本身；主播卡各自指定用哪家的哪个模型。
      </p>

      {editing && (
        <ConnectionEditorDialog
          key={editing.connection?.id ?? 'new'}
          connection={editing.connection}
          providers={providers}
          onClose={() => setEditing(null)}
        />
      )}

      {testing && <TestConnectionDialog connection={testing} onClose={() => setTesting(null)} />}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除供应商接入</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {usedBy > 0
              ? `「${deleting?.name}」正被 ${usedBy} 张主播卡使用，删掉后这些卡得重新选一个接入和模型。`
              : `确认删除「${deleting?.name}」？`}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={remove}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 连通性测试弹窗：列出这条接入的全部模型，逐个测（也能一次全测）。
 * 同一家的模型可用性常常不一致，所以不挑一个代表来测，得能单独验。
 */
function TestConnectionDialog({
  connection,
  onClose
}: {
  connection: ModelConnectionSafe
  onClose: () => void
}) {
  const providers = useAppStore((s) => s.llmProviders)
  type TestState = { state: 'idle' | 'running' | 'ok' | 'error'; detail?: string }
  const [results, setResults] = useState<Record<string, TestState>>({})
  const [batchRunning, setBatchRunning] = useState(false)

  const setResult = (model: string, next: TestState) =>
    setResults((prev) => ({ ...prev, [model]: next }))

  const runOne = async (model: string): Promise<void> => {
    setResult(model, { state: 'running' })
    const result = await window.api.model.test(connection.id, model)
    setResult(
      model,
      result.ok
        ? { state: 'ok', detail: result.latencyMs ? `${result.latencyMs} ms` : undefined }
        : { state: 'error', detail: result.error }
    )
  }

  const runAll = async (): Promise<void> => {
    if (batchRunning) return
    setBatchRunning(true)
    try {
      // 串行：同一条接入并发打请求容易被限流，也会把失败原因搅在一起
      for (const model of connection.models) await runOne(model)
    } finally {
      setBatchRunning(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon providerId={connection.providerId} />
            测试「{connection.name}」
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          对一个模型发一次最小请求（max_tokens=1），验的是「地址 + 密钥 + 模型名」这一整套。
        </p>
        <div className="flex flex-col gap-1.5">
          {connection.models.map((model) => {
            const result = results[model] ?? { state: 'idle' as const }
            return (
              <div
                key={model}
                className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{model}</span>
                {result.state === 'ok' && (
                  <span className="shrink-0 text-xs text-emerald-600">
                    连通{result.detail ? ` · ${result.detail}` : ''}
                  </span>
                )}
                {result.state === 'error' && (
                  <span className="max-w-[16rem] shrink-0 truncate text-xs text-destructive" title={result.detail}>
                    {result.detail}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-xs"
                  disabled={result.state === 'running' || batchRunning}
                  onClick={() => void runOne(model)}
                >
                  {result.state === 'running' ? '测试中…' : '测试'}
                </Button>
              </div>
            )
          })}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={batchRunning} onClick={() => void runAll()}>
            {batchRunning ? '测试中…' : '全部测试'}
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建/编辑供应商接入：凭据按 manifest 的 configFields 渲染，模型列表单独编辑 */
function ConnectionEditorDialog({
  connection,
  providers,
  onClose
}: {
  connection?: ModelConnectionSafe
  providers: LlmProviderManifest[]
  onClose: () => void
}) {
  const setConnections = useAppStore((s) => s.setConnections)
  const refreshPersona = useAppStore((s) => s.refreshPersona)
  const initialProviderId = connection?.providerId ?? providers[0]?.id ?? 'deepseek'
  const [providerId, setProviderId] = useState(initialProviderId)
  // 接入名默认就用服务商 label（一条接入 = 一家，改不改随你）
  const [name, setName] = useState(
    connection?.name ?? providers.find((item) => item.id === initialProviderId)?.label ?? ''
  )
  const [models, setModels] = useState<string[]>(connection?.models ?? [])
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [params, setParams] = useState<Record<string, string | number | boolean>>(() => {
    const def = providers.find((item) => item.id === connection?.providerId) ?? providers[0]
    const initial: Record<string, string | number | boolean> = { ...(connection?.params ?? {}) }
    for (const field of def?.configFields ?? []) {
      if (initial[field.key] === undefined && field.default !== undefined) initial[field.key] = field.default
    }
    return initial
  })

  const def = providers.find((item) => item.id === providerId)
  const links = LLM_LINKS[providerId]
  const patch = (part: { key: string; value: string | number | boolean }) =>
    setParams((prev) => ({ ...prev, [part.key]: part.value }))

  /** 换服务商：按新服务商的字段重排参数，同名字段（apiKey / baseUrl）保留已填的值 */
  const changeProvider = (next: string) => {
    setProviderId(next)
    const nextDef = providers.find((item) => item.id === next)
    // 新建时名字还没改过（仍是上一家的 label）就跟着换，省得手填
    if (!connection && name === def?.label) setName(nextDef?.label ?? name)
    const nextParams: Record<string, string | number | boolean> = {}
    for (const field of nextDef?.configFields ?? []) {
      const current = params[field.key]
      nextParams[field.key] = current !== undefined ? current : (field.default ?? '')
    }
    setParams(nextParams)
  }

  const setModelAt = (index: number, value: string) => {
    setModels(models.map((model, i) => (i === index ? value : model)))
  }

  const removeModelAt = (index: number) => {
    setModels(models.filter((_, i) => i !== index))
  }

  const addModels = (ids: string[]) => {
    const next = [...models]
    for (const id of ids) {
      const value = id.trim()
      if (value && !next.includes(value)) next.push(value)
    }
    setModels(next)
  }

  const save = async () => {
    if (busy) return
    if (!name.trim()) {
      toast.warning('先给这条接入起个名字')
      return
    }
    if (models.length === 0) {
      toast.warning('至少加一个模型', { description: '模型列表里放这家能用的模型 id' })
      return
    }
    setBusy(true)
    try {
      const result = await window.api.model.save({
        id: connection?.id,
        name,
        providerId,
        params,
        models
      })
      if (!result.ok) {
        toast.error('保存失败', { description: result.error })
        return
      }
      setConnections(result.connections)
      void refreshPersona()
      toast.success(connection ? '接入已保存' : '接入已新建', {
        description: '已启动的主播重启后使用新模型'
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {connection ? `供应商接入 · ${connection.name || '未命名'}` : '新建供应商接入'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">接入名</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={def ? `如：${def.label} 主号` : '如：DeepSeek 主号'}
              />
            </div>
            <div>
              <Label className="mb-1">服务商</Label>
              <Select value={providerId} onValueChange={changeProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="flex items-center gap-2">
                        <ProviderIcon providerId={item.id} size="sm" />
                        {item.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {def && <p className="-mt-1 text-xs text-muted-foreground">{def.note}</p>}

          <div className="flex flex-col gap-3">
            {(def?.configFields ?? []).map((field) => (
              <div key={field.key}>
                <Label className="mb-1">{field.label}</Label>
                <ProviderField
                  field={field}
                  value={params[field.key] ?? ''}
                  secretSaved={Boolean(connection?.hasSecret && field.secret)}
                  onChange={(value) => patch({ key: field.key, value })}
                />
                {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label>模型列表（这家能用的模型；用哪个由人设卡自己选）</Label>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => setPickerOpen(true)}
              >
                <Plus className="size-3" />
                添加模型
              </Button>
            </div>
            {models.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                还没有模型。点「添加模型」从可用模型里挑，或直接手打模型 id（本地服务的模型名必须手打）。
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {models.map((model, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      value={model}
                      onChange={(e) => setModelAt(index, e.target.value)}
                      placeholder="模型 id，如 deepseek-chat"
                      className="h-7 text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除这一行"
                      onClick={() => removeModelAt(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {links && (
            <DocLinks
              items={[
                { label: `去 ${def?.label ?? providerId} 控制台拿 API Key`, url: links.console },
                { label: '查看接入文档', url: links.docs }
              ]}
            />
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>

        <ModelPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          providerId={providerId}
          providerLabel={def?.label ?? providerId}
          picked={models}
          onPick={(ids) => addModels(ids)}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * 从该服务商真实可用的模型里挑（providers:models：pi 目录 → manifest 建议）。
 * 目录里没有的（本地服务）只能手打，所以同时允许直接把输入的内容加进去。
 */
function ModelPickerDialog({
  open,
  onOpenChange,
  providerId,
  providerLabel,
  picked,
  onPick
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerLabel: string
  picked: string[]
  onPick: (ids: string[]) => void
}) {
  const [available, setAvailable] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setKeyword('')
    window.api.providers
      .models(providerId)
      .then(setAvailable)
      .catch(() => setAvailable([]))
      .finally(() => setLoading(false))
  }, [open, providerId])

  const filtered = available.filter((id) => id.toLowerCase().includes(keyword.trim().toLowerCase()))
  const typed = keyword.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加模型 · {providerLabel}</DialogTitle>
        </DialogHeader>

        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索模型 id，或直接手打一个（本地服务只能手打）"
        />

        <div className="flex min-h-32 flex-1 flex-col gap-1 overflow-y-auto">
          {typed && !available.includes(typed) && (
            <button
              type="button"
              className="flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-[13px] hover:bg-accent"
              onClick={() => {
                onPick([typed])
                setKeyword('')
              }}
            >
              <span className="min-w-0 truncate">手打添加「{typed}」</span>
              <Plus className="size-3.5 shrink-0" />
            </button>
          )}
          {loading ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">读取可用模型…</p>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              {available.length === 0
                ? '这家服务商没有可列出的模型目录，直接在左边输入框里手打模型 id。'
                : '没有匹配的模型。'}
            </p>
          ) : (
            filtered.map((id) => {
              const added = picked.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  disabled={added}
                  className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-left text-[13px] hover:bg-accent disabled:opacity-50"
                  onClick={() => onPick([id])}
                >
                  <span className="min-w-0 truncate">{id}</span>
                  {added ? (
                    <span className="shrink-0 text-xs text-muted-foreground">已添加</span>
                  ) : (
                    <Plus className="size-3.5 shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** manifest 驱动的单个配置字段：type 映射到现有控件，secret 用密码框 */
function ProviderField({
  field,
  value,
  secretSaved,
  onChange
}: {
  field: ProviderFieldSpec
  value: string | number | boolean
  secretSaved: boolean
  onChange: (value: string | number | boolean) => void
}) {
  if (field.type === 'switch') {
    return (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={onChange}
        aria-label={field.label}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={field.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (field.type === 'number') {
    return (
      <Input
        type="number"
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }
  return (
    <Input
      type={field.type === 'password' ? 'password' : 'text'}
      value={String(value ?? '')}
      placeholder={secretSaved ? '已保存，留空表示不修改' : field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** 实时语音（Realtime 模型，双向 WS）：与「语音合成」是两套模型/协议/端点，故独立成栏 */
function RealtimeSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [form, setForm] = useState<TtsRealtimeConfig>({ ...config.ttsRealtime })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.ttsRealtime)
  const patch = (part: Partial<TtsRealtimeConfig>) => setForm((prev) => ({ ...prev, ...part }))

  const save = () => {
    setSaving(true)
    saveConfig({ ttsRealtime: form })
      .then(() => toast.success('实时语音配置已保存', { description: '动态内容将优先走实时通道' }))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">实时语音（Realtime 模型）</p>
          <p className="text-xs text-muted-foreground">
            双向 WebSocket 的实时语音模型：文本可流式喂入、首包更低；与「语音合成」是不同的模型与协议
          </p>
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
        <div>
          <p className="text-[13px]">启用实时语音通道</p>
          <p className="text-xs text-muted-foreground">
            关闭时动态内容走「语音合成」的流式（SSE）；开启后优先走实时通道，未配置或异常时自动降级
          </p>
        </div>
        <Switch checked={form.enabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label="实时语音开关" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">服务商</Label>
          <Select value={form.provider} onValueChange={(v) => patch({ provider: v as TtsRealtimeConfig['provider'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bailian">阿里云百炼（Qwen-Audio-TTS / CosyVoice）</SelectItem>
              <SelectItem value="volcano">火山引擎（实时对话）</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Field label="模型" value={form.model} onChange={(v) => patch({ model: v })} placeholder="qwen-audio-3.0-tts-flash" />
        <Field label="音色" value={form.voiceId} onChange={(v) => patch({ voiceId: v })} placeholder="longanhuan_v3.6 / Cherry" />
        <div className="col-span-2">
          <Field
            label="WebSocket 端点（百炼需带业务空间 ID）"
            value={form.wsUrl}
            onChange={(v) => patch({ wsUrl: v })}
            placeholder="wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
          />
        </div>
        <div className="col-span-2">
          <Field
            label="API Key（不用填：凭据取自「语音合成」里对应服务商的接入）"
            value={form.apiKey}
            onChange={(v) => patch({ apiKey: v })}
            type="password"
            placeholder="留空即可"
          />
        </div>
        <div className="col-span-2">
          <Field
            label="指令控制（可选，自然语言描述语音表现）"
            value={form.instruction}
            onChange={(v) => patch({ instruction: v })}
            placeholder="例如：语速稍快，语气热情，像直播间卖货"
          />
        </div>
      </div>

      <DocLinks
        items={[
          { label: '实时语音合成文档', url: 'https://help.aliyun.com/zh/model-studio/qwen-tts-realtime' },
          { label: '去百炼控制台拿 API Key', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key' }
        ]}
      />

      <p className="mt-3 text-xs text-muted-foreground">
        状态：端点与模型名已按官方文档配置；<span className="text-foreground">WS 事件帧协议尚待核对</span>，
        核对完成前动态内容会自动降级为「语音合成」的流式播报。
      </p>
    </div>
  )
}

/** 接入里的凭据字段（manifest 的 configFields 全部是凭据） */
function credentialFields(def: TtsProviderManifest): ProviderFieldSpec[] {
  return def.configFields
}

/** 模型 id → 目录里的显示名 */
function ttsModelLabel(catalog: CatalogModel[], provider: TtsProvider, modelId: string): string {
  const hit = catalog.find((entry) => entry.provider === provider && entry.model.id === modelId)
  return hit?.model.label ?? (modelId || '—')
}

/**
 * 语音合成（火山引擎 / 阿里云百炼）：
 * 一个条目 = 一个服务商账号，条目里带齐它自己的东西：凭据、模型与每个模型的参数（含语气）、实时合成开关。
 * 没有默认模型 / 默认音色 / 默认接入：音色严格绑定模型，模型属于某条接入，用哪个由人设卡/场次选。
 */
function TtsSection() {
  const providers = useAppStore((s) => s.ttsProviders)
  const connections = useAppStore((s) => s.ttsConnections)
  const setConnections = useAppStore((s) => s.setTtsConnections)
  const voices = useAppStore((s) => s.voices)
  /** 「添加接入」第一步：选服务商 */
  const [adding, setAdding] = useState(false)
  /** 正在编辑/新建的接入（新建时 connection 为空，只是带着服务商进来） */
  const [editing, setEditing] = useState<{ providerId: TtsProvider; connection?: TtsConnectionSafe } | null>(
    null
  )
  const [deleting, setDeleting] = useState<TtsConnectionSafe | null>(null)
  const [testing, setTesting] = useState<TtsConnectionSafe | null>(null)

  const removeConnection = () => {
    const target = deleting
    setDeleting(null)
    if (!target) return
    void window.api.tts.removeConnection(target.id).then((result) => {
      setConnections(result.connections)
      toast.success(`已删除「${target.name}」`)
    })
  }

  const boundVoices = deleting ? voices.filter((voice) => voice.connectionId === deleting.id).length : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border bg-card px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[14px] font-medium">服务商接入</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              一条接入 = 一个服务商账号；模型和参数都在这条接入里配（音色由人设卡/场次选，这里不设默认）。
            </p>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setAdding(true)}>
            <Plus />
            添加接入
          </Button>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {connections.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-[13px] text-muted-foreground">
              还没有接入。添加一条：选服务商 → 填一次密钥 → 勾上要用的模型。
            </p>
          ) : (
            connections.map((connection) => {
              const provider = providers.find((item) => item.id === connection.providerId)
              const unused = connection.models.length - connection.usableModels.length
              return (
                <div
                  key={connection.id}
                  className="flex items-start gap-3 rounded-lg border bg-background px-3.5 py-3"
                >
                  <ProviderIcon providerId={connection.providerId} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{connection.name}</span>
                      {unused > 0 && (
                        <Badge variant="outline" className="text-amber-600">
                          {unused} 个模型缺配置
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {connection.models.length} 个模型 · 实时合成 {connection.realtime ? '开' : '关'}
                      {connection.usableModels.length > 0
                        ? ` · 可用 ${connection.usableModels.length} 个`
                        : ' · 现在没有能用的模型'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={connection.usableModels.length === 0}
                      onClick={() => setTesting(connection)}
                    >
                      测试
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing({ providerId: connection.providerId, connection })}
                    >
                      配置
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除接入"
                      onClick={() => setDeleting(connection)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {adding && (
        <TtsProviderPickerDialog
          providers={providers}
          onClose={() => setAdding(false)}
          onPick={(providerId) => {
            setAdding(false)
            setEditing({ providerId })
          }}
        />
      )}

      {editing && (
        <TtsConnectionEditorDialog
          key={editing.connection?.id ?? `new-${editing.providerId}`}
          providerId={editing.providerId}
          connection={editing.connection}
          onClose={() => setEditing(null)}
        />
      )}

      {testing && <TtsTestDialog connection={testing} onClose={() => setTesting(null)} />}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除接入</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？
            {boundVoices > 0
              ? `这条接入下有 ${boundVoices} 个克隆音色：克隆音色只认克隆时那条接入，删掉后它们会合不出声（音色记录本身保留），想继续用得把接入加回来。`
              : '音色记录本身不受影响。'}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={removeConnection}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 「添加接入」第一步：选服务商（一家可以有多条接入，所以每次都从服务商开始） */
function TtsProviderPickerDialog({
  providers,
  onPick,
  onClose
}: {
  providers: TtsProviderManifest[]
  onPick: (providerId: TtsProvider) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加语音合成接入</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          选服务商 → 填一次密钥 → 勾上这家要用的模型。同一家可以加多条接入（不同账号 / 不同参数）。
        </p>
        <div className="flex flex-col gap-2">
          {providers.map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2 text-left hover:bg-accent"
              onClick={() => onPick(item.id)}
            >
              <ProviderIcon providerId={item.icon} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.note}</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {item.models.filter((model) => model.kind !== 'realtime').length} 个模型可用 ·{' '}
                  {item.capabilities.clone ? '支持声音复刻' : '不支持复刻'}
                </p>
              </div>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 按模型的参数声明渲染参数表单；留空 = 用官方默认值（落盘时键会去掉） */
function TtsParamForm({
  specs,
  values,
  onChange
}: {
  specs: ParamSpec[]
  values: Record<string, string | number | boolean>
  onChange: (key: string, value: string | number | boolean) => void
}) {
  const valueOf = (spec: ParamSpec): string | number | boolean =>
    values[spec.key] !== undefined ? values[spec.key] : (spec.default ?? '')

  return (
    <div className="grid grid-cols-2 gap-3">
      {specs.map((spec) => (
        <div key={spec.key}>
          <Label className="mb-1 text-xs">{spec.label}</Label>
          {spec.type === 'select' ? (
            <Select value={String(valueOf(spec))} onValueChange={(value) => onChange(spec.key, value)}>
              <SelectTrigger className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(spec.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              className="h-7 text-xs"
              type={spec.type === 'number' ? 'number' : 'text'}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={String(valueOf(spec))}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') return onChange(spec.key, '')
                onChange(spec.key, spec.type === 'number' ? Number(raw) : raw)
              }}
            />
          )}
          {spec.help && <p className="mt-1 text-[11px] text-muted-foreground">{spec.help}</p>}
        </div>
      ))}
    </div>
  )
}

/**
 * 接入测试弹窗：选一个已启用的模型 + 它的音色，合成一句听。
 * 不让一个模型代表整条接入：同一家的模型可用性常常不一致（比如没填业务空间 ID 的模型必然失败），得能单独验。
 */
function TtsTestDialog({
  connection,
  onClose
}: {
  connection: TtsConnectionSafe
  onClose: () => void
}) {
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)
  const catalog = flattenModelCatalog(providers)
  const [modelId, setModelId] = useState(connection.models[0]?.id ?? '')
  const [voice, setVoice] = useState('')
  const [text, setText] = useState('你好，欢迎来到直播间，这里是 Agent Anchor 智能体主播。')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    error?: string
    latencyMs?: number
    audioPath?: string
  } | null>(null)

  const entry = catalog.find(
    (item) => item.provider === connection.providerId && item.model.id === modelId
  )
  const voiceGroups = entry?.model.voices ?? []
  const clones = voices.filter(
    (item) =>
      item.status === 'ready' &&
      Boolean(item.voiceType) &&
      item.model === modelId &&
      item.connectionId === connection.id
  )
  const firstCatalogVoice = voiceGroups[0]?.voices[0]?.id ?? ''

  useEffect(() => {
    setVoice(firstCatalogVoice || clones[0]?.voiceType || '')
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId])

  const run = async () => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const res = await window.api.tts.test({
        connectionId: connection.id,
        model: modelId,
        voice: voice.trim() || undefined,
        text
      })
      setResult(res)
      if (res.ok && res.audioPath) await audioEngine.playTts(res.audioPath)
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon providerId={connection.providerId} />
            测试「{connection.name}」
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <div>
            <Label className="mb-1 text-xs">模型（这条接入已启用的）</Label>
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {connection.models.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {ttsModelLabel(catalog, connection.providerId, item.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-1 text-xs">音色（留空用该模型目录第一个）</Label>
            <Input
              className="h-8 text-xs"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              placeholder="音色 id"
            />
            {clones.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {clones.map((item) => (
                  <Button
                    key={item.id}
                    variant={voice === item.voiceType ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => setVoice(item.voiceType)}
                  >
                    {item.name}
                  </Button>
                ))}
              </div>
            )}
            {voiceGroups.length > 0 && (
              <div className="mt-2 flex max-h-44 flex-col gap-2 overflow-y-auto rounded-lg border px-2 py-2">
                {voiceGroups.map((group) => (
                  <div key={group.label} className="flex flex-col gap-1">
                    <span className="text-[13px] text-muted-foreground">{group.label}</span>
                    <div className="flex flex-wrap gap-1">
                      {group.voices.map((spec) => (
                        <Button
                          key={spec.id}
                          variant={voice === spec.id ? 'secondary' : 'ghost'}
                          size="sm"
                          className="h-6 text-xs"
                          title={spec.id}
                          onClick={() => setVoice(spec.id)}
                        >
                          {spec.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {voiceGroups.length === 0 && clones.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                这个模型没有内置音色目录：复刻模型用音色库里绑它的克隆音色，或在上面手填音色 id。
              </p>
            )}
          </div>

          <div>
            <Label className="mb-1 text-xs">测试文本</Label>
            <Input className="h-8 text-xs" value={text} onChange={(e) => setText(e.target.value)} />
          </div>

          {result &&
            (result.ok ? (
              <p className="text-xs text-emerald-600">
                合成成功{result.latencyMs ? ` · ${result.latencyMs} ms` : ''}
                {result.audioPath ? ' · 正在播放' : ''}
              </p>
            ) : (
              <p className="text-xs text-destructive">{result.error}</p>
            ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button disabled={busy || !modelId} onClick={() => void run()}>
            {busy ? '合成中…' : '测试合成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建/编辑语音合成接入：接入名 + 凭据 + 模型（勾选 + 每个模型的参数）+ 实时合成 */
function TtsConnectionEditorDialog({
  providerId,
  connection,
  onClose
}: {
  providerId: TtsProvider
  connection?: TtsConnectionSafe
  onClose: () => void
}) {
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)
  const connections = useAppStore((s) => s.ttsConnections)
  const setConnections = useAppStore((s) => s.setTtsConnections)
  const def = providers.find((item) => item.id === providerId)
  const catalog = flattenModelCatalog(providers)
  const specs = (def?.models ?? []).filter((spec) => spec.kind !== 'realtime')
  const fields = def ? credentialFields(def) : []
  const firstTts = specs.find((spec) => spec.kind === 'tts')?.id ?? specs[0]?.id ?? ''
  const [name, setName] = useState(connection?.name ?? def?.label ?? '')
  const [params, setParams] = useState<Record<string, string | number | boolean>>(() => {
    const initial: Record<string, string | number | boolean> = { ...(connection?.params ?? {}) }
    for (const field of def?.configFields ?? []) {
      if (initial[field.key] === undefined && field.default !== undefined) initial[field.key] = field.default
    }
    return initial
  })
  const [enabled, setEnabled] = useState<string[]>(
    () => connection?.models.map((item) => item.id) ?? (firstTts ? [firstTts] : [])
  )
  const [modelParams, setModelParams] = useState<Record<string, Record<string, string | number | boolean>>>(
    () => Object.fromEntries((connection?.models ?? []).map((item) => [item.id, { ...item.params }]))
  )
  const [realtime, setRealtime] = useState(connection?.realtime ?? false)
  const [expanded, setExpanded] = useState('')
  const [busy, setBusy] = useState(false)

  const toggleModel = (id: string, on: boolean) => {
    setEnabled(on ? [...enabled, id] : enabled.filter((item) => item !== id))
  }

  const patchModelParam = (id: string, key: string, value: string | number | boolean) =>
    setModelParams((prev) => {
      const current = { ...(prev[id] ?? {}) }
      // 清空 = 回到官方默认：键直接去掉，别把空值落盘
      if (value === '') delete current[key]
      else current[key] = value
      return { ...prev, [id]: current }
    })

  const restreamable = specs.some((spec) => enabled.includes(spec.id) && spec.streaming)

  const save = async () => {
    if (busy) return
    if (!name.trim()) {
      toast.warning('先给这条接入起个名字')
      return
    }
    if (enabled.length === 0) {
      toast.warning('至少启用一个模型', { description: '勾上要用的模型，音色才有地方合成' })
      return
    }
    setBusy(true)
    try {
      const result = await window.api.tts.saveConnection({
        id: connection?.id,
        providerId,
        name,
        params,
        models: enabled.map((id) => ({ id, params: modelParams[id] ?? {} })),
        realtime: restreamable ? realtime : false
      })
      if (!result.ok) {
        toast.error('保存失败', { description: result.error })
        return
      }
      setConnections(result.connections)
      toast.success(connection ? '接入已保存' : '接入已新建', { description: '启动中的主播重启后使用新凭据' })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  if (!def) return null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[86vh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon providerId={def.icon} />
            {connection ? connection.name : `新建${def.label}接入`}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-3">
            <div>
              <Label className="mb-1">接入名</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`如：${def.label} 主号 / 备用账号`}
              />
            </div>

            {fields.map((field) => (
              <div key={field.key}>
                <Label className="mb-1">{field.label}</Label>
                <ProviderField
                  field={field}
                  value={params[field.key] ?? ''}
                  secretSaved={Boolean(connection?.hasSecret && field.secret)}
                  onChange={(value) => setParams((prev) => ({ ...prev, [field.key]: value }))}
                />
                {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
              </div>
            ))}
          </div>

          <div>
            <Label className="mb-2">模型（勾上要用的；展开配这个模型的参数，比如语速、语气）</Label>
            <div className="flex flex-col gap-2">
              {specs.map((spec) => {
                const on = enabled.includes(spec.id)
                const missingWorkspace = Boolean(spec.needsWorkspace) && !String(params.workspaceId ?? '').trim()
                const paramCount = Object.keys(modelParams[spec.id] ?? {}).length
                return (
                  <div key={spec.id} className="rounded-lg border bg-background">
                    <div className="flex items-center gap-2.5 px-3 py-2.5">
                      <Checkbox
                        checked={on}
                        onCheckedChange={(value) => toggleModel(spec.id, value === true)}
                        aria-label={`启用 ${spec.label}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm">{spec.label}</span>
                          {spec.kind === 'clone' && <Badge variant="outline">复刻模型</Badge>}
                          {missingWorkspace && (
                            <Badge variant="outline" className="text-amber-600">
                              需业务空间 ID
                            </Badge>
                          )}
                        </div>
                        {spec.note && <p className="mt-0.5 truncate text-xs text-muted-foreground">{spec.note}</p>}
                      </div>
                      {spec.params.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!on}
                          onClick={() => setExpanded(expanded === spec.id ? '' : spec.id)}
                        >
                          参数{paramCount > 0 ? `（${paramCount}）` : ''}
                        </Button>
                      )}
                    </div>
                    {on && expanded === spec.id && spec.params.length > 0 && (
                      <div className="border-t px-3 py-3">
                        <TtsParamForm
                          specs={spec.params}
                          values={modelParams[spec.id] ?? {}}
                          onChange={(key, value) => patchModelParam(spec.id, key, value)}
                        />
                        <p className="mt-2 text-xs text-muted-foreground">清空某一项 = 用官方默认值</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3">
            <div>
              <p className="text-sm">实时合成</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {restreamable
                  ? '动态内容（评论回复等）边合成边播，首包更快；剧本类话术照旧提前预合成'
                  : '勾上的模型都不支持流式，开不了'}
              </p>
            </div>
            <Switch
              checked={realtime && restreamable}
              disabled={!restreamable}
              onCheckedChange={setRealtime}
              aria-label="实时合成开关"
            />
          </div>

          <DocLinks items={def.links} />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
