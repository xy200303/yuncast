import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/**
 * 文件工具（对齐 Pi Agent 的 read / write / edit）：
 * - 路径一律锁在项目目录内（相对路径按项目根解析，绝对路径越界直接拒绝）
 * - 读取只给文本（带行号）；二进制告诉类型和大小，处理交给 bash
 * - 写入/替换都是原子写（同目录 .tmp + rename），不会留下写一半的文件
 * - 改已有文件优先用 edit（精确替换），整篇重写才用 write
 */

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_READ_CHARS = 200_000
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_EDIT_BYTES = 2 * 1024 * 1024

function projectRootOf(ctx: ToolCtx): string | { error: string } {
  const root = ctx.projectRoot?.()
  if (!root) return { error: '还没有打开项目：文件工具只在项目目录里操作' }
  // 统一成绝对路径 + 本平台分隔符，后面做 "root + sep" 的越界判断才可靠
  return resolve(root)
}

/** 把用户给的路径解析到项目内；越界/不存在的情况返回中文错误 */
function resolveInProject(ctx: ToolCtx, raw: string): string | { error: string } {
  const root = projectRootOf(ctx)
  if (typeof root !== 'string') return root
  const input = raw.trim()
  if (!input) return { error: 'path 不能为空' }
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input)
  if (target !== root && !target.startsWith(root + sep)) {
    return { error: `路径越界：只能操作项目目录内的文件（项目根：${root}）` }
  }
  return target
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000)
  for (const byte of sample) if (byte === 0) return true
  return false
}

function guessBinaryLabel(file: string, bytes: number): string {
  const ext = extname(file).toLowerCase()
  const kind = /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(ext)
    ? '图片'
    : /\.(mp3|wav|m4a|aac|flac|ogg)$/.test(ext)
      ? '音频'
      : /\.(mp4|mov|mkv|webm)$/.test(ext)
        ? '视频'
        : /\.pdf$/.test(ext)
          ? 'PDF'
          : '二进制文件'
  return `${kind} · ${(bytes / 1024).toFixed(1)}KB`
}

/** 原子写：同目录先写 .tmp 再改名；Windows 目标存在时 rename 失败就退回「删了再改名」 */
function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    try {
      unlinkSync(file)
    } catch {
      // 目标本来就不存在
    }
    renameSync(tmp, file)
  }
}

