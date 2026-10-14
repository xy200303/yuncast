import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { TtsSynthesisRequest } from '../../../../shared/types'
import {
  PODCAST_EVENTS,
  PODCAST_OK_CODE,
  PODCAST_RESOURCE_ID,
  PODCAST_WS_URL,
  buildFinishConnectionFrame,
  buildPodcastSessionPayload,
  buildStartSessionFrame,
  describePodcastError,
  parsePodcastFrame,
  type PodcastPayloadOptions,
  type PodcastResumeInfo,
  type PodcastRoundEndMeta,
  type PodcastRoundMeta
} from './podcastProtocol'

/**
 * 火山 PodcastAPI 适配器（kind='podcast'，docs/10 §6.6）：
 * 双人轮次稿 → WebSocket v3（二进制帧）→ 整期双人音频。
 * 鉴权复用火山接入的 API Key（X-Api-Key + 固定 Resource-Id volc.service_type.10050）。
 *
 * 断点续传（supportsResume）：连接中断后用同一个 task_id（首连的 session_id）+
 * last_finished_round_id 重连，服务端从没完成的轮次继续推；已收到的轮次音频按 round_id
 * 去重保留。内容审核/配额/参数错误按 §15.9 显式抛出中文说明，绝不静默降级到普通 TTS。
 *
 * 整期成品：请求里挂 return_audio_url=true，363 PodcastEnd 带 audio_url 就优先下载完整成品；
 * 拿不到（该事件不保证返回）再用逐轮 361 音频帧按 round_id 顺序拼接。
 * 注：断点续传后服务端是否重推已完成轮次的音频帧、以及 audio_url 是否覆盖重试前内容，
 * 文档没有明说——实现按「audio_url 优先、逐轮拼接兜底」双保险，细节需联调校准。
 */

type PodcastRequest = Extract<TtsSynthesisRequest, { type: 'podcast' }>

export interface VolcanoPodcastOptions {
  apiKey: string
  request: PodcastRequest
  /** 音频参数与发音人附加信息（不含 retry_info，续传由这里自己管） */
  payload: Omit<PodcastPayloadOptions, 'resume'>
  signal?: AbortSignal
  /** 连接中断/可重试错误时的续传次数（默认 3，指数退避 1s/2s/3s） */
  maxResumes?: number
  /** 整个合成（含续传）的总时限（默认 10 分钟：整期播客合成本来就慢） */
  timeoutMs?: number
  onLog?: (message: string) => void
}

export interface VolcanoPodcastResult {
  audio: Buffer
  durationMs?: number
  /** true = 用了服务端整期成品链接；false = 逐轮音频帧拼接 */
  fromAudioUrl: boolean
}

class PodcastAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

/** 一次任务的生命周期状态（续传跨连接保留）：逐轮音频、逐轮时长、最后完成轮次、整期链接 */
interface PodcastTaskState {
  taskId: string
  /** round_id → 音频片段（-1 = 开头音乐，9999 = 结尾音乐） */
  rounds: Map<number, Buffer[]>
  /** round_id → 时长（秒），按轮次去重（续传重推不重复累计） */
  durations: Map<number, number>
  lastFinishedRound: number
  audioUrl?: string
}

