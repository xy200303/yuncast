import { useState } from 'react'
import { ArrowLeft, ChevronRight, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { VoiceCascadePicker } from '@/components/VoiceCascadePicker'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore, type ProviderFieldSpec, type TtsProviderManifest } from '../../stores/useAppStore'
import { type ParamSpec, type TtsConnectionSafe, type TtsProvider } from '../../../../shared/types'

/**
 * 语音合成（火山引擎 / 阿里云百炼）：
 * 一个条目 = 一个服务商账号，条目里带齐它自己的东西：凭据、模型与每个模型的参数（含语气）、实时合成开关。
 * 没有默认模型 / 默认音色 / 默认接入：音色严格绑定模型，模型属于某条接入，用哪个由人设卡/节目选。
 */
export function TtsSection() {
  const providers = useAppStore((s) => s.ttsProviders)
  const connections = useAppStore((s) => s.ttsConnections)
  const setConnections = useAppStore((s) => s.setTtsConnections)
  const voices = useAppStore((s) => s.voices)
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
    <div className="flex flex-col gap-4">
      {editing ? (
        <TtsConnectionEditor
          key={editing.connection?.id ?? 'new'}
          initialProviderId={editing.providerId}
          connection={editing.connection}
          onClose={() => setEditing(null)}
          onTest={(connection) => setTesting(connection)}
          onDelete={(connection) => {
            setEditing(null)
            setDeleting(connection)
          }}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">服务商接入</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                一条接入 = 一个服务商账号，凭据、模型与参数都在接入里配。
              </p>
            </div>
            <Button
              className="shrink-0"
              disabled={providers.length === 0}
              onClick={() => setEditing({ providerId: providers[0].id })}
            >
              <Plus />
              添加接入
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {connections.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                还没有接入。点「添加接入」：选服务商 → 填密钥 → 勾上要用的模型。
              </p>
            ) : (
              connections.map((connection) => {
                const provider = providers.find((item) => item.id === connection.providerId)
                const unusable = connection.models.length - connection.usableModels.length
                return (
                  <button
                    key={connection.id}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3.5 text-left hover:bg-muted/60"
                    onClick={() => setEditing({ providerId: connection.providerId, connection })}
                  >
                    <ProviderIcon providerId={connection.providerId} />
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{connection.name}</span>
                      {provider && (
                        <Badge variant="outline" className="shrink-0 text-xs">
                          {provider.label}
                        </Badge>
                      )}
                      {unusable > 0 && (
                        <Badge variant="outline" className="shrink-0 text-xs text-amber-600">
                          {unusable} 个模型缺配置
                        </Badge>
                      )}
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {connection.models.length} 个模型{connection.realtime ? ' · 实时合成' : ''}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                )
              })
            )}
          </div>
        </>
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

/** manifest 驱动的单个凭据字段：password 带眼睛切换，密钥已存时留空 = 不修改 */
function CredentialField({
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
  const [show, setShow] = useState(false)

  if (field.type === 'switch') {
    return <Switch checked={Boolean(value)} onCheckedChange={onChange} aria-label={field.label} />
  }
  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="h-10 w-full text-sm">
          <SelectValue placeholder={field.placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={6}>
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
        className="h-10 text-sm"
        type="number"
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }
  if (field.type === 'password') {
    return (
      <div className="relative">
        <Input
          className="h-10 pr-10 text-sm"
          type={show ? 'text' : 'password'}
          value={String(value ?? '')}
          placeholder={secretSaved ? '已保存，留空表示不修改' : field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? '隐藏密钥' : '显示密钥'}
          onClick={() => setShow((prev) => !prev)}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    )
  }
  return (
    <Input
      className="h-10 text-sm"
      type="text"
      value={String(value ?? '')}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
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
          <Label className="mb-1.5 text-sm">{spec.label}</Label>
          {spec.type === 'select' ? (
            <Select value={String(valueOf(spec))} onValueChange={(value) => onChange(spec.key, value)}>
              <SelectTrigger className="h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={6}>
                {(spec.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              className="h-9 text-sm"
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
          {spec.help && <p className="mt-1 text-xs text-muted-foreground">{spec.help}</p>}
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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div>
            <Label className="mb-1.5 text-sm font-medium">模型与音色</Label>
            <VoiceCascadePicker
              voiceId={voice}
              onPick={setVoice}
              onModelChange={setModelId}
              connections={[connection]}
            />
          </div>
          <div>
            <Label className="mb-1.5 text-sm font-medium">测试文本</Label>
            <Input className="h-10 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
          </div>

          {result &&
            (result.ok ? (
              <p className="text-sm text-emerald-600">
                合成成功{result.latencyMs ? ` · ${result.latencyMs} ms` : ''}
                {result.playing ? ' · 已出声' : ''}
              </p>
            ) : (
              <p className="text-sm text-destructive">{result.error}</p>
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

/** 新建/编辑语音合成接入：接入名 + 凭据 + 模型（勾选 + 每个模型的参数）+ 实时合成。栏内切换视图，不是弹窗 */
function TtsConnectionEditor({
  initialProviderId,
  connection,
  onClose,
  onTest,
  onDelete
}: {
  initialProviderId: TtsProvider
  connection?: TtsConnectionSafe
  onClose: () => void
  onTest: (connection: TtsConnectionSafe) => void
  onDelete: (connection: TtsConnectionSafe) => void
}) {
  const providers = useAppStore((s) => s.ttsProviders)
  const setConnections = useAppStore((s) => s.setTtsConnections)
  const [providerId, setProviderId] = useState(initialProviderId)
  const def = providers.find((item) => item.id === providerId)
  const specs = (def?.models ?? []).filter((spec) => spec.kind !== 'realtime')
  const fields = def?.configFields ?? []
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

  /** 新建时换服务商：凭据按新服务商的字段重置，模型勾选回到新家的第一个 TTS 模型 */
  const changeProvider = (next: TtsProvider) => {
    if (connection || next === providerId) return
    const nextDef = providers.find((item) => item.id === next)
    if (!nextDef) return
    // 名字还没改过（仍是上一家的 label）就跟着换，省得手填
    if (!name.trim() || name === def?.label) setName(nextDef.label)
    const nextParams: Record<string, string | number | boolean> = {}
    for (const field of nextDef.configFields) {
      if (field.default !== undefined) nextParams[field.key] = field.default
    }
    const nextSpecs = nextDef.models.filter((spec) => spec.kind !== 'realtime')
    const nextFirst = nextSpecs.find((spec) => spec.kind === 'tts')?.id ?? nextSpecs[0]?.id ?? ''
    setProviderId(next)
    setParams(nextParams)
    setEnabled(nextFirst ? [nextFirst] : [])
    setModelParams({})
    setRealtime(false)
    setExpanded('')
  }

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
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
          <ArrowLeft />
          返回
        </Button>
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <ProviderIcon providerId={def.icon} />
          <span className="truncate">
            {connection ? `供应商接入 · ${connection.name || '未命名'}` : '新建供应商接入'}
          </span>
        </h2>
      </div>

      <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-1.5 text-sm font-medium">服务商</Label>
            {connection ? (
              <div className="flex h-10 items-center gap-2 rounded-lg border px-3.5">
                <ProviderIcon providerId={def.icon} size="sm" />
                <span className="truncate text-sm">{def.label}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  接入的服务商创建后不可换
                </span>
              </div>
            ) : (
              <Select
                value={providerId}
                onValueChange={(value) => changeProvider(value as TtsProvider)}
              >
              <SelectTrigger className="h-10 w-full text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderIcon providerId={def.icon} size="sm" />
                  <span className="truncate">{def.label}</span>
                </span>
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={6}>
                {providers.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderIcon providerId={item.icon} size="sm" />
                      <span className="flex min-w-0 flex-col items-start">
                        <span className="text-sm">{item.label}</span>
                        {item.note && (
                          <span className="text-xs text-muted-foreground">{item.note}</span>
                        )}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
              </Select>
            )}
            {def.note && <p className="mt-1.5 truncate text-xs text-muted-foreground">{def.note}</p>}
          </div>

          <div>
            <Label className="mb-1.5 text-sm font-medium">接入名</Label>
            <Input
              className="h-10 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`如：${def.label} 主号 / 备用账号`}
            />
          </div>

          {fields.map((field) => (
            <div key={field.key}>
              <Label className="mb-1.5 text-sm font-medium">{field.label}</Label>
              <CredentialField
                field={field}
                value={params[field.key] ?? ''}
                secretSaved={Boolean(connection?.hasSecret && field.secret)}
                onChange={(value) => setParams((prev) => ({ ...prev, [field.key]: value }))}
              />
              {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
            </div>
          ))}

          <div>
            <Label className="mb-1.5 text-sm font-medium">模型列表（已启用 {enabled.length} 个）</Label>
            <div className="flex flex-col gap-2">
              {specs.map((spec) => {
                const on = enabled.includes(spec.id)
                const missingWorkspace =
                  Boolean(spec.needsWorkspace) && !String(params.workspaceId ?? '').trim()
                const paramCount = Object.keys(modelParams[spec.id] ?? {}).length
                return (
                  <div key={spec.id} className="rounded-xl border">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Checkbox
                        checked={on}
                        onCheckedChange={(value) => toggleModel(spec.id, value === true)}
                        aria-label={`启用 ${spec.label}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{spec.label}</span>
                          {spec.kind === 'clone' && (
                            <Badge variant="outline" className="text-xs">
                              复刻模型
                            </Badge>
                          )}
                          {missingWorkspace && (
                            <Badge variant="outline" className="text-xs text-amber-600">
                              需业务空间 ID
                            </Badge>
                          )}
                        </div>
                        {spec.note && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{spec.note}</p>
                        )}
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
                      <div className="border-t px-4 py-3">
                        <TtsParamForm
                          specs={spec.params}
                          values={modelParams[spec.id] ?? {}}
                          onChange={(key, value) => patchModelParam(spec.id, key, value)}
                        />
                        <p className="mt-2 text-xs text-muted-foreground">留空 = 用官方默认值</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3.5">
            <div>
              <p className="text-sm font-medium">实时合成</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {restreamable
                  ? '动态内容（评论回复等）边合成边播，首包更快（暂走 SSE 流式）'
                  : '勾选的模型都不支持流式，开不了'}
              </p>
            </div>
            <Switch
              checked={realtime && restreamable}
              disabled={!restreamable}
              onCheckedChange={setRealtime}
              aria-label="实时合成开关"
            />
          </div>

          {def.links.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {def.links.map((item) => (
                <button
                  key={item.url}
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex items-center gap-2">
            {connection && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={connection.usableModels.length === 0}
                  onClick={() => onTest(connection)}
                >
                  测试
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDelete(connection)}
                >
                  <Trash2 />
                  删除接入
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
    </div>
  )
}
