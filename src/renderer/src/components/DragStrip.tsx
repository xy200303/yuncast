import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties

/** 内容区顶部的拖动条，和系统按钮同一行。win32 右侧给最小化/最大化/关闭让位。 */
export function DragStrip() {
  const win32 = window.api.platform === 'win32'
  return <div className={cn('h-10 shrink-0 border-b bg-background', win32 && 'pr-[138px]')} style={drag} />
}