export async function synthesizeVolcanoPodcast(options: VolcanoPodcastOptions): Promise<VolcanoPodcastResult> {
  const maxResumes = options.maxResumes ?? 3
  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  const log = options.onLog ?? (() => undefined)
  const state: PodcastTaskState = {
    taskId: randomUUID(),
    rounds: new Map(),
    durations: new Map(),
    lastFinishedRound: -1
  }

  let attempt = 0
  for (;;) {
    if (options.signal?.aborted) throw new Error('已中止')
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('播客合成超时（10 分钟）：文稿可能太长，或服务商拥塞，稍后重试')
    }
    // 有完成轮次才续传（retry_info 要 last_finished_round_id）；一轮都没完成就整个任务重来
    const resume: PodcastResumeInfo | undefined =
      state.lastFinishedRound >= 0
        ? { retryTaskId: state.taskId, lastFinishedRoundId: state.lastFinishedRound }
        : undefined
    if (!resume) state.taskId = randomUUID()
    try {
      await runPodcastSession(options, state, resume, remaining, log)
      break
    } catch (error) {
      if (options.signal?.aborted) throw new Error('已中止')
      const attemptError =
        error instanceof PodcastAttemptError
          ? error
          : new PodcastAttemptError(error instanceof Error ? error.message : String(error), true)
      if (!attemptError.retryable || attempt >= maxResumes) {
        if (attemptError.retryable && attempt >= maxResumes) {
          throw new Error(
            `播客合成连续中断（已断点续传 ${attempt} 次）：${attemptError.message}。检查网络后重新生成即可，已完成的轮次不会重复计费`
          )
        }
        throw new Error(attemptError.message)
      }
      attempt += 1
      log(`连接中断，${attempt}s 后断点续传（已完成 ${state.rounds.size} 轮）：${attemptError.message}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000 * attempt))
    }
  }

  const audio = state.audioUrl
    ? await downloadPodcastAudio(state.audioUrl, options.signal)
    : concatRounds(state)
  if (audio.length === 0) throw new Error('播客合成结束但没有拿到音频数据（协议行为异常，请反馈）')
  const durationSec = [...state.durations.values()].reduce((sum, value) => sum + value, 0)
  return {
    audio,
    durationMs: durationSec > 0 ? Math.round(durationSec * 1000) : undefined,
    fromAudioUrl: Boolean(state.audioUrl)
  }
}

/** 按 round_id 顺序拼接逐轮音频（-1 开头音乐 → 对话轮 → 9999 结尾音乐，数字序天然正确） */
function concatRounds(state: PodcastTaskState): Buffer {
  const ordered = [...state.rounds.keys()].sort((a, b) => a - b)
  return Buffer.concat(ordered.flatMap((roundId) => state.rounds.get(roundId) ?? []))
}

async function downloadPodcastAudio(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
  })
  if (!res.ok) throw new Error(`播客整期音频下载失败 ${res.status}：可重新生成（逐轮音频已丢弃）`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 一次连接的生命周期：建连 → StartSession → 收 360/361/362/363/154 → 152 完成。
 * 完成（resolve）后由调用方决定是否还需要续传；中断/错误一律 reject（retryable 标记决定是否续传）。
 */
function runPodcastSession(
  options: VolcanoPodcastOptions,
  state: PodcastTaskState,
  resume: PodcastResumeInfo | undefined,
  timeoutMs: number,
  log: (message: string) => void
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    // 本连接内的 session id（首连 = task_id；续传是新 session，retry_info 指回原任务）
    const sessionId = randomUUID()
    /** 361 音频帧归属的轮次（由最近的 360 给出）；-2 = 还没见过轮次开始 */
    let currentRound = -2
    let settled = false

    const ws = new WebSocket(PODCAST_WS_URL, {
      headers: {
        'X-Api-Key': options.apiKey,
        'X-Api-Resource-Id': PODCAST_RESOURCE_ID,
        'X-Api-Request-Id': randomUUID()
      }
    })
    ws.binaryType = 'arraybuffer'

    const timer = setTimeout(() => {
      fail(new PodcastAttemptError('本次连接超时（服务端长时间没推帧）', true))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      ws.removeAllListeners()
    }
    const fail = (error: PodcastAttemptError) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        ws.close()
      } catch {
        /* 连接本来就坏了 */
      }
      rejectPromise(error)
    }
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      // 礼貌关闭：FinishConnection → 不等 52 直接关（52 只是回执，音频已齐）
      try {
        ws.send(buildFinishConnectionFrame())
        setTimeout(() => ws.close(), 500).unref()
      } catch {
        /* 已关闭 */
      }
      resolvePromise()
    }
    const onAbort = () => fail(new PodcastAttemptError('已中止', false))

    ws.on('open', () => {
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const payload = buildPodcastSessionPayload(options.request, { ...options.payload, resume })
      log(
        resume
          ? `断点续传：task=${resume.retryTaskId}，从第 ${resume.lastFinishedRoundId + 1} 轮继续`
          : `发起播客合成：${options.request.turns.length} 轮`
      )
      ws.send(buildStartSessionFrame(sessionId, payload))
    })

    ws.on('message', (raw: ArrayBuffer) => {
      let frame
      try {
        frame = parsePodcastFrame(Buffer.from(raw))
      } catch (error) {
        fail(
          new PodcastAttemptError(
            `协议帧解析失败：${error instanceof Error ? error.message : String(error)}`,
            false
          )
        )
        return
      }
      if (frame.kind === 'error') {
        const described = describePodcastError(frame.code, frame.message)
        fail(new PodcastAttemptError(described.text, described.retryable))
        return
      }
      const meta = frame.json ?? {}
      switch (frame.event) {
        case PODCAST_EVENTS.SessionStarted:
          return
        case PODCAST_EVENTS.UsageResponse:
          return
        case PODCAST_EVENTS.PodcastRoundStart: {
          const round = (meta as PodcastRoundMeta).round_id
          currentRound = typeof round === 'number' ? round : currentRound
          if (!state.rounds.has(currentRound)) state.rounds.set(currentRound, [])
          return
        }
        case PODCAST_EVENTS.PodcastRoundResponse: {
          if (frame.payload.length > 0) {
            const bucket = state.rounds.get(currentRound) ?? []
            bucket.push(Buffer.from(frame.payload))
            state.rounds.set(currentRound, bucket)
          }
          return
        }
        case PODCAST_EVENTS.PodcastRoundEnd: {
          const end = meta as PodcastRoundEndMeta
          if (end.is_error) {
            const msg = end.error_msg ?? '本轮合成失败'
            // 内容审核类错误重试也没用（§15.9 显式抛出）；其余轮次错误允许断点续传再试
            const audit = /content filter|risk|audit|风控|审核/i.test(msg)
            fail(
              new PodcastAttemptError(
                audit
                  ? `播客第 ${currentRound} 轮内容审核未通过：请修改该轮文稿后重试（${msg}）`
                  : `播客第 ${currentRound} 轮合成失败：${msg}`,
                !audit
              )
            )
            return
          }
          if (currentRound >= 0) state.lastFinishedRound = Math.max(state.lastFinishedRound, currentRound)
          if (typeof end.audio_duration === 'number') state.durations.set(currentRound, end.audio_duration)
          return
        }
        case PODCAST_EVENTS.PodcastEnd: {
          const info = (meta as { meta_info?: { audio_url?: string } }).meta_info
          if (info?.audio_url) state.audioUrl = info.audio_url
          return
        }
        case PODCAST_EVENTS.SessionFinished: {
          const status = Number((meta as { status_code?: number }).status_code ?? 0)
          if (status === PODCAST_OK_CODE) {
            done()
          } else {
            const described = describePodcastError(
              status,
              String((meta as { message?: string }).message ?? '')
            )
            fail(new PodcastAttemptError(described.text, described.retryable))
          }
          return
        }
        default:
          return
      }
    })

    ws.on('error', (error) => {
      fail(new PodcastAttemptError(`WebSocket 错误：${error.message}`, true))
    })
    ws.on('close', (code, reason) => {
      fail(
        new PodcastAttemptError(
          `连接被关闭（code=${code}${reason.length > 0 ? ` ${reason.toString()}` : ''}）`,
          true
        )
      )
    })
    // 建连阶段的 HTTP 非 200（鉴权失败等）：ws 会先发 unexpected-response
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      res.on('end', () => {
        const auth = res.statusCode === 401 || res.statusCode === 403
        fail(
          new PodcastAttemptError(
            auth
              ? '播客合成鉴权失败：检查火山引擎接入的 API Key（设置 → 语音合成），并确认已开通播客语音合成'
              : `播客合成建连失败 ${res.statusCode}: ${body.slice(0, 200)}`,
            !auth
          )
        )
      })
    })
  })
}
