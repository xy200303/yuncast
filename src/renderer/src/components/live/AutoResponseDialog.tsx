import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AutoResponsePicker } from './AutoResponsePicker'
import type { Program, SessionConfig } from '../../../../shared/types'

/**
 * 自动响应配置弹窗（本场唯一的互动接线入口，播出中也能开）。
 * 用弹窗而不是侧边抽屉：它只有一件事，看完就关，不占版面也不跟主区的卡片流抢位置。
 */
export function AutoResponseDialog({
  open,
  onOpenChange,
  program,
  session,
  onSessionSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  program: Program | null
  session: SessionConfig | null
  onSessionSaved: (session: SessionConfig) => void
}) {
  /** 互动开关不依赖播放状态：没有本场配置就现建一条，打开弹窗立刻可调 */
  const ensuring = useRef(false)
  const [ensureFailed, setEnsureFailed] = useState(false)
  useEffect(() => {
    if (!open || !program || session) return
    if (ensuring.current) return
    ensuring.current = true
    setEnsureFailed(false)
    void window.api.sessionConfig
      .ensure(program.id)
      .then((next) => {
        if (next) onSessionSaved(next)
        else setEnsureFailed(true)
      })
      .catch(() => setEnsureFailed(true))
      .finally(() => {
        ensuring.current = false
      })
  }, [open, program, session, onSessionSaved])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">自动响应</DialogTitle>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            决定哪些直播间动态交给导演。实际收到的评论/礼物/系统通知在主区「事件流」里看；改完立刻生效，播出中也能调。
          </p>
        </DialogHeader>
        {!program ? (
          <p className="text-xs text-muted-foreground">先打开一个项目，再配置自动响应。</p>
        ) : session ? (
          <AutoResponsePicker programId={program.id} session={session} onSaved={onSessionSaved} />
        ) : ensureFailed ? (
          <p className="text-xs text-muted-foreground">没能准备本场开关：关掉重开再试。</p>
        ) : (
          <p className="text-xs text-muted-foreground">正在准备本场开关…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
