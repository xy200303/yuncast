import { cn } from '@/lib/utils'
import { ttsModelBadges } from '../lib/modelBadges'
import type { TtsModelSpec } from '../../../shared/types'

/**
 * 能力图标行（选择器/主播卡/列表行共用）：**只画图标不写文字**，含义放 tooltip——
 * 图标与颜色来自 `lib/modelBadges`（设置页模型列表也用同一份），一处定义处处一致。
 * 没有能力位就不渲染（普通单人合成没什么可标的）。
 */
export function ModelBadgeIcons({
  spec,
  className,
  max = 4
}: {
  spec: TtsModelSpec | undefined
  className?: string
  /** 最多画几个（超出折叠成 +N，title 里列全） */
  max?: number
}) {
  const badges = spec ? ttsModelBadges(spec) : []
  if (badges.length === 0) return null
  const shown = badges.slice(0, max)
  const rest = badges.slice(max)
  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {shown.map((badge) => (
        <span key={badge.label} title={badge.title} className="flex">
          <badge.icon className={cn('size-3.5 shrink-0', badge.className)} />
        </span>
      ))}
      {rest.length > 0 && (
        <span className="text-[10px] text-muted-foreground" title={rest.map((b) => `${b.label}：${b.title}`).join('\n')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}
