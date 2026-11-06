import { useEffect, useState } from 'react'
import { AlertTriangle, AudioWaveform, Check, Play, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { SpeakerPicker } from './SpeakerPicker'
import { cn } from '@/lib/utils'
import {
  CONTENT_TYPE_LABELS,
  DEFAULT_SESSION_CONFIG,
  PROGRAM_LANGUAGE_LABELS,
  SESSION_PRESETS,
  type ContentType,
  type Program,
  type ProgramLanguage,
  type SessionConfig,
  type SessionConfigInput,
} from '../../../../shared/types'

/**
 * 直播配置（docs/12 第五节）：点「启动直播」先过这一屏，每次都必须人点确认。
 * 版式照「新建 SSH」那类分组表单：顶部标题，中间三步（写稿/合成/播放），
 * 底部固定「取消 / 确认并预检」；一页只放一组，避免所有配置堆在一起。
 */

export type LaunchConfig = Omit<SessionConfigInput, 'programId'>

const LANGUAGES = Object.entries(PROGRAM_LANGUAGE_LABELS).map(([value, label]) => ({
  value: value as ProgramLanguage,
  label
}))

const CONTENT_TYPES = (Object.keys(CONTENT_TYPE_LABELS) as ContentType[]).map((value) => ({
  value,
  label: CONTENT_TYPE_LABELS[value]
}))

/** 分段控件：同一行单选，选中项白底浮起 */
function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="inline-flex w-full rounded-lg bg-muted/70 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'flex-1 rounded-[6px] px-3 py-1.5 text-[12.5px] whitespace-nowrap transition-colors',
            option.value === value
              ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 一个字段：标签在上、控件在下（与图 2 的表单一致） */
function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground/75">{hint}</p>}
    </div>
  )
}

/** 上次配置 / 默认值 → 本次预填（必须人点确认，预填值不写回资产）。
 *  内容来源不再是选项：实时档=现场无限生成，其余=按本场话术，由合成时机唯一决定。 */
