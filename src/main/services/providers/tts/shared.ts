import type { FieldSpec, TtsProviderManifest } from '../registry'

/**
 * 两家 TTS 服务商共用的字段声明。
 * 「服务商」本身由设置页的下拉（listTtsProviders）承担，字段清单里保留它是为了让
 * configFields 完整覆盖 TtsConfig。
 */

export const TTS_PROVIDER_FIELD: FieldSpec = {
  key: 'provider',
  label: '服务商',
  type: 'select',
  default: 'volcano',
  options: [
    { value: 'volcano', label: '火山引擎（豆包语音）' },
    { value: 'bailian', label: '阿里云百炼（Qwen-TTS）' }
  ]
}

/** 默认音色：字段的说法来自该服务商的 voiceHint，两处不重复维护；两家都必填（没音色没法合成） */
export function voiceField(hint: TtsProviderManifest['voiceHint']): FieldSpec {
  return {
    key: 'voiceId',
    label: hint.label,
    type: 'text',
    placeholder: hint.placeholder,
    help: hint.help,
    required: true,
    wide: true
  }
}
