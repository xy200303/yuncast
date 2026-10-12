import {
  TTS_PROVIDERS,
  TTS_PROVIDER_SHORT,
  ttsProviderHasCredentials,
  type TtsConfig,
  type TtsProvider,
  type VoiceRecord
} from '../../../shared/types'

/** 音色候选按归属分组后的形态 */
export interface VoiceGroup {
  provider: TtsProvider
  label: string
  voices: VoiceRecord[]
  /** 这家服务商在配置里有没有凭据：没有的组照样能选，选中后就地提示缺凭据 */
  hasCredentials: boolean
}

/**
 * 音色库候选按 provider 分组（主播 agent 声音无关，各家的音色都能调度）。
 * 分组只用来归置与标注凭据有无，不做任何禁用；系统音色（库里没记录）不属于任何一组，手打即可。
 */
export function groupVoicesByProvider(voices: VoiceRecord[], tts: TtsConfig): VoiceGroup[] {
  return TTS_PROVIDERS.map((provider) => ({
    provider,
    label: TTS_PROVIDER_SHORT[provider],
    voices: voices.filter((voice) => voice.provider === provider),
    hasCredentials: ttsProviderHasCredentials(tts, provider)
  }))
}
