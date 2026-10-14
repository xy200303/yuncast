import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Program } from '../../../shared/types'

/**
 * 生成底稿的确认弹窗（生成入口共用：节目页底稿库 / 播控台预检）。
 * 节目化后写多少、怎么写由主播按节目配置（内容类型/剧本/知识范围）自己判断，
 * 不再有「预生成时长/语气」这类一次性输入（docs/10 §10）。
 */
export function DraftMinutesDialog({
  program,
  open,
  onOpenChange,
  onConfirm
}: {
  program: Program
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 确认后回调：调用方负责跳播控台/派写稿 */
  onConfirm: () => void
}) {
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (busy) return
    setBusy(true)
    onOpenChange(false)
    onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>生成底稿 · {program.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          主播会按这个节目的内容类型、剧本和知识范围逐场景写底稿——过程在播控台看得见，随时可以插话改口径。
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            <Sparkles />
            开始生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
