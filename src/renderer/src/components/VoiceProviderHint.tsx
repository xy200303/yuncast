import { useAppStore } from '../stores/useAppStore'
import { cloneVoiceHint, flattenModelCatalog, systemVoiceUsable } from '../lib/voice'
import { parseManualVoice } from '../../../shared/voiceProvider'

/**
 * 音色可用性提示：就地说明当前这个音色能不能合成。三种写法各看各的归属：
 * 克隆音色看它绑定的那条接入与模型；手动音色看复合串里的接入与模型；系统音色看有没有接入启用了它所属的模型。
 */
export function VoiceProviderHint({ voiceId }: { voiceId: string }) {
  const voices = useAppStore((s) => s.voices)
  const connections = useAppStore((s) => s.ttsConnections)
  const manifests = useAppStore((s) => s.ttsProviders)
  const id = voiceId.trim()
  if (!id) return null

  const clone = voices.find((voice) => voice.voiceType === id)
  if (clone) {
    const hint = cloneVoiceHint(clone, connections)
    if (!hint.hint) return null
    return (
      <p className={hint.ok ? 'mt-1 text-xs text-muted-foreground' : 'mt-1 text-xs text-destructive'}>
        {hint.hint}
      </p>
    )
  }

  const manual = parseManualVoice(id)
  if (manual) {
    const connection = connections.find((item) => item.id === manual.connectionId)
    if (!connection) {
      return (
        <p className="mt-1 text-xs text-destructive">
          手动音色里的接入不存在：到主播团重新选一个带接入与模型的音色
        </p>
      )
    }
    if (!connection.usableModels.includes(manual.modelId)) {
      return (
        <p className="mt-1 text-xs text-destructive">
          接入「{connection.name}」的这个模型现在用不了（没启用，或缺业务空间 ID 这类前置条件）：到设置 →
          语音合成看看
        </p>
      )
    }
    return null
  }

  const check = systemVoiceUsable(flattenModelCatalog(manifests), connections, id)
  if (check.usable) return null
  return <p className="mt-1 text-xs text-destructive">{check.hint}</p>
}
