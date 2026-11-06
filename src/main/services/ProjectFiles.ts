import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectService } from './ProjectService'
import type { StorageService } from './StorageService'

/** 清扫宽限：刚写完还没落库的文件不能删 */
const GRACE_MS = 60 * 60_000
/** 项目里的临时区：合成中间产物、转码暂存；不进库，打开项目时清空 */
const TMP_DIR = '.tmp'

export type ProjectFileKind = 'audio' | 'assets'

export interface ProjectFilePutResult {
  path: string
  hash: string
  bytes: number
  deduped: boolean
}

/**
 * 项目文件：合成音频进 `<项目>/audio/`，附件进 `<项目>/assets/`。
 *
 * 不做应用级统一存储：同一段音频几乎不会被别的项目复用，放进项目目录之后
 * 「整个目录拷走 = 完整备份」才成立。文件名取内容哈希，同文本同参数重复合成
 * 直接命中已有文件，不再写第二份。
 *
 * 没打开项目时（设置页试发音、音色试听）不落库：文件留在临时区，调用方用完即弃。
 */
export class ProjectFiles {
  private readonly warming = new Set<string>()

  constructor(
    private readonly projects: ProjectService,
    private readonly storage: StorageService
  ) {}

  /** 当前项目的 audio / assets 根；没开项目返回 null */
  root(kind: ProjectFileKind): string | null {
    const project = this.projects.currentProject()
    return project ? join(project.path, kind) : null
  }

  tmpDir(): string {
    const project = this.projects.currentProject()
    return project ? join(project.path, TMP_DIR) : join(tmpdir(), 'yuncast-tmp')
  }

  tmpPath(name: string): string {
    const dir = this.tmpDir()
    mkdirSync(dir, { recursive: true })
    return join(dir, name)
  }

  /** 路径归不归当前项目管（audio/ 或 assets/ 下） */
  isManaged(path: string | null | undefined): boolean {
    if (!path) return false
    const project = this.projects.currentProject()
    if (!project) return false
    const abs = resolve(path).toLowerCase()
    const root = resolve(project.path).toLowerCase()
    if (!abs.startsWith(`${root}${sep}`)) return false
    return abs.startsWith(`${join(root, 'audio')}${sep}`) || abs.startsWith(`${join(root, 'assets')}${sep}`)
  }

  /** 托管路径 → 内容哈希（文件名就是哈希）；非托管返回 null */
  hashForPath(path: string | null | undefined): string | null {
    if (!path || !this.isManaged(path)) return null
    const name = basename(path)
    const hash = name.split('.')[0]
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null
  }

  /**
   * 文件入库：算哈希 → 目标已存在就丢源文件（去重）→ 否则原子搬进去。
   * move=false 用于用户自己的文件（原始素材、外部导入音频）：只抄一份，不动原文件。
   * 没打开项目时不落库，原样返回源路径。
   */
  async put(
    srcPath: string,
    kind: ProjectFileKind,
    ext: string,
    options?: { move?: boolean }
  ): Promise<ProjectFilePutResult> {
    const bytes = statSync(srcPath).size
    const hash = await hashFile(srcPath)
    const root = this.root(kind)
    if (!root) return { path: srcPath, hash, bytes, deduped: false }

    const normalizedExt = ext.replace(/^\./, '').toLowerCase() || 'bin'
    const target = join(root, hash.slice(0, 2), `${hash}.${normalizedExt}`)
    if (resolve(target).toLowerCase() === resolve(srcPath).toLowerCase()) {
      return { path: target, hash, bytes, deduped: true }
    }
    if (existsSync(target)) {
      if (options?.move !== false) await rm(srcPath, { force: true }).catch(() => undefined)
      return { path: target, hash, bytes, deduped: true }
    }
    await mkdir(dirname(target), { recursive: true })
    if (options?.move === false) await copyFile(srcPath, target)
    else await moveFile(srcPath, target)
    return { path: target, hash, bytes, deduped: false }
  }

  /** 没别的行引用才删（稿子、池、附件都算引用；TTS 缓存不算） */
  async deleteIfUnreferenced(path: string): Promise<boolean> {
    if (!this.isManaged(path)) return false
    if (this.storage.projectReferencedFiles().has(normalize(path))) return false
    await rm(path, { force: true }).catch(() => undefined)
    this.storage.projectTtsCacheDeleteByPath(path)
    return true
  }

