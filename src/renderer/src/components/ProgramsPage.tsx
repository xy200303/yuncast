import { useCallback, useEffect, useState } from 'react'
import {
  BookOpenText,
  Check,
  Clapperboard,
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
  BROADCAST_MODE_LABELS,
  CONTENT_TYPE_LABELS,
  type KnowledgeFile,
  type Product,
  type Program,
  type Script
} from '../../../shared/types'
import { ProgramDialog } from './programs/ProgramDialog'
import { UtteranceDialog } from './programs/UtteranceDialog'

/** 节目库：一场直播/一期播客/一本有声书都是一个节目（内容 + 播出方式 + 事件规则 + 知识范围）。谁播由当前主播定，开播唯一入口在直播台。 */
export function ProgramsPage() {
  const config = useAppStore((s) => s.config)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const [programs, setPrograms] = useState<Program[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  /** 每个节目的底稿统计（卡片上显示） */
  const [utteranceStats, setUtteranceStats] = useState<Record<string, { total: number; ready: number }>>({})
  const [editing, setEditing] = useState<{ program?: Program } | null>(null)
  const [deleting, setDeleting] = useState<Program | null>(null)
  const [reviewing, setReviewing] = useState<Program | null>(null)

  const activeProgramId = config.live.activeProgramId

  const reload = useCallback(async () => {
    const [p, s, pr, f] = await Promise.all([
      window.api.program.list(),
      window.api.script.list(),
      window.api.knowledge.listProducts(),
      window.api.knowledge.listFiles()
    ])
    setPrograms(p)
    setScripts(s)
    setProducts(pr)
    setFiles(f)
    const stats: Record<string, { total: number; ready: number }> = {}
    for (const program of p) {
      const list = await window.api.utterance.list(program.id)
      stats[program.id] = { total: list.length, ready: list.filter((u) => u.status === 'ready').length }
    }
    setUtteranceStats(stats)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setActive = (id: string) => {
    void window.api.program.setActive(id === activeProgramId ? '' : id).then(async () => {
      await loadConfig() // 主进程写的 config，拉回来同步渲染端缓存
      await reload()
      toast.success(id === activeProgramId ? '已取消当前节目' : '已设为当前节目', {
        description: id === activeProgramId ? undefined : '下次开播按这个节目就位'
      })
    })
  }

  const scriptName = (id: string | null) => scripts.find((s) => s.id === id)?.title ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Clapperboard className="size-4 text-primary" />
        <h1 className="text-sm font-medium">节目</h1>
        <p className="text-xs text-muted-foreground">一场直播、一期播客、一本有声书都是一个节目：内容 + 播出方式 + 事件规则 + 知识范围（谁播由当前主播定）</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus />
            新建节目
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {programs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Clapperboard className="size-10" strokeWidth={1.25} />
            <p className="text-sm">还没有节目。建一个节目，把这次要播的内容、剧本、底稿都装进去</p>
          </div>
        ) : (
          <div className="grid max-w-4xl grid-cols-2 gap-3">
            {programs.map((program) => {
              const active = program.id === activeProgramId
              const stats = utteranceStats[program.id]
              return (
                <Card key={program.id} className={active ? 'border-primary/50' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="min-w-0 truncate text-sm">{program.name}</CardTitle>
                      {active && <Badge>当前节目</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                      {program.theme || '（没写主题）'}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="secondary">{CONTENT_TYPE_LABELS[program.contentType]}</Badge>
                      <Badge variant="outline">{BROADCAST_MODE_LABELS[program.broadcastMode]}</Badge>
                      {scriptName(program.scriptId) ? (
                        <Badge variant="secondary">{scriptName(program.scriptId)}</Badge>
                      ) : (
                        <Badge variant="outline">未绑剧本</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <BookOpenText className="size-3.5" />
                      {stats && stats.total > 0 ? (
                        <span>
                          底稿 {stats.total} 段 · 音频就绪 {stats.ready}
                        </span>
                      ) : (
                        <span>底稿为空（点「底稿库」生成）</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        variant={active ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setActive(program.id)}
                      >
                        <Check />
                        {active ? '取消当前' : '设为当前'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setReviewing(program)}>
                        <BookOpenText />
                        底稿库
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="配置" onClick={() => setEditing({ program })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(program)}>
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

      <ProgramDialog
        key={editing?.program?.id ?? 'new'}
        open={editing !== null}
        program={editing?.program}
        scripts={scripts}
        products={products}
        files={files}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      {reviewing && (
        <UtteranceDialog
          program={reviewing}
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
            <DialogTitle>删除节目</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？它的底稿库会一起删掉，绑定的剧本不受影响。
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
                void window.api.program.remove(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await loadConfig() // 删的可能是当前节目，拉一次同步
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
