import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MIN_PLANNED_MINUTES, type LivePlan } from '../../../shared/types'
import { BITS_PER_MINUTE, planMaxBits } from '../../../shared/planDuration'

/**
 * 生成底稿前的预生成时长询问（生成入口共用：场次页话术库 / 直播台预检）。
 * 时长不是场次属性、更不是硬限制——它只是「这次写多少」的一次性输入；
 * 填完写回场次当下次的默认值，真正的成本闸是场次的话术段数上限。
 */
export function DraftMinutesDialog({
  plan,
  open,
  onOpenChange,
  onConfirm
}: {
  plan: LivePlan
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 确认后回调（时长已写回场次）：调用方负责跳直播台/派写稿 */
  onConfirm: (minutes: number) => void
}) {
  const [minutes, setMinutes] = useState(plan.plannedMinutes)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setMinutes(plan.plannedMinutes)
  }, [open, plan.plannedMinutes])

  const cap = planMaxBits({ plannedMinutes: minutes, genConfig: plan.genConfig })
  const estimated = Math.min(Math.max(1, Math.ceil(minutes * BITS_PER_MINUTE)), cap)

  const submit = () => {
    if (busy) return
    setBusy(true)
    // 记住这次填的时长，下次生成当默认值（不是场次配置，纯便利）
    void window.api.plan
      .save({ ...plan, plannedMinutes: minutes }, plan.id)
      .then((result) => {
        if (!result.ok) {
          toast.error('保存预生成时长失败', { description: result.error })
          return
        }
        onOpenChange(false)
        onConfirm(minutes)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>生成底稿 · {plan.name}</DialogTitle>
        </DialogHeader>
        <div>
          <Label className="mb-1">预生成时长（分钟）</Label>
          <Input
            type="number"
            min={MIN_PLANNED_MINUTES}
            max={600}
            value={minutes}
            onChange={(e) =>
              setMinutes(Math.max(MIN_PLANNED_MINUTES, Math.min(600, Number(e.target.value) || MIN_PLANNED_MINUTES)))
            }
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            按 {minutes} 分钟约写 {estimated} 段桥段
            {plan.genConfig.maxBits > 0 ? `（场次上限 ${plan.genConfig.maxBits} 段，写满即停）` : '（写够推算量即停）'}；
            只决定这次写多少，不是开播时长限制
          </p>
        </div>
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
