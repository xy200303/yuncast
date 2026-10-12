import type { FieldSpec, TtsProviderManifest } from '../registry'

/**
 * 两家 TTS 服务商共用的字段声明。
 * 只放**通用偏好**字段：凭据字段各写各的（进 tts_connections 接入），偏好字段存在 config.tts 上。
 */

/** 默认音色：字段的说法来自该服务商的 voiceHint，两处不重复维护（没音色没法合成，两家都必填） */
export function voiceField(hint: TtsProviderManifest['voiceHint']): FieldSpec {
  return {
    key: 'voiceId',
    label: hint.label,
    type: 'text',
    placeholder: hint.placeholder,
    help: hint.help,
    required: true,
    wide: true,
    preference: true
  }
}
