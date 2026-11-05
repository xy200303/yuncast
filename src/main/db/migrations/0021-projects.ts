import type { Migration } from '../types'

/**
 * v21 · 项目列表（应用库）：`projects(id, path, name, created_at, last_opened_at)`。
 *
 * 内容全部搬进「每个项目一个目录 + 一个 project.db」之后，应用库只剩三件事：
 * 全局设置/凭据、音色库、以及这张项目清单。清单可扫盘重建，丢了不丢内容。
 */
export const migration: Migration = {
  name: '0021-projects',
  version: 21,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS projects_recent ON projects(last_opened_at DESC)')
  }
}
