import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectRecord } from '../../shared/types'
import type { ProjectService } from './ProjectService'
import type { StorageService } from './StorageService'

/**
 * 项目导入/导出（一个项目 = 一个目录 = 一个 project.db + 音频资产）。
 *
 * 导出包是标准 ZIP：`manifest.json` + `project/`（项目目录整份）。
 * **包里不存任何本机绝对路径**：项目目录内的文件写成相对路径，目录外的音频拷进 `project/audio/`
 * 后再写成相对路径——所以包换台电脑也能直接打开。
 *
 * 导入 = 解压到「文档/YunCast Projects/<名字>」，把库里的相对路径接回新目录的绝对路径。
 * 项目 id 撞了就换一个新的（同一台机器再导入一次不能顶掉原项目）。
 * 解压用系统自带 tar（Windows 10+ 的 bsdtar 支持 zip），不引第三方压缩库。
 */

const MANIFEST_FORMAT = 'yuncast-project'
const MANIFEST_VERSION = 2

interface Manifest {
  format: string
  version: number
  id: string
  name: string
  createdAt: number
}

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus'])

function tarBinary(): string {
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'
}

function runTar(args: string[]): void {
  execFileSync(tarBinary(), args, { stdio: 'pipe', windowsHide: true })
}

/** 跨平台的相对路径写法（包里统一用 /，导入时再转回本机分隔符） */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function fromPosix(path: string): string {
  return path.split('/').join(sep)
}

/** 把库和 JSON 字段里引用的文件路径都过一遍（导出改相对 / 导入改绝对共用） */
function rewriteFilePaths(db: DatabaseSync, remap: (path: string) => string): void {
  const rewriteColumn = (selectSql: string, updateSql: string, column: string): void => {
    try {
      for (const row of db.prepare(selectSql).all() as Record<string, unknown>[]) {
        const oldPath = String(row[column] ?? '').trim()
        if (!oldPath) continue
        const next = remap(oldPath)
        if (next !== oldPath) db.prepare(updateSql).run(next, oldPath)
      }
    } catch {
      // 老库缺列/缺表
    }
  }
  rewriteColumn(
    'SELECT DISTINCT audio_path FROM pool_items WHERE audio_path IS NOT NULL',
    'UPDATE pool_items SET audio_path = ? WHERE audio_path = ?',
    'audio_path'
  )
  rewriteColumn(
    'SELECT DISTINCT audio_path FROM draft_units WHERE audio_path IS NOT NULL',
    'UPDATE draft_units SET audio_path = ? WHERE audio_path = ?',
    'audio_path'
  )
  rewriteColumn(
    "SELECT DISTINCT file_path FROM material_files WHERE file_path IS NOT NULL AND file_path != ''",
    'UPDATE material_files SET file_path = ? WHERE file_path = ?',
    'file_path'
  )
  rewriteColumn(
    'SELECT DISTINCT path FROM tts_cache',
    'UPDATE tts_cache SET path = ? WHERE path = ?',
    'path'
  )

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

  /** 导出当前项目（或指定项目）到一个 ZIP 包；包内只有相对路径 */
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
      // 项目目录整份拷进包：.tmp 是合成中间产物，不进包
      const projectRoot = resolve(record.path)
      cpSync(projectRoot, projectCopy, {
        recursive: true,
        filter: (src) => !relative(projectRoot, src).split(sep)[0].startsWith('.tmp')
      })
      mkdirSync(join(projectCopy, 'audio'), { recursive: true })
      mkdirSync(join(projectCopy, 'assets'), { recursive: true })

      /** 绝对路径 → 包内相对路径；项目目录外的文件先拷进包里 */
      const externalMap = new Map<string, string>()
      const toRelative = (path: string): string => {
        const abs = resolve(path)
        if (abs.toLowerCase().startsWith(`${projectRoot.toLowerCase()}${sep}`)) {
          return toPosix(relative(projectRoot, abs))
        }
        const known = externalMap.get(path)
        if (known) return known
        if (!existsSync(path)) return path // 文件已经不在：原样留着，导入后由界面提示重合成
        const audio = AUDIO_EXT.has(extname(path).toLowerCase())
        const folder = audio ? 'audio' : 'assets'
        const name = `imported-${externalMap.size + 1}${extname(path)}`
        copyFileSync(path, join(projectCopy, folder, name))
        const rel = `${folder}/${name}`
        externalMap.set(path, rel)
        return rel
      }

      const db = new DatabaseSync(join(projectCopy, 'project.db'))
      try {
        rewriteFilePaths(db, toRelative)
      } finally {
        db.close()
      }

      const manifest: Manifest = {
        format: MANIFEST_FORMAT,
        version: MANIFEST_VERSION,
        id: record.id,
        name: record.name,
        createdAt: record.createdAt
      }
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

      // bsdtar 的 -a 按扩展名选格式：.zip 就是标准 ZIP
      runTar(['-a', '-cf', targetFile, '-C', staging, '.'])
      return { file: targetFile, files: externalMap.size + 1 }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** 导入 ZIP 包：解到项目根目录 → 相对路径接回新目录 → 登记并打开 */
  importProject(sourceFile: string): ProjectRecord {
    const staging = mkdtempSync(join(tmpdir(), 'yuncast-import-'))
    try {
      runTar(['-xf', sourceFile, '-C', staging])
      const manifestPath = join(staging, 'manifest.json')
      if (!existsSync(manifestPath)) throw new Error('不是 YunCast 项目包（缺少 manifest.json）')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
      if (manifest.format !== MANIFEST_FORMAT) throw new Error('不是 YunCast 项目包')
      if (manifest.version > MANIFEST_VERSION) {
        throw new Error(`这个项目包来自更新版本的软件（包版本 ${manifest.version}），请先升级`)
      }
      if (manifest.version < MANIFEST_VERSION) throw new Error('旧版项目包（含本机绝对路径）不再支持，请用新版本重新导出')
      const sourceDir = join(staging, 'project')
      if (!existsSync(join(sourceDir, 'project.db'))) throw new Error('项目包损坏：缺少 project.db')

      const targetDir = this.uniqueProjectDir(manifest.name)
      cpSync(sourceDir, targetDir, { recursive: true })

      const db = new DatabaseSync(join(targetDir, 'project.db'))
      try {
        db.exec('PRAGMA busy_timeout = 5000')
        rewriteFilePaths(db, (path) =>
          isAbsolute(path) ? path : join(targetDir, fromPosix(path))
        )
        if (this.storage.projectRows().some((row) => row.id === manifest.id)) {
          remapProjectId(db, randomUUID())
        }
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
