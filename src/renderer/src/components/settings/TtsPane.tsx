import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { flattenModelCatalog } from '@/lib/voice'
import { VoiceCascadePicker } from '@/components/VoiceCascadePicker'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore, type ProviderFieldSpec, type TtsProviderManifest } from '../../stores/useAppStore'
import { type ParamSpec, type TtsConnectionSafe, type TtsProvider } from '../../../../shared/types'
import { DocLinks, ProviderField } from './shared'

/** 接入里的凭据字段（manifest 的 configFields 全部是凭据） */
function credentialFields(def: TtsProviderManifest): ProviderFieldSpec[] {
  return def.configFields
}

/** 模型 id → 目录里的显示名 */

/**
 * 语音合成（火山引擎 / 阿里云百炼）：
 * 一个条目 = 一个服务商账号，条目里带齐它自己的东西：凭据、模型与每个模型的参数（含语气）、实时合成开关。
 * 没有默认模型 / 默认音色 / 默认接入：音色严格绑定模型，模型属于某条接入，用哪个由人设卡/场次选。
 */
export function TtsSection() {
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
  const [modelId, setModelId] = useState(connection.models[0]?.id ?? '')
  const [voice, setVoice] = useState('')
  const [text, setText] = useState('你好，欢迎来到直播间，这里是 Agent Anchor 智能体主播。')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    error?: string
    latencyMs?: number
    audioPath?: string
    /** 合成完由主进程直接出声：true = 真的播出来了 */
    playing?: boolean
  } | null>(null)

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
      // 合成与出声都在主进程：res.playing=true 才代表真的播出来了
      setResult(res)
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
            <Label className="mb-1 text-xs">模型与音色</Label>
            <VoiceCascadePicker
              voiceId={voice}
              onPick={setVoice}
              onModelChange={setModelId}
              connections={[connection]}
            />
          </div>
          <div>
            <Label className="mb-1 text-xs">测试文本</Label>
            <Input className="h-8 text-xs" value={text} onChange={(e) => setText(e.target.value)} />
          </div>

          {result &&
            (result.ok ? (
              <p className="text-xs text-emerald-600">
                合成成功{result.latencyMs ? ` · ${result.latencyMs} ms` : ''}
                {result.playing ? ' · 已出声' : ''}
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
                  ? '动态内容（评论回复等）边合成边播，首包更快；剧本类话术照旧提前预合成。双向实时通道协议核对中，暂时走 SSE 流式'
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
