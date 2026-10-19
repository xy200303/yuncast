import { existsSync } from 'node:fs'
import ffmpegPath from 'ffmpeg-static'

/**
 * 把「依赖里报的路径」换算成「磁盘上真正能执行的那个」。
 *
 * 打包后 `ffmpeg-static` 报的是它在依赖里的位置：
 *   …/resources/app.asar/node_modules/ffmpeg-static/ffmpeg.exe
 * 但 asar 是归档，不是目录，spawn 它只会得到
 *   spawn …\app.asar\node_modules\ffmpeg-static\ffmpeg.exe ENOENT
 * electron-builder 按 asarUnpack 把二进制解到了旁边的 app.asar.unpacked，所以这里换过去。
 * 开发态（node_modules 真实存在）没有 app.asar 段，原样返回。
 */
export function resolveFfmpegPath(raw: string): string {
  return raw.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

let cached: string | null = null

/** FFmpeg 二进制路径：先认解包后的位置，退回原路径，都找不到就抛能看懂的错 */
export function getFfmpegPath(): string {
  if (cached) return cached
  if (!ffmpegPath) throw new Error('ffmpeg 二进制不可用（ffmpeg-static 安装异常，重装应用即可）')
  const raw = ffmpegPath as string
  const unpacked = resolveFfmpegPath(raw)
  for (const candidate of unpacked === raw ? [raw] : [unpacked, raw]) {
    if (existsSync(candidate)) {
      cached = candidate
      return candidate
    }
  }
  throw new Error(`找不到 ffmpeg 可执行文件（试过 ${unpacked}、${raw}）：安装包可能缺 asarUnpack，重装应用`)
}
