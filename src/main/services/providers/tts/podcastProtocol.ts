import { gunzipSync } from 'node:zlib'
import type { PodcastTurn, TtsSynthesisRequest } from '../../../../shared/types'

/**
 * 火山 PodcastAPI WebSocket v3 二进制协议编解码（纯函数，无网络/无 electron 依赖，可离线自检）。
 * 协议文档：https://docs.volcengine.com/docs/DoubaoVoice/PodcastAPI-websocket-v3protocol
 *
 * 帧结构（整数一律大端）：
 *   byte0 = 协议版本 0b0001 << 4 | header 长度 0b0001        → 固定 0x11
 *   byte1 = 消息类型 << 4 | 类型标记
 *           上行请求   0b1001_0100 = 0x94（full-client request，带事件号）
 *           下行音频帧 0b1011_0100 = 0xB4；下行其他帧 0b1001_0100 = 0x94
 *           下行错误帧 0xF0（事件号位置是错误码）
 *   byte2 = 序列化 << 4 | 压缩（0b0001 JSON / 0b0000 Raw；压缩 0b0001 = gzip）
 *   byte3 = 保留 0
 *   [4~7] = 事件号（uint32 BE；错误帧里是错误码）
 * 会话类帧随后：len(session_id) + session_id + len(payload) + payload；
 * FinishConnection 不带 session_id：len(payload) + payload。
 *
 * 按文档明确实现的：帧头布局、事件 150/152/154/360/361/362/363/52、action=3 的 nlp_texts、
 * retry_info 断点续传、错误码表。
 * 按同体系（火山 v3 双向流式）推断、需联调校准的：上行 StartSession 事件号 = 100
 * （播客文档的帧示例只写 "StartSession event type" 没给数值；FinishSession=102 播客流程用不到——
 * 文档明确"生成 podcast 阶段不需要客户端发送上行 event 帧"，结束由服务端推 152）。
 */

export const PODCAST_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sami/podcasttts'
/** 播客语音合成的 Resource-Id（固定值，不是模型 id） */
export const PODCAST_RESOURCE_ID = 'volc.service_type.10050'

export const PODCAST_EVENTS = {
  FinishConnection: 2,
  ConnectionFinished: 52,
  /** 上行（事件号按火山 v3 同体系推断，待联调校准） */
  StartSession: 100,
  SessionStarted: 150,
  SessionFinished: 152,
  UsageResponse: 154,
  PodcastRoundStart: 360,
  PodcastRoundResponse: 361,
  PodcastRoundEnd: 362,
  PodcastEnd: 363
} as const

/** 合成成功状态码（152 SessionFinished 的 payload.status_code） */
export const PODCAST_OK_CODE = 20000000

const MSG_FULL_CLIENT = 0b1001
const MSG_AUDIO_ONLY = 0b1011
const FLAG_WITH_EVENT = 0b0100
const SERIAL_JSON = 0b0001

export interface PodcastRoundMeta {
  text_type?: string
  speaker?: string
  /** -1 = 开头音乐；9999 = 结尾音乐；≥0 = 对话轮次 */
  round_id?: number
  text?: string
}

export interface PodcastRoundEndMeta {
  is_error?: boolean
  error_msg?: string
  audio_duration?: number
  start_time?: number
  end_time?: number
}

export type PodcastFrame =
  | {
      kind: 'event'
      event: number
      sessionId: string
      /** 原始 payload（361 是音频二进制；其余是 JSON 文本，json 已代为解析） */
      payload: Buffer
      json?: Record<string, unknown>
    }
  | { kind: 'error'; code: number; message: string }

