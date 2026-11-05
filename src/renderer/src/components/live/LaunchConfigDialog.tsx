import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Persona, Program, ProgramLanguage, VoiceRecord } from '../../../../shared/types'

/**
 * 开播配置（docs/12 第五节）：点「启动节目」先过这一屏，每次都必须确认。
 *
 * 版式取向：**设置清单**，不是表单堆。
 * - 左标签 / 右控件，一行一组，用分隔线分段（不画框、不编号）
 * - 同类选择统一用分段控件（segmented），比散落的 chip 安静得多
 * - 只有真需要解释的（合成时机、清空重合成）才给一行小字，其余不写
 * - 底部只留一个主操作，右边箭头提示"下一步是预检"
 */

export type SynthMode = 'pre' | 'async' | 'realtime'

export interface LaunchConfig {
  language: ProgramLanguage
  finishMode: 'loop' | 'stop'
  synthMode: SynthMode
  rebuildAudio: boolean
  /** 主播 → 音色：只在本场生效，不改主播卡 */
  personaVoices: { personaId: string; voiceId: string }[]
}

const LANGUAGES: { value: ProgramLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'Chinese', label: '中文' },
  { value: 'English', label: '英语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Korean', label: '韩语' }
]

const SYNTH_MODES: { value: SynthMode; label: string; hint: string }[] = [
  { value: 'pre', label: '预合成', hint: '开播前全部合成好；改一个字要重合成' },
  { value: 'async', label: '边播边合', hint: '播一条备几条；补货跟不上时会等' },
  { value: 'realtime', label: '实时', hint: '逐句合成立刻播；互动最快，语气连贯性略差' }
]

/** 分段控件：同一行里单选，选中项用白底 + 细边框浮起来，不选的不带框 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div className={cn('inline-flex rounded-lg bg-muted/70 p-0.5', disabled && 'opacity-50')}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[6px] px-2.5 py-1 text-[12.5px] transition-colors',
              active
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** 一行设置：左标签（定宽）+ 右控件 */
function Row({
  label,
  children,
  hint,
  last
}: {
  label: string
  children: React.ReactNode
  hint?: string
  last?: boolean
}) {
  return (
    <div className={cn('flex items-start gap-4 py-3', !last && 'border-b border-border/60')}>
      <span className="w-16 shrink-0 pt-1 text-[12.5px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {children}
        {hint && <p className="text-[11.5px] leading-relaxed text-muted-foreground/80">{hint}</p>}
      </div>
    </div>
  )
}

