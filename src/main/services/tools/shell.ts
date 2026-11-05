import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/**
 * 命令执行工具：让导演能像在终端里一样处理项目目录里的东西（转码、批量改名、pdftotext、python 脚本…）。
 *
 * 边界（护栏，不是沙箱）：
 * - 工作目录锁定在项目根目录内（cwd 只能是项目目录或它的子目录）
 * - 非交互执行（stdin 关闭）、有超时、输出有上限，超时杀整个进程树
 * - 平台适配：Windows 走 PowerShell（UTF-8 输出），macOS/Linux 走 /bin/sh
 * - 明显破坏性的命令直接拒绝（删根、格式化、关机…），其余交给系统权限
 */

const DEFAULT_TIMEOUT_SEC = 60
const MAX_TIMEOUT_SEC = 600
const MAX_OUTPUT = 200_000

/** 明显不该由主播执行的命令：只做第一道护栏，不假装是沙箱 */
const DENY_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME)\s*$/i,
  /\brm\s+-rf\s+\/(\s|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+delete\s+hklm/i,
  /\bdel\s+\/[sq]\s+[a-z]:\\/i,
  /\bRemove-Item\b.*-Recurse.*\b(C:\\|~|\$HOME)\b/i
]

function resolveCwd(rawRoot: string, cwd?: string): string | { error: string } {
  const root = resolve(rawRoot)
  const target = cwd?.trim() ? resolve(root, cwd.trim()) : root
  if (target !== root && !target.startsWith(root + sep)) {
    return { error: `cwd 只能指向项目目录内部：${root}` }
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) return { error: `目录不存在：${target}` }
  return target
}

function buildInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // PowerShell：把控制台输出编码钉成 UTF-8，中文/emoji 才不变成乱码
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; ${command}`
      ]
    }
  }
  return { file: '/bin/sh', args: ['-lc', command] }
}

/** 正在跑的命例子进程：暂停/急停/中断生成时统一掐掉，别让工具在后台继续跑 */
const runningCommands = new Set<ChildProcess>()

export function killRunningCommands(): void {
  for (const child of runningCommands) killTree(child)
  runningCommands.clear()
}

/** 超时杀整棵进程树：npm/python 这类会再拉起子进程，只杀父进程会留下孤儿 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      // 落到下面的 kill
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 已经退出
  }
}

/**
 * 控制台字节解码：优先 UTF-8，失败再按 GBK（中文 Windows 上 curl/dir 这类老工具仍按系统代码页输出）。
 * 直接用 utf8 解码会把「状态码」变成「״̬??」这种乱码。
 */
function decodeChunk(chunk: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(chunk)
  } catch {
    try {
      return new TextDecoder('gbk').decode(chunk)
    } catch {
      return chunk.toString('utf8')
    }
  }
}

function formatResult(input: {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
}): string {
  const status = input.timedOut
    ? `超时被终止（上限 ${Math.round(input.durationMs / 1000)}s）`
    : input.signal
      ? `被信号 ${input.signal} 终止`
      : `退出码 ${input.code ?? '未知'}`
  const parts = [`[${status} · ${(input.durationMs / 1000).toFixed(1)}s]`]
  if (input.stdout.trim()) parts.push(`stdout:\n${input.stdout.trimEnd()}`)
  if (input.stderr.trim()) parts.push(`stderr:\n${input.stderr.trimEnd()}`)
  if (!input.stdout.trim() && !input.stderr.trim()) parts.push('（没有任何输出）')
  if (input.truncated) parts.push('（输出超过上限，已截断）')
  return parts.join('\n\n')
}

function run(ctx: ToolCtx, params: { command: string; cwd?: string; timeoutSec?: number }): Promise<string> {
  const root = ctx.projectRoot?.()
  if (!root) return Promise.resolve('还没有打开项目：命令只在项目目录里执行，先在界面打开一个项目')
  const command = params.command.trim()
  if (!command) return Promise.resolve('command 不能为空')
  if (DENY_PATTERNS.some((rule) => rule.test(command))) {
    return Promise.resolve('这条命令属于破坏性操作（删根/格式化/关机/改注册表），我不会执行。换个做法，或者让用户自己来')
  }
  const cwd = resolveCwd(root, params.cwd)
  if (typeof cwd !== 'string') return Promise.resolve(cwd.error)

  const timeoutSec = Math.min(Math.max(Number(params.timeoutSec) || DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC)
  const { file, args } = buildInvocation(command)
  const startedAt = Date.now()

  return new Promise<string>((done) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let truncated = false

    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' }
    })

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      const text = decodeChunk(chunk)
      if (target === 'out') {
        if (stdout.length < MAX_OUTPUT) stdout += text
        else truncated = true
      } else if (stderr.length < MAX_OUTPUT) stderr += text
      else truncated = true
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutSec * 1000)

    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk))

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(
        formatResult({
          code,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: stderr.slice(0, MAX_OUTPUT),
          truncated
        })
      )
    }

    runningCommands.add(child)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      runningCommands.delete(child)
      clearTimeout(timer)
      done(`命令没起来：${error.message}`)
    })
    child.on('close', (code, signal) => {
      runningCommands.delete(child)
      finish(code, signal)
    })
  })
}

export const shellTools = [
  defineTool({
    name: 'bash',
    label: 'bash',
    domain: 'shell',
    risk: 'danger',
    expose: { agent: true, mcp: false },
    description:
      '在当前项目目录里执行一条非交互命令，返回退出码和输出（stdout/stderr）。' +
      'Windows 用 PowerShell，macOS/Linux 用 /bin/sh；工作目录默认项目根目录，cwd 只能是项目内的相对路径。' +
      '适合处理素材：pdftotext、ffmpeg、python 脚本、批量改名、查看目录等。' +
      '不要跑会一直等输入的命令（如 ssh、交互式 python），默认 60 秒超时、最长 600 秒。',
    parameters: Type.Object({
      command: Type.String({ description: '要执行的命令（一整条，平台差异按当前系统来写）' }),
      cwd: Type.Optional(Type.String({ description: '工作目录（相对项目根目录）；不传 = 项目根目录' })),
      timeoutSec: Type.Optional(
        Type.Number({ description: '超时秒数，默认 60，最大 600', minimum: 1, maximum: MAX_TIMEOUT_SEC })
      )
    }),
    handler: (ctx, params) => run(ctx, params)
  })
]
