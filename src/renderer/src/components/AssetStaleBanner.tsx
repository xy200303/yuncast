import { useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '../stores/useAppStore'

/**
 * 「改动下次开播生效」提示条（docs/07 §8.5）：会话出生时冻结了人设 / 模型 / 剧本，
 * 之后改这些资产不会影响正在跑的这一场——这里是唯一的「立即应用」入口。
 * 音色不在此列：它是每条话术现算的，改完对后面说的话立刻生效。
 */
export function AssetStaleBanner() {
  const stale = useAppStore((s) => s.agent.assetsStale)
  const live = useAppStore((s) => s.agent.live === true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!stale) return null

  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.agent.restart()
      if (result.ok) {
        setConfirming(false)
        toast.success('已按最新资产重启会话', { description: '主播接下来用新的人设与模型' })
      } else {
        toast.error('重启失败', { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {live
            ? '本场主播用的还是开播时的版本（人设 / 模型 / 剧本改过了），改动下次开播生效'
            : '当前主播会话用的还是启动时的版本（人设 / 模型 / 剧本改过了），重开会话才生效'}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 border-amber-500/40 px-2 text-xs"
          onClick={() => setConfirming(true)}
        >
          <RefreshCw />
          立即应用
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>立即应用改动</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            会用最新的人设、模型与剧本重开一次主播会话：
            <span className="text-foreground">当前对话上下文清空</span>
            ，大约 2-5 秒没有声音；已排进话术池的内容不受影响，照常播完。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              下次开播再说
            </Button>
            <Button disabled={busy} onClick={() => void apply()}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              立即应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
