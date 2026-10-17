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
