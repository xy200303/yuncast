import type { CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AppEditAction, AppViewAction } from '../../../shared/types'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * 顶部菜单栏（自绘，窗口是无边框的）：项目 / 编辑 / 视图 / 帮助。
 * 「项目」管新建与打开；编辑/视图走主进程的 webContents 动作；右侧留给窗口拖动和系统按钮。
 */
export function MenuBar({
  onCreateProject,
  onOpenProject,
  onOpenFolder,
  onExportProject,
  onImportProject,
  onAbout
}: {
  onCreateProject: () => void
  onOpenProject: () => void
  onOpenFolder: () => void
  onExportProject: () => void
  onImportProject: () => void
  onAbout: () => void
}) {
  const win32 = window.api.platform === 'win32'

  return (
    <div
      className={cn('flex h-9 shrink-0 items-center gap-0.5 border-b bg-background px-1', win32 && 'pr-[138px]')}
      style={drag}
    >
      <Menu label="项目" style={noDrag}>
        <DropdownMenuItem onSelect={onCreateProject}>新建项目…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenProject}>打开项目…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenFolder}>打开已存在项目…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onExportProject}>导出项目…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onImportProject}>导入项目…</DropdownMenuItem>
      </Menu>
      <Menu label="编辑" style={noDrag}>
        {(
          [
            ['undo', '撤销'],
            ['redo', '重做'],
            ['cut', '剪切'],
            ['copy', '复制'],
            ['paste', '粘贴'],
            ['selectAll', '全选']
          ] as [AppEditAction, string][]
        ).map(([action, label]) => (
          <DropdownMenuItem key={action} onSelect={() => window.api.app.edit(action)}>
            {label}
          </DropdownMenuItem>
        ))}
      </Menu>
      <Menu label="视图" style={noDrag}>
        {(
          [
            ['reload', '重新加载'],
            ['zoom-in', '放大'],
            ['zoom-out', '缩小'],
            ['zoom-reset', '实际大小'],
            ['fullscreen', '全屏'],
            ['devtools', '开发者工具']
          ] as [AppViewAction, string][]
        ).map(([action, label]) => (
          <DropdownMenuItem key={action} onSelect={() => window.api.app.view(action)}>
            {label}
          </DropdownMenuItem>
        ))}
      </Menu>
      <Menu label="帮助" style={noDrag}>
        <DropdownMenuItem onSelect={onAbout}>关于</DropdownMenuItem>
      </Menu>
    </div>
  )
}

function Menu({
  label,
  children,
  style
}: {
  label: string
  children: React.ReactNode
  style?: CSSProperties
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          style={style}
          className="flex h-7 items-center gap-1 rounded px-2 text-[12px] text-foreground/80 outline-none hover:bg-muted data-[state=open]:bg-muted"
        >
          {label}
          <ChevronDown className="size-3 opacity-40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
