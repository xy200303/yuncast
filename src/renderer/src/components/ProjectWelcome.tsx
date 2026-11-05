import { FolderOpen } from 'lucide-react'
import { useProjectStore } from '@/stores/useProjectStore'

/** 没有打开项目时的主区：项目从左侧新建或选择（项目列表本身就是导航） */
export function ProjectWelcome() {
  const projects = useProjectStore((s) => s.projects)

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <FolderOpen className="mx-auto mb-4 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{projects.length > 0 ? '选择一个项目' : '还没有项目'}</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          {projects.length > 0
            ? '从顶部「项目」菜单打开，或点左上角的项目块；切换项目等于切换上下文。'
            : '从顶部「项目 → 新建项目」开始。一个项目就是一个目录，场次、稿子、对话、音频都在里面。'}
        </p>
      </div>
    </div>
  )
}
