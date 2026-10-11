import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { useAppStore } from '../stores/useAppStore'
import type { LivePlan, LivePlanInput, Script } from '../../../shared/types'

/** 场次：一场直播的完整配置（主题 + 剧本）。当前场次持久化，主播启动时注入 system prompt。 */
export function SessionsPage() {
  const config = useAppStore((s) => s.config)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const [plans, setPlans] = useState<LivePlan[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [editing, setEditing] = useState<{ plan?: LivePlan } | null>(null)
  const [deleting, setDeleting] = useState<LivePlan | null>(null)

  const activePlanId = config.live.activePlanId

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([window.api.plan.list(), window.api.script.list()])
    setPlans(p)
    setScripts(s)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setActive = (id: string) => {
    void window.api.plan.setActive(id === activePlanId ? '' : id).then(async () => {
      await loadConfig() // 主进程写的 config，拉回来同步渲染端缓存
      await reload()
      toast.success(id === activePlanId ? '已取消当前场次' : '已设为当前场次', {
        description: id === activePlanId ? undefined : '下次启动主播按这个场次播'
      })
    })
  }

  const scriptName = (id: string | null) => scripts.find((s) => s.id === id)?.title ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <CalendarDays className="size-4 text-primary" />
        <h1 className="text-sm font-medium">场次</h1>
        <p className="text-xs text-muted-foreground">一场直播的完整配置，一键切换</p>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus />
            新建场次
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {plans.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <CalendarDays className="size-10" strokeWidth={1.25} />
            <p className="text-sm">还没有场次。建一个场次绑定剧本，主播就知道这场播什么</p>
          </div>
        ) : (
          <div className="grid max-w-4xl grid-cols-2 gap-3">
            {plans.map((plan) => {
              const active = plan.id === activePlanId
              return (
                <Card key={plan.id} className={active ? 'border-primary/50' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="min-w-0 truncate text-sm">{plan.name}</CardTitle>
                      {active && <Badge>当前场次</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                      {plan.theme || '（没写主题）'}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>剧本：</span>
                      {scriptName(plan.scriptId) ? (
                        <Badge variant="secondary">{scriptName(plan.scriptId)}</Badge>
                      ) : (
                        <span>未绑定</span>
                      )}
                      {plan.scriptId && (
                        <span className="text-muted-foreground/70">
                          进度 {plan.currentSceneIdx}/{scripts.find((s) => s.id === plan.scriptId)?.scenes.length ?? '?'} 场
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        variant={active ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setActive(plan.id)}
                      >
                        <Check />
                        {active ? '取消当前' : '设为当前'}
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditing({ plan })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(plan)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <PlanDialog
        key={editing?.plan?.id ?? 'new'}
        open={editing !== null}
        plan={editing?.plan}
        scripts={scripts}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除场次</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">确认删除「{deleting?.name}」？绑定的剧本不会删。</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                void window.api.plan.remove(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await loadConfig() // 删的可能是当前场次，拉一次同步
                    await reload()
                  } else toast.error('删除失败', { description: result.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 场次新建/编辑弹窗 */
function PlanDialog({
  open,
  plan,
  scripts,
  onOpenChange,
  onSaved
}: {
  open: boolean
  plan?: LivePlan
  scripts: Script[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<LivePlanInput>({
    name: plan?.name ?? '',
    theme: plan?.theme ?? '',
    scriptId: plan?.scriptId ?? null
  })
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (!form.name.trim() || busy) return
    setBusy(true)
    void window.api.plan
      .save(form, plan?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(plan ? '场次已更新' : '场次已创建')
          onOpenChange(false)
          await onSaved()
        } else {
          toast.error('保存失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{plan ? '编辑场次' : '新建场次'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label className="mb-1">场次名称</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：周五晚 · 锅具专场"
            />
          </div>
          <div>
            <Label className="mb-1">主题方向</Label>
            <Input
              value={form.theme}
              onChange={(e) => setForm({ ...form, theme: e.target.value })}
              placeholder="这场直播播什么、什么氛围"
            />
          </div>
          <div>
            <Label className="mb-1">绑定剧本</Label>
            <Select
              value={form.scriptId ?? 'none'}
              onValueChange={(v) => setForm({ ...form, scriptId: v === 'none' ? null : v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不绑定（自由发挥）</SelectItem>
                {scripts.map((script) => (
                  <SelectItem key={script.id} value={script.id}>
                    {script.title}（{script.scenes.length} 场）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scripts.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">还没有剧本，去「知识库」页底部建一个</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!form.name.trim() || busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
