import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ScriptScene } from '../../../../shared/types'

/** 草稿场景的本地 id：新加的行还没有库里的 id，拿它当 key；提交时清回空串由后端生成 */
const DRAFT_PREFIX = 'draft-scene-'
let seq = 0
const blankScene = (title: string): ScriptScene => ({
  id: `${DRAFT_PREFIX}${(seq += 1)}`,
  title,
  goal: '',
  keyPoints: '',
  estDurationMin: 5
})

/**
 * 节目编排（场景序列）编辑弹窗。
 * 编排是节目的内部结构，不再是独立"剧本"资产：没有名字/主题要填，也不会在别处多出一本。
 */
export function ProgramScenesDialog({
  programId,
  programName,
  open,
  onOpenChange,
  onSaved
}: {
  programId: string
  programName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [scenes, setScenes] = useState<ScriptScene[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.program.scenes(programId)
      setScenes(list.length > 0 ? list : [blankScene('开场')])
    } finally {
      setLoading(false)
    }
  }, [programId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  const patch = (index: number, part: Partial<ScriptScene>) =>
    setScenes((prev) => prev.map((scene, i) => (i === index ? { ...scene, ...part } : scene)))
  const move = (index: number, dir: -1 | 1) =>
    setScenes((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const submit = async () => {
    const cleaned = scenes
      .filter((scene) => scene.title.trim())
      .map((scene) => ({ ...scene, title: scene.title.trim(), id: scene.id.startsWith(DRAFT_PREFIX) ? '' : scene.id }))
    setBusy(true)
    try {
      const result = await window.api.program.saveScenes(programId, cleaned as ScriptScene[])
      if (!result.ok) {
        toast.error('保存编排失败', { description: result.error })
        return
      }
      toast.success(`编排已保存（${cleaned.length} 场）`)
      onSaved()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{programName} · 编排</DialogTitle>
          <DialogDescription>
            编排是节目的场景序列（开场→痛点→讲解→互动→催单→收尾）：开播后主播按场推进，底稿按场归属。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-auto pr-1">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">读取编排…</p>
          ) : (
            scenes.map((scene, i) => (
              <div key={scene.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                  <Input
                    value={scene.title}
                    placeholder="场景名（开场/痛点/讲解/互动/催单/收尾…）"
                    onChange={(e) => patch(i, { title: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="上移"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="下移"
                    disabled={i === scenes.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="删除这一场"
                    disabled={scenes.length === 1}
                    onClick={() => setScenes((prev) => prev.filter((_, index) => index !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Label className="text-xs text-muted-foreground">这场要达成什么</Label>
                <Input
                  value={scene.goal}
                  placeholder="例：把观众放进早上灌水的日常"
                  onChange={(e) => patch(i, { goal: e.target.value })}
                />
                <Label className="text-xs text-muted-foreground">必讲要点（一行一条）</Label>
                <Textarea
                  value={scene.keyPoints}
                  rows={2}
                  placeholder="316 内胆 / 12 小时保温 / 一键弹盖"
                  onChange={(e) => patch(i, { keyPoints: e.target.value })}
                />
              </div>
            ))
          )}
        </div>
        <DialogFooter className="justify-between gap-2 sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => setScenes((prev) => [...prev, blankScene('')])}>
            <Plus />
            加一场
          </Button>
          <Button disabled={busy || loading} onClick={submit}>
            保存编排
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
