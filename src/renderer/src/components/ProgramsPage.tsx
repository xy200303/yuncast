import { useCallback, useEffect, useState } from 'react'
import {
  AudioWaveform,
  BookOpenText,
  Check,
  Clapperboard,
  Download,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '../stores/useAppStore'
import {
  BROADCAST_MODE_LABELS,
  CONTENT_TYPE_LABELS,
  type KnowledgeFile,
  type LaunchResult,
  type Product,
  type Program,
  type ProgramAudioProgress,
  type ProgramGateResult,
  type Script
} from '../../../shared/types'
import { ProgramDialog } from './programs/ProgramDialog'
import { UtteranceDialog } from './programs/UtteranceDialog'
import { ProgramGateDialog } from './ProgramGateDialog'
import { ExportDialog } from './ExportDialog'
import { AUDIO_UNIT_LABEL } from '../lib/audioUnits'
import { resumeBroadcast } from '../audio/liveControl'

/** 节目库：一场直播/一期播客/一本有声书都是一个节目（内容 + 播出方式 + 事件规则 + 知识范围）。谁播由当前主播定；预制节目音频全部就绪后卡片上可直接播放（门禁不过进弹窗，不静默跳过）。 */
export function ProgramsPage() {
  const config = useAppStore((s) => s.config)
  const loadConfig = useAppStore((s) => s.loadConfig)
  const [programs, setPrograms] = useState<Program[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  /** 每个节目的底稿统计（卡片上显示） */
  const [utteranceStats, setUtteranceStats] = useState<Record<string, { total: number; ready: number }>>({})
  /** 预制节目的音频进度（卡片摘要与主操作判定用） */
  const [audioStats, setAudioStats] = useState<Record<string, ProgramAudioProgress>>({})
  const [producingId, setProducingId] = useState('')
  /** 播放预制节目时门禁未过：结构化缺口进弹窗（docs/10 §7.8） */
  const [gateState, setGateState] = useState<{ program: Program; gate: ProgramGateResult } | null>(null)
  const [editing, setEditing] = useState<{ program?: Program } | null>(null)
  const [deleting, setDeleting] = useState<Program | null>(null)
  const [reviewing, setReviewing] = useState<Program | null>(null)
  /** 导出弹窗（docs/10 §8.3/§11.6，P6） */
  const [exporting, setExporting] = useState<Program | null>(null)

  const activeProgramId = config.live.activeProgramId

  const reload = useCallback(async () => {
    const [p, s, pr, f] = await Promise.all([
      window.api.program.list(),
      window.api.script.list(),
      window.api.knowledge.listProducts(),
      window.api.knowledge.listFiles()
    ])
    setPrograms(p)
    setScripts(s)
    setProducts(pr)
    setFiles(f)
    const stats: Record<string, { total: number; ready: number }> = {}
    const audio: Record<string, ProgramAudioProgress> = {}
    for (const program of p) {
      const list = await window.api.utterance.list(program.id)
      stats[program.id] = { total: list.length, ready: list.filter((u) => u.status === 'ready').length }
      if (program.broadcastMode === 'prepared') {
        audio[program.id] = await window.api.program.audioProgress(program.id)
      }
    }
    setUtteranceStats(stats)
    setAudioStats(audio)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 预制音频资产变化：刷新对应节目的音频摘要（合成进度实时反映到卡片上）
  useEffect(() => {
    return window.api.program.onAudioEvent((payload) => {
      void window.api.program.audioProgress(payload.programId).then((progress) => {
        setAudioStats((prev) => ({ ...prev, [payload.programId]: progress }))
      })
    })
  }, [])

  const setActive = (id: string) => {
    void window.api.program.setActive(id === activeProgramId ? '' : id).then(async () => {
      await loadConfig() // 主进程写的 config，拉回来同步渲染端缓存
      await reload()
      toast.success(id === activeProgramId ? '已取消当前节目' : '已设为当前节目', {
        description: id === activeProgramId ? undefined : '下次开播按这个节目就位'
      })
    })
  }

  const scriptName = (id: string | null) => scripts.find((s) => s.id === id)?.title ?? null

  /** 开播成功的统一提示（直播台启动与门禁弹窗里的「仅播放已完成部分」共用口径） */
  const announceLaunched = (program: Program, result: LaunchResult): void => {
    resumeBroadcast() // 新一场从「播报中」开始（上一场可能是暂停状态停掉的）
    if (result.warning) {
      toast.warning(`节目已启动：${program.name}（智能层未就位）`, { description: result.warning })
    } else {
      toast.success(`节目已启动：${program.name}`, {
        description: result.loaded ? `已装载 ${result.loaded} 个播出单元，到「播控台」看播出` : undefined
      })
    }
    useAppStore.getState().setPage('live')
  }

  /** 预制节目主操作「继续合成」：统一生产入口只重做未完成/失败/过期单元，进度走 onAudioEvent */
  const produceAudio = async (program: Program): Promise<void> => {
    if (producingId) return
    setProducingId(program.id)
    try {
      const result = await window.api.program.produceAudio(program.id)
      if (!result.ok) {
        toast.error('生成节目音频没能完成', { description: result.error })
      } else if (result.failed > 0) {
        toast.warning(`生成完成，还有 ${result.failed} 个失败`, {
          description: `完成 ${result.done} · 跳过 ${result.skipped} · 失败 ${result.failed}，打开底稿库可逐项重试`
        })
      } else {
        toast.success('节目音频已全部生成', {
          description: `完成 ${result.done} · 跳过 ${result.skipped}` + (result.notice ? `；${result.notice}` : '')
        })
      }
    } finally {
      setProducingId('')
      await reload()
    }
  }

  /** 预制节目主操作「播放」：先设为当前节目再启动；门禁未过进弹窗，绝不静默跳过 */
  const playProgram = async (program: Program): Promise<void> => {
    if (program.id !== activeProgramId) {
      await window.api.program.setActive(program.id)
      await loadConfig()
    }
    const result = await window.api.program.launch(program.id)
    if (result.ok) {
      announceLaunched(program, result)
    } else if (result.gate) {
      setGateState({ program, gate: result.gate })
    } else {
      toast.error('启动失败', { description: result.error })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Clapperboard className="size-4 text-primary" />
        <h1 className="text-sm font-medium">节目</h1>
        <p className="text-xs text-muted-foreground">一场直播、一期播客、一本有声书都是一个节目：内容 + 播出方式 + 事件规则 + 知识范围（谁播由当前主播定）</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus />
            新建节目
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {programs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Clapperboard className="size-10" strokeWidth={1.25} />
            <p className="text-sm">还没有节目。建一个节目，把这次要播的内容、剧本、底稿都装进去</p>
          </div>
        ) : (
          <div className="grid max-w-4xl grid-cols-2 gap-3">
            {programs.map((program) => {
              const active = program.id === activeProgramId
              const stats = utteranceStats[program.id]
              const audio = audioStats[program.id]
              const prepared = program.broadcastMode === 'prepared'
              const improvised = program.broadcastMode === 'improvised'
              const unitLabel = AUDIO_UNIT_LABEL[program.contentType]
              return (
                <Card key={program.id} className={active ? 'border-primary/50' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="min-w-0 truncate text-sm">{program.name}</CardTitle>
                      {active && <Badge>当前节目</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                      {program.theme || '（没写主题）'}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="secondary">{CONTENT_TYPE_LABELS[program.contentType]}</Badge>
                      <Badge variant="outline">{BROADCAST_MODE_LABELS[program.broadcastMode]}</Badge>
                      {scriptName(program.scriptId) ? (
                        <Badge variant="secondary">{scriptName(program.scriptId)}</Badge>
                      ) : (
                        <Badge variant="outline">未绑剧本</Badge>
                      )}
                    </div>
                    {prepared ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <AudioWaveform className="size-3.5" />
                        {audio && audio.total > 0 ? (
                          <span>
                            音频 {audio.ready}/{audio.total} {unitLabel}
                            {audio.failed > 0 && ` · 失败 ${audio.failed}`}
                            {audio.stale > 0 && ` · 文稿已修改 ${audio.stale}`}
                            {audio.synthesizing > 0 && ` · 合成中 ${audio.synthesizing}`}
                          </span>
                        ) : (
                          <span>还没有文稿（点「底稿库」生成）</span>
                        )}
                      </div>
                    ) : improvised ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <BookOpenText className="size-3.5" />
                        <span>现场发挥：无底稿，主播临场说</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <BookOpenText className="size-3.5" />
                        {stats && stats.total > 0 ? (
                          <span>
                            底稿 {stats.total} 段 · 音频就绪 {stats.ready}
                          </span>
                        ) : (
                          <span>底稿为空（点「底稿库」生成）</span>
                        )}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      {prepared && audio && audio.total === 0 && (
                        <Button size="sm" onClick={() => setReviewing(program)}>
                          <BookOpenText />
                          继续写稿
                        </Button>
                      )}
                      {prepared && audio && audio.total > 0 && audio.ready < audio.total && (
                        <Button
                          size="sm"
                          disabled={producingId !== ''}
                          onClick={() => void produceAudio(program)}
                        >
                          {producingId === program.id ? <Loader2 className="animate-spin" /> : <AudioWaveform />}
                          {producingId === program.id ? '正在生成…' : '继续合成'}
                        </Button>
                      )}
                      {prepared && audio && audio.total > 0 && audio.ready === audio.total && (
                        <Button size="sm" onClick={() => void playProgram(program)}>
                          <Play />
                          播放
                        </Button>
                      )}
                      <Button
                        variant={active ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setActive(program.id)}
                      >
                        <Check />
                        {active ? '取消当前' : '设为当前'}
                      </Button>
                      {!improvised && (
                        <Button variant="outline" size="sm" onClick={() => setReviewing(program)}>
                          <BookOpenText />
                          底稿库
                        </Button>
                      )}
                      <Button variant="ghost" size="icon-sm" title="配置" onClick={() => setEditing({ program })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="导出节目音频" onClick={() => setExporting(program)}>
                        <Download />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(program)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <ProgramDialog
        key={editing?.program?.id ?? 'new'}
        open={editing !== null}
        program={editing?.program}
        scripts={scripts}
        products={products}
        files={files}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      {reviewing && (
        <UtteranceDialog
          program={reviewing}
          script={scripts.find((s) => s.id === reviewing.scriptId) ?? null}
          open
          onOpenChange={(open) => {
            if (!open) setReviewing(null)
          }}
          onChanged={reload}
        />
      )}
      {/* 预制节目门禁未过：继续生成 / 重试失败项 / 仅播放已完成部分（docs/10 §7.8） */}
      {gateState && (
        <ProgramGateDialog
          program={gateState.program}
          gate={gateState.gate}
          open
          onOpenChange={(open) => {
            if (!open) setGateState(null)
          }}
          onGateChange={(gate) => setGateState((prev) => (prev ? { ...prev, gate } : prev))}
          onLaunched={(result) => {
            announceLaunched(gateState.program, result)
            void reload()
          }}
        />
      )}
      {/* 导出弹窗（docs/10 §8.3/§11.6，P6）：缺章明确提示，不静默跳过 */}
      {exporting && (
        <ExportDialog
          program={exporting}
          open
          onOpenChange={(open) => {
            if (!open) setExporting(null)
          }}
        />
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除节目</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？它的底稿库会一起删掉，绑定的剧本不受影响。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                void window.api.program.remove(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await loadConfig() // 删的可能是当前节目，拉一次同步
                    await reload()
                  } else toast.error('删除失败', { description: result.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
