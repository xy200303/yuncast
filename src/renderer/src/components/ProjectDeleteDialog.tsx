import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { slashPath } from '@/lib/utils'
import { useProjectStore } from '@/stores/useProjectStore'
import type { ProjectRecord } from '../../../shared/types'

/**
 * 删除项目：两个选择——只从列表移除（目录还在），或者连项目目录一起删（不可恢复）。
 * 打开项目弹窗和欢迎页的最近项目共用。
 */
export function ProjectDeleteDialog({
  project,
  onOpenChange
}: {
  project: ProjectRecord | null
  onOpenChange: (open: boolean) => void
}) {
  const refresh = useProjectStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)

  const remove = async (deleteFiles: boolean): Promise<void> => {
    if (!project) return
    setBusy(true)
    try {
      const result = await window.api.project.remove(project.id, deleteFiles)
      if (!result.ok) {
        toast.error('删除失败', { description: result.error })
        return
      }
      await refresh()
      onOpenChange(false)
      toast.success(deleteFiles ? '项目和目录已删除' : '已从列表移除', {
        description: deleteFiles ? project.name : `${project.name}（目录还在磁盘上）`
      })
    } catch (error) {
      toast.error('删除失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[15px]">删除项目</DialogTitle>
        </DialogHeader>
        {project && (
          <div className="flex flex-col gap-2 text-[12.5px]">
            <p className="font-medium">{project.name}</p>
            <p className="break-all text-[11px] text-muted-foreground">{slashPath(project.path)}</p>
            <p className="text-muted-foreground">
              「删除项目和文件」会把整个目录一起删掉，稿子、音频、对话都没了；「仅移出列表」只从列表去掉，目录还在磁盘上。
            </p>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void remove(false)}>
            仅移出列表
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove(true)}>
            删除项目和文件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
