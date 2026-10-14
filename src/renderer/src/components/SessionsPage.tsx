import { useCallback, useEffect, useState } from 'react'
import {
  BookOpenText,
  CalendarDays,
  Check,
  Drama,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
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
import { useAppStore } from '../stores/useAppStore'
import {
  DEFAULT_MODE_ID,
  type KnowledgeFile,
  type LiveMode,
  type LivePlan,
  type Product,
  type Script
} from '../../../shared/types'
import { PlanDialog } from './sessions/PlanDialog'
import { ModesDialog } from './sessions/ModesDialog'
import { UtteranceDialog } from './sessions/UtteranceDialog'

/** 场次：一场直播的任务配置（形式/模式/剧本/知识库/话术库）。谁播由当前主播定，开播唯一入口在直播台。 */
export function SessionsPage() {
  const config = useAppStore((s) => s.config)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const [plans, setPlans] = useState<LivePlan[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [modes, setModes] = useState<LiveMode[]>([])
  /** 每个场次的话术库统计（卡片上显示） */
  const [utteranceStats, setUtteranceStats] = useState<Record<string, { total: number; ready: number }>>({})
  const [editing, setEditing] = useState<{ plan?: LivePlan } | null>(null)
  const [deleting, setDeleting] = useState<LivePlan | null>(null)
  const [reviewing, setReviewing] = useState<LivePlan | null>(null)
  const [modesOpen, setModesOpen] = useState(false)

  const activePlanId = config.live.activePlanId

  const reload = useCallback(async () => {
    const [p, s, pr, f, m] = await Promise.all([
      window.api.plan.list(),
      window.api.script.list(),
      window.api.knowledge.listProducts(),
      window.api.knowledge.listFiles(),
      window.api.mode.list()
    ])
    setPlans(p)
    setScripts(s)
    setProducts(pr)
    setFiles(f)
    setModes(m)
    const stats: Record<string, { total: number; ready: number }> = {}
    for (const plan of p) {
      const list = await window.api.utterance.list(plan.id)
      stats[plan.id] = { total: list.length, ready: list.filter((u) => u.status === 'ready').length }
    }
    setUtteranceStats(stats)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setActive = (id: string) => {
    void window.api.plan.setActive(id === activePlanId ? '' : id).then(async () => {
      await loadConfig() // 主进程写的 config，拉回来同步渲染端缓存
      await reload()
      toast.success(id === activePlanId ? '已取消当前场次' : '已设为当前场次', {
        description: id === activePlanId ? undefined : '下次开播按这个场次就位'
      })
    })
  }

  const scriptName = (id: string | null) => scripts.find((s) => s.id === id)?.title ?? null
  const modeName = (id: string) =>
    modes.find((m) => m.id === (id || DEFAULT_MODE_ID))?.name ??
    modes.find((m) => m.id === DEFAULT_MODE_ID)?.name ??
    null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <CalendarDays className="size-4 text-primary" />
        <h1 className="text-sm font-medium">场次</h1>
        <p className="text-xs text-muted-foreground">一场直播的任务配置：形式 + 模式 + 剧本 + 知识库 + 话术库（谁播由当前主播定）</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setModesOpen(true)}>
            <Drama />
            模式库
          </Button>
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
            <p className="text-sm">还没有场次。建一个场次，把这场要用的人设、剧本、话术库都装进去</p>
          </div>
        ) : (
          <div className="grid max-w-4xl grid-cols-2 gap-3">
            {plans.map((plan) => {
              const active = plan.id === activePlanId
              const stats = utteranceStats[plan.id]
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
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {plan.styleHint && <Badge variant="outline">{plan.styleHint}</Badge>}
                      {modeName(plan.modeId) && <Badge variant="outline">{modeName(plan.modeId)}</Badge>}
                      {scriptName(plan.scriptId) ? (
                        <Badge variant="secondary">{scriptName(plan.scriptId)}</Badge>
                      ) : (
                        <Badge variant="outline">未绑剧本</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <BookOpenText className="size-3.5" />
                      {stats && stats.total > 0 ? (
                        <span>
                          话术库 {stats.total} 段 · 就绪 {stats.ready}
                        </span>
                      ) : (
                        <span>话术库为空（点「话术库」生成）</span>
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
                      <Button variant="outline" size="sm" onClick={() => setReviewing(plan)}>
                        <BookOpenText />
                        话术库
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
        products={products}
        files={files}
        modes={modes}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      <ModesDialog open={modesOpen} modes={modes} onOpenChange={setModesOpen} onChanged={reload} />
      {reviewing && (
        <UtteranceDialog
          plan={reviewing}
          script={scripts.find((s) => s.id === reviewing.scriptId) ?? null}
          open
          onOpenChange={(open) => {
            if (!open) setReviewing(null)
          }}
          onChanged={reload}
        />
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除场次</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？本场话术库会一起删掉，绑定的剧本不受影响。
          </p>
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
