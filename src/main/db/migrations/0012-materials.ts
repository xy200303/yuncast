import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable, parseJson, str } from '../helpers'

/**
 * v12 · 素材统一：products → materials（条目），knowledge_files → material_files（附属于条目）；
 * programs.knowledge_scope 的 products 键 → materials。
 */
export const migration: Migration = {
  name: '0012-materials',
  version: 12,
  up: (db) => {
    if (hasTable(db, 'products') && !hasTable(db, 'materials')) {
      db.exec('ALTER TABLE products RENAME TO materials')
    }
    if (hasTable(db, 'knowledge_files') && !hasTable(db, 'material_files')) {
      db.exec('ALTER TABLE knowledge_files RENAME TO material_files')
    }
    ensureColumn(db, 'material_files', 'material_id', "TEXT NOT NULL DEFAULT ''")
    if (!hasTable(db, 'programs') || !columnsOf(db, 'programs').has('knowledge_scope')) return
    const rows = db.prepare('SELECT id, knowledge_scope FROM programs').all() as Record<string, unknown>[]
    const update = db.prepare('UPDATE programs SET knowledge_scope = ? WHERE id = ?')
    for (const row of rows) {
      const scope = parseJson<Record<string, unknown>>(row.knowledge_scope, {})
      if ('products' in scope || !('materials' in scope)) {
        update.run(JSON.stringify({ materials: scope.products ?? '*', files: scope.files ?? '*' }), str(row.id))
      }
    }
  }
}
