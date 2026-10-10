import type { LucideIcon } from 'lucide-react'

/** 页面占位：页面名 + 一句话描述 + 居中空态。后续里程碑把内容填进来。 */
export function PagePlaceholder(props: { icon: LucideIcon; title: string; description: string; empty: string }) {
  const Icon = props.icon
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Icon className="size-4 text-primary" />
        <h1 className="text-sm font-medium">{props.title}</h1>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Icon className="size-10" strokeWidth={1.25} />
        <p className="text-sm">{props.empty}</p>
      </div>
    </div>
  )
}
