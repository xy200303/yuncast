import {
  TTS_PROVIDERS,
  TTS_PROVIDER_SHORT,
  ttsProviderHasCredentials,
  type TtsConfig,
  type TtsProvider
} from './types'

/**
 * 音色与服务商的绑定关系。
 *
 * 核心约束：**在 A 平台克隆的音色，B 平台合成不了**——合成请求带的是当前服务商的凭据，
 * 火山复刻出的 speaker_id 拿去百炼必然失败，反之亦然。所以凡是把音色和合成凑到一起的地方
 * （选择器、预检、合成入口）都按这里的口径判断：缺哪家的凭据就直说缺凭据，别等 API 报一个看不懂的错。
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

/** 配置里已有凭据的服务商短名（可排除某一家）；给「当前只配了 X」这种说法用 */
export function configuredProviderLabels(tts: TtsConfig, exclude?: TtsProvider): string[] {
  return TTS_PROVIDERS.filter((id) => id !== exclude && ttsProviderHasCredentials(tts, id)).map(
    (id) => TTS_PROVIDER_SHORT[id]
  )
}

/** 缺凭据的提示（卡片小字 / 选择器就地提示 / 试听错误）：说清要哪家的凭据、去哪儿加 */
export function missingCredentialHint(provider: TtsProvider, tts: TtsConfig): string {
  const others = configuredProviderLabels(tts, provider)
  const tail = others.length > 0 ? `（当前只配了${others.join('、')}）` : '（现在哪家的凭据都还没配）'
  return `需要${TTS_PROVIDER_SHORT[provider]}凭据：到设置 → 语音合成加上${tail}`
}

/**
 * 音色用不了的中文原因（带音色名，试听/合成的错误文案）。
 * 两家凭据都配齐、只是当前没切过去时，说清楚切哪家——跨平台合成不了这件事没变。
 */
export function voiceUnavailableError(
  voice: { name: string; provider: string },
  tts: TtsConfig
): string {
  const owner = TTS_PROVIDER_SHORT[voice.provider as TtsProvider] ?? voice.provider
  const current = TTS_PROVIDER_SHORT[tts.provider]
  if (ttsProviderHasCredentials(tts, voice.provider as TtsProvider)) {
    return `音色「${voice.name}」属于${owner}，当前语音合成用的是${current}，合成不了（到设置 → 语音合成切回${owner}，或换一个音色）`
  }
  return `音色「${voice.name}」属于${owner}，当前没有${owner}的凭据，合成不了（到设置 → 语音合成加上）`
}
