import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CircleHelp,
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
  SendHorizontal,
  SlidersHorizontal,
  Square,
  X
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
import { useAppStore } from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import { playbackLoop } from '../audio/playbackLoop'
import type {
  DirectorMessage,
  LiveComment,
  LivePlan,
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
  const [leftTab, setLeftTab] = useState<'pool' | 'comments'>('pool')
  const [comments, setComments] = useState<LiveComment[]>([])
  /** 右栏选项卡：对话是主区（铺满高度），提词器/操作切过去才显示 */
  const [rightTab, setRightTab] = useState<'chat' | 'teleprompter' | 'control'>('chat')
  /** 导演对话未读数（切走时有新汇报/请示在选项卡上亮红点） */
  const [chatUnread, setChatUnread] = useState(0)

  // 评论订阅提到页面层（标签上要显示条数），保持最近 100 条
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.comment.onComment((comment) => {
      setComments((prev) => [...prev.slice(-99), comment])
    })
  }, [])

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
        {/* 唯一开播入口：选场次 → 启动场次（docs/07 §8.5） */}
        <PlanLauncher />
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
        {/* 左栏：话术池队列 / 评论流，选项卡切换 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <Tabs value={leftTab} onValueChange={(v) => setLeftTab(v as typeof leftTab)} className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 border-b px-4 pt-2">
              <TabsList variant="line">
                <TabsTrigger value="pool" className="px-3 text-xs">
                  话术池队列 · {pool.items.length}
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

        {/* 右侧面板：选项卡切换。对话是主区（铺满整栏）；提词器/操作切过去才显示。
            forceMount 保持挂载——切走不丢消息状态和订阅。 */}
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
                <TabsTrigger value="teleprompter" className="px-3 text-xs">
                  提词器
                </TabsTrigger>
                <TabsTrigger value="control" className="px-3 text-xs">
                  操作
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="chat" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <DirectorConsole active={rightTab === 'chat'} onUnread={() => setChatUnread((n) => n + 1)} />
            </TabsContent>
            <TabsContent
              value="teleprompter"
              forceMount
              className="min-h-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden"
            >
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
            </TabsContent>
            <TabsContent value="control" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <ControlPanel />
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  )
}

/**
 * 场次入口：选场次 + 启动/停止场次（唯一开播入口）。
 * 最小版：加载场次（写 activePlanId）+ 启动主播 Agent；预检弹窗与话术库装载是后续里程碑。
 */
