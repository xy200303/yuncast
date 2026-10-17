import { useReducer, useState } from 'react'
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
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore, type ProviderFieldSpec, type TtsProviderManifest } from '../../stores/useAppStore'
import { ttsModelBadges } from '../../lib/modelBadges'
import { cn } from '@/lib/utils'
import { TTS_MODEL_KIND_LABEL, type ParamSpec, type TtsConnectionSafe, type TtsProvider } from '../../../../shared/types'

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
          key={editing.connection?.id ?? 'new-tts-connection'}
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
  const [text, setText] = useState('你好，欢迎来到直播间，这里是小云播客坊智能主播。')
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
            <UnifiedVoicePicker
              voiceId={voice}
              onPick={setVoice}
              onModelChange={setModelId}
              connections={[connection]}
              emptyLabel="（用这个模型的默认音色）"
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

/**
 * 编辑器表单是一份草稿：换服务商时模型勾选、每个模型的参数、实时开关、展开项要整批重置，
 * 属于同一次状态迁移，所以并进一个 reducer；保存/测试的请求状态（busy、formTest）与草稿无关，各自 useState。
 */
type TtsDraft = {
  providerId: TtsProvider
  name: string
  params: Record<string, string | number | boolean>
  enabled: string[]
  modelParams: Record<string, Record<string, string | number | boolean>>
  realtime: boolean
  expanded: string
}

type TtsDraftAction =
  | { type: 'name'; name: string }
  | { type: 'param'; key: string; value: string | number | boolean }
  | { type: 'toggleModel'; id: string; on: boolean }
  | { type: 'modelParam'; id: string; key: string; value: string | number | boolean }
  | { type: 'realtime'; realtime: boolean }
  | { type: 'toggleExpanded'; id: string }
  | {
      type: 'provider'
      providerId: TtsProvider
      name: string
      params: Record<string, string | number | boolean>
      enabled: string[]
      realtime: boolean
    }

function ttsDraftReducer(state: TtsDraft, action: TtsDraftAction): TtsDraft {
  switch (action.type) {
    case 'name':
      return { ...state, name: action.name }
    case 'param':
      return { ...state, params: { ...state.params, [action.key]: action.value } }
    case 'toggleModel':
      return {
        ...state,
        enabled: action.on
          ? [...state.enabled, action.id]
          : state.enabled.filter((item) => item !== action.id)
      }
    case 'modelParam': {
      const current = { ...(state.modelParams[action.id] ?? {}) }
      // 清空 = 回到官方默认：键直接去掉，别把空值落盘
      if (action.value === '') delete current[action.key]
      else current[action.key] = action.value
      return { ...state, modelParams: { ...state.modelParams, [action.id]: current } }
    }
    case 'realtime':
      return { ...state, realtime: action.realtime }
    case 'toggleExpanded':
      return { ...state, expanded: state.expanded === action.id ? '' : action.id }
    case 'provider':
      return {
        providerId: action.providerId,
        name: action.name,
        params: action.params,
        enabled: action.enabled,
        modelParams: {},
        realtime: action.realtime,
        expanded: ''
      }
  }
}

