import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useProjectStore } from '@/stores/useProjectStore'

/** 新建项目：给个名字 + 选个位置（默认「文档 / YunCast Projects」） */
export function ProjectCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useProjectStore((s) => s.create)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = (): void => {
    setName('')
    setParent('')
    setBusy(false)
  }

  const pick = async (): Promise<void> => {
    const picked = await window.api.project.pickDir()
    if (picked.ok) setParent(picked.path)
  }

  const submit = async (): Promise<void> => {
    const value = name.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      await create(value, parent.trim() || undefined)
      onOpenChange(false)
      reset()
    } catch (error) {
      toast.error('新建项目失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            placeholder="项目名，比如：保温杯送礼专场"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <button
            type="button"
            onClick={() => void pick()}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/50"
            title="选择项目的父目录；不选就用默认位置"
          >
            <FolderOpen className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {parent || '默认位置：文档 / YunCast Projects'}
            </span>
            <span className="shrink-0 text-[11px]">选择…</span>
          </button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