  /** 后台把文件读进 OS 页面缓存：第一条播出时 ffmpeg 不用等磁盘 */
  warm(path: string | null | undefined): void {
    if (!path || !this.isManaged(path) || this.warming.has(path)) return
    this.warming.add(path)
    const stream = createReadStream(path)
    stream.on('error', () => this.warming.delete(path))
    stream.on('end', () => this.warming.delete(path))
    stream.resume()
  }

  // ---------- TTS 缓存（按项目存：同文同参只合一次） ----------

  cachedPath(key: string): string | null {
    const path = this.storage.projectTtsCacheGet(key)
    if (!path) return null
    if (existsSync(path)) return path
    this.storage.projectTtsCacheDelete(key)
    return null
  }

  remember(key: string, path: string): void {
    if (!this.projects.currentProject()) return
    this.storage.projectTtsCachePut(key, path)
  }

  // ---------- 打开项目：重绑路径 + 清临时区 + 扫孤儿 ----------

  /**
   * 目录被拷到别处/别的机器后，库里记的绝对路径会失效。
   * 文件名是内容哈希，按文件名在项目里找回同一份文件，把路径改回当前目录。
   */
  rebind(): void {
    const project = this.projects.currentProject()
    if (!project) return
    const index = this.scanFiles()
    if (index.size === 0) return
    let fixed = 0
    for (const path of this.storage.projectFilePaths()) {
      if (!path) continue
      const abs = isAbsolute(path) ? path : join(project.path, path)
      if (existsSync(abs)) {
        if (abs !== path) this.storage.projectRewriteFilePath(path, abs)
        continue
      }
      const hit = index.get(basename(abs))
      if (!hit) continue
      this.storage.projectRewriteFilePath(path, hit)
      fixed += 1
    }
    if (fixed > 0) console.log(`[项目文件] 目录搬过家，重绑 ${fixed} 条路径`)
  }

  /** 打开项目时清掉上次崩溃/中断留下的临时文件 */
  cleanTemp(): void {
    const project = this.projects.currentProject()
    if (!project) return
    rmSync(join(project.path, TMP_DIR), { recursive: true, force: true })
  }

  /** 清孤儿：项目里没人引用的音频/附件（过宽限期才删） */
  async sweep(): Promise<{ removed: number; freedBytes: number }> {
    const project = this.projects.currentProject()
    if (!project) return { removed: 0, freedBytes: 0 }
    this.storage.projectTtsCachePruneMissing()
    const referenced = new Set([...this.storage.projectReferencedFiles()].map(normalize))
    let removed = 0
    let freedBytes = 0
    for (const dir of ['audio', 'assets'] as ProjectFileKind[]) {
      const root = join(project.path, dir)
      for (const file of walk(root)) {
        if (referenced.has(normalize(file))) continue
        try {
          if (Date.now() - statSync(file).mtimeMs < GRACE_MS) continue
          const bytes = statSync(file).size
          await rm(file, { force: true })
          this.storage.projectTtsCacheDeleteByPath(file)
          removed += 1
          freedBytes += bytes
        } catch {
          /* 删不掉的下次再说 */
        }
      }
    }
    if (removed > 0) {
      console.log(`[项目文件] 清扫 ${removed} 个孤儿文件（${(freedBytes / 1024 / 1024).toFixed(1)}MB）`)
    }
    return { removed, freedBytes }
  }

  /** 文件名 → 绝对路径（重绑用；同名哈希不会重复） */
  private scanFiles(): Map<string, string> {
    const project = this.projects.currentProject()
    const index = new Map<string, string>()
    if (!project) return index
    for (const dir of ['audio', 'assets']) {
      for (const file of walk(join(project.path, dir))) {
        const name = basename(file)
        if (!index.has(name)) index.set(name, file)
      }
    }
    return index
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else out.push(path)
    }
  }
  visit(dir)
  return out
}

function normalize(path: string): string {
  return resolve(path).toLowerCase()
}

function hashFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', () => done(hash.digest('hex')))
  })
}

/** rename 跨盘会 EXDEV：退回「复制 + 删源」 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}
