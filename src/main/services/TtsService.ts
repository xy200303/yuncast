import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { StorageService } from './StorageService'
import { getTtsProvider, isTtsConnectionReady } from './providers/registry'
import { TTS_PROVIDER_SHORT, type TtsConnection, type TtsProvider } from '../../shared/types'
import {
  defaultProviderConnectionError,
  findCloneVoice,
  voiceConnectionError
} from '../../shared/voiceProvider'

/**
 * TTS 双通道合成（搬迁自旧版 desktop/src/main/modules/tts/volcanoClient.ts）。
 * - 火山引擎语音合成（大模型语音合成 HTTP 协议）: https://www.volcengine.com/docs/6561/79817
 * - 阿里云百炼 DashScope 多模态生成（Qwen-TTS）
 * 预合成走 HTTP 一次性返回 mp3（火山）/ wav（百炼），写入 userData/audio-cache。
 *
 * 凭据按服务商存在 tts_connections 接入列表里（设置 → 语音合成，一家一条），
 * 合成时**按生效音色的归属路由到对应接入**：克隆音色归它自己那家，系统音色归默认服务商。
 */

const VOLCANO_TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts'
const BAILIAN_TTS_PATH = '/services/aigc/multimodal-generation/generation'
/** 百炼端点按模型系列区分（端点不可混用）：Qwen-TTS 走通用端点，其余走 maas 业务空间端点 */
const BAILIAN_QWEN_TTS_PREFIX = 'qwen3-tts'
const MAAS_TTS_PATH = '/services/audio/tts/SpeechSynthesizer'
const MAAS_BASE = '.cn-beijing.maas.aliyuncs.com/api/v1'
const MAAS_REGION_SUFFIX = '.cn-beijing.maas.aliyuncs.com'

interface BailianTarget {
  url: string
  body: Record<string, unknown>
}


const REQUEST_TIMEOUT_MS = 30000

interface VolcanoTtsRequest {
  app: { appid: string; token: string; cluster: string }
  user: { uid: string }
  audio: { voice_type: string; encoding: string; speed_ratio: number }
  request: { reqid: string; text: string; operation: string }
}

/** 解析出来的合成路由：用哪家的哪条接入，以及真正送进合成的音色 */
interface TtsRoute {
  provider: TtsProvider
  params: TtsConnection['params']
  voice: string
}

export class TtsService {
  constructor(private readonly storage: StorageService) {}

  /** 合成音频缓存目录（media:// 协议只服务这个目录里的文件） */
  audioCacheDir(): string {
    const dir = join(app.getPath('userData'), 'audio-cache')
    void mkdir(dir, { recursive: true }).catch(() => undefined)
    return dir
  }

  /** 该音色会走哪家（流式通道据此选实现；接入没配就抛中文原因） */
  providerForVoice(voiceId?: string): TtsProvider {
    return this.route(voiceId).provider
  }

  /**
   * 合成路由：克隆音色只能用**它自己那家**的接入（火山复刻的 speaker_id 拿去百炼必然失败）；
   * 系统音色（音色库里没有记录）判断不出归属，按默认服务商。那条接入没配也没法合成，
   * 就地抛中文原因，不让请求跑到服务商才报一个看不懂的错。
   */
  private route(voiceId?: string): TtsRoute {
    const { tts } = this.storage.getConfig()
    const voice = (voiceId || tts.voiceId).trim()
    const clone = voice ? findCloneVoice(this.storage.listVoices(), voice) : undefined
    const provider: TtsProvider = clone ? (clone.provider as TtsProvider) : tts.providerId
    const connection = this.storage.ttsConnectionGetByProvider(provider)
    if (!connection || !isTtsConnectionReady(connection, getTtsProvider(provider))) {
      throw new Error(clone ? voiceConnectionError(clone) : defaultProviderConnectionError(provider))
    }
    return { provider, params: connection.params, voice }
  }

