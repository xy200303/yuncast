import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Cable, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isVirtualCable, listOutputDevices, type OutputDevice } from '../../audio/outputDevice'

/**
 * 虚拟声卡：只负责检测和安装。
 * 声音送到哪些设备、各自多大声，在播放条的喇叭里配（像直播软件那样）。
 */
export function VirtualCableCard() {
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [installing, setInstalling] = useState(false)
  const platform = window.api.platform
  const isWindows = platform === 'win32'

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
      toast.success('虚拟声卡已安装', {
        description: '在播放条的喇叭里勾选它；推流软件麦克风选对应的输出'
      })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center gap-2">
        <Cable className="size-4 text-muted-foreground" />
        <p className="text-[13px] font-medium">虚拟声卡</p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {virtual ? (
          <span className="flex items-center gap-1.5 text-[12px] text-emerald-600">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {virtual.label}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] text-amber-600">
            <AlertTriangle className="size-3.5" />
            未检测到虚拟声卡
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-8" onClick={() => void refresh().then(() => toast.message('已重新检测'))}>
            <RefreshCw />
            重新检测
          </Button>
          {!virtual && isWindows && (
            <>
              <Button size="sm" variant="ghost" className="h-8" disabled={installing} onClick={() => void install({ pick: true })}>
                用本地安装包…
              </Button>
              <Button size="sm" variant="outline" className="h-8" disabled={installing} onClick={() => void install()}>
                {installing ? '安装中…' : '安装 VB-CABLE（需要管理员）'}
              </Button>
            </>
          )}
        </div>
      </div>

      {!virtual && !isWindows && (
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {platform === 'darwin'
            ? 'macOS 用 BlackHole 当虚拟声卡：到 existential.audio/blackhole 安装后，在播放条喇叭里勾选 BlackHole 2ch。'
            : 'Linux 用 PulseAudio 空接收器：pactl load-module module-null-sink sink_name=YunCast，然后在播放条喇叭里勾选 YunCast 的 monitor。'}
        </p>
      )}
    </div>
  )
}
