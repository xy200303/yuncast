import { useEffect, useState } from 'react'
import { ArrowRight, FolderOpen, FolderSearch, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores/useProjectStore'

/**
 * 没有打开项目时的主区：产品化的启动页——
 * 一个明确的主操作（新建），两个次级入口（打开项目 / 打开文件夹），下面是最近项目的卡片列表。
 * 点最近的一条直接进入，不用先开菜单再找。
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
    <div
      className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-14"
      style={{ background: 'radial-gradient(900px 420px at 50% -8%, var(--muted), transparent 70%)' }}
    >
      <div className="w-full max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <Button className="h-9 gap-1.5 px-4" onClick={onCreate}>
            <Plus />
            新建项目
          </Button>
          <Button variant="outline" className="h-9 gap-1.5 px-4" onClick={onOpenList}>
            <FolderOpen />
            打开项目
          </Button>
          <Button variant="ghost" className="h-9 gap-1.5 px-3 text-muted-foreground" onClick={onOpenFolder}>
            <FolderSearch />
            打开文件夹
          </Button>
        </div>

        <div className="mt-9 flex items-baseline justify-between">
          <p className="text-[13px] font-medium">最近项目</p>
          {projects.length > recent.length && (
            <button
              type="button"
              onClick={onOpenList}
              className="text-[12px] text-muted-foreground hover:text-foreground"
            >
              全部 {projects.length} 个
            </button>
          )}
        </div>

        {recent.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-6 py-9 text-center">
            <p className="text-[12.5px] text-muted-foreground">还没有打开过项目，从「新建项目」开始吧。</p>
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.04)]">
            {recent.map((project, index) => (
              <button
                key={project.id}
                type="button"
                disabled={busy !== ''}
                onClick={() => void enter(project.id)}
                title={project.path}
                className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60 ${
                  index > 0 ? 'border-t' : ''
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{project.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {busy === project.id ? (
                    '打开中…'
                  ) : (
                    <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
