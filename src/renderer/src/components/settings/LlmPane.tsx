import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ProviderIcon } from '@/components/ProviderIcon'
import { providerLabel, useAppStore, type LlmProviderManifest } from '../../stores/useAppStore'
import { type ModelConnectionSafe } from '../../../../shared/types'
import { DocLinks, LLM_LINKS, ProviderField } from './shared'

/**
 * 语言模型：供应商接入库（设置 = 库，用哪条由主播卡决定）。
 * 一条接入 = 一个服务商 + 一份凭据（只填一次）+ 一串这家能用的模型；
 * 字段由 provider 的 configFields 动态渲染，加一家服务商不用改这里。
 * 密钥字段只在落盘时加密，渲染层只看得到「填没填过」。
 */
export function LlmSection() {
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
  /** 模型行：id + 上下文窗口（tokens，空 = 按服务商默认）。窗口是模型级属性——同一家不同型号窗口可能差好几倍 */
  const [models, setModels] = useState<{ id: string; window: string }[]>(
    (connection?.models ?? []).map((id) => ({
      id,
      window: connection?.modelContextWindows?.[id] ? String(connection.modelContextWindows[id]) : ''
    }))
  )
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
    setModels(models.map((row, i) => (i === index ? { ...row, id: value } : row)))
  }

  const setWindowAt = (index: number, value: string) => {
    setModels(models.map((row, i) => (i === index ? { ...row, window: value } : row)))
  }

  const removeModelAt = (index: number) => {
    setModels(models.filter((_, i) => i !== index))
  }

  const addModels = (ids: string[]) => {
    const next = [...models]
    for (const id of ids) {
      const value = id.trim()
      if (value && !next.some((row) => row.id === value)) next.push({ id: value, window: '' })
    }
    setModels(next)
  }

  const save = async () => {
    if (busy) return
    if (!name.trim()) {
      toast.warning('先给这条接入起个名字')
      return
    }
    const ids = [...new Set(models.map((row) => row.id.trim()).filter(Boolean))]
    if (ids.length === 0) {
      toast.warning('至少加一个模型', { description: '模型列表里放这家能用的模型 id' })
      return
    }
    // 模型级窗口：只收填了且 ≥4096 的，其余按服务商默认
    const modelContextWindows: Record<string, number> = {}
    for (const row of models) {
      const id = row.id.trim()
      const value = Math.floor(Number(row.window))
      if (id && row.window.trim() && value >= 4096) modelContextWindows[id] = value
    }
    setBusy(true)
    try {
      const result = await window.api.model.save({
        id: connection?.id,
        name,
        providerId,
        params,
        models: ids,
        modelContextWindows
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
                {models.map((row, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      value={row.id}
                      onChange={(e) => setModelAt(index, e.target.value)}
                      placeholder="模型 id，如 deepseek-chat"
                      className="h-7 text-xs"
                    />
                    <Input
                      value={row.window}
                      onChange={(e) => setWindowAt(index, e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="窗口自动"
                      title="上下文窗口（tokens）：留空按服务商默认（DeepSeek/Kimi/千问/豆包/智谱均按 128k）。对话快涨满窗口时自动压缩旧消息（预留 16k 给回复）——不同型号窗口不一样，填准了压缩更平滑"
                      inputMode="numeric"
                      className="h-7 w-24 shrink-0 text-xs"
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
                <p className="text-xs text-muted-foreground">
                  第二列是上下文窗口（tokens），留空按服务商默认；对话涨到「窗口 − 16k」时自动压缩旧消息
                </p>
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
          picked={models.map((row) => row.id)}
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
