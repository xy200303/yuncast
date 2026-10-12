import { TTS_PROVIDER_SHORT, type TtsProvider } from './types'

/**
 * 音色与服务商的绑定关系。
 *
 * 核心约束：**在 A 平台克隆的音色，B 平台合成不了**——火山复刻出的 speaker_id 拿去百炼必然失败，
 * 反之亦然。因此凡是能把音色和当前 TTS 服务商凑到一起的地方（选择器、预检、合成入口）
 * 都要按这里的口径判断，别等 API 报一个看不懂的错。
 */

/** 克隆音色只能用它所属的服务商合成；系统音色（库里没记录）无法判断，按可用处理 */
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

/** 跨平台音色的中文错误：说清为什么合成不了、去哪儿改 */
export function cloneVoiceMismatchError(
  voice: { name: string; provider: string },
  ttsProviderId: string
): string {
  const owner = TTS_PROVIDER_SHORT[voice.provider as TtsProvider] ?? voice.provider
  const current = TTS_PROVIDER_SHORT[ttsProviderId as TtsProvider] ?? ttsProviderId
  return `音色「${voice.name}」是${owner}克隆的，当前语音合成用的是${current}，合成不了（到设置 → 语音合成切回${owner}，或换一个音色）`
}
