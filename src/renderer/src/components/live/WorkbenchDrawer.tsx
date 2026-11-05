import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { AutoResponsePicker } from './AutoResponsePicker'
import { PreparedPanel } from './PreparedPanel'
import type { Program, SessionConfig } from '../../../../shared/types'
import type { DrawerTab } from './WorkbenchTopBar'

/**
 * 工作台抽屉（docs/12 §7）：剧本大纲、章节点播、互动设置收在这里，
 * 平时不占版面；顶栏「⋯」按需拉开。评论/事件是主区常驻标签，不进抽屉。
 */
export function WorkbenchDrawer({
  open,
  tab,
  onTab,
  onClose,
  program,
  session,
  prepared,
  onSessionSaved
}: {
  open: boolean
  tab: DrawerTab
  onTab: (tab: DrawerTab) => void
  onClose: () => void
  program: Program | null
  session: SessionConfig | null
  prepared: boolean
  onSessionSaved: (session: SessionConfig) => void
}) {
  /** 互动开关不依赖播放状态：没有本场配置就现建一条空卡司的，打开这一页立刻可调 */
  const ensuring = useRef(false)
  const [ensureFailed, setEnsureFailed] = useState(false)
  useEffect(() => {
    if (!open || tab !== 'interaction' || !program || session) return
    if (ensuring.current) return
    ensuring.current = true
    setEnsureFailed(false)
    void window.api.sessionConfig
      .ensure(program.id)
      .then((next) => {
        if (next) onSessionSaved(next)
        else setEnsureFailed(true)
      })
      .catch(() => setEnsureFailed(true))
      .finally(() => {
        ensuring.current = false
      })
  }, [open, tab, program, session, onSessionSaved])

  if (!open) return null
  const scenes = program?.plan.scenes ?? []
  const current = program?.currentSceneIdx ?? 0

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/10" onClick={onClose} />
      <aside className="absolute top-0 right-0 flex h-full w-[440px] max-w-[92vw] flex-col border-l bg-background shadow-2xl">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="text-[13px] font-medium">本场资料</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} title="收起">
            <X />
          </Button>
        </div>

        <Tabs value={tab} onValueChange={(value) => onTab(value as DrawerTab)} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 border-b px-3 pt-2">
            <TabsList variant="line">
              <TabsTrigger value="scenes" className="px-2 text-xs">
                场次
              </TabsTrigger>
              {prepared && (
                <TabsTrigger value="chapters" className="px-2 text-xs">
                  章节
                </TabsTrigger>
              )}
              <TabsTrigger value="interaction" className="px-2 text-xs">
                自动响应
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="scenes" className="min-h-0 overflow-y-auto p-4">
            {!program ? (
              <p className="text-xs text-muted-foreground">还没打开项目</p>
            ) : scenes.length === 0 ? (
              <p className="text-xs text-muted-foreground">这个项目还没有场次；让导演把场次搭出来。</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {scenes.map((scene, index) => (
                  <li
                    key={scene.id}
                    className={cn(
                      'rounded-lg border px-3 py-2',
                      index === current && 'border-primary/40 bg-primary/5'
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{scene.title}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{scene.estDurationMin} 分钟</span>
                    </div>
                    <p className="mt-1 text-[12px] text-muted-foreground">{scene.goal || '（没写目标）'}</p>
                    {scene.keyPoints && (
                      <p className="mt-1 text-[11px] text-muted-foreground/80">
                        要点：{scene.keyPoints.replace(/\n/g, '；')}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="chapters" className="min-h-0 data-[state=active]:flex data-[state=active]:flex-col">
            {program && <PreparedPanel program={program} />}
          </TabsContent>

          <TabsContent value="interaction" className="min-h-0 overflow-y-auto p-4">
            <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
              这里是<span className="text-foreground">设置</span>：决定哪些直播间动态派给主播。实际收到的评论/礼物/系统通知在主区「事件流」里看。
            </p>
            {!program ? (
              <p className="text-xs text-muted-foreground">先打开一个项目，再配置自动响应。</p>
            ) : session ? (
              <AutoResponsePicker programId={program.id} session={session} onSaved={onSessionSaved} />
            ) : ensureFailed ? (
              <p className="text-xs text-muted-foreground">没能准备本场开关：重开这一页再试。</p>
            ) : (
              <p className="text-xs text-muted-foreground">正在准备本场开关…</p>
            )}
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  )
}
