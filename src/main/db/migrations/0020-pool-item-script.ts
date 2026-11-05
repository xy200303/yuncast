import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v20 · 话术池归属（docs/12 §13 状态机）：`pool_items.script_id`。
 *
 * 以前池是全局的：开播时 `poolItemRestampActive` 把「所有活跃条目」改挂到新场次，
 * 上一本剧本的存货会被算到这一场里（串台），历史里也会出现别人的话术。
 * 现在每条入池条目记下它属于哪本剧本；开播只重挂/播放本剧本的条目，别的一律跳过。
 */
export const migration: Migration = {
  name: '0020-pool-item-script',
  version: 20,
  up: (db) => {
    if (!hasTable(db, 'pool_items')) return
    ensureColumn(db, 'pool_items', 'script_id', "TEXT NOT NULL DEFAULT ''")
    // 存量：能从场次反查的按场次归属回填；查不到的（从没开播）留空，开播时会被当成外来条目跳过
    if (
      hasTable(db, 'live_sessions') &&
      columnsOf(db, 'live_sessions').has('script_id') &&
      columnsOf(db, 'pool_items').has('live_session_id')
    ) {
      db.exec(`
        UPDATE pool_items
           SET script_id = COALESCE((
             SELECT s.script_id FROM live_sessions s WHERE s.id = pool_items.live_session_id
           ), '')
         WHERE script_id = ''
      `)
    }
    if (!columnsOf(db, 'pool_items').has('script_id')) {
      throw new Error('v20 迁移后 pool_items.script_id 不存在')
    }
  }
}
