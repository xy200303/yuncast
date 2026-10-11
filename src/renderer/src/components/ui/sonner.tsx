"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useAppStore } from "../../stores/useAppStore"

/** 全局 toast。主题跟随应用外观（本项目主题不走 next-themes，走 useAppStore + applyAppearance）。 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppStore((s) => s.resolvedApp)

  return (
    <Sonner
      theme={theme}
      // 顶部居中：弹窗（Dialog）打开时右下角的提示会被遮住，顶部不会被覆盖
      position="top-center"
      offset={16}
      // 抬到 Dialog（z-50）之上，保证任何弹窗下都可见
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          zIndex: 10000,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
