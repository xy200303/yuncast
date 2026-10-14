import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppStore } from '../../stores/useAppStore'
import { type StreamConfig, type StreamMode } from '../../../../shared/types'
import { DocLinks } from './shared'

/** 推流表单：伴侣模式（推荐）或 FFmpeg 直推 RTMP */
export function StreamSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const stream = useAppStore((s) => s.stream)
  const [form, setForm] = useState<StreamConfig>({ ...config.stream })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.stream)
  const patch = (part: Partial<StreamConfig>) => setForm((prev) => ({ ...prev, ...part }))

  const save = () => {
    setSaving(true)
    saveConfig({ stream: form })
      .then(() => toast.success('推流配置已保存'))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  const toggleStream = () => {
    void (stream.state === 'live' ? window.api.stream.stop() : window.api.stream.start()).then((result) => {
      if (result && 'ok' in result && !result.ok) {
        toast.error('开播失败', { description: result.error })
      }
    })
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">推流</p>
          <p className="text-xs text-muted-foreground">伴侣模式只出声（推荐）；直推模式 FFmpeg 静态帧 + 混音推 RTMP</p>
        </div>
        <div className="flex items-center gap-2">
          {stream.state === 'live' && (
            <Badge variant="secondary">推流中 · {stream.bitrateKbps} kbps</Badge>
          )}
          <Button variant={stream.state === 'live' ? 'secondary' : 'default'} size="sm" onClick={toggleStream}>
            {stream.state === 'live' ? '停止推流' : '开始推流'}
          </Button>
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">模式</Label>
          <ToggleGroup
            type="single"
            value={form.mode}
            onValueChange={(v) => v && patch({ mode: v as StreamMode })}
            className="rounded-lg bg-muted p-0.5"
          >
            <ToggleGroupItem value="companion" className="h-7 px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
              伴侣模式（只出声）
            </ToggleGroupItem>
            <ToggleGroupItem value="direct" className="h-7 px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
              直推 RTMP
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {form.mode === 'direct' && (
          <>
            <Field label="服务器地址" value={form.serverUrl} onChange={(v) => patch({ serverUrl: v })} placeholder="rtmp://…" />
            <Field label="推流密钥" value={form.streamKey} onChange={(v) => patch({ streamKey: v })} type="password" />
          </>
        )}
      </div>
      <div className="mt-3">
        <DocLinks
          items={[
            { label: '下载抖音直播伴侣', url: 'https://streamingtool.douyin.com/' },
            { label: '抖音开播页（复制推流地址）', url: 'https://creator.douyin.com/' }
          ]}
        />
      </div>
      {form.mode === 'direct' && (!form.serverUrl || !form.streamKey) && (
        <p className="mt-3 text-xs text-muted-foreground">直推模式需要服务器地址和推流密钥（抖音开播页可复制）</p>
      )}
    </div>
  )
}

function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div>
      <Label className="mb-1">{props.label}</Label>
      <Input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}
