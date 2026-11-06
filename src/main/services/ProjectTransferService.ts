import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { ProjectRecord } from '../../shared/types'
import type { ProjectService } from './ProjectService'
import type { StorageService } from './StorageService'

/**
 * 项目导入/导出（一个项目 = 一个目录 = 一个 project.db + 音频资产）。
 *
 * 导出包 = tar.gz：
 *   manifest.json   项目身份 + 外部音频映射（音频不在项目目录里时用）
 *   project/        项目目录整份拷贝（project.db、assets、用户放进来的文件）
 *   blobs/          数据库里引用的、但存放在项目目录之外的音频（应用 blob 区）
 *
 * 导入 = 解包到「文档/YunCast Projects/<名字>」，把库里的绝对路径重写成新位置，
 * 项目 id 撞了就换一个新的（同一台机器上再导入一次不能顶掉原项目）。
 * 容器用系统自带的 tar（Windows 10+ 的 bsdtar），不引第三方压缩库。
 */

const MANIFEST_FORMAT = 'yuncast-project'
const MANIFEST_VERSION = 1

interface Manifest {
  format: string
  version: number
  id: string
  name: string
  projectPath: string
  createdAt: number
  /** 项目目录之外、被库里引用的文件：original = 导出时的绝对路径，name = 包内 blobs/ 下的文件名 */
  externals: { name: string; original: string }[]
}

function tarBinary(): string {
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'
}

function runTar(args: string[]): void {
  execFileSync(tarBinary(), args, { stdio: 'pipe', windowsHide: true })
}

/** 把库和 JSON 字段里引用的音频路径都过一遍（导出收集 / 导入重写共用） */
function walkAudioPaths(
  db: DatabaseSync,
  visit: (path: string) => void
): void {
  const claim = (value: unknown): void => {
    const path = typeof value === 'string' ? value.trim() : ''
    if (path) visit(path)
  }
  const tryQuery = (sql: string, column: string): void => {
    try {
      for (const row of db.prepare(sql).all() as Record<string, unknown>[]) claim(row[column])
    } catch {
      // 老库缺列/缺表就跳过：别的路径照常处理
    }
  }
  tryQuery('SELECT audio_path FROM pool_items WHERE audio_path IS NOT NULL', 'audio_path')
  tryQuery('SELECT audio_path FROM draft_units WHERE audio_path IS NOT NULL', 'audio_path')
  tryQuery("SELECT file_path FROM material_files WHERE file_path <> ''", 'file_path')
  try {
    for (const row of db.prepare('SELECT rendered FROM draft_units WHERE rendered IS NOT NULL').all() as {
      rendered: unknown
    }[]) {
      try {
        claim((JSON.parse(String(row.rendered)) as { audioPath?: string }).audioPath)
      } catch {
        // 坏 JSON 跳过
      }
    }
  } catch {
    // 老库没有 rendered 列
  }
  try {
    const row = db.prepare('SELECT scenes FROM project LIMIT 1').get() as { scenes?: unknown } | undefined
    const scenes = JSON.parse(String(row?.scenes ?? '[]')) as { rendered?: { audioPath?: string } }[]
    for (const scene of Array.isArray(scenes) ? scenes : []) claim(scene.rendered?.audioPath)
  } catch {
    // 老库没有 scenes 列 / 坏 JSON
  }
}

