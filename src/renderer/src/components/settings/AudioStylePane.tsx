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
      <div>
        <h2 className="text-sm font-medium">音频理解（声音风格解析）</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          听一段人声样本，解析出「音色 / 语速 / 语气 / 句尾习惯 / 距离感」，产出 ≤100
          字的风格指令。用在两处：音色库新建音色时起草 instruction；agent 的 voice_analyze_style
          工具（写完可用 voice_update 落库）。
        </p>
      </div>

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
        <p className="mt-1 text-xs text-muted-foreground">
          样本会先上传到临时文件站换公网直链（百炼音频理解只收 URL），链接最长 72 小时自动失效
        </p>
      </div>

      <div>
        <Label className="mb-1">模型</Label>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="qwen3.8-omni-flash"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          推荐 Qwen 全模态（Omni）系：qwen3.8-omni-flash（便宜）/ qwen3.5-omni-flash /
          qwen3-omni-flash。老的 qwen-audio-turbo 在新账号上常没有额度（403 AllocationQuota）
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
