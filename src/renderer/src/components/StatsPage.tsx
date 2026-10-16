import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EChart } from '@/components/EChart'
import { WordCloud } from '@/components/WordCloud'
import { useAppStore } from '../stores/useAppStore'
import { voiceDisplayName } from '../lib/voice'
import {
  USAGE_KIND_LABEL,
  type Program,
  type StatsGlobal,
  type TtsRecord,
  type UsageDashboard,
  type UsageRecord
} from '../../../shared/types'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** token/字符数的紧凑显示：1.2k / 3.4万 */
function formatCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 数据页：统计图表（场次/互动/热词）+ 用量看板。场次级的播出/互动/复盘明细都在「场次记录」页。 */
export function StatsPage() {
  const [tab, setTab] = useState<'overview' | 'rank' | 'usage'>('overview')
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BarChart3 className="size-4 shrink-0 text-primary" />
        <h1 className="shrink-0 text-sm font-medium">统计</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">播出与互动统计 + 全局用量（场次级明细在场次记录里）</p>
      </header>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="overview" className="px-3 text-xs">概览</TabsTrigger>
            <TabsTrigger value="rank" className="px-3 text-xs">排行与热词</TabsTrigger>
            <TabsTrigger value="usage" className="px-3 text-xs">用量</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="min-h-0 overflow-auto">
          <StatsBoard section="overview" />
        </TabsContent>
        <TabsContent value="rank" className="min-h-0 overflow-auto">
          <StatsBoard section="rank" />
        </TabsContent>
        <TabsContent value="usage" className="min-h-0 overflow-auto">
          <UsageBoard />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** 统计图的时间范围（与节目筛选组成同一套查询参数，全局图表共用） */
type StatsRange = '7' | '30' | '90' | 'all'

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: 'all', label: '全部' }
]

/** 播出/合成时长的紧凑显示 */
function formatMs(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  return `${minutes} 分钟`
}

/** 合成字符 → 时长粗估：中文 TTS 约 4 字/秒 */
function synthMs(chars: number): number {
  return (chars / 4) * 1000
}

/** 全局统计图表区（docs/REDESIGN 4.11 A）：KPI + 播出/互动趋势 + 节目/主播排行 + 热词云。
 *  按 tab 拆两块渲染（同一个组件、同一套查询参数），切 tab 时 Radix 卸载旧内容所以不会双份轮询。 */
