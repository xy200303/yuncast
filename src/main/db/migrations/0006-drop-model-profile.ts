import type { Migration } from '../types'
import { columnsOf, hasTable } from '../helpers'

/** v6 · 最后一个死列：model_profile_id 是更早的「模型档案」残留，代码零引用 */
export const migration: Migration = {
  name: '0006-drop-model-profile',
  version: 6,
  up: (db) => {
    if (hasTable(db, 'personas') && columnsOf(db, 'personas').has('model_profile_id')) {
      db.exec('ALTER TABLE personas DROP COLUMN model_profile_id')
    }
  }
}
