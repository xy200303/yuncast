import { TTS_PROVIDER_SHORT } from '../../../shared/types'
import { findCloneVoice, voiceMatchesProvider } from '../../../shared/voiceProvider'
import { useAppStore } from '../stores/useAppStore'

/**
 * 音色归属提示：手打或已选的音色命中别的服务商克隆的那个时点明合成不了。
 * 系统音色（库里没记录）无法判断归属，不提示。
 */
export function VoiceProviderHint({ voiceId }: { voiceId: string }) {
  const voices = useAppStore((s) => s.voices)
  const provider = useAppStore((s) => s.config.tts.provider)

  const clone = findCloneVoice(voices, voiceId)
  if (!clone || voiceMatchesProvider(clone, provider)) return null

  return (
    <p className="mt-1 text-xs text-destructive">
      「{clone.name}」是{TTS_PROVIDER_SHORT[clone.provider]}克隆的，当前用
      {TTS_PROVIDER_SHORT[provider]}合成不了（到设置 → 语音合成切回去，或换个音色）
    </p>
  )
}
