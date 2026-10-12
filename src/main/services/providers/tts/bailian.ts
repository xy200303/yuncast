import { TTS_PROVIDER_SHORT } from '../../../../shared/types'
import type { TtsProviderManifest } from '../registry'
import { voiceField } from './shared'

/**
 * 阿里云百炼 Qwen-TTS：HTTP 返回音频地址（TtsService.synthesizeBailian）。
 * 能力依据见 docs/06-TTS克隆接口核对.md 附录：Qwen-TTS 走 X-DashScope-SSE 真流式（已核实）、
 * 有语气指令字段；**音色复刻未实现**（待确认是否支持本地音频直传），所以 clone 为 false。
 */
const voiceHint = {
  label: '默认音色 voice',
  placeholder: 'qwen3-tts-flash 的 voice，例如 Cherry',
  help: '音色名对模型有要求（如 Cherry / Serena），以百炼文档的音色列表为准'
}

export const bailianTtsProvider: TtsProviderManifest = {
  id: 'bailian',
  label: `${TTS_PROVIDER_SHORT.bailian}（Qwen-TTS）`,
  icon: 'bailian',
  note: 'Qwen-TTS 走 SSE 真流式、支持语气指令；音色复刻尚未接入',
  capabilities: {
    streaming: true,
    clone: false,
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
      key: 'model',
      label: '模型',
      type: 'text',
      default: 'qwen3-tts-flash',
      required: true,
      placeholder: 'qwen3-tts-flash',
      help: '模型名决定走哪个端点：qwen3-tts 系列走通用端点，其余系列要填业务空间 ID'
    },
    {
      key: 'baseUrl',
      label: 'API 地址',
      type: 'text',
      default: 'https://dashscope.aliyuncs.com/api/v1',
      placeholder: 'https://dashscope.aliyuncs.com/api/v1'
    },
    {
      key: 'languageType',
      label: '语种',
      type: 'text',
      default: 'Chinese',
      placeholder: 'Chinese',
      help: 'Auto / Chinese 等，见 Qwen-TTS 文档的 language_type'
    },
    {
      key: 'workspaceId',
      label: '业务空间 ID',
      type: 'text',
      placeholder: '模型名不以 qwen3-tts 开头时必须填',
      help: 'Qwen-Audio-TTS / CosyVoice / MiniMax 系列的端点形如 https://{业务空间ID}.cn-beijing.maas.aliyuncs.com',
      wide: true
    },
    voiceField(voiceHint),
    {
      key: 'instruction',
      label: '语气指令 instruction（可选，≤100 字）',
      type: 'text',
      placeholder: '例如：语速稍快，语气热情，像直播间卖货',
      wide: true,
      preference: true
    },
    {
      key: 'format',
      label: '输出格式',
      type: 'select',
      default: 'mp3',
      options: [
        { value: 'mp3', label: 'MP3（兼容最好）' },
        { value: 'wav', label: 'WAV' },
        { value: 'pcm', label: 'PCM（流式推荐，免解码）' }
      ],
      preference: true
    },
    {
      key: 'sampleRate',
      label: '采样率（Hz）',
      type: 'select',
      default: 24000,
      options: [
        { value: '24000', label: '24000（推荐）' },
        { value: '16000', label: '16000' },
        { value: '48000', label: '48000' }
      ],
      preference: true
    }
  ],
  voiceHint,
  links: [
    { label: '去百炼控制台拿 API Key', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
    { label: '查看 Qwen-TTS 文档', url: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api' }
  ]
}
