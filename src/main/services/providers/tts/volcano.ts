import { TTS_PROVIDER_SHORT, type ParamSpec, type TtsModelSpec } from '../../../../shared/types'
import type { TtsProviderManifest } from '../registry'
import { seedTts1Voices, seedTts2Voices } from './voices.volcano'

/**
 * 火山引擎（豆包语音）语音合成：全部走 V3 体系（HTTP Chunked，TtsService.synthesizeVolcano）。
 * 端点 https://openspeech.bytedance.com/api/v3/tts/unidirectional，鉴权 X-Api-Key + X-Api-Resource-Id。
 * 旧 V1（appId + token + cluster）已放弃；凭据只有新版控制台的 API Key。
 * 复刻走 /api/v3/tts/voice_clone + /api/v3/tts/get_voice（VoiceService）。
 */

/** 语音指令（additions.context_texts，不计费）：仅 seed-tts-2.0 精品音色支持；
 *  复刻音色（seed-icl-x）指定 model 后不可用，所以只挂在 seed-tts-2.0 的参数表里。
 *  接入级静态底色，agent 每条话术的 delivery 会覆盖它（TtsService.withPerformance） */
const CONTEXT_INSTRUCTION_PARAM: ParamSpec = {
  key: 'instruction',
  label: '语音指令（风格底色）',
  type: 'text',
  help: '如「用热情爽朗的语气说」；不计费；每条话术的 delivery 会覆盖它'
}

/** 火山全模型共用的合成参数（V3 req_params / audio_params / additions）。
 *  speech_rate/pitch/silence_duration 是接入默认，agent 可按条覆盖（语速/音调） */
function volcanoParams(extra: ParamSpec[] = []): ParamSpec[] {
  return [
    {
      key: 'speech_rate',
      label: '语速（接入默认，agent 可按条覆盖）',
      type: 'number',
      min: -50,
      max: 100,
      default: 0,
      help: '0 为原速；[-50, 100] 对应 0.5x - 2x'
    },
    { key: 'loudness_rate', label: '音量', type: 'number', min: -50, max: 100, default: 0 },
    {
      key: 'pitch',
      label: '音调（半音，接入默认，agent 可按条覆盖）',
      type: 'number',
      min: -12,
      max: 12,
      default: 0,
      help: '对应 additions.post_process.pitch'
    },
    {
      key: 'silence_duration',
      label: '句尾静音（毫秒）',
      type: 'number',
      min: 0,
      default: 0,
      help: '0 为不额外留白；段落之间的停顿也可以用 pauseAfterMs / <pause> 标记'
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
    note: '最新一代大模型音色（uranus 族），Resource-Id 同名；支持语音指令（context_texts，不计费）',
    kind: 'tts',
    instruction: true,
    params: volcanoParams([CONTEXT_INSTRUCTION_PARAM]),
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
    note: '只吃复刻出的 speaker_id（音色库克隆产物）；复刻音色指定 model 后不支持语音指令（context_texts），局部情绪用 expressive 的 cot 标签',
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
          { value: 'seed-tts-2.0-expressive', label: 'expressive（表现力：支持 cot 局部情绪标签）' }
        ],
        help: 'expressive 自动开 cot 标签解析：文案里 <cot text=情绪>句子</cot> 只给该句套情绪（含标签单句 ≤64 字）'
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
  },
  {
    // PodcastAPI（WebSocket v3，TtsService → providers/tts/podcastVolcano）：
    // 双人轮次稿一次合成整期双人音频，不是逐段 TTS；Resource-Id 固定 volc.service_type.10050
    id: 'volc-podcast-v3',
    label: 'Podcast 双人播客',
    note: '双人播客整期合成：预制节目选它，文稿按主持人 A/B 一次合成整期音频',
    kind: 'tts',
    params: [
      {
        key: 'speech_rate',
        label: '语速（接入默认）',
        type: 'number',
        min: -50,
        max: 100,
        default: 0,
        help: '0 为原速；[-50, 100] 对应 0.5x - 2x'
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
        options: ['16000', '24000', '48000'].map((value) => ({ value, label: value }))
      }
    ],
    // 播客专用发音人（官方「可选发音人列表」）；普通 TTS 目录音色与克隆音色也能当主持人
    voices: [
      {
        label: '播客发音人',
        voices: [
          { id: 'zh_female_mizaitongxue_v2_saturn_bigtts', name: '咪仔（女声）', desc: '黑猫侦探社系列' },
          { id: 'zh_male_dayixiansheng_v2_saturn_bigtts', name: '大壹先生（男声）', desc: '黑猫侦探社系列' },
          { id: 'zh_male_liufei_v2_saturn_bigtts', name: '刘飞（男声）', desc: '刘飞和潇磊系列' },
          { id: 'zh_male_xiaolei_v2_saturn_bigtts', name: '潇磊（男声）', desc: '刘飞和潇磊系列' }
        ]
      }
    ],
    capabilities: {
      kind: 'podcast',
      input: 'dialogueTurns',
      output: 'stream',
      minSpeakers: 2,
      maxSpeakers: 2,
      supportsCloneVoice: true,
      supportsResume: true,
      supportsTimestamps: true,
      maxTextChars: 10000,
      maxCharsPerTurn: 300
    }
  }
]

export const volcanoTtsProvider: TtsProviderManifest = {
  id: 'volcano',
  label: `${TTS_PROVIDER_SHORT.volcano}（豆包语音）`,
  icon: 'volcano',
  note: 'V3 大模型语音合成 + 声音复刻；HTTP 整段返回，延迟按整段算',
  capabilities: {
    streaming: false,
    clone: true,
    instruction: true,
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
  links: [
    { label: '去火山语音控制台拿 API Key', url: 'https://console.volcengine.com/speech/app' },
    { label: '查看 V3 接入文档', url: 'https://www.volcengine.com/docs/6561/1598757' }
  ],
  // 火山语音合成是并发制（文档：并发 100），串行逐条合成碰不到限流，间隔意思一下
  defaultSynthIntervalMs: 50
}
