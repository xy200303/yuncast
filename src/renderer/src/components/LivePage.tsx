import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, Megaphone, MessageSquareText, OctagonAlert, Pause, Play, Radio, RadioTower, SlidersHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import { playbackLoop } from '../audio/playbackLoop'
import type { LiveComment, SpeechItem, SpeechLane, SpeechSourceKind, SpeechStatus } from '../../../shared/types'

const LANE_LABEL: Record<SpeechLane, string> = {
  interrupt: '打断',
  next: '下一条',
  normal: '常规',
  filler: '垫底'
}

const LANE_BADGE_VARIANT: Record<SpeechLane, 'destructive' | 'default' | 'secondary' | 'outline'> = {
  interrupt: 'destructive',
  next: 'default',
  normal: 'secondary',
  filler: 'outline'
}

const STATUS_LABEL: Record<SpeechStatus, string> = {
  pending: '待合成',
  synthesizing: '合成中',
  ready: '就绪',
  playing: '播报中',
  done: '已播',
  interrupted: '被打断',
  skipped: '已撤销',
  failed: '失败',
  expired: '已过期'
}

const SOURCE_LABEL: Record<SpeechSourceKind, string> = {
  scene: '剧情',
  reply: '回复',
  interact: '互动',
  announce: '公告',
  filler: '暖场',
  manual: '手动',
  reaction: '捧场'
}

/** 把话术按标点切成句子（提词器句级高亮用） */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?；;…\n])/).filter((s) => s.trim().length > 0)
  return parts.length > 0 ? parts : [text]
}

