import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * 虚拟声卡（VB-CABLE）一键安装。
 *
 * 驱动程序没法「在应用里注册」——只能下载官方安装包并提权运行它：
 *   1. 从 vb-audio.com/Cable 解析当前版本的下载地址（文件名带版本号，不硬编码）
 *   2. 下载到临时目录、解压出 VBCABLE_Setup_x64.exe
 *   3. 用 PowerShell Start-Process -Verb RunAs 提权静默安装（-i -h）
 *
 * 这一步会弹 UAC、会在系统里装一个内核音频驱动，所以只由用户在设置里显式点击触发。
 * 装完由渲染层重新枚举输出设备，检测到 CABLE Input 就自动切过去。
 */

const CABLE_PAGE = 'https://vb-audio.com/Cable/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'

function tarBinary(): string {
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'
}

/** 官网安装包地址（文件名 VBCABLE_Driver_Pack45.zip 这类，版本会变） */
async function resolveInstallerUrl(): Promise<string> {
  const response = await fetch(CABLE_PAGE, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`官网打不开（HTTP ${response.status}）`)
  const html = await response.text()
  const match = html.match(
    /https:\/\/download\.vb-audio\.com\/Download_CABLE\/VBCABLE_Driver_Pack\d+\.zip/i
  )
  if (!match) throw new Error('没能从官网解析出下载地址：可以到 vb-audio.com/Cable 手动下载安装')
  return match[0]
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file))
  if (statSync(file).size < 200_000) throw new Error('下载的安装包不完整，请检查网络后重试')
}

/** 在解压目录里找 64 位安装程序（找不到就退回 32 位） */
function findSetup(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findSetup(full)
      if (found) return found
    } else if (/^VBCABLE_Setup_x64\.exe$/i.test(entry.name)) {
      return full
    }
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findSetup(full)
      if (found) return found
    } else if (/^VBCABLE_Setup\.exe$/i.test(entry.name)) {
      return full
    }
  }
  return null
}

/**
 * 安装虚拟声卡。
 * @param zipPath 本地安装包（用户自己下好的 zip）：走这条就不用联网，慢网络下最实用
 * @param pick    让主进程弹文件选择框挑本地安装包
 */
export async function installVirtualCable(
  opts: { zipPath?: string; pick?: boolean } = {}
): Promise<{ ok: boolean; error?: string; canceled?: boolean; source?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: '虚拟声卡安装只支持 Windows' }
  let zipPath = opts.zipPath?.trim() ?? ''
  if (opts.pick && !zipPath) {
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: '选择虚拟声卡安装包',
      properties: ['openFile'],
      filters: [{ name: 'VB-CABLE 安装包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    zipPath = picked.filePaths[0]
  }
  const work = mkdtempSync(join(tmpdir(), 'yuncast-vbcable-'))
  try {
    let zip = zipPath
    let source = 'local'
    if (!zip) {
      // 应用资源里自带安装包就直接用（发布包可以把包放进 resources/virtual-cable/）
      const bundled = findBundledPackage()
      if (bundled) {
        zip = bundled
        source = 'bundled'
      } else {
        const url = await resolveInstallerUrl()
        zip = join(work, 'vbcable.zip')
        await download(url, zip)
        source = 'download'
      }
    }
    if (!existsSync(zip)) throw new Error(`安装包不存在：${zip}`)
    const unpack = join(work, 'unpack')
    mkdirSync(unpack, { recursive: true })
    spawnSync(tarBinary(), ['-xf', zip, '-C', unpack], { windowsHide: true })
    const setup = findSetup(unpack)
    if (!setup) throw new Error('安装包里没找到 VBCABLE_Setup：请到 vb-audio.com/Cable 手动安装')

    // 提权运行（UAC）；-i 安装、-h 静默，装完等它退出再返回
    const quoted = setup.replace(/'/g, "''")
    const script =
      `$p = Start-Process -FilePath '${quoted}' -ArgumentList '-i','-h' -Verb RunAs -Wait -PassThru; ` +
      `Write-Output $p.ExitCode`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 240_000,
      encoding: 'utf8'
    })
    if (result.status !== 0) {
      const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
      if (/canceled|cancelled|取消/i.test(output)) {
        return { ok: false, error: '已取消安装：安装虚拟声卡需要管理员权限' }
      }
      return { ok: false, error: `安装失败：${output.slice(0, 200) || '未知错误'}` }
    }
    return { ok: true, source }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}


/** 发布包里自带的安装包（resources/virtual-cable/*.zip）；开发时也认项目的 resources/ 目录 */
function findBundledPackage(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'virtual-cable'),
    join(process.cwd(), 'resources', 'virtual-cable')
  ]
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue
      const zip = readdirSync(dir).find((name) => /\.zip$/i.test(name))
      if (zip) return join(dir, zip)
    } catch {
      // 目录不可读就跳过
    }
  }
  return null
}
