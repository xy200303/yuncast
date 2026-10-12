/**
 * 音色与服务商的绑定关系。
 *
 * 核心约束（没变）：**在 A 平台克隆的音色，B 平台合成不了**——火山复刻出的 speaker_id
 * 拿去百炼必然失败。变的是绑定的粒度：现在克隆音色绑「克隆时那条接入 + 目标模型」
 * （voices 表的 connection_id / model），凭据在 tts_connections 里按接入存，
 * 所以合成时按这个绑定就能直接路由到对的接入与模型。
 */

/** 按 voiceType 在音色库里找克隆音色；找不到 = 系统音色（服务商自带，归属由模型目录反查） */
export function findCloneVoice<T extends { voiceType: string }>(
  voices: T[],
  voiceType: string
): T | undefined {
  const id = voiceType.trim()
  if (!id) return undefined
  return voices.find((voice) => voice.voiceType === id)
}

/**
 * 手动音色（官方没给系统音色目录的模型，如 qwen-audio-3.x / cosyvoice-v3.5）：
 * 选择器里现选「接入 + 模型 + 音色」，存成复合字符串 `接入id::模型id::音色`。
 * 接入 id 与模型 id 里不会出现 `::`，所以按 `::` 切开不会有歧义。
 * 没有默认接入也没有默认模型：模型由这个前缀显式指定（见 TtsService.routeSystem）。
 */
export const MANUAL_VOICE_SEP = '::'

export interface ManualVoiceRef {
  connectionId: string
  modelId: string
  voice: string
}

/** 组装手动音色的复合字符串；三段缺一不可 */
export function formatManualVoice(ref: ManualVoiceRef): string {
  return [ref.connectionId.trim(), ref.modelId.trim(), ref.voice.trim()].join(MANUAL_VOICE_SEP)
}

/** 解析手动音色；不是复合写法（段数不足或段位为空）返回 null */
export function parseManualVoice(value: string): ManualVoiceRef | null {
  const parts = value.trim().split(MANUAL_VOICE_SEP)
  if (parts.length < 3) return null
  const [connectionId, modelId, ...rest] = parts
  const voice = rest.join(MANUAL_VOICE_SEP).trim()
  if (!connectionId.trim() || !modelId.trim() || !voice) return null
  return { connectionId: connectionId.trim(), modelId: modelId.trim(), voice }
}
