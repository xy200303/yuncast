import { Badge } from '@/components/ui/badge'
import { useAppStore } from '../stores/useAppStore'
import { NAV_ITEMS } from './Sidebar'

/** 底部状态栏。M1 右侧全是占位状态，接入后换成真状态。 */
export function StatusBar() {
  const page = useAppStore((s) => s.page)
  const current = NAV_ITEMS.find((item) => item.id === page)

  return (
    <footer className="flex h-7 items-center gap-2 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
      <span className="truncate">{current ? `就绪 · ${current.label}` : '就绪'}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <Badge variant="outline">推流未配置</Badge>
        <Badge variant="outline">LLM 未配置</Badge>
        <Badge variant="outline">TTS 未配置</Badge>
        <Badge variant="outline">评论未接入</Badge>
      </span>
    </footer>
  )
}
