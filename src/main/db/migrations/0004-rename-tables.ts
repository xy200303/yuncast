import type { Migration } from '../types'
import { hasTable } from '../helpers'

/**
 * v4 · 底层表名改造：agents→personas / utterances→draft_units / speech_items→pool_items /
 * model_connections→llm_connections / program_sessions→director_sessions /
 * broadcast_sessions→live_sessions。
 */
export const migration: Migration = {
  name: '0004-rename-tables',
  version: 4,
  up: (db) => {
    const renames: [string, string][] = [
      ['agents', 'personas'],
      ['utterances', 'draft_units'],
      ['speech_items', 'pool_items'],
      ['model_connections', 'llm_connections'],
      ['program_sessions', 'director_sessions'],
      ['broadcast_sessions', 'live_sessions']
    ]
    // 只对「真的改了名」的表做校验：全新库（还没有这些表）走到这里应该是空转，
    // 以前无条件断言目标表存在，结果全新安装死在 v4（升级上来的老库反而没事）
    const renamed: [string, string][] = []
    for (const [from, to] of renames) {
      if (hasTable(db, from) && !hasTable(db, to)) {
        db.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
        renamed.push([from, to])
      }
    }
    // 旧索引名跟着表走会保留旧名：删掉，由建表时的 CREATE INDEX 用新名重建
    for (const index of ['speech_items_status', 'utterances_program', 'utterances_plan', 'broadcast_sessions_program']) {
      db.exec(`DROP INDEX IF EXISTS ${index}`)
    }
    for (const [, to] of renamed) {
      if (!hasTable(db, to)) throw new Error(`v4 迁移后 ${to} 表不存在`)
    }
  }
}
