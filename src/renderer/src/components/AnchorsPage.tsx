import { useCallback, useEffect, useState } from 'react'
import { Bot, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AssetStaleBanner } from '@/components/AssetStaleBanner'
import { VoiceProviderHint } from '@/components/VoiceProviderHint'
import { useAppStore } from '../stores/useAppStore'
import { useDataRefresh } from '../lib/useDataRefresh'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { voiceDisplayName, voiceRouteSummary } from '../lib/voice'
import { ModelBadgeIcons } from './ModelBadgeIcons'
import { type Persona } from '../../../shared/types'

type PersonaForm = Omit<Persona, 'id' | 'updatedAt'>

/** 主播团：只有人设卡（风格 + 嗓音）。大脑归导演（设置 → 导演），启停归播出流程（开播/写稿）。 */
export function AnchorsPage() {
  const agent = useAppStore((s) => s.agent)
  const voices = useAppStore((s) => s.voices)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const [personas, setPersonas] = useState<Persona[]>([])
  /** 编辑器：undefined=关闭；{id?}=编辑某张卡；{}=新建 */
  const [editing, setEditing] = useState<{ persona?: Persona } | null>(null)

  const reload = useCallback(async () => {
    setPersonas(await window.api.persona.list())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])
  // agent/MCP 改了人设卡：广播到达就重拉（不用手动切页）
  useDataRefresh(['personas'], () => void reload())

  const openEditor = (persona?: Persona) => setEditing(persona ? { persona } : {})

  /** 保存后不偷偷重启会话：卡司资料是出生时冻结的，改了靠黄条上的「立即应用」显式生效 */
  const afterSaved = (okText: string) => {
    if (useAppStore.getState().agent.state === 'running') {
      toast.success(okText, { description: '本场导演用的还是开播时的版本，改动下次开播生效（可点黄条立即应用）' })
    } else {
      toast.success(okText)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <AssetStaleBanner />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Bot className="size-4 shrink-0 text-primary" />
        <h1 className="shrink-0 text-sm font-medium">主播团</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          人设卡：风格 + 嗓音（谁上场由节目卡司决定，在节目配置里选；没配卡司导演逐条指定）
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* 会话出错只报一句：配脑与启停都在设置/播出流程里，这里不做开关 */}
          {agent.state === 'error' && agent.error && (
            <div className="mb-3 max-w-2xl rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {agent.error}
            </div>
          )}

          <div className="mb-3 flex items-center gap-2">
            <p className="text-xs text-muted-foreground">主播团 · {personas.length} 位</p>
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" title="重新拉取主播卡（agent 改动会自动刷新，这里是手动兜底）" onClick={() => void reload()}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEditor()}>
              <Plus className="size-3.5" />
              新建人设卡
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 [&>*]:min-w-0">
            {personas.map((item) => {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openEditor(item)}
                  className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary">
                      {item.name.trim().slice(0, 1) || '主'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.name}</span>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                    {item.personality || '（还没写性格）'}
                  </p>
                  <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
                    <span className="truncate">
                      嗓子：{item.voiceId ? voiceDisplayName(voices, ttsProviders, item.voiceId) : '还没选（必选）'}
                    </span>
                    {/* 这把嗓子能干什么：跟选择器同一套能力图标（lib/modelBadges） */}
                    {item.voiceId && (
                      <ModelBadgeIcons
                        spec={voiceRouteSummary(voices, ttsProviders, ttsConnections, item.voiceId).modelSpec ?? undefined}
                      />
                    )}
                  </div>
                  <VoiceProviderHint voiceId={item.voiceId} />
                </button>
              )
            })}
          </div>
      </div>
      {/* 人设卡编辑器 */}
      <PersonaEditorDialog
        key={editing?.persona?.id ?? 'new-persona'}
        editing={editing}
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

/** 人设卡编辑器：点击卡片弹出，含删除 */
function PersonaEditorDialog({
  editing,
  onOpenChange,
  onSaved,
  onDeleted
}: {
  editing: { persona?: Persona } | null
  onOpenChange: (open: boolean) => void
  onSaved: (okText: string) => void | Promise<void>
  onDeleted: () => void | Promise<void>
}) {
  const open = editing !== null
  const source = editing?.persona
  const [form, setForm] = useState<PersonaForm>(() => ({
    name: source?.name ?? '',
    personality: source?.personality ?? '',
    catchphrases: source?.catchphrases ?? '',
    background: source?.background ?? '',
    taboos: source?.taboos ?? '',
    voiceId: source?.voiceId ?? ''
  }))
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const patch = (part: Partial<PersonaForm>) => setForm((prev) => ({ ...prev, ...part }))

  /** 重新从后端读这张卡（agent/MCP 刚改过：不用关弹窗，刷新一下就能看到最新内容） */
  const refreshFromBackend = async () => {
    if (!source) return
    const fresh = (await window.api.persona.list()).find((p) => p.id === source.id)
    if (!fresh) {
      toast.error('这张卡已经被删除了')
      return
    }
    setForm({
      name: fresh.name,
      personality: fresh.personality,
      catchphrases: fresh.catchphrases,
      background: fresh.background,
      taboos: fresh.taboos,
      voiceId: fresh.voiceId
    })
    toast.success('已重新读取最新内容')
  }

  const save = async () => {
    if (busy) return
    if (!form.name.trim()) {
      toast.warning('请填写主播名字')
      return
    }
    if (!form.voiceId.trim()) {
      toast.warning('给这张卡选个音色', { description: '没选音色主播没声音' })
      return
    }
    setBusy(true)
    try {
      await window.api.persona.save(form, source?.id)
      await onSaved('人设已保存')
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
              <Label className="mb-1">
                音色<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <UnifiedVoicePicker
                voiceId={form.voiceId}
                onPick={(voiceType) => patch({ voiceId: voiceType })}
              />
              {form.voiceId.trim() ? (
                <VoiceProviderHint voiceId={form.voiceId} />
              ) : (
                <p className="mt-1 text-xs text-destructive">必选：没选音色主播没声音</p>
              )}
            </div>
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

          <p className="text-xs text-muted-foreground">
            主播卡是纯资料（大脑是导演的，在「设置 → 导演」里配）。保存后写进导演的工作手册；会话在跑时顶部会出「立即应用」横幅，点了重启会话生效（换人出镜由导演按卡司调度，不换脑不打断思路）。
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {source && (
              <>
                <Button variant="ghost" onClick={() => void refreshFromBackend()}>
                  刷新内容
                </Button>
                <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                  删除
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogFooter>

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除人设卡</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              确认删除「{source?.name}」？它已生成的音频保留；节目卡司里会少一项。
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
