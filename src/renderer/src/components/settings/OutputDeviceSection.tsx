import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Cable, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '../../stores/useAppStore'
import { isVirtualCable, listOutputDevices, syncOutputDevice, type OutputDevice } from '../../audio/outputDevice'

/**
 * 本机输出设备（伴侣模式）：把声音送到虚拟声卡，推流软件再把 CABLE Output 当麦克风采，
 * 系统声音/提示音就混不进来。虚拟声卡是系统驱动，这里只做检测、切换和一键安装。
 */
export function OutputDeviceSection() {
  const stream = useAppStore((s) => s.config.stream)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [installing, setInstalling] = useState(false)

  const refresh = useCallback(async () => {
    setDevices(await listOutputDevices())
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    navigator.mediaDevices?.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange)
  }, [refresh])

  const virtual = devices.find((device) => device.deviceId !== 'default' && isVirtualCable(device.label))
  // 存着的设备可能已经拔掉/被卸载（比如换了个声卡）：下拉回落到「系统默认」，别显示空白
  const selectedId =
    stream.outputDeviceId && devices.some((device) => device.deviceId === stream.outputDeviceId)
      ? stream.outputDeviceId
      : 'default'
  const current = devices.find((device) => device.deviceId === selectedId)

  const apply = async (patch: Partial<typeof stream>): Promise<void> => {
    await saveConfig({ stream: patch })
    const applied = await syncOutputDevice()
    if (applied) {
      toast.success(
        applied.mirrorLabel ? `输出：${applied.label}；同时送 ${applied.mirrorLabel}` : `输出已切到：${applied.label}`
      )
    }
  }

  const install = async (opts: { pick?: boolean } = {}): Promise<void> => {
    setInstalling(true)
    try {
      const result = await window.api.stream.installVirtualCable(opts)
      if (result.canceled) return
      if (!result.ok) {
        toast.error('虚拟声卡没装上', { description: result.error })
        return
      }
      await refresh()
      // 装完重新枚举一次：找到就顺手切过去
      const devicesNow = await listOutputDevices()
      const found = devicesNow.find((device) => device.deviceId !== 'default' && isVirtualCable(device.label))
      if (found) {
        await saveConfig({ stream: { outputDeviceId: found.deviceId, autoVirtualCable: true } })
        const applied = await syncOutputDevice()
        toast.success('虚拟声卡已安装并启用', {
          description: `输出：${applied?.label ?? found.label}；推流软件里把麦克风选 CABLE Output`
        })
      } else {
        toast.success('安装完成', { description: 'VB-CABLE 装完通常要重启一次电脑，CABLE Input 才会出现' })
      }
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center gap-2">
        <Cable className="size-4 text-muted-foreground" />
        <p className="text-[13px] font-medium">输出设备（伴侣模式）</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        输出切到虚拟声卡，推流软件麦克风选 <code>CABLE Output</code>：只有 AI 的声音，系统声音进不来。
      </p>

      <div className="mt-3 grid gap-3">
        <div>
          <Label className="mb-1">输出到</Label>
          <Select
            value={selectedId}
            onValueChange={(value) => void apply({ outputDeviceId: value === 'default' ? '' : value })}
          >
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder="系统默认" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">系统默认</SelectItem>
              {devices
                .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
                .map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            当前：{current?.label ?? '系统默认'}
          </p>
        </div>

        <label className="flex items-start gap-2">
          <Switch
            checked={stream.autoVirtualCable}
            disabled={stream.dualOutput}
            onCheckedChange={(checked) => void apply({ autoVirtualCable: checked })}
          />
          <span className="text-[12.5px]">
            有虚拟声卡时自动切过去
            {stream.dualOutput && <span className="block text-[11px] text-muted-foreground">双路输出时不需要自动切</span>}
          </span>
        </label>

        <label className="flex items-start gap-2">
          <Switch
            checked={stream.dualOutput}
            disabled={!virtual}
            onCheckedChange={(checked) =>
              void apply({
                dualOutput: checked,
                ...(checked
                  ? { autoVirtualCable: false, ...(selectedId === virtual?.deviceId ? { outputDeviceId: '' } : {}) }
                  : {})
              })
            }
          />
          <span className="text-[12.5px]">
            同时输出到虚拟声卡
            <span className="block text-[11px] text-muted-foreground">
              主输出照常出声，同一路声音再送 {virtual?.label ?? '虚拟声卡'}；推流软件采集 CABLE Output
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {virtual ? (
            <span className="flex items-center gap-1.5 text-[12px] text-emerald-600">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              已检测到虚拟声卡：{virtual.label}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[12px] text-amber-600">
              <AlertTriangle className="size-3.5" />
              未检测到虚拟声卡
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-8" onClick={() => void refresh().then(() => toast.message('已重新检测输出设备'))}>
              <RefreshCw />
              重新检测
            </Button>
            {!virtual && (
              <>
                <Button size="sm" variant="ghost" className="h-8" disabled={installing} onClick={() => void install({ pick: true })}>
                  用本地安装包…
                </Button>
                <Button size="sm" variant="outline" className="h-8" disabled={installing} onClick={() => void install()}>
                  {installing ? '安装中…' : '安装虚拟声卡（需要管理员）'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
