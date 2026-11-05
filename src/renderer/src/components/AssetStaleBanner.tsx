import { useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '../stores/useAppStore'

/**
 * 「换脑」提示条：只有导演模型/接入变了才出现——它焊在会话实例上，只能重开。
 * 内容（场次/稿子/手册/项目资料）不参与判断：agent 用工具实时读取，改内容不会刷新会话、不会丢上下文。
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
          
        }
      } else {
        toast.error('应用失败', { description: result.error })
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
