import { useEffect, useState } from 'react'
import { AudioLines, BookOpen, Brain, Cable, Compass, Info, MessageSquareText, Palette } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAppStore, type SettingsPaneId } from '../stores/useAppStore'
import { AboutPane } from './settings/AboutPane'
import { AppearancePane } from './settings/AppearancePane'
import { DirectorSection } from './settings/DirectorPane'
import { LlmSection } from './settings/LlmPane'
import { PromptsSection } from './settings/PromptsPane'
import { TtsSection } from './settings/TtsPane'
import { StreamSection } from './settings/StreamPane'
import { CommentGatewayCard } from './settings/CommentPane'

type Pane = SettingsPaneId

const PANES: { id: Pane; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'director', label: '导演', icon: Compass },
  { id: 'llm', label: '语言模型', icon: Brain },
  { id: 'prompts', label: '导演手册', icon: BookOpen },
  { id: 'tts', label: '语音合成', icon: AudioLines },
  { id: 'stream', label: '推流', icon: Cable },
  { id: 'comment', label: '连接器', icon: MessageSquareText },
  { id: 'about', label: '关于', icon: Info }
]

/** 设置：全局弹窗（对齐 TermPilot），左侧栏目、右侧当前项。从侧边栏底部入口打开。 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const targetPane = useAppStore((s) => s.settingsPane)
  // 默认落「语言模型」（docs/REDESIGN 4.9：小白最常要修的是导演大脑，不是外观）
  const [pane, setPane] = useState<Pane>('director')

  // 深链定位（预检「去修复」等）：打开时若指定了栏目就跳过去
  useEffect(() => {
    if (open && targetPane) setPane(targetPane)
  }, [open, targetPane])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton
        className="flex h-[min(640px,85vh)] w-[min(880px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-44 shrink-0 flex-col gap-1 border-r bg-muted/40 p-3">
            <div className="px-2 py-1.5 text-sm font-medium">设置</div>
            {PANES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                  pane === item.id ? 'bg-background font-medium shadow-sm' : 'hover:bg-background/70'
                )}
                onClick={() => setPane(item.id)}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-5">
            {pane === 'appearance' && <AppearancePane />}
            {pane === 'director' && <DirectorSection />}
            {pane === 'llm' && <div className="max-w-2xl"><LlmSection /></div>}
            {pane === 'prompts' && <PromptsSection />}
            {pane === 'tts' && <div className="max-w-3xl"><TtsSection /></div>}
            {pane === 'stream' && <div className="max-w-xl"><StreamSection /></div>}
            {pane === 'comment' && <div className="max-w-xl"><CommentGatewayCard /></div>}
            {pane === 'about' && <div className="max-w-xl"><AboutPane /></div>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
