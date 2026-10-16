import { useState } from 'react'
import { AlertTriangle, AudioWaveform, CircleAlert, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { VoicePickDialog } from './VoicePickDialog'
import type { LaunchResult, ProduceVoiceOverride, Program, ProgramGateResult } from '../../../shared/types'
import { AUDIO_UNIT_LABEL } from '../lib/audioUnits'

/**
 * 预制节目正式播放门禁未通过的明确提示（docs/10 §7.8）：绝不静默跳过、绝不静默播旧音频。
 * 三个去向：继续生成（跑完自动重新过门禁，过了就直接开播）/ 重试失败项 / 仅播放已完成部分。
 * 直播台的「启动节目」和节目卡的「播放」共用这一个弹窗。
 */
export function ProgramGateDialog({
  program,
  gate,
  open,
  onOpenChange,
  onGateChange,
  onLaunched
}: {
  program: Program
  gate: ProgramGateResult
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 继续生成后门禁仍不过：拿最新门禁结果刷新弹窗 */
  onGateChange: (gate: ProgramGateResult) => void
  /** 启动成功（完整或仅已完成部分）：父级提示并收尾 */
  onLaunched: (result: LaunchResult) => void
}) {
  const [busy, setBusy] = useState<'' | 'produce' | 'partial'>('')
  /** 「继续生成」先弹声音选择弹窗（docs/REDESIGN 4.4），确认才发起合成 */
  const [voicePickOpen, setVoicePickOpen] = useState(false)
  const unitLabel = AUDIO_UNIT_LABEL[program.contentType]

  const launchNow = async (allowPartial: boolean) => {
    const result = await window.api.program.launch(program.id, { allowPartial })
    if (result.ok) {
      onOpenChange(false)
      onLaunched(result)
    } else if (result.gate) {
      onGateChange(result.gate)
    } else {
      toast.error('启动失败', { description: result.error })
    }
  }

  /** 继续生成 / 重试失败项：统一生产入口只重做未完成与失败项，跑完重新过门禁 */
  const produce = async (voiceOverride?: ProduceVoiceOverride, rebuildAll?: boolean) => {
    if (busy) return
    setVoicePickOpen(false)
    setBusy('produce')
    try {
      if (rebuildAll) await window.api.utterance.clearAudio(program.id)
      const result = await window.api.program.produceAudio(program.id, voiceOverride)
      if (!result.ok) {
        toast.error('生成节目音频没能完成', { description: result.error })
        return
      }
      if (result.failed > 0) {
        toast.warning(`生成完成，还有 ${result.failed} ${unitLabel}失败`, {
          description: result.notice
        })
      }
      const fresh = await window.api.program.playGate(program.id)
      if (fresh.ok) {
        await launchNow(false)
      } else {
        onGateChange(fresh)
      }
    } finally {
      setBusy('')
    }
  }

  const playPartial = async () => {
    if (busy) return
    setBusy('partial')
    try {
      await launchNow(true)
    } finally {
      setBusy('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>当前节目还不能完整播放</DialogTitle>
        </DialogHeader>
        <p className="text-[13px]">
          已完成 {gate.ready}/{gate.total} {unitLabel}
          {gate.failed > 0 && ` · 失败 ${gate.failed} ${unitLabel}`}
          {gate.pending > 0 && ` · 待合成 ${gate.pending} ${unitLabel}`}
          {gate.synthesizing > 0 && ` · 合成中 ${gate.synthesizing} ${unitLabel}`}
          {gate.stale > 0 && ` · 文稿已修改 ${gate.stale} ${unitLabel}`}
        </p>
        {gate.failures.length > 0 && (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {gate.failures.map((failure) => (
              <div
                key={`${failure.unitKind}:${failure.unitId}`}
                className="flex items-start gap-2 rounded-md border px-2.5 py-1.5"
              >
                {failure.status === 'stale' ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                ) : (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-red-600" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[13px]">
                    {failure.title || '（无标题）'}
                    {failure.status === 'stale' && (
                      <span className="ml-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        文稿已修改
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{failure.reason}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="ghost" disabled={busy !== ''} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={busy !== '' || gate.ready === 0}
            onClick={() => void playPartial()}
            title={gate.ready === 0 ? '还没有已完成的单元' : `只播已完成的 ${gate.ready} ${unitLabel}，缺的部分跳过`}
          >
            {busy === 'partial' ? <Loader2 className="animate-spin" /> : <Play />}
            仅播放已完成部分
          </Button>
          {/* 一个按钮管到底：缺的、失败的、文稿改过的都会重新合成（原来「重试失败项」跟它是同一个动作，删掉） */}
          <Button
            disabled={busy !== ''}
            onClick={() => setVoicePickOpen(true)}
            title="把还没合成、合成失败、文稿改过的单元都补齐，再正式开播"
          >
            {busy === 'produce' ? <Loader2 className="animate-spin" /> : <AudioWaveform />}
            继续生成（补齐音频）
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 补合成前统一过声音选择弹窗（docs/REDESIGN 4.4）：确认后回到本弹窗继续跑门禁 */}
      <VoicePickDialog
        program={program}
        open={voicePickOpen}
        onOpenChange={setVoicePickOpen}
        busy={busy === 'produce'}
        onConfirm={(override, rebuildAll) => produce(override, rebuildAll)}
      />
    </Dialog>
  )
}