function prefill(session: SessionConfig | null): LaunchConfig {
  if (session) {
    return {
      language: session.language,
      contentType: session.contentType,
      instruction: session.instruction,
      preset: session.preset,
      contentSource: session.synthMode === 'realtime' ? 'infinite' : 'script',
      synthMode: session.synthMode,
      endMode: session.endMode,
      audioPolicy: 'reuse',
      allowLiveEvents: session.allowLiveEvents,
      enabledTriggerIds: session.enabledTriggerIds,
      voiceId: session.voiceId ?? '',
      speakerVoices: session.speakerVoices ?? {}
    }
  }
  return {
    ...DEFAULT_SESSION_CONFIG
  }
}
export function LaunchConfigDialog({
  open,
  program,
  session,
  draftCount,
  readyCount,
  onCancel,
  onConfirm,
  onWrite,
  onSynthesize,
  defaultTab = 'write',
  brief = '',
  onBriefChange,
  launching = false
}: {
  open: boolean
  program: Program | null
  session: SessionConfig | null
  draftCount: number
  readyCount: number
  onCancel: () => void
  onConfirm: (config: LaunchConfig) => void
  /** 写稿：存配置后让导演写一版（不合成、不开播） */
  onWrite?: (config: LaunchConfig) => void
  /** 合成：存配置后批量合成未就绪的段落 */
  onSynthesize?: (config: LaunchConfig) => void
  /** 打开时落在哪一段：写稿 / 合成 / 播放（由直播台按当前进度决定） */
  defaultTab?: 'write' | 'synth' | 'play'
  /** 写稿要求（商品/卖点/受众/风格），存到项目简介里，导演按它写稿 */
  brief?: string
  onBriefChange?: (value: string) => void
  launching?: boolean
}) {
  const [config, setConfig] = useState<LaunchConfig>(() =>
    program ? prefill(session) : { ...DEFAULT_SESSION_CONFIG }
  )
  const [tab, setTab] = useState<'write' | 'synth' | 'play'>(defaultTab)
  /** 稿子里出现的主播标识（自动识别，逐个配声） */
  const [speakers, setSpeakers] = useState<string[]>([])
  // 打开时按真实进度落位：稿子还没写就一定从「写稿」开始；写好了就跳到「合成」/「播放」
  useEffect(() => {
    if (!open) return
    const progress = draftCount === 0 ? 'write' : readyCount === 0 ? 'synth' : 'play'
    setTab(defaultTab === 'write' && progress !== 'write' ? progress : defaultTab)
  }, [open, defaultTab, draftCount, readyCount])

  useEffect(() => {
    if (!open || !program) return
    setConfig(prefill(session))
  }, [open, program, session])

  // 从稿子里自动识别主播标识：有几个角色，就在合成这一步给几个音色
  useEffect(() => {
    if (!open || !program) {
      setSpeakers([])
      return
    }
    let alive = true
    void window.api.draftUnit
      .list(program.id)
      .then((units) => {
        if (!alive) return
        const labels = new Set<string>()
        for (const unit of units) {
          const label = (unit.speaker ?? '').trim()
          if (label) labels.add(label)
        }
        setSpeakers([...labels])
      })
      .catch(() => alive && setSpeakers([]))
    return () => {
      alive = false
    }
  }, [open, program?.id, draftCount])

  const patch = (part: Partial<LaunchConfig>) => setConfig((prev) => ({ ...prev, ...part }))

  const applyPreset = (value: string) => {
    const preset = value as LaunchConfig['preset']
    if (!preset) return patch({ preset })
    const found = SESSION_PRESETS.find((item) => item.id === preset)
    if (!found) return
    patch({
      preset,
      // 内容来源跟着合成时机走（预设里两者本来就一致，这里统一按规则推一次）
      contentSource: found.synthMode === 'realtime' ? 'infinite' : 'script',
      synthMode: found.synthMode,
      endMode: found.endMode
    })
  }

  /** 分段推进只发生在打开时（见上一个 effect）；打开后一律听用户的：
   *  写稿/合成/播放三段都能点回去，「已经合成完了」不该把人锁在下一步。 */

  const steps: { id: 'write' | 'synth' | 'play'; label: string; done: boolean }[] = [
    { id: 'write', label: '写稿', done: draftCount > 0 },
    { id: 'synth', label: '合成', done: readyCount > 0 },
    { id: 'play', label: '播放', done: false }
  ]

  if (!program) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex h-[min(680px,88vh)] w-[720px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader className="shrink-0 px-7 pt-5 pb-4">
          <DialogTitle className="text-[15px]">直播配置</DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {program.name}
            <span className="mx-2 text-border">|</span>底稿 {draftCount} 段
            <span className="mx-2 text-border">|</span>就绪 {readyCount} 段
          </p>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="shrink-0 border-b px-7">
            <div className="flex items-center justify-center gap-3 py-3">
              {steps.map((step, index) => {
                const active = tab === step.id
                return (
                  <div key={step.id} className="flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setTab(step.id)}
                      className={cn(
                        'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors',
                        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium',
                          step.done
                            ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-600'
                            : active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border text-muted-foreground'
                        )}
                      >
                        {step.done ? <Check className="size-3" /> : index + 1}
                      </span>
                      <span className={cn('truncate text-[12.5px]', active && 'font-medium')}>{step.label}</span>
                    </button>
                    {index < steps.length - 1 && <span className="h-px w-20 shrink-0 bg-border" />}
                  </div>
                )
              })}
            </div>
          </div>

          <TabsContent value="write" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-5">
              {config.synthMode === 'realtime' && (
                <p className="rounded-md bg-muted/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
                  当前是实时档：内容现场生成、逐句合成，不靠备稿库存。要备稿先把合成时机切回预合成或边播边合。
                </p>
              )}
              <Field label="预设" hint="只负责套「内容来源 / 合成时机 / 收尾」三个开关，套完仍可逐项改">
                <Select
                  value={config.preset || '__custom'}
                  onValueChange={(value) => applyPreset(value === '__custom' ? '' : value)}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__custom">自定义</SelectItem>
                    {SESSION_PRESETS.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                        <span className="ml-2 text-[11px] text-muted-foreground">{item.example}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="话术语言" hint="只决定写什么语言，不传给 TTS；个别条可在卡片上单独覆盖">
                <Select
                  value={config.language}
                  onValueChange={(value) => patch({ language: value as ProgramLanguage })}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="内容形态" hint="表达规范：一个人讲 / 多人聊天 / 照稿读 / 分角色">
                <Select
                  value={config.contentType}
                  onValueChange={(value) => patch({ contentType: value as ContentType })}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTENT_TYPES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="写稿要求"
                hint="商品/服务、卖点、卖给谁、想要什么风格；不清楚的导演会在对话里再问你"
              >
                <Textarea
                  value={brief}
                  rows={4}
                  placeholder="比如：卖保温杯，59.9，送爸妈/送同事；风格温暖实在，别喊麦；这场大约 40 分钟"
                  onChange={(event) => onBriefChange?.(event.target.value)}
                />
              </Field>

              <Field label="本场风格" hint="≤100 字，低于卡片上逐条的演法">
                <Input
                  value={config.instruction}
                  onChange={(event) => patch({ instruction: event.target.value.slice(0, 100) })}
                  placeholder="如：温柔、语速偏慢、句尾放轻"
                  className="h-10"
                />
              </Field>
            </div>
                    </TabsContent>

          <TabsContent value="synth" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-5">
<div className="flex flex-col gap-4">
              <p className="text-[12px] text-muted-foreground">
                本场默认音色；稿子里出现的其他主播会自动列在下面，逐个配音色。没选音色时新内容没法合成，存量音频照播。
              </p>
              <Field label="默认音色">
                <UnifiedVoicePicker
                  voiceId={config.voiceId}
                  onPick={(voiceId) => patch({ voiceId })}
                  emptyLabel="未选音色"
                  placeholder="选择音色"
                />
              </Field>
              {speakers.length > 0 && (
                <Field label="主播音色" hint="从稿子里的主播标识自动识别；没配的跟随默认音色">
                  <div className="flex flex-col gap-2">
                    {speakers.map((label) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 truncate text-[12.5px] text-muted-foreground" title={label}>
                          {label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <SpeakerPicker
                            value={config.speakerVoices?.[label] ?? ''}
                            onChange={(voiceId) =>
                              patch({ speakerVoices: { ...(config.speakerVoices ?? {}), [label]: voiceId } })
                            }
                            emptyLabel="跟随默认音色"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </Field>
              )}
            </div>
<div className="flex flex-col gap-5">
              

              <Field
                label="合成时机"
                hint={
                  config.synthMode === 'pre'
                    ? '开播前全部合成好；改一个字要重合成'
                    : config.synthMode === 'async'
                      ? '播一条备几条；补货跟不上时会等'
                      : '逐句合成立刻播；互动最快，语气连贯性略差'
                }
              >
                <Segmented
                  value={config.synthMode}
                  options={[
                    { value: 'pre', label: '预合成' },
                    { value: 'async', label: '边播边合' },
                    { value: 'realtime', label: '实时' }
                  ]}
                  // 内容来源不再是选项，由合成时机唯一决定：实时=现场无限生成，其余=按本场话术
                  onChange={(synthMode) =>
                    patch({
                      synthMode,
                      contentSource: synthMode === 'realtime' ? 'infinite' : 'script'
                    })
                  }
                />
              </Field>

              {config.synthMode !== 'realtime' && (
                <Field label="音频策略">
                  <Segmented
                    value={config.audioPolicy}
                    options={[
                      { value: 'reuse', label: `复用现有（${readyCount} 段）` },
                      { value: 'rebuild', label: '清空重合成' }
                    ]}
                    onChange={(audioPolicy) => patch({ audioPolicy })}
                  />
                  {config.audioPolicy === 'rebuild' && (
                    <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-800">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      会清空本场全部音频，按当前音色/语言重新合成，期间不能开播，并按次计费。
                    </p>
                  )}
                </Field>
              )}
            </div>
            </div>
                    </TabsContent>

          <TabsContent value="play" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-5">
              {config.synthMode === 'realtime' ? (
                <p className="rounded-md bg-muted/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
                  实时档：内容现场生成、逐句合成立刻播，没有整轮播完再循环这回事——下面只留互动设置。
                </p>
              ) : (
                <Field
                  label="收尾"
                  hint="一遍播完＝播完就收尾下播；循环返场＝回卷重播同一批稿子；一直播＝这一轮播完接着写新内容一直播下去（预合成做不了边播边写，会改用边播边合）"
                >
                  <Segmented
                    value={config.endMode}
                    options={[
                      { value: 'stop', label: '一遍播完' },
                      { value: 'loop', label: '循环返场' },
                      { value: 'forever', label: '一直播' }
                    ]}
                    onChange={(endMode) =>
                      patch(
                        endMode === 'forever' && config.synthMode === 'pre'
                          ? { endMode, synthMode: 'async' }
                          : { endMode }
                      )
                    }
                  />
                </Field>
              )}
              {/* 互动接线不在开播配置里改：顶栏「自动响应」是它的唯一入口（实时生效，播出中也能调）。
                  这里是开播那一刻的快照，不在这里二次编辑，避免两处改出两套状态 */}
            </div>
                    </TabsContent>

        </Tabs>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-7 py-3">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          {tab === 'write' ? (
            <Button
              disabled={launching || !onWrite || config.synthMode === 'realtime'}
              onClick={() => onWrite?.(config)}
            >
              <Sparkles />
              {config.synthMode === 'realtime' ? '实时档不备稿' : draftCount > 0 ? '重新写稿' : '开始写稿'}
            </Button>
          ) : tab === 'synth' ? (
            config.synthMode === 'pre' ? (
              <Button disabled={launching || !onSynthesize} onClick={() => onSynthesize?.(config)}>
                <AudioWaveform />
                {readyCount > 0 ? '重新合成音频' : '预先合成音频'}
              </Button>
            ) : (
              // 边播边合 / 实时：开播前没有「必须合成完」这一步，直接进开播设置
              <Button disabled={launching} onClick={() => setTab('play')}>
                <Play />
                下一步：开播设置
              </Button>
            )
          ) : (
            <Button disabled={launching} onClick={() => onConfirm(config)}>
              <Play />
              确认开播
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
