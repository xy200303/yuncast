import { useEffect, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { listOutputDevices, syncOutputDevices, type OutputDevice } from '../../audio/outputDevice'
import { useAppStore } from '../../stores/useAppStore'

/**
 * 声音输出（像直播软件那样从喇叭进）：列出所有输出设备，勾选要用的、各自调音量。
 * 勾几个就同时送几个：自己听扬声器、推流软件采虚拟声卡可以同时要。
 */
export function AudioOutputDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const stream = useAppStore((state) => state.config.stream)
  const saveConfig = useAppStore((state) => state.saveConfig)
  const masterVolume = useAppStore((state) => state.masterVolume)
  const setMasterVolume = useAppStore((state) => state.setMasterVolume)
  const [devices, setDevices] = useState<OutputDevice[]>([])

  useEffect(() => {
    if (!open) return
    void listOutputDevices().then(setDevices)
  }, [open])

  const entries = stream.outputDevices.length ? stream.outputDevices : [{ deviceId: 'default', volume: 1 }]
  /** 拖动中的本地音量（0~100）：松手才落库，避免拖一次写几十回配置 */
  const [dragging, setDragging] = useState<Record<string, number>>({})
  const enabled = new Map(entries.map((entry) => [entry.deviceId, entry.volume]))
  const volumeOf = (deviceId: string): number =>
    dragging[deviceId] ?? Math.round((enabled.get(deviceId) ?? 1) * 100)
  const options = [
    { deviceId: 'default', label: '系统默认' },
    ...devices.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
  ]

  const apply = async (next: { deviceId: string; volume: number }[]): Promise<void> => {
    await saveConfig({ stream: { outputDevices: next } })
    await syncOutputDevices()
  }

  const toggle = (deviceId: string): void => {
    const next = entries.filter((entry) => entry.deviceId !== deviceId)
    if (!enabled.has(deviceId)) next.push({ deviceId, volume: 1 })
    // 全取消 = 回到系统默认
    void apply(next.length ? next : [{ deviceId: 'default', volume: 1 }])
  }

  const commitVolume = (deviceId: string, percent: number): void => {
    const value = Math.max(0, Math.min(100, percent)) / 100
    setDragging((prev) => {
      const next = { ...prev }
      delete next[deviceId]
      return next
    })
    void apply(entries.map((entry) => (entry.deviceId === deviceId ? { ...entry, volume: value } : entry)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Volume2 className="size-4" />
            声音输出
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px]">总音量（所有设备）</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{masterVolume}</span>
            </div>
            <div className="mt-2">
              <Slider
                value={[masterVolume]}
                min={0}
                max={100}
                step={1}
                aria-label="总音量"
                onValueChange={([value]) => setMasterVolume(value)}
              />
            </div>
          </div>
          {options.map((device) => {
            const volume = enabled.get(device.deviceId)
            const on = volume !== undefined
            return (
              <div key={device.deviceId} className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-[12.5px]">{device.label}</span>
                  <Switch checked={on} onCheckedChange={() => toggle(device.deviceId)} />
                </div>
                {on && (
                  <div className="mt-2 flex items-center gap-3">
                    <Slider
                      className="flex-1"
                      value={[volumeOf(device.deviceId)]}
                      min={0}
                      max={100}
                      step={1}
                      aria-label={`${device.label} 音量`}
                      onValueChange={([value]) =>
                        setDragging((prev) => ({ ...prev, [device.deviceId]: value }))
                      }
                      onValueCommit={([value]) => commitVolume(device.deviceId, value)}
                    />
                    <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
                      {volumeOf(device.deviceId)}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
