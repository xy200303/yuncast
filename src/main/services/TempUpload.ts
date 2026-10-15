import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureCloneSample, sampleFormat } from './audio/sampleAudio'

/**
 * 临时文件托管：把本地样本上传到一个匿名临时文件站，换回一个公网直链。
 *
 * 为什么要它：百炼的声音复刻接口只接受**公网可访问的音频 URL**，不接受本地文件直传；
 * 而"先去某个图床/网盘上传再回来粘贴地址"对用户来说太绕，这里一键传完自动填地址。
 *
 * 选型（2026-10-12 真机实测，匿名、免注册、上传即回直链）：
 * - litterbox.catbox.moe：临时（1h/12h/24h/72h 可选），实测 200 audio/mpeg、字节数一致 ✅
 * - uguu.se：临时 3h，实测同上 ✅
 * - 0x0.st：官方已关闭上传（"uploads disabled"）✗；tmpfiles.org：无响应 ✗
 *
 * 注意：这是把**用户的录音样本**传到第三方，属于隐私决定——所以只在用户点按钮时发生，
 * 界面上要写清楚"临时寄存在第三方文件站、多久失效"，绝不自动后台上传。
 */

export interface TempUploadResult {
  ok: boolean
  url?: string
  /** 托管方名字（展示用） */
  provider?: string
  /** 有效期描述（展示用） */
  expiresIn?: string
  /** 上传前为了兼容复刻接口做过转码（webm → mp3） */
  converted?: boolean
  error?: string
}

/** 百炼复刻的音频要求：≤10MB，建议 10-20 秒（格式统一在 sampleAudio 里归一） */
const MAX_BYTES = 10 * 1024 * 1024

interface Provider {
  name: string
  expiresIn: string
  upload: (file: Buffer, fileName: string, mime: string) => Promise<string>
}

function mimeOf(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.aac') return 'audio/aac'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.webm') return 'audio/webm'
  return 'application/octet-stream'
}

/**
 * 单个托管方的超时：连不上就尽快失败（国内网络下 IPv6 黑洞会让请求挂在 SYN_SENT 很久，
 * 用户只看到按钮转圈）。主进程已设 dns ipv4first（见 main/index.ts），这里再把上限收住。
 */
const UPLOAD_TIMEOUT_MS = 25_000

async function postForm(url: string, form: FormData): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/timeout|abort/i.test(reason)) throw new Error(`连接超时（${UPLOAD_TIMEOUT_MS / 1000} 秒）`)
    throw new Error(`连不上：${reason.slice(0, 120)}`)
  }
  const text = (await res.text()).trim()
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 140)}`)
  return text
}

const PROVIDERS: Provider[] = [
  {
    name: 'litterbox（临时文件站）',
    expiresIn: '1 小时',
    upload: async (file, fileName, mime) => {
      const form = new FormData()
      form.append('reqtype', 'fileupload')
      form.append('time', '1h')
      form.append('fileToUpload', new Blob([new Uint8Array(file)], { type: mime }), fileName)
      const out = await postForm('https://litterbox.catbox.moe/resources/internals/api.php', form)
      if (!/^https?:\/\//.test(out)) throw new Error(out.slice(0, 160) || '没有返回地址')
      return out
    }
  },
  {
    name: 'uguu.se（临时文件站）',
    expiresIn: '3 小时',
    upload: async (file, fileName, mime) => {
      const form = new FormData()
      form.append('files[]', new Blob([new Uint8Array(file)], { type: mime }), fileName)
      const out = await postForm('https://uguu.se/upload.php?output=text', form)
      if (!/^https?:\/\//.test(out)) throw new Error(out.slice(0, 160) || '没有返回地址')
      return out
    }
  }
]

export class TempUploadService {
  /** 上传本地文件换公网直链；逐个试候选托管方，全失败则把每个的原因拼起来返回 */
  async upload(filePath: string): Promise<TempUploadResult> {
    let file: Buffer
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return { ok: false, error: `不是一个文件：${filePath}` }
      if (info.size > MAX_BYTES) {
        return {
          ok: false,
          error: `样本 ${(info.size / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限：百炼复刻只收 10-20 秒的短样本`
        }
      }
      file = await readFile(filePath)
    } catch (error) {
      return {
        ok: false,
        error: `读不到样本文件：${error instanceof Error ? error.message : String(error)}`
      }
    }

    // 复刻接口只收 WAV/MP3/M4A：录出来的 webm 之类先转成 mp3 再上传，用户不用管格式
    let uploadPath = filePath
    let uploadFile = file
    if (!['mp3', 'wav', 'm4a'].includes(sampleFormat(filePath))) {
      const prepared = await ensureCloneSample(filePath, join(tmpdir(), 'yuncast-upload'))
      if (!prepared.ok || !prepared.path) {
        return { ok: false, error: prepared.error ?? '样本转码失败' }
      }
      uploadPath = prepared.path
      uploadFile = await readFile(prepared.path)
    }

    const fileName = basename(uploadPath)
    const mime = mimeOf(fileName)

    const failures: string[] = []
    for (const provider of PROVIDERS) {
      try {
        const url = await provider.upload(uploadFile, fileName, mime)
        return {
          ok: true,
          url,
          provider: provider.name,
          expiresIn: provider.expiresIn,
          converted: uploadPath !== filePath
        }
      } catch (error) {
        failures.push(`${provider.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      ok: false,
      error: `临时文件站都连不上（国内网络常见）——${failures.join('；')}。可以自己把样本传到任意可公网访问的地址后粘贴`
    }
  }
}
