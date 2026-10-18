import type { Migration } from '../types'
import { columnsOf, hasTable, parseJson, str } from '../helpers'

/**
 * v7 · 节目不再存声音配置：audio_config 列里的 instruction 提到顶层 instruction 列，然后整列删除。
 * 迁移跑在建表之前，instruction 列要先补上。
 */
export const migration: Migration = {
  name: '0007-program-instruction',
  version: 7,
  up: (db) => {
    if (!hasTable(db, 'programs')) return
    const cols = columnsOf(db, 'programs')
    if (!cols.has('instruction')) db.exec('ALTER TABLE programs ADD COLUMN instruction TEXT')
    if (!cols.has('audio_config')) return
    const rows = db.prepare('SELECT id, audio_config FROM programs').all() as Record<string, unknown>[]
    const update = db.prepare('UPDATE programs SET instruction = ? WHERE id = ?')
    for (const row of rows) {
      const cfg = parseJson<{ instruction?: string }>(row.audio_config, {})
      const instruction = typeof cfg.instruction === 'string' ? cfg.instruction.trim() : ''
      if (instruction) update.run(instruction, str(row.id))
    }
    db.exec('ALTER TABLE programs DROP COLUMN audio_config')
  }
}
