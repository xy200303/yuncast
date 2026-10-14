import { useState } from 'react'
import { Copy, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  type LiveMode,
  type LiveModeInput,
  type LiveModeWiring
} from '../../../../shared/types'

/** 评论接入方式的展示名 */
const COMMENTS_LABEL: Record<LiveModeWiring['comments'], string> = {
  off: '不接评论',
  batched: '评论攒批',
  full: '逐条即派'
}
const ENTRANCES_LABEL: Record<LiveModeWiring['entrances'], string> = {
  off: '不理进场',
  fans: '只欢迎老粉',
  all: '都欢迎'
}

/** 模式库：内置模式随代码升级（只能复制），自定义模式自由增删改。场次只存 modeId，改模式对所有场次生效。 */
export function ModesDialog({
  open,
  modes,
  onOpenChange,
  onChanged
}: {
  open: boolean
  modes: LiveMode[]
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}) {
  /** null=列表视图；{input, id?}=编辑/新建视图 */
  const [draft, setDraft] = useState<{ input: LiveModeInput; id?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (next: boolean) => {
    if (!next) setDraft(null)
    onOpenChange(next)
  }

  const startEdit = (mode: LiveMode) => {
    setDraft({
      id: mode.id,
      input: {
        name: mode.name,
        description: mode.description,
        wiring: { ...mode.wiring },
        promptModule: mode.promptModule
      }
    })
  }

  const startNew = () => {
    setDraft({
      input: {
        name: '',
        description: '',
        wiring: { comments: 'batched', commentBatchSec: 15, entrances: 'fans', triggers: true },
        promptModule: ''
      }
    })
  }

  const submit = () => {
    if (!draft || !draft.input.name.trim() || busy) return
    setBusy(true)
    void window.api.mode
      .save(draft.input, draft.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(draft.id ? '模式已更新' : '模式已创建', {
            description: '用它的场次下次开播生效'
          })
          setDraft(null)
          await onChanged()
        } else toast.error('保存失败', { description: result.error })
      })
      .finally(() => setBusy(false))
  }

  const duplicate = (mode: LiveMode) => {
    void window.api.mode.duplicate(mode.id).then(async (result) => {
      if (result.ok) {
        toast.success('已复制，可以随便改了')
        await onChanged()
      } else toast.error('复制失败', { description: result.error })
    })
  }

  const remove = (mode: LiveMode) => {
    void window.api.mode.remove(mode.id).then(async (result) => {
      if (result.ok) {
        toast.success('已删除', { description: '引用它的场次会回落到默认互动模式' })
        await onChanged()
      } else toast.error('删除失败', { description: result.error })
    })
  }

  const wiringSummary = (w: LiveModeWiring) =>
    `${COMMENTS_LABEL[w.comments]}${w.comments === 'batched' ? `（${w.commentBatchSec}s）` : ''} · ${ENTRANCES_LABEL[w.entrances]} · 触发器${w.triggers ? '开' : '关'}`

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.id ? '编辑模式' : '新建模式') : '直播模式库'}</DialogTitle>
        </DialogHeader>
        {draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1">模式名称</Label>
                <Input
                  value={draft.input.name}
                  onChange={(e) => setDraft({ ...draft, input: { ...draft.input, name: e.target.value } })}
                  placeholder="例如：深夜情感场"
                />
              </div>
              <div>
                <Label className="mb-1">一句话说明</Label>
                <Input
                  value={draft.input.description}
                  onChange={(e) =>
                    setDraft({ ...draft, input: { ...draft.input, description: e.target.value } })
                  }
                  placeholder="这场怎么播，给谁看"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="mb-1">评论接入</Label>
                <Select
                  value={draft.input.wiring.comments}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: { ...draft.input.wiring, comments: v as LiveModeWiring['comments'] }
                      }
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">不接（纯直播）</SelectItem>
                    <SelectItem value="batched">攒批派给主播</SelectItem>
                    <SelectItem value="full">逐条即派</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1">攒批窗口（秒）</Label>
                <Input
                  type="number"
                  min={3}
                  max={120}
                  disabled={draft.input.wiring.comments !== 'batched'}
                  value={draft.input.wiring.commentBatchSec}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: {
                          ...draft.input.wiring,
                          commentBatchSec: Math.max(3, Math.min(120, Number(e.target.value) || 15))
                        }
                      }
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1">进场事件</Label>
                <Select
                  value={draft.input.wiring.entrances}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      input: {
                        ...draft.input,
                        wiring: { ...draft.input.wiring, entrances: v as LiveModeWiring['entrances'] }
                      }
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">不理</SelectItem>
                    <SelectItem value="fans">只欢迎老粉</SelectItem>
                    <SelectItem value="all">都欢迎</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.input.wiring.triggers}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    input: {
                      ...draft.input,
                      wiring: { ...draft.input.wiring, triggers: checked === true }
                    }
                  })
                }
              />
              自动化触发器（冷场自救/整点带节奏/价格提醒…；关掉主播就不被任何外部事件打扰）
            </label>

            <div className="flex min-h-0 flex-1 flex-col">
              <Label className="mb-1">角色定位提示词模块（拼进主播 system prompt 的「本场直播」段）</Label>
              <Textarea
                className="min-h-40 flex-1 font-mono text-xs"
                value={draft.input.promptModule}
                onChange={(e) =>
                  setDraft({ ...draft, input: { ...draft.input, promptModule: e.target.value } })
                }
                placeholder={'- 直播模式：xxx。这场怎么演…\n- 节奏/形态上的特别要求…'}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                只写「怎么演」的定位和节奏要求；具体内容仍由主播自编自导
              </p>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                返回
              </Button>
              <Button onClick={submit} disabled={!draft.input.name.trim() || busy}>
                {busy && <Loader2 className="animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {modes.map((mode) => (
              <div key={mode.id} className="flex items-start gap-2 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{mode.name}</span>
                    {mode.builtIn && <Badge variant="secondary">内置</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{mode.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{wiringSummary(mode.wiring)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" title="复制一份再改" onClick={() => duplicate(mode)}>
                    <Copy />
                  </Button>
                  {!mode.builtIn && (
                    <>
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => startEdit(mode)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => remove(mode)}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            <div className="pt-1">
              <Button size="sm" variant="outline" onClick={startNew}>
                <Plus />
                新建模式
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
