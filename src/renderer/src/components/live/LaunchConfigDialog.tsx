import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
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
  type Trigger
} from '../../../../shared/types'

/**
 * 直播配置（docs/12 第五节）：点「启动直播」先过这一屏，每次都必须人点确认。
 * 版式照「新建 SSH」那类分组表单：顶部标题，中间四个标签页（基本/播出/主播/互动），
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

/** 上次配置 / 默认值 → 本次预填（必须人点确认，预填值不写回资产） */
function prefill(session: SessionConfig | null): LaunchConfig {
  if (session) {
    return {
      language: session.language,
      contentType: session.contentType,
      instruction: session.instruction,
      preset: session.preset,
      contentSource: session.contentSource,
      synthMode: session.synthMode,
      endMode: session.endMode,
      audioPolicy: 'reuse',
      allowLiveEvents: session.allowLiveEvents,
      enabledTriggerIds: session.enabledTriggerIds,
      voiceId: session.voiceId ?? ''
    }
  }
  return {
    ...DEFAULT_SESSION_CONFIG
  }
}

export function LaunchConfigDialog({
  open,
  program,
  triggers,
  session,
  draftCount,
  readyCount,
  onCancel,
  onConfirm
}: {
  open: boolean
  program: Program | null
  triggers: Trigger[]
  session: SessionConfig | null
  draftCount: number
  readyCount: number
  onCancel: () => void
  onConfirm: (config: LaunchConfig) => void
}) {
  const [config, setConfig] = useState<LaunchConfig>(() =>
    program ? prefill(session) : { ...DEFAULT_SESSION_CONFIG }
  )

  useEffect(() => {
    if (!open || !program) return
    setConfig(prefill(session))
  }, [open, program, session])

  const patch = (part: Partial<LaunchConfig>) => setConfig((prev) => ({ ...prev, ...part }))

  const applyPreset = (value: string) => {
    const preset = value as LaunchConfig['preset']
    if (!preset) return patch({ preset })
    const found = SESSION_PRESETS.find((item) => item.id === preset)
    if (!found) return
    patch({
      preset,
      contentSource: found.contentSource,
      synthMode: found.synthMode,
      endMode: found.endMode
    })
  }

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

        <Tabs defaultValue="basic" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="shrink-0 border-b px-7">
            <TabsList className="w-full justify-start gap-1">
              <TabsTrigger value="basic" className="text-[12.5px]">
                基本
              </TabsTrigger>
              <TabsTrigger value="broadcast" className="text-[12.5px]">
                播出
              </TabsTrigger>
              <TabsTrigger value="voice" className="text-[12.5px]">
                声音
              </TabsTrigger>
              <TabsTrigger value="interaction" className="text-[12.5px]">
                互动
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="basic" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-5">
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

          <TabsContent value="broadcast" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-5">
              <Field label="内容来源">
                <Segmented
                  value={config.contentSource}
                  options={[
                    { value: 'script', label: '本场话术' },
                    { value: 'infinite', label: '边播边无限生成' }
                  ]}
                  onChange={(contentSource) => patch({ contentSource })}
                />
              </Field>

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
                  onChange={(synthMode) => patch({ synthMode })}
                />
              </Field>

              <Field label="收尾">
                <Segmented
                  value={config.endMode}
                  options={[
                    { value: 'stop', label: '一遍播完' },
                    { value: 'loop', label: '循环返场' },
                    { value: 'forever', label: '一直播' }
                  ]}
                  onChange={(endMode) => patch({ endMode })}
                />
              </Field>

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
            </div>
          </TabsContent>

          <TabsContent value="voice" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-4">
              <p className="text-[12px] text-muted-foreground">
                本场默认音色；段落可以在写稿时单独覆盖。没选音色时新内容没法合成，存量音频照播。
              </p>
              <Field label="默认音色">
                <UnifiedVoicePicker
                  voiceId={config.voiceId}
                  onPick={(voiceId) => patch({ voiceId })}
                  emptyLabel="未选音色"
                  placeholder="选择音色"
                />
              </Field>
            </div>
          </TabsContent>

          <TabsContent value="interaction" className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
            <div className="flex flex-col gap-4">
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  checked={config.allowLiveEvents}
                  onCheckedChange={(checked) => patch({ allowLiveEvents: checked === true })}
                />
                读评论区 / 礼物 / 进场
              </label>
              <p className="text-[11.5px] text-muted-foreground">关闭后评论、礼物、进场都不派给主播。</p>
              {config.allowLiveEvents && triggers.length > 0 && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-t pt-4">
                  {triggers.map((trigger) => (
                    <label key={trigger.id} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <Checkbox
                        checked={config.enabledTriggerIds.includes(trigger.id)}
                        onCheckedChange={(checked) =>
                          patch({
                            enabledTriggerIds: checked
                              ? [...new Set([...config.enabledTriggerIds, trigger.id])]
                              : config.enabledTriggerIds.filter((id) => id !== trigger.id)
                          })
                        }
                      />
                      <span className="truncate">{trigger.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-7 py-3">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(config)}>确认并预检 →</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
