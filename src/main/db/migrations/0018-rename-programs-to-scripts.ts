import type { Migration } from '../types'
import { columnsOf, hasTable } from '../helpers'

/**
 * v18 · 资产表改名（docs/12 §17）：`programs` → `scripts`，所有外键列 `program_id` → `script_id`。
 *
 * 这是纯命名迁移，不搬数据、不改形状：
 * - 资产本身（场次、写稿语言、素材范围、风格指令）原样保留；
 * - 场次记录、本场配置、话术库、导演会话/时间线、事件日志、用量表的归属列一起改；
 * - 旧索引连带重建为 `*_script`，不留 `*_program` 的影子。
 */
export const migration: Migration = {
  name: '0018-rename-programs-to-scripts',
  version: 18,
  up: (db) => {
    if (hasTable(db, 'programs')) {
      if (!hasTable(db, 'scripts')) {
        db.exec('ALTER TABLE programs RENAME TO scripts')
      } else {
        // 极老的库里可能还留着 v14 之前那张 legacy scripts；空表就让位，非空拒绝迁移
        const legacyRows = Number(
          (db.prepare('SELECT COUNT(*) AS c FROM scripts').get() as { c?: number } | undefined)?.c ?? 0
        )
        if (legacyRows > 0) throw new Error('0018 迁移冲突：programs 与 scripts 同时存在且 scripts 非空')
        db.exec('DROP TABLE scripts')
        db.exec('ALTER TABLE programs RENAME TO scripts')
      }
    }

    const tables = [
      'draft_units',
      'live_sessions',
      'session_configs',
      'director_sessions',
      'director_timeline',
      'event_log',
      'usage_records',
      'tts_records'
    ]
    for (const table of tables) {
      if (!hasTable(db, table)) continue
      const cols = columnsOf(db, table)
      if (cols.has('program_id') && !cols.has('script_id')) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN program_id TO script_id`)
      }
    }

    const indexes: { oldName: string; table: string; columns: string[]; sql: string }[] = [
      {
        oldName: 'draft_units_program',
        table: 'draft_units',
        columns: ['script_id', 'scene_id', 'status'],
        sql: 'CREATE INDEX IF NOT EXISTS draft_units_script ON draft_units(script_id, scene_id, status)'
      },
      {
        oldName: 'session_configs_program',
        table: 'session_configs',
        columns: ['script_id', 'created_at'],
        sql: 'CREATE INDEX IF NOT EXISTS session_configs_script ON session_configs(script_id, created_at DESC)'
      },
      {
        oldName: 'live_sessions_program',
        table: 'live_sessions',
        columns: ['script_id', 'started_at'],
        sql: 'CREATE INDEX IF NOT EXISTS live_sessions_script ON live_sessions(script_id, started_at)'
      },
      {
        oldName: 'usage_records_program',
        table: 'usage_records',
        columns: ['script_id', 'ts'],
        sql: 'CREATE INDEX IF NOT EXISTS usage_records_script ON usage_records(script_id, ts)'
      },
      {
        oldName: 'tts_records_program',
        table: 'tts_records',
        columns: ['script_id', 'ts'],
        sql: 'CREATE INDEX IF NOT EXISTS tts_records_script ON tts_records(script_id, ts)'
      }
    ]
    for (const index of indexes) {
      db.exec(`DROP INDEX IF EXISTS ${index.oldName}`)
      if (!hasTable(db, index.table)) continue
      const cols = columnsOf(db, index.table)
      if (index.columns.every((column) => cols.has(column))) db.exec(index.sql)
    }

    if (hasTable(db, 'programs')) throw new Error('v18 迁移后 programs 表仍然存在')
    for (const table of tables) {
      if (hasTable(db, table) && columnsOf(db, table).has('program_id')) {
        throw new Error(`v18 迁移后 ${table}.program_id 仍然存在`)
      }
    }
  }
}
