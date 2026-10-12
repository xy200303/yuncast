import { useAppStore } from '../stores/useAppStore'
import { cloneVoiceHint, flattenModelCatalog, systemVoiceUsable } from '../lib/voice'

/**
 * 音色可用性提示：就地说明当前这个音色能不能合成。
 * 克隆音色看它绑定的接入（接入删了会回退到默认接入，那是提示不是错）；
 * 系统音色看有没有哪条接入启用了它所属的模型。
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

  const check = systemVoiceUsable(flattenModelCatalog(manifests), connections, id)
  if (check.usable) return null
  return <p className="mt-1 text-xs text-destructive">{check.hint}</p>
}
