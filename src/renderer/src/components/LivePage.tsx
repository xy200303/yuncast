import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Loader2,
  Megaphone,
  MessageSquareText,
  OctagonAlert,
  Paperclip,
  Pause,
  Play,
  Radio,
  RadioTower,
  RefreshCw,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wrench,
  X,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { MiniMarkdown } from '@/components/MiniMarkdown'
import { VoiceProviderHint } from '@/components/VoiceProviderHint'
import { useAppStore } from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import { pauseBroadcast, resumeBroadcast } from '../audio/liveControl'
import { AssetStaleBanner } from './AssetStaleBanner'
import type {
  DirectorMessage,
  LiveComment,
  LivePlan,
  PreflightItem,
  Script,
  SpeechItem,
  SpeechLane,
  SpeechSourceKind,
  SpeechStatus
} from '../../../shared/types'

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

export function LivePage() {
  const pool = useAppStore((s) => s.pool)
  const levels = useAppStore((s) => s.levels)
  const [leftTab, setLeftTab] = useState<'pool' | 'comments'>('pool')
  const [comments, setComments] = useState<LiveComment[]>([])
  /** 右栏选项卡：对话是主区（铺满高度），操作切过去才显示 */
  const [rightTab, setRightTab] = useState<'chat' | 'control'>('chat')
  /** 对话未读数（切走时有新条目在选项卡上亮红点） */
  const [chatUnread, setChatUnread] = useState(0)

  // 评论订阅提到页面层（标签上要显示条数），保持最近 100 条
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.comment.onComment((comment) => {
      setComments((prev) => [...prev.slice(-99), comment])
    })
  }, [])

  // 主播工具触发的播报控制（pause_broadcast / resume_broadcast / skip_current）
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.playback.onControl((action) => {
      if (action === 'pause') {
        pauseBroadcast()
        toast.message('主播暂停了播报', { description: '池里的内容保留' })
      } else if (action === 'resume') {
        resumeBroadcast()
        toast.message('主播恢复了播报')
      } else {
        audioEngine.stopCurrent()
        toast.message('主播跳过了当前这条')
      }
    })
  }, [])

  // 队列：按话轮分组（同 lane + turnId 一组，原子播出不拆开）。
  // 正在播的那条同样列在这里，用「播报中」标记标出来——不再单独做一块状态显示。
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
    <div className="flex min-h-0 flex-1">
        {/* 左栏 = 队列 / 评论流。「正在播什么」在右栏对话区底部的常驻状态行（一处就够） */}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">            <Radio className="size-4 text-primary" />
            <h1 className="text-sm font-medium">直播台</h1>
            {/* 开播控制贴最右：顶部居中的 toast 不会再盖住「启动/暂停」按钮 */}
            <div className="ml-auto flex items-center gap-3">
              <StreamIndicator />
              {/* 主输出电平 */}
              <div className="flex items-center gap-1.5" title="输出电平">
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150"
                    style={{ width: `${Math.round(levels.master * 100)}%` }}
                  />
                </div>
              </div>
              {/* 唯一开播入口：选场次 → 启动场次（docs/07 §8.5） */}
              <PlanLauncher />
            </div>
          </header>
          {/* 资产改过但本场会话还是旧的：都在这里给「立即应用」 */}
          <AssetStaleBanner />
          <Tabs value={leftTab} onValueChange={(v) => setLeftTab(v as typeof leftTab)} className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 border-b px-4 pt-2">
              <TabsList variant="line">
                <TabsTrigger value="pool" className="px-3 text-xs">
                  话术池队列 · {groups.reduce((n, group) => n + group.items.length, 0)}
                </TabsTrigger>
                <TabsTrigger value="comments" className="px-3 text-xs">
                  评论流 · {comments.length}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="pool" className="min-h-0 overflow-y-auto p-3">
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
            </TabsContent>
            <TabsContent value="comments" className="min-h-0 overflow-y-auto px-4 pb-2">
              <CommentList comments={comments} />
            </TabsContent>
          </Tabs>
        </section>

        {/* 右侧面板：对话（主区，铺满整栏）/ 操作。forceMount 保持挂载——切走不丢消息状态和订阅。
            「正在播什么」在左栏顶部，这里不再重复一遍。 */}
        <aside className="flex w-80 shrink-0 flex-col border-l">
          <Tabs
            value={rightTab}
            onValueChange={(v) => {
              setRightTab(v as typeof rightTab)
              if (v === 'chat') setChatUnread(0)
            }}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="shrink-0 border-b px-3 pt-2">
              <TabsList variant="line">
                <TabsTrigger value="chat" className="px-3 text-xs">
                  对话
                  {chatUnread > 0 && <Badge className="ml-1 h-4 px-1 text-[10px]">{chatUnread}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="control" className="px-3 text-xs">
                  操作
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="chat" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <DirectorConsole active={rightTab === 'chat'} onUnread={() => setChatUnread((n) => n + 1)} />
            </TabsContent>
            <TabsContent value="control" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <ControlPanel onOpenChat={() => setRightTab('chat')} />
            </TabsContent>
          </Tabs>
        </aside>
    </div>
  )
}

