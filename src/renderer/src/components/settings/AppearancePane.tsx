import { Monitor, Moon, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppStore } from '../../stores/useAppStore'
import { APP_ACCENTS, APP_ACCENT_META, type AppAccent, type AppTheme } from '../../../../shared/types'

const THEME_OPTIONS: { id: AppTheme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor }
]

export function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const accent = useAppStore((s) => s.accent)
  const setTheme = useAppStore((s) => s.setTheme)
  const setAccent = useAppStore((s) => s.setAccent)

  const saveTheme = (value: AppTheme) => {
    setTheme(value).catch((e) =>
      toast.error('保存主题失败', { description: e instanceof Error ? e.message : String(e) })
    )
  }

  const saveAccent = (value: AppAccent) => {
    setAccent(value).catch((e) =>
      toast.error('保存配色失败', { description: e instanceof Error ? e.message : String(e) })
    )
  }

  return (
    <section>
      <h2 className="text-sm font-medium">外观</h2>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-[13px]">明暗模式</p>
          <p className="text-xs text-muted-foreground">跟随系统时随系统自动切换明暗</p>
        </div>
        <Select value={theme} onValueChange={(v) => saveTheme(v as AppTheme)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-[13px]">配色主题</p>
          <p className="text-xs text-muted-foreground">点缀色，作用于按钮、选中态与强调信息</p>
        </div>
        <Select value={accent} onValueChange={(v) => saveAccent(v as AppAccent)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_ACCENTS.map((id) => (
              <SelectItem key={id} value={id}>
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block size-3 rounded-full"
                    style={{ background: APP_ACCENT_META[id].light }}
                  />
                  {APP_ACCENT_META[id].label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  )
}