function StatsBoard({ section }: { section: 'overview' | 'rank' }) {
  const [programs, setPrograms] = useState<Program[]>([])
  const [range, setRange] = useState<StatsRange>('30')
  const [programId, setProgramId] = useState('')
  const [stats, setStats] = useState<StatsGlobal | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    void window.api.program.list().then(setPrograms)
  }, [])

  useEffect(() => {
    const load = () => {
      const from = range === 'all' ? 0 : Date.now() - Number(range) * 24 * 3600_000
      window.api.stats
        .global({ from, programId: programId || undefined })
        .then((d) => {
          setStats(d)
          setLoadError('')
        })
        .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
    }
    load()
    // 直播在跑时场次/互动持续增长，15s 轮询让图表自己往前走（页面常驻挂载，靠轮询而不是重进刷新）
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [range, programId])

  const trendOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['场次数', '播出时长（分钟）'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: stats.trend.map((point) => point.day.slice(5)),
        axisLabel: { fontSize: 10, interval: Math.ceil(stats.trend.length / 8) }
      },
      yAxis: [
        { type: 'value' as const, minInterval: 1, axisLabel: { fontSize: 10 } },
        { type: 'value' as const, axisLabel: { fontSize: 10 } }
      ],
      series: [
        { name: '场次数', type: 'bar' as const, data: stats.trend.map((point) => point.sessions), itemStyle: { color: '#c2693f' } },
        { name: '播出时长（分钟）', type: 'line' as const, yAxisIndex: 1, smooth: true, data: stats.trend.map((point) => point.minutes), itemStyle: { color: '#4f7fa8' } }
      ]
    }
  }, [stats])

  const interactionOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['评论数', '互动观众数'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: stats.interactionTrend.map((point) => point.day.slice(5)),
        axisLabel: { fontSize: 10, interval: Math.ceil(stats.interactionTrend.length / 8) }
      },
      yAxis: { type: 'value' as const, minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        { name: '评论数', type: 'line' as const, smooth: true, data: stats.interactionTrend.map((point) => point.comments), itemStyle: { color: '#c2693f' } },
        { name: '互动观众数', type: 'line' as const, smooth: true, data: stats.interactionTrend.map((point) => point.viewers), itemStyle: { color: '#7d8a5a' } }
      ]
    }
  }, [stats])

  const byProgramOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['场次数', '总时长（分钟）', '场均评论'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 16, top: 28, bottom: 0, containLabel: true },
      xAxis: { type: 'value' as const, axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category' as const,
        inverse: true,
        data: stats.byProgram.map((entry) => entry.programName),
        axisLabel: { fontSize: 10 }
      },
      series: [
        { name: '场次数', type: 'bar' as const, data: stats.byProgram.map((entry) => entry.sessions), itemStyle: { color: '#c2693f' } },
        { name: '总时长（分钟）', type: 'bar' as const, data: stats.byProgram.map((entry) => entry.minutes), itemStyle: { color: '#4f7fa8' } },
        { name: '场均评论', type: 'bar' as const, data: stats.byProgram.map((entry) => entry.avgComments), itemStyle: { color: '#7d8a5a' } }
      ]
    }
  }, [stats])

  const byPresenterOption = useMemo(() => {
    if (!stats) return {}
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['场次数', '时长（分钟）'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 16, top: 28, bottom: 0, containLabel: true },
      xAxis: { type: 'value' as const, axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category' as const,
        inverse: true,
        data: stats.byPresenter.map((entry) => entry.personaName),
        axisLabel: { fontSize: 10 }
      },
      series: [
        { name: '场次数', type: 'bar' as const, data: stats.byPresenter.map((entry) => entry.sessions), itemStyle: { color: '#c2693f' } },
        { name: '时长（分钟）', type: 'bar' as const, data: stats.byPresenter.map((entry) => entry.minutes), itemStyle: { color: '#4f7fa8' } }
      ]
    }
  }, [stats])

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          {section === 'overview' ? '场次与互动' : '排行与热词'}
        </p>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(v) => setRange(v as StatsRange)}>
            <SelectTrigger className="h-8 w-28 shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6}>
              {RANGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={programId || '__all__'} onValueChange={(v) => setProgramId(v === '__all__' ? '' : v)}>
            <SelectTrigger className="h-8 w-44 shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6}>
              <SelectItem value="__all__">全部节目</SelectItem>
              {programs.map((program) => (
                <SelectItem key={program.id} value={program.id}>
                  {program.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loadError ? (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <p className="text-sm text-destructive">统计数据读取失败：{loadError}</p>
          <p className="text-xs text-muted-foreground">主进程可能是旧版本，重启应用后自动恢复重试</p>
        </div>
      ) : !stats ? (
        <p className="p-4 text-sm text-muted-foreground">读取统计数据…</p>
      ) : stats.totals.sessions === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <BarChart3 className="size-8 opacity-40" />
          <p className="text-sm">还没有场次，开播后这里会有图表</p>
        </div>
      ) : (
        <>
          {section === 'overview' && (
            <>
              <div className="grid grid-cols-3 gap-3 xl:grid-cols-5">
                <OverviewCard title="总场次" main={String(stats.totals.sessions)} sub={`共播出 ${stats.totals.played} 段`} />
                <OverviewCard title="总播出时长" main={formatMs(stats.totals.broadcastMs)} sub="收播场次按实际起止计" />
                <OverviewCard title="总评论数" main={formatCount(stats.totals.comments)} sub={`累计互动观众 ${stats.totals.viewers} 人`} />
                <OverviewCard
                  title="总合成时长"
                  main={`约 ${formatMs(synthMs(stats.totals.speechChars))}`}
                  sub={`共合成 ${formatCount(stats.totals.speechChars)} 字符（按 4 字/秒折算）`}
                />
                <OverviewCard title="累计观众" main={String(stats.totals.viewers)} sub="互动过的观众去重数" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <ChartCard title="播出趋势（每天场次数 + 时长）">
                  {stats.trend.every((point) => point.sessions === 0) ? (
                    <EmptyChart text="这段时间没有场次" />
                  ) : (
                    <EChart option={trendOption} className="mt-1 h-52 w-full" />
                  )}
                </ChartCard>
                <ChartCard title="互动趋势（评论数 / 互动观众数）">
                  {stats.interactionTrend.every((point) => point.comments === 0) ? (
                    <EmptyChart text="这段时间没有评论互动" />
                  ) : (
                    <EChart option={interactionOption} className="mt-1 h-52 w-full" />
                  )}
                </ChartCard>
              </div>
            </>
          )}

          {section === 'rank' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <ChartCard title="节目排行">
                  {stats.byProgram.length === 0 ? (
                    <EmptyChart text="还没有节目播出记录" />
                  ) : (
                    <EChart option={byProgramOption} className="mt-1 h-52 w-full" />
                  )}
                </ChartCard>
                <ChartCard title="主播排行">
                  {stats.byPresenter.length === 0 ? (
                    <EmptyChart text="场次没有卡司快照（老场次不记主播）" />
                  ) : (
                    <EChart option={byPresenterOption} className="mt-1 h-52 w-full" />
                  )}
                </ChartCard>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <ChartCard title="评论热词">
                  <WordCloud words={stats.commentWords} empty="这段时间没有评论" className="mt-2 px-1" />
                </ChartCard>
                <ChartCard title="话术热词">
                  <WordCloud words={stats.speechWords} empty="这段时间没有播出话术" className="mt-2 px-1" />
                </ChartCard>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

/** 用量看板：总览卡片 + 30 天趋势（双轴柱）+ 按节目分布（双轴柱）+ 明细记录表 */
function UsageBoard() {
  const voices = useAppStore((s) => s.voices)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const connections = useAppStore((s) => s.connections)
  const [programs, setPrograms] = useState<Program[]>([])
  const [programId, setProgramId] = useState('')
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null)
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([])
  const [ttsRecords, setTtsRecords] = useState<TtsRecord[]>([])
  const [recordTab, setRecordTab] = useState<'llm' | 'tts'>('llm')
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback((pid: string) => {
    const filter = pid || undefined
    window.api.stats
      .dashboard(filter)
      .then((d) => {
        setDashboard(d)
        setLoadError('')
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
    void window.api.stats.usageRecords(100, filter).then(setUsageRecords).catch(() => {})
    void window.api.stats.ttsRecords(100, filter).then(setTtsRecords).catch(() => {})
  }, [])

  useEffect(() => {
    void window.api.program.list().then(setPrograms)
  }, [])

  useEffect(() => {
    refresh(programId)
    // 直播在跑时用量持续增长，10s 轮询让看板自己往前走
    const timer = setInterval(() => refresh(programId), 10_000)
    return () => clearInterval(timer)
  }, [programId, refresh])

  /** TTS 明细的模型 id → manifest 显示名（音色反查走 voiceDisplayName） */
  const ttsModelLabel = (modelId: string): string => {
    for (const provider of ttsProviders) {
      const spec = provider.models.find((model) => model.id === modelId)
      if (spec) return spec.label
    }
    return modelId
  }

  /** LLM 明细的模型列：接入名反查 + 模型 id（接入被删了就只显示模型） */
  const llmModelLabel = (record: UsageRecord): string => {
    const name = connections.find((item) => item.id === record.connectionId)?.name
    return name ? `${name} · ${record.model}` : record.model
  }

  const programName = useMemo(() => {    const names = new Map(programs.map((program) => [program.id, program.name]))
    return (id: string | null) => (id ? (names.get(id) ?? '已删除节目') : '—')
  }, [programs])

  if (!dashboard) {
    if (loadError) {
      return (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <p className="text-sm text-destructive">用量数据读取失败：{loadError}</p>
          <p className="text-xs text-muted-foreground">主进程可能是旧版本，重启应用后自动恢复重试</p>
        </div>
      )
    }
    return <p className="p-4 text-sm text-muted-foreground">读取用量数据…</p>
  }

  const { today, total } = dashboard

  // 大脑用量与语音字数是两个量纲：双轴并列，不堆叠
  const trendOption = {
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['导演大脑（tokens）', '语音合成（字数）'], top: 0, right: 0, textStyle: { fontSize: 11 } },
    grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: dashboard.trend.map((point) => point.day.slice(5)),
      axisLabel: { fontSize: 10, interval: 4 }
    },
    yAxis: [
      { type: 'value' as const, axisLabel: { fontSize: 10, formatter: (v: number) => formatCount(v) } },
      { type: 'value' as const, axisLabel: { fontSize: 10, formatter: (v: number) => formatCount(v) } }
    ],
    series: [
      { name: '导演大脑（tokens）', type: 'bar' as const, data: dashboard.trend.map((point) => point.llmTokens), itemStyle: { color: '#c2693f' } },
      { name: '语音合成（字数）', type: 'bar' as const, yAxisIndex: 1, data: dashboard.trend.map((point) => point.ttsChars), itemStyle: { color: '#7d8a5a' } }
    ]
  }

  const byProgramOption = {
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['导演大脑（tokens）', '语音合成（字数）'], top: 0, right: 0, textStyle: { fontSize: 11 } },
    grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: dashboard.byProgram.map((entry) => entry.programName),
      axisLabel: { fontSize: 10, interval: 0, rotate: dashboard.byProgram.length > 4 ? 24 : 0 }
    },
    yAxis: [
      { type: 'value' as const, axisLabel: { fontSize: 10, formatter: (v: number) => formatCount(v) } },
      { type: 'value' as const, axisLabel: { fontSize: 10, formatter: (v: number) => formatCount(v) } }
    ],
    series: [
      { name: '导演大脑（tokens）', type: 'bar' as const, data: dashboard.byProgram.map((entry) => entry.llmTokens), itemStyle: { color: '#c2693f' } },
      { name: '语音合成（字数）', type: 'bar' as const, yAxisIndex: 1, data: dashboard.byProgram.map((entry) => entry.ttsChars), itemStyle: { color: '#7d8a5a' } }
    ]
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          大脑用量按服务商回报统计（tokens 是服务商的计费单位，没回报的按字数估算并标「估算」）；语音按合成的字数记
        </p>
        <Select value={programId || '__all__'} onValueChange={(v) => setProgramId(v === '__all__' ? '' : v)}>
          <SelectTrigger className="h-8 w-44 shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" sideOffset={6}>
            <SelectItem value="__all__">全部节目</SelectItem>
            {programs.map((program) => (
              <SelectItem key={program.id} value={program.id}>
                {program.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <OverviewCard
          title="今日大脑用量"
          main={formatCount(today.llmInputTokens + today.llmOutputTokens)}
          sub={`输入 ${formatCount(today.llmInputTokens)} · 输出 ${formatCount(today.llmOutputTokens)} · 缓存命中 ${formatCount(today.llmCacheRead)}`}
        />
        <OverviewCard
          title="累计大脑用量"
          main={formatCount(total.llmInputTokens + total.llmOutputTokens)}
          sub={`输入 ${formatCount(total.llmInputTokens)} · 输出 ${formatCount(total.llmOutputTokens)} · 缓存命中 ${formatCount(total.llmCacheRead)}`}
        />
        <OverviewCard
          title="今日语音合成"
          main={formatCount(today.ttsChars)}
          sub={`累计 ${formatCount(total.ttsChars)} 字`}
        />
        <OverviewCard
          title="累计语音合成"
          main={formatCount(total.ttsChars)}
          sub={`今日 ${formatCount(today.ttsChars)} 字`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">近 30 天用量趋势</p>
          {dashboard.trend.every((point) => point.llmTokens === 0 && point.ttsChars === 0) ? (
            <EmptyChart text="近 30 天还没有用量记录" />
          ) : (
            <EChart option={trendOption} className="mt-1 h-48 w-full" />
          )}
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">按节目分布（累计）</p>
          {dashboard.byProgram.length === 0 ? (
            <EmptyChart text="还没有按节目归集的用量记录" />
          ) : (
            <EChart option={byProgramOption} className="mt-1 h-48 w-full" />
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Tabs value={recordTab} onValueChange={(v) => setRecordTab(v as typeof recordTab)} className="gap-0">
          <div className="flex items-center justify-between border-b px-3 pt-2">
            <TabsList variant="line">
              <TabsTrigger value="llm" className="px-3 text-xs">LLM 请求 · {usageRecords.length}</TabsTrigger>
              <TabsTrigger value="tts" className="px-3 text-xs">TTS 合成 · {ttsRecords.length}</TabsTrigger>
            </TabsList>
            <span className="pb-1 text-[11px] text-muted-foreground">最近 100 条</span>
          </div>
          <TabsContent value="llm" className="max-h-72 overflow-auto">
            {usageRecords.length === 0 ? (
              <EmptyChart text="还没有 LLM 请求记录。主播说过话之后这里就有了" />
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    <Th>时间</Th>
                    <Th>节目</Th>
                    <Th>用途</Th>
                    <Th>模型</Th>
                    <Th className="text-right">输入</Th>
                    <Th className="text-right">输出</Th>
                    <Th className="text-right">缓存命中</Th>
                  </tr>
                </thead>
                <tbody>
                  {usageRecords.map((record) => (
                    <tr key={record.id} className="border-t">
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.ts)}</Td>
                      <Td className="max-w-28 truncate">{programName(record.programId)}</Td>
                      <Td>
                        <Badge variant="outline" className="text-[11px]">
                          {USAGE_KIND_LABEL[record.kind] ?? record.kind}
                        </Badge>
                        {record.estimated && (
                          <Badge variant="outline" className="ml-1 text-[11px] text-amber-600">
                            估算
                          </Badge>
                        )}
                      </Td>
                      <Td className="max-w-36 truncate" title={record.model}>{llmModelLabel(record)}</Td>
                      <Td className="text-right tabular-nums">{formatCount(record.inputTokens)}</Td>
                      <Td className="text-right tabular-nums">{formatCount(record.outputTokens)}</Td>
                      <Td className="text-right tabular-nums">
                        {record.cacheRead > 0 ? formatCount(record.cacheRead) : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>
          <TabsContent value="tts" className="max-h-72 overflow-auto">
            {ttsRecords.length === 0 ? (
              <EmptyChart text="还没有 TTS 合成记录。合成过声音之后这里就有了" />
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    <Th>时间</Th>
                    <Th>节目</Th>
                    <Th>模型</Th>
                    <Th>音色</Th>
                    <Th className="text-right">字符数</Th>
                  </tr>
                </thead>
                <tbody>
                  {ttsRecords.map((record) => (
                    <tr key={record.id} className="border-t">
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.ts)}</Td>
                      <Td className="max-w-28 truncate">{programName(record.programId)}</Td>
                      <Td className="max-w-36 truncate">{ttsModelLabel(record.modelId)}</Td>
                      <Td className="max-w-28 truncate">{voiceDisplayName(voices, ttsProviders, record.voiceId)}</Td>
                      <Td className="text-right tabular-nums">{formatCount(record.chars)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function OverviewCard({ title, main, sub }: { title: string; main: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Activity className="size-3" />
        {title}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{main}</p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={sub}>
        {sub}
      </p>
    </div>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>
}

function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-1.5 ${className}`} title={title}>{children}</td>
}

function EmptyChart({ text }: { text: string }) {
  return (
    <p className="flex h-32 items-center justify-center text-xs text-muted-foreground">{text}</p>
  )
}
