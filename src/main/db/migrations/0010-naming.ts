import type { Migration } from '../types'
import { columnsOf, hasTable } from '../helpers'

/**
 * v10 · 命名收口：主播卡列名 presenter_* → persona_*；
 * blob 引用类型跟着新实体名（utterance → draft_unit / speech_item → pool_item /
 * utterance_rendered → draft_unit_rendered）。
 */
export const migration: Migration = {
  name: '0010-naming',
  version: 10,
  up: (db) => {
    const renameCol = (table: string, from: string, to: string) => {
      if (!hasTable(db, table)) return
      const cols = columnsOf(db, table)
      if (cols.has(from) && !cols.has(to)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
    }
    renameCol('programs', 'presenter_ids', 'persona_ids')
    renameCol('draft_units', 'presenter_id', 'persona_id')
    if (hasTable(db, 'blob_refs')) {
      const kindMap: [string, string][] = [
        ['utterance', 'draft_unit'],
        ['speech_item', 'pool_item'],
        ['utterance_rendered', 'draft_unit_rendered']
      ]
      const update = db.prepare('UPDATE blob_refs SET owner_kind = ? WHERE owner_kind = ?')
      for (const [from, to] of kindMap) update.run(to, from)
    }
  }
}
