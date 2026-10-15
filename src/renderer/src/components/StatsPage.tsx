import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, NotebookText, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EChart } from '@/components/EChart'
import {
  USAGE_KIND_LABEL,
  type EpisodeSummary,
  type Program,
  type TtsRecord,
  type UsageDashboard,
  type UsageRecord,
  type ViewerProfile
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

/** 数据页：观众画像 / 节目摘要 / 用量看板，选项卡组织（事件时间线已并入播控台「事件流」）。 */
export function StatsPage() {
  const [viewers, setViewers] = useState<ViewerProfile[]>([])
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([])
  const [tab, setTab] = useState<'viewers' | 'episodes' | 'usage'>('viewers')

  useEffect(() => {
    void window.api.memory.viewers().then(setViewers)
    void window.api.memory.episodes().then(setEpisodes)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BarChart3 className="size-4 text-primary" />
        <h1 className="text-sm font-medium">数据</h1>
        <p className="text-xs text-muted-foreground">观众画像 · 节目摘要 · 用量看板</p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="viewers" className="px-3">观众画像 · {viewers.length}</TabsTrigger>
            <TabsTrigger value="episodes" className="px-3">节目摘要 · {episodes.length}</TabsTrigger>
            <TabsTrigger value="usage" className="px-3">用量看板</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="viewers" className="overflow-auto p-4">
          {viewers.length === 0 ? (
            <EmptyState icon={Users} text="还没有画像。开播后观众来互动，主播会自动记住他们" />
          ) : (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {viewers.map((viewer) => (
                <div key={viewer.name} className="rounded-lg border bg-card px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{viewer.name}</span>
                    <Badge variant="secondary">互动 {viewer.interactions}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">最近互动 {formatTime(viewer.lastSeenAt)}</p>
                  {viewer.asks.length > 0 && (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={viewer.asks.join('\n')}>
                      问过：{viewer.asks.slice(0, 2).join('；')}
                    </p>
                  )}
                  {viewer.notes.length > 0 && (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={viewer.notes.join('\n')}>
                      备注：{viewer.notes.slice(0, 2).join('；')}
                    </p>
                  )}
                  {viewer.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {viewer.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="episodes" className="overflow-auto p-4">
          {episodes.length === 0 ? (
            <EmptyState icon={NotebookText} text="还没有摘要。主播下播时会自动复盘本场亮点和高频问题" />
          ) : (
            <div className="flex flex-col gap-2">
              {episodes.map((episode) => (
                <div key={episode.id} className="rounded-lg border bg-card px-3 py-2.5">
                  <p className="text-xs text-muted-foreground">
                    {formatTime(episode.startedAt)} 开播 · 播了 {Math.max(1, Math.round((episode.endedAt - episode.startedAt) / 60000))} 分钟
                  </p>
                  <p className="mt-1 text-[13px] leading-6">{episode.summary}</p>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="usage" className="min-h-0 overflow-auto">
          {tab === 'usage' && <UsageBoard />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** 用量看板：总览卡片 + 30 天趋势（双轴柱）+ 按节目分布（双轴柱）+ 明细记录表 */
function UsageBoard() {
  const [programs, setPrograms] = useState<Program[]>([])
  const [programId, setProgramId] = useState('')
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null)
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([])
  const [ttsRecords, setTtsRecords] = useState<TtsRecord[]>([])
  const [recordTab, setRecordTab] = useState<'llm' | 'tts'>('llm')

  const refresh = useCallback((pid: string) => {
    const filter = pid || undefined
    void window.api.stats.dashboard(filter).then(setDashboard)
    void window.api.stats.usageRecords(100, filter).then(setUsageRecords)
    void window.api.stats.ttsRecords(100, filter).then(setTtsRecords)
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

  const programName = useMemo(() => {
    const names = new Map(programs.map((program) => [program.id, program.name]))
    return (id: string | null) => (id ? (names.get(id) ?? '已删除节目') : '—')
  }, [programs])

  if (!dashboard) {
    return <p className="p-4 text-sm text-muted-foreground">读取用量数据…</p>
  }

  const { today, total } = dashboard

  // tokens 与字符是两个量纲：双轴并列，不堆叠
  const trendOption = {
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['LLM tokens', 'TTS 字符'], top: 0, right: 0, textStyle: { fontSize: 11 } },
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
      { name: 'LLM tokens', type: 'bar' as const, data: dashboard.trend.map((point) => point.llmTokens), itemStyle: { color: '#c2693f' } },
      { name: 'TTS 字符', type: 'bar' as const, yAxisIndex: 1, data: dashboard.trend.map((point) => point.ttsChars), itemStyle: { color: '#7d8a5a' } }
    ]
  }

  const byProgramOption = {
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['LLM tokens', 'TTS 字符'], top: 0, right: 0, textStyle: { fontSize: 11 } },
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
      { name: 'LLM tokens', type: 'bar' as const, data: dashboard.byProgram.map((entry) => entry.llmTokens), itemStyle: { color: '#c2693f' } },
      { name: 'TTS 字符', type: 'bar' as const, yAxisIndex: 1, data: dashboard.byProgram.map((entry) => entry.ttsChars), itemStyle: { color: '#7d8a5a' } }
    ]
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          只统计用量：token 是服务商回报的真实用量（没回 usage 的按字符估算并标「估算」），TTS 按送进合成的字符数记
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
          title="今日 LLM tokens"
          main={formatCount(today.llmInputTokens + today.llmOutputTokens)}
          sub={`输入 ${formatCount(today.llmInputTokens)} · 输出 ${formatCount(today.llmOutputTokens)} · 缓存命中 ${formatCount(today.llmCacheRead)}`}
        />
        <OverviewCard
          title="累计 LLM tokens"
          main={formatCount(total.llmInputTokens + total.llmOutputTokens)}
          sub={`输入 ${formatCount(total.llmInputTokens)} · 输出 ${formatCount(total.llmOutputTokens)} · 缓存命中 ${formatCount(total.llmCacheRead)}`}
        />
        <OverviewCard
          title="今日 TTS 字符"
          main={formatCount(today.ttsChars)}
          sub={`累计 ${formatCount(total.ttsChars)}`}
        />
        <OverviewCard
          title="累计 TTS 字符"
          main={formatCount(total.ttsChars)}
          sub={`今日 ${formatCount(today.ttsChars)}`}
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
                      <Td className="max-w-36 truncate font-mono">{record.model}</Td>
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
                      <Td className="max-w-36 truncate font-mono">{record.modelId}</Td>
                      <Td className="max-w-28 truncate">{record.voiceId}</Td>
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

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>
}

function EmptyChart({ text }: { text: string }) {
  return (
    <p className="flex h-32 items-center justify-center text-xs text-muted-foreground">{text}</p>
  )
}

function EmptyState({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
      <Icon className="size-8" strokeWidth={1.25} />
      <p className="text-sm">{text}</p>
    </div>
  )
}
