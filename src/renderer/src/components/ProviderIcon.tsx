import { Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 服务商图标（圆角方形色块 + 字形）。
 * 键就是 provider 的 id（也就是 manifest 里的 icon 键）；未知服务商回落通用图标，
 * 所以以后新增适配器不写图标也不会开天窗。
 */
const PROVIDER_STYLES: Record<string, { glyph: string; className: string }> = {
  deepseek: { glyph: 'DS', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  qwen: { glyph: '通', className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  doubao: { glyph: '豆', className: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400' },
  kimi: { glyph: 'K', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  zai: { glyph: '智', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  openai: { glyph: 'OA', className: 'bg-teal-500/15 text-teal-700 dark:text-teal-300' },
  'local-openai': { glyph: '本', className: 'bg-slate-500/15 text-slate-600 dark:text-slate-400' },
  // 语音合成服务商（同一套色块 + 字形）
  volcano: { glyph: '火', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  bailian: { glyph: '百', className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' }
}

export function ProviderIcon({ providerId, size = 'md' }: { providerId: string; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'size-5 rounded-md text-[10px]' : 'size-7 rounded-lg text-xs'
  const style = PROVIDER_STYLES[providerId]

  if (!style) {
    return (
      <span
        title={providerId}
        className={cn('flex shrink-0 items-center justify-center bg-muted text-muted-foreground', box)}
      >
        <Cpu className={size === 'sm' ? 'size-3' : 'size-4'} />
      </span>
    )
  }
  return (
    <span
      title={providerId}
      className={cn('flex shrink-0 items-center justify-center font-medium', box, style.className)}
    >
      {style.glyph}
    </span>
  )
}
