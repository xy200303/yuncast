import { ttsProviderHasCredentials } from '../../../shared/types'
import {
  findCloneVoice,
  missingCredentialHint,
  voiceMatchesProvider,
  voiceUnavailableError
} from '../../../shared/voiceProvider'
import { useAppStore } from '../stores/useAppStore'

/**
 * 音色归属提示：手打或已选的音色命中克隆音色时，就地说明它能不能合成——
 * 缺凭据说缺凭据，两家都配了只是当前没切过去就说清切哪家。
 * 系统音色（库里没记录）无法判断归属，不提示。
 */
export function VoiceProviderHint({ voiceId }: { voiceId: string }) {
  const voices = useAppStore((s) => s.voices)
  const tts = useAppStore((s) => s.config.tts)

  const clone = findCloneVoice(voices, voiceId)
  if (!clone) return null
  const sameProvider = voiceMatchesProvider(clone, tts.provider)
  if (sameProvider && ttsProviderHasCredentials(tts, clone.provider)) return null
  const text = sameProvider
    ? missingCredentialHint(clone.provider, tts)
    : voiceUnavailableError(clone, tts)

  return <p className="mt-1 text-xs text-destructive">{text}</p>
}
