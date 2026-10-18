import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v3 · 用量与成本采集：两张记录表 + event_log 绑节目列 + 接入的模型单价列。
 * 都是纯增量：全新库由建表后的 CREATE IF NOT EXISTS / ensureColumn 兜底，这里管老库抬升。
 */
export const migration: Migration = {
  name: '0003-usage-tables',
  version: 3,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        program_id TEXT,
        persona_id TEXT NOT NULL DEFAULT '',
        connection_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'chat',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        estimated INTEGER NOT NULL DEFAULT 0,
        cost REAL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tts_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        program_id TEXT,
        connection_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        voice_id TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL DEFAULT 0,
        cost REAL
      )
    `)
    if (hasTable(db, 'event_log')) ensureColumn(db, 'event_log', 'program_id', 'TEXT')
    ensureColumn(db, 'model_connections', 'model_prices', "TEXT NOT NULL DEFAULT '{}'")

    // 校验：v3 产物必须都在
    for (const table of ['usage_records', 'tts_records']) {
      if (!hasTable(db, table)) throw new Error(`v3 迁移后 ${table} 表不存在`)
    }
    if (hasTable(db, 'event_log') && !columnsOf(db, 'event_log').has('program_id')) {
      throw new Error('event_log.program_id 迁移后仍不存在')
    }
  }
}
