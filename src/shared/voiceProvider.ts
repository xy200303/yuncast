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
