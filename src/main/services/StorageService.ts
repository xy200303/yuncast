import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_CONFIG,
  DEFAULT_PLAN_GEN_CONFIG,
  DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  parseAppConfig,
  type AppConfig,
  type EpisodeSummary,
  type KnowledgeFile,
  type PartialDeep,
  type Persona,
  type PlanGenConfig,
  type PlanKnowledgeScope,
  type Product,
  type Script,
  type LivePlan,
  type SpeechItem,
  type SpeechLane,
  type SpeechReplyTo,
  type SpeechStatus,
  type Trigger,
  type LiveEvent,
  type Utterance,
  type UtteranceStatus,
  type ViewerProfile,
  type VoiceRecord
} from '../../shared/types'

/**
 * 持久化层：
 * - 应用配置：userData/config.json（tts.accessToken / tts.apiKey / llm.apiKey 用 safeStorage 加密落盘）
 * - 话术池、人设卡等业务数据：userData/agentanchor.db（Node 内置 SQLite，WAL，免原生重编译）
 */

type StoredValue = string | { __enc: string }

/** 以 dot path 标记的敏感字段，写入前加密、读出后解密 */
const SECRET_KEYS = [
  'tts.accessToken',
  'tts.apiKey',
  'ttsRealtime.apiKey',
  'llm.apiKey',
  'stream.streamKey',
  'comment.connectorToken'
] as const

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  const last = segments.pop()!
  let parent = obj
  for (const seg of segments) parent = parent[seg] as Record<string, unknown>
  parent[last] = value
}

