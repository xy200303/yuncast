import { useState } from 'react'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '../stores/useAppStore'
import type { AppTheme } from '../../../shared/types'

const THEME_OPTIONS: { id: AppTheme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor }
]

/** 设置页。选项卡组织：外观 / 接入（LLM/TTS/推流/评论后续里程碑开为独立选项卡）。 */
export function SettingsPage() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Settings className="size-4 text-primary" />
        <h1 className="text-sm font-medium">设置</h1>
      </header>
      <Tabs defaultValue="appearance" className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="appearance" className="px-3">外观</TabsTrigger>
            <TabsTrigger value="access" className="px-3">接入</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="appearance" className="overflow-auto p-6">
          <section className="max-w-xl">
            <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
              <div>
                <p className="text-[13px]">主题</p>
                <p className="text-xs text-muted-foreground">界面配色，跟随系统时随系统自动切换</p>
              </div>
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon
                  const active = theme === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setError(null)
                        setTheme(option.id).catch((e) => setError(e instanceof Error ? e.message : String(e)))
                      }}
                      className={cn(
                        'flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] text-muted-foreground transition-colors',
                        active && 'bg-background text-foreground shadow-sm'
                      )}
                    >
                      <Icon className="size-3.5" />
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {error && <p className="mt-2 text-xs text-destructive">保存主题失败：{error}</p>}
          </section>
        </TabsContent>

        <TabsContent value="access" className="overflow-auto p-6">
          <section className="max-w-xl">
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
              LLM / TTS / 推流 / 评论接入将在后续里程碑开放
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
