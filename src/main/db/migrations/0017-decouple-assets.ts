import type { Migration } from '../types'
import { columnsOf, ensureColumn, hasTable } from '../helpers'

/**
 * v17 · 资产解耦（docs/12 §2 / §17）：本场是唯一的绑定处，资产之间零引用。
 *
 * - 主播卡删掉 `voice_id` / `default_voice_id`：嗓子只属于本场，不再有"卡上默认音色"。
 * - 节目删掉 `finish_mode` / `allow_live_events` / `enabled_trigger_ids` / `persona_ids`：
 *   收尾、互动、触发器、出镜人选全部搬进本场配置；节目只描述内容结构。
 * - 本场配置补齐三个正交开关、互动开关与 `cast`（主播 × 音色 × 主主播），
 *   旧的 `persona_voices` 一对一搬进 `cast`，第一张卡标主主播。
 * - 话术池删掉 `language_type`：语言只体现在文本里，不再作为 TTS 参数。
 *
 * 破坏性：旧列直接丢弃，不保留兼容列。项目没有生产数据，升级即最终结构。
 */
export const migration: Migration = {
  name: '0017-decouple-assets',
  version: 17,
  up: (db) => {
    if (hasTable(db, 'personas')) {
      // 远古库的 personas 可能只有 id/name：先把要保留的列补齐，再整表重建
      for (const [column, definition] of [
        ['personality', "TEXT NOT NULL DEFAULT ''"],
        ['catchphrases', "TEXT NOT NULL DEFAULT ''"],
        ['background', "TEXT NOT NULL DEFAULT ''"],
        ['taboos', "TEXT NOT NULL DEFAULT ''"],
        ['updated_at', 'INTEGER NOT NULL DEFAULT 0']
      ] as const) {
        ensureColumn(db, 'personas', column, definition)
      }
      const cols = columnsOf(db, 'personas')
      if (cols.has('voice_id') || cols.has('default_voice_id')) {
        db.exec('DROP TABLE IF EXISTS personas_v17')
        db.exec(`
          CREATE TABLE personas_v17 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            personality TEXT NOT NULL DEFAULT '',
            catchphrases TEXT NOT NULL DEFAULT '',
            background TEXT NOT NULL DEFAULT '',
            taboos TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
          )
        `)
        db.exec(`
          INSERT INTO personas_v17 (id, name, personality, catchphrases, background, taboos, updated_at)
          SELECT id, name, personality, catchphrases, background, taboos, updated_at FROM personas
        `)
        db.exec('DROP TABLE personas')
        db.exec('ALTER TABLE personas_v17 RENAME TO personas')
      }
    }

    if (hasTable(db, 'programs')) {
      // 远古库可能缺后来才加的列：先补齐，整表重建的 SELECT 才有稳定的列可读
      for (const [column, definition] of [
        ['theme', "TEXT NOT NULL DEFAULT ''"],
        ['content_type', "TEXT NOT NULL DEFAULT 'solo'"],
        ['broadcast_mode', "TEXT NOT NULL DEFAULT 'rolling'"],
        ['instruction', 'TEXT'],
        ['language', "TEXT NOT NULL DEFAULT 'auto'"],
        ['plan', "TEXT NOT NULL DEFAULT '{\"scenes\":[]}'"],
        ['knowledge_scope', "TEXT NOT NULL DEFAULT '{}'"],
        ['current_scene_idx', 'INTEGER NOT NULL DEFAULT 0'],
        ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['updated_at', 'INTEGER NOT NULL DEFAULT 0']
      ] as const) {
        ensureColumn(db, 'programs', column, definition)
      }
      const cols = columnsOf(db, 'programs')
      if (cols.has('persona_ids') || cols.has('finish_mode') || cols.has('allow_live_events')) {
        db.exec('DROP TABLE IF EXISTS programs_v17')
        db.exec(`
          CREATE TABLE programs_v17 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            theme TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT 'solo',
            broadcast_mode TEXT NOT NULL DEFAULT 'rolling',
            instruction TEXT,
            language TEXT NOT NULL DEFAULT 'auto',
            plan TEXT NOT NULL DEFAULT '{"scenes":[]}',
            knowledge_scope TEXT NOT NULL DEFAULT '{}',
            current_scene_idx INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        db.exec(`
          INSERT INTO programs_v17
            (id, name, theme, content_type, broadcast_mode, instruction, language, plan,
             knowledge_scope, current_scene_idx, created_at, updated_at)
          SELECT id, name, theme, content_type, broadcast_mode, instruction, language,
                 COALESCE(plan, '{"scenes":[]}'),
                 COALESCE(knowledge_scope, '{}'), COALESCE(current_scene_idx, 0), created_at, updated_at
          FROM programs
        `)
        db.exec('DROP TABLE programs')
        db.exec('ALTER TABLE programs_v17 RENAME TO programs')
      }
    }

    if (hasTable(db, 'session_configs')) {
      const cols = columnsOf(db, 'session_configs')
      if (!cols.has('cast') || cols.has('persona_voices')) {
        const legacyPairs = cols.has('persona_voices')
          ? (db.prepare('SELECT id, persona_voices FROM session_configs').all() as Record<string, unknown>[])
          : []
        const castOf = (id: string): string => {
          const row = legacyPairs.find((item) => String(item.id) === id)
          if (!row) return '[]'
          try {
            const pairs = JSON.parse(String(row.persona_voices ?? '[]')) as { personaId?: string; voiceId?: string }[]
            return JSON.stringify(
              pairs
                .filter((pair) => pair.personaId)
                .map((pair, index) => ({
                  personaId: String(pair.personaId),
                  voiceId: String(pair.voiceId ?? ''),
                  lead: index === 0
                }))
            )
          } catch {
            return '[]'
          }
        }
        db.exec('DROP TABLE IF EXISTS session_configs_v17')
        db.exec(`
          CREATE TABLE session_configs_v17 (
            id TEXT PRIMARY KEY,
            program_id TEXT NOT NULL,
            language TEXT NOT NULL DEFAULT 'Chinese',
            preset TEXT NOT NULL DEFAULT '',
            content_source TEXT NOT NULL DEFAULT 'script',
            synth_mode TEXT NOT NULL DEFAULT 'async',
            end_mode TEXT NOT NULL DEFAULT 'loop',
            audio_policy TEXT NOT NULL DEFAULT 'reuse',
            allow_live_events INTEGER NOT NULL DEFAULT 1,
            enabled_trigger_ids TEXT NOT NULL DEFAULT '[]',
            cast TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
          )
        `)
        const rows = db.prepare('SELECT * FROM session_configs').all() as Record<string, unknown>[]
        const insert = db.prepare(
          `INSERT INTO session_configs_v17
             (id, program_id, language, preset, content_source, synth_mode, end_mode, audio_policy,
              allow_live_events, enabled_trigger_ids, cast, created_at)
           VALUES (?, ?, ?, ?, 'script', ?, ?, ?, 1, '[]', ?, ?)`
        )
        for (const row of rows) {
          insert.run(
            String(row.id),
            String(row.program_id),
            String(row.language ?? 'Chinese'),
            String(row.preset ?? ''),
            String(row.synth_mode ?? 'async'),
            String(row.end_mode ?? 'loop'),
            String(row.audio_policy ?? 'reuse'),
            castOf(String(row.id)),
            Number(row.created_at ?? Date.now())
          )
        }
        db.exec('DROP TABLE session_configs')
        db.exec('ALTER TABLE session_configs_v17 RENAME TO session_configs')
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS session_configs_program ON session_configs(program_id, created_at DESC)')

    if (hasTable(db, 'pool_items') && columnsOf(db, 'pool_items').has('language_type')) {
      db.exec('ALTER TABLE pool_items DROP COLUMN language_type')
    }

    // 校验：解耦后的产物必须都在
    if (hasTable(db, 'personas') && columnsOf(db, 'personas').has('voice_id')) {
      throw new Error('v17 迁移后 personas.voice_id 仍然存在')
    }
    if (hasTable(db, 'programs') && columnsOf(db, 'programs').has('persona_ids')) {
      throw new Error('v17 迁移后 programs.persona_ids 仍然存在')
    }
    if (hasTable(db, 'session_configs') && !columnsOf(db, 'session_configs').has('cast')) {
      throw new Error('v17 迁移后 session_configs.cast 不存在')
    }
  }
}
