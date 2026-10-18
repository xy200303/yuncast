/**
 * 本地声学测量（零依赖）：解码成 16k 单声道 PCM，按帧算能量与基频（自相关）。
 * 用途：声音风格解析的「客观数值」——语速之外再给音高（基频中位数/范围）、发声占比、停顿占比、响度。
 * 数值只用于校准与对比，不直接当 instruction；中文描述仍由音频理解模型给。
 */
import { spawn } from 'node:child_process'
import { getFfmpegPath } from '../stream/ffmpeg/bin'

export interface VoiceMetrics {
  /** 总时长（秒） */
  duration: number
  /** 有效发声时长（秒，扣掉静音帧） */
  speechSeconds: number
  /** 停顿占比 0~1 */
  silenceRatio: number
  /** 平均响度 dBFS（整段非静音帧） */
  meanVolumeDb?: number
  /** 基频中位数 Hz（浊音帧） */
  f0Median?: number
  /** 基频 10 分位 / 90 分位 Hz：看音高范围 */
  f0P10?: number
  f0P90?: number
  /** 浊音帧占比（越高越"实"，越低越气声） */
  voicedRatio: number
  /** 帧能量标准差（dB）：越大起伏越大 */
  energyStd?: number
}

const SAMPLE_RATE = 16000
const FRAME = 640 // 40ms
const HOP = 320 // 20ms
const MIN_LAG = Math.floor(SAMPLE_RATE / 500) // 500Hz
const MAX_LAG = Math.floor(SAMPLE_RATE / 70) // 70Hz

function decodePcm(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      getFfmpegPath(),
      ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) reject(new Error(stderr.slice(0, 200) || 'ffmpeg 解码失败'))
      else resolve(Buffer.concat(chunks))
    })
  })
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[idx]
}

/** 单帧基频：归一化自相关峰值，置信度太低判为清音 */
function frameF0(frame: Float32Array): number | null {
  let energy = 0
  for (const v of frame) energy += v * v
  if (energy / frame.length < 1e-5) return null
  let bestLag = 0
  let bestScore = 0
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let corr = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i + lag < frame.length; i++) {
      corr += frame[i] * frame[i + lag]
      normA += frame[i] * frame[i]
      normB += frame[i + lag] * frame[i + lag]
    }
    const denom = Math.sqrt(normA * normB)
    const score = denom > 0 ? corr / denom : 0
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestScore < 0.35 || bestLag === 0) return null
  return SAMPLE_RATE / bestLag
}

/** 测量一段音频：时长/停顿/响度/基频统计 */
export async function measureVoice(filePath: string): Promise<VoiceMetrics> {
  const pcm = await decodePcm(filePath)
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const frames: Float32Array[] = []
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    const frame = new Float32Array(FRAME)
    for (let i = 0; i < FRAME; i++) frame[i] = samples[start + i] / 32768
    frames.push(frame)
  }
  const duration = samples.length / SAMPLE_RATE
  const rmsList = frames.map((frame) => {
    let sum = 0
    for (const v of frame) sum += v * v
    return Math.sqrt(sum / frame.length)
  })
  const maxRms = Math.max(...rmsList, 1e-9)
  const threshold = Math.max(maxRms * 0.08, 0.003)
  const voicedFrames: Float32Array[] = []
  const energies: number[] = []
  let voicedCount = 0
  frames.forEach((frame, i) => {
    if (rmsList[i] >= threshold) {
      voicedCount++
      voicedFrames.push(frame)
      energies.push(20 * Math.log10(Math.max(rmsList[i], 1e-9)))
    }
  })
  const f0s: number[] = []
  for (const frame of voicedFrames) {
    const f0 = frameF0(frame)
    if (f0) f0s.push(f0)
  }
  f0s.sort((a, b) => a - b)
  const meanEnergy = energies.length > 0 ? energies.reduce((a, b) => a + b, 0) / energies.length : undefined
  const energyStd =
    energies.length > 1 && meanEnergy !== undefined
      ? Math.sqrt(energies.reduce((acc, v) => acc + (v - meanEnergy) ** 2, 0) / energies.length)
      : undefined
  const silenceRatio = frames.length > 0 ? 1 - voicedCount / frames.length : 1
  return {
    duration: Number(duration.toFixed(2)),
    speechSeconds: Number(((1 - silenceRatio) * duration).toFixed(2)),
    silenceRatio: Number(silenceRatio.toFixed(2)),
    meanVolumeDb: meanEnergy !== undefined ? Number(meanEnergy.toFixed(1)) : undefined,
    f0Median: f0s.length > 0 ? Number(percentile(f0s, 0.5).toFixed(1)) : undefined,
    f0P10: f0s.length > 0 ? Number(percentile(f0s, 0.1).toFixed(1)) : undefined,
    f0P90: f0s.length > 0 ? Number(percentile(f0s, 0.9).toFixed(1)) : undefined,
    voicedRatio: frames.length > 0 ? Number((f0s.length / frames.length).toFixed(2)) : 0,
    energyStd: energyStd !== undefined ? Number(energyStd.toFixed(2)) : undefined
  }
}

