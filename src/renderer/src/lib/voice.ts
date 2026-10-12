import {
  TTS_PROVIDERS,
  TTS_PROVIDER_SHORT,
  ttsProviderConfigured,
  type TtsConnectionSafe,
  type TtsProvider,
  type VoiceRecord
} from '../../../shared/types'

/** 音色候选按归属分组后的形态 */
export interface VoiceGroup {
  provider: TtsProvider
  label: string
  voices: VoiceRecord[]
  /** 这家服务商有没有配好接入：没配的组照样能选，选中后就地提示去加这条接入 */
  configured: boolean
}

/**
 * 音色库候选按 provider 分组（一个主播 agent 能调度各家的音色）。
 * 分组只用来归置与标注接入有无，不做任何禁用；系统音色（库里没记录）不属于任何一组，手打即可。
 */
export function groupVoicesByProvider(
  voices: VoiceRecord[],
  connections: TtsConnectionSafe[]
): VoiceGroup[] {
  return TTS_PROVIDERS.map((provider) => ({
    provider,
    label: TTS_PROVIDER_SHORT[provider],
    voices: voices.filter((voice) => voice.provider === provider),
    configured: ttsProviderConfigured(connections, provider)
  }))
}
