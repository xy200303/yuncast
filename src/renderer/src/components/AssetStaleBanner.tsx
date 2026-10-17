import { useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '../stores/useAppStore'

/**
 * 「资产改过了」提示条（docs/07 §8.5）：会话出生时冻结了人设 / 模型 / 剧本，
 * 之后改这些资产不会影响正在跑的这一场——这里是唯一的「立即应用」入口。
 * 音色不在此列：它是每条话术现算的，改完对后面说的话立刻生效。
 * 全局只有一个会话（导演对话和开播播出共用）。应用分两档：
 * prompt（人设/剧本/手册/节目）= 热更新，原位换 system 消息，不打断不弹确认；
 * brain（导演模型/接入）= 换脑，必须重开会话，弹窗说明后执行。
 */
export function AssetStaleBanner() {
  const stale = useAppStore((s) => s.agent.assetsStale)
  const live = useAppStore((s) => s.agent.live === true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!stale || stale === 'none') return null

  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.agent.restart()
      if (result.ok) {
        setConfirming(false)
        if (result.mode === 'cold') {
          toast.success('已按最新资产重开会话', { description: '接下来用新的模型，历史对话保留' })
        } else {
          toast.success('已热更新', { description: '人设 / 剧本 / 手册立刻生效，会话没断' })
        }
      } else {
        toast.error('应用失败', { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  if (stale === 'prompt') {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400">
        <Zap className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          人设 / 剧本 / 手册改过了——立即应用立刻生效，不打断当前会话
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 border-amber-500/40 px-2 text-xs"
          disabled={busy}
          onClick={() => void apply()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Zap />}
          立即应用
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {live
            ? '导演模型 / 接入改过了——现在跑的还是开播时的大脑，改动下次开播生效'
            : '导演模型 / 接入改过了——要重开会话才生效'}
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
            换大脑要重开当前会话（导演对话和开播播出是同一个会话）：
            正在生成的那一轮会被打断，<span className="text-foreground">历史对话保留</span>
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