/** 初始草稿：编辑已有接入就用它落盘的值，新建就按服务商 manifest 给默认值 */
function initTtsDraft({
  connection,
  providerId,
  providers
}: {
  connection?: TtsConnectionSafe
  providerId: TtsProvider
  providers: TtsProviderManifest[]
}): TtsDraft {
  const def = providers.find((item) => item.id === providerId)
  const params: Record<string, string | number | boolean> = { ...(connection?.params ?? {}) }
  for (const field of def?.configFields ?? []) {
    if (params[field.key] === undefined && field.default !== undefined) params[field.key] = field.default
  }
  const specs = (def?.models ?? []).filter((spec) => spec.kind !== 'realtime')
  const firstTts = specs.find((spec) => spec.kind === 'tts')?.id ?? specs[0]?.id ?? ''
  return {
    providerId,
    name: connection?.name ?? def?.label ?? '',
    params,
    enabled: connection?.models.map((item) => item.id) ?? (firstTts ? [firstTts] : []),
    modelParams: Object.fromEntries(
      (connection?.models ?? []).map((item) => [item.id, { ...item.params }])
    ),
    realtime: connection?.realtime ?? false,
    expanded: ''
  }
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
  const [draft, dispatch] = useReducer(
    ttsDraftReducer,
    { connection, providerId: initialProviderId, providers },
    initTtsDraft
  )
  const { providerId, name, params, enabled, modelParams, realtime, expanded } = draft
  const def = providers.find((item) => item.id === providerId)
  const specs = (def?.models ?? []).filter((spec) => spec.kind !== 'realtime')
  const fields = def?.configFields ?? []
  const [busy, setBusy] = useState(false)
  /** 表单直连测试（不必先保存）：idle/running/ok/error + 一行结果 */
  const [formTest, setFormTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; detail?: string }>({
    state: 'idle'
  })

  /** 新建时换服务商：凭据按新服务商的字段重置，模型勾选回到新家的第一个 TTS 模型 */
  const changeProvider = (next: TtsProvider) => {
    if (connection || next === providerId) return
    const nextDef = providers.find((item) => item.id === next)
    if (!nextDef) return
    const nextParams: Record<string, string | number | boolean> = {}
    for (const field of nextDef.configFields) {
      if (field.default !== undefined) nextParams[field.key] = field.default
    }
    const nextSpecs = nextDef.models.filter((spec) => spec.kind !== 'realtime')
    const nextFirst = nextSpecs.find((spec) => spec.kind === 'tts')?.id ?? nextSpecs[0]?.id ?? ''
    dispatch({
      type: 'provider',
      providerId: next,
      // 名字还没改过（仍是上一家的 label）就跟着换，省得手填
      name: !name.trim() || name === def?.label ? nextDef.label : name,
      params: nextParams,
      enabled: nextFirst ? [nextFirst] : [],
      realtime: false
    })
  }

  const toggleModel = (id: string, on: boolean) => {
    dispatch({ type: 'toggleModel', id, on })
  }

  const patchModelParam = (id: string, key: string, value: string | number | boolean) =>
    dispatch({ type: 'modelParam', id, key, value })

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

  /**
   * 测试连通：用表单当前（未保存）的值合成一句并出声；密钥留空 = 沿用已保存的（主进程合并）。
   * 挑勾选里第一个普通合成模型（长文/双人播客模型吃不了单句文本）。
   */
  const runFormTest = async () => {
    if (formTest.state === 'running') return
    if (enabled.length === 0) {
      toast.warning('先在模型列表里勾一个模型再测')
      return
    }
    const model =
      specs.find((spec) => enabled.includes(spec.id) && (spec.capabilities?.kind ?? 'standard') === 'standard')
        ?.id ?? enabled[0]
    setFormTest({ state: 'running' })
    try {
      const result = await window.api.tts.testInput({
        id: connection?.id,
        providerId,
        name,
        params,
        models: enabled.map((id) => ({ id, params: modelParams[id] ?? {} })),
        model
      })
      setFormTest(
        result.ok
          ? { state: 'ok', detail: `合成成功${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}${result.playing ? ' · 已出声' : ''}` }
          : { state: 'error', detail: result.error }
      )
    } catch (error) {
      setFormTest({ state: 'error', detail: error instanceof Error ? error.message : String(error) })
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
            {def.note && <p className="mt-1.5 break-words text-xs text-muted-foreground">{def.note}</p>}
          </div>

          <div>
            <Label className="mb-1.5 text-sm font-medium">接入名</Label>
            <Input
              className="h-10 text-sm"
              value={name}
              onChange={(e) => dispatch({ type: 'name', name: e.target.value })}
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
                onChange={(value) => dispatch({ type: 'param', key: field.key, value })}
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
                          {/* 模型种类标签（docs/10 §6.1）：普通 / 长文 / 双人播客；复刻模型保持原标记 */}
                          {spec.kind === 'clone' ? (
                            <Badge variant="outline" className="text-xs">
                              复刻模型
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">
                              {TTS_MODEL_KIND_LABEL[spec.capabilities?.kind ?? 'standard']}
                            </Badge>
                          )}
                          {/* 能力标识：彩色图标 + 文字（与音色选择器同口径，lib/modelBadges） */}
                          {ttsModelBadges(spec).map((badge) => (
                            <Badge
                              key={badge.label}
                              variant="secondary"
                              className="gap-1 text-xs"
                              title={badge.title}
                            >
                              <badge.icon className={cn('size-3', badge.className)} />
                              {badge.label}
                            </Badge>
                          ))}
                          {missingWorkspace && (
                            <Badge variant="outline" className="text-xs text-amber-600">
                              需业务空间 ID
                            </Badge>
                          )}
                        </div>
                        {spec.note && (
                          <p className="mt-0.5 break-words text-xs text-muted-foreground">{spec.note}</p>
                        )}
                      </div>
                      {spec.params.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!on}
                          onClick={() => dispatch({ type: 'toggleExpanded', id: spec.id })}
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
              onCheckedChange={(value) => dispatch({ type: 'realtime', realtime: value })}
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
          <div className="flex flex-wrap items-center gap-2">
            {/* 测试连通：用表单当前值直接测（不必先保存），会真合成一句并出声 */}
            <Button
              variant="outline"
              size="sm"
              disabled={formTest.state === 'running' || enabled.length === 0}
              title="用上面填好的值合成一句试播，不用先保存"
              onClick={() => void runFormTest()}
            >
              {formTest.state === 'running' ? '合成中…' : '测试连通'}
            </Button>
            {formTest.state === 'ok' && <span className="text-xs text-emerald-600">{formTest.detail}</span>}
            {formTest.state === 'error' && (
              <span className="max-w-md truncate text-xs text-destructive" title={formTest.detail}>
                {formTest.detail}
              </span>
            )}
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
