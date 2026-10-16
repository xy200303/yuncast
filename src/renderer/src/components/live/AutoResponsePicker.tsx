import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { Program, Trigger } from '../../../../shared/types'

/**
 * 自动响应配置（节目的互动总闸 + 触发器白名单）：
 * 开播确认页和直播台「⋯ → 自动响应」共用同一份组件——**播出中也能改**，改完写回节目配置，
 * 主进程 refreshProgramGate 立刻让引擎按新配置判定（不用下播、不用重启会话）。
 */
export function AutoResponsePicker({
  program,
  onSaved,
  compact = false
}: {
  program: Program
  onSaved?: (program: Program) => void
  /** 紧凑版（开播确认页内嵌）：不放标题与说明 */
  compact?: boolean
}) {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.trigger.list().then((list) => setTriggers(list.filter((item) => item.enabled)))
  }, [])

  const save = async (patch: Partial<Pick<Program, 'allowLiveEvents' | 'enabledTriggerIds'>>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const { id, createdAt: _c, updatedAt: _u, currentSceneIdx: _s, ...input } = program
      const result = await window.api.program.save({ ...input, ...patch }, id)
      if (result.ok) onSaved?.(result.item)
      else toast.error('自动响应没保存上', { description: result.error })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (triggerId: string, on: boolean): void => {
    const next = on
      ? [...new Set([...program.enabledTriggerIds, triggerId])]
      : program.enabledTriggerIds.filter((id) => id !== triggerId)
    void save({ enabledTriggerIds: next })
  }

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
        <div className="min-w-0">
          <Label className="text-sm">让主播看到直播间动态</Label>
          <p className="text-xs text-muted-foreground">
            关掉后评论/礼物/进场都不派给主播，她只演自己的
          </p>
        </div>
        <Switch
          checked={program.allowLiveEvents}
          disabled={busy}
          onCheckedChange={(checked) => void save({ allowLiveEvents: checked })}
        />
      </div>
      {program.allowLiveEvents && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/20 px-3 py-2">
          <span className="text-xs text-muted-foreground">自动响应：</span>
          {triggers.length === 0 ? (
            <span className="text-xs text-muted-foreground">没有可用的触发器</span>
          ) : (
            triggers.map((trigger) => (
              <label key={trigger.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={program.enabledTriggerIds.includes(trigger.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => toggle(trigger.id, checked === true)}
                />
                {trigger.name}
              </label>
            ))
          )}
        </div>
      )}
      {!compact && (
        <p className="px-1 text-xs text-muted-foreground">
          改完立刻生效，播出中也能调——不必下播、不用重启导演。
        </p>
      )}
    </div>
  )
}
