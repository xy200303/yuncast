import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CircleAlert,
  Download,
  FolderOpen,
  History,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Trash2,
  Zap, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDataRefresh } from '../lib/useDataRefresh'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { EChart } from '@/components/EChart'
import { WordCloud } from '@/components/WordCloud'
import { ContentText } from './ContentText'
import { audition, auditionTitle, useAuditionStore } from '../lib/audition'
import type {
  BroadcastEndReason,
  BroadcastEvent,
  BroadcastSession,
  Program,
  ProgramExportFormat,
  ProgramExportMode,
  SessionDetail,
  SessionExportResult,
  SessionStats,
  PoolItem,
  PoolSourceKind,
  PoolItemStatus
} from '../../../shared/types'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(startedAt: number, endedAt: number): string {
  if (!endedAt) return '进行中'
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60000))
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
  return `${minutes} 分钟`
}

const END_REASON_LABEL: Record<BroadcastEndReason, string> = {
  '': '进行中',
  manual: '手动收播',
  auto_stop: '播完收播',
  emergency: '紧急停止',
  app_quit: '应用退出',
  crash: '异常中断'
}

const STATUS_LABEL: Record<PoolItemStatus, string> = {
  pending: '待合成',
  synthesizing: '合成中',
  ready: '未播',
  playing: '播放中',
  done: '已播',
  interrupted: '被打断',
  skipped: '跳过',
  failed: '失败',
  expired: '过期'
}

/** 话术来源中文名（与 LivePage 的 SOURCE_LABEL 同一口径） */
const SOURCE_LABEL: Record<PoolSourceKind, string> = {
  scene: '剧情',
  reply: '回复',
  interact: '互动',
  announce: '公告',
  filler: '暖场',
  manual: '手动',
  reaction: '捧场'
}

/** 饼图来源配色（按 sourceMix 顺序循环取） */
const SOURCE_COLORS = ['#c2693f', '#4f7fa8', '#7d8a5a', '#b0526b', '#8a6fb0', '#c9a03f', '#5aa39b']

