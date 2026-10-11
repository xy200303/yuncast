/**
 * 测试入口（被 scripts/test-revise.mjs 打包执行）。
 * 用一个假 TTS 记录"合成时看到的文本"，验证修订链路。
 */
import { StorageService } from '../src/main/services/StorageService'
import { SpeechPool } from '../src/main/services/SpeechPool'
import { join } from 'node:path'

interface SynthCall {
  id: string
  text: string
}

function makeStubs(work: string) {
  const calls: SynthCall[] = []
  let delayMs = 0
  const tts = {
    async synthesize(id: string, text: string, _voice?: string, signal?: AbortSignal): Promise<string> {
      calls.push({ id, text })
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      if (signal?.aborted) throw new Error('aborted')
      const file = join(work, `${id}-${calls.length}.mp3`)
      return file
    },
    providerIsBailian: () => false,
    outputExtension: () => 'mp3' as const,
    audioCacheDir: () => work
  }
  return {
    tts,
    calls,
    setDelay: (ms: number) => {
      delayMs = ms
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function run(work: string): Promise<{ name: string; ok: boolean; detail?: string }[]> {
  const results: { name: string; ok: boolean; detail?: string }[] = []
  const push = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail })

  const storage = new StorageService()
  const stub = makeStubs(work)
  const pool = new SpeechPool(storage, stub.tts as never, () => undefined)

  // 场景条目（预合成类型）
  const scene = pool.say({ text: '库存还有 500 件', sourceKind: 'scene' })
  await sleep(120)
  const afterFirst = pool.getStatus()
  void afterFirst
  const readyScene = storage.speechGet(scene.id)
  push('场景条目完成预合成', readyScene?.status === 'ready' && !!readyScene.audioPath, `status=${readyScene?.status}`)
  push(
    '合成为原始文本',
    stub.calls.some((c) => c.id === scene.id && c.text === '库存还有 500 件'),
    JSON.stringify(stub.calls)
  )

  // 1) 预合成条目 revise → 回 pending 后重新合成新文本
  const beforeCalls = stub.calls.length
  pool.revise(scene.id, '库存只剩 30 件了')
  const mid = storage.speechGet(scene.id)
  push('修订后立即无效化旧音频', mid?.audioPath === undefined || mid?.status !== 'ready', `status=${mid?.status}`)
  await sleep(250)
  const after = storage.speechGet(scene.id)
  push('修订后重新合成完成', after?.status === 'ready' && !!after.audioPath, `status=${after?.status}`)
  push('重合成用的是新文本', stub.calls.length > beforeCalls && stub.calls[stub.calls.length - 1].text === '库存只剩 30 件了', JSON.stringify(stub.calls.slice(beforeCalls)))

  // 2) 合成期间修订（竞态）：旧合成返回时文本已变 → 必须作废重来
  stub.setDelay(150)
  const race = pool.say({ text: '第一版报价 199', sourceKind: 'scene' })
  await sleep(30) // 让合成开始
  pool.revise(race.id, '第二版报价 179')
  await sleep(600)
  stub.setDelay(0)
  const raceFinal = storage.speechGet(race.id)
  const raceCalls = stub.calls.filter((c) => c.id === race.id).map((c) => c.text)
  push('竞态：最终状态 ready', raceFinal?.status === 'ready', `status=${raceFinal?.status}`)
  push(
    '竞态：最终文本为新版且发生过重合成',
    raceFinal?.text === '第二版报价 179' && raceCalls.includes('第二版报价 179'),
    JSON.stringify(raceCalls)
  )

  // 3) 流式条目（realtime 开启）revise → 直接 ready，不触发合成
  storage.setConfig({ tts: { realtime: true } })
  const streamItem = pool.insertNext({ text: '@桃子：一套 199', sourceKind: 'reply' })
  await sleep(120)
  const streamReady = storage.speechGet(streamItem.id)
  push('实时模式下回复条目标 stream', streamReady?.status === 'ready' && streamReady.stream === true, `status=${streamReady?.status} stream=${streamReady?.stream}`)
  const beforeStreamCalls = stub.calls.filter((c) => c.id === streamItem.id).length
  pool.revise(streamItem.id, '@桃子：一套 179')
  await sleep(120)
  const streamAfter = storage.speechGet(streamItem.id)
  const afterStreamCalls = stub.calls.filter((c) => c.id === streamItem.id).length
  push(
    '流式条目修订后直接 ready 且不重合成',
    streamAfter?.status === 'ready' && streamAfter.text === '@桃子：一套 179' && afterStreamCalls === beforeStreamCalls,
    `status=${streamAfter?.status} text=${streamAfter?.text} calls=${afterStreamCalls}`
  )

  // 4) 已播条目拒绝修订
  storage.speechUpdate(streamItem.id, { status: 'playing' })
  let refused = false
  try {
    pool.revise(streamItem.id, '不该生效')
  } catch {
    refused = true
  }
  push('playing 条目拒绝修订', refused)

  return results
}
