import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Persona, Program, ProgramLanguage } from '../../../../shared/types'

/**
 * 开播配置（docs/12 第五节）：点「启动节目」先过这一屏，每次都必须确认。
 *
 * 为什么必须每次过：这一场用什么人、什么嗓子、什么语言、读什么稿、用旧音频还是重合成，
 * 是"本场"的事，不是资产的事。资产（剧本/主播/音色）保持静态描述，绑定只发生在这里。
 *
 * 现在能真正落地的：语言 / 播出方式 / 收尾方式 / 音频策略（清空音频）。
 * 主播与音色的多选解耦要等 0016 迁移，这里先按现有绑定只读展示，避免给出假开关。
 */

export type SynthMode = 'pre' | 'async' | 'realtime'

export interface LaunchConfig {
  language: ProgramLanguage
  finishMode: 'loop' | 'stop'
  synthMode: SynthMode
  rebuildAudio: boolean
}

const LANGUAGES: { value: ProgramLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'Chinese', label: '中文' },
  { value: 'English', label: '英语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Korean', label: '韩语' }
]

const SYNTH_MODES: { value: SynthMode; label: string; hint: string }[] = [
  { value: 'pre', label: '预合成', hint: '开播前整段合成好，改一个字就要重合成' },
  { value: 'async', label: '边播边合成', hint: '播一条、备几条，补货跟不上会等' },
  { value: 'realtime', label: '实时流式', hint: '逐句合成立刻播，适合互动，语气连贯性略差' }
]

export function LaunchConfigDialog({
  open,
  program,
  personas,
  draftCount,
  readyCount,
  onCancel,
  onConfirm
}: {
  open: boolean
  program: Program | null
  personas: Persona[]
  draftCount: number
  readyCount: number
  onCancel: () => void
  onConfirm: (config: LaunchConfig) => void
}) {
  const [config, setConfig] = useState<LaunchConfig>({
    language: program?.language ?? 'auto',
    finishMode: program?.finishMode === 'stop' ? 'stop' : 'loop',
    synthMode: 'async',
    rebuildAudio: false
  })

  useEffect(() => {
    if (!open || !program) return
    setConfig({
      language: program.language,
      finishMode: program.finishMode === 'stop' ? 'stop' : 'loop',
      synthMode: 'async',
      rebuildAudio: false
    })
  }, [open, program])

  const cast = useMemo(
    () => (program?.personaIds ?? []).map((id) => personas.find((persona) => persona.id === id)).filter(Boolean) as Persona[],
    [program, personas]
  )

  if (!program) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>直播配置</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-[13px]">
          <p className="-mt-1 text-xs text-muted-foreground">
            {program.name} · 底稿 {draftCount} 段 · 就绪 {readyCount} 段
          </p>

          <div className="space-y-1.5">
            <Label className="text-xs">① 话术语言</Label>
            <div className="flex flex-wrap gap-1.5">
              {LANGUAGES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs',
                    config.language === item.value ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground'
                  )}
                  onClick={() => setConfig({ ...config, language: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">只决定写什么语言，不会作为参数传给 TTS。</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">② 主播与音色</Label>
            {cast.length === 0 ? (
              <p className="text-xs text-muted-foreground">本节目还没配卡司（下一步会改成开播时自由选择）</p>
            ) : (
              <ul className="space-y-1">
                {cast.map((persona) => (
                  <li key={persona.id} className="flex items-center gap-2 text-xs">
                    <span className="size-1.5 rounded-full bg-primary" />
                    <span>{persona.name}</span>
                    <span className="text-muted-foreground">· {persona.voiceId ? '已绑音色' : '未选音色'}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">
              音色的逐人选择要等资产解耦（主播不再自带音色）；现在沿用节目里已绑的那套，先开播。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">③ 播完怎么走</Label>
            <div className="flex gap-1.5">
              {[
                { value: 'loop' as const, label: '循环返场' },
                { value: 'stop' as const, label: '播完停止' }
              ].map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs',
                    config.finishMode === item.value ? 'border-primary bg-primary/5' : 'border-border text-muted-foreground'
                  )}
                  onClick={() => setConfig({ ...config, finishMode: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">④ 合成时机</Label>
            <div className="space-y-1">
              {SYNTH_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs',
                    config.synthMode === mode.value ? 'border-primary bg-primary/5' : 'border-border'
                  )}
                  onClick={() => setConfig({ ...config, synthMode: mode.value })}
                >
                  <span className={cn('mt-1 size-2 shrink-0 rounded-full', config.synthMode === mode.value ? 'bg-primary' : 'bg-border')} />
                  <span className="min-w-0">
                    <span className="text-foreground">{mode.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{mode.hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">互动回复固定走实时流式，不受这里影响。</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">⑤ 音频</Label>
            <div className="flex gap-1.5">
              <button
                type="button"
                className={cn(
                  'rounded-md border px-2 py-1 text-xs',
                  !config.rebuildAudio ? 'border-primary bg-primary/5' : 'border-border text-muted-foreground'
                )}
                onClick={() => setConfig({ ...config, rebuildAudio: false })}
              >
                复用现有音频（{readyCount} 段就绪）
              </button>
              <button
                type="button"
                className={cn(
                  'rounded-md border px-2 py-1 text-xs',
                  config.rebuildAudio ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-border text-muted-foreground'
                )}
                onClick={() => setConfig({ ...config, rebuildAudio: true })}
              >
                清空后重新合成
              </button>
            </div>
            {config.rebuildAudio && (
              <p className="flex items-start gap-1 text-[11px] text-amber-700">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                会清掉本节目已合成的音频再按当前音色重合成，期间不能开播，且会消耗 TTS 调用。
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(config)}>确认并预检</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
