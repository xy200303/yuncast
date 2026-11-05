import { useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/useProjectStore'

/** 打开项目：列出已登记的项目，点一条就切过去（等价于在磁盘上打开那个目录） */
export function ProjectSwitchDialog({
  open,
  onOpenChange,
  onCreate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 列表里没有目标时直接去新建 */
  onCreate: () => void
}) {
  const projects = useProjectStore((s) => s.projects)
  const current = useProjectStore((s) => s.current)
  const refresh = useProjectStore((s) => s.refresh)
  const openProject = useProjectStore((s) => s.open)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const enter = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      await openProject(id)
      onOpenChange(false)
    } catch (error) {
      toast.error('打开项目失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>打开项目</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {projects.length === 0 ? (
            <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">还没有项目</p>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={busy !== ''}
                onClick={() => void enter(project.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/50',
                  current?.id === project.id && 'border-primary/40 bg-muted/40'
                )}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{project.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{project.path}</span>
                </span>
                {current?.id === project.id && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">当前</span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              onCreate()
            }}
          >
            新建项目…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
