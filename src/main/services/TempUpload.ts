import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

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
  error?: string
}

/** 百炼复刻的音频要求：WAV(16bit)/MP3/M4A，≤10MB，建议 10-20 秒 */
const ALLOWED_EXT = ['.mp3', '.wav', '.m4a', '.mp4', '.aac', '.ogg', '.flac', '.webm']
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

async function postForm(url: string, form: FormData): Promise<string> {
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(90_000) })
  const text = (await res.text()).trim()
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`)
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

    const fileName = basename(filePath)
    const ext = extname(fileName).toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
      return {
        ok: false,
        error: `不支持的样本格式 ${ext || '（无扩展名）'}：百炼复刻收 WAV(16bit) / MP3 / M4A`
      }
    }
    const mime = mimeOf(fileName)

    const failures: string[] = []
    for (const provider of PROVIDERS) {
      try {
        const url = await provider.upload(file, fileName, mime)
        return { ok: true, url, provider: provider.name, expiresIn: provider.expiresIn }
      } catch (error) {
        failures.push(`${provider.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: false, error: `临时上传都失败了——${failures.join('；')}` }
  }
}
