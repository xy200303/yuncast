import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  AudioWaveform,
  Bot,
  Brain,
  CheckCircle2,
  Check,
  ChevronRight,
  Copy,
  Eraser,
  Loader2,
  Paperclip,
  Play,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/Markdown'
import { VoiceProviderHint } from '@/components/VoiceProviderHint'
import { AutoResponsePicker } from './live/AutoResponsePicker'
import { DraftMinutesDialog } from '@/components/DraftMinutesDialog'
import { ProgramGateDialog } from '@/components/ProgramGateDialog'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { VoicePickDialog } from '@/components/VoicePickDialog'
import { useAppStore, type NavPage, type SettingsPaneId } from '../stores/useAppStore'
import { useLiveStore } from '../stores/useLiveStore'
import { useDataRefresh } from '../lib/useDataRefresh'
import { audioEngine } from '../audio/engine'
import { pauseBroadcast, resumeBroadcast } from '../audio/liveControl'
import { AssetStaleBanner } from './AssetStaleBanner'
import { CommentList } from './live/CommentList'
import { EventStream } from './live/EventStream'
import { NowPlayingBar } from './live/NowPlayingBar'
import { CardStream } from './live/CardStream'
import { LaunchConfigDialog, type LaunchConfig } from './live/LaunchConfigDialog'
import { WorkbenchTopBar, type DrawerTab } from './live/WorkbenchTopBar'
import { WorkbenchDrawer } from './live/WorkbenchDrawer'
import { CONTENT_TYPE_LABELS, llmReady } from '../../../shared/types'
import type {
  ChatEntry,
  DirectorMessage,
  LiveComment,
  LiveInboxEvent,
  Program,
  PreflightItem,
  ProduceVoiceOverride,
  ProgramGateResult,
  PoolItem,
  SessionConfig
} from '../../../shared/types'

/**
 * 预检「去修复」深链：按检查项 code 跳到对应设置栏目。
 * 主播卡/剧本都不再是资产：缺嗓子的修复口是项目的开播配置，缺编排的修复口是导演对话。
 */
const PREFLIGHT_FIX: Record<string, { label: string; pane?: SettingsPaneId; page?: NavPage }> = {
  'director-brain': { label: '去配大脑', pane: 'director' },
  'tts-broken': { label: '去检查合成', pane: 'tts' },
  'voice-test': { label: '去测发音', pane: 'tts' },
  connector: { label: '去连接', pane: 'comment' },
  stream: { label: '去推流设置', pane: 'stream' }
}

