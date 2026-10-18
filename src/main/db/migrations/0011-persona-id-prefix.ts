import type { Migration } from '../types'
import { columnsOf, hasTable } from '../helpers'

/**
 * v11 · id 前缀去掉历史品牌：主播卡 id `anchor-*` → `persona-*`。
 * 主播卡 id 是外部可见的稳定寻址（节目卡司、底稿归属、对话时间线、场次快照都存着它），
 * 所以一次把库里所有引用一起改写，不只是 personas.id。
 */
export const migration: Migration = {
  name: '0011-persona-id-prefix',
  version: 11,
  up: (db) => {
    const rewrite = (table: string, column: string, quoted = false): void => {
      if (!hasTable(db, table) || !columnsOf(db, table).has(column)) return
      const col = quoted ? `"${column}"` : column
      db.prepare(`UPDATE ${table} SET ${col} = REPLACE(${col}, 'anchor-', 'persona-') WHERE ${col} LIKE '%anchor-%'`).run()
    }
    rewrite('personas', 'id')
    rewrite('programs', 'persona_ids')
    rewrite('draft_units', 'persona_id')
    rewrite('director_timeline', 'payload')
    rewrite('director_sessions', 'entries')

    // 场次卡司快照列跟着改名：cast 是 SQL 关键字，之前一直带引号用，这里一并正名
    if (hasTable(db, 'live_sessions')) {
      const cols = columnsOf(db, 'live_sessions')
      if (cols.has('cast')) rewrite('live_sessions', 'cast', true)
      rewrite('live_sessions', 'personas')
      if (cols.has('cast') && !cols.has('personas')) {
        db.exec('ALTER TABLE live_sessions RENAME COLUMN "cast" TO personas')
      }
    }
  }
}