/** 导入时按「前缀换根 + 外部文件精确映射」重写路径 */
function rewriteAudioPaths(
  db: DatabaseSync,
  remap: (path: string) => string
): void {
  const rewriteColumn = (sql: string, update: string): void => {
    try {
      for (const row of db.prepare(sql).all() as Record<string, unknown>[]) {
        const oldPath = String(row.audio_path ?? '')
        if (!oldPath) continue
        const next = remap(oldPath)
        if (next !== oldPath) db.prepare(update).run(next, oldPath)
      }
    } catch {
      // 老库缺列/缺表
    }
  }
  rewriteColumn('SELECT DISTINCT audio_path FROM pool_items WHERE audio_path IS NOT NULL', 'UPDATE pool_items SET audio_path = ? WHERE audio_path = ?')
  rewriteColumn('SELECT DISTINCT audio_path FROM draft_units WHERE audio_path IS NOT NULL', 'UPDATE draft_units SET audio_path = ? WHERE audio_path = ?')

  try {
    const rows = db.prepare('SELECT id, rendered FROM draft_units WHERE rendered IS NOT NULL').all() as {
      id: string
      rendered: string
    }[]
    const update = db.prepare('UPDATE draft_units SET rendered = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const ref = JSON.parse(row.rendered) as { audioPath?: string }
        if (!ref?.audioPath) continue
        const next = remap(ref.audioPath)
        if (next === ref.audioPath) continue
        update.run(JSON.stringify({ ...ref, audioPath: next }), row.id)
      } catch {
        // 坏 JSON 跳过
      }
    }
  } catch {
    // 老库没有 rendered 列
  }

  try {
    const row = db.prepare('SELECT scenes FROM project LIMIT 1').get() as { scenes?: string } | undefined
    if (row?.scenes) {
      const scenes = JSON.parse(row.scenes) as { rendered?: { audioPath?: string } }[]
      let changed = false
      for (const scene of Array.isArray(scenes) ? scenes : []) {
        if (!scene.rendered?.audioPath) continue
        const next = remap(scene.rendered.audioPath)
        if (next !== scene.rendered.audioPath) {
          scene.rendered.audioPath = next
          changed = true
        }
      }
      if (changed) db.prepare('UPDATE project SET scenes = ?').run(JSON.stringify(scenes))
    }
  } catch {
    // 老库没有 scenes 列 / 坏 JSON
  }

  try {
    const rows = db.prepare("SELECT id, file_path FROM material_files WHERE file_path <> ''").all() as {
      id: string
      file_path: string
    }[]
    const update = db.prepare('UPDATE material_files SET file_path = ? WHERE id = ?')
    for (const row of rows) {
      const next = remap(row.file_path)
      if (next !== row.file_path) update.run(next, row.id)
    }
  } catch {
    // 老库没有 material_files
  }
}

/** 换项目 id（同一台机器重复导入时避免顶掉原项目） */
function remapProjectId(db: DatabaseSync, nextId: string): void {
  const tables = [
    'session_configs',
    'draft_units',
    'pool_items',
    'live_sessions',
    'director_sessions',
    'director_timeline',
    'event_log'
  ]
  for (const table of tables) {
    try {
      db.prepare(`UPDATE ${table} SET script_id = ?`).run(nextId)
    } catch {
      // 老库缺表/缺列
    }
  }
  db.prepare('UPDATE project SET id = ?').run(nextId)
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'projectId'").run(nextId)
  } catch {
    // 老库没有 meta
  }
}

export class ProjectTransferService {
  constructor(
    private readonly projects: ProjectService,
    private readonly storage: StorageService
  ) {}