export const fsTools = [
  defineTool({
    name: 'read',
    label: '读文件',
    domain: 'fs',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '读取项目内的文本文件（带行号，方便引用和改）。' +
      'path 是相对项目根的路径，比如 assets/产品介绍.txt、notes.md。' +
      '大文件用 offset/limit 分页读（默认前 2000 行）；超过 2MB 或二进制（图片/PDF/音视频）只返回类型和大小——' +
      '二进制要用 bash 处理（pdftotext / ffmpeg / python 等）。',
    parameters: Type.Object({
      path: Type.String({ description: '项目内的文件路径（相对项目根，或项目内的绝对路径）' }),
      offset: Type.Optional(Type.Number({ description: '从第几行开始读（1 起），默认 1' })),
      limit: Type.Optional(Type.Number({ description: '最多读多少行，默认 2000' }))
    }),
    handler: (ctx, params) => {
      const target = resolveInProject(ctx, params.path)
      if (typeof target !== 'string') return target.error
      if (!existsSync(target)) return `文件不存在：${params.path}`
      const stat = statSync(target)
      if (stat.isDirectory()) return `${params.path} 是目录（要看内容用 bash：ls / dir）`
      if (stat.size > MAX_READ_BYTES) {
        return `文件太大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 2MB）：用 bash 分段处理（head/tail/sed/python）`
      }
      const buf = readFileSync(target)
      if (isBinary(buf)) {
        return `${params.path} 不是文本文件（${guessBinaryLabel(target, stat.size)}）。read 只读文本；需要处理就用 bash（pdftotext/ffmpeg/python）`
      }
      const lines = buf.toString('utf8').split(/\r?\n/)
      const offset = Math.max(1, Math.floor(Number(params.offset) || 1))
      const limit = Math.max(1, Math.floor(Number(params.limit) || 2000))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      let text = slice.map((line, i) => `${offset + i}\t${line}`).join('\n')
      if (text.length > MAX_READ_CHARS) text = `${text.slice(0, MAX_READ_CHARS)}\n…（本页超过 20 万字符，已截断；用 offset/limit 分页）`
      const tail =
        offset - 1 + slice.length < lines.length
          ? `\n…（共 ${lines.length} 行，已读到第 ${offset - 1 + slice.length} 行；继续读用 offset=${offset + slice.length}）`
          : ''
      return `# ${params.path}（${lines.length} 行）\n${text}${tail}`
    }
  }),
  defineTool({
    name: 'write',
    label: '写文件',
    domain: 'fs',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '新建或整篇覆盖一个文本文件（自动建目录，原子写，不会留半截文件）。' +
      'path 相对项目根；content 是完整内容，上限 1MB。' +
      '改已有文件的一小段请用 edit（精确替换），别用 write 整篇重写。',
    parameters: Type.Object({
      path: Type.String({ description: '项目内的文件路径（相对项目根）' }),
      content: Type.String({ description: '完整文件内容（覆盖写）' })
    }),
    handler: (ctx, params) => {
      const target = resolveInProject(ctx, params.path)
      if (typeof target !== 'string') return target.error
      if (Buffer.byteLength(params.content, 'utf8') > MAX_WRITE_BYTES) {
        return '内容超过 1MB：拆成多个文件，或用 bash 生成'
      }
      atomicWrite(target, params.content)
      const lines = params.content.split(/\r?\n/).length
      return `已写入 ${params.path}（${Buffer.byteLength(params.content, 'utf8')} 字节 · ${lines} 行）`
    }
  }),
  defineTool({
    name: 'edit',
    label: '改文件',
    domain: 'fs',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '对已有文本文件做精确字符串替换（最常用的改文件方式，比 write 安全）。' +
      'old_string 必须和文件里逐字一致（含缩进与换行）；默认只允许匹配 1 处，匹配多处以 replace_all=true 全改。' +
      '匹配不到就报错——说明文件和你想的不一样，先 read 再看。写入是原子的。',
    parameters: Type.Object({
      path: Type.String({ description: '项目内的文件路径' }),
      old_string: Type.String({ description: '要被替换的原文（逐字一致，含缩进/换行）' }),
      new_string: Type.String({ description: '替换后的内容；空串 = 删除这段' }),
      replace_all: Type.Optional(Type.Boolean({ description: '匹配到多处时是否全部替换，默认 false' }))
    }),
    handler: (ctx, params) => {
      const target = resolveInProject(ctx, params.path)
      if (typeof target !== 'string') return target.error
      if (!existsSync(target)) return `文件不存在：${params.path}（新文件用 write）`
      const stat = statSync(target)
      if (stat.isDirectory()) return `${params.path} 是目录，不能 edit`
      if (stat.size > MAX_EDIT_BYTES) return '文件超过 2MB，edit 不适合：用 bash 里的 sed/python 处理'
      const before = readFileSync(target, 'utf8')
      if (!params.old_string) return 'old_string 不能为空（想追加内容用 write，或在末尾用 edit 替换一段已知文本）'
      const count = before.split(params.old_string).length - 1
      if (count === 0) {
        return `没有匹配到 old_string：先 read ${params.path} 看清原文（空格/缩进/换行都要一致），再改`
      }
      if (count > 1 && params.replace_all !== true) {
        return `old_string 匹配到 ${count} 处：给更多上下文让它唯一，或传 replace_all=true 全部替换`
      }
      const after = params.replace_all === true
        ? before.split(params.old_string).join(params.new_string)
        : before.replace(params.old_string, params.new_string)
      atomicWrite(target, after)
      return `已替换 ${params.replace_all === true ? count : 1} 处：${params.path}（${Buffer.byteLength(after, 'utf8')} 字节）`
    }
  })
]