/**
 * 场次入口：选场次 + 启动/停止场次（唯一开播入口）。
 * 点「启动场次」先跑预检（docs/07 §8.5）：阻断项红、警告项黄，有阻断项不许开。
 */
function PlanLauncher() {
  const agent = useAppStore((s) => s.agent)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const activePlanId = useAppStore((s) => s.config.live.activePlanId)
  const [plans, setPlans] = useState<LivePlan[]>([])
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<PreflightItem[] | null>(null)

  useEffect(() => {
    void window.api.plan.list().then(setPlans)
  }, [])

  /** 直播中的判定：写稿会话（prep）不算开播，仍然显示「启动场次」 */
  const running = (agent.state === 'running' || agent.state === 'starting') && agent.purpose !== 'prep'
  const activePlan = plans.find((p) => p.id === activePlanId) ?? null
  const blocked = (checks ?? []).some((item) => item.level === 'block')
  /** 底稿覆盖不过关：预检弹窗给出「去生成底稿」的直达入口（跳直播台派主播写稿） */
  const coverageShort = (checks ?? []).some((item) => item.code === 'coverage' && item.level !== 'ok')

  const goGenerate = (): void => {
    if (!activePlanId) return
    setChecks(null)
    void window.api.agent.draftStart(activePlanId).then((result) => {
      if (!result.ok) toast.error('派写稿任务失败', { description: result.error })
    })
  }

  const switchPlan = async (id: string): Promise<void> => {
    await window.api.plan.setActive(id)
    await useAppStore.getState().loadConfig()
    const plan = plans.find((p) => p.id === id)
    toast.success(`已切换到场次：${plan?.name ?? ''}`, {
      description: running ? '结构性变更下次开播生效' : undefined
    })
  }

  const runPreflight = async (): Promise<void> => {
    if (!activePlanId) return
    setChecking(true)
    try {
      setChecks(await window.api.plan.preflight(activePlanId))
    } finally {
      setChecking(false)
    }
  }

  const openPreflight = async (): Promise<void> => {
    if (!activePlanId) {
      toast.warning('先选一个场次', { description: '场次决定这场用什么人设、剧本与话术' })
      return
    }
    await runPreflight()
  }

  const start = async (): Promise<void> => {
    if (busy || !activePlanId) return
    setBusy(true)
    try {
      const result = await window.api.plan.launch(activePlanId)
      if (result.ok) {
        setChecks(null)
        // 新一场从「播报中」开始（上一场可能是暂停状态停掉的）
        resumeBroadcast()
        toast.success(`场次已启动：${activePlan?.name ?? ''}`, {
          description: result.loaded
            ? `已从话术库装载 ${result.loaded} 条，接着播`
            : '本场没有就绪话术，主播先现场生成'
        })
      } else {
        toast.error('启动失败', { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.api.agent.stop()
      toast.message('场次已停止', { description: '池里的存货会继续播完' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {activePlan && !running && (
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {activePlan.theme || '（未设主题）'}
        </span>
      )}
      <Select
        value={activePlanId || undefined}
        onValueChange={(v) => void switchPlan(v)}
        disabled={running}
      >
        <SelectTrigger size="sm" className="w-48">
          <SelectValue placeholder="选择场次" />
        </SelectTrigger>
        <SelectContent>
          {plans.length === 0 && (
            <SelectItem value="__none" disabled>
              还没有场次（到「场次」页新建）
            </SelectItem>
          )}
          {plans.map((plan) => (
            <SelectItem key={plan.id} value={plan.id}>
              {plan.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 统一开播控制：启动 → 暂停/继续 → 结束，一个地方说清"这场现在什么状态" */}
      {running ? (
        <>
          <Button
            size="sm"
            variant={loopRunning ? 'default' : 'secondary'}
            onClick={() => (loopRunning ? pauseBroadcast() : resumeBroadcast())}
            title={loopRunning ? '暂停：停播报，也让主播先别生成新话术' : '继续播报'}
          >
            {loopRunning ? <Pause /> : <Play />}
            {loopRunning ? '暂停' : '继续'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void stop()}
            title="结束本场（池里的存货会播完）"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Square />}
            结束场次
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={busy || checking}
          onClick={() => void openPreflight()}
          title="预检并启动场次"
        >
          {busy || checking ? <Loader2 className="animate-spin" /> : <Play />}
          启动场次
        </Button>
      )}

      {/* 开播预检（docs/07 §8.5）：阻断项拦住开播，警告项自己判断 */}
      <Dialog
        open={checks !== null}
        onOpenChange={(open) => {
          if (!open) setChecks(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>开播预检{activePlan ? ` · ${activePlan.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {(checks ?? []).map((item, index) => (
              <div key={index} className="flex items-start gap-2 rounded-md border p-2">
                {item.level === 'ok' ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                ) : item.level === 'warn' ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                )}
                <div className="min-w-0">
                  <p className="text-sm">{item.label}</p>
                  {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          {blocked && (
            <p className="text-xs text-red-600">
              有阻断项：按提示处理完再开播（配置入口在左下角「设置」）。
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="outline" onClick={() => setChecks(null)}>
              先去处理
            </Button>
            {coverageShort && (
              <Button variant="outline" onClick={goGenerate}>
                <Sparkles />
                去生成底稿
              </Button>
            )}
            <Button variant="outline" disabled={checking} onClick={() => void runPreflight()}>
              {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重新预检
            </Button>
            <Button disabled={blocked || busy} onClick={() => void start()}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              仍然启动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 评论列表（ LivePage 持有数据与订阅，这里只渲染） */
function CommentList({ comments }: { comments: LiveComment[] }) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments])

  if (comments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareText className="size-8" strokeWidth={1.25} />
        <p className="text-sm">还没有评论，开连接器的演示模式试试</p>
      </div>
    )
  }
  return (
    <div ref={listRef} className="flex flex-col gap-1 pt-2">
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
          title={
            item.speechText && item.speechText !== item.text
              ? `${item.text}

实际念的是：${item.speechText}`
              : item.text
          }
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

/** 推流状态指示（直播台 header）：开播/码率/时长/重连 */
function StreamIndicator() {
  const stream = useAppStore((s) => s.stream)
  if (stream.state === 'idle') return null
  if (stream.state === 'error') return <Badge variant="destructive">推流出错</Badge>
  if (stream.state === 'starting') return <Badge variant="outline">推流启动中…</Badge>
  if (stream.state !== 'live') return null
  const duration = `${Math.floor(stream.durationSec / 60)}:${String(stream.durationSec % 60).padStart(2, '0')}`
  return (
    <Badge variant="secondary" title={stream.reconnecting ? `第 ${stream.reconnectAttempt} 次重连中` : undefined}>
      {stream.reconnecting
        ? `重连中(${stream.reconnectAttempt})`
        : stream.mode === 'direct'
          ? `推流中 · ${stream.bitrateKbps}kbps · ${duration}`
          : `伴侣模式 · ${duration}`}
    </Badge>
  )
}

/** 时间戳（工具调用行里统一用等宽小字，不抢视线） */
function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 请示（ask_director）：带倒计时、默认策略与一键选项的卡片，不阻塞直播（docs/07 §8.8.6 ④） */
function AskCard({
  message,
  now,
  onAnswer
}: {
  message: DirectorMessage
  now: number
  onAnswer: (message: DirectorMessage, answer: string) => void
}) {
  const remain = message.timeoutSec
    ? Math.max(0, Math.ceil((message.ts + message.timeoutSec * 1000 - now) / 1000))
    : null
  const expired = remain === 0
  const dim = expired || Boolean(message.answered)
  return (
    <div
      className={cn(
        'rounded-2xl rounded-tl-sm border px-3 py-2',
        dim ? 'border-border bg-muted/60' : 'border-primary/30 bg-primary/5'
      )}
    >
      <MiniMarkdown text={message.text} />
      {message.defaultAction && (
        <p className="mt-1 text-[12px] text-muted-foreground">没答就按这个走：{message.defaultAction}</p>
      )}
      {remain !== null && !dim && (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">剩 {remain}s 未答就按默认策略继续</p>
      )}
      {message.answered ? (
        <p className="mt-1.5 text-[12px] text-muted-foreground">已答复：{message.answered}</p>
      ) : expired ? (
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          已过期（超过 {message.timeoutSec}s 未答，按默认策略继续）
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(message.options ?? []).map((option) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              className="h-7 bg-background px-2.5 text-xs"
              onClick={() => onAnswer(message, option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 对话时间线的一条：导演指令（右）/ 主播文本（左，中间文本或最终回复）/ 工具卡片 / 请示卡片 */
type ChatEntry =
  | { type: 'director'; id: string; ts: number; text: string; attachments?: { name: string; path: string }[] }
  | { type: 'text'; id: string; ts: number; text: string; final: boolean; turnId: string }
  | {
      type: 'tool'
      id: string
      ts: number
      turnId: string
      name: string
      args?: string
      status: 'running' | 'ok' | 'error'
      result?: string
      durationMs?: number
    }
  | { type: 'ask'; id: string; ts: number; message: DirectorMessage }

/** 连续同名工具并成一行（say ×4 · 65ms），点开看每一条 */
function ToolGroup({ items }: { items: Extract<ChatEntry, { type: 'tool' }>[] }) {
  const [open, setOpen] = useState(false)
  const name = items[0].name
  const totalMs = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const running = items.some((item) => item.status === 'running')
  const failed = items.some((item) => item.status === 'error')
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Wrench className="size-3 shrink-0 opacity-60" />
        <span className="shrink-0 font-mono text-[11px]">{name}</span>
        <span className="shrink-0 font-mono text-[11px] opacity-60">×{items.length}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-60">
          {items[0].args && !NOISY_TOOLS.has(name) ? items[0].args : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {totalMs > 0 && <span className="font-mono text-[10px] opacity-50">{Math.round(totalMs)}ms</span>}
          {running ? (
            <Loader2 className="size-3 animate-spin opacity-60" />
          ) : failed ? (
            <XCircle className="size-3 text-destructive/80" />
          ) : (
            <CheckCircle2 className="size-3 text-emerald-600/70" />
          )}
          <ChevronRight className={cn('size-3 opacity-40 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-1 border-l border-border/70 py-0.5 pl-3">
          {items.map((item) => (
            <div key={item.id} className="flex flex-col gap-0.5 font-mono text-[11px] leading-[17px] text-muted-foreground">
              {item.args && <p className="whitespace-pre-wrap break-all opacity-80">{item.args}</p>}
              {item.result && <p className="whitespace-pre-wrap break-all opacity-60">{item.result}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 播出类工具：一轮里能出现十几条，参数（就是话术原文）没必要塞在行里，展开再看 */
const NOISY_TOOLS = new Set(['say', 'insert_next'])

/**
 * 工具调用：做成一行"日志行"——浅灰等宽字 + 小图标，不套边框卡片，好让文本穿插其间时读起来连贯。
 * 点一下展开完整参数与结果；播出类工具收起时不显示参数（否则每句台词都糊在时间线上）。
 */
function ToolCard({ entry }: { entry: Extract<ChatEntry, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Wrench className="size-3 shrink-0 opacity-60" />
        <span className="shrink-0 font-mono text-[11px]">{entry.name}</span>
        {entry.args && !NOISY_TOOLS.has(entry.name) && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-75">{entry.args}</span>
        )}
        {NOISY_TOOLS.has(entry.name) && <span className="min-w-0 flex-1" />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {entry.durationMs !== undefined && (
            <span className="font-mono text-[10px] opacity-50">{Math.round(entry.durationMs)}ms</span>
          )}
          {entry.status === 'running' ? (
            <Loader2 className="size-3 animate-spin opacity-60" />
          ) : entry.status === 'ok' ? (
            <CheckCircle2 className="size-3 text-emerald-600/70" />
          ) : (
            <XCircle className="size-3 text-destructive/80" />
          )}
          <ChevronRight className={cn('size-3 opacity-40 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-1 border-l border-border/70 py-0.5 pl-3 font-mono text-[11px] leading-[17px] text-muted-foreground">
          {entry.args && <p className="whitespace-pre-wrap break-all opacity-80">{entry.args}</p>}
          {entry.result && (
            <p className={cn('whitespace-pre-wrap break-all', entry.status === 'error' ? 'text-destructive' : 'opacity-90')}>
              {entry.result}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 主播对话（docs/07 §8.8 / docs/09 §11）：导演 ↔ 主播的实时通道，右栏主区（铺满整栏高度）。
 * 时间线照 pi 事件流原样渲染：导演指令（右侧气泡）/ 中间文本（左侧淡色流式）/ 工具卡片 /
 * 最终回复（独立气泡）/ 请示卡片（一键作答）。不做二次抽文本，也没有单独的"汇报"通道。
 * 快速指令（暂停/跳过/恢复）本地解析直接执行，不过 LLM；其余文本 steer 插队给主播。
 * composer 对齐 Codex 桌面版：圆角盒内 附件（回形针）+ 发送；附件以路径形式随指令发给主播。
 */
function DirectorConsole({ active, onUnread }: { active: boolean; onUnread: () => void }) {
  const agent = useAppStore((s) => s.agent)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  /** 请示倒计时用（有未答且有 timeoutSec 的卡片时每秒走一次） */
  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onUnreadRef = useRef(onUnread)
  onUnreadRef.current = onUnread
  /** 见过的条目 id：只有首见的那次算未读（流式更新同一 id 不算新消息） */
  const seenRef = useRef(new Set<string>())

  /** 时间线顺序追加/按 id 覆盖（text 覆盖全文、tool 更新状态）；时间戳沿用首次那条，避免排序跳动 */
  const upsert = (entry: ChatEntry): void => {
    setEntries((prev) => {
      const index = prev.findIndex((item) => item.id === entry.id)
      if (index < 0) return [...prev.slice(-199), entry]
      const next = prev.slice()
      // 合并而不是替换：工具结束的更新不带 args，整体替换会把参数/结果冲掉
      next[index] = { ...prev[index], ...entry, ts: prev[index].ts } as ChatEntry
      return next
    })
  }

  /** 新条目（首见 id）落地；切走时在「对话」选项卡上累未读 */
  const landed = (id: string): void => {
    const first = !seenRef.current.has(id)
    seenRef.current.add(id)
    if (first && !activeRef.current) onUnreadRef.current()
  }

  // 订阅对话时间线（文本流式 + 工具卡片）与请示卡片
  useEffect(() => {
    if (!('api' in window)) return
    const offTimeline = window.api.director.onTimeline((event) => {
      const entry = event.entry
      if (entry.type === 'text') {
        upsert({
          type: 'text',
          id: entry.id,
          ts: Date.now(),
          turnId: event.turnId,
          text: entry.text,
          final: entry.final === true
        })
      } else {
        upsert({
          type: 'tool',
          id: entry.id,
          ts: Date.now(),
          turnId: event.turnId,
          name: entry.name,
          args: entry.args,
          status: entry.status,
          result: entry.result,
          durationMs: entry.durationMs
        })
      }
      landed(entry.id)
    })
    const offAsk = window.api.director.onEvent((message) => {
      upsert({ type: 'ask', id: message.id, ts: message.ts, message })
      landed(message.id)
    })
    return () => {
      offTimeline()
      offAsk()
    }
  }, [])

  // 请示超时倒计时：到点卡片标过期（主播那边本来就不阻塞，docs/07 §8.8.6 ④）
  const hasPendingAsk = entries.some(
    (entry) => entry.type === 'ask' && !entry.message.answered && entry.message.timeoutSec
  )
  useEffect(() => {
    if (!hasPendingAsk) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasPendingAsk])

  // 开发演示：?demo 时塞一组样例条目看布局（仅 dev，不进生产包行为）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('demo')) return
    const t0 = Date.now()
    setEntries([
      {
        type: 'director',
        id: 'demo-1',
        ts: t0 - 120000,
        text: '语速放慢一点，多强调 316 不锈钢内胆',
        attachments: [{ name: '保温杯卖点.pdf', path: 'D:/docs/保温杯卖点.pdf' }]
      },
      { type: 'tool', id: 'demo-t1', ts: t0 - 118000, turnId: 'turn-1', name: 'search_knowledge', args: '保温杯 内胆', status: 'ok', result: '商品「316 保温杯」：内胆 316 不锈钢，容量 500ml', durationMs: 240 },
      { type: 'text', id: 'demo-2', ts: t0 - 117000, turnId: 'turn-1', text: '先查一下内胆材质的话术，再调下面几条。', final: false },
      { type: 'tool', id: 'demo-t2', ts: t0 - 116000, turnId: 'turn-1', name: 'revise_next', args: 'count=2', status: 'ok', result: '已改写 2 条未播话术', durationMs: 88 },
      { type: 'text', id: 'demo-3', ts: t0 - 60000, turnId: 'turn-1', text: '收到：接下来两条改成强调 316 不锈钢内胆，语速提示调慢了 10%，预计 30 秒后生效。', final: true },
      { type: 'text', id: 'demo-3b', ts: t0 - 59000, turnId: 'turn-1', text: '（同轮续写：这段也算这一轮的文本，不会再插分隔线。）', final: true },
      { type: 'tool', id: 'demo-s1', ts: t0 - 55000, turnId: 'turn-2', name: 'say', args: '{"text":"家人们欢迎进直播间"}', status: 'ok', result: '已排进队列', durationMs: 31 },
      { type: 'tool', id: 'demo-s2', ts: t0 - 54800, turnId: 'turn-2', name: 'say', args: '{"text":"今天咱们是保温杯专场"}', status: 'ok', result: '已排进队列', durationMs: 8 },
      { type: 'tool', id: 'demo-s3', ts: t0 - 54600, turnId: 'turn-2', name: 'say', args: '{"text":"316 内胆，12 小时保温"}', status: 'ok', result: '已排进队列', durationMs: 5 },
      { type: 'tool', id: 'demo-s4', ts: t0 - 54400, turnId: 'turn-2', name: 'say', args: '{"text":"价格给到位，59 块 9"}', status: 'ok', result: '已排进队列', durationMs: 3 },
      { type: 'text', id: 'demo-4', ts: t0 - 40000, turnId: 'turn-2', text: '第二轮只有这一段文本：中间文本与最终回复都铺满宽度，靠上面的时间分隔线区分是哪一轮。', final: true },
      {
        type: 'ask',
        id: 'demo-4',
        ts: t0 - 15000,
        message: {
          id: 'demo-4',
          ts: t0 - 15000,
          kind: 'ask',
          text: '有观众问能不能刻字，知识库里没有这一条。可以承诺免费刻字吗？',
          options: ['可以承诺', '别承诺，引导私信', '我确认下再回']
        }
      }
    ])
  }, [])

  // 新条目/流式更新：贴底状态时自动滚到底（导演往上翻时不抢滚动条）；初始视为贴底
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (!el || !active) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [entries, active])

  /** 快速指令本地解析（不过 LLM）。命中返回 true。 */
  const runQuickCommand = (text: string): boolean => {
    if (/^(暂停|暂停播报|停一下)$/.test(text)) {
      pauseBroadcast()
      toast.message('播报已暂停', { description: '主播也停了产出，池里的内容保留，恢复后继续播' })
      return true
    }
    if (/^(恢复|继续|恢复播报|继续播报)$/.test(text)) {
      resumeBroadcast()
      return true
    }
    if (/^(跳过|跳过这条|下一条)$/.test(text)) {
      audioEngine.stopCurrent()
      toast.message('已跳过当前播报')
      return true
    }
    return false
  }

  const pickAttachment = async (): Promise<void> => {
    const filePath = await window.api.dialog.pickFile('选择附件', [
      'png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'docx', 'txt', 'md'
    ])
    if (!filePath) return
    setAttachments((prev) => [...prev, { name: filePath.split(/[\\/]/).pop() ?? filePath, path: filePath }])
  }

  const send = (raw: string): void => {
    const text = raw.trim()
    const files = attachments
    if (!text && files.length === 0) return
    setInput('')
    setAttachments([])
    const id = `dm-local-${Date.now()}`
    upsert({
      type: 'director',
      id,
      ts: Date.now(),
      text,
      attachments: files.length > 0 ? files : undefined
    })
    landed(id)
    if (text && runQuickCommand(text)) return
    const payload =
      files.length > 0 ? `${text}\n${files.map((f) => `[附件] ${f.name}：${f.path}`).join('\n')}`.trim() : text
    void window.api.director.send(payload).then((result) => {
      if (!result.ok) toast.error('指令没送达', { description: result.error })
    })
  }

  const answerAsk = (message: DirectorMessage, answer: string): void => {
    upsert({ type: 'ask', id: message.id, ts: message.ts, message: { ...message, answered: answer } })
    send(answer)
  }

  /** 连续同名工具并成一组（中间夹着文本就断开），避免 say 刷屏 */
  const rows = useMemo(() => {
    const list: (
      | { kind: 'entry'; entry: ChatEntry }
      | { kind: 'tools'; id: string; items: Extract<ChatEntry, { type: 'tool' }>[] }
    )[] = []
    for (const entry of entries) {
      const last = list[list.length - 1]
      if (entry.type === 'tool' && last?.kind === 'tools' && last.items[0].name === entry.name) {
        last.items.push(entry)
        continue
      }
      if (entry.type === 'tool') list.push({ kind: 'tools', id: `group-${entry.id}`, items: [entry] })
      else list.push({ kind: 'entry', entry })
    }
    return list
  }, [entries])

  const canSend = input.trim().length > 0 || attachments.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot className="size-8" strokeWidth={1.25} />
            <p className="px-6 text-center text-xs leading-5">
              这里能看到主播的想法、工具调用和最终回复。
              <br />
              消息只进对话，不会被播出去。
            </p>
          </div>
        ) : (
          rows.map((row, index) => {
            // 分组的工具行也要参与"轮"的判断：取它第一条的 turnId
            const firstEntry = row.kind === 'tools' ? row.items[0] : row.entry
            const prevRow = index > 0 ? rows[index - 1] : undefined
            const prevEntry = prevRow?.kind === 'entry' ? prevRow.entry : prevRow?.items?.[0]
            const dayBreak = prevEntry
              ? new Date(prevEntry.ts).toDateString() !== new Date(firstEntry.ts).toDateString()
              : false
            /** 每轮开头插一条时间分隔线：用时间把一轮对话框起来（不给最终回复贴标签） */
            const turnId =
              firstEntry.type === 'text' || firstEntry.type === 'tool' ? firstEntry.turnId : undefined
            const prevTurnId =
              prevEntry && (prevEntry.type === 'text' || prevEntry.type === 'tool')
                ? prevEntry.turnId
                : undefined
            const showTurnBreak = Boolean(turnId) && turnId !== prevTurnId
            const head = (
              <>
                {dayBreak && (
                  <div className="my-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    {new Date(firstEntry.ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {showTurnBreak && (
                  <div className="mt-1.5 mb-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/50">
                    <span className="h-px flex-1 bg-border/60" />
                    {clock(firstEntry.ts)}
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                )}
              </>
            )

            if (row.kind === 'tools') {
              return (
                <Fragment key={row.id}>
                  {head}
                  {row.items.length > 1 ? <ToolGroup items={row.items} /> : <ToolCard entry={row.items[0]} />}
                </Fragment>
              )
            }

            const entry = row.entry
            return (
              <Fragment key={entry.id}>
                {head}
                {entry.type === 'director' ? (
                  <div className="flex max-w-[86%] flex-col items-end gap-1 self-end">
                    <div className="rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-[13px] leading-[20px] text-primary-foreground">
                      {entry.text}
                      {entry.attachments?.map((file) => (
                        <div
                          key={file.path}
                          className="mt-1 flex items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 text-xs"
                          title={file.path}
                        >
                          <Paperclip className="size-3 shrink-0" />
                          <span className="truncate">{file.name}</span>
                        </div>
                      ))}
                    </div>
                    <span className="px-1 font-mono text-[10px] text-muted-foreground/60">{clock(entry.ts)}</span>
                  </div>
                ) : entry.type === 'text' && !entry.final ? (
                  // 中间文本：淡色、不套气泡、铺满宽度（流式追加时不会跳成多块）
                  <p className="whitespace-pre-wrap text-[13px] leading-[21px] text-muted-foreground">
                    {entry.text}
                    {agent.state === 'running' && index === rows.length - 1 && (
                      <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
                    )}
                  </p>
                ) : entry.type === 'text' ? (
                  // 最终回复：正常前景色、铺满宽度（时间在轮分隔线上，这里不再重复）
                  <MiniMarkdown text={entry.text} />
                ) : entry.type === 'tool' ? (
                  <ToolCard entry={entry} />
                ) : (
                  <AskCard message={entry.message} now={now} onAnswer={answerAsk} />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      {/* 快速指令：本地直执不过 LLM；「汇报下状态」发给主播 */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => send(loopRunning ? '暂停' : '继续')}
        >
          {loopRunning ? '暂停' : '继续'}
        </Button>
        <Button variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => send('跳过')}>
          跳过这条
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => send('汇报一下当前直播状态')}
        >
          汇报下状态
        </Button>
      </div>

      {/* composer：圆角盒 + 附件 + 发送（Codex 桌面版布局） */}
      <div className="shrink-0 p-2">
        <div className="rounded-lg bg-muted px-3 pt-2 pb-1.5">
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((file) => (
                <span
                  key={file.path}
                  className="flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-xs"
                  title={file.path}
                >
                  <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  <span className="max-w-36 truncate">{file.name}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setAttachments((prev) => prev.filter((f) => f.path !== file.path))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            placeholder={agent.state === 'running' ? '对主播说点什么…' : '对主播说点什么…（选中场次即可开聊，主播会自己就位）'}
            className="max-h-32 w-full resize-none bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send(input)
              }
            }}
          />
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => void pickAttachment()} title="添加附件">
              <Paperclip />
            </Button>
            {agent.state === 'running' && (
              <span className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-green-500" />
                主播在跑，指令插队直达
              </span>
            )}
            <Button
              size="icon-sm"
              className="ml-auto"
              disabled={!canSend}
              onClick={() => send(input)}
              title="发送（Enter）"
            >
              <SendHorizontal />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}


/** 右侧操作面板：人工控制入口（人工播报 / 切场景 / 急停 / 场控指令 → 对话 / 调音量） */
function ControlPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [panicOpen, setPanicOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [sceneOpen, setSceneOpen] = useState(false)

  const panic = () => {
    setPanicOpen(false)
    void (async () => {
      // 急停链：停主播 → 清全部车道 → 主进程掐断当前播报（解码与排播都在那边）
      await window.api.agent.stop()
      for (const lane of ['interrupt', 'next', 'normal', 'filler'] as const) {
        await window.api.pool.clearLane(lane)
      }
      audioEngine.stopCurrent()
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
        <Button variant="outline" size="sm" onClick={() => setSceneOpen(true)} title="跳到剧本某一场景并装载该场景话术">
          <Clapperboard />
          切场景
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setPanicOpen(true)}>
          <OctagonAlert />
          紧急停止
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenChat} title="到对话区直接指挥主播">
          <RadioTower />
          场控指令
        </Button>
        <Button variant="outline" size="sm" onClick={() => setVolumeOpen(true)}>
          <SlidersHorizontal />
          调音量
        </Button>
      </div>
      <ManualBroadcastDialog open={broadcastOpen} onOpenChange={setBroadcastOpen} />
      <VolumeDialog open={volumeOpen} onOpenChange={setVolumeOpen} />
      <SceneDialog open={sceneOpen} onOpenChange={setSceneOpen} />
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

/** 切场景：列当前场次剧本的场景，点一个就跳过去并把该场景话术库载入池 */
function SceneDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activePlanId = useAppStore((s) => s.config.live.activePlanId)
  const scene = useAppStore((s) => s.agent.scene)
  const [plan, setPlan] = useState<LivePlan | null>(null)
  const [scripts, setScripts] = useState<Script[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void window.api.plan.list().then((list) => setPlan(list.find((p) => p.id === activePlanId) ?? null))
    void window.api.script.list().then(setScripts)
  }, [open, activePlanId])

  const script = scripts.find((s) => s.id === plan?.scriptId) ?? null

  const goto = async (index: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.plan.gotoScene(activePlanId, index)
      if (result.ok) {
        onOpenChange(false)
        toast.success(`已切到「${result.title ?? ''}」`, {
          description: result.loaded ? `装载话术 ${result.loaded} 条` : '该场景没有就绪话术，主播现场补'
        })
      } else {
        toast.error('切场景失败', { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>切场景{script ? ` · ${script.title}` : ''}</DialogTitle>
        </DialogHeader>
        {script ? (
          <div className="space-y-1.5">
            {script.scenes.map((item, index) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                onClick={() => void goto(index)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50',
                  scene?.index === index && 'border-primary/40 bg-primary/5'
                )}
              >
                <span className="text-xs text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.goal}</span>
                </span>
                {scene?.index === index && <Badge variant="secondary">当前</Badge>}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            这场没绑剧本（或者还没选场次）——到场次页选一场，或在剧本里加场景。
          </p>
        )}
      </DialogContent>
    </Dialog>
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
              placeholder="留空用主播自己的音色"
              className="h-7 text-xs"
            />
          </div>
          <VoiceProviderHint voiceId={voice} />
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

/** 调音量弹窗：BGM（选择/播放/音量）+ 麦克风接管 + 主音量。BGM 与音量全在主进程判定。 */
function VolumeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const streamMode = useAppStore((s) => s.stream.mode)
  const [bgmPlaying, setBgmPlaying] = useState(false)
  const [bgmVolume, setBgmVolume] = useState(Math.round(config.bgm.volume * 100))
  const [micOn, setMicOn] = useState(audioEngine.micActive)
  const [masterVolume, setMasterVolume] = useState(Math.round(audioEngine.volume * 100))

  const pickBgm = async () => {
    const filePath = await window.api.dialog.pickFile('音频文件', ['mp3', 'wav', 'm4a', 'ogg', 'flac'])
    if (!filePath) return
    const result = await window.api.audio.setBgm('start', filePath, bgmVolume / 100)
    if (!result.ok) {
      toast.error('BGM 放不了', { description: result.error ?? '未知原因' })
      return
    }
    void saveConfig({ bgm: { path: filePath, volume: bgmVolume / 100 } })
    setBgmPlaying(true)
    toast.success('BGM 已开始播放', { description: filePath.split(/[\/]/).pop() })
  }

  const stopBgm = () => {
    void window.api.audio.setBgm('stop')
    setBgmPlaying(false)
  }

  const changeBgmVolume = (value: number) => {
    setBgmVolume(value)
    void window.api.audio.setBgm('volume', undefined, value / 100)
  }

  const toggleMic = async (on: boolean) => {
    if (on) {
      try {
        // 直推模式把 PCM 帧转发进主进程混音器；伴侣模式只进本地总线（伴侣采集系统声音）
        await audioEngine.startMic('', { autoYield: true, forwardPcm: streamMode === 'direct' })
        setMicOn(true)
        toast.success('麦克风已接管', { description: '说话时自动压低 AI 播报' })
      } catch (e) {
        toast.error('麦克风打开失败', { description: e instanceof Error ? e.message : String(e) })
      }
    } else {
      audioEngine.stopMic()
      setMicOn(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>调音量</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>BGM</Label>
              <div className="flex items-center gap-1.5">
                {bgmPlaying ? (
                  <Button variant="outline" size="sm" className="h-6 text-xs" onClick={stopBgm}>
                    停止
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => void pickBgm()}>
                  {config.bgm.path ? '换一首' : '选择音频文件'}
                </Button>
              </div>
            </div>
            <p className="mb-1.5 truncate text-xs text-muted-foreground">
              {config.bgm.path ? config.bgm.path.split(/[\/]/).pop() : '未选择（TTS 播报时自动压低）'}
            </p>
            <Slider
              value={[bgmVolume]}
              min={0}
              max={100}
              step={1}
              onValueChange={([v]) => changeBgmVolume(v)}
              onValueCommit={([v]) => void saveConfig({ bgm: { path: config.bgm.path, volume: v / 100 } })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <p className="text-[13px]">麦克风接管</p>
              <p className="text-xs text-muted-foreground">真人说话时自动压低 AI 播报{streamMode === 'direct' ? '，声音进推流' : ''}</p>
            </div>
            <Switch checked={micOn} onCheckedChange={(v) => void toggleMic(v)} aria-label="麦克风接管" />
          </div>
          <div>
            <Label className="mb-1.5">主音量</Label>
            <Slider
              value={[masterVolume]}
              min={0}
              max={100}
              step={1}
              onValueChange={([v]) => {
                setMasterVolume(v)
                audioEngine.setMasterVolume(v / 100)
              }}
            />
          </div>        </div>
      </DialogContent>
    </Dialog>
  )
}
