import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable, parseJson, str } from '../helpers'

/**
 * v15 · 素材支持正文与链接附件；节目的素材范围只留 materials（附件随条目走）。
 * 顺序上排在 v12 之后：v12 才把 products 改名成 materials，先跑 15 会看不到表。
 */
export const migration: Migration = {
  name: '0015-material-content',
  version: 15,
  up: (db) => {
    ensureColumn(db, 'materials', 'content', "TEXT NOT NULL DEFAULT ''")
    ensureColumn(db, 'material_files', 'type', "TEXT NOT NULL DEFAULT 'file'")
    ensureColumn(db, 'material_files', 'url', "TEXT NOT NULL DEFAULT ''")
    if (!hasTable(db, 'programs') || !columnsOf(db, 'programs').has('knowledge_scope')) return
    const rows = db.prepare('SELECT id, knowledge_scope FROM programs').all() as Record<string, unknown>[]
    const update = db.prepare('UPDATE programs SET knowledge_scope = ? WHERE id = ?')
    for (const row of rows) {
      const scope = parseJson<{ materials?: unknown }>(row.knowledge_scope, {})
      update.run(JSON.stringify({ materials: scope.materials ?? '*' }), str(row.id))
    }
  }
}
