import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { useAppStore } from '../../stores/useAppStore'

/**
 * 设置 → 音频理解：声音风格解析（voice_analyze_style / 音色库解析）用哪条百炼接入、哪个模型。
 * 只复用百炼语音合成接入的 API Key（同一把 DashScope 密钥），不单独存一份密钥。
 */
export function AudioStylePane() {
  const config = useAppStore((s) => s.config)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const bailian = ttsConnections.filter((c) => c.providerId === 'bailian')
  const [connectionId, setConnectionId] = useState(config.audioStyle.connectionId)
  const [model, setModel] = useState(config.audioStyle.model)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await saveConfig({ audioStyle: { connectionId, model: model.trim() || 'qwen3.8-omni-flash' } })
      toast.success('音频理解配置已保存')
    } catch (error) {
      toast.error('保存失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-5">
      <p className="text-xs text-muted-foreground">听一段人声样本，解析出音色、语速、语气等风格特征。</p>

      <div>
        <Label className="mb-1">用哪条接入的密钥</Label>
        <Select
          value={connectionId || '__auto'}
          onValueChange={(value) => setConnectionId(value === '__auto' ? '' : value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto">自动（最早一条有密钥的百炼接入）</SelectItem>
            {bailian.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
                {item.hasSecret ? '' : '（没配密钥）'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {bailian.length === 0 && (
          <p className="mt-1 text-xs text-destructive">
            还没有阿里云百炼接入：到 设置 → 语音合成 添加一条（音频理解复用它的 API Key）
          </p>
        )}
      </div>

      <div>
        <Label className="mb-1">模型</Label>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="qwen3.8-omni-flash"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
