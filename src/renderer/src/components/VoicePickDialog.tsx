import { useEffect, useMemo, useReducer, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { voiceDisplayName } from '../lib/voice'
import {
  TTS_MODEL_KIND_LABEL,
  type Persona,
  type ProducePlanInfo,
  type ProduceVoiceOverride,
  type Program
} from '../../../shared/types'
import { MANUAL_VOICE_SEP } from '../../../shared/voiceProvider'

/** 「其他」手动选择的本地记忆（下次合成默认带出来）；带 :v1 版本标识，以后字段变了换版本号即可整体作废 */
const LAST_PICK_KEY = 'yuncast.voicePick.last:v1'
/** 版本化之前的旧 key：只在还没写过新 key 时读一次，读到就搬过去，免得升级后上次的选音丢失 */
const LAST_PICK_LEGACY_KEY = 'yuncast.voicePick.last'

interface LastPick {
  modelValue: string
  voiceId: string
  castVoiceA: string
  castVoiceB: string
}

function readLastPick(): LastPick | null {
  try {
    const legacyRaw = localStorage.getItem(LAST_PICK_LEGACY_KEY)
    const raw = localStorage.getItem(LAST_PICK_KEY) ?? legacyRaw
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastPick>
    if (typeof parsed.modelValue !== 'string') return null
    if (legacyRaw && !localStorage.getItem(LAST_PICK_KEY)) {
      try {
        localStorage.setItem(LAST_PICK_KEY, raw)
        localStorage.removeItem(LAST_PICK_LEGACY_KEY)
      } catch {
        // 迁移写不进去（配额/隐私模式）不影响本次读取，下次再来
      }
    }
    return {
      modelValue: parsed.modelValue,
      voiceId: typeof parsed.voiceId === 'string' ? parsed.voiceId : '',
      castVoiceA: typeof parsed.castVoiceA === 'string' ? parsed.castVoiceA : '',
      castVoiceB: typeof parsed.castVoiceB === 'string' ? parsed.castVoiceB : ''
    }
  } catch {
    return null
  }
}

type PickMode = 'presenter' | 'other'

/** 弹窗里「这次用什么声音」的草稿：确认时一起读、换节目/重开时整块重置，收在一处免得漏改某个字段 */
interface PickDraft {
  mode: PickMode
  modelValue: string
  otherVoice: string
  castVoiceA: string
  castVoiceB: string
}

const EMPTY_PICK: PickDraft = {
  mode: 'presenter',
  modelValue: '',
  otherVoice: '',
  castVoiceA: '',
  castVoiceB: ''
}

type PickDraftAction =
  | { type: 'patch'; patch: Partial<PickDraft> }
  | { type: 'remember'; last: LastPick }
  | { type: 'reset'; mode: PickMode }

function pickDraftReducer(draft: PickDraft, action: PickDraftAction): PickDraft {
  if (action.type === 'patch') return { ...draft, ...action.patch }
  if (action.type === 'remember') {
    return {
      mode: 'other',
      modelValue: action.last.modelValue,
      otherVoice: action.last.voiceId,
      castVoiceA: action.last.castVoiceA,
      castVoiceB: action.last.castVoiceB
    }
  }
  return { ...EMPTY_PICK, mode: action.mode }
}

/**
 * 声音选择弹窗（docs/REDESIGN 4.4，所有合成入口统一）：点「合成」先弹这个，确认才真的合成。
 * - 显示「本次合成 N 段 · 约 X 分钟」（producePlan IPC）；
 * - 声音二选一：卡司嗓音（节目卡司第一张）/ 其他（内嵌统一音色选择器）；
 *   节目里已经不再配声音了——合成这一步是唯一的选声音入口，选完冻结进每段产物；
 * - 播客模型时「其他」呈现为主持人 A/B 两个选择器 + 开场/结尾音乐（配乐只在播客路线有意义，跟着这次选）；
 * - 池里已有其他嗓音成品时给混音提醒 + 「全部重合成统一」勾选；
 * - 上次手动选择记忆在 localStorage，下次默认带出。
 *
 * 确认后由调用方执行：onConfirm(override, rebuildAll)——override 透传给 produceAudio 冻结，
 * rebuildAll=true 时调用方先清掉对应范围的旧音频再合成。
 */
export function VoicePickDialog({
  program,
  open,
  onOpenChange,
  busy = false,
  onConfirm
}: {
  program: Program
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 外部合成进行中（禁用确认键） */
  busy?: boolean
  onConfirm: (override: ProduceVoiceOverride | undefined, rebuildAll: boolean) => void | Promise<void>
}) {
  const voices = useAppStore((s) => s.voices)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const [castPersona, setCastPersona] = useState<Persona | null>(null)

  const [plan, setPlan] = useState<ProducePlanInfo | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [draft, dispatchDraft] = useReducer(pickDraftReducer, EMPTY_PICK)
  const { mode, modelValue, otherVoice, castVoiceA, castVoiceB } = draft
  const [rebuildAll, setRebuildAll] = useState(false)
  /** 播客模型的整期配乐（跟着这次合成选；默认沿用节目里存的历史值） */
  const [headMusic, setHeadMusic] = useState(true)
  const [tailMusic, setTailMusic] = useState(false)
  /** 池里/库里已成品的嗓音（混音提醒的比对基准） */
  const [existingVoices, setExistingVoices] = useState<string[]>([])

  // 打开时拉合成计划 + 已成品的嗓音清单；默认项：上次手动选择 > 卡司第一张
  useEffect(() => {
    if (!open) return
    setPlanLoading(true)
    void window.api.program
      .producePlan(program.id)
      .then(setPlan)
      .catch(() => setPlan(null))
      .finally(() => setPlanLoading(false))
    void window.api.utterance
      .list(program.id)
      .then((items) => {
        const set = new Set<string>()
        for (const item of items) {
          if (item.status === 'ready' && item.synthVoice?.trim()) set.add(item.synthVoice.trim())
        }
        setExistingVoices([...set])
      })
      .catch(() => setExistingVoices([]))
    setRebuildAll(false)
    setHeadMusic(true)
    setTailMusic(false)
    const last = readLastPick()
    if (last?.voiceId || last?.castVoiceA) {
      dispatchDraft({ type: 'remember', last })
    } else {
      dispatchDraft({ type: 'reset', mode: 'presenter' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, program.id])

  /** 「其他」的模型下拉（接入::模型 复合值）：播客模型检测靠它 */
  const modelOptions = useMemo(
    () =>
      ttsConnections.flatMap((connection) =>
        connection.usableModels.map((model) => {
          const spec = ttsProviders
            .find((item) => item.id === connection.providerId)
            ?.models.find((item) => item.id === model)
          const kind = spec?.capabilities?.kind ?? 'standard'
          return {
            value: `${connection.id}${MANUAL_VOICE_SEP}${model}`,
            label: `${connection.name} · ${spec?.label ?? model}${kind === 'standard' ? '' : `（${TTS_MODEL_KIND_LABEL[kind]}）`}`,
            connection,
            modelId: model,
            podcast: kind === 'podcast'
          }
        })
      ),
    [ttsConnections, ttsProviders]
  )
  const pickedModel = modelOptions.find((option) => option.value === modelValue) ?? null
  const podcastMode = pickedModel?.podcast === true

  // 出镜由节目卡司决定（没有「当前出镜」全局概念）：取节目卡司第一张，没配卡司就取第一张卡
  useEffect(() => {
    if (!open || !('api' in window)) return
    let alive = true
    void window.api.persona.list().then((list) => {
      if (!alive) return
      const first = program.presenterIds[0] ? (list.find((item) => item.id === program.presenterIds[0]) ?? null) : null
      setCastPersona(first)
    })
    return () => {
      alive = false
    }
  }, [open, program.presenterIds])

  const presenterVoice = castPersona?.voiceId.trim() ?? ''
  const presenterVoiceName = presenterVoice ? voiceDisplayName(voices, ttsProviders, presenterVoice) : ''

  /** 本次选定的声音（混音提醒比对用；播客/节目安排是多个，逐个比） */
  const chosenVoices = useMemo(() => {
    if (mode === 'presenter') return presenterVoice ? [presenterVoice] : []
    if (podcastMode) return [castVoiceA.trim(), castVoiceB.trim()].filter(Boolean)
    return otherVoice.trim() ? [otherVoice.trim()] : []
  }, [mode, presenterVoice, podcastMode, castVoiceA, castVoiceB, otherVoice])

  /** 混音提醒：已有成品里有任何一把嗓音不在本次选定集合里 */
  const mixingVoices = existingVoices.filter((voice) => !chosenVoices.includes(voice))
  const showMixingWarning = mixingVoices.length > 0 && chosenVoices.length > 0

  const canConfirm =
    !busy &&
    plan?.ok === true &&
    (plan.pendingSegments ?? 0) > 0 &&
    (mode === 'presenter'
      ? presenterVoice.length > 0
      : podcastMode
        ? castVoiceA.trim().length > 0 && castVoiceB.trim().length > 0
        : otherVoice.trim().length > 0)

  const confirm = async () => {
    if (!canConfirm) return
    let override: ProduceVoiceOverride | undefined
    if (mode === 'presenter') {
      // 卡司嗓音：不传覆盖，后端按卡司第一张解析（节目不再存声音配置）
      override = undefined
    } else if (mode === 'other') {
      override = podcastMode
        ? { castVoices: [castVoiceA.trim(), castVoiceB.trim()], useHeadMusic: headMusic, useTailMusic: tailMusic }
        : { voiceId: otherVoice.trim() }
      localStorage.setItem(
        LAST_PICK_KEY,
        JSON.stringify({ modelValue, voiceId: otherVoice.trim(), castVoiceA: castVoiceA.trim(), castVoiceB: castVoiceB.trim() } satisfies LastPick)
      )
    }
    await onConfirm(override, showMixingWarning && rebuildAll)
  }

  const optionRow = (
    value: PickMode,
    title: string,
    desc: string,
    disabled = false
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => dispatchDraft({ type: 'patch', patch: { mode: value } })}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
        mode === value ? 'border-primary bg-primary/5' : 'hover:bg-accent/60',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      {mode === value ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
      )}
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  )

  const pending = plan?.pendingSegments ?? 0

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>合成声音 · {program.name}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {planLoading ? (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在统计要合成的段数…
            </p>
          ) : plan?.ok ? (
            <p className="text-[13px]">
              本次合成 {pending} 段{plan.estMinutes ? ` · 约 ${plan.estMinutes} 分钟` : ''}
              {(plan.readyCount ?? 0) > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">已就绪 {plan.readyCount} 个单元自动跳过</span>
              )}
            </p>
          ) : (
            <p className="text-[13px] text-destructive">{plan?.error ?? '合成计划拿不到，稍后再试'}</p>
          )}

          {plan?.ok && pending > 0 && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">声音</Label>
                {optionRow(
                  'presenter',
                  `卡司嗓音${castPersona?.name ? `（${castPersona.name}）` : ''}`,
                  presenterVoiceName
                    ? presenterVoiceName
                    : castPersona
                      ? '卡司还没选音色'
                      : '未选主播：本节目没配卡司，逐段用 speaker 指定，或在下面选其他音色'
                )}
                {optionRow('other', '选择其他音色…', '换一把嗓音合成这一次，不改节目配置')}
              </div>

              {mode === 'other' && (
                <div className="flex flex-col gap-2 rounded-lg border p-2.5">
                  {/* 声音就用统一选择器（服务商 → 模型 → 音色 + 能力徽章），不再另起一个模型下拉 */}
                  {podcastMode ? (
                    <div className="flex flex-col gap-2">
                      {(
                        [
                          ['主持人 A', 'castVoiceA'],
                          ['主持人 B', 'castVoiceB']
                        ] as const
                      ).map(([label, field]) => (
                        <div key={label}>
                          <Label className="mb-1 text-xs text-muted-foreground">{label}音色</Label>
                          <UnifiedVoicePicker
                            voiceId={draft[field]}
                            onPick={(voiceId) => dispatchDraft({ type: 'patch', patch: { [field]: voiceId } })}
                            connections={[pickedModel.connection]}
                            fixedModelId={pickedModel.modelId}
                          />
                        </div>
                      ))}
                      <p className="text-xs text-muted-foreground">
                        双人播客模型：整期一次合成，两位主持人的音色要挂在同一个播客模型下
                      </p>
                      {/* 配乐跟着这次合成选：它只在播客这一条路线上有意义，所以不放在节目配置里 */}
                      <div className="flex items-center gap-5">
                        <label className="flex items-center gap-1.5 text-xs">
                          <Switch checked={headMusic} onCheckedChange={(v) => setHeadMusic(v === true)} aria-label="开场音乐" />
                          开场音乐
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                          <Switch checked={tailMusic} onCheckedChange={(v) => setTailMusic(v === true)} aria-label="结尾音乐" />
                          结尾音乐
                        </label>
                      </div>
                    </div>
                  ) : (
                    <UnifiedVoicePicker
                      voiceId={otherVoice}
                      onPick={(voiceId) => dispatchDraft({ type: 'patch', patch: { otherVoice: voiceId } })}
                      onModelChange={(modelId, connectionId) => {
                        const hit = modelOptions.find(
                          (option) => option.modelId === modelId && option.connection.id === connectionId
                        )
                        dispatchDraft({ type: 'patch', patch: { modelValue: hit?.value ?? '' } })
                      }}
                    />
                  )}
                </div>
              )}

              {showMixingWarning && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                  <p className="flex items-start gap-1.5 text-[13px] text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    已有 {mixingVoices.length} 把其他嗓音的成品，本次换声音会混音
                  </p>
                  <label className="mt-1.5 flex items-center gap-2 text-[13px]">
                    <Checkbox checked={rebuildAll} onCheckedChange={(v) => setRebuildAll(v === true)} />
                    全部重合成，统一为本次选的声音（旧音频清掉）
                  </label>
                </div>
              )}
            </>
          )}
          {plan?.ok && pending === 0 && (
            <p className="text-[13px] text-muted-foreground">都合成好了，没有要合成的段落。</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canConfirm} onClick={() => void confirm()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            开始合成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
