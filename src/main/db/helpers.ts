import type { DatabaseSync } from 'node:sqlite'

/**
 * 迁移里反复用到的结构探查与兜底建列。
 * 只依赖 node:sqlite，不碰 Electron——这样迁移器和迁移脚本可以脱离应用单独跑（自测脚本就是这么验的）。
 */

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

export function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]
  return new Set(rows.map((row) => String(row.name)))
}

/** 补列但不覆盖已有值：老库抬升与全新库兜底共用同一条路径 */
export function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (hasTable(db, table) && !columnsOf(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value
  return value == null ? '' : String(value)
}

/** JSON 列容错解析：坏了/空了都回落默认值，不让一行脏数据炸掉整次迁移 */
export function parseJson<T>(value: unknown, fallback: T): T {
  const raw = str(value)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
