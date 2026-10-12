import { TTS_PROVIDER_SHORT } from '../../../../shared/types'
import type { TtsProviderManifest } from '../registry'
import { TTS_PROVIDER_FIELD, voiceField } from './shared'

/**
 * 火山引擎（豆包语音）语音合成：HTTP 一次性合成 mp3（TtsService.synthesizeVolcano）。
 * 能力依据见 docs/06-TTS克隆接口核对.md：音色复刻已实现（端点/字段待逐条核对），流式协议仍待核对。
 */
const voiceHint = {
  label: '默认音色 voice_type',
  placeholder: '控制台里的音色 id，例如 zh_female_…',
  help: '复刻音色就填音色库里的那个（克隆后可用「音色库 → 设为默认」直接写上）'
}

export const volcanoTtsProvider: TtsProviderManifest = {
  id: 'volcano',
  label: `${TTS_PROVIDER_SHORT.volcano}（豆包语音）`,
  icon: 'volcano',
  note: 'HTTP 一次性合成 mp3，延迟按整段算；支持声音复刻',
  capabilities: {
    streaming: false,
    clone: true,
    instruction: false,
    formats: ['mp3']
  },
  configFields: [
    TTS_PROVIDER_FIELD,
    {
      key: 'appId',
      label: 'AppId',
      type: 'text',
      required: true,
      placeholder: '控制台 → 语音技术 → 应用管理'
    },
    {
      key: 'accessToken',
      label: 'Access Token',
      type: 'password',
      secret: true,
      required: true,
      placeholder: '应用的 Access Token'
    },
    {
      key: 'cluster',
      label: '接入集群 Cluster',
      type: 'text',
      default: 'volcano_tts',
      placeholder: 'volcano_tts',
      help: '复刻音色用另一个集群（复刻走音色库，不用改这里）'
    },
    voiceField(voiceHint),
    {
      key: 'speed',
      label: '语速倍率',
      type: 'number',
      default: 1,
      placeholder: '1.0',
      help: '对应合成请求里的 speed_ratio，1.0 为原速'
    }
  ],
  voiceHint,
  links: [
    { label: '去火山语音控制台拿 AppId / Token', url: 'https://console.volcengine.com/speech/app' },
    { label: '查看接入文档', url: 'https://www.volcengine.com/docs/6561/79820' }
  ]
}