  /** 合成一条话术到缓存文件，返回绝对路径。signal 用于预合成窗口挤出时取消。 */
  async synthesize(itemId: string, text: string, voiceId?: string, signal?: AbortSignal): Promise<string> {
    const route = this.route(voiceId)
    const extension = route.provider === 'bailian' ? 'wav' : 'mp3'
    const outPath = join(this.audioCacheDir(), `${itemId}.${extension}`)
    if (route.provider === 'bailian') {
      await this.synthesizeBailian(text, outPath, route, signal)
    } else {
      await this.synthesizeVolcano(text, outPath, route, signal)
    }
    return outPath
  }

  /** 设置页「测试发音」：用指定的那条接入（默认 = 默认服务商）合成一小段，返回路径给渲染进程播放 */
  async test(
    text: string,
    providerId?: TtsProvider
  ): Promise<{ ok: boolean; error?: string; audioPath?: string }> {
    const provider = providerId ?? this.storage.getConfig().tts.providerId
    try {
      const voice = this.testVoice(provider)
      if (!voice) {
        return {
          ok: false,
          error: `还没有可用的${TTS_PROVIDER_SHORT[provider]}音色：到设置 → 语音合成填默认音色，或在音色库克隆一个`
        }
      }
      const audioPath = await this.synthesize(`test-${Date.now()}`, text, voice)
      // 记下成功时间：开播预检用它提示"凭据可能失效"（docs/07 §8.5）
      this.storage.setConfig({ tts: { lastTestAt: Date.now() } })
      return { ok: true, audioPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 测某家那条接入时用哪个音色：优先这家已就绪的克隆音色（归属明确，一定路由到它）；
   * 退而用默认音色——只有默认那家能用（默认音色归另外一家时会路由到那家去，测不到这条接入）。
   */
  private testVoice(provider: TtsProvider): string {
    const voices = this.storage.listVoices()
    const clone = voices.find(
      (voice) => voice.provider === provider && voice.status === 'ready' && voice.voiceType.trim()
    )
    if (clone) return clone.voiceType
    const { tts } = this.storage.getConfig()
    if (tts.providerId !== provider || findCloneVoice(voices, tts.voiceId)) return ''
    return tts.voiceId
  }

  private combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }

  private async synthesizeVolcano(
    text: string,
    outPath: string,
    route: TtsRoute,
    signal?: AbortSignal
  ): Promise<void> {
    const { tts } = this.storage.getConfig()
    const appId = String(route.params.appId ?? '')
    const accessToken = String(route.params.accessToken ?? '')
    const cluster = String(route.params.cluster ?? '') || 'volcano_tts'
    const voice = route.voice
    if (!voice) throw new Error('未选择音色（voiceId 为空）')

    const payload: VolcanoTtsRequest = {
      app: { appid: appId, token: accessToken, cluster },
      user: { uid: 'agent-anchor' },
      audio: {
        voice_type: voice,
        encoding: 'mp3',
        speed_ratio: tts.speed
      },
      request: {
        reqid: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        text,
        operation: 'query'
      }
    }

    const res = await fetch(VOLCANO_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer;${accessToken}`
      },
      body: JSON.stringify(payload),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { code?: number; message?: string; data?: string }
    if (data.code !== 3000 || !data.data) {
      throw new Error(`TTS 合成失败: code=${data.code} ${data.message ?? ''}`)
    }

    await mkdir(dirname(outPath), { recursive: true }).catch(() => undefined)
    await writeFile(outPath, Buffer.from(data.data, 'base64'))
  }


  /**
   * 百炼 Qwen-TTS **真流式**合成（依据 help.aliyun.com/zh/model-studio/qwen-tts-api）。
   * 端点与鉴权同非流式，加 X-DashScope-SSE: enable 头，服务端按 SSE 返回多个 chunk：
   *   中间帧：output.audio.data = base64 音频片段（PCM 16bit 单声道 24kHz）
   *   末帧：finish_reason = stop，data 为空、url 为完整音频地址（不用它）
   * 文本上限 600 字符。
   */
  async *synthesizeBailianStream(
    text: string,
    voiceId?: string,
    signal?: AbortSignal
  ): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const { tts } = this.storage.getConfig()
    const route = this.route(voiceId)
    const apiKey = String(route.params.apiKey ?? '')
    if (!route.voice) throw new Error('未选择百炼音色（voiceId 为空）')

    const target = this.buildBailianTarget(text, route.voice, route.params, { stream: true })
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-SSE': 'enable'
      },
      body: JSON.stringify(target.body),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`百炼流式 TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }
    if (!res.body) throw new Error('百炼流式 TTS 无响应体')

    const sep = new RegExp(String.fromCharCode(13) + '?\\n{2}')
    const brk = new RegExp(String.fromCharCode(13) + '?\\n')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(sep)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        for (const line of block.split(brk)) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let frame: {
            status_code?: number
            message?: string
            output?: { audio?: { data?: string }; finish_reason?: string | null }
          }
          try {
            frame = JSON.parse(payload)
          } catch {
            continue
          }
          if (frame.status_code && frame.status_code !== 200) {
            throw new Error(
              `百炼流式 TTS 返回 ${frame.status_code}${frame.message ? `：${frame.message}` : ''}`
            )
          }
          const base64 = frame.output?.audio?.data
          if (base64) {
            // 流式固定要 pcm（见 buildBailianTarget），采样率跟随配置
            yield { pcm: Buffer.from(base64, 'base64'), sampleRate: tts.sampleRate || 24000 }
          }
        }
      }
    }
  }

  /** 依据模型名与配置，构造百炼请求的端点与请求体（端点系列见 docs/02 §端点多系列） */
  private buildBailianTarget(
    text: string,
    voice: string,
    params: TtsConnection['params'],
    extra: { stream: boolean }
  ): BailianTarget {
    const { tts } = this.storage.getConfig()
    const model = String(params.model ?? '')
    const base = (String(params.baseUrl ?? '') || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '')
    const instruction = tts.instruction?.trim()

    // Qwen-TTS 系列（qwen3-tts-flash）：通用端点 + multimodal-generation 请求体
    if (model.startsWith(BAILIAN_QWEN_TTS_PREFIX)) {
      return {
        url: `${base}${BAILIAN_TTS_PATH}`,
        body: {
          model,
          input: {
            text,
            voice,
            language_type: String(params.languageType ?? '') || 'Chinese',
            ...(instruction ? { instruction } : {})
          }
        }
      }
    }

    // 其余系列（Qwen-Audio-TTS / CosyVoice / MiniMax）：maas 端点，需要业务空间 ID
    const workspaceId = String(params.workspaceId ?? '')
    if (!workspaceId) {
      throw new Error(
        `模型 ${model} 需要「业务空间 ID」（设置 → 语音合成 → 阿里云百炼接入）：端点形如 https://{业务空间ID}.cn-beijing.maas.aliyuncs.com`
      )
    }
    const maasBase = `https://${workspaceId}${MAAS_BASE}`
    void MAAS_REGION_SUFFIX
    return {
      url: `${maasBase}${MAAS_TTS_PATH}`,
      body: {
        model,
        input: {
          text,
          voice,
          format: extra.stream ? 'pcm' : tts.format,
          sample_rate: tts.sampleRate,
          ...(instruction ? { instruction } : {})
        }
      }
    }
  }

  private async synthesizeBailian(
    text: string,
    outPath: string,
    route: TtsRoute,
    signal?: AbortSignal
  ): Promise<void> {
    const apiKey = String(route.params.apiKey ?? '')
    const voice = route.voice
    if (!voice) throw new Error('未选择百炼音色（voiceId 为空）')

    const target = this.buildBailianTarget(text, voice, route.params, { stream: false })
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(target.body),
      signal: this.combinedSignal(signal)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`百炼 TTS 请求失败 ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      output?: { audio?: { url?: string } }
      code?: string
      message?: string
    }
    const audioUrl = data.output?.audio?.url
    if (!audioUrl) {
      throw new Error(`百炼 TTS 未返回音频地址${data.message ? `：${data.message}` : ''}`)
    }

    const audioRes = await fetch(audioUrl, { signal: this.combinedSignal(signal) })
    if (!audioRes.ok) throw new Error(`百炼音频下载失败 ${audioRes.status}`)
    await mkdir(dirname(outPath), { recursive: true }).catch(() => undefined)
    await writeFile(outPath, Buffer.from(await audioRes.arrayBuffer()))
  }
}