/** AB 对比的一维差异：值、容差、得分（0~1）、是否达标 */
export interface VoiceMetricDiff {
  key: string
  label: string
  target: number | undefined
  actual: number | undefined
  /** 相对差（actual-target/target，音高类）或绝对差（比例类） */
  delta: number
  tolerance: number
  /** 1 = 完全一致，0 = 差到容差以上 */
  closeness: number
  ok: boolean
  hint: string
}

export interface VoiceComparison {
  /** 0~100：越高越像（加权，容差内的差异算达标） */
  score: number
  verdict: string
  dims: VoiceMetricDiff[]
}

/**
 * 克隆 AB 验收：拿目标样本与克隆合成两套 DSP 指标做逐维对比。
 * 只用本地测量（不看模型描述），所以可重复、可回归——用来回答"这次复刻到底像不像"。
 * 权重按"听感上最容易露馅的程度"排：音高中心 > 语速 > 气声/音高范围 > 起伏 > 停顿。
 */
export function compareVoiceMetrics(
  target: Partial<VoiceMetrics> & { charsPerSec?: number },
  probe: Partial<VoiceMetrics> & { charsPerSec?: number },
  targetCps?: number
): VoiceComparison {
  const pct = (actual?: number, want?: number): number => {
    if (!actual || !want) return 0
    return (actual - want) / want
  }
  const abs = (actual?: number, want?: number): number => {
    if (actual === undefined || want === undefined) return 0
    return actual - want
  }
  const dim = (
    key: string,
    label: string,
    t: number | undefined,
    a: number | undefined,
    tolerance: number,
    delta: number,
    hint: string
  ): VoiceMetricDiff => {
    if (t === undefined || a === undefined) {
      return { key, label, target: t, actual: a, delta: 0, tolerance, closeness: 0.5, ok: false, hint: '无法测量' }
    }
    // 分段曲线：容差内 0.75~1.0（达标就是好），超出后线性掉到 0（2 倍容差处约 0.25）
    const used = Math.abs(delta) / tolerance
    const closeness = used <= 1 ? 0.75 + 0.25 * (1 - used) : Math.max(0, 0.75 - 0.5 * (used - 1))
    return { key, label, target: t, actual: a, delta, tolerance, closeness, ok: Math.abs(delta) <= tolerance, hint }
  }

  const dims: VoiceMetricDiff[] = [
    dim(
      'f0',
      '音高中心',
      target.f0Median,
      probe.f0Median,
      0.08,
      pct(probe.f0Median, target.f0Median),
      '克隆整体偏高/偏低：可用 pitch 微调，或换更贴近的音色'
    ),
    dim(
      'cps',
      '语速',
      targetCps,
      probe.charsPerSec,
      0.08,
      pct(probe.charsPerSec, targetCps),
      '语速偏快/偏慢：调 rate（1 是音色本速）'
    ),
    dim(
      'voiced',
      '气声比例',
      target.voicedRatio,
      probe.voicedRatio,
      0.08,
      abs(probe.voicedRatio, target.voicedRatio),
      '浊音占比偏低 = 气声过多（或反之）：调音色指令里的气声描述'
    ),
    dim(
      'range',
      '音高范围',
      target.f0P90 && target.f0P10 ? target.f0P90 / target.f0P10 : undefined,
      probe.f0P90 && probe.f0P10 ? probe.f0P90 / probe.f0P10 : undefined,
      0.12,
      pct(
        probe.f0P90 && probe.f0P10 ? probe.f0P90 / probe.f0P10 : undefined,
        target.f0P90 && target.f0P10 ? target.f0P90 / target.f0P10 : undefined
      ),
      '起伏范围差：靠情绪标记 <cot> 和重音位置补'
    ),
    dim(
      'energy',
      '情绪起伏',
      target.energyStd,
      probe.energyStd,
      2.5,
      abs(probe.energyStd, target.energyStd),
      '起伏不足/过头：演出强度按 emotion 或 delivery 描述调'
    ),
    dim(
      'silence',
      '停顿占比',
      target.silenceRatio,
      probe.silenceRatio,
      0.06,
      abs(probe.silenceRatio, target.silenceRatio),
      '停顿多少：正文里用 <pause> 控制，别靠 rate'
    )
  ]

  const weights: Record<string, number> = { f0: 0.3, cps: 0.22, voiced: 0.16, range: 0.12, energy: 0.12, silence: 0.08 }
  let score = 0
  for (const d of dims) score += (weights[d.key] ?? 0) * d.closeness
  const normalized = Math.round(score * 100)
  const bad = dims.filter((d) => !d.ok)
  const verdict =
    normalized >= 85
      ? '很像，可以直接用'
      : normalized >= 70
        ? `基本像，还差：${bad.map((d) => d.label).join('、')}`
        : `偏差明显，重点看：${bad.map((d) => d.label).join('、')}`
  return { score: normalized, verdict, dims }
}
