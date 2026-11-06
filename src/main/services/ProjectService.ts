import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  insertProjectMeta,
  openProjectDatabase,
  readProjectMeta,
  readSchemaVersion,
  PROJECT_SCHEMA_VERSION,
  type ProjectMeta
} from '../db/projectSchema'
import type { ProjectRecord } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { ScriptService } from './ScriptService'

/**
 * 项目（docs：一个项目 = 一个目录 = 一个库）。
 *
 * - 目录列表记在应用库（可扫盘重建），项目内容只存在 `<目录>/project.db`
 * - `open()` 之后项目库常驻；`close()` 先 checkpoint 再断开，保证目录可以直接拷走
 * - 项目 id 同时是导演会话/场景/底稿的归属键（后续阶段内容全部落项目库）
 */
export class ProjectService {
  private db: DatabaseSync | null = null
  private current: ProjectRecord | null = null
  /** 项目列表或当前项目变化（界面据此刷新） */
  onChanged: (() => void) | null = null
  /** 切了项目（打开/关闭）：导演会话要按新项目重建，别拿着上一个项目的上下文和旧提示词 */
  onSwitched: ((id: string | null) => void) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly script: ScriptService
  ) {}

  /** 默认项目根目录：文档 / YunCast Projects（用户可逐个项目另选目录） */
  rootDir(): string {
    return join(app.getPath('documents'), 'YunCast Projects')
  }

  list(): ProjectRecord[] {
    return this.storage.projectRows()
  }

  currentProject(): ProjectRecord | null {
    return this.current
  }

  create(input: { name: string; dir?: string }): ProjectRecord {
    const name = input.name.trim()
    if (!name) throw new Error('项目名不能为空')
    const id = randomUUID()
    const dir = input.dir?.trim()
      ? join(input.dir.trim(), safeDirName(name))
      : join(this.rootDir(), safeDirName(name))
    if (existsSync(dir) && statSync(dir).isDirectory() && existsSync(join(dir, 'project.db'))) {
      throw new Error(`这个目录里已经有一个项目了：${dir}`)
    }
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'assets'), { recursive: true })
    mkdirSync(join(dir, 'audio'), { recursive: true })

    const now = Date.now()
    const db = openProjectDatabase(join(dir, 'project.db'))
    insertProjectMeta(db, { id, name, type: 'authored', createdAt: now, updatedAt: now })
    db.close()

    const record: ProjectRecord = { id, path: dir, name, createdAt: now, lastOpenedAt: 0 }
    this.storage.projectRowInsert(record)
    this.onChanged?.()
    return record
  }

  /** 打开项目：目录里的 project.db 是唯一真值；比应用新的库直接拒绝，避免降级写坏 */
  open(id: string): ProjectRecord {
    const record = this.storage.projectRows().find((item) => item.id === id)
    if (!record) throw new Error('项目不存在（列表可能过期，刷新后重试）')
    const file = join(record.path, 'project.db')
    if (!existsSync(file)) throw new Error(`项目文件缺失：${file}`)
    if (this.current?.id === id && this.db) return this.current

    this.close()
    // 先只读探一下结构版本再真开：openProjectDatabase 会把 user_version 写成当前值
    const probe = openProjectDatabase(file, { create: false })
    let version = 0
    try {
      version = readSchemaVersion(probe)
    } finally {
      probe.close()
    }
    if (version !== PROJECT_SCHEMA_VERSION) {
      throw new Error(
        `项目结构版本不一致（项目 ${version} / 当前 ${PROJECT_SCHEMA_VERSION}）：旧项目不再兼容，请新建项目`
      )
    }
    const db = openProjectDatabase(file)
    this.db = db
    this.current = record
    this.storage.attachProject(db)
    this.storage.projectRowTouch(id)

    this.script.setActiveProgram(record.id)
    this.onChanged?.()
    this.onSwitched?.(record.id)
    return record
  }

  /**
   * 按目录打开：用于「打开已有项目」（换机器、别人给的项目目录、从 U 盘打开）。
   * 身份以 project.db 里的 id 为准，目录名只是显示——改名/移动后仍能认回同一个项目。
   */
  openAt(dir: string): ProjectRecord {
    const path = dir.trim()
    if (!path) throw new Error('没有选择目录')
    const file = join(path, 'project.db')
    if (!existsSync(file)) throw new Error('这个目录不是 YunCast 项目（缺少 project.db）')
    const probe = openProjectDatabase(file, { create: false })
    let meta: ProjectMeta | null = null
    try {
      meta = readProjectMeta(probe)
    } finally {
      probe.close()
    }
    if (!meta) throw new Error('项目文件损坏：缺少项目信息')
    const known = this.storage.projectRows().find((item) => item.id === meta!.id)
    const record: ProjectRecord = {
      id: meta.id,
      path,
      name: meta.name,
      createdAt: meta.createdAt,
      lastOpenedAt: known?.lastOpenedAt ?? 0
    }
    if (!known || known.path !== path) this.storage.projectRowInsert(record)
    return this.open(record.id)
  }

  /**
   * 关闭当前项目：先 checkpoint 把 WAL 收回主文件，目录才是一个可压缩的完整快照。
   * 同时取消当前节目，避免没有项目时还有别的项目在"当前"。
   */
  close(): void {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // 库已经不可用时 checkpoint 也会抛，关掉就好
      }
      this.storage.detachProject()
      this.db.close()
      this.db = null
    }
    if (this.current) {
      this.current = null
      this.script.setActiveProgram('')
      this.onChanged?.()
      this.onSwitched?.(null)
    }
  }

  /** 从列表移除（**不动磁盘目录**：项目是用户资产，删文件必须由用户自己决定） */
  /** 移除项目；deleteFiles=true 时连项目目录一起删（不可恢复，调用方必须先确认） */
  remove(id: string, options: { deleteFiles?: boolean } = {}): void {
    const record = this.storage.projectRows().find((row) => row.id === id)
    if (this.current?.id === id) this.close()
    this.storage.projectRowRemove(id)
    if (options.deleteFiles && record) {
      try {
        rmSync(record.path, { recursive: true, force: true })
      } catch (error) {
        console.warn('[项目] 删除目录失败:', error instanceof Error ? error.message : String(error))
      }
    }
    this.onChanged?.()
  }

  /** 把 WAL 收回主文件：导出/拷贝目录前调，目录才是一个完整快照 */
  checkpoint(): void {
    if (!this.db) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // 库不可用时 checkpoint 会抛，导出侧再兜底
    }
  }


}

function safeDirName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned.slice(0, 60) || '未命名项目'
}
