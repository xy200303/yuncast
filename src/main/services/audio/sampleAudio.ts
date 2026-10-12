import { spawn } from 'node:child_process'
import { extname, join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { getFfmpegPath } from '../stream/ffmpeg/bin'

/**
 * 复刻样本的格式归一。
 *
 * 两家的复刻接口都不收浏览器录出来的 webm：
 * - 火山 V3 声音复刻：wav / mp3 / ogg / m4a / aac / pcm
 * - 百炼 voice-enrollment：WAV(16bit) / MP3 / M4A
 * 取交集就是 mp3 / wav / m4a。录出来的 webm（以及 flac / opus）在这里统一转成 mp3，
 * 用户不用关心格式——这也是"点了提交/上传就该成功"的前提。
 */

/** 两家都收的格式（不用转） */
const ACCEPTED = new Set(['mp3', 'wav', 'm4a'])

export function sampleFormat(filePath: string): string {
  return extname(filePath).replace('.', '').toLowerCase()
}

export function isCloneReadyFormat(filePath: string): boolean {
  return ACCEPTED.has(sampleFormat(filePath))
}

export interface PreparedSample {
  ok: boolean
  /** 可以直接交给复刻接口 / 上传的文件路径（转换过就是 mp3） */
  path?: string
  converted?: boolean
  error?: string
}

/**
 * 确保样本是复刻接口能吃的格式：能直接用就原样返回；否则用 ffmpeg 转成 24kHz 单声道 mp3。
 * outDir 用来放转码产物（音色样本目录 / 临时目录皆可）。
 */
export async function ensureCloneSample(filePath: string, outDir: string): Promise<PreparedSample> {
  if (isCloneReadyFormat(filePath)) return { ok: true, path: filePath, converted: false }
  const source = sampleFormat(filePath) || '未知格式'
  await mkdir(outDir, { recursive: true }).catch(() => undefined)
  const outPath = join(outDir, `converted-${Date.now()}.mp3`)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '24000',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '128k',
    outPath
  ]
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (error) => resolve({ code: -1, stderr: String(error) }))
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
  if (result.code !== 0) {
    await rm(outPath, { force: true }).catch(() => undefined)
    return {
      ok: false,
      error: `样本格式 ${source} 需要转成 mp3 但转码失败：${result.stderr.trim().split('\n').slice(-2).join(' ') || `ffmpeg 退出码 ${result.code}`}`
    }
  }
  return { ok: true, path: outPath, converted: true }
}
