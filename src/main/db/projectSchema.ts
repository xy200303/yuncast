import { DatabaseSync } from 'node:sqlite'

/**
 * 单个项目的库结构（`<项目目录>/project.db`）。
 *
 * 一个项目 = 一个目录 = 一个库：项目信息、场次、底稿、导演对话都在同一个文件里，
 * 拷走目录就是完整备份。应用级数据（音色库、模型接入、全局设置）不在这里，见 StorageService。
 *
 * 版本走 `PRAGMA user_version`：版本不一致直接拒绝打开；结构只有当前形态一份，不做迁移。
 */
export const PROJECT_SCHEMA_VERSION = 7

export type ProjectMeta = {
  id: string
  name: string
  /** authored = 先备稿再播；live = 播着写；realtime = 不写稿，直接对话合成（项目设置落地前只做展示） */
  type: 'authored' | 'live' | 'realtime'
  createdAt: number
  updatedAt: number
}

/** 项目库的业务表：场景、底稿、话术池、场次、对话——全部随项目走，跨项目不共享 */
const CONTENT_DDL = `
  CREATE TABLE IF NOT EXISTS session_configs (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'Chinese',
    content_type TEXT NOT NULL DEFAULT 'solo',
    instruction TEXT NOT NULL DEFAULT '',
    preset TEXT NOT NULL DEFAULT '',
    content_source TEXT NOT NULL DEFAULT 'script',
    synth_mode TEXT NOT NULL DEFAULT 'async',
    end_mode TEXT NOT NULL DEFAULT 'loop',
    audio_policy TEXT NOT NULL DEFAULT 'reuse',
    allow_live_events INTEGER NOT NULL DEFAULT 1,
    enabled_trigger_ids TEXT NOT NULL DEFAULT '[]',
    voice_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_configs_script ON session_configs(script_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS session_configs_script_unique ON session_configs(script_id);

  CREATE TABLE IF NOT EXISTS draft_units (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    scene_id TEXT NOT NULL DEFAULT '',
    variant_idx INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    bit_type TEXT NOT NULL DEFAULT '',
    delivery TEXT NOT NULL DEFAULT '',
    rate REAL,
    pitch REAL,
    pause_after_ms INTEGER,
    voice_id TEXT NOT NULL DEFAULT '',
    synth_voice TEXT NOT NULL DEFAULT '',
    audio_path TEXT,
    rendered TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    source TEXT NOT NULL DEFAULT 'initial',
    sources TEXT NOT NULL DEFAULT '[]',
    text_zh TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS draft_units_script ON draft_units(script_id, scene_id, status);

  CREATE TABLE IF NOT EXISTS pool_items (
    id TEXT PRIMARY KEY,
    live_session_id TEXT NOT NULL DEFAULT '',
    script_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    voice_id TEXT NOT NULL DEFAULT '',
    source_actor_id TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT 'manual',
    lane TEXT NOT NULL DEFAULT 'normal',
    dedupe_key TEXT,
    expires_at INTEGER,
    reply_to TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    audio_path TEXT,
    error TEXT,
    sort_order INTEGER,
    queue_seq INTEGER,
    origin_draft_unit_id TEXT,
    stream INTEGER NOT NULL DEFAULT 0,
    speech_text TEXT,
    delivery TEXT,
    rate REAL,
    pitch REAL,
    emotion TEXT,
    emotion_scale REAL,
    pause_after_ms INTEGER,
    created_at INTEGER NOT NULL,
    played_at INTEGER,
    text_zh TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS pool_items_status ON pool_items(status, created_at);

  CREATE TABLE IF NOT EXISTS live_sessions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    program_name TEXT NOT NULL DEFAULT '',
    director_model_desc TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT NOT NULL DEFAULT '',
    stats TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS live_sessions_script ON live_sessions(script_id, started_at);

  CREATE TABLE IF NOT EXISTS broadcast_events (
    id TEXT PRIMARY KEY,
    live_session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS broadcast_events_session ON broadcast_events(live_session_id, ts);

  CREATE TABLE IF NOT EXISTS director_sessions (
    script_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL DEFAULT 'prep',
    entries TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS director_timeline (
    script_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    turn_id TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (script_id, entry_id)
  );

  CREATE TABLE IF NOT EXISTS viewer_profiles (
    name TEXT PRIMARY KEY,
    interactions INTEGER NOT NULL DEFAULT 0,
    asks TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_log (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL,
    script_id TEXT
  );
  CREATE INDEX IF NOT EXISTS event_log_ts ON event_log(ts);
`

/** 素材与附件（知识库）：跨版本都保留的两张表 */
const MATERIAL_DDL = `
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    selling_points TEXT NOT NULL DEFAULT '',
    faq TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'product',
    external_id TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS material_files (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'file',
    url TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`

const DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'authored',
    /** 项目简介（注入导演上下文，不进 TTS） */
    theme TEXT NOT NULL DEFAULT '',
    /** 场次序列（JSON：[{id,title,goal,keyPoints,estDurationMin}]） */
    scenes TEXT NOT NULL DEFAULT '[]',
    /** 场次推进进度（断播能续） */
    scene_idx INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  /** TTS 缓存：同文本同参数只合一次；path 指向项目 audio/ 里的文件 */
  CREATE TABLE IF NOT EXISTS tts_cache (
    param_key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

`

/** 新建（或打开后补齐）项目库，返回连接。 */
export function openProjectDatabase(file: string, options: { create?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  if (options.create !== false) {
    db.exec(DDL)
    db.exec(CONTENT_DDL)
    db.exec(MATERIAL_DDL)
    db.exec(`PRAGMA user_version = ${PROJECT_SCHEMA_VERSION}`)
  }
  return db
}

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  return Number(row?.user_version ?? 0)
}

export function insertProjectMeta(db: DatabaseSync, meta: ProjectMeta): void {
  db.prepare(
    `INSERT OR REPLACE INTO project (id, name, type, theme, scenes, scene_idx, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meta.id,
    meta.name,
    meta.type,
    '',
    '[]',
    0,
    meta.createdAt,
    meta.updatedAt
  )
  const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  set.run('schema', String(PROJECT_SCHEMA_VERSION))
  set.run('projectId', meta.id)
  set.run('createdAt', String(meta.createdAt))
}

export function readProjectMeta(db: DatabaseSync): ProjectMeta | null {
  const row = db
    .prepare(`SELECT id, name, type, created_at, updated_at FROM project LIMIT 1`)
    .get() as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type) as ProjectMeta['type'],
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  }
}
