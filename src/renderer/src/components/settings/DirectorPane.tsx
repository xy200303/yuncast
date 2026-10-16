import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppStore } from '../../stores/useAppStore'

/**
 * 导演：全局唯一的大脑（名字 + 接入 + 模型）。
 * 从「语言模型」里独立成一栏——那栏是接入库（家底），这栏是"谁来指挥"（选人），两件事分开看更清楚。
 */
export function DirectorSection() {
  const connections = useAppStore((s) => s.connections)
  const openSettings = useAppStore((s) => s.openSettings)
  const [name, setName] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!('api' in window)) return
    void window.api.director.get().then((director) => {
      setName(director.name)
      setConnectionId(director.modelConnectionId ?? '')
      setModel(director.model)
      setLoaded(true)
    })
  }, [])

  const connection = connections.find((item) => item.id === connectionId)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.director.save({
        name: name.trim() || '小云',
        modelConnectionId: connectionId || null,
        model: connectionId ? model : ''
      })
      if (!result.ok) {
        toast.error('导演大脑保存失败', { description: result.error })
        return
      }
      // 刷进全局 store（状态栏 LLM 徽章 / 预检都看 config.director）
      await useAppStore.getState().loadConfig()
      toast.success('导演大脑已保存', { description: '会话在跑时改动要重启会话/下次开播才生效' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="rounded-xl border bg-card px-5 py-4">
        <p className="text-base font-semibold">导演大脑</p>
        <p className="mt-1 text-sm text-muted-foreground">
          全局唯一的大脑：导演思考、派活、写稿全靠它；主播团里的卡只是人设与嗓音
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label className="mb-1.5">导演名字</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="小云" />
          </div>
          <div>
            <Label className="mb-1.5">接入</Label>
            <Select
              value={connectionId || 'none'}
              onValueChange={(v) => {
                setConnectionId(v === 'none' ? '' : v)
                setModel('')
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一条接入" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">（未选）</SelectItem>
                {connections.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                    {item.ready ? '' : '（未配齐）'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5">模型</Label>
            {/* 值必须是字符串：以前是 `model || undefined`，空模型时 Select 处于非受控、
                选中后又变受控，Radix 会警告且这条选中态可能丢；「（未选）」与旁边的接入一致 */}
            <Select
              value={model || 'none'}
              onValueChange={(v) => setModel(v === 'none' ? '' : v)}
              disabled={!connection}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={connection ? '选一个模型' : '先选接入'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">（未选）</SelectItem>
                {(connection?.models ?? []).map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" disabled={busy || !loaded} onClick={() => void save()}>
            {busy ? '保存中…' : '保存导演大脑'}
          </Button>
          {loaded && (!connectionId || !model) && (
            <p className="text-xs text-amber-600">还没配好：导演没脑上不了工（启动会话/开播会被拦）</p>
          )}
          {connections.length === 0 && (
            <Button variant="outline" size="sm" onClick={() => openSettings('llm')}>
              去「语言模型」建接入
            </Button>
          )}
        </div>
      </div>

      <p className="px-1 text-xs text-muted-foreground">
        接入与模型清单在左边「语言模型」那一栏维护（一条接入 = 一家服务商 + 一份凭据 + 一组模型）；这栏只决定"用哪一条、用哪个模型"。
      </p>
    </div>
  )
}
