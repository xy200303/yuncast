import { useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, Pencil, Play, Square, Trash2, Upload, RefreshCw } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ProviderIcon } from '@/components/ProviderIcon'
import { cn } from '@/lib/utils'
import { AssetStaleBanner } from './AssetStaleBanner'
import { cloneVoiceHint, flattenModelCatalog, type CatalogModel } from '@/lib/voice'
import { useAppStore } from '../stores/useAppStore'
import { useDataRefresh } from '../lib/useDataRefresh'
import { TTS_PROVIDER_SHORT, type VoiceRecord, type VoiceUsage } from '../../../shared/types'

/** 只显示文件名：分隔符按字符码判断（92=\ 47=/），省得在字符串与正则里跟反斜杠较劲 */
function fileNameOf(path: string): string {
  let cut = -1
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const code = path.charCodeAt(i)
    if (code === 92 || code === 47) {
      cut = i
      break
    }
  }
  return cut >= 0 ? path.slice(cut + 1) : path
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 音色库：克隆音色的管理、试听与引用关系。
 *  克隆在服务商侧异步训练，本页接收广播更新状态。克隆音色绑定「它克隆时那条接入 + 目标模型」
 *  （不可跨模型），合成时按这个绑定路由。音色的入口统一在人设卡/节目，这里没有「默认音色」。 */
