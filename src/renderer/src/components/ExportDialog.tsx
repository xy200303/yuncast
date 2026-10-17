import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, Download, FolderOpen, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type {
  Program,
  ProgramExportFormat,
  ProgramExportMode,
  ProgramExportResult,
  ProgramGateFailure
} from '../../../shared/types'
import { AUDIO_UNIT_LABEL } from '../lib/audioUnits'

const DEFAULT_TEMPLATE = '{节目名}-{序号}-{段标题}'

type Phase =
  | { kind: 'config' }
  | { kind: 'running'; current: number; total: number; title: string }
  | { kind: 'done'; result: ProgramExportResult }

/**
 * 节目音频导出弹窗（docs/10 §8.3/§11.6，P6）：全部段、分段/合并、MP3/WAV、响度归一。
 * 缺音频不静默跳过（§15.5）：默认禁用开始并列出缺失的段，勾选「仅导出已完成部分」才放行。
 * 导出中禁关弹窗（要停就点「取消导出」），完成后显示产出清单与「打开目录」。
 * 入口在节目页的节目卡上；直播现场（滚动/即兴）的音频走「场次记录」的整场导出。
 */
export function ExportDialog({
  program,
  open,
  onOpenChange
}: {
  program: Program
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const unitLabel = AUDIO_UNIT_LABEL[program.contentType]
  const [loading, setLoading] = useState(false)
  const [gateError, setGateError] = useState('')
  const [missing, setMissing] = useState<ProgramGateFailure[]>([])
  const [totalUnits, setTotalUnits] = useState(0)
  const [readyUnits, setReadyUnits] = useState(0)
  const [mode, setMode] = useState<ProgramExportMode>('separate')
  const [format, setFormat] = useState<ProgramExportFormat>('mp3')
  const [loudness, setLoudness] = useState(false)
  const [onlyReady, setOnlyReady] = useState(false)
  const [outputDir, setOutputDir] = useState('')
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [phase, setPhase] = useState<Phase>({ kind: 'config' })

  const running = phase.kind === 'running'

  /** 打开时拉门禁结果：缺段清单与导出本体的「可导出」判定同口径（不静默跳过） */
  const refreshGate = useCallback(async () => {
    setLoading(true)
    setGateError('')
    try {
      if (program.broadcastMode !== 'prepared') {
        setTotalUnits(0)
        setReadyUnits(0)
        setMissing([])
        setGateError('滚动/即兴节目没有节目级预制音频可导出（只有预制节目支持导出）')
        return
      }
      const gate = await window.api.program.playGate(program.id)
      setTotalUnits(gate.total)
      setReadyUnits(gate.ready)
      setMissing(gate.failures)
      if (gate.total === 0) setGateError('节目还没有文稿，没有可导出的音频')
    } finally {
      setLoading(false)
    }
  }, [program.id, program.broadcastMode])

  useEffect(() => {
    // 只拉数据，不同步草稿态：父层是「打开才挂载」（ProgramsPage 用 exporting && <ExportDialog open />），
    // 重新打开等价于重新挂载，phase/onlyReady 的初始值本就对；不这样写，用户改到一半的勾选/进度会被无关渲染冲掉
    if (open) void refreshGate()
  }, [open, refreshGate])

  /** 进度事件只认本节目的（别处可能也在导出/弹窗实例共存） */
  useEffect(() => {
    return window.api.program.onExportEvent((progress) => {
      if (progress.programId !== program.id) return
      if (progress.status === 'running') {
        setPhase({ kind: 'running', current: progress.current, total: progress.total, title: progress.title })
      }
    })
  }, [program.id])

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
    setPhase({ kind: 'running', current: 0, total: readyUnits, title: '准备中' })
    const result = await window.api.program.exportAudio({
      programId: program.id,
      mode,
      format,
      outputDir: outputDir.trim(),
      fileNameTemplate: template.trim() || DEFAULT_TEMPLATE,
      loudness,
      onlyReady
    })
    if (result.ok) {
      setPhase({ kind: 'done', result })
    } else if (result.cancelled) {
      setPhase({ kind: 'config' })
      toast.warning('导出已取消', { description: result.error })
      void refreshGate()
    } else {
      setPhase({ kind: 'config' })
      toast.error('导出失败', { description: result.error })
      void refreshGate()
    }
  }

  const cancel = async () => {
    await window.api.program.exportCancel()
  }

  const blockedMissing = missing.length > 0 && !onlyReady
  const startDisabled = loading || gateError !== '' || readyUnits === 0 || blockedMissing || !outputDir.trim()

  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent
        className="sm:max-w-md"
        // 导出中禁关：Esc / 点遮罩都不响应（要停就点「取消导出」，语义明确）
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onPointerDownOutside={(e) => running && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>导出节目音频 · {program.name}</DialogTitle>
        </DialogHeader>

        {phase.kind !== 'done' ? (
          <div className="flex flex-col gap-3 text-[13px]">
            {/* 导出范围：第一版固定全部段（§8.3 第一版不做当前段单选） */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">导出范围</span>
              <span>
                全部 {totalUnits} {unitLabel}
                {missing.length > 0 && `（${readyUnits} 个可导出）`}
              </span>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在检查音频就绪情况…
              </div>
            ) : gateError ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <CircleAlert className="size-3.5 text-red-600" />
                {gateError}
              </div>
            ) : (
              missing.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2">
                  <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="size-3.5" />
                    还有 {missing.length} {unitLabel}缺音频
                  </p>
                  <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
                    {/* 每条失败记录对应一个音频单元，unitKind+unitId 是它的天然主键（同一单元只会出现一次），比下标稳定 */}
                    {missing.map((item) => (
                      <p key={`${item.unitKind}:${item.unitId}`} className="text-xs text-muted-foreground">
                        {item.title || '（无标题）'}：{item.reason}
                      </p>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={onlyReady}
                      onCheckedChange={(v) => setOnlyReady(v === true)}
                      disabled={readyUnits === 0}
                      aria-label="仅导出已完成部分"
                    />
                    仅导出已完成部分（{readyUnits} {unitLabel}）
                  </label>
                </div>
              )
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">方式</span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={mode === 'separate' ? 'secondary' : 'outline'}
                  disabled={running}
                  onClick={() => setMode('separate')}
                >
                  分段导出
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'merged' ? 'secondary' : 'outline'}
                  disabled={running}
                  onClick={() => setMode('merged')}
                >
                  合并为一个文件
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">格式</span>
              <Select value={format} onValueChange={(v) => setFormat(v as ProgramExportFormat)} disabled={running}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp3">MP3</SelectItem>
                  <SelectItem value="wav">WAV</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">统一音量（各段响度拉齐，不会忽大忽小）</span>
              <Switch checked={loudness} onCheckedChange={(v) => setLoudness(v === true)} disabled={running} aria-label="统一音量" />
            </label>

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">输出目录</span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="max-w-52 truncate text-xs" title={outputDir}>
                  {outputDir || '（未选择）'}
                </span>
                <Button size="sm" variant="outline" disabled={running} onClick={() => void pickDir()}>
                  <FolderOpen />
                  选择
                </Button>
              </div>
            </div>

            {mode === 'separate' && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">文件名模板</span>
                <Input
                  className="h-8 w-64 text-xs"
                  value={template}
                  disabled={running}
                  onChange={(e) => setTemplate(e.target.value)}
                  placeholder={DEFAULT_TEMPLATE}
                />
              </div>
            )}
            {mode === 'separate' && (
              <p className="-mt-2 text-right text-xs text-muted-foreground">
                可用变量：{'{节目名}'} {'{序号}'} {'{段标题}'}；重名自动加 -2 后缀，不覆盖
              </p>
            )}

            {phase.kind === 'running' && (
              <div className="flex flex-col gap-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${phase.total > 0 ? Math.round((phase.current / phase.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  正在导出 {phase.current}/{phase.total}
                  {phase.title && ` · ${phase.title}`}
                </p>
              </div>
            )}
          </div>
        ) : (
          /* 完成：产出文件清单 + 打开目录 */
          <div className="flex flex-col gap-2 text-[13px]">
            <p>
              导出完成：{phase.result.files?.length ?? 0} 个文件
            </p>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border px-2.5 py-2">
              {(phase.result.files ?? []).map((file) => (
                <p key={file} className="truncate text-xs text-muted-foreground" title={file}>
                  {file}
                </p>
              ))}
            </div>
            {phase.result.warning && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {phase.result.warning}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-end">
          {phase.kind === 'done' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button onClick={() => void window.api.program.openExportDir(phase.result.outputDir ?? '')}>
                <FolderOpen />
                打开目录
              </Button>
            </>
          ) : running ? (
            <Button variant="destructive" onClick={() => void cancel()}>
              取消导出
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={startDisabled}
                title={
                  blockedMissing
                    ? `还有 ${missing.length} ${unitLabel}缺音频：补齐合成，或勾选「仅导出已完成部分」`
                    : !outputDir.trim()
                      ? '先选输出目录'
                      : undefined
                }
                onClick={() => void start()}
              >
                <Download />
                开始导出
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