export function LaunchConfigDialog({
  open,
  program,
  personas,
  voices,
  draftCount,
  readyCount,
  onCancel,
  onConfirm
}: {
  open: boolean
  program: Program | null
  personas: Persona[]
  voices: VoiceRecord[]
  draftCount: number
  readyCount: number
  onCancel: () => void
  onConfirm: (config: LaunchConfig) => void
}) {
  const [config, setConfig] = useState<LaunchConfig>({
    language: program?.language ?? 'auto',
    finishMode: program?.finishMode === 'stop' ? 'stop' : 'loop',
    synthMode: 'async',
    rebuildAudio: false,
    personaVoices: []
  })

  useEffect(() => {
    if (!open || !program) return
    setConfig({
      language: program.language,
      finishMode: program.finishMode === 'stop' ? 'stop' : 'loop',
      synthMode: 'async',
      rebuildAudio: false,
      personaVoices: (program.personaIds ?? []).map((id) => {
        const persona = personas.find((item) => item.id === id)
        return { personaId: id, voiceId: persona?.defaultVoiceId || persona?.voiceId || '' }
      })
    })
  }, [open, program])

  /** 本场实际出镜的主播：开播配置里选中的那些（不再是节目里写死的卡司） */
  const cast = useMemo(
    () =>
      config.personaVoices
        .map((pair) => personas.find((persona) => persona.id === pair.personaId))
        .filter(Boolean) as Persona[],
    [config.personaVoices, personas]
  )
  /** 还没选进来的候选主播（可从"加主播"里挑） */
  const candidates = useMemo(
    () => personas.filter((persona) => !config.personaVoices.some((pair) => pair.personaId === persona.id)),
    [personas, config.personaVoices]
  )

  if (!program) return null
  const synthHint = SYNTH_MODES.find((mode) => mode.value === config.synthMode)?.hint

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-[560px] gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-4">
          <DialogTitle className="text-[15px]">直播配置</DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {program.name}
            <span className="mx-1.5 text-border">|</span>
            底稿 {draftCount} 段
            <span className="mx-1.5 text-border">|</span>
            就绪 {readyCount} 段
          </p>
        </DialogHeader>

        <div className="px-6">
          <Row label="语言" hint="只决定写什么语言，不会作为参数传给 TTS。">
            <Segmented
              value={config.language}
              options={LANGUAGES}
              onChange={(language) => setConfig({ ...config, language })}
            />
          </Row>

          <Row label="播完">
            <Segmented
              value={config.finishMode}
              options={[
                { value: 'loop' as const, label: '循环返场' },
                { value: 'stop' as const, label: '播完停止' }
              ]}
              onChange={(finishMode) => setConfig({ ...config, finishMode })}
            />
          </Row>

          <Row label="合成" hint={synthHint}>
            <Segmented
              value={config.synthMode}
              options={SYNTH_MODES.map(({ value, label }) => ({ value, label }))}
              onChange={(synthMode) => setConfig({ ...config, synthMode })}
            />
          </Row>

          <Row
            label="音频"
            hint={
              config.rebuildAudio
                ? undefined
                : '沿用已合成好的音频，只有缺失或失效的段才补合成。'
            }
          >
            <Segmented
              value={config.rebuildAudio ? 'rebuild' : 'reuse'}
              options={[
                { value: 'reuse' as const, label: `复用已有（${readyCount} 段）` },
                { value: 'rebuild' as const, label: '清空重合成' }
              ]}
              onChange={(mode) => setConfig({ ...config, rebuildAudio: mode === 'rebuild' })}
            />
            {config.rebuildAudio && (
              <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-800">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                会先清掉本节目已合成的音频再重做，期间不能开播，并消耗 TTS 调用。
              </p>
            )}
          </Row>

          <div className="border-t border-border/60 py-3">
            <div className="flex items-center gap-4">
              <span className="w-16 shrink-0 text-[12.5px] text-muted-foreground">主播</span>
              <div className="min-w-0 flex-1 space-y-1.5">
                {cast.map((persona) => {
                  const picked = config.personaVoices.find((pair) => pair.personaId === persona.id)?.voiceId ?? ''
                  return (
                    <div key={persona.id} className="flex items-center gap-2">
                      <i className="size-1.5 shrink-0 rounded-full bg-primary" />
                      <span className="w-14 shrink-0 truncate text-[12.5px]">{persona.name}</span>
                      <select
                        value={picked}
                        onChange={(event) =>
                          setConfig({
                            ...config,
                            personaVoices: config.personaVoices.map((pair) =>
                              pair.personaId === persona.id ? { ...pair, voiceId: event.target.value } : pair
                            )
                          })
                        }
                        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px]"
                      >
                        <option value="">默认（主播卡上的音色）</option>
                        {voices.map((voice) => (
                          <option key={voice.id} value={voice.voiceType || voice.id}>
                            {voice.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setConfig({
                            ...config,
                            personaVoices: config.personaVoices.filter((pair) => pair.personaId !== persona.id)
                          })
                        }
                      >
                        移出
                      </button>
                    </div>
                  )
                })}
                {candidates.length > 0 && (
                  <div className="flex items-center gap-2 pt-0.5">
                    <span className="w-14 shrink-0" />
                    <select
                      value=""
                      onChange={(event) => {
                        const persona = personas.find((item) => item.id === event.target.value)
                        if (!persona) return
                        setConfig({
                          ...config,
                          personaVoices: [
                            ...config.personaVoices,
                            { personaId: persona.id, voiceId: persona.defaultVoiceId || persona.voiceId || '' }
                          ]
                        })
                      }}
                      className="h-7 min-w-0 flex-1 rounded-md border border-dashed border-border bg-background px-2 text-[12.5px] text-muted-foreground"
                    >
                      <option value="">＋ 加主播</option>
                      {candidates.map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <p className="text-[11.5px] leading-relaxed text-muted-foreground/80">
                  出镜人选与嗓子都在这里定，只影响本场；节目里配的卡司只作为默认勾选。
                </p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-6 py-3">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" onClick={() => onConfirm(config)}>
            确认并预检 →
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