export function VoicesPage() {
  const voices = useAppStore((s) => s.voices)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const catalog = flattenModelCatalog(ttsProviders)
  /** 按接入筛：接入的标签里就带服务商，所以不再单列服务商标签页 */
  const [connectionFilter, setConnectionFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  /** 新建弹窗的挂载代数：每次打开 +1（key 一换整块重挂载，草稿回到初始值）；关闭时不动它，
   *  否则重挂载会打断弹窗自己的关闭过渡 */
  const [addSession, setAddSession] = useState(0)
  const [deleting, setDeleting] = useState<VoiceRecord | null>(null)
  const [renaming, setRenaming] = useState<VoiceRecord | null>(null)
  /** 每个音色被谁用（卡片摘要 + 删除确认） */
  const [usages, setUsages] = useState<Record<string, VoiceUsage>>({})
  /** 正在试听的音色 id（播放期间按钮转圈） */
  const [previewing, setPreviewing] = useState('')

  const reload = () => void window.api.voice.list().then(useAppStore.getState().setVoices)

  useEffect(reload, [])
  useDataRefresh(['voices'], () => reload())

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      voices.map(async (voice) => [voice.id, await window.api.voice.usage(voice.id)] as const)
    ).then((entries) => {
      if (!cancelled) setUsages(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [voices])

  const shown = voices.filter(
    (voice) => connectionFilter === 'all' || voice.connectionId === connectionFilter
  )

  const preview = (voice: VoiceRecord) => {
    if (previewing) return
    setPreviewing(voice.id)
    // 合成与出声都在主进程（aux 槽：不打断正在播报的话术）；播放结束才回来
    void window.api.voice
      .preview(voice.id)
      .then((result) => {
        if (!result.ok) toast.error('试听失败', { description: result.error })
      })
      .catch((error: unknown) => {
        toast.error('试听失败', { description: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => setPreviewing(''))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <AssetStaleBanner />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <AudioLines className="size-4 shrink-0 text-primary" />
        <h1 className="shrink-0 text-sm font-medium">音色库</h1>
        <p className="text-[13px] text-muted-foreground">克隆音色管理 · 主播可以调度各家的音色</p>
        <p className="text-[13px] text-muted-foreground">共 {voices.length} 个</p>
        <Button variant="ghost" size="sm" className="h-7 text-xs" title="重新拉取音色库（克隆完成/agent 改动会自动刷新，这里是手动兜底）" onClick={() => reload()}>
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
        {ttsConnections.length > 0 && (
          <Select value={connectionFilter} onValueChange={setConnectionFilter}>
            <SelectTrigger className="ml-2 h-7 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部接入（{voices.length}）</SelectItem>
              {ttsConnections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {TTS_PROVIDER_SHORT[connection.providerId]} · {connection.name}（
                  {voices.filter((voice) => voice.connectionId === connection.id).length}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            刷新
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAddSession((n) => n + 1)
              setAdding(true)
            }}
          >
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
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            这条接入下还没有音色。点「新建音色」，在弹窗里选它作为接入
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((voice) => {
              const connection = ttsConnections.find((item) => item.id === voice.connectionId)
              const owner = TTS_PROVIDER_SHORT[voice.provider]
              const spec = catalog.find(
                (entry) => entry.provider === voice.provider && entry.model.id === voice.model
              )
              const hint = cloneVoiceHint(voice, ttsConnections)
              const usage = usages[voice.id]
              return (
                <div key={voice.id} className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{voice.name}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="outline" className="gap-1">
                        <ProviderIcon providerId={voice.provider} size="sm" />
                        {owner}
                      </Badge>
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
                    <button
                      type="button"
                      className="self-start truncate text-[11px] text-muted-foreground/70 underline-offset-2 hover:underline"
                      title={`复制音色标识：${voice.voiceType}`}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(voice.voiceType)
                          .then(() => toast.success('音色标识已复制'))
                          .catch(() => toast.error('复制失败'))
                      }}
                    >
                      标识 {voice.voiceType.length > 18 ? `${voice.voiceType.slice(0, 18)}…` : voice.voiceType}（点按复制）
                    </button>
                  )}
                  <p className="break-words text-[13px] text-muted-foreground" title={voice.model}>
                    模型 {spec?.model.label ?? (voice.model || '—')}
                    {connection ? ` · 接入「${connection.name}」` : ''}
                  </p>
                  {voice.instruction && (
                    <p className="truncate text-xs text-muted-foreground" title={voice.instruction}>
                      风格：{voice.instruction}
                    </p>
                  )}
                  {voice.status === 'failed' && voice.error && (
                    <p className="text-[13px] text-destructive">{voice.error}</p>
                  )}
                  <p className="text-[13px] text-muted-foreground">
                    {usage ? usageSummary(usage) : '统计引用关系…'}
                  </p>
                  {hint.hint && (
                    <p className={cn('text-[13px]', hint.ok ? 'text-muted-foreground' : 'text-destructive')}>
                      {hint.hint}
                    </p>
                  )}

                  <div className="mt-auto flex flex-wrap justify-end gap-1.5 pt-1">
                    {voice.status === 'ready' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={previewing !== ''}
                        title="用这个音色合成一句试听"
                        onClick={() => preview(voice)}
                      >
                        {previewing === voice.id ? <Loader2 className="animate-spin" /> : <Play />}
                        试听
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="编辑（名称 / 风格指令）"
                      onClick={() => setRenaming(voice)}
                    >
                      <Pencil />
                    </Button>
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

      {/* key 换一个就整块重挂载：表单草稿自然回到初始值，不用在 effect 里按 open 逐个重置状态 */}
      <NewVoiceDialog key={addSession} open={adding} onOpenChange={setAdding} onDone={reload} />

      {/* 同理按音色 id 重挂载：换一个音色就是一份新草稿，同一音色内的重渲染不会冲掉已经输入的内容 */}
      <RenameVoiceDialog
        key={renaming?.id ?? 'closed'}
        voice={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
        onDone={reload}
      />

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除音色</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？样本文件会一并删除，平台侧的复刻音色需要在服务商控制台单独清理。
          </p>
          {deleting && usages[deleting.id] && usageCount(usages[deleting.id]) > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
              <p className="mb-1 text-[13px] text-destructive">这个音色正在被使用，删掉后这些地方会指向不存在的音色：</p>
              {usages[deleting.id].personas.map((item) => (
                <p key={item.id}>主播卡「{item.name}」 · 音色</p>
              ))}
              {usages[deleting.id].programs.map((item) => (
                <p key={item.id}>节目「{item.name}」的卡司里</p>
              ))}
              {usages[deleting.id].draftUnitCount > 0 && (
                <p>
                  话术库 {usages[deleting.id].draftUnitCount} 条
                  {usages[deleting.id].draftUnitSamples[0]
                    ? `（例如：${usages[deleting.id].draftUnitSamples[0].text.slice(0, 20)}…）`
                    : ''}
                </p>
              )}
            </div>
          )}
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

/** 「被 2 张主播卡 · 1 个节目 · 12 条话术使用」 */
function usageSummary(usage: VoiceUsage): string {
  const parts: string[] = []
  if (usage.personas.length) parts.push(`${usage.personas.length} 张主播卡`)
  if (usage.programs.length) parts.push(`${usage.programs.length} 个节目`)
  if (usage.draftUnitCount) parts.push(`${usage.draftUnitCount} 条话术`)
  return parts.length > 0 ? `被 ${parts.join(' · ')}使用` : '还没被主播卡 / 节目 / 话术使用'
}

function usageCount(usage: VoiceUsage): number {
  return usage.personas.length + usage.programs.length + usage.draftUnitCount
}

/** 编辑音色（显示名 + 风格指令；复刻标识与绑定不动） */
function RenameVoiceDialog({
  voice,
  onOpenChange,
  onDone
}: {
  voice: VoiceRecord | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  // 名称与风格指令是用户没提交的草稿：初值只取一次，之后交给本地 state；换音色由父层 key={voice.id} 重挂载重置，
  // 所以不要用 effect 把 prop 抄进来——那样连无关的重渲染都会把正在输入的内容冲掉
  const [name, setName] = useState(voice?.name ?? '')
  const [instruction, setInstruction] = useState(voice?.instruction ?? '')
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (!voice || busy || !name.trim()) return
    setBusy(true)
    void window.api.voice
      .update(voice.id, { name, instruction: instruction.trim() })
      .then((r) => {
        if (r.ok) {
          toast.success('已保存')
          onOpenChange(false)
          onDone()
        } else toast.error('保存失败', { description: r.error })
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={voice !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>编辑音色</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <Label className="mb-1">音色名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：店主本人 / 小助理"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
              }}
            />
          </div>
          <div>
            <Label className="mb-1">风格指令（可选，≤100 字）</Label>
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={100}
              placeholder="年轻活泼的女性，语速较快，带货场景"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              这个音色的默认演法。阿里云百炼音色生效；火山 seed-tts-2.0 走语音指令，复刻音色不支持。节目可以另配风格覆盖它
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !name.trim()} onClick={submit}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建音色：选接入 → 选目标模型（音色与模型绑死，不可跨模型）→ 上传样本 → 勾选授权 → 提交复刻 */
function NewVoiceDialog({
  open,
  onOpenChange,
  onDone
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const catalog = flattenModelCatalog(ttsProviders)
  const readyConnections = ttsConnections.filter((item) => item.ready)
  // 这十来个字段都是「本次填表」的草稿：初值就是全新表单的样子，打开时靠父层换 key 重挂载重置，
  // 所以不用在 effect 里按 open 一个个抄回去（抄的过程还会顺带清掉用户已经填好的内容）
  const [connectionId, setConnectionId] = useState(readyConnections[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [samplePath, setSamplePath] = useState('')
  const [sampleUrl, setSampleUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadInfo, setUploadInfo] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const connection = readyConnections.find((item) => item.id === connectionId) ?? readyConnections[0]
  const provider = connection?.providerId ?? 'volcano'
  /** 这条接入启用、且官方允许作为复刻目标的模型（音色创建时就绑死它，不能跨模型） */
  const cloneTargets = (connection?.models ?? [])
    .map((item) =>
      catalog.find((entry) => entry.provider === connection?.providerId && entry.model.id === item.id)
    )
    .filter((entry): entry is CatalogModel => Boolean(entry?.model.cloneTarget))

  useEffect(() => {
    if (!cloneTargets.some((entry) => entry.model.id === model)) {
      setModel(cloneTargets[0]?.model.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, open])

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

  /** 关弹窗都走这里（取消 / 提交成功 / ESC / 点遮罩）：录音得跟着「关闭」这个动作一起收掉。
   *  原来挂在 effect 里看 open 变化去停，等于用 prop 变化驱动 setState，还慢一帧 */
  const close = () => {
    stopRecording()
    onOpenChange(false)
  }

  /** 把本地样本传到临时文件站换公网直链（百炼复刻要用）；是否上传由用户点按钮决定 */
  const uploadSample = async () => {
    if (!samplePath || uploading) return
    setUploading(true)
    setUploadInfo('')
    try {
      const result = await window.api.voice.uploadTemp(samplePath)
      if (result.ok && result.url) {
        setSampleUrl(result.url)
        setUploadInfo(
          `已上传到${result.provider ?? '临时文件站'}（${result.expiresIn ?? '临时'}后失效${result.converted ? '，已自动转成 mp3' : ''}）`
        )
      } else {
        toast.error('上传失败', { description: result.error })
      }
    } finally {
      setUploading(false)
    }
  }

  const submit = () => {
    if (busy) return
    if (!connection) {
      toast.warning('还没有可用的接入：到设置 → 语音合成添加一条')
      return
    }
    if (!model) {
      toast.warning('这条接入里没有可复刻的模型', { description: '复刻目标模型得先在接入里勾上' })
      return
    }
    if (!name.trim()) {
      toast.warning('先给音色起个名字')
      return
    }
    if (provider === 'volcano' && !samplePath) {
      toast.warning('请先上传或录制样本音频')
      return
    }
    if (provider === 'bailian' && !sampleUrl.trim()) {
      toast.warning('请粘贴公网可访问的样本音频地址')
      return
    }
    setBusy(true)
    void window.api.voice
      .clone({
        name,
        samplePath: samplePath || undefined,
        sampleUrl: sampleUrl.trim() || undefined,
        authorized,
        connectionId: connection.id,
        model,
        instruction: instruction.trim() || undefined
      })
      .then((result) => {
        if (result.ok) {
          toast.success('克隆任务已提交', { description: '训练完成后音色卡片会变为「就绪」' })
          close()
          onDone()
        } else {
          toast.error('提交失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建音色（声音克隆）</DialogTitle>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <Label className="mb-1">接入（复刻在它那边做，用它的凭据）</Label>
            <Select value={connection?.id ?? ''} onValueChange={setConnectionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一条已配齐的接入" />
              </SelectTrigger>
              <SelectContent>
                {readyConnections.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="flex items-center gap-2">
                      <ProviderIcon providerId={item.providerId} size="sm" />
                      {TTS_PROVIDER_SHORT[item.providerId]} · {item.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {readyConnections.length === 0 ? (
              <p className="mt-1 text-xs text-destructive">
                还没有配齐的接入：到设置 → 语音合成添加一条（填密钥、勾上复刻模型）
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                克隆出来的音色绑死这条接入 + 下面的目标模型，之后合成也走它们
              </p>
            )}
          </div>

          <div>
            <Label className="mb-1">目标模型（音色不能跨模型用）</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一个可复刻的模型" />
              </SelectTrigger>
              <SelectContent>
                {cloneTargets.map((entry) => (
                  <SelectItem key={entry.model.id} value={entry.model.id}>
                    {entry.model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {connection && cloneTargets.length === 0 && (
              <p className="mt-1 text-xs text-destructive">
                这条接入里没有可复刻的模型：编辑接入，勾上「复刻模型」（火山 seed-icl-1.0/2.0、百炼 cosyvoice 各版 / qwen-audio）
              </p>
            )}
          </div>

          <div>
            <Label className="mb-1">音色名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：店主本人 / 小助理" />
          </div>

          <div>
            <Label className="mb-1">风格指令（可选，≤100 字）</Label>
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={100}
              placeholder="年轻活泼的女性，语速较快，带货场景"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              这个音色的默认演法，克隆完成后也能改。阿里云百炼音色生效；火山 seed-tts-2.0 走语音指令，复刻音色不支持
            </p>
          </div>

          <div>
            <Label className="mb-1">
              声音样本（
              {provider === 'volcano'
                ? '火山要求 14–30 秒：wav/单声道、低噪声、无背景音乐，吐字清晰'
                : '百炼要求 10–20 秒干净人声最佳：≤60 秒、采样率 ≥16kHz、无背景音乐'}
              ）
            </Label>
            <div className="flex min-w-0 items-center gap-2">
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
                {samplePath ? fileNameOf(samplePath) : '尚未选择样本'}
              </span>
            </div>
            {samplePath && !/\.(mp3|wav|m4a)$/i.test(samplePath) && (
              <p className="mt-1 text-xs text-amber-600">
                复刻接口收 WAV / MP3 / M4A：提交或上传时会自动把这个样本转成 mp3
              </p>
            )}
          </div>

          {provider === 'bailian' && (
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label>样本的公网地址（百炼复刻只认 URL）</Label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!samplePath || uploading}
                  onClick={() => void uploadSample()}
                >
                  {uploading ? '上传中…' : '上传样本并取地址'}
                </Button>
              </div>
              <Input
                value={sampleUrl}
                onChange={(e) => setSampleUrl(e.target.value)}
                placeholder="https://…（点上面按钮自动填，也可自己粘）"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                百炼只接受公网可访问的音频地址。点「上传样本并取地址」会把上面选的样本临时传到第三方文件站换回直链
                ——样本是隐私内容，不想上传就自己粘一个地址。
              </p>
              {uploadInfo && <p className="mt-1 text-xs text-emerald-600">{uploadInfo}</p>}
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox
              checked={authorized}
              onCheckedChange={(v) => setAuthorized(v === true)}
              className="mt-0.5"
              aria-label="授权确认"
            />
            <span>
              <span className="text-[13px]">我确认已获得录音人的明确授权</span>
              <span className="ml-1 text-muted-foreground">（克隆音色需本人授权，提交时间将留痕）</span>
            </span>
          </label>

          <p className="min-w-0 break-words text-xs text-muted-foreground">
            {provider === 'volcano'
              ? '提交前会先校验样本时长（14–30 秒），不合规直接拦下。提交后由火山引擎异步训练（通常秒级完成），本页会自动更新状态。账号需已开通「声音复刻」；样本支持 wav / mp3 / ogg / m4a / aac / pcm，录音产物（webm）会自动转码成单声道 mp3。火山复刻走后付费音色：首次正式合成即转正收费，试听 7 天未正式调用会被删除。'
              : '提交前会先校验样本时长（10–60 秒，10–20 最佳），不合规直接拦下。百炼复刻创建即完成（无异步训练），音色长期有效；创建时绑定的目标模型之后不能改。'}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            disabled={
              busy ||
              !connection ||
              !model ||
              !name.trim() ||
              !authorized ||
              (provider === 'volcano' ? !samplePath : !sampleUrl.trim())
            }
            onClick={submit}
          >
            {busy ? '提交中…' : '提交克隆'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