export function LivePage() {
  const pool = useAppStore((s) => s.pool)
  /** 主区标签：接下来（卡片流）/ 评论流 / 事件流——常驻可切换 */
  const [mainTab, setMainTab] = useState<'pool' | 'comments' | 'events'>('pool')
  /** 清空确认：稿子 / 音频 */
  const [confirmClear, setConfirmClear] = useState<'drafts' | 'audio' | null>(null)
  const [clearing, setClearing] = useState(false)
  const [synthing, setSynthing] = useState(false)
  /** 工作台抽屉：剧本大纲 / 章节 / 互动（docs/12 §7，平时不占版面） */
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [comments, setComments] = useState<LiveComment[]>([])
  /** 发给主播的直播间动态（事件流选项卡；主进程 250ms 节流推快照） */
  const [inboxEvents, setInboxEvents] = useState<LiveInboxEvent[]>([])
  /** 节目控制（选择/启动/暂停/结束 + 预检与门禁弹窗）：activeProgram 也由它给，只有一处真值 */
  const programControl = useProgramLauncher()
  // 已播历史与底稿的加载放在页面级（底栏水位/卡片流都要用，挂在卡片流里预制模式会拿不到历史）
  const loadHistory = useLiveStore((s) => s.loadHistory)
  const loadDrafts = useLiveStore((s) => s.loadDrafts)
  const agentLive = useAppStore((s) => s.agent.live === true)
  const activeId = useAppStore((s) => s.config.live.activeProgramId)
  const poolSize = useAppStore((s) => s.pool.items.length)
  useEffect(() => {
    if (agentLive) void loadHistory()
  }, [agentLive, loadHistory, activeId, poolSize])
  useEffect(() => {
    // 开播后也要留着：卡片流按稿子顺序排位置，没有底稿就只能按播放历史排（循环后顺序会跳）
    void loadDrafts(activeId)
  }, [activeId, loadDrafts])
  // 导演写稿是一段一段入库的：本剧本的底稿变了就重拉，卡片流不用手动刷新
  useDataRefresh(['drafts'], (_scope, detail) => {
    if (detail && detail !== activeId) return
    void loadDrafts(activeId)
  })

  /** 本场配置落库（写稿/合成/播放三段共用）：只存配置，不做动作 */
  const persistLaunchConfig = async (config: LaunchConfig): Promise<boolean> => {
    const program = programControl.activeProgram
    if (!program) return false
    // 互动接线归顶栏「自动响应」管（它会实时改），这边存的是开播快照——
    // 用库里的当前值覆盖，别让一份旧快照把用户刚调好的开关顶回去
    const latest = await window.api.sessionConfig.latest(program.id)
    const saved = await window.api.sessionConfig.save({
      ...config,
      programId: program.id,
      allowLiveEvents: latest?.allowLiveEvents ?? config.allowLiveEvents,
      enabledTriggerIds: latest?.enabledTriggerIds ?? config.enabledTriggerIds
    })
    if (!saved.ok) {
      toast.error('本场配置没保存', { description: saved.error })
      return false
    }
    programControl.setSession(saved.config)
    if (config.audioPolicy === 'rebuild') {
      const cleared = await window.api.draftUnit.clearAudio(program.id)
      if (!cleared.ok) {
        toast.error('清空音频失败', { description: cleared.error })
        return false
      }
      toast.message('已清空本节目音频', { description: `共 ${cleared.item ?? 0} 段，开播后按本场音色重新合成` })
    }
    return true
  }

  /** 写稿：存配置 → 让导演按项目写（不合成、不开播） */
  const writeFromConfig = async (config: LaunchConfig): Promise<void> => {
    const state = useAppStore.getState()
    if (!llmReady(state.connections, state.config.director)) {
      toast.error('还没有配置导演模型', { description: '先去 设置 → 语言模型 配一个接入，再让导演写稿' })
      state.openSettings('llm')
      return
    }
    const program = programControl.activeProgram
    if (program && writeBrief.trim() !== program.theme) {
      await window.api.program.save(
        {
          name: program.name,
          theme: writeBrief.trim(),
          plan: program.plan,
          knowledgeScope: program.knowledgeScope
        },
        program.id
      )
    }
    if (!(await persistLaunchConfig(config))) return
    programControl.setLaunchConfigOpen(false)
    programControl.startDraft()
  }

  /** 合成：存配置 → 批量合成未就绪的段落（后台跑） */
  const synthesizeFromConfig = async (config: LaunchConfig): Promise<void> => {
    const program = programControl.activeProgram
    const state = useAppStore.getState()
    if (!state.ttsConnections.some((connection) => connection.ready)) {
      toast.error('还没有可用的语音合成接入', { description: '先去 设置 → 语音合成 配一个接入，再合成音频' })
      state.openSettings('tts')
      return
    }
    if (!program || !(await persistLaunchConfig(config))) return
    programControl.setLaunchConfigOpen(false)
    const result = await window.api.program.produceAudio(program.id)
    if (!result.ok) toast.error('合成没能开始', { description: result.error })
    else toast.success('已开始批量合成', { description: '进度显示在卡片上' })
  }

  /** 播放：存配置 → 开播 */
  const applyLaunchConfig = async (config: LaunchConfig): Promise<void> => {
    if (!(await persistLaunchConfig(config))) return
    programControl.setLaunchConfigOpen(false)
    void programControl.start()
  }
  const [draftCounts, setDraftCounts] = useState({ draft: 0, ready: 0 })
  /** 写稿要求：跟随项目简介，开写前存回项目 */
  const [writeBrief, setWriteBrief] = useState('')
  useEffect(() => {
    setWriteBrief(programControl.activeProgram?.theme ?? '')
  }, [programControl.activeProgram?.id])

  /** 下一步：没稿 → 写稿；没音频 → 合成；都齐 → 播放 */
  const nextStep: 'write' | 'synth' | 'play' =
    draftCounts.draft === 0 ? 'write' : draftCounts.ready === 0 ? 'synth' : 'play'
  const primaryLaunchAction = (
    <Button
      size="sm"
      disabled={!programControl.activeProgram}
      onClick={() => programControl.openLaunchConfig(nextStep)}
      title={
        nextStep === 'write'
          ? '本场还没有稿子：先让导演按项目写一版'
          : nextStep === 'synth'
            ? '稿子写好了还没有音频：先选音色、合成一段试听'
            : '稿子和音频都就绪：确认播放方式后开播'
      }
    >
      <Play />
      {nextStep === 'write' ? '写稿' : nextStep === 'synth' ? '合成' : '启动直播'}
    </Button>
  )
  useEffect(() => {
    const programId = programControl.activeProgram?.id
    if (!programId) {
      setDraftCounts({ draft: 0, ready: 0 })
      return
    }
    const load = () =>
      void window.api.draftUnit.list(programId).then((list) => {
        setDraftCounts({
          draft: list.length,
          ready: list.filter((unit) => unit.rendered?.status === 'ready').length
        })
      })
    load()
    // 写稿/合成一有结果就刷新：步骤条能自动走完一项进下一项
    // 合成状态变化（单段/批量）也要让卡片流跟着变：刷新计数 + 刷新底稿列表
    const off = window.api.draftUnit.onEvent(() => {
      load()
      void loadDrafts(programId)
    })
    return () => off()
  }, [programControl.activeProgram?.id, programControl.launchConfigOpen])
  const activeProgram = programControl.activeProgram

  // 评论订阅提到页面层（抽屉里要显示条数），保持最近 100 条
  useEffect(() => {
    if (!('api' in window)) return
    return window.api.comment.onComment((comment) => {
      setComments((prev) => [...prev.slice(-99), comment])
    })
  }, [])

  // 事件流：先拉快照，再订阅变更（主进程已节流）
  useEffect(() => {
    if (!('api' in window)) return
    void window.api.agent.inboxList().then(setInboxEvents)
    return window.api.agent.onInbox(setInboxEvents)
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


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶栏 · 本场配置（docs/12 §7）：剧本 / 主播 / 语言 / 预设，⋯ 收导演、大纲、评论事件、推流互动 */}
      <WorkbenchTopBar
        program={activeProgram}
        session={programControl.session}
        running={programControl.running}
        prepared={programControl.session?.synthMode === 'pre'}
        onConfigure={() => programControl.setLaunchConfigOpen(true)}
        onOpenDrawer={setDrawer}
        onOpenDirector={() => useAppStore.getState().openAgentPanel()}
        onManualBroadcast={() => setManualOpen(true)}
        onOpenStreamSettings={() => useAppStore.getState().openSettings('stream')}
        onFocusQueue={() => {
          setMainTab('pool')
          window.setTimeout(() => {
            const list = document.getElementById('up-next-list')
            const target = document.querySelector('[data-playing="true"]')
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
            else list?.scrollTo({ top: 0, behavior: 'smooth' })
          }, 80)
        }}
      />

      {/* 资产改过但本场会话还是旧的：都在这里给「立即应用」 */}
      <AssetStaleBanner />

      {/* 主体：接下来（段落卡片流）/ 评论流 / 事件流。
          卡片流一段一张卡、正文全文可见（docs/12 第七、八节）；评论/事件常驻可切换，不等同于抽屉 */}
      <Tabs
        value={mainTab}
        onValueChange={(value) => setMainTab(value as typeof mainTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex shrink-0 items-end gap-2 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="pool" className="px-3 text-xs">
              接下来{pool.items.length > 0 ? ` · ${pool.items.length}` : ''}
            </TabsTrigger>
            <TabsTrigger value="comments" className="px-3 text-xs">
              评论流 · {comments.length}
            </TabsTrigger>
            <TabsTrigger
              value="events"
              className="px-3 text-xs"
              title="发给主播的直播间动态（评论、礼物、系统通知）"
            >
              事件流 · {inboxEvents.filter((event) => event.state === 'new' || event.state === 'seen').length}
            </TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 px-2 text-xs"
            disabled={!programControl.activeProgram || programControl.running}
            title="打开写稿配置，让导演按项目写一版"
            onClick={() => programControl.openLaunchConfig('write')}
          >
            <Sparkles className="size-3.5" />
            生成底稿
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!programControl.activeProgram || programControl.running || draftCounts.draft === 0}
            title={draftCounts.draft === 0 ? '还没有稿子' : '清空本场全部底稿（不可恢复）'}
            onClick={() => setConfirmClear('drafts')}
          >
            <Eraser className="size-3.5" />
            清空稿子
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!programControl.activeProgram || programControl.running || draftCounts.ready === 0}
            title={draftCounts.ready === 0 ? '还没有已合成的音频' : '清空本场已合成的音频（文稿保留）'}
            onClick={() => setConfirmClear('audio')}
          >
            <Trash2 className="size-3.5" />
            清空音频
          </Button>
        </div>
        <TabsContent value="pool" className="min-h-0 data-[state=active]:flex data-[state=active]:flex-col">
          <CardStream />
        </TabsContent>
        <TabsContent value="comments" className="min-h-0 data-[state=active]:flex data-[state=active]:flex-col">
          <CommentList comments={comments} />
        </TabsContent>
        <TabsContent value="events" className="min-h-0 data-[state=active]:flex data-[state=active]:flex-col">
          <EventStream events={inboxEvents} />
        </TabsContent>
      </Tabs>

      {/* 底栏 · 音乐播放器式：播放/暂停、03/23、分段水位、还能播多久、音量、跳过、更多、结束本场。
          剧本/主播/语言/预设只在顶栏，这里不重复。 */}
      <div className="shrink-0 border-t bg-card/60">
        <NowPlayingBar
          program={activeProgram}
          launchAction={primaryLaunchAction}
          endAction={programControl.endAction}
        />
      </div>

      {/* 抽屉：剧本大纲 / 评论 / 事件 / 章节 / 互动 */}
      <WorkbenchDrawer
        open={drawer !== null}
        tab={drawer ?? 'scenes'}
        onTab={setDrawer}
        onClose={() => setDrawer(null)}
        program={activeProgram}
        session={programControl.session}
        prepared={programControl.session?.synthMode === 'pre'}
        onSessionSaved={programControl.setSession}
      />

      {/* 预检 / 开播确认 / 结束确认 / 底稿 / 声音选择 / 预制门禁：都挂在页面根部 */}
      {programControl.dialogs}
      <Dialog open={confirmClear !== null} onOpenChange={(next) => !next && !clearing && setConfirmClear(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{confirmClear === 'drafts' ? '清空稿子？' : '清空音频？'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmClear === 'drafts'
              ? '会删掉本场全部底稿（含已合成音频），不可恢复。已经开播的场次记录不受影响。'
              : '只删已合成的音频，文稿保留；之后可以按当前音色重新合成。'}
          </p>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="ghost" disabled={clearing} onClick={() => setConfirmClear(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={clearing}
              onClick={() => {
                const id = programControl.activeProgram?.id
                if (!id || !confirmClear) return
                setClearing(true)
                const run =
                  confirmClear === 'drafts'
                    ? window.api.draftUnit.clear(id)
                    : window.api.draftUnit.clearAudio(id)
                void run
                  .then(async (result) => {
                    if (!result.ok) {
                      toast.error('清空失败', { description: result.error })
                      return
                    }
                    toast.success(confirmClear === 'drafts' ? '已清空稿子' : '已清空音频')
                    await loadDrafts(id)
                    setConfirmClear(null)
                  })
                  .finally(() => setClearing(false))
              }}
            >
              {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ManualBroadcastDialog open={manualOpen} onOpenChange={setManualOpen} />
      <LaunchConfigDialog
        open={programControl.launchConfigOpen}
        program={activeProgram}
        session={programControl.session}
        draftCount={draftCounts.draft}
        readyCount={draftCounts.ready}
        defaultTab={programControl.launchTab}
        launching={programControl.busy}
        brief={writeBrief}
        onBriefChange={setWriteBrief}
        onCancel={() => programControl.setLaunchConfigOpen(false)}
        onWrite={(config: LaunchConfig) => void writeFromConfig(config)}
        onSynthesize={(config: LaunchConfig) => void synthesizeFromConfig(config)}
        onConfirm={(config: LaunchConfig) => void applyLaunchConfig(config)}
      />
    </div>
  )
}

/**
 * 节目控制（选择 / 启动 / 暂停 / 结束 + 预检与门禁弹窗）。
 * 原来是顶栏里的 ProgramLauncher：现在拆成几块塞进吸底播放条——左槽节目选择、中槽启动或用传输控制、
 * 中槽右侧结束本场；弹窗仍挂在页面根部。状态收在一处，避免多处各存一份。
 */
function useProgramLauncher() {
  const agent = useAppStore((s) => s.agent)
  const director = useAppStore((s) => s.config.director)
  const activeProgramId = useAppStore((s) => s.config.live.activeProgramId)
  const [programs, setPrograms] = useState<Program[]>([])
  /** 本场配置（最近一次）：卡司/语言/互动/收尾都以它为准；开播配置确认后更新 */
  const [session, setSession] = useState<SessionConfig | null>(null)
  /** 触发器清单（开播配置里的互动勾选用） */
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<PreflightItem[] | null>(null)
  /** 预制节目门禁未过的结构化结果（不空就不许静默开播，弹窗给三选项） */
  const [gate, setGate] = useState<ProgramGateResult | null>(null)
  const [draftAsk, setDraftAsk] = useState(false)
  /** 开播预检「提前合成」的声音选择弹窗（docs/REDESIGN 4.4） */
  const [voicePickOpen, setVoicePickOpen] = useState(false)
  /** 「结束本场」二次确认：收场是不可逆的重操作，跟「暂停」分开 */
  const [stopAsk, setStopAsk] = useState(false)
  /** 开播配置弹窗开合（点「启动节目」先过这一屏） */
  const [launchConfigOpen, setLaunchConfigOpen] = useState(false)
  /** 开播配置打开时落在哪一段（写稿 / 合成 / 播放） */
  const [launchTab, setLaunchTab] = useState<'write' | 'synth' | 'play'>('write')

  /**
   * 节目列表 + 卡司列表。页面是常驻不卸载的（App 用显隐切页），所以不能只在挂载时拉一次——
   * 在节目页改了名字/删了节目再回直播台，看到的就是旧清单（曾把已删节目当"当前节目"显示）。
   */
  const loadPrograms = useCallback(async (): Promise<Program[]> => {
    const programList = await window.api.program.list()
    setPrograms(programList)
    return programList
  }, [])

  const page = useAppStore((s) => s.page)
  useEffect(() => {
    if (page === 'live') void loadPrograms()
    // 切项目 = 换一个库：activeProgramId 变了必须重拉，否则顶栏/卡片流还停在上一本
  }, [page, activeProgramId, loadPrograms])

  // 本场配置跟着当前节目走（切节目/开播配置保存后都重拉）
  useEffect(() => {
    if (!activeProgramId) {
      setSession(null)
      return
    }
    setSession((prev) => (prev && prev.programId === activeProgramId ? prev : null))
    void window.api.sessionConfig.latest(activeProgramId).then((next) =>
      setSession((prev) => (prev?.id === next?.id ? prev : next))
    )
  }, [activeProgramId, page])

  /** 直播中的判定：开播态归引擎（agent.live）——主播会话没起来也照播存量，不算没开播 */
  const running = agent.live === true
  const activeProgram = programs.find((p) => p.id === activeProgramId) ?? null


  const blocked = (checks ?? []).some((item) => item.level === 'block')
  /** 底稿管线动作入口（code 驱动按钮）：没写 → 去生成底稿；写了没合成 → 预合成全部 */
  const draftEmpty = (checks ?? []).some((item) => item.code === 'draft-empty')
  const presynthShort = (checks ?? []).some((item) => item.code === 'presynth')

  const patchProgram = (saved: Program): void =>
    setPrograms((prev) => prev.map((p) => (p.id === saved.id ? saved : p)))

  const goGenerate = (): void => {
    if (!activeProgramId) return
    setChecks(null)
    setDraftAsk(true)
  }

  const startPresynth = (): void => {
    if (!activeProgramId) return
    // 合成入口统一先过声音选择弹窗（docs/REDESIGN 4.4），确认后才发起
    setVoicePickOpen(true)
  }

  const confirmPresynth = async (voiceOverride?: ProduceVoiceOverride, rebuildAll?: boolean): Promise<void> => {
    if (!activeProgramId) return
    setVoicePickOpen(false)
    if (rebuildAll) await window.api.draftUnit.clearAudio(activeProgramId)
    // 滚动节目走统一音频生产入口（produceAudio 的 rolling 分支 = 后台逐段提前合成）
    const result = await window.api.program.produceAudio(activeProgramId, voiceOverride)
    if (!result.ok) toast.error('提前合成没能开始', { description: result.error })
    else toast.success('已开始提前合成', { description: '合成在后台跑，完成后点「重新预检」看结果' })
  }

  const startDraft = (): void => {
    if (!activeProgramId || !activeProgram) return
    useAppStore.getState().openAgentPanel({ kind: 'draft', programId: activeProgramId })
    // 顶栏当下选的参数随任务书发过去：会话里的 system prompt 可能是切换语言之前生的
    void window.api.agent
      .draftStart(activeProgramId, {
        language: session?.language,
        instruction: session?.instruction,
        contentType: session?.contentType,
        endMode: session?.endMode
      })
      .then((result) => {
        if (!result.ok) toast.error('导演没能开始写稿', { description: result.error })
      })
  }

  const switchProgram = async (id: string): Promise<void> => {
    // 切之前重拉一次清单：本地这份可能是旧的（剧本刚在剧本页被删/改名），
    // 直接照着旧清单切会"切到一个已经不存在的剧本"还弹成功提示
    const program = (await loadPrograms()).find((p) => p.id === id)
    if (!program) {
      toast.error('这本剧本已经不在了', { description: '清单已刷新，重新选一个' })
      return
    }
    await window.api.program.setActive(id)
    await useAppStore.getState().loadConfig()
    toast.success(`已切换到剧本：${program.name}`, {
      description: running ? '结构性变更下次开播生效' : undefined
    })
  }

  const runPreflight = async (): Promise<void> => {
    if (!activeProgramId) return
    setChecking(true)
    try {
      setChecks(await window.api.program.preflight(activeProgramId))
    } finally {
      setChecking(false)
    }
  }

  /** 预检「去修复」：按检查项 code 深链到对应设置栏目/页面 */
  const goFix = (code: string): void => {
    const fix = PREFLIGHT_FIX[code]
    if (!fix) return
    setChecks(null)
    if (fix.pane) useAppStore.getState().openSettings(fix.pane)
    else if (fix.page) useAppStore.getState().setPage(fix.page)
  }

  const openPreflight = async (): Promise<void> => {
    if (!activeProgramId) {
      toast.warning('先打开一个项目', { description: '场次、稿子与声音都在项目里' })
      return
    }
    await runPreflight()
  }

  const start = async (): Promise<void> => {
    if (busy || !activeProgramId) return
    setBusy(true)
    try {
      const result = await window.api.program.launch(activeProgramId)
      if (result.ok) {
        setChecks(null)
        // 新一场从「播报中」开始（上一场可能是暂停状态停掉的）
        resumeBroadcast()
        if (result.warning) {
          toast.warning(`直播已启动：${activeProgram?.name ?? ''}（主播还没就位）`, {
            description: result.warning
          })
        } else {
          toast.success(`直播已启动：${activeProgram?.name ?? ''}`, {
            description: result.loaded
              ? `已装载 ${result.loaded} 个播出单元，接着播`
              : '本场没有就绪底稿，主播先现场生成'
          })
        }
      } else if (result.gate && activeProgram) {
        // 预制节目门禁未过：结构化缺口进弹窗，不静默跳过（docs/10 §7.8）
        setChecks(null)
        setGate(result.gate)
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
    setStopAsk(false)
    try {
      useAppStore.getState().setLoopRunning(false)
      await window.api.agent.stop()
      toast.message('本场已结束', { description: '播报一并停止，池里的存货保留，下次开播接着用' })
    } finally {
      setBusy(false)
    }
  }

  /** 中槽未开播态：唯一主 CTA（先跑预检 → 开播确认，再出声） */
  const launchAction = (
    <Button
      size="sm"
      disabled={busy || checking}
      onClick={() => setLaunchConfigOpen(true)}
      title="先配这一场：写稿 / 合成 / 播放，再预检开播"
    >
      {busy || checking ? <Loader2 className="animate-spin" /> : <Play />}
      启动直播
    </Button>
  )

  /** 中槽直播态右侧：结束本场（红字 + 二次确认，与「暂停」明确区分） */
  const endAction = (
    <>
      <span className="mx-1 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={() => setStopAsk(true)}
        title="结束本场：播报停止，池里的存货保留（收场，与「暂停」不同）"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Square />}
        结束本场
      </Button>
    </>
  )

  const dialogs = (
    <>
      {/* 结束本场二次确认：收场是不可逆的重操作，和「暂停」区分开 */}
      <Dialog open={stopAsk} onOpenChange={setStopAsk}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>结束本场？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            播报会停下来，池里的存货保留，下次开播接着用。只想临时安静一下请用「暂停」。
          </p>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="outline" onClick={() => setStopAsk(false)}>
              继续播
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
              {busy ? <Loader2 className="animate-spin" /> : <Square />}
              结束本场
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeProgram && (
        <DraftMinutesDialog
          program={activeProgram}
          open={draftAsk}
          onOpenChange={setDraftAsk}
          onConfirm={() => startDraft()}
        />
      )}
      {/* 预检「提前合成全部」的声音选择弹窗（docs/REDESIGN 4.4），确认后才发起合成 */}
      {activeProgram && (
        <VoicePickDialog
          program={activeProgram}
          open={voicePickOpen}
          onOpenChange={setVoicePickOpen}
          onConfirm={(override, rebuildAll) => void confirmPresynth(override, rebuildAll)}
        />
      )}
      {/* 预制节目门禁未过：继续生成 / 重试失败项 / 仅播放已完成部分，三选项都在这里 */}
      {activeProgram && gate && (
        <ProgramGateDialog
          program={activeProgram}
          gate={gate}
          open
          onOpenChange={(open) => {
            if (!open) setGate(null)
          }}
          onGateChange={setGate}
          onLaunched={(result) => {
            resumeBroadcast()
            if (result.warning) {
              toast.warning(`直播已启动：${activeProgram.name}（主播还没就位）`, {
                description: result.warning
              })
            } else {
              toast.success(`直播已启动：${activeProgram.name}`, {
                description: result.loaded ? `已装载 ${result.loaded} 个播出单元，接着播` : undefined
              })
            }
          }}
        />
      )}
    </>
  )

  return {
    programs,
    activeProgram,
    running,
    launchAction,
    endAction,
    dialogs,
    patchProgram,
    openPreflight,
    launchConfigOpen,
    setLaunchConfigOpen,
    launchTab,
    openLaunchConfig: (tab: 'write' | 'synth' | 'play') => {
      setLaunchTab(tab)
      setLaunchConfigOpen(true)
      void runPreflight()
    },
    checks,
    checking,
    runPreflight,
    start,
    busy,
    session,
    setSession,
    switchProgram,
    startDraft
  }
}

/**
 * 行级 memo：`upsert` 只替换变化的那一条 entry（其余对象引用不变），所以下面这些包装能真正跳过重渲染——
 * 最后一条流式文本每 60ms 变一次时，历史里的 markdown/思考块/工具卡不再跟着重渲染。
 */
const ToolCardMemo = memo(ToolCard)
const ToolGroupMemo = memo(ToolGroup)
const ThinkingBlockMemo = memo(ThinkingBlock)
const AskCardMemo = memo(AskCard, (a: { message: DirectorMessage }, b: { message: DirectorMessage }) => a.message === b.message)

/** 行首标记（日期分隔 / 每轮时间线）：拆出来是为了它也能被 memo 覆盖 */
function RowHead({ dayLabel }: { dayLabel?: string }) {
  return (
    <>
      {dayLabel && (
        <div className="my-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {dayLabel}
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
    </>
  )
}

/**
 * 时间线的一行（memo）：只有真的变化的那条 entry 才重渲染——
 * 流式文本每 60ms 变一次时，历史里的 Markdown（streamdown 解析）、思考块、工具卡都不再跟着重跑。
 * 流式期间只有最后一行拿到 caret（isTail），其余行的 props 全不变。
 */
const TimelineLine = memo(function TimelineLine({
  entry,
  dayLabel,
  isTail,
  running,
  restored,
  onAnswer
}: {
  entry: ChatEntry
  dayLabel?: string
  isTail: boolean
  running: boolean
  /** 存档恢复出来的条目（本次会话之前就落库的）：思考条目拿不到可信起点，不给秒表 */
  restored: boolean
  onAnswer: (message: DirectorMessage, answer: string) => void
}) {
  /** 这一条能不能复制：只有"真的说过的话"（我的消息 / 导演正文 / 请示卡）；
   *  思考过程与工具卡不给复制入口（它们是过程，不是可引用的产出） */
  const copyText =
    entry.type === 'ask'
      ? entry.message.text
      : entry.type === 'text' || entry.type === 'director'
        ? entry.text
        : ''
  const copy = (): void => {
    if (!copyText) return
    void navigator.clipboard
      .writeText(copyText)
      .then(() => toast.success('已复制这条'))
      .catch(() => toast.error('复制失败'))
  }
  return (
    // select-text：应用全局是 user-select:none（桌面应用风格），消息文字要能选中复制
    <div className="group/line flex select-text flex-col">
      <RowHead dayLabel={dayLabel} />
      {entry.type === 'director' ? (
        // 自己的消息：贴内容宽度，长到 92% 才换行（再宽就跟助手正文分不清了）
        <div className="flex max-w-[92%] flex-col items-end gap-1 self-end">
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
        </div>
      ) : entry.type === 'text' && !entry.final ? (
        // 中间文本：淡色、不套气泡、铺满宽度（流式追加时不会跳成多块）
        <p className="whitespace-pre-wrap text-[13px] leading-[21px] text-muted-foreground">
          {entry.text}
          {running && isTail && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
          )}
        </p>
      ) : entry.type === 'text' ? (
        // 最终回复：富文本（表格/列表/代码），时间在轮分隔线上不再重复
        <Markdown text={entry.text} />
      ) : entry.type === 'thinking' ? (
        <ThinkingBlockMemo entry={entry} restored={restored} isTail={isTail} />
      ) : entry.type === 'tool' ? (
        <ToolCardMemo entry={entry} />
      ) : (
        <AskCardMemo message={entry.message} onAnswer={onAnswer} />
      )}
      {/* 底部一行：时间 + 复制图标（自己的消息靠右，其它靠左）——时间不再挂在消息上方 */}
      {(copyText || entry.type === 'director') && (
        <div
          className={cn(
            'mt-0.5 flex items-center gap-1.5',
            entry.type === 'director' && 'justify-end'
          )}
        >
          <span className="font-mono text-[10px] text-muted-foreground/60">{clock(entry.ts)}</span>
          {copyText && (
            <button
              type="button"
              className="flex size-4 items-center justify-center rounded text-muted-foreground/35 transition-colors hover:bg-accent hover:text-muted-foreground/70"
              title="复制这条内容"
              onClick={copy}
            >
              <Copy className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
})

/** 话轮卡片头：图标 + 颜色区分，不放原始 id/hash 这类机器串 */
function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 请示（ask_director）：带倒计时、默认策略与一键选项的卡片，不阻塞直播（docs/07 §8.8.6 ④） */
function AskCard({
  message,
  onAnswer
}: {
  message: DirectorMessage
  onAnswer: (message: DirectorMessage, answer: string) => void
}) {
  // 倒计时自己走秒：放在父组件会每秒把整条时间线都重渲染
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (message.answered || !message.timeoutSec) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [message.answered, message.timeoutSec])
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
      <Markdown text={message.text} />
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

const TOOL_LABEL: Record<string, string> = {
  search_knowledge: '查了商品资料',
  check_price: '核对了商品价格',
  edit_draft: '修改了底稿',
  say: '安排了播报',
  insert_next: '安排了下一条播报',
  save_program: '保存了节目',
  save_script: '保存了剧本',
  save_persona: '保存了主播卡',
  session_history: '查了历史场次'
}

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? '执行了系统操作'
}

/** 连续同名工具并成一行，默认说人话；点开才看技术细节 */
function ToolGroup({ items }: { items: Extract<ChatEntry, { type: 'tool' }>[] }) {
  const [open, setOpen] = useState(false)
  const name = items[0].name
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
        <span className="shrink-0 text-[11px]">{toolLabel(name)}</span>
        <span className="shrink-0 text-[11px] opacity-60">×{items.length}</span>
        <span className="min-w-0 flex-1" />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
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

/** 工具调用默认显示人话，点击后才展开原始参数、结果与技术细节。 */
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
        <span className="shrink-0 text-[11px]">{toolLabel(entry.name)}</span>
        <span className="min-w-0 flex-1" />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
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
export function DirectorConsole({ active, onUnread }: { active: boolean; onUnread: () => void }) {
  const agent = useAppStore((s) => s.agent)
  const loopRunning = useAppStore((s) => s.loopRunning)
  /** 会话按项目分开：切项目就换一份对话记录 */
  const projectId = useAppStore((s) => s.config.live.activeProgramId)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  /** 已发出、还没等到导演第一条动静（占位提示用；首条时间线条目落地即清） */
  const [awaiting, setAwaiting] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  /** 最新值镜像（给异步回调读）：在 effect 里同步，不在渲染期写 ref——渲染可能被丢弃/重放 */
  const activeRef = useRef(active)
  const onUnreadRef = useRef(onUnread)
  useEffect(() => {
    activeRef.current = active
    onUnreadRef.current = onUnread
  })
  /** 见过的条目 id：只有首见的那次算未读（流式更新同一 id 不算新消息） */
  const seenRef = useRef(new Set<string>())
  /** 存档恢复出来的条目 id：它们的 ts 是"落库时刻"，不能当开始时间用（思考秒表会算出天文数字） */
  const restoredRef = useRef(new Set<string>())
  /** ?demo 演示模式（仅 dev）：置上之后存档恢复不再合并进来，免得演示条目跟真实历史混在一起 */
  const demoRef = useRef(false)

  /** 时间线顺序追加/按 id 覆盖（text 覆盖全文、tool 更新状态）；时间戳沿用首次那条，避免排序跳动 */
  const upsert = (entry: ChatEntry): void => {
    setEntries((prev) => {
      const index = prev.findIndex((item) => item.id === entry.id)
      if (index < 0) return [...prev.slice(-199), entry]
      const before = prev[index]
      const next = prev.slice()
      if ((entry.type === 'text' || entry.type === 'thinking') && entry.append) {
        // 流式增量：主进程只发新增片段，这里累加（定稿那次是全文，天然对账自愈）
        const merged = {
          ...before,
          ...entry,
          text: (before.type === entry.type ? before.text : '') + entry.text,
          ts: before.ts
        }
        delete merged.append
        next[index] = merged as ChatEntry
        return next
      }
      // 合并而不是替换：工具结束的更新不带 args，整体替换会把参数/结果冲掉
      next[index] = { ...before, ...entry, ts: before.ts } as ChatEntry
      return next
    })
  }

  /** 新条目（首见 id）落地；切走时在「对话」选项卡上累未读 */
  const landed = (id: string): void => {
    const first = !seenRef.current.has(id)
    seenRef.current.add(id)
    if (first && !activeRef.current) onUnreadRef.current()
    // 导演有动静了（思考/文本/工具任一条）就把"正在生成回复中"收掉
    if (first && !id.startsWith('dm-local-')) setAwaiting(false)
  }

  useEffect(() => {
    if (!('api' in window)) return
    let cancelled = false
    // 换项目 = 换一份对话：先清屏再拉这个项目的存档，避免把上一个项目的记录带进来
    seenRef.current = new Set()
    restoredRef.current = new Set()
    setEntries([])
    void window.api.director.timelineList(projectId).then((stored) => {
      if (cancelled || demoRef.current) return
      for (const entry of stored) {
        seenRef.current.add(entry.id)
        restoredRef.current.add(entry.id)
      }
      setEntries([...stored].sort((a, b) => a.ts - b.ts))
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // 订阅对话时间线（文本流式 + 工具卡片 + 压缩后 reset）与请示卡片
  useEffect(() => {
    if (!('api' in window)) return
    const offTimeline = window.api.director.onTimeline((event) => {
      // 压缩成功 → 可见历史整体替换（只剩压缩卡）：有多少记录 = 实际有多长上下文
      if ('type' in event && event.type === 'reset') {
        setEntries(event.entries)
        seenRef.current = new Set(event.entries.map((entry) => entry.id))
        return
      }
      if (!('entry' in event)) return
      const entry = event.entry
      if (entry.type === 'text') {
        upsert({
          type: 'text',
          id: entry.id,
          ts: Date.now(),
          turnId: event.turnId,
          text: entry.text,
          final: entry.final === true,
          append: entry.append === true,
        })
      } else if (entry.type === 'thinking') {
        upsert({
          type: 'thinking',
          id: entry.id,
          ts: Date.now(),
          turnId: event.turnId,
          text: entry.text,
          done: entry.done === true,
          append: entry.append === true,
          durationMs: entry.durationMs,
        })
      } else if (entry.type === 'ask') {
        // 主播请示卡片：与文本/工具同一条单通道
        upsert({ type: 'ask', id: entry.id, ts: entry.message.ts, message: entry.message })
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
          durationMs: entry.durationMs,
        })
      }
      landed(entry.id)
    })
    return () => {
      offTimeline()
    }
  }, [])

  // 请示超时倒计时：到点卡片标过期（主播那边本来就不阻塞，docs/07 §8.8.6 ④）
  // 开发演示：?demo 时塞一组样例条目看布局（仅 dev，不进生产包行为）——纯演示，不与真实历史混排
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('demo')) return
    demoRef.current = true
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
      { type: 'tool', id: 'demo-s1', ts: t0 - 55000, turnId: 'turn-2', name: 'say', args: '{"text":"诸位欢迎进直播间"}', status: 'ok', result: '已排进队列', durationMs: 31 },
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

  /**
   * 贴底跟随：列表用 `flex-col-reverse` 逆序渲染（最后一行在 DOM 最前、视觉最底）。
   * 这样 scrollTop=0 天然就是底部——新消息追加、思考过程展开撑高行、流式定稿换富文本，
   * 浏览器都自动保持视口钉在底部，不需要任何 JS 补偿；用户向上翻（scrollTop 变负）时
   * 滚动锚定也天然保住阅读位置。JS 只维护「贴底模式」标志：
   * 只有真实用户动作（滚轮向上、拖到上方）才退出贴底；回到底部附近自动恢复。
   */
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      // column-reverse：scrollTop 0 = 视觉底部，向上翻为负值
      const dist = -el.scrollTop
      if (dist < 40) stickRef.current = true
      else if (dist > 200) stickRef.current = false
      setAtBottom((prev) => (prev === (dist < 120) ? prev : dist < 120))
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) stickRef.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  // 条目变化（新消息/流式追加/恢复历史）时兜底钉一次：column-reverse 下本就近乎免费，
  // 这里防的是个别浏览器在「行高原地变化」时不做滚动锚定
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = 0
  }, [entries])

  const jumpToBottom = (): void => {
    stickRef.current = true
    setAtBottom(true)
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /** 快速指令本地解析（不过 LLM）。命中返回 true。 */
  const runQuickCommand = (text: string): boolean => {
    if (/^(暂停|暂停播报|停一下)$/.test(text)) {
      pauseBroadcast()
      // 正在生成/跑工具时连这一轮一起打断，否则「暂停」停不住正在执行的命令
      if (agent.busy) void window.api.agent.abort()
      toast.message('播报已暂停', {
        description: agent.busy ? '正在执行的那一步也停了；池里的内容保留，恢复后继续播' : '池里的内容保留，恢复后继续播'
      })
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
    setAwaiting(true)
    upsert({
      type: 'director',
      id,
      ts: Date.now(),
      text,
      attachments: files.length > 0 ? files : undefined
    })
    landed(id)
    if (text && runQuickCommand(text)) return
    // 图片走第三参（main 读成图像内容进会话，模型需开多模态）；其它类型拼 [附件] 文本随指令发
    const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
    const images = files.filter((f) => IMAGE_EXT.has((f.name.split('.').pop() ?? '').toLowerCase()))
    const others = files.filter((f) => !IMAGE_EXT.has((f.name.split('.').pop() ?? '').toLowerCase()))
    const payload =
      others.length > 0 ? `${text}\n${others.map((f) => `[附件] ${f.name}：${f.path}`).join('\n')}`.trim() : text
    // 本地回显的 id 一起发给 main：落库用同一 id，切场/重载恢复时不重复
    // 每轮都带当前写稿参数（语言/形态/风格/收尾）：system prompt 不存这些值，改了语言下一句就生效
    void (async () => {
      const programId = useAppStore.getState().config.live.activeProgramId
      const session = programId ? await window.api.sessionConfig.latest(programId) : null
      const result = await window.api.director.send(
        payload,
        id,
        images.length > 0 ? images : undefined,
        session
          ? {
              language: session.language,
              instruction: session.instruction,
              contentType: session.contentType,
              endMode: session.endMode
            }
          : undefined
      )
      if (!result.ok) {
        setAwaiting(false)
        toast.error('指令没送达', { description: result.error })
      }
    })()
  }

  const answerAsk = (message: DirectorMessage, answer: string): void => {
    upsert({ type: 'ask', id: message.id, ts: message.ts, message: { ...message, answered: answer } })
    send(answer)
  }
  // 传给行级 memo 的引用要稳：不然每次渲染都是新函数，memo 全被击穿。
  // 最新值镜像在 effect 里同步（渲染期写 ref 会被 react-doctor 判 no-ref-current-in-render）
  const answerAskRef = useRef(answerAsk)
  useEffect(() => {
    answerAskRef.current = answerAsk
  })
  const answerAskStable = useCallback((message: DirectorMessage, answer: string) => answerAskRef.current(message, answer), [])

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

  /** 每行的分隔标记（日期/是否末行）按正序算好，渲染时才逆序——与视觉顺序解耦 */
  const displayRows = useMemo(() => {
    const metas = rows.map((row, index) => {
      const firstEntry = row.kind === 'tools' ? row.items[0] : row.entry
      const prevRow = index > 0 ? rows[index - 1] : undefined
      const prevEntry = prevRow?.kind === 'entry' ? prevRow.entry : prevRow?.items?.[0]
      const dayLabel =
        prevEntry && new Date(prevEntry.ts).toDateString() !== new Date(firstEntry.ts).toDateString()
          ? new Date(firstEntry.ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
          : undefined
      return { row, dayLabel, isTail: index === rows.length - 1 }
    })
    // column-reverse 列表：渲染顺序与视觉相反（最后一行 DOM 最前）
    return metas.reverse()
  }, [rows])

  /** 渲染一条时间线行（分隔标记由 displayRows 预算好） */
  const renderRow = (meta: {
    row:
      | { kind: 'entry'; entry: ChatEntry }
      | { kind: 'tools'; id: string; items: Extract<ChatEntry, { type: 'tool' }>[] }
    dayLabel?: string
    isTail: boolean
  }): React.ReactNode => {
    const { row, dayLabel, isTail } = meta
    if (row.kind === 'tools') {
      return (
        <>
          <RowHead dayLabel={dayLabel} />
          {row.items.length > 1 ? <ToolGroupMemo items={row.items} /> : <ToolCardMemo entry={row.items[0]} />}
        </>
      )
    }
    return (
      <TimelineLine
        entry={row.entry}
        dayLabel={dayLabel}
        isTail={isTail}
        running={agent.state === 'running'}
        restored={restoredRef.current.has(row.entry.id)}
        onAnswer={answerAskStable}
      />
    )
  }

  const canSend = input.trim().length > 0 || attachments.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 对话时间线：column-reverse 逆序渲染，scrollTop=0 天然钉在底部。
          新消息/流式追加/行高变化都由浏览器自动保底，JS 只管「贴底模式」标志（见 stickRef 注释）。
          时间线上限 200 条，行组件都有 memo，全量渲染负担可控（虚拟化反而引入测量/贴底一串问题，已移除） */}
      {rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Bot className="size-8" strokeWidth={1.25} />
          <p className="px-6 text-center text-xs leading-5">
            这里能看到主播的想法、工具调用和最终回复。
            <br />
            消息只进对话，不会被播出去。
          </p>
        </div>
      ) : (
        <div ref={scrollerRef} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
          {/* 生成中占位在 DOM 最前 = 视觉最底（紧挨最新一行） */}
          {(awaiting || agent.busy) && (
            <div className="flex items-center gap-1.5 px-4 pt-1 pb-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在生成回复中…
            </div>
          )}
          {displayRows.map((meta) => (
            <div
              key={meta.row.kind === 'tools' ? meta.row.id : meta.row.entry.id}
              // 每行包一层 flex 列容器：导演消息靠 self-end 右对齐（块级容器里 self-end 是无效的，
              // 那会让自己的消息只在"86% 宽的盒子内"右对齐，长消息就从左边一路铺过来）
              className="flex shrink-0 flex-col px-4 pb-3"
            >
              {renderRow(meta)}
            </div>
          ))}
        </div>
      )}

      {/* 用户往上翻着看历史时，新内容不抢滚动条，给一个回到底部的入口 */}
      {!atBottom && (
        <div className="flex shrink-0 px-3 pb-1">
          <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" onClick={jumpToBottom}>
            ↓ 回到底部
          </Button>
        </div>
      )}

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
                    aria-label={`移除附件 ${file.name}`}
                    title="移除这个附件"
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
            placeholder={agent.state === 'running' ? '跟导演说点什么…' : '跟导演说点什么…'}
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
            <div className="ml-auto flex items-center gap-1">
              <ContextMeter tokens={agent.contextTokens} window={agent.contextWindow} />
              {agent.busy ? (
                <Button
                  size="icon-sm"
                  onClick={() => void window.api.agent.abort()}
                  title="停止这一轮生成（会话保留，可继续对话）"
                >
                  <Square className="fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  disabled={!canSend}
                  onClick={() => send(input)}
                  title="发送（Enter）"
                >
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


/** 上下文仪表：只显示圆环，悬停浮出「导演的短期记忆已用 Z%」，涨近上限变色 */
function ContextMeter({ tokens, window: contextWindow }: { tokens?: number; window?: number }) {
  if (!tokens || !contextWindow) return null
  const ratio = Math.min(1, tokens / contextWindow)
  const color = ratio > 0.85 ? 'text-red-500' : ratio > 0.65 ? 'text-amber-500' : 'text-emerald-500'
  // 环形进度：r=7 的圆，周长 ≈ 43.98，dasharray 按比例填充
  const r = 7
  const circumference = 2 * Math.PI * r
  return (
    <div className="group relative flex items-center pr-1">
      <div className="pointer-events-none absolute -top-8 right-0 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[10px] text-background opacity-0 shadow-md transition-opacity group-hover:opacity-100">
        导演的短期记忆已用 {Math.round(ratio * 100)}%，快满时会自动整理
      </div>
      <svg viewBox="0 0 18 18" className={`size-4.5 -rotate-90 ${color}`}>
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`}
        />
      </svg>
    </div>
  )
}

/** 思考过程条目：默认折叠（用户手动展开）；思考中显示「思考中… Ns」计时，写完收成「思考过程 · Ns」 */
function ThinkingBlock({
  entry,
  restored,
  isTail
}: {
  entry: Extract<ChatEntry, { type: 'thinking' }>
  /** 本次会话之前就存在于存档里的（恢复出来的）：它的 ts 不是"开始时刻"，不能拿来跑实时秒表 */
  restored: boolean
  /** 只有时间线上最后一行可能在"正在思考"：被别的条目顶下去，说明这段思考早结束了 */
  isTail: boolean
}) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  /** 秒数只在两种情况下定下来：主进程给的 durationMs，或本会话里看着它写完的那一刻 */
  const [frozenSec, setFrozenSec] = useState<number | null>(null)
  const live = !entry.done && !restored && isTail
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  useEffect(() => {
    if (frozenSec !== null) return
    // 权威时长优先（主进程按 startedAt 算的）
    if (entry.durationMs !== undefined) {
      setFrozenSec(Math.max(0, Math.round(entry.durationMs / 1000)))
      return
    }
    // 兜底：本会话里看着它写完（ts 是本会话首见时刻，可信）——
    // 恢复出来的旧条目没有可信起点，就不给数字，只显示「思考过程」
    if (entry.done && !restored) setFrozenSec(Math.max(0, Math.round((Date.now() - entry.ts) / 1000)))
  }, [entry.done, entry.durationMs, entry.ts, frozenSec, restored])
  const sec: number | null = frozenSec ?? (live ? Math.max(0, Math.round((now - entry.ts) / 1000)) : null)
  return (
    <div className="max-w-[92%]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground/80 hover:text-muted-foreground"
      >
        <Brain className="size-3.5" />
        {sec === null
          ? '思考过程'
          : entry.done
            ? `思考过程${sec > 0 ? ` · ${sec}s` : ''}`
            : `思考中… ${sec}s`}
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2.5 text-xs leading-5 text-muted-foreground/80 italic">
          {entry.text}
          {!entry.done && (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
          )}
        </p>
      )}
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
            <Label className="shrink-0 text-xs text-muted-foreground">插播方式</Label>
            <ToggleGroup
              type="single"
              value={lane}
              onValueChange={(v) => v && setLane(v as 'normal' | 'next')}
              className="rounded-lg bg-muted p-0.5"
            >
              <ToggleGroupItem value="normal" className="h-6 px-2.5 text-xs" title="排在已排队的内容后面">
                排队等播
              </ToggleGroupItem>
              <ToggleGroupItem value="next" className="h-6 px-2.5 text-xs" title="当前这条播完就播它">
                插为下一条
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="shrink-0 text-xs text-muted-foreground">音色</Label>
            <UnifiedVoicePicker
              voiceId={voice}
              onPick={setVoice}
              emptyLabel="留空用主播自己的音色"
              placeholder="留空用主播自己的音色"
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

