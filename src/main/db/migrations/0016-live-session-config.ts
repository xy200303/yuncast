import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v16 · 直播台改造的地基（docs/12）：
 *
 * 1. 主播卡不再"自带音色"：`personas.default_voice_id` 承接原来的 `voice_id`，只当默认建议用；
 *    真正的出镜与嗓音在开播配置（本场）里定。`voice_id` 列暂时保留，等 UI 全部切到本场绑定后
 *    再由下一版迁移删掉——这样升级与回退都安全。
 * 2. 话术条目加中文对照 `text_zh`：外语节目播出时下面能看到这句中文说的是什么（双语显示）。
 * 3. 新建 `session_configs`：本场绑定的落库位置（节目 / 主播→音色 / 语言 / 合成时机 / 收尾 / 音频策略）。
 *
 * 只加列不删列、只建表不改表：老库升上来数据一行不动。
 */
export const migration: Migration = {
  name: '0016-live-session-config',
  version: 16,
  up: (db) => {
    // ① 主播的默认音色建议
    ensureColumn(db, 'personas', 'default_voice_id', "TEXT NOT NULL DEFAULT ''")
    if (hasTable(db, 'personas') && columnsOf(db, 'personas').has('voice_id')) {
      db.exec("UPDATE personas SET default_voice_id = voice_id WHERE default_voice_id = ''")
    }

    // ② 话术条目的中文对照
    ensureColumn(db, 'draft_units', 'text_zh', "TEXT NOT NULL DEFAULT ''")
    if (hasTable(db, 'pool_items')) ensureColumn(db, 'pool_items', 'text_zh', "TEXT NOT NULL DEFAULT ''")

    // ③ 本场配置
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_configs (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto',
        preset TEXT NOT NULL DEFAULT '',
        synth_mode TEXT NOT NULL DEFAULT 'async',
        end_mode TEXT NOT NULL DEFAULT 'loop',
        audio_policy TEXT NOT NULL DEFAULT 'reuse',
        persona_voices TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS session_configs_program ON session_configs(program_id, created_at DESC)')

    // 校验：产物必须都在，且数据没被清空
    if (!hasTable(db, 'session_configs')) throw new Error('v16 迁移后 session_configs 表不存在')
    // 全新库这时还没有业务表（由 init 建表兜底），只在表存在时校验列
    if (hasTable(db, 'personas') && !columnsOf(db, 'personas').has('default_voice_id')) {
      throw new Error('v16 迁移后 personas.default_voice_id 不存在')
    }
    if (hasTable(db, 'draft_units') && !columnsOf(db, 'draft_units').has('text_zh')) {
      throw new Error('v16 迁移后 draft_units.text_zh 不存在')
    }
  }
}
