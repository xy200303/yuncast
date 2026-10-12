import { ttsProviderConfigured } from '../../../shared/types'
import { findCloneVoice, missingConnectionHint } from '../../../shared/voiceProvider'
import { useAppStore } from '../stores/useAppStore'

/**
 * 音色归属提示：手打或已选的音色命中克隆音色时，就地说明它能不能合成。
 * 现在合成按音色归属路由到那家的接入，所以判断只剩一件事：**这条接入配没配**。
 * 系统音色（库里没记录）归默认服务商，由开播预检负责提示。
 */
export function VoiceProviderHint({ voiceId }: { voiceId: string }) {
  const voices = useAppStore((s) => s.voices)
  const connections = useAppStore((s) => s.ttsConnections)

  const clone = findCloneVoice(voices, voiceId)
  if (!clone) return null
  if (ttsProviderConfigured(connections, clone.provider)) return null

  return <p className="mt-1 text-xs text-destructive">{missingConnectionHint(clone.provider)}</p>
}
