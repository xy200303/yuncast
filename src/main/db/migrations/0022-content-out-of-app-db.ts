import type { Migration } from '../types'

/**
 * v22 · 内容全部迁进项目库（`<目录>/project.db`）。
 *
 * 应用库从这一版起只装全局数据：设置/凭据、音色库、供应商接入、用量、blob 存储、项目清单。
 * 旧库里遗留的业务表与数据**直接删除**（没有生产数据，不做迁移、不留兼容层）。
 */
const CONTENT_TABLES = [
  'scripts',
  'session_configs',
  'draft_units',
  'pool_items',
  'live_sessions',
  'broadcast_events',
  'director_sessions',
  'director_timeline',
  'viewer_profiles',
  'event_log',
  'personas',
  'materials',
  'material_files'
]

export const migration: Migration = {
  name: '0022-content-out-of-app-db',
  version: 22,
  up: (db) => {
    for (const table of CONTENT_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}
