import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v1 · 节目化改造（docs/10 §9.4，破坏性，一次性）：事务内直接得到最终表结构，不留兼容分支。
 * live_plans → programs（复制仍有价值的字段，节目新字段给默认值，mode_id/voice_id/planned_minutes/
 * gen_config/style_hint 随之入土）；plan_sessions → program_sessions；
 * utterances/director_timeline 的 plan_id 列改名 program_id；modes 表删除。
 * 迁完用 PRAGMA table_info 校验旧表旧列不存在，不一致直接抛错（启动失败好过脏结构）。
 */
export const migration: Migration = {
  name: '0001-programize',
  version: 1,
  up: (db) => {
    if (hasTable(db, 'live_plans')) {
      // 老库的 knowledge_scope 列是后期补的，补不齐就没法复制（其余列自首版就有）
      ensureColumn(db, 'live_plans', 'knowledge_scope', "TEXT NOT NULL DEFAULT '{}'")
      db.exec(`
        CREATE TABLE programs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          theme TEXT NOT NULL DEFAULT '',
          content_type TEXT NOT NULL DEFAULT 'solo',
          broadcast_mode TEXT NOT NULL DEFAULT 'rolling',
          finish_mode TEXT NOT NULL DEFAULT 'loop',
          allow_live_events INTEGER NOT NULL DEFAULT 1,
          enabled_trigger_ids TEXT NOT NULL DEFAULT '[]',
          script_id TEXT,
          knowledge_scope TEXT NOT NULL DEFAULT '{}',
          current_scene_idx INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        INSERT INTO programs (id, name, theme, script_id, current_scene_idx, knowledge_scope, created_at, updated_at)
        SELECT id, name, theme, script_id, current_scene_idx, knowledge_scope, created_at, updated_at FROM live_plans
      `)
      db.exec('DROP TABLE live_plans')
    }
    if (hasTable(db, 'plan_sessions')) {
      db.exec(`
        CREATE TABLE program_sessions (
          program_id TEXT PRIMARY KEY,
          purpose TEXT NOT NULL DEFAULT 'prep',
          entries TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(
        'INSERT INTO program_sessions (program_id, purpose, entries, updated_at) SELECT plan_id, purpose, entries, updated_at FROM plan_sessions'
      )
      db.exec('DROP TABLE plan_sessions')
    }
    // 外键列 plan_id → program_id（SQLite ≥ 3.25 的 RENAME COLUMN，索引定义随列自动改）
    if (hasTable(db, 'utterances') && columnsOf(db, 'utterances').has('plan_id')) {
      db.exec('ALTER TABLE utterances RENAME COLUMN plan_id TO program_id')
    }
    if (hasTable(db, 'director_timeline') && columnsOf(db, 'director_timeline').has('plan_id')) {
      db.exec('ALTER TABLE director_timeline RENAME COLUMN plan_id TO program_id')
    }
    // 直播模式预设包整体退役
    if (hasTable(db, 'modes')) db.exec('DROP TABLE modes')

    // 校验：旧表旧列必须不存在
    for (const table of ['live_plans', 'plan_sessions', 'modes']) {
      if (hasTable(db, table)) throw new Error(`旧表 ${table} 迁移后仍存在`)
    }
    if (hasTable(db, 'programs')) {
      const legacy = ['mode_id', 'voice_id', 'planned_minutes', 'gen_config', 'style_hint'].filter((column) =>
        columnsOf(db, 'programs').has(column)
      )
      if (legacy.length > 0) throw new Error(`programs 残留旧列：${legacy.join(', ')}`)
    }
    for (const table of ['utterances', 'director_timeline']) {
      if (hasTable(db, table) && columnsOf(db, table).has('plan_id')) throw new Error(`${table}.plan_id 迁移后仍存在`)
    }
  }
}
