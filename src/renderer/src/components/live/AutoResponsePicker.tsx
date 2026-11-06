import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { SessionConfig, Trigger } from '../../../../shared/types'

/**
 * 自动响应配置（本场的互动总闸 + 触发器白名单）：
 * 直播台顶栏「自动响应」弹窗用它——**播出中也能改**，
 * 改的是本场配置（不写回节目），主进程 refreshProgramGate 立刻让引擎按新配置判定。
 */
export function AutoResponsePicker({
  programId,
  session,
  onSaved,
  compact = false
}: {
  programId: string
  session: SessionConfig
  onSaved?: (session: SessionConfig) => void
  /** 紧凑版（开播确认页内嵌）：不放标题与说明 */
  compact?: boolean
}) {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.trigger.list().then((list) => setTriggers(list.filter((item) => item.enabled)))
  }, [])

  const save = async (
    patch: Partial<Pick<SessionConfig, 'allowLiveEvents' | 'enabledTriggerIds'>>
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await window.api.sessionConfig.patch(programId, patch)
      if (saved) onSaved?.(saved)
      else toast.error('自动响应没保存上', { description: '本场配置不存在，先做一次开播配置' })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (triggerId: string, on: boolean): void => {
    const next = on
      ? [...new Set([...session.enabledTriggerIds, triggerId])]
      : session.enabledTriggerIds.filter((id) => id !== triggerId)
    void save({ enabledTriggerIds: next })
  }

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
        <div className="min-w-0">
          <Label className="text-sm">让导演看到直播间动态</Label>
          <p className="text-xs text-muted-foreground">
            关掉后评论/礼物/进场都不交给导演，只按稿子演
          </p>
        </div>
        <Switch
          checked={session.allowLiveEvents}
          disabled={busy}
          onCheckedChange={(checked) => void save({ allowLiveEvents: checked })}
        />
      </div>
      {session.allowLiveEvents && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/20 px-3 py-2">
          <span className="text-xs text-muted-foreground">自动响应：</span>
          {triggers.length === 0 ? (
            <span className="text-xs text-muted-foreground">没有可用的触发器</span>
          ) : (
            triggers.map((trigger) => (
              <label key={trigger.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={session.enabledTriggerIds.includes(trigger.id)}
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
          改完立刻生效，播出中也能调——不必下播、不用重启。
        </p>
      )}
    </div>
  )
}
