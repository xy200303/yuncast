/**
 * 迁移器自检（不需要起 Electron）。
 *
 *   node scripts/db-migrate-check.mjs
 *
 * 四个场景各跑一遍，任何一条不符合就退出码非 0：
 *   A 全新库      —— 12 条全跑、版本落最新、再跑空转（业务表由 StorageService.init 的建表兜底，
 *                    迁移器不负责建新库，这里顺便把这条约束也钉住）
 *   B 现役库副本  —— 复制一份正在用的库（v15）：应当 0 条执行、结构不动、只补基线
 *   C 远古库(v11) —— 旧表名现造一个：验证 v12 改名 → v14 编排 → v15 补列这条链（曾经顺序错就漏列）
 *   D 远古库(v6)  —— 带 audio_config 的节目：验证 v7 把 instruction 摘出来、并继续往后抬到最新
 *
 * 脚本自己用 esbuild 把 src/main/db 打成一个临时 CJS 再跑，不进 out/，跑完删掉。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'yuncast-migrate-'))
const bundle = join(work, 'migrator.cjs')
const entry = join(work, 'entry.ts')

// 打一个只含迁移器的包：入口在临时目录，导入用绝对路径
writeFileSync(entry, `export { runMigrations } from '${join(root, 'src/main/db/migrator').replace(/\\/g, '/')}'\n`)
execFileSync(
  process.execPath,
  [join(root, 'node_modules/esbuild/bin/esbuild'), entry, '--bundle', '--platform=node', '--format=cjs', '--outfile=' + bundle],
  { stdio: 'inherit', cwd: root }
)
const { runMigrations } = await import('file://' + bundle.replace(/\\/g, '/'))

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

const tableExists = (db, table) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
const userVersion = (db) => Number(db.prepare('PRAGMA user_version').get().user_version ?? 0)
const migrationRows = (db) => db.prepare('SELECT COUNT(*) c FROM _migrations').get().c

// ---------- A 全新库 ----------
{
  console.log('\n[A] 全新库')
  const db = new DatabaseSync(join(work, 'fresh.db'))
  db.exec('PRAGMA journal_mode = WAL')
  const report = await runMigrations(db)
  const total = report.applied.length
  check('执行了全部迁移', total >= 17, report.applied.join(','))
  check('结构版本最新', report.version === 22 && userVersion(db) === 22, `user_version=${userVersion(db)}`)
  check('执行记录落表', migrationRows(db) === total, `_migrations=${migrationRows(db)}`)
  check('迁移器不建业务表（由 init 建表兜底）', !tableExists(db, 'programs') && !tableExists(db, 'scripts'))
  const again = await runMigrations(db)
  check('再跑一次是空转', again.applied.length === 0, again.applied.join(','))
  db.close()
}

// ---------- B 现役库副本 ----------
{
  console.log('\n[B] 现役库副本（已经是最新结构）')
  const live = join(process.env.APPDATA ?? '', 'YunCast', 'yuncast.db')
  if (!existsSync(live)) {
    console.log('  · 跳过：本机没有现役库')
  } else {
    const copyPath = join(work, 'live-copy.db')
    copyFileSync(live, copyPath)
    const before = new DatabaseSync(copyPath)
    before.close()
    const db = new DatabaseSync(copyPath)
    const report = await runMigrations(db)
    // 现役库可能正好停在上一版：允许补跑 0016/0017/0018，但不能再跑历史迁移
    check(
      '只补跑比现役库新的迁移',
      report.applied.every(
        (name) =>
          name === '0016-live-session-config' ||
          name === '0017-decouple-assets' ||
          name === '0018-rename-programs-to-scripts' ||
          name === '0019-script-structure-only' ||
          name === '0020-pool-item-script' ||
          name === '0021-projects' ||
          name === '0022-content-out-of-app-db'
      ),
      report.applied.join(',')
    )
    check('版本抬到最新', userVersion(db) === 22, `user_version=${userVersion(db)}`)
    check(
      '内容表已从应用库移除',
      ['scripts', 'draft_units', 'pool_items', 'personas', 'materials'].every((t) => !tableExists(db, t))
    )
    check('基线登记完整', migrationRows(db) >= 17, `_migrations=${migrationRows(db)}`)
    const againReport = await runMigrations(db)
    check('再跑一次是空转', againReport.applied.length === 0, againReport.applied.join(','))
    db.close()
  }
}

// ---------- B2 v16 现役结构：资产解耦的破坏性重建 ----------
{
  console.log('\n[B2] v16 结构（旧卡司列 + persona_voices）升 v17')
  const db = new DatabaseSync(join(work, 'legacy-v16.db'))
  db.exec(`
    PRAGMA user_version = 16;
    CREATE TABLE personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, personality TEXT NOT NULL DEFAULT '',
      catchphrases TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT '',
      taboos TEXT NOT NULL DEFAULT '', voice_id TEXT NOT NULL DEFAULT '',
      default_voice_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE programs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'solo', broadcast_mode TEXT NOT NULL DEFAULT 'rolling',
      finish_mode TEXT NOT NULL DEFAULT 'loop', allow_live_events INTEGER NOT NULL DEFAULT 1,
      enabled_trigger_ids TEXT NOT NULL DEFAULT '[]', persona_ids TEXT NOT NULL DEFAULT '[]',
      instruction TEXT, language TEXT NOT NULL DEFAULT 'auto', plan TEXT NOT NULL DEFAULT '{"scenes":[]}',
      knowledge_scope TEXT NOT NULL DEFAULT '{}', current_scene_idx INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_configs (
      id TEXT PRIMARY KEY, program_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto',
      preset TEXT NOT NULL DEFAULT '', synth_mode TEXT NOT NULL DEFAULT 'async',
      end_mode TEXT NOT NULL DEFAULT 'loop', audio_policy TEXT NOT NULL DEFAULT 'reuse',
      persona_voices TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pool_items (id TEXT PRIMARY KEY, text TEXT, language_type TEXT);
    INSERT INTO personas (id, name, voice_id, default_voice_id) VALUES
      ('persona-1', '小满', 'v1', 'v1'), ('persona-2', '阿哲', 'v2', 'v2');
    INSERT INTO programs (id, name, persona_ids, finish_mode) VALUES ('prog-1', '保温杯', '["persona-1","persona-2"]', 'stop');
    INSERT INTO session_configs (id, program_id, persona_voices, end_mode, created_at)
      VALUES ('sc-1', 'prog-1', '[{"personaId":"persona-1","voiceId":"v1"},{"personaId":"persona-2","voiceId":"v2"}]', 'loop', 1);
    INSERT INTO pool_items (id, text, language_type) VALUES ('p1', '旧条目', 'Chinese');
  `)
  const report = await runMigrations(db)
  check(
    '只跑 0017 + 0018 + 0019',
    report.applied.join(',') ===
      '0017-decouple-assets,0018-rename-programs-to-scripts,0019-script-structure-only,0020-pool-item-script,0021-projects,0022-content-out-of-app-db',
    report.applied.join(',')
  )
  check(
    '内容表已从应用库移除',
    ['personas', 'scripts', 'session_configs', 'pool_items'].every((t) => !tableExists(db, t))
  )
  check('项目清单留在应用库', tableExists(db, 'projects'))
  db.close()
}

// ---------- C 远古库（v11：素材还叫 products、编排还在 scripts 表） ----------
{
  console.log('\n[C] 远古库 v11（旧素材表 + 旧编排表）')
  const db = new DatabaseSync(join(work, 'legacy-v11.db'))
  db.exec(`
    PRAGMA user_version = 11;
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE draft_units (id TEXT PRIMARY KEY, program_id TEXT, persona_id TEXT, rendered TEXT);
    CREATE TABLE pool_items (id TEXT PRIMARY KEY, live_session_id TEXT);
    CREATE TABLE live_sessions (id TEXT PRIMARY KEY, personas TEXT);
    CREATE TABLE director_timeline (program_id TEXT, payload TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE knowledge_files (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE programs (
      id TEXT PRIMARY KEY,
      name TEXT,
      instruction TEXT,
      knowledge_scope TEXT NOT NULL DEFAULT '{}',
      script_id TEXT
    );
    CREATE TABLE scripts (id TEXT PRIMARY KEY, scenes TEXT);
    INSERT INTO programs (id, name, instruction, knowledge_scope, script_id)
      VALUES ('prog-1', '老节目', '压低声音', '{"products":"*","files":"*"}', 'script-1');
    INSERT INTO scripts (id, scenes) VALUES ('script-1', '[{"id":"scene-1","title":"开场"}]');
    INSERT INTO products (id, name) VALUES ('prod-1', '保温杯');
  `)
  const report = await runMigrations(db)
  check(
    '基线后只补跑新迁移',
    report.applied.join(',') ===
      '0012-materials,0014-plan-into-programs,0015-material-content,0016-live-session-config,0017-decouple-assets,0018-rename-programs-to-scripts,0019-script-structure-only,0020-pool-item-script,0021-projects,0022-content-out-of-app-db',
    report.applied.join(',')
  )
  check('结构版本抬到最新', userVersion(db) === 22)
  check(
    '内容表已从应用库移除',
    ['scripts', 'session_configs', 'draft_units', 'materials', 'material_files'].every((t) => !tableExists(db, t))
  )
  check('旧表也清掉了', !tableExists(db, 'programs') && !tableExists(db, 'products'))
  check('项目清单留在应用库', tableExists(db, 'projects'))
  db.close()
}

// ---------- D 远古库（v3：表名/列名全是当年的样子） ----------
{
  console.log('\n[D] 远古库 v3（agents/utterances/speech_items + audio_config）')
  const db = new DatabaseSync(join(work, 'legacy-v3.db'))
  db.exec(`
    PRAGMA user_version = 3;
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, roles TEXT, active INTEGER, model_profile_id TEXT);
    CREATE TABLE utterances (id TEXT PRIMARY KEY, plan_id TEXT, presenter_id TEXT);
    CREATE TABLE speech_items (id TEXT PRIMARY KEY, session_id TEXT, source_agent_id TEXT, origin_utterance_id TEXT);
    CREATE TABLE model_connections (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE program_sessions (program_id TEXT PRIMARY KEY, purpose TEXT, entries TEXT, updated_at INTEGER);
    CREATE TABLE broadcast_sessions (id TEXT PRIMARY KEY, "cast" TEXT);
    CREATE TABLE broadcast_events (id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE director_timeline (program_id TEXT, payload TEXT);
    CREATE TABLE programs (
      id TEXT PRIMARY KEY,
      name TEXT,
      presenter_ids TEXT,
      knowledge_scope TEXT NOT NULL DEFAULT '{}',
      script_id TEXT,
      audio_config TEXT
    );
    CREATE TABLE scripts (id TEXT PRIMARY KEY, scenes TEXT);
    INSERT INTO agents (id, name, model_profile_id) VALUES ('anchor-1', '小满', 'mp-1');
    INSERT INTO programs (id, name, presenter_ids, knowledge_scope, script_id, audio_config)
      VALUES ('prog-1', '老节目', '["anchor-1"]', '{"products":"*","files":"*"}', 'script-1', '{"instruction":"语速放慢一点"}');
    INSERT INTO scripts (id, scenes) VALUES ('script-1', '[{"id":"scene-1","title":"开场"}]');
  `)
  const report = await runMigrations(db)
  check(
    '从 v4 一路抬到最新',
    report.applied.join(',') ===
      '0004-rename-tables,0005-persona-columns,0006-drop-model-profile,0007-program-instruction,0010-naming,0011-persona-id-prefix,0012-materials,0014-plan-into-programs,0015-material-content,0016-live-session-config,0017-decouple-assets,0018-rename-programs-to-scripts,0019-script-structure-only,0020-pool-item-script,0021-projects,0022-content-out-of-app-db',
    report.applied.join(',')
  )
  check(
    '内容表已从应用库移除',
    ['personas', 'draft_units', 'pool_items', 'scripts', 'live_sessions', 'director_timeline'].every(
      (t) => !tableExists(db, t)
    )
  )
  check('远古表也一并清掉', !tableExists(db, 'agents') && !tableExists(db, 'utterances'))
  check('结构版本抬到最新', userVersion(db) === 22)
  check('项目清单留在应用库', tableExists(db, 'projects'))
  db.close()
}

rmSync(work, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不通过`)
process.exit(failed === 0 ? 0 : 1)
