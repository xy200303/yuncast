import { TTS_PROVIDER_SHORT, type ParamSpec, type TtsModelSpec } from '../../../../shared/types'
import type { TtsProviderManifest } from '../registry'
import { seedTts1Voices, seedTts2Voices } from './voices.volcano'

/**
 * 火山引擎（豆包语音）语音合成：全部走 V3 体系（HTTP Chunked，TtsService.synthesizeVolcano）。
 * 端点 https://openspeech.bytedance.com/api/v3/tts/unidirectional，鉴权 X-Api-Key + X-Api-Resource-Id。
 * 旧 V1（appId + token + cluster）已放弃；凭据只有新版控制台的 API Key。
 * 复刻走 /api/v3/tts/voice_clone + /api/v3/tts/get_voice（VoiceService）。
 */

/** 火山全模型共用的合成参数（V3 req_params / audio_params / additions） */
function volcanoParams(extra: ParamSpec[] = []): ParamSpec[] {
  return [
    {
      key: 'speech_rate',
      label: '语速',
      type: 'number',
      min: -50,
      max: 100,
      default: 0,
      help: '0 为原速；[-50, 100] 对应 0.5x - 2x'
    },
    { key: 'loudness_rate', label: '音量', type: 'number', min: -50, max: 100, default: 0 },
    {
      key: 'pitch',
      label: '音调（半音）',
      type: 'number',
      min: -12,
      max: 12,
      default: 0,
      help: '对应 additions.post_process.pitch'
    },
    {
      key: 'format',
      label: '输出格式',
      type: 'select',
      default: 'mp3',
      options: [
        { value: 'mp3', label: 'MP3（兼容最好）' },
        { value: 'ogg_opus', label: 'OGG（Opus）' },
        { value: 'pcm', label: 'PCM（免解码）' }
      ]
    },
    {
      key: 'sample_rate',
      label: '采样率（Hz）',
      type: 'select',
      default: '24000',
      options: ['8000', '16000', '22050', '24000', '32000', '44100', '48000'].map((value) => ({
        value,
        label: value
      }))
    },
    {
      key: 'emotion',
      label: '情感（可选）',
      type: 'text',
      help: '按音色支持，如 happy / angry / sad；留空不指定'
    },
    { key: 'emotion_scale', label: '情感强度', type: 'number', min: 1, max: 5, default: 4 },
    ...extra
  ]
}

const models: TtsModelSpec[] = [
  {
    id: 'seed-tts-2.0',
    label: 'Seed-TTS 2.0',
    note: '最新一代大模型音色（uranus 族），Resource-Id 同名',
    kind: 'tts',
    params: volcanoParams(),
    voices: seedTts2Voices
  },
  {
    id: 'seed-tts-1.0',
    label: 'Seed-TTS 1.0',
    note: '经典大模型音色（mars / moon 族）',
    kind: 'tts',
    params: volcanoParams(),
    voices: seedTts1Voices
  },
  {
    id: 'seed-icl-2.0',
    label: '声音复刻 2.0',
    note: '只吃复刻出的 speaker_id（音色库克隆产物）',
    kind: 'clone',
    cloneTarget: true,
    params: volcanoParams([
      {
        key: 'model',
        label: '复刻版本',
        type: 'select',
        default: 'seed-tts-2.0-standard',
        options: [
          { value: 'seed-tts-2.0-standard', label: 'standard（标准）' },
          { value: 'seed-tts-2.0-expressive', label: 'expressive（表现力）' }
        ]
      }
    ]),
    voices: []
  },
  {
    id: 'seed-icl-1.0',
    label: '声音复刻 1.0',
    note: '只吃复刻出的 speaker_id（音色库克隆产物）',
    kind: 'clone',
    cloneTarget: true,
    params: volcanoParams(),
    voices: []
  }
]

const voiceHint = {
  label: '默认音色 voice_type',
  placeholder: '系统音色 id，例如 zh_female_vv_uranus_bigtts',
  help: '复刻音色就填音色库里的那个 speaker_id（克隆后可用「音色库 → 设为默认」直接写上）'
}

export const volcanoTtsProvider: TtsProviderManifest = {
  id: 'volcano',
  label: `${TTS_PROVIDER_SHORT.volcano}（豆包语音）`,
  icon: 'volcano',
  note: 'V3 大模型语音合成 + 声音复刻；HTTP 整段返回，延迟按整段算',
  capabilities: {
    streaming: false,
    clone: true,
    instruction: false,
    formats: ['mp3', 'ogg_opus', 'pcm']
  },
  configFields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      secret: true,
      required: true,
      placeholder: '新版语音控制台 → API Key 管理',
      help: 'V3 接口用 X-Api-Key 头鉴权；旧的 AppId / Access Token / Cluster（V1）已放弃'
    }
  ],
  models,
  voiceHint,
  links: [
    { label: '去火山语音控制台拿 API Key', url: 'https://console.volcengine.com/speech/app' },
    { label: '查看 V3 接入文档', url: 'https://www.volcengine.com/docs/6561/1598757' }
  ]
}
