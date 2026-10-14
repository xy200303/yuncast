/**
 * 火山 PodcastAPI 协议编解码 + 播客请求纯函数的离线自检（无真实密钥时的验证手段）。
 * 跑法：npm run selfcheck:podcast（esbuild 打包后 node 执行；不动 dev server）。
 * 覆盖：帧构造/解析往返、错误帧与中文映射、session payload（action=3 / retry_info / speaker_additions）、
 * 请求前校验（§15.9）、轮次稿拆分与角色组装。覆盖不了：真实握手、事件时序、断点续传的服务端行为。
 */
import {
  PODCAST_EVENTS,
  PODCAST_OK_CODE,
  buildFinishConnectionFrame,
  buildPodcastSessionPayload,
  buildStartSessionFrame,
  describePodcastError,
  parsePodcastFrame
} from '../src/main/services/providers/tts/podcastProtocol'
import { buildPodcastTurns, splitPodcastTurnText, validatePodcastRequest } from '../src/shared/podcast'
import type { TtsModelCapabilities, TtsSynthesisRequest } from '../src/shared/types'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`)
  }
}

/** 模拟服务端下行帧（事件号 + session_id + payload） */
function downlink(event: number, sessionId: string, payload: Buffer, audio = false): Buffer {
  const session = Buffer.from(sessionId, 'utf8')
  const head = Buffer.from([0x11, audio ? 0xb4 : 0x94, 0x10, 0])
  const u32 = (v: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v, 0)
    return b
  }
  return Buffer.concat([head, u32(event), u32(session.length), session, u32(payload.length), payload])
}

const CAPS: TtsModelCapabilities = {
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

const SPK: [string, string] = ['zh_male_dayixiansheng_v2_saturn_bigtts', 'zh_female_mizaitongxue_v2_saturn_bigtts']
const REQ: Extract<TtsSynthesisRequest, { type: 'podcast' }> = {
  type: 'podcast',
  turns: [
    { speaker: SPK[0], text: '今天我们聊聊 AI 语音直播。' },
    { speaker: SPK[1], text: '最近实时互动确实很热。' }
  ],
  speakers: SPK,
  useHeadMusic: true,
  useTailMusic: false
}

console.log('— 帧编解码 —')
{
  const sessionId = 'session-abc-123'
  const payload = { action: 3, use_head_music: true }
  const frame = parsePodcastFrame(buildStartSessionFrame(sessionId, payload))
  check('StartSession 往返：kind=event', frame.kind === 'event')
  if (frame.kind === 'event') {
    check('StartSession 往返：event=100', frame.event === PODCAST_EVENTS.StartSession, frame.event)
    check('StartSession 往返：sessionId', frame.sessionId === sessionId, frame.sessionId)
    check('StartSession 往返：payload', JSON.stringify(frame.json) === JSON.stringify(payload), frame.json)
  }

  const fin = buildFinishConnectionFrame()
  check('FinishConnection：帧头 0x11/0x94', fin[0] === 0x11 && fin[1] === 0x94)
  check('FinishConnection：event=2', fin.readUInt32BE(4) === PODCAST_EVENTS.FinishConnection)
  check('FinishConnection：payload={}', fin.subarray(12).toString('utf8') === '{}')

  const audioFrame = parsePodcastFrame(downlink(PODCAST_EVENTS.PodcastRoundResponse, sessionId, Buffer.from([1, 2, 3, 254]), true))
  check('361 音频帧：原样保留二进制', audioFrame.kind === 'event' && Buffer.compare(audioFrame.payload, Buffer.from([1, 2, 3, 254])) === 0)

  const metaFrame = parsePodcastFrame(
    downlink(PODCAST_EVENTS.PodcastRoundStart, sessionId, Buffer.from(JSON.stringify({ round_id: 2, speaker: SPK[0] }), 'utf8'))
  )
  check('360 元数据帧：json.round_id=2', metaFrame.kind === 'event' && (metaFrame.json as { round_id?: number })?.round_id === 2)

  const finFrame = parsePodcastFrame(
    downlink(PODCAST_EVENTS.SessionFinished, sessionId, Buffer.from(JSON.stringify({ status_code: PODCAST_OK_CODE, message: 'ok' }), 'utf8'))
  )
  check('152 完成帧：status_code 可解析', finFrame.kind === 'event' && (finFrame.json as { status_code?: number })?.status_code === PODCAST_OK_CODE)
}

console.log('— 错误帧与中文映射 —')
{
  const errorBytes = (code: number, message: string) =>
    Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x10, 0]),
      (() => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(code, 0)
        return b
      })(),
      Buffer.from(JSON.stringify({ message }), 'utf8')
    ])
  const err = parsePodcastFrame(errorBytes(45000000, 'quota exceeded for types: concurrency'))
  check('错误帧：kind=error + code', err.kind === 'error' && err.code === 45000000, err)
  if (err.kind === 'error') check('错误帧：message 解出', err.message.includes('quota exceeded'), err.message)

  check('45000000 → 配额不足（不重试）', (() => { const d = describePodcastError(45000000, 'quota'); return !d.retryable && d.text.includes('配额不足') })())
  check('40000022 → 内容审核（不重试）', (() => { const d = describePodcastError(40000022, 'IllegalPayload:TextRiskAuditFailed'); return !d.retryable && d.text.includes('审核') })())
  check('50302102 content filter → 审核（不重试）', (() => { const d = describePodcastError(50302102, 'NLP RespError: content filter'); return !d.retryable && d.text.includes('审核') })())
  check('50302102 content length → 超长（不重试）', (() => { const d = describePodcastError(50302102, 'NLP RespError: content length'); return !d.retryable && d.text.includes('上下文限制') })())
  check('55000000 → 服务端错误（可续传）', (() => { const d = describePodcastError(55000000, 'server error'); return d.retryable })())
}

console.log('— session payload（action=3） —')
{
  const plain = buildPodcastSessionPayload(REQ, { format: 'mp3', sampleRate: 24000, speechRate: 0 })
  check('action=3', plain.action === 3)
  check('nlp_texts 轮次映射', JSON.stringify(plain.nlp_texts) === JSON.stringify(REQ.turns.map((t) => ({ speaker: t.speaker, text: t.text }))))
  check('use_head_music / use_tail_music', plain.use_head_music === true && plain.use_tail_music === false)
  check('audio_config', JSON.stringify(plain.audio_config) === JSON.stringify({ format: 'mp3', sample_rate: 24000, speech_rate: 0 }))
  check('speaker_info 固定顺序双人', JSON.stringify((plain.speaker_info as { speakers: string[] }).speakers) === JSON.stringify(SPK) && (plain.speaker_info as { random_order: boolean }).random_order === false)
  check('return_audio_url 打开', (plain.input_info as { return_audio_url: boolean }).return_audio_url === true)
  check('无 retry_info', plain.retry_info === undefined)

  const resumed = buildPodcastSessionPayload(REQ, {
    format: 'mp3',
    sampleRate: 24000,
    speechRate: 10,
    speakerAdditions: { [SPK[0]]: '{"model":"seed-tts-2.0-standard"}' },
    resume: { retryTaskId: 'task-1', lastFinishedRoundId: 5 }
  })
  check('retry_info 断点续传', JSON.stringify(resumed.retry_info) === JSON.stringify({ retry_task_id: 'task-1', last_finished_round_id: 5 }), resumed.retry_info)
  check('speaker_additions 透传', JSON.stringify((resumed.speaker_info as { speaker_additions?: unknown }).speaker_additions) === JSON.stringify({ [SPK[0]]: '{"model":"seed-tts-2.0-standard"}' }))
}

console.log('— 请求前校验（§15.9） —')
{
  check('正常轮次稿通过', validatePodcastRequest(REQ, CAPS) === null)
  check('空轮次稿拦截', validatePodcastRequest({ ...REQ, turns: [] }, CAPS)?.includes('空') === true)
  check('三个发音人拦截', validatePodcastRequest({ ...REQ, speakers: ['a', 'b'] as [string, string], turns: [{ speaker: 'c', text: 'x' }] }, CAPS)?.includes('不在两个主持人里') === true)
  check('发音人重复拦截', validatePodcastRequest({ ...REQ, speakers: [SPK[0], SPK[0]] }, CAPS)?.includes('恰好 2 个不同的发音人') === true)
  const longTurn = '字'.repeat(301)
  check('单轮超 300 字拦截', validatePodcastRequest({ ...REQ, turns: [{ speaker: SPK[0], text: longTurn }] }, CAPS)?.includes('单轮上限') === true)
  const manyTurns = Array.from({ length: 40 }, () => ({ speaker: SPK[0], text: '字'.repeat(300) }))
  check('总文本超 10000 字拦截', validatePodcastRequest({ ...REQ, turns: manyTurns }, CAPS)?.includes('模型上限') === true)
}

console.log('— 轮次稿拆分与组装 —')
{
  check('短文本不拆', splitPodcastTurnText('你好。', 300).length === 1)
  const long = `${'一'.repeat(200)}。${'二'.repeat(200)}。${'三'.repeat(100)}`
  const parts = splitPodcastTurnText(long, 300)
  check('长文本按句号拆', parts.length === 3 && parts.every((p) => p.length <= 300), parts.map((p) => p.length))
  check('拆分不丢字', parts.join('') === long)
  const noPunct = '字'.repeat(700)
  const hard = splitPodcastTurnText(noPunct, 300)
  check('无标点硬切且不超上限', hard.length === 3 && hard.every((p) => p.length <= 300) && hard.join('') === noPunct)

  const lines = [
    { voiceId: 'voiceA', text: 'A 说第一句。' },
    { voiceId: '', text: '没标角色，轮到 B。' },
    { voiceId: 'voiceB', text: 'B 明确说。' },
    { voiceId: '', text: '又没标，轮到 A。' }
  ]
  const turns = buildPodcastTurns(lines, ['voiceA', 'voiceB'], ['spk-a', 'spk-b'], 300)
  check(
    '角色匹配 + 未标交替',
    turns !== null && turns.map((t) => t.speaker).join(',') === 'spk-a,spk-b,spk-b,spk-a',
    turns?.map((t) => t.speaker)
  )
  check('第三种音色拒绝（§6.4）', buildPodcastTurns([{ voiceId: 'voiceC', text: '第三人' }], ['voiceA', 'voiceB'], ['spk-a', 'spk-b'], 300) === null)
  const cloneResolved = buildPodcastTurns([{ voiceId: 'spk-a', text: '直接写 speaker id 也认' }], ['voiceA', 'voiceB'], ['spk-a', 'spk-b'], 300)
  check('speaker id 直接命中', cloneResolved !== null && cloneResolved[0].speaker === 'spk-a')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