function PlanLauncher() {
  const agent = useAppStore((s) => s.agent)
  const activePlanId = useAppStore((s) => s.config.live.activePlanId)
  const [plans, setPlans] = useState<LivePlan[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.plan.list().then(setPlans)
  }, [])

  const running = agent.state === 'running' || agent.state === 'starting'
  const activePlan = plans.find((p) => p.id === activePlanId) ?? null

  const switchPlan = async (id: string): Promise<void> => {
    await window.api.plan.setActive(id)
    await useAppStore.getState().loadConfig()
    const plan = plans.find((p) => p.id === id)
    toast.success(`已切换到场次：${plan?.name ?? ''}`, {
      description: running ? '结构性变更下次开播生效' : undefined
    })
  }

  const start = async (): Promise<void> => {
    if (busy) return
    if (!activePlanId) {
      toast.warning('先选一个场次', { description: '场次决定这场用什么人设、剧本与话术' })
      return
    }
    setBusy(true)
    try {
      // 最小版：加载场次（已是 active）→ 启动主播会话
      const result = await window.api.agent.start()
      if (result.ok) {
        toast.success(`场次已启动：${activePlan?.name ?? ''}`, { description: '开场话术正在入池' })
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

      <Button
        size="sm"
        variant={running ? 'secondary' : 'default'}
        disabled={busy}
        onClick={() => void (running ? stop() : start())}
        title={running ? '停止本场（池内存货播完）' : '加载场次并启动主播'}
      >
        {busy ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
        {running ? '停止场次' : '启动场次'}
      </Button>

      {activePlan && !running && (
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {activePlan.theme || '（未设主题）'}
        </span>
      )}
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

/** AI 正在组织语言：text_delta 实时预览（品牌色），入池即消失 */
function AgentDraft() {
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

/**
 * 导演对话（docs/07 §8.8）：导演 ↔ 主播的实时文字通道，右栏主区（铺满整栏高度）。
 * 消息三类分流：导演指令（右侧气泡）/ 主播汇报（灰字，report_to_director 工具）/ 主播请示（高亮卡片 + 一键选项）。
 * 快速指令（暂停/跳过/恢复）本地解析直接执行，不过 LLM；其余文本 steer 插队给主播。
 * composer 对齐 Codex 桌面版：圆角盒内 附件（回形针）+ 发送；附件以路径形式随指令发给主播。
 */
function DirectorConsole({ active, onUnread }: { active: boolean; onUnread: () => void }) {
  const agent = useAppStore((s) => s.agent)
  const loopRunning = useAppStore((s) => s.loopRunning)
  const setLoopRunning = useAppStore((s) => s.setLoopRunning)
  const [messages, setMessages] = useState<DirectorMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onUnreadRef = useRef(onUnread)
  onUnreadRef.current = onUnread

  // 订阅主播汇报/请示（主进程广播）；切走时在「对话」选项卡上累未读
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.director.onEvent((message) => {
      setMessages((prev) => [...prev.slice(-99), message])
      if (!activeRef.current) onUnreadRef.current()
    })
  }, [])

  // 开发演示：?demo 时塞一组样例消息看布局（仅 dev，不进生产包行为）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('demo')) return
    const now = Date.now()
    setMessages([
      { id: 'demo-1', ts: now - 120000, kind: 'report', text: '开场白播完了，在线 23 人，正在讲 1 号链接的保温杯' },
      {
        id: 'demo-2',
        ts: now - 90000,
        kind: 'director',
        text: '语速放慢一点，多强调 316 不锈钢内胆',
        attachments: [{ name: '保温杯卖点.pdf', path: 'D:/docs/保温杯卖点.pdf' }]
      },
      { id: 'demo-3', ts: now - 60000, kind: 'report', text: '收到，已把「316 不锈钢内胆」编进当前话术，语速调慢了 10%' },
      {
        id: 'demo-4',
        ts: now - 15000,
        kind: 'ask',
        text: '有观众问能不能刻字，知识库里没有这一条。可以承诺免费刻字吗？',
        options: ['可以承诺', '别承诺，引导私信', '我确认下再回']
      }
    ])
  }, [])

  // 新消息：贴底状态时自动滚到底（导演往上翻时不抢滚动条）；初始视为贴底
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (!el || !active) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, active])

  const append = (message: DirectorMessage): void => {
    setMessages((prev) => [...prev.slice(-99), message])
  }

  /** 快速指令本地解析（不过 LLM）。命中返回 true。 */
  const runQuickCommand = (text: string): boolean => {
    if (/^(暂停|暂停播报|停一下)$/.test(text)) {
      playbackLoop.stop()
      setLoopRunning(false)
      toast.message('播报已暂停', { description: '池里的内容保留，恢复后继续播' })
      return true
    }
    if (/^(恢复|继续|恢复播报|继续播报)$/.test(text)) {
      playbackLoop.start()
      setLoopRunning(true)
      return true
    }
    if (/^(跳过|跳过这条|下一条)$/.test(text)) {
      audioEngine.stopCurrentTts()
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
    append({
      id: `dm-local-${Date.now()}`,
      ts: Date.now(),
      kind: 'director',
      text,
      attachments: files.length > 0 ? files : undefined
    })
    if (text && runQuickCommand(text)) return
    const payload =
      files.length > 0 ? `${text}\n${files.map((f) => `[附件] ${f.name}：${f.path}`).join('\n')}`.trim() : text
    void window.api.director.send(payload).then((result) => {
      if (!result.ok) toast.error('指令没送达', { description: result.error })
    })
  }

  const answerAsk = (message: DirectorMessage, answer: string): void => {
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, answered: answer } : m)))
    send(answer)
  }

  const canSend = input.trim().length > 0 || attachments.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot className="size-8" strokeWidth={1.25} />
            <p className="px-6 text-center text-xs leading-5">
              和主播直接对话：下指令、收汇报、答请示。
              <br />
              消息只进对话，不会被播出去。
            </p>
          </div>
        ) : (
          messages.map((message) =>
            message.kind === 'director' ? (
              <div
                key={message.id}
                className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-[13px] text-primary-foreground"
              >
                {message.text}
                {message.attachments?.map((file) => (
                  <div
                    key={file.path}
                    className="mt-1 flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-xs"
                    title={file.path}
                  >
                    <Paperclip className="size-3 shrink-0" />
                    <span className="truncate">{file.name}</span>
                  </div>
                ))}
              </div>
            ) : message.kind === 'report' ? (
              <div key={message.id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Bot className="mt-0.5 size-3.5 shrink-0" />
                <p className="min-w-0">
                  {message.text}
                  <span className="ml-1.5 text-[10px] opacity-60">
                    {new Date(message.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </p>
              </div>
            ) : (
              <div key={message.id} className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <CircleHelp className="size-3.5 text-primary" />
                  <span className="text-xs font-medium text-primary">主播请示</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {new Date(message.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="mb-2 text-[13px]">{message.text}</p>
                {message.answered ? (
                  <Badge variant="secondary">已答复：{message.answered}</Badge>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(message.options ?? []).map((option) => (
                      <Button
                        key={option}
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => answerAsk(message, option)}
                      >
                        {option}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )
          )
        )}
      </div>

      {/* 快速指令：本地直执不过 LLM；「汇报下状态」发给主播 */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => send(loopRunning ? '暂停播报' : '恢复播报')}
        >
          {loopRunning ? '暂停播报' : '恢复播报'}
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
            placeholder={agent.state === 'running' ? '对主播说点什么…' : '主播没在跑（先启动场次）'}
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


/** 右侧操作面板：人工控制入口。后续场控/场景/音量等能力都往这里加按钮。 */
function ControlPanel() {
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [panicOpen, setPanicOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)

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
        <Button variant="outline" size="sm" onClick={() => setVolumeOpen(true)}>
          <SlidersHorizontal />
          调音量
        </Button>
      </div>
      <ManualBroadcastDialog open={broadcastOpen} onOpenChange={setBroadcastOpen} />
      <VolumeDialog open={volumeOpen} onOpenChange={setVolumeOpen} />
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

/** 调音量弹窗：BGM（选择/播放/音量）+ 麦克风接管 + 主音量 */
function VolumeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const streamMode = useAppStore((s) => s.stream.mode)
  const [bgmPlaying, setBgmPlaying] = useState(audioEngine.bgmPlaying)
  const [bgmVolume, setBgmVolume] = useState(Math.round(config.bgm.volume * 100))
  const [micOn, setMicOn] = useState(audioEngine.micActive)
  const [masterVolume, setMasterVolume] = useState(100)

  const pickBgm = async () => {
    const filePath = await window.api.dialog.pickFile('音频文件', ['mp3', 'wav', 'm4a', 'ogg', 'flac'])
    if (!filePath) return
    audioEngine.startBgm(filePath, bgmVolume / 100)
    void window.api.stream.setBgm('start', filePath, bgmVolume / 100)
    void saveConfig({ bgm: { path: filePath, volume: bgmVolume / 100 } })
    setBgmPlaying(true)
    toast.success('BGM 已开始播放', { description: filePath.split(/[\/]/).pop() })
  }

  const stopBgm = () => {
    audioEngine.stopBgm()
    void window.api.stream.setBgm('stop')
    setBgmPlaying(false)
  }

  const changeBgmVolume = (value: number) => {
    setBgmVolume(value)
    audioEngine.setBgmVolume(value / 100)
    void window.api.stream.setBgm('volume', undefined, value / 100)
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