/** 场次记录页：每场开播的完整留档（话术播出/评论/事件），支持逐条试听与整场音频导出。 */
export function SessionsPage() {
  const [sessions, setSessions] = useState<BroadcastSession[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [programFilter, setProgramFilter] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setSessions(await window.api.session.list(programFilter || undefined))
  }, [programFilter])

  useEffect(() => {
    void window.api.program.list().then(setPrograms)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useDataRefresh(['sessions'], () => void refresh())

  // refresh 会随节目筛选换引用，直接进依赖会让定时器被无关重渲染反复重建；
  // 这里用 ref 镜像最新实现（React 19 虽有 useEffectEvent，但项目里既有的最新值镜像一律是 ref + effect，不单独引新写法）
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })

  // 还在播的场次 5 秒一刷（统计/时长跟着走）
  useEffect(() => {
    if (!sessions.some((s) => !s.endedAt)) return
    const timer = setInterval(() => void refreshRef.current(), 5000)
    return () => clearInterval(timer)
  }, [sessions])

  const remove = async (session: BroadcastSession) => {
    const result = await window.api.session.remove(session.id)
    if (!result.ok) {
      toast.error('删除失败', { description: result.error })
      return
    }
    toast.success('场次已删除')
    void refresh()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {detailId ? (
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setDetailId(null)}>
            <ArrowLeft className="size-4" />
          </Button>
        ) : (
          <History className="size-4 shrink-0 text-primary" />
        )}
        <h1 className="shrink-0 text-sm font-medium">场次记录</h1>
        {!detailId && (
          <>
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">每场开播的实际播出、评论与事件留档</p>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-8 text-xs" title="重新拉取场次（收播/agent 改动会自动刷新，这里是手动兜底）" onClick={() => void refresh()}>
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
              <Select value={programFilter || 'all'} onValueChange={(v) => setProgramFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="h-8 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部节目</SelectItem>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </header>

      {detailId ? (
        <SessionDetailView id={detailId} onBack={() => { setDetailId(null); void refresh() }} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <History className="size-8 opacity-40" />
              <p className="text-sm">还没有场次。开播一场节目后，这里会记下整场的播出与互动</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/40"
                  onClick={() => setDetailId(session.id)}
                  onKeyDown={(e) => {
                    // 卡片里嵌着删除按钮，套成真 button 会形成按钮嵌套（非法 HTML、键盘焦点会串）；
                    // target 判等是为了不让删除按钮上的 Enter/Space 冒泡上来把详情也打开
                    if (e.target !== e.currentTarget) return
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    setDetailId(session.id)
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{session.programName || '未命名节目'}</span>
                    <Badge variant={session.endedAt ? 'secondary' : 'default'}>
                      {END_REASON_LABEL[session.endReason]}
                    </Badge>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {formatTime(session.startedAt)} · {formatDuration(session.startedAt, session.endedAt)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    导演：{session.directorModelDesc || '未记录'} · 卡司：{session.cast.map((item) => item.personaName).join('、') || '未记录'}
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>播出 {session.stats.played} 条</span>
                    <span>评论 {session.stats.comments} 条</span>
                    <span>回复 {session.stats.replies} 条</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-7 text-muted-foreground hover:text-destructive"
                      title="删除场次"
                      onClick={(e) => {
                        e.stopPropagation()
                        void remove(session)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 场次详情：播出话术与评论/事件按时间交错成一条时间线 */
function SessionDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const auditionState = useAuditionStore()

  const refresh = useCallback(async () => {
    setDetail(await window.api.session.detail(id))
    setStats(await window.api.stats.session(id))
  }, [id])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useDataRefresh(['sessions'], () => void refresh())

  const timeline = useMemo(() => {
    if (!detail) return []
    const rows: ({ ts: number } & ({ kind: 'speech'; item: PoolItem } | { kind: 'event'; event: BroadcastEvent }))[] =
      [
        ...detail.items.map((item) => ({ kind: 'speech' as const, item, ts: item.playedAt ?? item.createdAt })),
        ...detail.events.map((event) => ({ kind: 'event' as const, event, ts: event.ts }))
      ]
    rows.sort((a, b) => a.ts - b.ts)
    return rows
  }, [detail])

  const remove = async () => {
    const result = await window.api.session.remove(id)
    if (!result.ok) {
      toast.error('删除失败', { description: result.error })
      return
    }
    toast.success('场次已删除')
    onBack()
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }
  const { session } = detail
  const playableCount = detail.items.filter(
    (item) => (item.status === 'done' || item.status === 'interrupted') && item.audioPath
  ).length

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <span className="min-w-0 truncate text-[13px] font-medium">{session.programName}</span>
        <Badge variant={session.endedAt ? 'secondary' : 'default'}>{END_REASON_LABEL[session.endReason]}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatTime(session.startedAt)} 开播 · {formatDuration(session.startedAt, session.endedAt)} · 播出{' '}
          {session.stats.played} · 评论 {session.stats.comments} · 回复 {session.stats.replies}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-8" onClick={() => setExportOpen(true)}>
            <Download className="size-3.5" />
            导出音频
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="删除场次"
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="timeline" className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="timeline" className="px-3">时间线</TabsTrigger>
            <TabsTrigger value="charts" className="px-3">图表</TabsTrigger>
            <TabsTrigger value="viewers" className="px-3">观众 · {detail.viewers.length}</TabsTrigger>
            <TabsTrigger value="summary" className="px-3">复盘摘要</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="timeline" className="min-h-0 overflow-auto p-4">
          {timeline.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              这场没有留下任何播出与互动记录
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {timeline.map((row) =>
                row.kind === 'speech' ? (
                  <div key={`sp-${row.item.id}`} className="rounded-lg border bg-card px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs tabular-nums text-muted-foreground">{formatClock(row.ts)}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {row.item.replyTo ? `回复 @${row.item.replyTo.author}` : STATUS_LABEL[row.item.status]}
                      </Badge>
                      {row.item.audioPath && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="ml-auto size-6"
                          title={
                            auditionState.key === `session:${row.item.id}` && auditionState.playing
                              ? auditionState.paused
                                ? '继续试听'
                                : '暂停试听'
                              : '试听这条'
                          }
                          onClick={() =>
                            audition.toggle({
                              key: `session:${row.item.id}`,
                              title: auditionTitle(row.item.text),
                              audioPath: row.item.audioPath!
                            })
                          }
                        >
                          {auditionState.key === `session:${row.item.id}` &&
                          auditionState.playing &&
                          !auditionState.paused ? (
                            <Pause className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                    <ContentText
                      text={row.item.text}
                      muted={row.item.status !== 'done' && row.item.status !== 'interrupted'}
                      className="mt-1"
                    />
                  </div>
                ) : (
                  <div
                    key={`ev-${row.event.id}`}
                    className="flex items-baseline gap-2 px-3 py-0.5 text-xs text-muted-foreground"
                  >
                    <span className="shrink-0 tabular-nums">{formatClock(row.ts)}</span>
                    {row.event.kind === 'comment' ? (
                      <span className="min-w-0">
                        <MessageSquare className="mr-1 inline size-3 align-[-1px]" />
                        <span className="font-medium text-foreground/80">{String(row.event.payload.author ?? '匿名')}</span>
                        ：{String(row.event.payload.content ?? '')}
                      </span>
                    ) : (
                      <span className="min-w-0">
                        <Zap className="mr-1 inline size-3 align-[-1px]" />
                        {String(row.event.payload.label ?? row.event.payload.type ?? '事件')}
                      </span>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="charts" className="min-h-0 overflow-auto p-4">
          <SessionCharts session={session} stats={stats} />
        </TabsContent>

        <TabsContent value="viewers" className="min-h-0 overflow-auto p-4">
          {detail.viewers.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              这场没有观众互动
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0 xl:grid-cols-3">
              {detail.viewers.map((viewer) => (
                <div key={viewer.name} className="rounded-lg border bg-card px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{viewer.name}</span>
                    <Badge variant="secondary">本场 {viewer.count} 条</Badge>
                  </div>
                  {viewer.profile && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      老粉画像：累计互动 {viewer.profile.interactions} 次
                      {viewer.profile.tags.length > 0 && ` · ${viewer.profile.tags.join('、')}`}
                    </p>
                  )}
                  {viewer.contents.length > 0 && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={viewer.contents.join('\n')}>
                      说过：{viewer.contents.slice(0, 2).join('；')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="summary" className="min-h-0 overflow-auto p-4">
          {session.summary ? (
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-[13px] leading-6 whitespace-pre-wrap">{session.summary}</p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              这场没有复盘摘要（下播时主播有过对话才会自动复盘）
            </div>
          )}
        </TabsContent>
      </Tabs>

      {exportOpen && (
        <SessionExportDialog
          session={session}
          playableCount={playableCount}
          open={exportOpen}
          onOpenChange={setExportOpen}
        />
      )}
    </>
  )
}

/** 单场可视化（docs/REDESIGN 4.11 B）：KPI + 分钟级互动热度 + 评论词云 + 来源构成 + 观众榜 */
function SessionCharts({ session, stats }: { session: BroadcastSession; stats: SessionStats | null }) {
  const heatOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['评论/分钟', '播出/分钟'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category' as const,
        // 叠播出时间轴：横轴是开播后的实际钟点
        data: stats.heat.map((point) => formatClock(session.startedAt + point.offsetMin * 60000)),
        axisLabel: { fontSize: 10 }
      },
      yAxis: { type: 'value' as const, minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: '评论/分钟',
          type: 'line' as const,
          smooth: true,
          areaStyle: { opacity: 0.12 },
          data: stats.heat.map((point) => point.comments),
          itemStyle: { color: '#c2693f' }
        },
        {
          name: '播出/分钟',
          type: 'line' as const,
          smooth: true,
          data: stats.heat.map((point) => point.speech),
          itemStyle: { color: '#4f7fa8' }
        }
      ]
    }
  }, [stats, session.startedAt])

  const sourceOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'item' as const },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      series: [
        {
          type: 'pie' as const,
          radius: ['38%', '62%'],
          center: ['50%', '44%'],
          label: { fontSize: 11, formatter: '{b} {d}%' },
          data: stats.sourceMix.map((entry, index) => ({
            name: SOURCE_LABEL[entry.kind] ?? entry.kind,
            value: entry.count,
            itemStyle: { color: SOURCE_COLORS[index % SOURCE_COLORS.length] }
          }))
        }
      ]
    }
  }, [stats])

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-3">
        <KpiCard title="时长" value={formatDuration(session.startedAt, session.endedAt || Date.now())} />
        <KpiCard title="播出段数" value={String(stats.played)} />
        <KpiCard title="评论数" value={String(stats.comments)} />
        <KpiCard title="互动观众数" value={String(stats.viewers)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">互动热度（按分钟聚合，叠播出时间轴）</p>
          {stats.heat.length === 0 ? (
            <p className="flex h-40 items-center justify-center text-xs text-muted-foreground">这场没有播出与互动记录</p>
          ) : (
            <EChart option={heatOption} className="mt-1 h-52 w-full" />
          )}
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">话术来源构成</p>
          {stats.sourceMix.length === 0 ? (
            <p className="flex h-40 items-center justify-center text-xs text-muted-foreground">这场没有播出话术</p>
          ) : (
            <EChart option={sourceOption} className="mt-1 h-52 w-full" />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">评论热词</p>
          <WordCloud words={stats.commentWords} empty="这场没有评论" className="mt-2 px-1" />
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">观众榜 TOP10</p>
          {stats.topViewers.length === 0 ? (
            <p className="flex h-24 items-center justify-center text-xs text-muted-foreground">这场没有观众互动</p>
          ) : (
            <div className="mt-2 flex flex-col">
              {stats.topViewers.map((viewer, index) => (
                <div key={viewer.name} className="flex items-center gap-2 border-t px-1 py-1.5 text-xs first:border-t-0">
                  <span className={cn('w-5 shrink-0 text-center tabular-nums', index < 3 ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{viewer.name}</span>
                  <Badge variant="secondary" className="ml-auto shrink-0">
                    {viewer.count} 条
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

type ExportPhase =
  | { kind: 'config' }
  | { kind: 'running'; current: number; total: number; title: string }
  | { kind: 'done'; result: SessionExportResult }

/** 场次音频导出弹窗：默认合并为一个文件（整场回放），可选按播出顺序分文件；与节目导出同一套 ffmpeg 管线 */
function SessionExportDialog({
  session,
  playableCount,
  open,
  onOpenChange
}: {
  session: BroadcastSession
  playableCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [mode, setMode] = useState<ProgramExportMode>('merged')
  const [format, setFormat] = useState<ProgramExportFormat>('mp3')
  const [loudness, setLoudness] = useState(false)
  const [outputDir, setOutputDir] = useState('')
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'config' })

  const running = phase.kind === 'running'

  // 这个弹窗只在 open 为 true 时挂载（父层条件渲染），每次打开都是新实例、phase 初值就是 config，
  // 所以不需要再用 effect 把 open 抄进 state

  // 进度事件复用节目导出通道：programId 字段带的是场次 id
  useEffect(() => {
    return window.api.program.onExportEvent((progress) => {
      if (progress.programId !== session.id) return
      if (progress.status === 'running') {
        setPhase({ kind: 'running', current: progress.current, total: progress.total, title: progress.title })
      }
    })
  }, [session.id])

  const pickDir = async () => {
    const dir = await window.api.program.pickExportDir()
    if (dir) setOutputDir(dir)
  }

  const start = async () => {
    if (running) return
    if (!outputDir.trim()) {
      toast.warning('先选输出目录', { description: '导出前需要一个本机目录' })
      return
    }
    setPhase({ kind: 'running', current: 0, total: playableCount, title: '准备中' })
    const result = await window.api.session.exportAudio({
      sessionId: session.id,
      mode,
      format,
      outputDir: outputDir.trim(),
      loudness
    })
    if (result.ok) {
      setPhase({ kind: 'done', result })
    } else if (result.cancelled) {
      setPhase({ kind: 'config' })
      toast.warning('导出已取消', { description: result.error })
    } else {
      setPhase({ kind: 'config' })
      toast.error('导出失败', { description: result.error })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>导出场次音频 · {session.programName}</DialogTitle>
        </DialogHeader>

        {phase.kind === 'done' ? (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm">导出完成，产出 {phase.result.files?.length ?? 0} 个文件</p>
            {phase.result.skippedStream ? (
              <p className="text-xs text-muted-foreground">
                {phase.result.skippedStream} 条流式播报不落文件，未包含在导出里
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => phase.result.outputDir && void window.api.program.openExportDir(phase.result.outputDir)}
              >
                <FolderOpen className="size-4" />
                打开目录
              </Button>
              <Button onClick={() => onOpenChange(false)}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">导出范围</span>
              <span className="text-sm text-muted-foreground">实际播出 {playableCount} 条</span>
            </div>
            {playableCount === 0 && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5" />
                这场没有可导出的播出音频（流式播报不落文件，只有合成音频能导出）
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">方式</span>
              <Select value={mode} onValueChange={(v) => setMode(v as ProgramExportMode)} disabled={running}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merged">合并为一个文件</SelectItem>
                  <SelectItem value="separate">按播出顺序分文件</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">格式</span>
              <Select value={format} onValueChange={(v) => setFormat(v as ProgramExportFormat)} disabled={running}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp3">MP3</SelectItem>
                  <SelectItem value="wav">WAV</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">统一音量（各段响度拉齐，不会忽大忽小）</span>
              <Switch checked={loudness} onCheckedChange={setLoudness} disabled={running} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">输出目录</span>
              <div className="flex items-center gap-2">
                <span className="max-w-48 truncate text-xs text-muted-foreground">{outputDir || '（未选择）'}</span>
                <Button variant="outline" size="sm" onClick={() => void pickDir()} disabled={running}>
                  选择
                </Button>
              </div>
            </div>

            {running && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span className="min-w-0 truncate">
                  {phase.current}/{phase.total} {phase.title}
                </span>
              </div>
            )}

            <DialogFooter>
              {running ? (
                <Button variant="outline" onClick={() => void window.api.program.exportCancel()}>
                  取消导出
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button onClick={() => void start()} disabled={playableCount === 0 || !outputDir.trim()}>
                    <Download className="size-4" />
                    开始导出
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
