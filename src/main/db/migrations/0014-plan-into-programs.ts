import type { Migration } from '../types'
import { columnsOf, hasTable, parseJson, str } from '../helpers'

/**
 * v14 · 编排并入节目：programs.plan 存场景序列，script_id 与 scripts 表退役。
 * 无人引用的历史剧本在节目删除时导出留底（见 ScriptService），这里只管把在用场景搬进来。
 */
export const migration: Migration = {
  name: '0014-plan-into-programs',
  version: 14,
  up: (db) => {
    if (!hasTable(db, 'programs')) return
    if (!columnsOf(db, 'programs').has('plan')) {
      db.exec(`ALTER TABLE programs ADD COLUMN plan TEXT NOT NULL DEFAULT '{"scenes":[]}'`)
    }
    if (hasTable(db, 'scripts') && columnsOf(db, 'programs').has('script_id')) {
      const rows = db.prepare('SELECT id, script_id FROM programs').all() as Record<string, unknown>[]
      const getScenes = db.prepare('SELECT scenes FROM scripts WHERE id = ?')
      const update = db.prepare('UPDATE programs SET plan = ? WHERE id = ?')
      for (const row of rows) {
        const scriptId = str(row.script_id)
        if (!scriptId) continue
        const hit = getScenes.get(scriptId) as Record<string, unknown> | undefined
        if (!hit) continue
        update.run(JSON.stringify({ scenes: parseJson(hit.scenes, []) }), str(row.id))
      }
    }
    if (columnsOf(db, 'programs').has('script_id')) {
      db.exec('ALTER TABLE programs DROP COLUMN script_id')
    }
    db.exec('DROP TABLE IF EXISTS scripts')
  }
}
