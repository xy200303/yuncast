/**
 * 段落音频切分：整段合成出来的 PCM 按句界切回条目粒度。
 *
 * 两条定位句界的路：
 * - 火山：合成时开字幕/时间戳，句界是模型给的精确值（cutsFromSentenceBounds）
 * - 百炼：接口不给时间戳，用静音检测找句间停顿（cutsFromSilence），
 *   找到的停顿数对不上句数就抛错，调用方整段放弃、回退逐条合成——绝不硬切错。
 *
 * 切片统一写成 wav（s16le 48k 单声道）：免二次压缩损失，AudioPipeline 的 ffmpeg 直接解。
 */

const SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2
/** 静音分析帧长：20ms */
const FRAME_MS = 20
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000

/** 句间停顿至少要这么长才当句界（逗号级别的停顿通常 <150ms，句末一般 300ms+） */
const MIN_GAP_MS = 200
/** 音频首尾保护带：太靠边的"停顿"是起收气口，不是句界 */
const EDGE_GUARD_MS = 300

export interface SentenceBound {
  /** 秒，相对整段音频开头 */
  start: number
  end: number
}

/** PCM → wav（44 字节 RIFF 头 + 数据） */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 火山字幕句界 → 条目切点（采样点）。
 * bounds 是逐句的起止秒数；每个条目的切点取"上句结束与下句开始的中间"，
 * 让句间停顿一边一半，切口落在静音里。
 * 句数对不上（模型分句和我们的不一样）直接抛错。
 */
export function cutsFromSentenceBounds(
  bounds: SentenceBound[],
  perItemSentences: number[]
): number[] {
  const total = perItemSentences.reduce((sum, n) => sum + n, 0)
  if (bounds.length !== total) {
    throw new Error(`段落字幕句数对不上（文本 ${total} 句，返回 ${bounds.length} 句），放弃整段合成`)
  }
  const cuts: number[] = []
  let consumed = 0
  for (let i = 0; i < perItemSentences.length - 1; i++) {
    consumed += perItemSentences[i]
    const endOfLast = bounds[consumed - 1].end
    const startOfNext = bounds[consumed].start
    cuts.push(Math.round(((endOfLast + startOfNext) / 2) * SAMPLE_RATE))
  }
  return cuts
}

/**
 * 静音检测 → 条目切点（采样点）。
 * 需要 totalSentences-1 个句界：找出的停顿段数必须精确等于它（多取最强 N-1 个）；
 * 不够就抛错回退。逗号停顿可能混入，所以候选多于需要时取时长最长的前 N-1 个再按位置排序。
 */
export function cutsFromSilence(pcm: Buffer, perItemSentences: number[]): number[] {
  const totalSentences = perItemSentences.reduce((sum, n) => sum + n, 0)
  const neededSentenceCuts = totalSentences - 1
  const frameCount = Math.floor(pcm.length / (FRAME_SAMPLES * BYTES_PER_SAMPLE))
  if (frameCount === 0) throw new Error('段落音频为空，放弃整段合成')

  // 逐帧 RMS；静音阈值取峰值的 1.5%（合成语音底噪接近数字零，阈值很干净）
  const rms = new Float64Array(frameCount)
  let peak = 0
  for (let f = 0; f < frameCount; f++) {
    let sum = 0
    const base = f * FRAME_SAMPLES * BYTES_PER_SAMPLE
    for (let s = 0; s < FRAME_SAMPLES; s++) {
      const v = pcm.readInt16LE(base + s * BYTES_PER_SAMPLE)
      sum += v * v
    }
    rms[f] = Math.sqrt(sum / FRAME_SAMPLES)
    if (rms[f] > peak) peak = rms[f]
  }
  const threshold = Math.max(120, peak * 0.015)
  const minGapFrames = Math.round(MIN_GAP_MS / FRAME_MS)
  const guardFrames = Math.round(EDGE_GUARD_MS / FRAME_MS)

  const gaps: { midFrame: number; frames: number }[] = []
  let run = 0
  for (let f = 0; f < frameCount; f++) {
    if (rms[f] < threshold) {
      run++
    } else {
      if (run >= minGapFrames && f - run > guardFrames && f < frameCount - guardFrames) {
        gaps.push({ midFrame: f - Math.floor(run / 2), frames: run })
      }
      run = 0
    }
  }

  if (gaps.length < neededSentenceCuts) {
    throw new Error(
      `句间停顿数对不上（文本 ${totalSentences} 句需 ${neededSentenceCuts} 处停顿，只找到 ${gaps.length} 处），放弃整段合成`
    )
  }
  const chosen = [...gaps]
    .sort((a, b) => b.frames - a.frames)
    .slice(0, neededSentenceCuts)
    .map((gap) => gap.midFrame * FRAME_SAMPLES)
    .sort((a, b) => a - b)

  // 句界 → 条目切点：每个条目吃掉自己的句数，边界句之间的切点就是条目切点
  const cuts: number[] = []
  let consumed = 0
  for (let i = 0; i < perItemSentences.length - 1; i++) {
    consumed += perItemSentences[i]
    cuts.push(chosen[consumed - 1])
  }
  return cuts
}

/** 按切点把整段 PCM 切成每条目一片（切点单位：采样点） */
export function slicePcm(pcm: Buffer, cuts: number[], pieces: number): Buffer[] {
  const totalSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  const bounds = [0, ...cuts, totalSamples]
  if (bounds.length !== pieces + 1) {
    throw new Error(`切点数对不上（${cuts.length} 个切点，${pieces} 条），放弃整段合成`)
  }
  const out: Buffer[] = []
  for (let i = 0; i < pieces; i++) {
    const from = bounds[i] * BYTES_PER_SAMPLE
    const to = bounds[i + 1] * BYTES_PER_SAMPLE
    if (to <= from) throw new Error('切点顺序异常，放弃整段合成')
    out.push(pcm.subarray(from, to))
  }
  return out
}
