import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AutoResponsePicker } from './AutoResponsePicker'
import type { Program, SessionConfig } from '../../../../shared/types'

/**
 * 本场资料抽屉：只放「自动响应」这一件事。
 * 场次大纲和章节点播已经不在抽屉里重复——主区的卡片流就是全部内容与跳播入口，
 * 抽屉再列一遍只会两处各显示一套状态。
 */
export function WorkbenchDrawer({
  open,
  onClose,
  program,
  session,
  onSessionSaved
}: {
  open: boolean
  onClose: () => void
  program: Program | null
  session: SessionConfig | null
  onSessionSaved: (session: SessionConfig) => void
}) {
  /** 互动开关不依赖播放状态：没有本场配置就现建一条，打开这一页立刻可调 */
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

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/10" onClick={onClose} />
      <aside className="absolute top-0 right-0 flex h-full w-[440px] max-w-[92vw] flex-col border-l bg-background shadow-2xl">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="text-[13px] font-medium">自动响应</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} title="收起">
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
            这里是<span className="text-foreground">设置</span>：决定哪些直播间动态派给主播。实际收到的评论/礼物/系统通知在主区「事件流」里看。
          </p>
          {!program ? (
            <p className="text-xs text-muted-foreground">先打开一个项目，再配置自动响应。</p>
          ) : session ? (
            <AutoResponsePicker programId={program.id} session={session} onSaved={onSessionSaved} />
          ) : ensureFailed ? (
            <p className="text-xs text-muted-foreground">没能准备本场开关：重开这一页再试。</p>
          ) : (
            <p className="text-xs text-muted-foreground">正在准备本场开关…</p>
          )}
        </div>
      </aside>
    </div>
  )
}
