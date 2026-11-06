import { useEffect, useState } from 'react'
import { FolderOpen, FolderSearch, List, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { slashPath } from '@/lib/utils'
import { useProjectStore } from '@/stores/useProjectStore'

/**
 * 没有打开项目时的主区：像 VS Code 欢迎页一样，直接给出「开始」和「最近」。
 * 项目列表本身就是导航——点最近的一条直接进入，不用先开菜单再找。
 */
export function ProjectWelcome({
  onCreate,
  onOpenList,
  onOpenFolder
}: {
  onCreate: () => void
  onOpenList: () => void
  onOpenFolder: () => void
}) {
  const projects = useProjectStore((s) => s.projects)
  const openProject = useProjectStore((s) => s.open)
  const [busy, setBusy] = useState('')

  // 欢迎页出现时重拉一次清单：启动后还没打开过项目，store 里可能是空的
  useEffect(() => {
    void useProjectStore.getState().refresh()
  }, [])


  const enter = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      await openProject(id)
    } catch (error) {
      toast.error('打开项目失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const recent = projects.slice(0, 6)

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-[26px] font-semibold tracking-tight">小云播客坊</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">
          一个项目就是一个目录：场次、稿子、对话、音频都在里面，整个目录拷走就是完整备份。
        </p>

        <p className="mt-7 text-[13px] font-medium">开始</p>
        <div className="mt-2 flex flex-col gap-0.5">
          <Entry icon={<Plus />} label="新建项目…" onClick={onCreate} />
          <Entry icon={<FolderOpen />} label="打开项目…" onClick={onOpenList} />
          <Entry icon={<FolderSearch />} label="打开文件夹…" onClick={onOpenFolder} />
        </div>

        <p className="mt-7 text-[13px] font-medium">最近</p>
        <div className="mt-2 flex flex-col gap-0.5">
          {recent.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
              还没有打开过项目。从一个新项目开始，或者打开已有目录。
            </p>
          ) : (
            recent.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={busy !== ''}
                onClick={() => void enter(project.id)}
                className="group flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 disabled:opacity-60"
                title={project.path}
              >
                <span className="shrink-0 text-[13px] font-medium group-hover:text-primary">{project.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                  {slashPath(project.path)}
                </span>
                {busy === project.id && <span className="shrink-0 text-[11px] text-muted-foreground">打开中…</span>}
              </button>
            ))
          )}
          {projects.length > recent.length && (
            <Entry icon={<List />} label="更多…" onClick={onOpenList} compact />
          )}
        </div>
      </div>
    </div>
  )
}

function Entry({
  icon,
  label,
  onClick,
  compact = false
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        compact
          ? 'flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:text-foreground'
          : 'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60'
      }
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      {label}
    </button>
  )
}