  /** 导出当前项目（或指定项目）到单个 .yuncast 文件 */
  exportProject(targetFile: string, projectId?: string): { file: string; files: number } {
    const id = projectId ?? this.projects.currentProject()?.id
    const record = this.storage.projectRows().find((item) => item.id === id)
    if (!record) throw new Error('没有可导出的项目')
    if (!existsSync(join(record.path, 'project.db'))) throw new Error(`项目文件缺失：${record.path}`)

    // 正在用的项目先把 WAL 收回主文件，拷出来才是完整快照
    if (this.projects.currentProject()?.id === record.id) this.projects.checkpoint()

    const staging = mkdtempSync(join(tmpdir(), 'yuncast-export-'))
    try {
      const projectCopy = join(staging, 'project')
      cpSync(record.path, projectCopy, { recursive: true })
      const blobsDir = join(staging, 'blobs')
      mkdirSync(blobsDir, { recursive: true })

      const externals: Manifest['externals'] = []
      const seen = new Set<string>()
      const db = new DatabaseSync(join(projectCopy, 'project.db'))
      try {
        const projectRoot = resolve(record.path).toLowerCase()
        walkAudioPaths(db, (path) => {
          if (seen.has(path)) return
          seen.add(path)
          // 项目目录里的文件随目录一起拷了，不用再单独打包
          const inside = resolve(path).toLowerCase().startsWith(projectRoot)
          if (inside || !existsSync(path)) return
          const name = `${externals.length + 1}${extname(path) || '.mp3'}`
          copyFileSync(path, join(blobsDir, name))
          externals.push({ name, original: path })
        })
      } finally {
        db.close()
      }

      const manifest: Manifest = {
        format: MANIFEST_FORMAT,
        version: MANIFEST_VERSION,
        id: record.id,
        name: record.name,
        projectPath: record.path,
        createdAt: record.createdAt,
        externals
      }
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

      runTar(['-czf', targetFile, '-C', staging, '.'])
      return { file: targetFile, files: externals.length + 1 }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** 导入 .yuncast 包：解到项目根目录 → 重写音频路径 → 登记并打开 */
  importProject(sourceFile: string): ProjectRecord {
    const staging = mkdtempSync(join(tmpdir(), 'yuncast-import-'))
    try {
      runTar(['-xzf', sourceFile, '-C', staging])
      const manifestPath = join(staging, 'manifest.json')
      if (!existsSync(manifestPath)) throw new Error('不是 YunCast 项目包（缺少 manifest.json）')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
      if (manifest.format !== MANIFEST_FORMAT) throw new Error('不是 YunCast 项目包')
      if (manifest.version > MANIFEST_VERSION) {
        throw new Error(`这个项目包来自更新版本的软件（包版本 ${manifest.version}），请先升级`)
      }
      const sourceDir = join(staging, 'project')
      if (!existsSync(join(sourceDir, 'project.db'))) throw new Error('项目包损坏：缺少 project.db')

      const targetDir = this.uniqueProjectDir(manifest.name)
      cpSync(sourceDir, targetDir, { recursive: true })

      // 外部音频统一落到项目目录的 audio/ 下
      const audioDir = join(targetDir, 'audio')
      const externalMap = new Map<string, string>()
      if (manifest.externals?.length) {
        mkdirSync(audioDir, { recursive: true })
        for (const file of manifest.externals) {
          const from = join(staging, 'blobs', file.name)
          const to = join(audioDir, basename(file.name))
          if (existsSync(from)) copyFileSync(from, to)
          externalMap.set(file.original, to)
        }
      }

      const remap = (path: string): string => {
        const exact = externalMap.get(path)
        if (exact) return exact
        // 项目目录整体搬家：旧目录前缀下的文件都在新目录同样的相对位置（Windows 路径不分大小写）
        const oldRoot = resolve(manifest.projectPath)
        const target = resolve(path)
        const sameRoot =
          target.toLowerCase() === oldRoot.toLowerCase() ||
          target.toLowerCase().startsWith(`${oldRoot.toLowerCase()}${sep}`)
        if (sameRoot) return join(targetDir, target.slice(oldRoot.length))
        return path
      }

      const db = new DatabaseSync(join(targetDir, 'project.db'))
      try {
        db.exec('PRAGMA busy_timeout = 5000')
        rewriteAudioPaths(db, remap)
        const clash = this.storage.projectRows().some((row) => row.id === manifest.id)
        if (clash) remapProjectId(db, randomUUID())
      } finally {
        db.close()
      }

      // 走同一条「按目录打开」路径：校验库版本、登记到应用库、切到新项目
      return this.projects.openAt(targetDir)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** 目标目录重名就加序号：导入不能覆盖已有项目 */
  private uniqueProjectDir(name: string): string {
    const root = this.projects.rootDir()
    mkdirSync(root, { recursive: true })
    const base = (name || '未命名项目').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || '未命名项目'
    let dir = join(root, base)
    let index = 2
    while (existsSync(dir)) {
      dir = join(root, `${base} (${index})`)
      index += 1
    }
    return dir
  }
}
