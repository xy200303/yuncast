import type { Migration } from '../types'
import { columnsOf, hasTable } from '../helpers'

/**
 * v5 · 字段改造：删掉主播卡的废弃列（大脑/角色/当前出镜时代的残留），
 * 并把与新表名不一致的列改名（session_id→live_session_id、source_agent_id→source_actor_id、
 * origin_utterance_id→origin_draft_unit_id，pool_items 与 broadcast_events 同步）。
 */
export const migration: Migration = {
  name: '0005-persona-columns',
  version: 5,
  up: (db) => {
    if (hasTable(db, 'personas')) {
      const personaCols = columnsOf(db, 'personas')
      for (const col of ['roles', 'active', 'model_connection_id', 'model']) {
        if (personaCols.has(col)) db.exec(`ALTER TABLE personas DROP COLUMN ${col}`)
      }
    }
    const renameColumn = (table: string, from: string, to: string) => {
      if (!hasTable(db, table)) return
      const cols = columnsOf(db, table)
      if (cols.has(from) && !cols.has(to)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
    }
    renameColumn('pool_items', 'session_id', 'live_session_id')
    renameColumn('pool_items', 'source_agent_id', 'source_actor_id')
    renameColumn('pool_items', 'origin_utterance_id', 'origin_draft_unit_id')
    renameColumn('broadcast_events', 'session_id', 'live_session_id')
    db.exec('DROP INDEX IF EXISTS broadcast_events_session')
  }
}