function frameHeader(messageType: number, serialization: number): Buffer {
  return Buffer.from([
    0x11,
    (messageType << 4) | FLAG_WITH_EVENT,
    (serialization << 4) | 0,
    0
  ])
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/** 上行 StartSession 帧：header + event + session_id + JSON payload（retry_info 在 payload 里） */
export function buildStartSessionFrame(sessionId: string, payload: Record<string, unknown>): Buffer {
  const session = Buffer.from(sessionId, 'utf8')
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([
    frameHeader(MSG_FULL_CLIENT, SERIAL_JSON),
    u32(PODCAST_EVENTS.StartSession),
    u32(session.length),
    session,
    u32(body.length),
    body
  ])
}

/** 上行 FinishConnection 帧：不带 session_id（文档帧示例：event + len(payload) + payload） */
export function buildFinishConnectionFrame(): Buffer {
  const body = Buffer.from('{}', 'utf8')
  return Buffer.concat([
    frameHeader(MSG_FULL_CLIENT, SERIAL_JSON),
    u32(PODCAST_EVENTS.FinishConnection),
    u32(body.length),
    body
  ])
}

/**
 * 解析下行帧。错误帧（byte1 = 0xF0）→ { kind: 'error' }；
 * 其余按 事件号 + session_id + payload 解析；payload 标了 gzip 的先解压。
 * 帧畸形抛异常（调用方兜底成「协议解析失败」错误，不让脏帧静默过去）。
 */
export function parsePodcastFrame(data: Buffer): PodcastFrame {
  if (data.length < 8) throw new Error(`帧太短（${data.length} 字节）`)
  if (data[0] !== 0x11) throw new Error(`帧头版本/长度不对：0x${data[0].toString(16)}`)
  const byte1 = data[1]
  const compression = data[2] & 0x0f

  // 错误帧：事件号位置是错误码，payload 是错误消息对象
  if (byte1 === 0xf0) {
    const code = data.readUInt32BE(4)
    const raw = data.subarray(8).toString('utf8')
    let message = raw
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      message = String(parsed.message ?? parsed.error_msg ?? raw)
    } catch {
      /* payload 不是 JSON 就按原文展示 */
    }
    return { kind: 'error', code, message }
  }

  const messageType = byte1 >> 4
  if (messageType !== MSG_FULL_CLIENT && messageType !== MSG_AUDIO_ONLY) {
    throw new Error(`未知下行消息类型：0x${messageType.toString(16)}`)
  }
  const event = data.readUInt32BE(4)
  let offset = 8
  const sessionLen = data.readUInt32BE(offset)
  offset += 4
  const sessionId = data.subarray(offset, offset + sessionLen).toString('utf8')
  offset += sessionLen
  const payloadLen = data.readUInt32BE(offset)
  offset += 4
  let payload = data.subarray(offset, offset + payloadLen)
  if (compression === 1) payload = gunzipSync(payload)

  let json: Record<string, unknown> | undefined
  if (event !== PODCAST_EVENTS.PodcastRoundResponse && payload.length > 0) {
    try {
      json = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    } catch {
      json = undefined
    }
  }
  return { kind: 'event', event, sessionId, payload, json }
}

/** 断点续传信息（retry_info：retry_task_id = 第一次 StartSession 的 session_id） */
export interface PodcastResumeInfo {
  retryTaskId: string
  lastFinishedRoundId: number
}

export interface PodcastPayloadOptions {
  format: string
  sampleRate: number
  /** 火山口径语速：[-50, 100]，0 = 原速 */
  speechRate: number
  /** 发音人额外信息（ICL/复刻音色切模型用，JSON 字符串值） */
  speakerAdditions?: Record<string, string>
  resume?: PodcastResumeInfo
}

type PodcastRequest = Extract<TtsSynthesisRequest, { type: 'podcast' }>

/**
 * 组装 StartSession 的 payload（action=3：按 nlp_texts 轮次稿直接合成）。
 * return_audio_url=true：请服务端在 363 PodcastEnd 里回完整音频链接（有效期 1h），
 * 拿到就优先下载整期成品；拿不到再用逐轮音频帧拼接。
 */
export function buildPodcastSessionPayload(
  request: PodcastRequest,
  options: PodcastPayloadOptions
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: 3,
    use_head_music: request.useHeadMusic,
    use_tail_music: request.useTailMusic,
    nlp_texts: request.turns.map((turn: PodcastTurn) => ({ speaker: turn.speaker, text: turn.text })),
    audio_config: {
      format: options.format,
      sample_rate: options.sampleRate,
      speech_rate: options.speechRate
    },
    speaker_info: {
      // 发音人顺序固定（A 先开口由轮次稿自己决定，不让服务端随机）
      random_order: false,
      speakers: [...request.speakers]
    },
    input_info: { return_audio_url: true }
  }
  if (options.speakerAdditions && Object.keys(options.speakerAdditions).length > 0) {
    ;(payload.speaker_info as Record<string, unknown>).speaker_additions = options.speakerAdditions
  }
  if (options.resume) {
    payload.retry_info = {
      retry_task_id: options.resume.retryTaskId,
      last_finished_round_id: options.resume.lastFinishedRoundId
    }
  }
  return payload
}

/** 播客错误的中文说明（§15.9：内容审核/配额不足/不可重试错误显式抛出；retryable=true 的走断点续传） */
export function describePodcastError(code: number, message: string): { text: string; retryable: boolean } {
  const lower = message.toLowerCase()
  if (code === 45000000) {
    return {
      text: `播客合成配额不足或并发超限：稍后再试，或到火山控制台确认额度（${message}）`,
      retryable: false
    }
  }
  if (code === 40000010) {
    return { text: `播客合成参数错误：${message}（这通常是适配器问题，请反馈）`, retryable: false }
  }
  if (code === 40000022 || lower.includes('content filter') || lower.includes('textriskauditfailed')) {
    return {
      text: `播客内容审核未通过：文稿命中风控，请修改文稿后重试（不会自动降级到普通 TTS）`,
      retryable: false
    }
  }
  if (lower.includes('content length')) {
    return {
      text: `播客文稿超过模型上下文限制：拆成更多期/章再合成（${message}）`,
      retryable: false
    }
  }
  if (code === 55000000) {
    return { text: `播客服务端错误：${message}（会自动断点续传重试）`, retryable: true }
  }
  return { text: `播客合成失败：code=${code} ${message}`, retryable: false }
}
