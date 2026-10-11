import { useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, Square, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '../stores/useAppStore'
import type { VoiceRecord } from '../../../shared/types'

const PROVIDER_LABEL: Record<VoiceRecord['provider'], string> = {
  volcano: '火山引擎',
  bailian: '阿里云百炼'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 音色库：克隆音色的管理与训练状态。
 *  克隆在服务商侧异步训练，本页轮询/接收广播更新状态；「设为默认音色」写 config.tts.voiceId。 */
export function VoicesPage() {
  const voices = useAppStore((s) => s.voices)
  const defaultVoiceId = useAppStore((s) => s.config.tts.voiceId)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<VoiceRecord | null>(null)

  const reload = () => void window.api.voice.list().then(useAppStore.getState().setVoices)
  useEffect(reload, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <AudioLines className="size-4 text-primary" />
        <h1 className="text-sm font-medium">音色库</h1>
        <p className="text-xs text-muted-foreground">克隆音色管理 · 训练完成后可设为默认或角色音色</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            刷新
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Mic />
            新建音色
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {voices.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-muted-foreground">
            <AudioLines className="size-8" strokeWidth={1.25} />
            <p className="text-sm">还没有克隆音色。点右上角「新建音色」，上传或录制一段 10-30 秒清晰人声</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {voices.map((voice) => {
              const isDefault = voice.status === 'ready' && voice.voiceType === defaultVoiceId
              return (
                <div key={voice.id} className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{voice.name}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isDefault && <Badge variant="secondary">默认</Badge>}
                      <Badge variant="outline">{PROVIDER_LABEL[voice.provider]}</Badge>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {voice.status === 'training' && (
                      <Badge variant="outline" className="gap-1">
                        <Loader2 className="size-3 animate-spin" />
                        训练中
                      </Badge>
                    )}
                    {voice.status === 'ready' && <Badge variant="secondary">就绪</Badge>}
                    {voice.status === 'failed' && <Badge variant="destructive">失败</Badge>}
                    <span className="text-xs text-muted-foreground">{formatTime(voice.createdAt)}</span>
                  </div>

                  {voice.voiceType && (
                    <p className="truncate text-xs text-muted-foreground" title={voice.voiceType}>
                      音色标识：{voice.voiceType}
                    </p>
                  )}
                  {voice.status === 'failed' && voice.error && (
                    <p className="text-xs text-destructive">{voice.error}</p>
                  )}

                  <div className="mt-auto flex justify-end gap-1.5 pt-1">
                    {voice.status === 'ready' && !isDefault && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void window.api.voice.setDefault(voice.id).then((r) => {
                            if (r.ok) {
                              toast.success('已设为默认音色')
                              void useAppStore.getState().loadConfig()
                            } else toast.error('设置失败', { description: r.error })
                          })
                        }}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(voice)}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <NewVoiceDialog open={adding} onOpenChange={setAdding} onDone={reload} />

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除音色</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？样本文件会一并删除，平台侧的复刻音色需要在服务商控制台单独清理。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                void window.api.voice.remove(target.id).then((r) => {
                  if (r.ok) {
                    toast.success('已删除')
                    reload()
                  } else toast.error('删除失败', { description: r.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 新建音色：上传音频或现场录音 → 勾选授权 → 提交复刻 */
function NewVoiceDialog({
  open,
  onOpenChange,
  onDone
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [samplePath, setSamplePath] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setSamplePath('')
      setAuthorized(false)
      setSeconds(0)
    } else {
      stopRecording()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pickFile = async () => {
    const path = await window.api.dialog.pickFile('音频文件', ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'])
    if (path) setSamplePath(path)
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        void blob.arrayBuffer().then(async (buf) => {
          const result = await window.api.voice.uploadSample(new Uint8Array(buf), 'webm')
          if (result.ok) {
            setSamplePath(result.path)
            toast.success('录音已保存')
          } else {
            toast.error('录音保存失败', { description: result.error })
          }
        })
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      setSeconds(0)
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
    } catch (error) {
      toast.error('无法访问麦克风', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
  }

  const submit = () => {
    if (busy) return
    if (!samplePath) {
      toast.warning('请先上传或录制样本音频')
      return
    }
    setBusy(true)
    void window.api.voice
      .clone({ name, samplePath, authorized })
      .then((result) => {
        if (result.ok) {
          toast.success('克隆任务已提交', { description: '训练完成后音色卡片会变为「就绪」' })
          onOpenChange(false)
          onDone()
        } else {
          toast.error('提交失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建音色（声音克隆）</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <Label className="mb-1">音色名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：店主本人 / 小助理" />
          </div>

          <div>
            <Label className="mb-1">声音样本（建议 10-30 秒清晰人声，无背景音乐）</Label>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void pickFile()}>
                <Upload />
                上传音频
              </Button>
              <Button
                variant={recording ? 'destructive' : 'outline'}
                size="sm"
                onClick={() => (recording ? stopRecording() : void startRecording())}
              >
                {recording ? <Square /> : <Mic />}
                {recording ? `停止录音（${seconds}s）` : '现场录音'}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {samplePath ? samplePath.split(/[\\/]/).pop() : '尚未选择样本'}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2">
            <Switch checked={authorized} onCheckedChange={setAuthorized} aria-label="授权确认" />
            <div className="text-xs">
              <p className="text-[13px]">我确认已获得录音人的明确授权</p>
              <p className="mt-0.5 text-muted-foreground">
                克隆音色需本人授权（合规要求）。本应用的克隆流程要求此确认，并记录授权时间。
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            提交后由火山引擎异步训练（通常秒级完成），本页会自动更新状态。账号需已开通「声音复刻」权限。
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !name.trim() || !samplePath || !authorized} onClick={submit}>
            {busy ? '提交中…' : '提交克隆'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
