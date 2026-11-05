import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v19 · 剧本资产瘦身（docs/12 §3）：
 *
 * 剧本只描述结构——名称 / 简介 / 场次序列 / 素材范围。
 * 原来挂在资产上的「内容形态、播出方式、写稿语言、风格指令」都属于本场：
 * - 内容形态 / 风格指令搬进 session_configs（`content_type` / `instruction`），
 * - 写稿语言只留本场（session_configs.language），资产上的 `language` 删除，
 * - 播出方式由本场的「内容来源 + 合成时机 + 收尾」三个开关推导，资产上的 `broadcast_mode` 删除。
 *
 * 升级时把每个剧本当前的这些值回填到它最近一次本场配置，历史配置也补上同一套值；
 * 之后资产不再携带它们。破坏性：旧列直接丢弃。
 */
export const migration: Migration = {
  name: '0019-script-structure-only',
  version: 19,
  up: (db) => {
    if (hasTable(db, 'session_configs')) {
      ensureColumn(db, 'session_configs', 'content_type', "TEXT NOT NULL DEFAULT 'solo'")
      ensureColumn(db, 'session_configs', 'instruction', "TEXT NOT NULL DEFAULT ''")
      if (hasTable(db, 'scripts')) {
        const cols = columnsOf(db, 'scripts')
        // 从没开播过的剧本没有本场配置：先补一条空卡司的本场行，把语言/形态/风格带过去，
        // 否则丢列时这些用户设置会一起消失。开播时仍要重新走一遍开播配置。
        const language = cols.has('language') ? "COALESCE(NULLIF(language, ''), 'Chinese')" : "'Chinese'"
        const contentType = cols.has('content_type') ? "COALESCE(NULLIF(content_type, ''), 'solo')" : "'solo'"
        const instruction = cols.has('instruction') ? "COALESCE(instruction, '')" : "''"
        // 旧播出方式 → 本场两个开关：prepared→预合成，improvised→无限生成+实时，rolling→边播边合
        const contentSource = cols.has('broadcast_mode')
          ? "CASE WHEN broadcast_mode = 'improvised' THEN 'infinite' ELSE 'script' END"
          : "'script'"
        const synthMode = cols.has('broadcast_mode')
          ? "CASE WHEN broadcast_mode = 'prepared' THEN 'pre' WHEN broadcast_mode = 'improvised' THEN 'realtime' ELSE 'async' END"
          : "'async'"
        db.exec(`
          INSERT INTO session_configs
            (id, script_id, language, content_type, instruction, preset, content_source, synth_mode,
             end_mode, audio_policy, allow_live_events, enabled_trigger_ids, cast, created_at)
          SELECT 'session-migrate-' || id, id, ${language}, ${contentType}, ${instruction}, '',
                 ${contentSource}, ${synthMode}, 'loop', 'reuse', 1, '[]', '[]', updated_at
            FROM scripts
           WHERE NOT EXISTS (SELECT 1 FROM session_configs c WHERE c.script_id = scripts.id)
        `)
        if (cols.has('content_type')) {
          db.exec(`
            UPDATE session_configs
               SET content_type = COALESCE(NULLIF(content_type, ''), (
                     SELECT s.content_type FROM scripts s WHERE s.id = session_configs.script_id
                   ), 'solo')
          `)
        }
        if (cols.has('instruction')) {
          db.exec(`
            UPDATE session_configs
               SET instruction = COALESCE(NULLIF(instruction, ''), (
                     SELECT s.instruction FROM scripts s WHERE s.id = session_configs.script_id
                   ), '')
          `)
        }
      }
    }

    if (hasTable(db, 'scripts')) {
      for (const column of ['content_type', 'broadcast_mode', 'instruction', 'language']) {
        if (columnsOf(db, 'scripts').has(column)) db.exec(`ALTER TABLE scripts DROP COLUMN ${column}`)
      }
    }

    if (hasTable(db, 'scripts')) {
      for (const column of ['content_type', 'broadcast_mode', 'instruction', 'language']) {
        if (columnsOf(db, 'scripts').has(column)) throw new Error(`v19 迁移后 scripts.${column} 仍然存在`)
      }
    }
    if (hasTable(db, 'session_configs') && !columnsOf(db, 'session_configs').has('content_type')) {
      throw new Error('v19 迁移后 session_configs.content_type 不存在')
    }
  }
}
