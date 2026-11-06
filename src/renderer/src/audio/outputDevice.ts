import { audioEngine } from './engine'
import { streamPlayer } from './streamPlayer'
import { useAppStore } from '../stores/useAppStore'

/**
 * 本机输出设备（伴侣模式的关键）：把声音送到虚拟声卡，
 * 推流软件再把 CABLE Output 当麦克风采，就只拿到主播的声音，系统声音混不进来。
 *
 * 虚拟声卡是系统驱动，应用只能「检测 + 切输出」；装驱动走设置里的显式安装入口。
 */

export interface OutputDevice {
  deviceId: string
  label: string
}

/** 常见虚拟声卡的设备名（输出端）：VB-CABLE / VoiceMeeter / 中文名兜底 */
const VIRTUAL_CABLE_RE = /cable input|voicemeeter input|vb-audio|virtual cable|虚拟声卡/i
/**
 * VB-CABLE 新版安装包会同时装两个设备：经典立体声 `CABLE Input` 和 16 声道版
 * `CABLE In 16ch`。16ch 是给多声道场景的、还要求两端采样率一致，
 * 推流用不到，混进下拉框只会选错——统一排除。
 */
const MULTICHANNEL_CABLE_RE = /16\s*ch|hi-?fi\s*cable/i

export function isVirtualCable(label: string): boolean {
  return VIRTUAL_CABLE_RE.test(label) && !MULTICHANNEL_CABLE_RE.test(label)
}

export async function listOutputDevices(): Promise<OutputDevice[]> {
  if (!('mediaDevices' in navigator)) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audiooutput')
    .filter((device) => !MULTICHANNEL_CABLE_RE.test(device.label))
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || `输出设备 ${device.deviceId.slice(0, 6)}`
    }))
}

/**
 * 按当前配置把音频输出切到位（启动、保存设置、插拔设备后调）：
 * 选了几个设备就同时送几个——第一个走主音频图（音量/静音/避让都生效），其余镜像过去。
 * 一个都没选 = 系统默认。
 */
export async function syncOutputDevices(): Promise<{ labels: string[] } | null> {
  const { stream } = useAppStore.getState().config
  const devices = await listOutputDevices()
  if (devices.length === 0) return null
  const fallback = devices.find((device) => device.deviceId === 'default') ?? devices[0]
  const configured = stream.outputDevices.length
    ? stream.outputDevices
    : [{ deviceId: 'default', volume: 1 }]
  const selected = configured
    .map((entry) => {
      const device = devices.find((item) => item.deviceId === entry.deviceId)
      return device ? { ...entry, label: device.label } : null
    })
    .filter((entry): entry is { deviceId: string; volume: number; label: string } => entry !== null)
  const targets = selected.length ? selected : [{ deviceId: 'default', volume: 1, label: fallback.label }]

  const primary = targets[0]
  const ok = await audioEngine.setOutputDevice(primary.deviceId === 'default' ? '' : primary.deviceId)
  audioEngine.setDeviceVolume(primary.volume)
  await streamPlayer.setMirrorDevices(
    targets.slice(1).map((entry) => ({ deviceId: entry.deviceId, volume: entry.volume }))
  )
  return ok ? { labels: targets.map((entry) => entry.label) } : null
}
