import { TTS_PROVIDER_SHORT, type TtsProvider } from './types'

/**
 * 音色与服务商的绑定关系。
 *
 * 核心约束（没变）：**在 A 平台克隆的音色，B 平台合成不了**——火山复刻出的 speaker_id
 * 拿去百炼必然失败。变的是凭据的组织方式：凭据按服务商存在接入列表（tts_connections）里，
 * 所以音色自带归属这件事正好用来路由——合成时按音色的归属找那条接入，
 * 缺的就不是"当前没切过去"，而是"这条接入还没配置"。
 */

/** 音色是不是归这家服务商（克隆音色自带 provider，据此判定归属） */
export function voiceMatchesProvider(voice: { provider: string }, ttsProviderId: string): boolean {
  return voice.provider === ttsProviderId
}

/** 按 voiceType 在音色库里找克隆音色；找不到 = 系统音色（服务商自带，无法判断归属） */
export function findCloneVoice<T extends { voiceType: string }>(
  voices: T[],
  voiceType: string
): T | undefined {
  const id = voiceType.trim()
  if (!id) return undefined
  return voices.find((voice) => voice.voiceType === id)
}

/** 某家服务商还没配置接入的提示（音色卡片小字 / 选择器就地提示共用） */
export function missingConnectionHint(provider: TtsProvider): string {
  return `还没配置${TTS_PROVIDER_SHORT[provider]}接入：到设置 → 语音合成加上`
}

/** 音色所属那家没配置接入时的中文原因（试听/合成的错误文案，带音色名） */
export function voiceConnectionError(voice: { name: string; provider: string }): string {
  const owner = TTS_PROVIDER_SHORT[voice.provider as TtsProvider] ?? voice.provider
  return `音色「${voice.name}」属于${owner}，但还没配置这条接入：到设置 → 语音合成加上`
}

/** 默认服务商还没配置接入时的中文原因（系统音色没有归属，路由到默认那家） */
export function defaultProviderConnectionError(provider: TtsProvider): string {
  return `默认服务商${TTS_PROVIDER_SHORT[provider]}还没配置接入：到设置 → 语音合成加上`
}
