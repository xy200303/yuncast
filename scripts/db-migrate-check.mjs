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
  check('执行了全部迁移', report.applied.length === 12, report.applied.join(','))
  check('结构版本最新', report.version === 15 && userVersion(db) === 15, `user_version=${userVersion(db)}`)
  check('执行记录落表', migrationRows(db) === 12, `_migrations=${migrationRows(db)}`)
  check('迁移器不建业务表（由 init 建表兜底）', !tableExists(db, 'programs'))
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
    const beforePrograms = before.prepare('SELECT COUNT(*) c FROM programs').get().c
    const beforeVersion = userVersion(before)
    before.close()
    const db = new DatabaseSync(copyPath)
    const report = await runMigrations(db)
    check('已有库不重复迁移', report.applied.length === 0, report.applied.join(','))
    check('版本保持不变', userVersion(db) === beforeVersion, `user_version=${userVersion(db)}`)
    check('业务数据没动', db.prepare('SELECT COUNT(*) c FROM programs').get().c === beforePrograms)
    check('基线登记了历史迁移', migrationRows(db) === 12, `_migrations=${migrationRows(db)}`)
    db.close()
  }
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
  check('基线后只补跑新迁移', report.applied.join(',') === '0012-materials,0014-plan-into-programs,0015-material-content', report.applied.join(','))
  check('结构版本抬到最新', userVersion(db) === 15)
  check('products → materials', tableExists(db, 'materials') && !tableExists(db, 'products'))
  check('改名后仍补上正文列（顺序敏感）', columns(db, 'materials').has('content'))
  check('附件表挂到条目上', columns(db, 'material_files').has('material_id') && columns(db, 'material_files').has('url'))
  check('编排进节目、scripts 退场', columns(db, 'programs').has('plan') && !tableExists(db, 'scripts'))
  const program = db.prepare('SELECT plan, instruction, knowledge_scope FROM programs').get()
  check('场景搬进 programs.plan', JSON.parse(program.plan).scenes.length === 1)
  check('节目风格指令原样保留', program.instruction === '压低声音', String(program.instruction))
  check('素材范围只留 materials', JSON.parse(program.knowledge_scope).materials === '*', program.knowledge_scope)
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
      '0004-rename-tables,0005-persona-columns,0006-drop-model-profile,0007-program-instruction,0010-naming,0011-persona-id-prefix,0012-materials,0014-plan-into-programs,0015-material-content',
    report.applied.join(',')
  )
  check('表名改造：agents/utterances/speech_items', ['personas', 'draft_units', 'pool_items'].every((t) => tableExists(db, t)) && !tableExists(db, 'agents'))
  check('死列 model_profile_id 已删', !columns(db, 'personas').has('model_profile_id'))
  const program = db.prepare('SELECT instruction, persona_ids FROM programs').get()
  check('audio_config 里的 instruction 摘到顶层', program.instruction === '语速放慢一点', String(program.instruction))
  check('audio_config 列已删', !columns(db, 'programs').has('audio_config'))
  check('presenter_ids → persona_ids', columns(db, 'programs').has('persona_ids'))
  check('卡司里的旧 id 前缀改写', program.persona_ids.includes('persona-1'), program.persona_ids)
  check('场次卡司列 cast → personas', columns(db, 'live_sessions').has('personas') && !columns(db, 'live_sessions').has('cast'))
  check('结构版本抬到最新', userVersion(db) === 15)
  db.close()
}

rmSync(work, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不通过`)
process.exit(failed === 0 ? 0 : 1)