function mergeDeep<T>(target: T, patch: PartialDeep<T>): T {
  if (!patch || typeof patch !== 'object') return target
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object'
    ) {
      out[key] = mergeDeep(current, value as PartialDeep<typeof current>)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

// ---------- speech_items 行 ↔ SpeechItem ----------

interface SpeechRow {
  id: unknown
  session_id: unknown
  text: unknown
  turn_id: unknown
  seq: unknown
  voice_id: unknown
  source_agent_id: unknown
  source_kind: unknown
  lane: unknown
  dedupe_key: unknown
  expires_at: unknown
  reply_to: unknown
  status: unknown
  audio_path: unknown
  speech_text: unknown
  stream: unknown
  origin_utterance_id: unknown
  error: unknown
  sort_order: unknown
  created_at: unknown
  played_at: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** JSON 列容错解析：坏了/空了都回落默认值，不让一行脏数据炸掉整张表 */
function parseJson<T>(value: unknown, fallback: T): T {
  const raw = str(value)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToItem(row: SpeechRow): SpeechItem {
  let replyTo: SpeechReplyTo | undefined
  const rawReplyTo = str(row.reply_to)
  if (rawReplyTo) {
    try {
      replyTo = JSON.parse(rawReplyTo) as SpeechReplyTo
    } catch {
      replyTo = undefined
    }
  }
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    text: str(row.text),
    turnId: str(row.turn_id),
    seq: num(row.seq) ?? 0,
    voiceId: str(row.voice_id),
    source: {
      agentId: str(row.source_agent_id),
      kind: (str(row.source_kind) || 'manual') as SpeechItem['source']['kind']
    },
    lane: (str(row.lane) || 'normal') as SpeechLane,
    dedupeKey: str(row.dedupe_key) || undefined,
    expiresAt: num(row.expires_at),
    replyTo,
    status: (str(row.status) || 'pending') as SpeechStatus,
    audioPath: str(row.audio_path) || undefined,
    speechText: str(row.speech_text) || undefined,
    stream: num(row.stream) === 1,
    originUtteranceId: str(row.origin_utterance_id) || undefined,
    error: str(row.error) || undefined,
    sortOrder: num(row.sort_order),
    createdAt: num(row.created_at) ?? 0,
    playedAt: num(row.played_at)
  }
}

const ACTIVE_STATUSES: SpeechStatus[] = ['pending', 'synthesizing', 'ready', 'playing']

export class StorageService {
  private readonly configFile: string
  private config: AppConfig
  private configListeners = new Set<(config: AppConfig) => void>()
  private db: DatabaseSync

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.configFile = join(dir, 'config.json')
    this.config = this.loadConfig()

    this.db = new DatabaseSync(join(dir, 'agentanchor.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS speech_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        voice_id TEXT NOT NULL DEFAULT '',
        source_agent_id TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT 'manual',
        lane TEXT NOT NULL DEFAULT 'normal',
        dedupe_key TEXT,
        expires_at INTEGER,
        reply_to TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        audio_path TEXT,
        error TEXT,
        sort_order INTEGER,
        created_at INTEGER NOT NULL,
        played_at INTEGER
      )
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS speech_items_status ON speech_items(status, created_at)'
    )
    // 人设卡（M3 单主播，表结构为多主播预留）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        personality TEXT NOT NULL DEFAULT '',
        catchphrases TEXT NOT NULL DEFAULT '',
        background TEXT NOT NULL DEFAULT '',
        taboos TEXT NOT NULL DEFAULT '',
        voice_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )
    `)
    // 知识库：商品（价格护栏数据源）+ 资料文件
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        selling_points TEXT NOT NULL DEFAULT '',
        faq TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `)
    // 记忆：老粉画像 + 场次摘要
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS viewer_profiles (
        name TEXT PRIMARY KEY,
        interactions INTEGER NOT NULL DEFAULT 0,
        asks TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '[]',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episode_summaries (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `)
    // 触发器 + 事件日志（M5 事件驱动体系）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        on_event TEXT NOT NULL,
        on_filter TEXT,
        target TEXT NOT NULL,
        throttle TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS event_log_ts ON event_log(ts)')
    // 剧本 + 场次（M6）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scripts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        theme TEXT NOT NULL DEFAULT '',
        scenes TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        theme TEXT NOT NULL DEFAULT '',
        script_id TEXT,
        current_scene_idx INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.ensureColumn('agents', 'roles', "TEXT NOT NULL DEFAULT '[]'")
    // 多张人设卡（主播团）：active=1 的那张是当前主播
    this.ensureColumn('agents', 'active', 'INTEGER NOT NULL DEFAULT 0')
    // 场次 = 开播单元（docs/07 §8.5）：人设/形式/生成配置/知识库范围/场次音色
    this.ensureColumn('live_plans', 'persona_id', 'TEXT')
    this.ensureColumn('live_plans', 'style_hint', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('live_plans', 'gen_config', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('live_plans', 'knowledge_scope', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('live_plans', 'voice_id', "TEXT NOT NULL DEFAULT ''")
    // 场次话术库（docs/07 §3 utterances：底稿库，与运行态 speech_items 分工）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS utterances (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        scene_id TEXT NOT NULL DEFAULT '',
        variant_idx INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        voice_id TEXT NOT NULL DEFAULT '',
        audio_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        source TEXT NOT NULL DEFAULT 'initial',
        sources TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS utterances_plan ON utterances(plan_id, scene_id, status)')
    // 预合成时实际用的音色：装载进池时比对，音色改过就不复用旧音频
    this.ensureColumn('utterances', 'synth_voice', "TEXT NOT NULL DEFAULT ''")
    // 话术取自哪条库底稿（复盘溯源，docs/07 §3）
    this.ensureColumn('speech_items', 'origin_utterance_id', 'TEXT')
    // 实时合成条目标记（M9）
    this.ensureColumn('speech_items', 'stream', 'INTEGER NOT NULL DEFAULT 0')
    // 语音稿（显示稿与念法分离）
    this.ensureColumn('speech_items', 'speech_text', 'TEXT')
    // 音色库（M8 声音克隆）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'volcano',
        voice_type TEXT NOT NULL DEFAULT '',
        sample_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'training',
        error TEXT NOT NULL DEFAULT '',
        authorized INTEGER NOT NULL DEFAULT 0,
        authorized_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  // ---------- 音色库（M8） ----------

  listVoices(): VoiceRecord[] {
    return this.db
      .prepare('SELECT * FROM voices ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: String(r.id),
          name: String(r.name),
          provider: r.provider as VoiceRecord['provider'],
          voiceType: String(r.voice_type ?? ''),
          samplePath: String(r.sample_path ?? ''),
          status: r.status as VoiceRecord['status'],
          error: String(r.error ?? ''),
          authorized: Number(r.authorized) === 1,
          authorizedAt: (r.authorized_at as number | null) ?? null,
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at)
        }
      })
  }

  saveVoice(voice: VoiceRecord): void {
    this.db
      .prepare(
        `INSERT INTO voices (id, name, provider, voice_type, sample_path, status, error, authorized, authorized_at, created_at, updated_at)
         VALUES (@id, @name, @provider, @voiceType, @samplePath, @status, @error, @authorized, @authorizedAt, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, provider=@provider, voice_type=@voiceType, sample_path=@samplePath,
           status=@status, error=@error, authorized=@authorized, authorized_at=@authorizedAt, updated_at=@updatedAt`
      )
      .run({
        ...voice,
        authorized: voice.authorized ? 1 : 0
      })
  }

  deleteVoice(id: string): void {
    this.db.prepare('DELETE FROM voices WHERE id = ?').run(id)
  }

  /** 兼容老库的加列 */
  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all()
    if (rows.some((row) => (row as Record<string, unknown>).name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  // ---------- 应用配置 ----------

  private loadConfig(): AppConfig {
    try {
      if (!existsSync(this.configFile)) return structuredClone(DEFAULT_CONFIG)
      const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as Record<string, unknown>
      // 解密敏感字段
      for (const key of SECRET_KEYS) {
        const value = getPath(raw, key) as StoredValue | undefined
        if (value && typeof value === 'object' && '__enc' in value) {
          try {
            setPath(raw, key, safeStorage.decryptString(Buffer.from(value.__enc, 'base64')))
          } catch {
            setPath(raw, key, '')
          }
        }
      }
      return parseAppConfig(raw)
    } catch (error) {
      console.error('[AgentAnchor] 读取配置失败，用默认值:', error)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  getConfig(): AppConfig {
    return this.config
  }

  setConfig(patch: PartialDeep<AppConfig>): AppConfig {
    this.config = parseAppConfig(mergeDeep(this.config, patch))
    this.saveConfig()
    for (const listener of this.configListeners) listener(this.config)
    return this.config
  }

  /** 配置变了就回调（主进程里用来同步窗口 chrome） */
  onConfigChange(listener: (config: AppConfig) => void): () => void {
    this.configListeners.add(listener)
    return () => this.configListeners.delete(listener)
  }

  private saveConfig(): void {
    try {
      mkdirSync(dirname(this.configFile), { recursive: true })
      const clone = JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>
      if (safeStorage.isEncryptionAvailable()) {
        for (const key of SECRET_KEYS) {
          const value = getPath(clone, key)
          if (typeof value === 'string' && value.length > 0) {
            setPath(clone, key, { __enc: safeStorage.encryptString(value).toString('base64') })
          }
        }
      }
      writeFileSync(this.configFile, JSON.stringify(clone, null, 2), 'utf8')
    } catch (error) {
      console.error('[AgentAnchor] 写入配置失败:', error)
    }
  }

  // ---------- 话术池存储 ----------

  speechInsert(item: SpeechItem): void {
    this.db
      .prepare(
        `INSERT INTO speech_items
         (id, session_id, text, turn_id, seq, voice_id, source_agent_id, source_kind, lane,
          dedupe_key, expires_at, reply_to, status, audio_path, speech_text, stream,
          origin_utterance_id, error, sort_order, created_at, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.sessionId,
        item.text,
        item.turnId,
        item.seq,
        item.voiceId,
        item.source.agentId,
        item.source.kind,
        item.lane,
        item.dedupeKey ?? null,
        item.expiresAt ?? null,
        item.replyTo ? JSON.stringify(item.replyTo) : null,
        item.status,
        item.audioPath ?? null,
        item.speechText ?? null,
        item.stream ? 1 : 0,
        item.originUtteranceId ?? null,
        item.error ?? null,
        item.sortOrder ?? null,
        item.createdAt,
        item.playedAt ?? null
      )
  }

  speechUpdate(id: string, patch: Partial<SpeechItem>): void {
    const columns: Record<string, unknown> = {}
    if (patch.text !== undefined) columns.text = patch.text
    if (patch.status !== undefined) columns.status = patch.status
    if (patch.audioPath !== undefined) columns.audio_path = patch.audioPath ?? null
    if (patch.error !== undefined) columns.error = patch.error ?? null
    if (patch.sortOrder !== undefined) columns.sort_order = patch.sortOrder ?? null
    if (patch.expiresAt !== undefined) columns.expires_at = patch.expiresAt ?? null
    if (patch.playedAt !== undefined) columns.played_at = patch.playedAt ?? null
    if (patch.voiceId !== undefined) columns.voice_id = patch.voiceId
    if (patch.stream !== undefined) columns.stream = patch.stream ? 1 : 0
    if (patch.speechText !== undefined) columns.speech_text = patch.speechText ?? null
    const keys = Object.keys(columns)
    if (keys.length === 0) return
    const sql = `UPDATE speech_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    this.db.prepare(sql).run(...(keys.map((k) => columns[k]) as never[]), id)
  }

  speechGet(id: string): SpeechItem | null {
    const row = this.db.prepare('SELECT * FROM speech_items WHERE id = ?').get(id)
    return row ? rowToItem(row as unknown as SpeechRow) : null
  }

  /** 未播完的条目（pending/synthesizing/ready/playing），排序由 SpeechPool 负责 */
  speechActive(): SpeechItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM speech_items WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
      )
      .all(...ACTIVE_STATUSES)
    return rows.map((row) => rowToItem(row as unknown as SpeechRow))
  }

  /** 某时间点之后进入终态失败的条目 */
  speechFailedSince(since: number): SpeechItem[] {
    const rows = this.db
      .prepare("SELECT * FROM speech_items WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC")
      .all(since)
    return rows.map((row) => rowToItem(row as unknown as SpeechRow))
  }

  /** 最近播完的条目（get_recent_played 工具用） */
  speechRecentPlayed(n: number): SpeechItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM speech_items WHERE status IN ('done', 'interrupted') ORDER BY played_at DESC LIMIT ?"
      )
      .all(n)
    return rows.map((row) => rowToItem(row as unknown as SpeechRow))
  }

  /** 限流统计：某来源在 since 之后创建的条目数 */
  speechCountBySourceSince(sourceAgentId: string, sourceKind: string, since: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM speech_items WHERE source_agent_id = ? AND source_kind = ? AND created_at >= ?'
      )
      .get(sourceAgentId, sourceKind, since)
    return typeof row?.n === 'number' ? row.n : 0
  }

  /** 按 dedupeKey 找未播条目（去重合并用） */
  speechFindActiveByDedupeKey(dedupeKey: string): SpeechItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM speech_items WHERE dedupe_key = ? AND status IN ('pending', 'synthesizing', 'ready') ORDER BY created_at DESC LIMIT 1`
      )
      .get(dedupeKey)
    return row ? rowToItem(row as unknown as SpeechRow) : null
  }

  /** 清理过期终态：done 只留最近 200 条，其余终态 1 小时后删除 */
  speechPrune(): void {
    this.db.exec(
      `DELETE FROM speech_items WHERE status IN ('skipped', 'failed', 'expired') AND created_at < ${Date.now() - 3600_000}`
    )
    this.db.exec(
      `DELETE FROM speech_items WHERE status = 'done' AND id NOT IN (
        SELECT id FROM speech_items WHERE status = 'done' ORDER BY played_at DESC LIMIT 200
      )`
    )
  }

  // ---------- 人设卡 ----------

  /** 取第一张人设卡（M3 单主播）；库里没有返回 null，由 PersonaService 负责播种 */
  /** 人设卡列表（主播团），active 的在最前 */
  personaList(): Persona[] {
    return this.db
      .prepare('SELECT * FROM agents ORDER BY active DESC, updated_at ASC')
      .all()
      .map((row) => this.toPersona(row as Record<string, unknown>))
  }

  /** 当前主播（active=1；没有标记就退回最早的一张，兼容老库） */
  personaGet(): Persona | null {
    const active = this.db.prepare('SELECT * FROM agents WHERE active = 1 LIMIT 1').get()
    if (active) return this.toPersona(active as Record<string, unknown>)
    const row = this.db.prepare('SELECT * FROM agents ORDER BY updated_at ASC LIMIT 1').get()
    return row ? this.toPersona(row as Record<string, unknown>) : null
  }

  /** 指定某张卡为当前主播（互斥） */
  personaSetActive(id: string): void {
    this.db.prepare('UPDATE agents SET active = 0').run()
    this.db.prepare('UPDATE agents SET active = 1 WHERE id = ?').run(id)
  }

  personaDelete(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  private toPersona(r: Record<string, unknown>): Persona {
    let roles: Persona['roles'] = []
    try {
      const parsed = JSON.parse(str(r.roles) || '[]')
      if (Array.isArray(parsed)) roles = parsed
    } catch {
      roles = []
    }
    return {
      id: str(r.id),
      name: str(r.name),
      personality: str(r.personality),
      catchphrases: str(r.catchphrases),
      background: str(r.background),
      taboos: str(r.taboos),
      voiceId: str(r.voice_id),
      roles,
      updatedAt: num(r.updated_at) ?? 0
    }
  }

  personaSave(persona: Persona): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, personality, catchphrases, background, taboos, voice_id, roles, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, personality = excluded.personality,
           catchphrases = excluded.catchphrases, background = excluded.background,
           taboos = excluded.taboos, voice_id = excluded.voice_id,
           roles = excluded.roles, updated_at = excluded.updated_at`
      )
      .run(
        persona.id,
        persona.name,
        persona.personality,
        persona.catchphrases,
        persona.background,
        persona.taboos,
        persona.voiceId,
        JSON.stringify(persona.roles),
        persona.updatedAt
      )
  }

  // ---------- 知识库 ----------

  productList(): Product[] {
    return this.db
      .prepare('SELECT * FROM products ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          name: str(r.name),
          price: num(r.price) ?? 0,
          sellingPoints: str(r.selling_points),
          faq: str(r.faq),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  productSave(product: Product): void {
    this.db
      .prepare(
        `INSERT INTO products (id, name, price, selling_points, faq, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, price = excluded.price,
           selling_points = excluded.selling_points, faq = excluded.faq`
      )
      .run(product.id, product.name, product.price, product.sellingPoints, product.faq, product.createdAt)
  }

  productDelete(id: string): void {
    this.db.prepare('DELETE FROM products WHERE id = ?').run(id)
  }

  knowledgeFileList(): KnowledgeFile[] {
    return this.db
      .prepare('SELECT * FROM knowledge_files ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          name: str(r.name),
          kind: (str(r.kind) || 'text') as KnowledgeFile['kind'],
          content: str(r.content),
          filePath: str(r.file_path),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  knowledgeFileInsert(file: KnowledgeFile): void {
    this.db
      .prepare(
        'INSERT INTO knowledge_files (id, name, kind, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(file.id, file.name, file.kind, file.content, file.filePath, file.createdAt)
  }

  knowledgeFileDelete(id: string): void {
    this.db.prepare('DELETE FROM knowledge_files WHERE id = ?').run(id)
  }

  // ---------- 记忆 ----------

  viewerGet(name: string): ViewerProfile | null {
    const row = this.db.prepare('SELECT * FROM viewer_profiles WHERE name = ?').get(name)
    return row ? rowToViewer(row as Record<string, unknown>) : null
  }

  viewerSave(profile: ViewerProfile): void {
    this.db
      .prepare(
        `INSERT INTO viewer_profiles (name, interactions, asks, tags, notes, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           interactions = excluded.interactions, asks = excluded.asks, tags = excluded.tags,
           notes = excluded.notes, last_seen_at = excluded.last_seen_at`
      )
      .run(
        profile.name,
        profile.interactions,
        JSON.stringify(profile.asks),
        JSON.stringify(profile.tags),
        JSON.stringify(profile.notes),
        profile.firstSeenAt,
        profile.lastSeenAt
      )
  }

  viewerList(): ViewerProfile[] {
    return this.db
      .prepare('SELECT * FROM viewer_profiles ORDER BY last_seen_at DESC')
      .all()
      .map((row) => rowToViewer(row as Record<string, unknown>))
  }

  episodeInsert(episode: EpisodeSummary): void {
    this.db
      .prepare(
        'INSERT INTO episode_summaries (id, started_at, ended_at, summary, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(episode.id, episode.startedAt, episode.endedAt, episode.summary, episode.createdAt)
  }

  episodeList(): EpisodeSummary[] {
    return this.db
      .prepare('SELECT * FROM episode_summaries ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          startedAt: num(r.started_at) ?? 0,
          endedAt: num(r.ended_at) ?? 0,
          summary: str(r.summary),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  // ---------- 触发器 ----------

  triggerList(): Trigger[] {
    return this.db
      .prepare('SELECT * FROM triggers ORDER BY created_at ASC')
      .all()
      .map((row) => rowToTrigger(row as Record<string, unknown>))
  }

  triggerSave(trigger: Trigger): void {
    this.db
      .prepare(
        `INSERT INTO triggers (id, name, enabled, on_event, on_filter, target, throttle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, enabled = excluded.enabled, on_event = excluded.on_event,
           on_filter = excluded.on_filter, target = excluded.target, throttle = excluded.throttle`
      )
      .run(
        trigger.id,
        trigger.name,
        trigger.enabled ? 1 : 0,
        trigger.on.event,
        trigger.on.filter ? JSON.stringify(trigger.on.filter) : null,
        JSON.stringify(trigger.target),
        trigger.throttle ? JSON.stringify(trigger.throttle) : null,
        Date.now()
      )
  }

  triggerDelete(id: string): void {
    this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id)
  }

  // ---------- 事件日志 ----------

  eventLogInsert(event: LiveEvent): void {
    this.db
      .prepare('INSERT INTO event_log (id, type, source, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.type, event.source, JSON.stringify(event.payload), event.ts)
    // 容量滚动清理：只留最近 5000 条
    this.db.exec(
      `DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY ts DESC LIMIT 5000)`
    )
  }

  eventLogRecent(n: number): LiveEvent[] {
    return this.db
      .prepare('SELECT * FROM event_log ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(n, 500)))
      .map((row) => {
        const r = row as Record<string, unknown>
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(str(r.payload) || '{}')
        } catch {
          payload = {}
        }
        return {
          id: str(r.id),
          type: str(r.type),
          source: (str(r.source) || 'system') as LiveEvent['source'],
          payload,
          ts: num(r.ts) ?? 0
        }
      })
  }

  // ---------- 剧本 ----------

  scriptList(): Script[] {
    return this.db
      .prepare('SELECT * FROM scripts ORDER BY created_at ASC')
      .all()
      .map((row) => rowToScript(row as Record<string, unknown>))
  }

  scriptSave(script: Script): void {
    this.db
      .prepare(
        `INSERT INTO scripts (id, title, theme, scenes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, theme = excluded.theme,
           scenes = excluded.scenes, updated_at = excluded.updated_at`
      )
      .run(script.id, script.title, script.theme, JSON.stringify(script.scenes), script.createdAt, script.updatedAt)
  }

  scriptDelete(id: string): void {
    this.db.prepare('DELETE FROM scripts WHERE id = ?').run(id)
  }

  // ---------- 场次 ----------

  planList(): LivePlan[] {
    return this.db
      .prepare('SELECT * FROM live_plans ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          name: str(r.name),
          theme: str(r.theme),
          personaId: str(r.persona_id) || null,
          styleHint: str(r.style_hint),
          scriptId: str(r.script_id) || null,
          currentSceneIdx: num(r.current_scene_idx) ?? 0,
          genConfig: { ...DEFAULT_PLAN_GEN_CONFIG, ...parseJson<Partial<PlanGenConfig>>(r.gen_config, {}) },
          knowledgeScope: {
            ...DEFAULT_PLAN_KNOWLEDGE_SCOPE,
            ...parseJson<Partial<PlanKnowledgeScope>>(r.knowledge_scope, {})
          },
          voiceId: str(r.voice_id),
          createdAt: num(r.created_at) ?? 0,
          updatedAt: num(r.updated_at) ?? 0
        }
      })
  }

  planSave(plan: LivePlan): void {
    this.db
      .prepare(
        `INSERT INTO live_plans (id, name, theme, persona_id, style_hint, script_id, current_scene_idx,
                                 gen_config, knowledge_scope, voice_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, theme = excluded.theme,
           persona_id = excluded.persona_id, style_hint = excluded.style_hint,
           script_id = excluded.script_id, gen_config = excluded.gen_config,
           knowledge_scope = excluded.knowledge_scope, voice_id = excluded.voice_id,
           updated_at = excluded.updated_at`
      )
      .run(
        plan.id,
        plan.name,
        plan.theme,
        plan.personaId ?? null,
        plan.styleHint,
        plan.scriptId ?? null,
        plan.currentSceneIdx,
        JSON.stringify(plan.genConfig),
        JSON.stringify(plan.knowledgeScope),
        plan.voiceId,
        plan.createdAt,
        plan.updatedAt
      )
  }

  planDelete(id: string): void {
    this.db.prepare('DELETE FROM live_plans WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM utterances WHERE plan_id = ?').run(id)
  }

  /** 场景推进进度落库（断播能续） */
  planSetSceneIdx(id: string, idx: number): void {
    this.db.prepare('UPDATE live_plans SET current_scene_idx = ? WHERE id = ?').run(idx, id)
  }

  // ---------- 话术库（utterances） ----------

  utteranceList(planId: string): Utterance[] {
    return this.db
      .prepare('SELECT * FROM utterances WHERE plan_id = ? ORDER BY scene_id ASC, variant_idx ASC, created_at ASC')
      .all(planId)
      .map((row) => rowToUtterance(row as Record<string, unknown>))
  }

  utteranceSave(u: Utterance): void {
    this.db
      .prepare(
        `INSERT INTO utterances (id, plan_id, scene_id, variant_idx, text, voice_id, audio_path,
                                 status, error, source, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scene_id = excluded.scene_id, variant_idx = excluded.variant_idx,
           text = excluded.text, voice_id = excluded.voice_id, audio_path = excluded.audio_path,
           status = excluded.status, error = excluded.error, source = excluded.source,
           sources = excluded.sources`
      )
      .run(
        u.id,
        u.planId,
        u.sceneId,
        u.variantIdx,
        u.text,
        u.voiceId,
        u.audioPath ?? null,
        u.status,
        u.error ?? null,
        u.source,
        JSON.stringify(u.sources),
        u.createdAt
      )
  }

  utteranceDelete(id: string): void {
    this.db.prepare('DELETE FROM utterances WHERE id = ?').run(id)
  }

  /** 批量删除（重生成某场景/清空场次话术库用） */
  utteranceDeleteWhere(planId: string, sceneId?: string): void {
    if (sceneId === undefined) {
      this.db.prepare('DELETE FROM utterances WHERE plan_id = ?').run(planId)
    } else {
      this.db.prepare('DELETE FROM utterances WHERE plan_id = ? AND scene_id = ?').run(planId, sceneId)
    }
  }

  /** 预合成状态推进（批量合成时逐条更新） */
  utteranceSetAudio(
    id: string,
    status: UtteranceStatus,
    audioPath: string | null,
    error?: string,
    synthVoice?: string
  ): void {
    if (synthVoice === undefined) {
      this.db
        .prepare('UPDATE utterances SET status = ?, audio_path = ?, error = ? WHERE id = ?')
        .run(status, audioPath, error ?? null, id)
      return
    }
    this.db
      .prepare('UPDATE utterances SET status = ?, audio_path = ?, error = ?, synth_voice = ? WHERE id = ?')
      .run(status, audioPath, error ?? null, synthVoice, id)
  }

  close(): void {
    this.db.close()
  }
}

function rowToUtterance(r: Record<string, unknown>): Utterance {
  return {
    id: str(r.id),
    planId: str(r.plan_id),
    sceneId: str(r.scene_id),
    variantIdx: num(r.variant_idx) ?? 0,
    text: str(r.text),
    voiceId: str(r.voice_id),
    audioPath: str(r.audio_path) || null,
    synthVoice: str(r.synth_voice),
    status: (str(r.status) || 'pending') as Utterance['status'],
    error: str(r.error) || undefined,
    source: str(r.source) === 'adopted' ? 'adopted' : 'initial',
    sources: parseJson<Utterance['sources']>(r.sources, []),
    createdAt: num(r.created_at) ?? 0
  }
}

function rowToScript(r: Record<string, unknown>): Script {
  let scenes: Script['scenes'] = []
  try {
    const parsed = JSON.parse(str(r.scenes) || '[]')
    if (Array.isArray(parsed)) scenes = parsed
  } catch {
    scenes = []
  }
  return {
    id: str(r.id),
    title: str(r.title),
    theme: str(r.theme),
    scenes,
    createdAt: num(r.created_at) ?? 0,
    updatedAt: num(r.updated_at) ?? 0
  }
}

function rowToTrigger(r: Record<string, unknown>): Trigger {
  const json = (value: unknown): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(str(value) || '')
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  return {
    id: str(r.id),
    name: str(r.name),
    enabled: num(r.enabled) !== 0,
    on: { event: str(r.on_event), filter: json(r.on_filter) },
    target: (json(r.target) ?? { agentId: 'anchor', mode: 'task' }) as Trigger['target'],
    throttle: json(r.throttle) as Trigger['throttle']
  }
}

function rowToViewer(r: Record<string, unknown>): ViewerProfile {
  const jsonArray = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(str(value) || '[]')
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return {
    name: str(r.name),
    interactions: num(r.interactions) ?? 0,
    asks: jsonArray(r.asks),
    tags: jsonArray(r.tags),
    notes: jsonArray(r.notes),
    firstSeenAt: num(r.first_seen_at) ?? 0,
    lastSeenAt: num(r.last_seen_at) ?? 0
  }
}