export function LivePage() {
  const pool = useAppStore((s) => s.pool)
  const levels = useAppStore((s) => s.levels)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const setLoopRunning = useAppStore((s) => s.setLoopRunning)

  const playing = pool.items.find((item) => item.status === 'playing') ?? null
  const queued = pool.items.filter((item) => item.status !== 'playing')

  // 按话轮分组（同 lane + turnId 的连续条目一组，原子播出不拆开）
  const groups = useMemo(() => {
    const out: { key: string; items: SpeechItem[] }[] = []
    for (const item of pool.items) {
      const key = `${item.lane}:${item.turnId}`
      const last = out[out.length - 1]
      if (last && last.key === key) last.items.push(item)
      else out.push({ key, items: [item] })
    }
    return out
  }, [pool.items])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Radio className="size-4 text-primary" />
        <h1 className="text-sm font-medium">直播台</h1>
        <p className="text-xs text-muted-foreground">话术池 · 提词器</p>
        <div className="ml-auto flex items-center gap-3">
          {/* 主输出电平 */}
          <div className="flex items-center gap-1.5" title="输出电平">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-150"
                style={{ width: `${Math.round(levels.master * 100)}%` }}
              />
            </div>
          </div>
          <Button
            variant={loopRunning ? 'secondary' : 'default'}
            size="sm"
            onClick={() => {
              if (loopRunning) {
                playbackLoop.stop()
                setLoopRunning(false)
                toast.message('播报已暂停', { description: '池里的内容保留，恢复后继续播' })
              } else {
                playbackLoop.start()
                setLoopRunning(true)
              }
            }}
          >
            {loopRunning ? <Pause /> : <Play />}
            {loopRunning ? '暂停播报' : '恢复播报'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：上评论流，下话术池队列 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <CommentFeed />
          <div className="flex h-8 shrink-0 items-center border-y px-4 text-xs text-muted-foreground">
            话术池队列 · {pool.items.length} 条
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {groups.length === 0 && pool.failed.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Radio className="size-10" strokeWidth={1.25} />
                <p className="text-sm">话术池是空的，从右侧操作面板发起人工播报</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {groups.map((group) => (
                  <TurnGroup key={group.key} group={group.items} />
                ))}
                {pool.failed.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    <p className="px-1 text-xs text-muted-foreground">合成失败（5 分钟内）</p>
                    {pool.failed.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
                      >
                        <Badge variant="destructive">失败</Badge>
                        <span className="min-w-0 flex-1 truncate text-[13px]">{item.text}</span>
                        <span className="shrink-0 text-xs text-muted-foreground" title={item.error}>
                          {item.error}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 右侧面板：提词器 + 操作面板 */}
        <aside className="flex w-80 shrink-0 flex-col border-l">
          <div className="flex h-8 shrink-0 items-center border-b px-4 text-xs text-muted-foreground">提词器</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <SceneLine />
            <AgentDraft />
            {playing ? (
              <TeleprompterCurrent item={playing} />
            ) : (
              <p className="text-sm text-muted-foreground">当前没有在播的话术</p>
            )}
            <p className="mt-5 mb-2 text-xs text-muted-foreground">接下来要播</p>
            {queued.length === 0 ? (
              <p className="text-xs text-muted-foreground">队列空了</p>
            ) : (
              <div className="flex flex-col gap-2">
                {queued.slice(0, 3).map((item) => (
                  <div key={item.id} className="rounded-lg border bg-card px-3 py-2">
                    <div className="mb-1 flex items-center gap-1.5">
                      <Badge variant={LANE_BADGE_VARIANT[item.lane]}>{LANE_LABEL[item.lane]}</Badge>
                      <Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>
                    </div>
                    <p className="line-clamp-2 text-[13px] text-muted-foreground">{item.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <ControlPanel />
        </aside>
      </div>
    </div>
  )
}

/** 评论流：实时滚动，最新在下，自动滚到底，保持最近 100 条 */
function CommentFeed() {
  const [comments, setComments] = useState<LiveComment[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!('api' in window)) return
    return window.api.comment.onComment((comment) => {
      setComments((prev) => [...prev.slice(-99), comment])
    })
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments])

  return (
    <div className="flex h-[40%] shrink-0 flex-col">
      <div className="flex h-8 shrink-0 items-center px-4 text-xs text-muted-foreground">
        评论流 · {comments.length} 条
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {comments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <MessageSquareText className="size-8" strokeWidth={1.25} />
            <p className="text-sm">还没有评论，开「模拟评论」试试</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {comments.map((comment) => (
              <div key={comment.id} className="flex items-baseline gap-2 text-[13px]">
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(comment.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="shrink-0 font-medium text-primary">{comment.author}</span>
                <span className="min-w-0">{comment.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 一个话轮（同 turnId 的连续条目）在队列里的样子 */
function TurnGroup({ group }: { group: SpeechItem[] }) {
  const first = group[0]
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
        <Badge variant={LANE_BADGE_VARIANT[first.lane]}>{LANE_LABEL[first.lane]}</Badge>
        <Badge variant="ghost">{SOURCE_LABEL[first.source.kind]}</Badge>
        {first.replyTo && <Badge variant="outline">回复 @{first.replyTo.author}</Badge>}
        {first.voiceId && <Badge variant="outline">{first.voiceId}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">话轮 {first.turnId.slice(-6)}</span>
      </div>
      <div className="flex flex-col">
        {group.map((item) => (
          <PoolRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

function PoolRow({ item }: { item: SpeechItem }) {
  const canRevoke = item.status === 'pending' || item.status === 'synthesizing' || item.status === 'ready'
  return (
    <div className="group/row flex items-center gap-2 px-3 py-2">
      <Badge
        variant={
          item.status === 'playing' ? 'default' : item.status === 'ready' ? 'secondary' : 'outline'
        }
      >
        {STATUS_LABEL[item.status]}
      </Badge>
      {item.status === 'synthesizing' ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : (
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px]',
            item.status === 'playing' && 'text-primary'
          )}
          title={item.text}
        >
          {item.text}
        </span>
      )}
      {canRevoke && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="opacity-0 group-hover/row:opacity-100"
          title="撤销这条"
          onClick={() => {
            void window.api.pool.revoke(item.id).then((result) => {
              if (result.ok) toast.success('已撤销')
              else toast.error('撤销失败', { description: result.error })
            })
          }}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

/** 提词器当前播报：句级高亮（按播放进度推进，简化版） */
function TeleprompterCurrent({ item }: { item: SpeechItem }) {
  const sentences = useMemo(() => splitSentences(item.text), [item.text])
  const [active, setActive] = useState(0)

  useEffect(() => {
    setActive(0)
    const timer = setInterval(() => {
      const progress = audioEngine.getTtsProgress()
      if (progress !== null) {
        setActive(Math.min(sentences.length - 1, Math.floor(progress * sentences.length)))
      }
    }, 200)
    return () => clearInterval(timer)
  }, [item.id, sentences.length])

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Badge>播报中</Badge>
        {item.voiceId && <Badge variant="outline">{item.voiceId}</Badge>}
      </div>
      <p className="text-sm leading-6">
        {sentences.map((sentence, index) => (
          <Fragment key={index}>
            <span className={index === active ? 'text-primary font-medium' : index < active ? 'text-muted-foreground' : ''}>
              {sentence}
            </span>
          </Fragment>
        ))}
      </p>
    </div>
  )
}

/** 当前场景小字（主播状态广播带来），无剧本不显示 */
function SceneLine() {
  const scene = useAppStore((s) => s.agent.scene)
  if (!scene) return null
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      当前场景：<span className="text-foreground">{scene.title}</span>（第 {scene.index + 1}/{scene.total} 场）
    </p>
  )
}

/** AI 正在组织语言：text_delta 实时预览（品牌色），入池即消失 */function AgentDraft() {
  const draft = useAppStore((s) => s.agent.draft)
  if (!draft) return null
  return (
    <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Badge variant="outline" className="text-primary border-primary/40">
          AI 正在组织语言…
        </Badge>
      </div>
      <p className="text-sm leading-6 text-primary">{draft}</p>
    </div>
  )
}

/** 右侧操作面板：人工控制入口。后续场控/场景/音量等能力都往这里加按钮。 */
function ControlPanel() {
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [panicOpen, setPanicOpen] = useState(false)
  const simRunning = useAppStore((s) => s.simRunning)
  const setSimRunning = useAppStore((s) => s.setSimRunning)
  const agentState = useAppStore((s) => s.agent.state)

  const toggleSim = () => {
    void (simRunning ? window.api.sim.stop() : window.api.sim.start()).then((status) => {
      setSimRunning(status.running)
      toast.message(status.running ? '模拟评论已开启' : '模拟评论已关闭', {
        description: status.running ? '每 3-8 秒来一条观众评论' : undefined
      })
    })
  }

  const panic = () => {
    setPanicOpen(false)
    void (async () => {
      // 急停链：停主播 → 清全部车道 → 停当前播放（播放循环会把 playing 条目收掉）
      await window.api.agent.stop()
      for (const lane of ['interrupt', 'next', 'normal', 'filler'] as const) {
        await window.api.pool.clearLane(lane)
      }
      audioEngine.stopCurrentTts()
      toast.success('已紧急停止', { description: '主播已停，话术池已清空' })
    })()
  }

  return (
    <div className="shrink-0 border-t p-3">
      <p className="mb-2 px-1 text-xs text-muted-foreground">操作面板</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => setBroadcastOpen(true)}>
          <Megaphone />
          人工播报
        </Button>
        <Button
          variant={simRunning ? 'secondary' : 'outline'}
          size="sm"
          onClick={toggleSim}
          title={agentState === 'running' ? undefined : '主播未启动时评论只会进 toast，不会触发回复'}
        >
          <MessageSquareText />
          {simRunning ? '关闭模拟评论' : '模拟评论'}
        </Button>
        <Button variant="outline" size="sm" disabled title="剧本场景上线后可用">
          <Clapperboard />
          切场景
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setPanicOpen(true)}>
          <OctagonAlert />
          紧急停止
        </Button>
        <Button variant="outline" size="sm" disabled title="场控能力上线后可用">
          <RadioTower />
          场控指令
        </Button>
        <Button variant="outline" size="sm" disabled title="音频控制上线后可用">
          <SlidersHorizontal />
          调音量
        </Button>
      </div>
      <ManualBroadcastDialog open={broadcastOpen} onOpenChange={setBroadcastOpen} />
      <Dialog open={panicOpen} onOpenChange={setPanicOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>紧急停止</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            立即停止主播 Agent、清空话术池全部车道、停止当前播报。池里未播的内容都会作废。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPanicOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={panic}>
              确认急停
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 人工播报弹窗：输入内容丢进话术池 */
function ManualBroadcastDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const defaultVoice = useAppStore((s) => s.config.tts.voiceId)
  const [text, setText] = useState('')
  const [lane, setLane] = useState<'normal' | 'next'>('normal')
  const [voice, setVoice] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = () => {
    const content = text.trim()
    if (!content || busy) return
    setBusy(true)
    const input = {
      text: content,
      voiceId: voice.trim() || undefined,
      sourceKind: 'manual' as const
    }
    const call = lane === 'next' ? window.api.pool.insertNext(input) : window.api.pool.say({ ...input, lane })
    void call
      .then((result) => {
        if (result.ok) {
          setText('')
          onOpenChange(false)
          toast.success('已丢进话术池', { description: '合成完成后自动播出' })
        } else {
          toast.error('没能进池', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>人工播报</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：欢迎来到直播间，今天给大家准备了好物……"
            className="min-h-24 resize-none"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <Label className="shrink-0 text-xs text-muted-foreground">车道</Label>
            <ToggleGroup
              type="single"
              value={lane}
              onValueChange={(v) => v && setLane(v as 'normal' | 'next')}
              className="rounded-lg bg-muted p-0.5"
            >
              <ToggleGroupItem value="normal" className="h-6 px-2.5 text-xs" title="排进常规队列">
                排队
              </ToggleGroupItem>
              <ToggleGroupItem value="next" className="h-6 px-2.5 text-xs" title="当前播完就播这条">
                下一条
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="shrink-0 text-xs text-muted-foreground">音色</Label>
            <Input
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              placeholder={defaultVoice ? `留空用默认（${defaultVoice}）` : '留空用默认音色'}
              className="h-7 text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!text.trim() || busy} onClick={submit}>
            丢进池里
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
