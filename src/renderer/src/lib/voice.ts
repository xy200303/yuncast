import { TTS_PROVIDERS, TTS_PROVIDER_SHORT, type TtsProvider, type VoiceRecord } from '../../../shared/types'

/** 音色候选按归属分组后的形态 */
export interface VoiceGroup {
  provider: TtsProvider
  label: string
  voices: VoiceRecord[]
  /** 属于当前 TTS 服务商：跨平台克隆的音色合成不了，别让人误选 */
  usable: boolean
}

/**
 * 音色库候选按 provider 分组，当前 TTS 服务商那组可用、其余标灰禁用。
 * 系统音色（库里没记录）不属于任何一组，手打即可，这里管不到。
 */
export function groupVoicesByProvider(voices: VoiceRecord[], currentProvider: string): VoiceGroup[] {
  return TTS_PROVIDERS.map((provider) => ({
    provider,
    label: TTS_PROVIDER_SHORT[provider],
    voices: voices.filter((voice) => voice.provider === provider),
    usable: provider === currentProvider
  }))
}
