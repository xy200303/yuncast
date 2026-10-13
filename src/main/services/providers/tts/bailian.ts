import { TTS_PROVIDER_SHORT, type ParamSpec, type TtsModelSpec } from '../../../../shared/types'
import type { TtsProviderManifest } from '../registry'
import {
  cosyvoiceV1Voices,
  cosyvoiceV2Voices,
  cosyvoiceV3FlashVoices,
  cosyvoiceV3PlusVoices,
  qwen3TtsFlashVoices
} from './voices.bailian'

/**
 * 阿里云百炼语音合成：qwen3-tts 系走 DashScope 通用端点（无需业务空间 ID），
 * Qwen-Audio-TTS / CosyVoice 系走 maas 业务空间端点（TtsService.buildBailianTarget 分流）。
 * Qwen-TTS / maas 系都支持 SSE 真流式（TtsService.synthesizeBailianStream）。
 * 声音复刻走 voice-enrollment（VoiceService.cloneBailian），target_model 见各模型 cloneTarget：
 * 官方复刻 API 的 target_model 不含 cosyvoice-v1，所以 V1 不能作为复刻目标。
 */

/** Qwen-Audio-TTS / CosyVoice 系共用的合成参数（maas SpeechSynthesizer） */
function maasParams(withInstruction = false): ParamSpec[] {
  const list: ParamSpec[] = [
    {
      key: 'format',
      label: '输出格式',
      type: 'select',
      default: 'mp3',
      options: [
        { value: 'mp3', label: 'MP3（兼容最好）' },
        { value: 'wav', label: 'WAV' },
        { value: 'pcm', label: 'PCM（流式推荐，免解码）' }
      ]
    },
    {
      key: 'sample_rate',
      label: '采样率（Hz）',
      type: 'select',
      default: '24000',
      options: ['16000', '22050', '24000', '48000'].map((value) => ({ value, label: value }))
    },
    { key: 'volume', label: '音量', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'rate', label: '语速倍率', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1 },
    { key: 'pitch', label: '音调倍率', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1 }
  ]
  if (withInstruction) {
    list.push({
      key: 'instruction',
      label: '语气指令（可选）',
      type: 'text',
      help: '≤100 字，如「语速稍快，语气热情，像直播间卖货」'
    })
  }
  return list
}

const QWEN_AUDIO_NOTE = '需要业务空间 ID；支持语气指令与文本内嵌情感标签'
const COSY_NOTE = '需要业务空间 ID；支持语气指令与声音复刻'

const models: TtsModelSpec[] = [
  {
    id: 'qwen3-tts-flash',
    label: 'Qwen3-TTS Flash',
    note: '走 DashScope 通用端点，无需业务空间 ID；没有语速/音调/语气参数',
    kind: 'tts',
    streaming: true,
    params: [
      {
        key: 'language_type',
        label: '语种',
        type: 'select',
        default: 'Auto',
        options: [
          { value: 'Auto', label: 'Auto（自动）' },
          { value: 'Chinese', label: 'Chinese（中文）' },
          { value: 'English', label: 'English' },
          { value: 'Japanese', label: 'Japanese（日语）' },
          { value: 'Korean', label: 'Korean（韩语）' },
          { value: 'German', label: 'German（德语）' },
          { value: 'French', label: 'French（法语）' },
          { value: 'Russian', label: 'Russian（俄语）' },
          { value: 'Italian', label: 'Italian（意大利语）' },
          { value: 'Spanish', label: 'Spanish（西班牙语）' },
          { value: 'Portuguese', label: 'Portuguese（葡萄牙语）' }
        ]
      }
    ],
    voices: qwen3TtsFlashVoices
  },
  {
    id: 'qwen-audio-3.0-tts-plus',
    label: 'Qwen-Audio 3.0 TTS Plus',
    note: QWEN_AUDIO_NOTE,
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: []
  },
  {
    id: 'qwen-audio-3.0-tts-flash',
    label: 'Qwen-Audio 3.0 TTS Flash',
    note: QWEN_AUDIO_NOTE,
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: []
  },
  {
    id: 'qwen-audio-3.1-tts-flash',
    label: 'Qwen-Audio 3.1 TTS Flash',
    note: QWEN_AUDIO_NOTE,
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: []
  },
  {
    id: 'cosyvoice-v1',
    label: 'CosyVoice V1',
    note: '需要业务空间 ID；不支持语气指令；官方复刻 API 的 target_model 不含 V1',
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    params: maasParams(),
    voices: cosyvoiceV1Voices
  },
  {
    id: 'cosyvoice-v2',
    label: 'CosyVoice V2',
    note: '需要业务空间 ID；支持声音复刻（不支持语气指令）',
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    cloneTarget: true,
    params: maasParams(),
    voices: cosyvoiceV2Voices
  },
  {
    id: 'cosyvoice-v3-plus',
    label: 'CosyVoice V3 Plus',
    note: COSY_NOTE,
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: cosyvoiceV3PlusVoices
  },
  {
    id: 'cosyvoice-v3-flash',
    label: 'CosyVoice V3 Flash',
    note: COSY_NOTE,
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: cosyvoiceV3FlashVoices
  },
  {
    id: 'cosyvoice-v3.5-plus',
    label: 'CosyVoice V3.5 Plus',
    note: '需要业务空间 ID；官方未公布系统音色目录，用复刻音色或手动输入',
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: []
  },
  {
    id: 'cosyvoice-v3.5-flash',
    label: 'CosyVoice V3.5 Flash',
    note: '需要业务空间 ID；官方未公布系统音色目录，用复刻音色或手动输入',
    kind: 'tts',
    needsWorkspace: true,
    streaming: true,
    instruction: true,
    cloneTarget: true,
    params: maasParams(true),
    voices: []
  }
]

export const bailianTtsProvider: TtsProviderManifest = {
  id: 'bailian',
  label: `${TTS_PROVIDER_SHORT.bailian}（Qwen-TTS / CosyVoice）`,
  icon: 'bailian',
  note: 'SSE 真流式、支持语气指令；声音复刻走 voice-enrollment（需公网音频地址）',
  capabilities: {
    streaming: true,
    clone: true,
    instruction: true,
    formats: ['mp3', 'wav', 'pcm']
  },
  configFields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      secret: true,
      required: true,
      placeholder: 'sk-…'
    },
    {
      key: 'workspaceId',
      label: '业务空间 ID',
      type: 'text',
      placeholder: 'CosyVoice / Qwen-Audio / 声音复刻必须填',
      help: 'qwen3-tts-flash 不需要；其余模型端点形如 https://{业务空间ID}.cn-beijing.maas.aliyuncs.com',
      wide: true
    },
    {
      key: 'baseUrl',
      label: 'API 地址（可选）',
      type: 'text',
      placeholder: '留空用官方默认 https://dashscope.aliyuncs.com/api/v1'
    }
  ],
  models,
  links: [
    { label: '去百炼控制台拿 API Key', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
    { label: '查看 Qwen-TTS 文档', url: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api' }
  ],
  // 百炼限流文档：Qwen-TTS/CosyVoice RPM 180（RPS 3），留余量取 400ms
  defaultSynthIntervalMs: 400
}
