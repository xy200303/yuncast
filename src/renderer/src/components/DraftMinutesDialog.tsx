import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MIN_PLANNED_MINUTES, type LivePlan } from '../../../shared/types'
import { BITS_PER_MINUTE, planBroadcastCap } from '../../../shared/planDuration'

/**
 * 生成底稿的一次性配置弹窗（生成入口共用：场次页话术库 / 直播台预检）。
 * 预生成时长和语气指令都是「这次怎么写」的一次性输入，不是场次属性——
 * 底稿可以反复生成，每次都能用不同的时长和语气；填完写回场次仅作下次默认值。
 * 真正的硬限制只有场次播报成本阀（段数上限，在场次里配）。
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
  /** 确认后回调（配置已写回场次）：调用方负责跳直播台/派写稿 */
  onConfirm: (minutes: number) => void
}) {
  const [minutes, setMinutes] = useState(plan.plannedMinutes)
  const [toneHint, setToneHint] = useState(plan.genConfig.toneHint)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setMinutes(plan.plannedMinutes)
      setToneHint(plan.genConfig.toneHint)
    }
  }, [open, plan.plannedMinutes, plan.genConfig.toneHint])

  const cap = planBroadcastCap(plan)
  const estimated = Math.min(Math.max(1, Math.ceil(minutes * BITS_PER_MINUTE)), cap)

  const submit = () => {
    if (busy) return
    setBusy(true)
    // 写回场次仅作下次生成的默认值（一次性配置的便利记忆，不是场次配置）
    void window.api.plan
      .save({ ...plan, plannedMinutes: minutes, genConfig: { ...plan.genConfig, toneHint } }, plan.id)
      .then((result) => {
        if (!result.ok) {
          toast.error('保存生成配置失败', { description: result.error })
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
        <div className="flex flex-col gap-3">
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
            />
            <p className="mt-1 text-xs text-muted-foreground">
              按 {minutes} 分钟约写 {estimated} 段桥段
              {Number.isFinite(cap) ? `（场次播报上限 ${cap} 段，写满即停）` : ''}
            </p>
          </div>
          <div>
            <Label className="mb-1">风格要求（可选，仅本次生成）</Label>
            <Input
              value={toneHint}
              onChange={(e) => setToneHint(e.target.value)}
              placeholder="例如：节奏明快、多讲故事、少喊口号"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              说给主播听的大白话：它自己理解后翻译成每段的演法（语气/语速/停顿/形态），不直连任何合成参数
            </p>
          </div>
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
