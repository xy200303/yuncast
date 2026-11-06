import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSecretBox, isV2Sealed, open as openSeal, seal } from './secretBox'
import { hotWords } from './statsWords'
import { openProjectDatabase } from '../db/projectSchema'
import {
  DEFAULT_CONFIG,
  DEFAULT_DIRECTOR_CONFIG,
  DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
  ENTRY_KINDS,
  MCP_HOST,
  parseAppConfig,
  type AppConfig,
  type BroadcastEndReason,
  type BroadcastEvent,
  type BroadcastSession,
  type SessionConfig,
  type UsageBucket,
  type UsageDashboard,
  type MaterialFile,
  type ModelConnection,
  type ModelConnectionInput,
  type ModelConnectionSafe,
  type PartialDeep,
  type Program,
  type ProjectRecord,
  type ProgramLanguage,
  type Material,
  type RenderedAudioRef,
  type ScriptScene,
  type EntryKind,
  type SessionStats,
  type PoolItem,
  type PoolLane,
  type PoolReplyTo,
  type PoolSourceKind,
  type PoolItemStatus,
  type StatsGlobal,
  type StatsQuery,
  type Trigger,
  type LiveEvent,
  type TtsConnection,
  type TtsConnectionInput,
  type TtsConnectionModel,
  type TtsConnectionSafe,
  type TtsRecord,
  type UsageRecord,
  type DraftUnit,
  type DraftUnitStatus,
  type ViewerProfile,
  type VoiceRecord,
  type DataChangeScope
} from '../../shared/types'
import { stripSpeechTags } from '../../shared/speechTags'
import {
  getLlmProvider,
  isModelConnectionReady,
  isTtsConnectionReady,
  isTtsModelUsable,
  getTtsProvider,
  secretFieldKeys,
  ttsSecretFieldKeys
} from './providers/registry'

/**
 * 持久化层（统一 SQLite，userData/yuncast.db，Node 内置、WAL、免原生重编译）：
 * - 应用配置：app_config 表单行 JSON（tts.accessToken / tts.apiKey / llm.apiKey 等加密内联）
 * - 业务数据：各业务表（话术池/节目/底稿/触发器…）
 * - 供应商接入（llm_connections / tts_connections）：密钥字段在 params 里内联加密
 * - 凭据加密用应用自管的 secretBox（AES-256-GCM + userData/secret.key，见 secretBox.ts），
 *   不用系统钥匙串——避免系统密钥轮换后凭据全哑，且行为跨平台一致
 */

type StoredValue = string | { __enc: string }

/** 以 dot path 标记的敏感字段，写入前加密、读出后解密 */
const SECRET_KEYS = [
  'stream.streamKey',
  'comment.connectorToken',
  'mcp.token'
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

// ---------- pool_items 行 ↔ PoolItem ----------

interface PoolItemRow {
  id: unknown
  live_session_id: unknown
  script_id: unknown
  text: unknown
  text_zh?: unknown
  turn_id: unknown
  seq: unknown
  persona_id: unknown
  voice_id: unknown
  source_actor_id: unknown
  source_kind: unknown
  lane: unknown
  dedupe_key: unknown
  expires_at: unknown
  reply_to: unknown
  status: unknown
  audio_path: unknown
  speech_text: unknown
  delivery: unknown
  rate: unknown
  pitch: unknown
  emotion: unknown
  emotion_scale: unknown
  pause_after_ms: unknown
  stream: unknown
  origin_draft_unit_id: unknown
  error: unknown
  sort_order: unknown
  queue_seq: unknown
  created_at: unknown
  played_at: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** 节目语言列的白名单校验：脏值一律回 auto（老数据/手改库都不炸） */
const PROGRAM_LANGUAGES: ProgramLanguage[] = [
  'auto',
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Russian',
  'Italian',
  'Spanish',
  'Portuguese',
  'Thai',
  'Vietnamese',
  'Indonesian',
  'Malay',
  'Filipino',
  'Khmer',
  'Lao',
  'Burmese'
]

function programLanguageOf(value: unknown): ProgramLanguage {
  const raw = str(value)
  return (PROGRAM_LANGUAGES as string[]).includes(raw) ? (raw as ProgramLanguage) : 'auto'
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

function rowToItem(row: PoolItemRow): PoolItem {
  let replyTo: PoolReplyTo | undefined
  const rawReplyTo = str(row.reply_to)
  if (rawReplyTo) {
    try {
      replyTo = JSON.parse(rawReplyTo) as PoolReplyTo
    } catch {
      replyTo = undefined
    }
  }
  return {
    id: str(row.id),
    sessionId: str(row.live_session_id),
    scriptId: str(row.script_id),
    text: str(row.text),
    textZh: str(row.text_zh) || undefined,
    turnId: str(row.turn_id),
    seq: num(row.seq) ?? 0,
    voiceId: str(row.voice_id),
    source: {
      agentId: str(row.source_actor_id),
      kind: (str(row.source_kind) || 'manual') as PoolItem['source']['kind']
    },
    lane: (str(row.lane) || 'normal') as PoolLane,
    dedupeKey: str(row.dedupe_key) || undefined,
    expiresAt: num(row.expires_at),
    replyTo,
    status: (str(row.status) || 'pending') as PoolItemStatus,
    audioPath: str(row.audio_path) || undefined,
    speechText: str(row.speech_text) || undefined,
    delivery: str(row.delivery) || undefined,
    rate: num(row.rate),
    pitch: num(row.pitch),
    emotion: str(row.emotion) || undefined,
    emotionScale: num(row.emotion_scale),
    pauseAfterMs: num(row.pause_after_ms),
    stream: num(row.stream) === 1,
    originDraftUnitId: str(row.origin_draft_unit_id) || undefined,
    error: str(row.error) || undefined,
    sortOrder: num(row.sort_order),
    queueSeq: num(row.queue_seq),
    createdAt: num(row.created_at) ?? 0,
    playedAt: num(row.played_at)
  }
}

const ACTIVE_STATUSES: PoolItemStatus[] = ['pending', 'synthesizing', 'ready', 'playing']

// ---------- 本场配置行映射 ----------

function rowToSessionConfig(row: Record<string, unknown>): SessionConfig {
  const preset = str(row.preset)
  const triggerIds = parseJson<unknown>(row.enabled_trigger_ids, [])
  return {
    id: str(row.id),
    programId: str(row.script_id),
    language: programLanguageOf(row.language),
    contentType: (['solo', 'conversation', 'reading', 'roleplay'] as string[]).includes(str(row.content_type))
      ? (str(row.content_type) as SessionConfig['contentType'])
      : 'solo',
    instruction: str(row.instruction),
    preset: (['audiobook', 'commerce', 'chat', 'stage'].includes(preset) ? preset : '') as SessionConfig['preset'],
    contentSource: str(row.content_source) === 'infinite' ? 'infinite' : 'script',
    synthMode:
      str(row.synth_mode) === 'pre' || str(row.synth_mode) === 'realtime'
        ? (str(row.synth_mode) as SessionConfig['synthMode'])
        : 'async',
    endMode:
      str(row.end_mode) === 'stop' || str(row.end_mode) === 'forever'
        ? (str(row.end_mode) as SessionConfig['endMode'])
        : 'loop',
    audioPolicy: str(row.audio_policy) === 'rebuild' ? 'rebuild' : 'reuse',
    allowLiveEvents: num(row.allow_live_events) !== 0,
    enabledTriggerIds: Array.isArray(triggerIds) ? triggerIds.map(String).filter(Boolean) : [],
    voiceId: str(row.voice_id),
    speakerVoices: parseJson<Record<string, string>>(row.speaker_voices, {}),
    createdAt: num(row.created_at) ?? 0
  }
}

// ---------- live_sessions / broadcast_events 行映射 ----------

function rowToSession(row: Record<string, unknown>): BroadcastSession {
  return {
    id: str(row.id),
    programId: str(row.script_id),
    programName: str(row.program_name),
    directorModelDesc: str(row.director_model_desc),
    startedAt: num(row.started_at) ?? 0,
    endedAt: num(row.ended_at) ?? 0,
    endReason: str(row.end_reason) as BroadcastSession['endReason'],
    stats: parseJson(row.stats, { played: 0, comments: 0, replies: 0 }),
    summary: str(row.summary)
  }
}

function rowToEvent(row: Record<string, unknown>): BroadcastEvent {
  return {
    id: str(row.id),
    sessionId: str(row.live_session_id),
    ts: num(row.ts) ?? 0,
    kind: (str(row.kind) || 'event') as BroadcastEvent['kind'],
    payload: parseJson(row.payload, {})
  }
}

export class StorageService {
  private config: AppConfig
  private configListeners = new Set<(config: AppConfig) => void>()
  /** 应用库（全局）：设置/凭据、音色库、接入、用量、项目清单 */
  private appDb: DatabaseSync
  /** 当前项目库；没有打开项目时是一份内存空库，内容读写落在空表上（不报错、不串项目） */
  private projectDb: DatabaseSync
  /** 内容层统一走项目库 */
  private get db(): DatabaseSync {
    return this.projectDb
  }
  /** 全局层统一走应用库 */
  private get adb(): DatabaseSync {
    return this.appDb
  }
  /** 命令行在应用没开时按这个路径把它拉起来（main 启动时 setLaunch 写入） */
  private launchApp = ''
  private launchArgs: string[] = []

  /** 应用库文件名 */
  private static readonly DB_FILE = 'yuncast.db'

  private static dbFile(dir: string): string {
    return join(dir, StorageService.DB_FILE)
  }

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    initSecretBox(dir)

    this.appDb = new DatabaseSync(StorageService.dbFile(dir))
    this.appDb.exec('PRAGMA journal_mode = WAL')
    this.appDb.exec('PRAGMA busy_timeout = 5000')
    this.projectDb = StorageService.emptyContentDb()
    // 应用配置也存数据库（单行 JSON，敏感字段照样加密内联）：一份存储、一次初始化、不用等两个文件
    this.adb.exec(
      'CREATE TABLE IF NOT EXISTS app_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)'
    )
    this.config = this.loadConfig()
    // 开放接口令牌：首次启动生成一次（randomUUID），之后随配置持久化（落库加密）
    if (!this.config.mcp.token) {
      this.config.mcp.token = randomUUID()
      this.saveConfig()
    } else {
      // 端点文件跟随最新配置（端口/开关可能被外部改过）
      this.writeMcpFile()
    }
  }

  /**
   * 建表 + 启动清扫。**必须在 app.whenReady 里 await 过再往下装配服务**——
   * 本类其余方法都假定结构已经就位。
   *
   * 结构只有「当前形态」一份，不做迁移。
   */
  async init(): Promise<void> {
    // 应用库只留全局数据：项目内容在各自的 <目录>/project.db（见 ProjectService / projectSchema）
    this.adb.exec(`
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
    // 提示词模板（导演手册）：**有行 = 用户手改过，没行 = 用代码里的默认**。
    // 所以这里不播种、也不存「是否默认」标记——恢复默认就是把行删掉。
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 项目清单：内容在各自的 <目录>/project.db，这里只记在哪、叫什么、最近打开
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.adb.exec('CREATE INDEX IF NOT EXISTS projects_recent ON projects(last_opened_at DESC)')
    // 音色库（M8 声音克隆）：全局资源，跨项目复用
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS voices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'volcano',
        voice_type TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        connection_id TEXT NOT NULL DEFAULT '',
        instruction TEXT NOT NULL DEFAULT '',
        sample_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'training',
        error TEXT NOT NULL DEFAULT '',
        authorized INTEGER NOT NULL DEFAULT 0,
        authorized_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.createModelConnectionsTable()
    // 语音合成的服务商接入（设置 → 语音合成）：一个条目 = 一个服务商账号 + 一份凭据 + 它的模型与参数
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS tts_connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        params TEXT NOT NULL DEFAULT '{}',
        models TEXT NOT NULL DEFAULT '[]',
        realtime INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 用量采集（数据页用量看板）：LLM 每次请求一条 usage_records，TTS 每次合成一条 tts_records
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        script_id TEXT,
        persona_id TEXT NOT NULL DEFAULT '',
        connection_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'chat',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        estimated INTEGER NOT NULL DEFAULT 0,
        cost REAL
      )
    `)
    this.adb.exec('CREATE INDEX IF NOT EXISTS usage_records_ts ON usage_records(ts)')
    this.adb.exec('CREATE INDEX IF NOT EXISTS usage_records_script ON usage_records(script_id, ts)')
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS tts_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        script_id TEXT,
        connection_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        voice_id TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL DEFAULT 0,
        cost REAL
      )
    `)
    this.adb.exec('CREATE INDEX IF NOT EXISTS tts_records_ts ON tts_records(ts)')
    this.adb.exec('CREATE INDEX IF NOT EXISTS tts_records_script ON tts_records(script_id, ts)')

  }

  /** 挂上当前项目库：之后所有内容读写都落在它上面 */
  attachProject(db: DatabaseSync): void {
    this.projectDb = db
  }

  /** 关掉项目：内容层退回一份内存空库，应用库和全局数据不受影响 */
  detachProject(): void {
    if (this.projectDb === this.appDb) return
    this.projectDb = StorageService.emptyContentDb()
  }

  /** 没有项目时的内容层：一份建好全部业务表的内存库，读写安全落地、跨项目不串 */
  private static emptyContentDb(): DatabaseSync {
    return openProjectDatabase(':memory:')
  }


  // ---------- 节目会话持久化（全局单会话：key 固定 'director'，单条滚动存档） ----------

  /** 全局唯一导演会话的存档 key（director_sessions 退化而来的单条记录） */
  static readonly DIRECTOR_SESSION_KEY = 'director'


  /** 保存某节目的 pi 会话 entries（stop/切节目/每轮结束时覆盖写） */
  saveProgramSession(programId: string, purpose: string, entriesJson: string): void {
    this.db
      .prepare(
        `INSERT INTO director_sessions (script_id, purpose, entries, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(script_id) DO UPDATE SET purpose = excluded.purpose, entries = excluded.entries, updated_at = excluded.updated_at`
      )
      .run(programId, purpose, entriesJson, Date.now())
  }

  loadProgramSession(programId: string): { purpose: string; entries: string } | null {
    const row = this.db.prepare('SELECT purpose, entries FROM director_sessions WHERE script_id = ?').get(programId) as
      | { purpose: string; entries: string }
      | undefined
    return row ?? null
  }

  deleteProgramSession(programId: string): void {
    this.db.prepare('DELETE FROM director_sessions WHERE script_id = ?').run(programId)
    this.db.prepare('DELETE FROM director_timeline WHERE script_id = ?').run(programId)
  }

  /** 时间线条目落库（按 entry_id upsert：流式快照/工具状态更新都收敛到同一行），每节目修剪到最近 500 条 */
  timelineAppend(programId: string, entryId: string, turnId: string, ts: number, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO director_timeline (script_id, entry_id, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(script_id, entry_id) DO UPDATE SET payload = excluded.payload`
      )
      .run(programId, entryId, turnId, ts, payload)
    this.db
      .prepare(
        `DELETE FROM director_timeline WHERE script_id = ? AND entry_id NOT IN (
           SELECT entry_id FROM director_timeline WHERE script_id = ? ORDER BY ts DESC LIMIT 500
         )`
      )
      .run(programId, programId)
  }

  /** 拉某节目的可见时间线（最近 limit 条，按时间正序） */
  timelineList(programId: string, limit = 200): { turnId: string; payload: string }[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id, payload FROM (
           SELECT turn_id, payload, ts FROM director_timeline WHERE script_id = ? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`
      )
      .all(programId, limit) as { turn_id: string; payload: string }[]
    return rows.map((r) => ({ turnId: r.turn_id, payload: r.payload }))
  }

  timelineClear(programId: string): void {
    this.db.prepare('DELETE FROM director_timeline WHERE script_id = ?').run(programId)
  }

  // ---------- 本场配置（docs/12） ----------

  sessionConfigSave(config: SessionConfig): void {
    // 一个项目只有一份本场配置：重复保存就地覆盖（id 保持第一次那行，历史行不再累积）
    this.db
      .prepare(
        `INSERT INTO session_configs (id, script_id, language, content_type, instruction, preset, content_source,
                                      synth_mode, end_mode, audio_policy, allow_live_events, enabled_trigger_ids, voice_id, speaker_voices, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(script_id) DO UPDATE SET
           language = excluded.language,
           content_type = excluded.content_type,
           instruction = excluded.instruction,
           preset = excluded.preset,
           content_source = excluded.content_source,
           synth_mode = excluded.synth_mode,
           end_mode = excluded.end_mode,
           audio_policy = excluded.audio_policy,
           allow_live_events = excluded.allow_live_events,
           enabled_trigger_ids = excluded.enabled_trigger_ids,
           voice_id = excluded.voice_id,
           speaker_voices = excluded.speaker_voices,
           created_at = excluded.created_at`
      )
      .run(
        config.id,
        config.programId,
        config.language,
        config.contentType,
        config.instruction.trim(),
        config.preset,
        config.contentSource,
        config.synthMode,
        config.endMode,
        config.audioPolicy,
        config.allowLiveEvents ? 1 : 0,
        JSON.stringify(config.enabledTriggerIds),
        config.voiceId ?? '',
        JSON.stringify(config.speakerVoices ?? {}),
        config.createdAt
      )
  }

  /**
   * 确保这个剧本有一条本场配置（互动开关随时可改，不等开播）：
   * 没有就建一条空卡司的默认记录；开播时仍要重新过开播配置。
   */
  sessionConfigEnsure(programId: string): SessionConfig | null {
    const latest = this.sessionConfigLatest(programId)
    if (latest) return latest
    const program = this.programList().find((item) => item.id === programId)
    if (!program) return null
    const config: SessionConfig = {
      id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      programId,
      language: 'Chinese',
      contentType: 'solo',
      instruction: '',
      preset: '',
      contentSource: 'script',
      synthMode: 'async',
      endMode: 'loop',
      audioPolicy: 'reuse',
      allowLiveEvents: true,
      enabledTriggerIds: this.triggerList().filter((trigger) => trigger.enabled).map((trigger) => trigger.id),
      voiceId: '',
      speakerVoices: {},
      createdAt: Date.now()
    }
    this.sessionConfigSave(config)
    return config
  }

  /** 最近一次本场配置（开播弹窗预填、直播台顶栏、互动总闸都读它） */
  sessionConfigLatest(programId: string): SessionConfig | null {
    const row = this.db
      .prepare('SELECT * FROM session_configs WHERE script_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(programId) as Record<string, unknown> | undefined
    return row ? rowToSessionConfig(row) : null
  }

  /**
   * 改最近一次本场配置的互动开关/触发器（直播中调自动响应，不新开一场）：
   * 只允许这两项——人选、语言、播出开关属于开播那一下的确认，要改就重新做一次开播配置。
   */
  sessionConfigPatch(
    programId: string,
    patch: Pick<Partial<SessionConfig>, 'allowLiveEvents' | 'enabledTriggerIds'>
  ): SessionConfig | null {
    const latest = this.sessionConfigLatest(programId)
    if (!latest) return null
    if (patch.allowLiveEvents !== undefined) {
      this.db
        .prepare('UPDATE session_configs SET allow_live_events = ? WHERE id = ?')
        .run(patch.allowLiveEvents ? 1 : 0, latest.id)
    }
    if (patch.enabledTriggerIds !== undefined) {
      this.db
        .prepare('UPDATE session_configs SET enabled_trigger_ids = ? WHERE id = ?')
        .run(JSON.stringify(patch.enabledTriggerIds), latest.id)
    }
    return this.sessionConfigLatest(programId)
  }

  /** 全部本场配置（新的在前；音色引用统计用） */
  sessionConfigAll(): SessionConfig[] {
    return this.db
      .prepare('SELECT * FROM session_configs ORDER BY created_at DESC')
      .all()
      .map((row) => rowToSessionConfig(row as Record<string, unknown>))
  }

  // ---------- 音色库（M8） ----------

  listVoices(): VoiceRecord[] {
    return this.adb
      .prepare('SELECT * FROM voices ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: String(r.id),
          name: String(r.name),
          provider: r.provider as VoiceRecord['provider'],
          voiceType: String(r.voice_type ?? ''),
          model: String(r.model ?? ''),
          connectionId: String(r.connection_id ?? ''),
          instruction: String(r.instruction ?? ''),
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
    this.adb
      .prepare(
        `INSERT INTO voices (id, name, provider, voice_type, model, connection_id, instruction, sample_path, status, error, authorized, authorized_at, created_at, updated_at)
         VALUES (@id, @name, @provider, @voiceType, @model, @connectionId, @instruction, @samplePath, @status, @error, @authorized, @authorizedAt, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, provider=@provider, voice_type=@voiceType, model=@model, connection_id=@connectionId, instruction=@instruction, sample_path=@samplePath,
           status=@status, error=@error, authorized=@authorized, authorized_at=@authorizedAt, updated_at=@updatedAt`
      )
      .run({
        ...voice,
        instruction: voice.instruction ?? '',
        authorized: voice.authorized ? 1 : 0
      })
  }

  deleteVoice(id: string): void {
    this.adb.prepare('DELETE FROM voices WHERE id = ?').run(id)
  }

  // ---------- 供应商接入（设置 → 语言模型） ----------

  /** 读出全部接入（密钥字段已解密），按创建顺序 */
  connectionList(): ModelConnection[] {
    return this.adb
      .prepare('SELECT * FROM llm_connections ORDER BY created_at ASC')
      .all()
      .map((row) => this.toModelConnection(row as Record<string, unknown>))
  }

  connectionGet(id: string): ModelConnection | null {
    const row = this.adb.prepare('SELECT * FROM llm_connections WHERE id = ?').get(id)
    return row ? this.toModelConnection(row as Record<string, unknown>) : null
  }

  /** 新建/更新接入。密钥字段留空表示不修改（沿用已保存的那个） */
  connectionSave(input: ModelConnectionInput): ModelConnection {
    const now = Date.now()
    const id = input.id || `model-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const existing = input.id ? this.connectionGet(input.id) : null
    const secrets = secretFieldKeys(input.providerId)
    const params: ModelConnection['params'] = {}
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (secrets.includes(key) && String(value ?? '') === '' && existing) {
        params[key] = existing.params[key] ?? ''
        continue
      }
      params[key] = value
    }
    for (const key of secrets) {
      if (!(key in params)) params[key] = existing?.params[key] ?? ''
    }
    const models = [...new Set((input.models ?? []).map((model) => model.trim()).filter(Boolean))]
    // 模型级窗口：只收 models 里存在的 id、正整数才留（4096 起步，再小没有实用价值）
    const modelContextWindows: Record<string, number> = {}
    for (const [key, value] of Object.entries(input.modelContextWindows ?? {})) {
      const id2 = key.trim()
      const window2 = typeof value === 'number' ? Math.floor(value) : 0
      if (models.includes(id2) && window2 >= 4096) modelContextWindows[id2] = window2
    }
    // 模型级思考强度：只收 models 里存在的 id、档位合法才留
    const modelThinkingLevels: Record<string, string> = {}
    for (const [key, value] of Object.entries(input.modelThinkingLevels ?? {})) {
      const id2 = key.trim()
      if (models.includes(id2) && ['off', 'low', 'medium', 'high'].includes(String(value))) {
        modelThinkingLevels[id2] = String(value)
      }
    }
    // 模型级高级参数：只收 models 里存在的 id；空对象（啥也没配）不落盘
    const modelParams: Record<string, Record<string, unknown>> = {}
    for (const [key, value] of Object.entries(input.modelParams ?? {})) {
      const id2 = key.trim()
      if (!models.includes(id2) || !value || typeof value !== 'object') continue
      const clean: Record<string, unknown> = {}
      if (value.vision === true) clean.vision = true
      const temperature = Number(value.temperature)
      if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) clean.temperature = temperature
      const maxTokens = Math.floor(Number(value.maxTokens))
      if (Number.isFinite(maxTokens) && maxTokens >= 1024) clean.maxTokens = maxTokens
      if (Object.keys(clean).length > 0) modelParams[id2] = clean
    }
    this.adb
      .prepare(
        `INSERT INTO llm_connections (id, name, provider_id, params, models, model_windows, model_thinking, model_params, created_at, updated_at)
         VALUES (@id, @name, @providerId, @params, @models, @modelWindows, @modelThinking, @modelParams, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, provider_id = @providerId, params = @params,
           models = @models, model_windows = @modelWindows, model_thinking = @modelThinking, model_params = @modelParams, updated_at = @updatedAt`
      )
      .run({
        id,
        name: input.name.trim() || getLlmProvider(input.providerId)?.label || '未命名接入',
        providerId: input.providerId,
        params: JSON.stringify(this.encryptParams(params, input.providerId)),
        models: JSON.stringify(models),
        modelWindows: JSON.stringify(modelContextWindows),
        modelThinking: JSON.stringify(modelThinkingLevels),
        modelParams: JSON.stringify(modelParams),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })

    return this.connectionGet(id) as ModelConnection
  }

  connectionDelete(id: string): void {
    this.adb.prepare('DELETE FROM llm_connections WHERE id = ?').run(id)
  }

  /** 给渲染层的列表：密钥值置空，只留 hasSecret / ready 两个判断 */
  connectionListSafe(): ModelConnectionSafe[] {
    return this.connectionList().map((connection) => {
      const secrets = secretFieldKeys(connection.providerId)
      const hasSecret = secrets.some((key) => String(connection.params[key] ?? '').trim().length > 0)
      const params = { ...connection.params }
      for (const key of secrets) params[key] = ''
      return {
        ...connection,
        params,
        hasSecret,
        ready: isModelConnectionReady(connection, getLlmProvider(connection.providerId))
      }
    })
  }

  private toModelConnection(r: Record<string, unknown>): ModelConnection {
    const providerId = str(r.provider_id)
    const rawModels = parseJson<unknown>(r.models, [])
    const models = Array.isArray(rawModels)
      ? rawModels.map(String).filter((model) => model.trim().length > 0)
      : []
    const rawWindows = parseJson<unknown>(r.model_windows, {})
    const modelContextWindows: Record<string, number> = {}
    if (rawWindows && typeof rawWindows === 'object' && !Array.isArray(rawWindows)) {
      for (const [key, value] of Object.entries(rawWindows as Record<string, unknown>)) {
        if (typeof value === 'number' && value > 0) modelContextWindows[key] = Math.floor(value)
      }
    }
    const rawThinking = parseJson<unknown>(r.model_thinking, {})
    const modelThinkingLevels: Record<string, ModelConnection['modelThinkingLevels'][string]> = {}
    if (rawThinking && typeof rawThinking === 'object' && !Array.isArray(rawThinking)) {
      for (const [key, value] of Object.entries(rawThinking as Record<string, unknown>)) {
        if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') {
          modelThinkingLevels[key] = value
        }
      }
    }
    const rawParams = parseJson<unknown>(r.model_params, {})
    const modelParams: ModelConnection['modelParams'] = {}
    if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
      for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const v = value as Record<string, unknown>
          modelParams[key] = {
            vision: v.vision === true ? true : undefined,
            temperature: typeof v.temperature === 'number' ? v.temperature : undefined,
            maxTokens: typeof v.maxTokens === 'number' ? v.maxTokens : undefined
          }
        }
      }
    }
    return {
      id: str(r.id),
      name: str(r.name),
      providerId,
      params: this.decryptParams(r.params, providerId),
      models,
      modelContextWindows,
      modelThinkingLevels,
      modelParams,
      createdAt: num(r.created_at) ?? 0,
      updatedAt: num(r.updated_at) ?? 0
    }
  }

  // ---------- 语音合成的供应商接入（设置 → 语音合成） ----------

  /** 读出全部接入（密钥字段已解密），按创建顺序 */
  ttsConnectionList(): TtsConnection[] {
    return this.adb
      .prepare('SELECT * FROM tts_connections ORDER BY created_at ASC')
      .all()
      .map((row) => this.toTtsConnection(row as Record<string, unknown>))
  }

  ttsConnectionGet(id: string): TtsConnection | null {
    const row = this.adb.prepare('SELECT * FROM tts_connections WHERE id = ?').get(id)
    return row ? this.toTtsConnection(row as Record<string, unknown>) : null
  }

  /** 新建/更新接入（按 id UPSERT；id 空则新建）。密钥字段留空表示不修改（沿用已保存的那个） */
  ttsConnectionSave(input: TtsConnectionInput): TtsConnection {
    const now = Date.now()
    const id = input.id || `tts-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const existing = this.ttsConnectionGet(id)
    const secrets = ttsSecretFieldKeys(input.providerId)
    const params: TtsConnection['params'] = {}
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (secrets.includes(key) && String(value ?? '') === '' && existing) {
        params[key] = existing.params[key] ?? ''
        continue
      }
      params[key] = value
    }
    for (const key of secrets) {
      if (!(key in params)) params[key] = existing?.params[key] ?? ''
    }

    // 启用模型：去空去重，只保留 manifest 里声明过的模型 id
    const def = getTtsProvider(input.providerId)
    const seen = new Set<string>()
    const models: TtsConnectionModel[] = []
    for (const model of input.models ?? []) {
      const modelId = model.id.trim()
      if (!modelId || seen.has(modelId)) continue
      if (def && !def.models.some((spec) => spec.id === modelId)) continue
      seen.add(modelId)
      models.push({ id: modelId, params: model.params ?? {} })
    }
    this.adb
      .prepare(
        `INSERT INTO tts_connections (id, provider_id, name, params, models, realtime, created_at, updated_at)
         VALUES (@id, @providerId, @name, @params, @models, @realtime, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, provider_id = @providerId, params = @params,
           models = @models, realtime = @realtime, updated_at = @updatedAt`
      )
      .run({
        id,
        providerId: input.providerId,
        name: input.name.trim() || def?.label || '未命名接入',
        params: JSON.stringify(this.encryptTtsParams(params, input.providerId)),
        models: JSON.stringify(models),
        realtime: (input.realtime ?? existing?.realtime ?? false) ? 1 : 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })

    return this.ttsConnectionGet(id) as TtsConnection
  }

  /** 删除接入（音色路由按接入 id 找接入：删掉的接入下的克隆音色会指过来报错，界面会提示补回） */
  ttsConnectionDelete(id: string): void {
    this.adb.prepare('DELETE FROM tts_connections WHERE id = ?').run(id)
  }

  /** 给渲染层的列表：密钥值置空，只留 hasSecret / ready 两个判断 */
  ttsConnectionListSafe(): TtsConnectionSafe[] {
    return this.ttsConnectionList().map((connection) => {
      const secrets = ttsSecretFieldKeys(connection.providerId)
      const hasSecret = secrets.some((key) => String(connection.params[key] ?? '').trim().length > 0)
      const params = { ...connection.params }
      for (const key of secrets) params[key] = ''
      const def = getTtsProvider(connection.providerId)
      return {
        ...connection,
        params,
        hasSecret,
        ready: isTtsConnectionReady(connection, def),
        // 逐模型给可用性：界面据此只禁用「这个模型不能用」，而不是整条接入一起废掉
        usableModels: connection.models
          .map((model) => model.id)
          .filter((id) => isTtsModelUsable(connection, def, id))
      }
    })
  }

  private toTtsConnection(r: Record<string, unknown>): TtsConnection {
    const providerId = str(r.provider_id) as TtsConnection['providerId']
    const rawModels = parseJson<unknown>(r.models, [])
    const models: TtsConnectionModel[] = Array.isArray(rawModels)
      ? rawModels
          .map((item) => {
            const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
            const params =
              row.params && typeof row.params === 'object'
                ? (row.params as TtsConnectionModel['params'])
                : {}
            return { id: String(row.id ?? ''), params }
          })
          .filter((model) => model.id.trim().length > 0)
      : []
    return {
      id: str(r.id),
      providerId,
      name: str(r.name),
      params: this.decryptTtsParams(r.params, providerId),
      models,
      realtime: Number(r.realtime) === 1,
      createdAt: num(r.created_at) ?? 0,
      updatedAt: num(r.updated_at) ?? 0
    }
  }

  /** 密钥字段按 {"__enc": base64} 加密后内联进 params，与 config.json 用同一套写法 */
  private encryptParams(
    params: ModelConnection['params'],
    providerId: string
  ): Record<string, string | number | boolean | { __enc: string }> {
    return this.encryptSecrets(params, secretFieldKeys(providerId))
  }

  private decryptParams(raw: unknown, providerId: string): ModelConnection['params'] {
    return this.decryptSecrets(raw, secretFieldKeys(providerId))
  }

  private encryptTtsParams(
    params: TtsConnection['params'],
    providerId: string
  ): Record<string, string | number | boolean | { __enc: string }> {
    return this.encryptSecrets(params, ttsSecretFieldKeys(providerId))
  }

  private decryptTtsParams(raw: unknown, providerId: string): TtsConnection['params'] {
    return this.decryptSecrets(raw, ttsSecretFieldKeys(providerId))
  }

  /** 解一个密文值；解不开返回 null，调用方置空——界面按「凭据缺失」提示重填 */
  private unsealValue(sealed: string): string | null {
    if (!isV2Sealed(sealed)) return null
    try {
      return openSeal(sealed)
    } catch {
      return null
    }
  }

  private encryptSecrets(
    params: Record<string, string | number | boolean>,
    secrets: string[]
  ): Record<string, string | number | boolean | { __enc: string }> {
    const out: Record<string, string | number | boolean | { __enc: string }> = {}
    for (const [key, value] of Object.entries(params)) {
      if (secrets.includes(key) && typeof value === 'string' && value.length > 0) {
        out[key] = { __enc: seal(value) }
        continue
      }
      out[key] = value
    }
    return out
  }

  private decryptSecrets(raw: unknown, secrets: string[]): Record<string, string | number | boolean> {
    const parsed = parseJson<Record<string, unknown>>(raw, {})
    const out: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (secrets.includes(key) && value && typeof value === 'object' && '__enc' in value) {
        const plain = this.unsealValue(String((value as { __enc: unknown }).__enc))
        out[key] = plain ?? ''
        continue
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    }
    return out
  }

  private createModelConnectionsTable(): void {
    this.adb.exec(`
      CREATE TABLE IF NOT EXISTS llm_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        models TEXT NOT NULL DEFAULT '[]',
        model_windows TEXT NOT NULL DEFAULT '{}',
        model_thinking TEXT NOT NULL DEFAULT '{}',
        model_params TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  // ---------- 应用配置 ----------

  private loadConfig(): AppConfig {
    try {
      const row = this.adb.prepare('SELECT data FROM app_config WHERE id = 1').get() as
        | { data?: unknown }
        | undefined
      if (row && typeof row.data === 'string') {
        return this.parseStoredConfig(JSON.parse(row.data) as Record<string, unknown>)
      }
      return structuredClone(DEFAULT_CONFIG)
    } catch (error) {
      console.error('[YunCast] 读取配置失败，用默认值:', error)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  /** 解密敏感字段 + 校验成 AppConfig */
  private parseStoredConfig(raw: Record<string, unknown>): AppConfig {
    let dirty = false
    for (const key of SECRET_KEYS) {
      const value = getPath(raw, key) as StoredValue | undefined
      if (value && typeof value === 'object' && '__enc' in value) {
        setPath(raw, key, this.unsealValue(value.__enc) ?? '')
        dirty = true
      }
    }
    // 配置里没有导演这一段就补默认值
    if (!('director' in raw)) {
      raw.director = { name: DEFAULT_DIRECTOR_CONFIG.name, modelConnectionId: null, model: '' }
      dirty = true
    }
    const config = parseAppConfig(raw)
    if (dirty) {
      this.config = config
      this.saveConfig()
    }
    return config
  }

  getConfig(): AppConfig {
    return this.config
  }

  setConfig(patch: PartialDeep<AppConfig>): AppConfig {
    this.config = parseAppConfig(mergeDeep(this.config, patch))
    this.saveConfig()
    for (const listener of this.configListeners) listener(this.config)
    this.onDataChanged?.('settings')
    return this.config
  }

  /** 配置变了就回调（主进程里用来同步窗口 chrome） */
  onConfigChange(listener: (config: AppConfig) => void): () => void {
    this.configListeners.add(listener)
    return () => this.configListeners.delete(listener)
  }

  /** 命令行在应用没开时用这个路径把应用拉起来（main 启动时写入）。 */
  setLaunch(appPath: string, args: string[]): void {
    this.launchApp = appPath
    this.launchArgs = args
    this.writeMcpFile()
  }

  private saveConfig(): void {
    try {
      const clone = JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>
      for (const key of SECRET_KEYS) {
        const value = getPath(clone, key)
        if (typeof value === 'string' && value.length > 0) {
          setPath(clone, key, { __enc: seal(value) })
        }
      }
      this.adb
        .prepare('INSERT INTO app_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
        .run(JSON.stringify(clone))
    } catch (error) {
      console.error('[YunCast] 写入配置失败:', error)
    }
    // 配置保存时重写端点文件（userData/mcp.json）：本机 Agent / CLI 从这里读地址和令牌
    this.writeMcpFile()
  }

  /** 给本机 Agent 和 CLI 自己注册 MCP 用。令牌只写在 userData，不进仓库。 */
  private writeMcpFile(): void {
    try {
      const mcp = this.config.mcp
      // Go 版 CLI（cli/dist/<os>-<arch>/，os 用 electron-builder 宏口径 win/mac/linux；打包后落在 resources/bin/）：不依赖 Node
      const exe = process.platform === 'win32' ? 'yuncast.exe' : 'yuncast'
      const osDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
      const cli = app.isPackaged
        ? join(process.resourcesPath, 'bin', exe)
        : join(app.getAppPath(), 'cli', 'dist', `${osDir}-${process.arch}`, exe)
      writeFileSync(
        join(app.getPath('userData'), 'mcp.json'),
        `${JSON.stringify(
          {
            name: 'yuncast',
            url: `http://${MCP_HOST}:${mcp.port}/mcp`,
            token: mcp.token,
            enabled: mcp.enabled,
            cli,
            app: this.launchApp,
            args: this.launchArgs
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    } catch (error) {
      console.warn('[YunCast] 写 MCP 端点文件失败:', error)
    }
  }

  // ---------- 话术池存储 ----------

  /**
   * 数据变更广播钩子（index.ts 接成 data:changed 推给所有窗口）。
   * 挂在存储层是刻意的：界面刷新只认「库真的变了」这一个信号，
   * IPC、agent 工具、MCP 三条写路径于是自动都覆盖，不用每个调用方各记得广播一次。
   */
  onDataChanged: ((scope: DataChangeScope, detail?: string) => void) | null = null

  poolItemInsert(item: PoolItem): void {
    this.db
      .prepare(
        `INSERT INTO pool_items
         (id, live_session_id, script_id, text, turn_id, seq, voice_id, source_actor_id, source_kind, lane,
          dedupe_key, expires_at, reply_to, status, audio_path, speech_text, delivery, rate, pitch, emotion, emotion_scale, pause_after_ms, stream,
          origin_draft_unit_id, error, sort_order, queue_seq, created_at, played_at, text_zh)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.sessionId,
        item.scriptId,
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
        item.delivery ?? null,
        item.rate ?? null,
        item.pitch ?? null,
        item.emotion ?? null,
        item.emotionScale ?? null,
        item.pauseAfterMs ?? null,
        item.stream ? 1 : 0,
        item.originDraftUnitId ?? null,
        item.error ?? null,
        item.sortOrder ?? null,
        item.queueSeq ?? null,
        item.createdAt,
        item.playedAt ?? null,
        item.textZh ?? ''
      )
  }

  poolItemUpdate(id: string, patch: Partial<PoolItem>): void {
    const columns: Record<string, unknown> = {}
    if (patch.text !== undefined) columns.text = patch.text
    if (patch.status !== undefined) columns.status = patch.status
    if (patch.audioPath !== undefined) columns.audio_path = patch.audioPath ?? null
    if (patch.error !== undefined) columns.error = patch.error ?? null
    if (patch.sortOrder !== undefined) columns.sort_order = patch.sortOrder ?? null
    if (patch.expiresAt !== undefined) columns.expires_at = patch.expiresAt ?? null
    if (patch.playedAt !== undefined) columns.played_at = patch.playedAt ?? null
    if (patch.voiceId !== undefined) columns.voice_id = patch.voiceId
    if (patch.pauseAfterMs !== undefined) columns.pause_after_ms = patch.pauseAfterMs ?? null
    if (patch.stream !== undefined) columns.stream = patch.stream ? 1 : 0
    if (patch.lane !== undefined) columns.lane = patch.lane
    if (patch.speechText !== undefined) columns.speech_text = patch.speechText ?? null
    if (patch.emotion !== undefined) columns.emotion = patch.emotion || null
    if (patch.emotionScale !== undefined) columns.emotion_scale = patch.emotionScale ?? null
    const keys = Object.keys(columns)
    if (keys.length === 0) return
    const sql = `UPDATE pool_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    this.db.prepare(sql).run(...(keys.map((k) => columns[k]) as never[]), id)
  }

  poolItemGet(id: string): PoolItem | null {
    const row = this.db.prepare('SELECT * FROM pool_items WHERE id = ?').get(id)
    return row ? rowToItem(row as unknown as PoolItemRow) : null
  }

  /** 未播完的条目（pending/synthesizing/ready/playing），排序由 SpeechPool 负责；传 scriptId 只取这本剧本的 */
  poolItemActive(scriptId?: string): PoolItem[] {
    const sql = scriptId
      ? `SELECT * FROM pool_items WHERE script_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
      : `SELECT * FROM pool_items WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    const rows = (
      scriptId
        ? this.db.prepare(sql).all(scriptId, ...ACTIVE_STATUSES)
        : this.db.prepare(sql).all(...ACTIVE_STATUSES)
    ) as unknown[]
    return rows.map((row) => rowToItem(row as PoolItemRow))
  }

  /** 某时间点之后进入终态失败的条目 */
  poolItemFailedSince(since: number): PoolItem[] {
    const rows = this.db
      .prepare("SELECT * FROM pool_items WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC")
      .all(since)
    return rows.map((row) => rowToItem(row as unknown as PoolItemRow))
  }

  /**
   * 最近播完的条目。
   * programId 传了就只取这个节目的（直播台的历史必须按节目隔离——否则切到别的节目，
   * 中间会混进上一场甚至别的节目的残留，看着像"这段话我没说过"）。
   * sessionId 传了就只取这一场的（播出中卡片流只展示本场播过什么，不混上一场）。
   */
  poolItemRecentPlayed(n: number, programId?: string, sessionId?: string): PoolItem[] {
    const conditions = ["p.status IN ('done', 'interrupted')"]
    const args: string[] = []
    if (programId) {
      conditions.push('s.script_id = ?')
      args.push(programId)
    }
    if (sessionId) {
      conditions.push('p.live_session_id = ?')
      args.push(sessionId)
    }
    const sql = `SELECT p.* FROM pool_items p
      ${programId ? 'JOIN live_sessions s ON s.id = p.live_session_id' : ''}
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.played_at DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, n) as unknown[]
    return rows.map((row) => rowToItem(row as PoolItemRow))
  }

  /** 限流统计：某来源在 since 之后创建的条目数 */
  poolItemCountBySourceSince(sourceAgentId: string, sourceKind: string, since: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM pool_items WHERE source_actor_id = ? AND source_kind = ? AND created_at >= ?'
      )
      .get(sourceAgentId, sourceKind, since)
    return typeof row?.n === 'number' ? row.n : 0
  }

  /** 按 dedupeKey 找未播条目（去重合并用）。playing 也算「在池里」：正在播的不能重装，否则一段话在队列里出现两次 */
  /**
   * 循环回卷：把本场已播/被打断的条目重置回就绪（同一批行、音频不动）。
   * 同时按上一轮的实际播出顺序重编号：下一轮严格从第一段重来，
   * 不依赖入库时可能为空或错位的 sort_order（否则回卷后会从中间某段开始）。
   * 返回回卷条数；0 = 没有可回卷的（需要重新装库）。
   */
  /**
   * 循环回卷：把本场已播/被打断的**稿子条目**重置回就绪（同一批行、音频不动）。
   * 只回卷带 queue_seq 的（= 从稿子装载进池的）；现场插话、评论回复、触发词这类一次性内容不复播。
   * 顺序一并恢复成装载时的稿子顺序：清掉 sort_order，让排序回落到 queue_seq。
   * 「上一段/仅播此条」写进去的临时队首只在当轮有效——否则播完一轮就再也回不到第一段。
   */
  poolRewind(sessionId: string, scriptId: string): number {
    const result = this.db
      .prepare(
        `UPDATE pool_items SET status = 'ready', played_at = NULL, sort_order = NULL
          WHERE live_session_id = ? AND script_id = ? AND queue_seq IS NOT NULL
            AND status IN ('done', 'interrupted')`
      )
      .run(sessionId, scriptId)
    return Number((result as { changes?: number }).changes ?? 0)
  }

  /** 按 dedupeKey 找最近一条（含已播）：上一段回退时复用同一行，不新增条目 */
  poolItemFindByDedupeKey(dedupeKey: string, sessionId: string): PoolItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pool_items WHERE dedupe_key = ? AND live_session_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(dedupeKey, sessionId)
    return row ? rowToItem(row as unknown as PoolItemRow) : null
  }

  /** 单条回退：重置为就绪并排到队首（不改文本、不改音频） */
  poolItemRewind(id: string, sortOrder: number): void {
    this.db
      .prepare(`UPDATE pool_items SET status = 'ready', played_at = NULL, sort_order = ? WHERE id = ?`)
      .run(sortOrder, id)
  }

  poolItemFindActiveByDedupeKey(dedupeKey: string): PoolItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pool_items WHERE dedupe_key = ? AND status IN ('pending', 'synthesizing', 'ready', 'playing') ORDER BY created_at DESC LIMIT 1`
      )
      .get(dedupeKey)
    return row ? rowToItem(row as unknown as PoolItemRow) : null
  }

  /**
   * 每条底稿（origin_draft_unit_id）最近一次进池的时间（轮播公平排序用：
   * 没播过的最优先，播过的按最久没播排，整个场景的话术轮得上，不饿死队尾）
   */
  poolItemLastLoadedByOrigin(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT origin_draft_unit_id AS origin, MAX(created_at) AS last_at
         FROM pool_items WHERE origin_draft_unit_id IS NOT NULL AND origin_draft_unit_id != ''
         GROUP BY origin_draft_unit_id`
      )
      .all() as { origin: unknown; last_at: unknown }[]
    const map = new Map<string, number>()
    for (const row of rows) map.set(str(row.origin), num(row.last_at) ?? 0)
    return map
  }

  /** 清理过期终态：done 只留最近 200 条，其余终态 1 小时后删除 */
  /** 仍被引用的音频路径（缓存清理时跳过）：话术池条目 + 底稿库条目（含段落切片的 wav） */
  poolItemReferencedAudioPaths(): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT audio_path AS path FROM pool_items WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION
         SELECT DISTINCT audio_path AS path FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''`
      )
      .all()
      .map((row) => str((row as Record<string, unknown>).path))
      .filter(Boolean)
  }

  poolItemPrune(): void {
    // 场记豁免：归到某个场次的条目是播出留档，不随池裁剪删除（删场次时才级联清掉）。
    const doomed = [
      ...(this.db
        .prepare(
          `SELECT id, audio_path FROM pool_items WHERE status IN ('skipped', 'failed', 'expired') AND created_at < ${Date.now() - 3600_000}
           AND live_session_id NOT IN (SELECT id FROM live_sessions)`
        )
        .all() as Record<string, unknown>[]),
      ...(this.db
        .prepare(
          `SELECT id, audio_path FROM pool_items WHERE status = 'done'
           AND live_session_id NOT IN (SELECT id FROM live_sessions)
           AND id NOT IN (
            SELECT id FROM pool_items WHERE status = 'done' ORDER BY played_at DESC LIMIT 200
          )`
        )
        .all() as Record<string, unknown>[])
    ]
    if (doomed.length === 0) return
    const del = this.db.prepare('DELETE FROM pool_items WHERE id = ?')
    for (const row of doomed) del.run(str(row.id))
  }

  // ---------- 场记（场次记录，docs 见 SessionRecorder） ----------

  sessionInsert(session: BroadcastSession): void {
    this.db
      .prepare(
        `INSERT INTO live_sessions (id, script_id, program_name, director_model_desc, started_at, ended_at, end_reason, stats, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.programId,
        session.programName,
        session.directorModelDesc,
        session.startedAt,
        session.endedAt,
        session.endReason,
        JSON.stringify(session.stats),
        session.summary
      )
  }

  /** 下播复盘摘要写进场次（场记详情/session_history 工具都读这） */
  sessionSetSummary(id: string, summary: string): void {
    this.db.prepare('UPDATE live_sessions SET summary = ? WHERE id = ?').run(summary, id)
  }

  /** 收播：补结束时刻/原因，并当场结算统计（播出数/评论数/回复数） */
  sessionFinish(id: string, endReason: BroadcastEndReason): void {
    const session = this.sessionGet(id)
    if (!session || session.endedAt) return
    const played = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM pool_items WHERE live_session_id = ? AND status IN ('done', 'interrupted')").get(id) as Record<string, unknown>)?.n ?? 0
    )
    const comments = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM broadcast_events WHERE live_session_id = ? AND kind = 'comment'").get(id) as Record<string, unknown>)?.n ?? 0
    )
    const replies = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM pool_items WHERE live_session_id = ? AND reply_to IS NOT NULL AND reply_to != ''").get(id) as Record<string, unknown>)?.n ?? 0
    )
    this.db
      .prepare('UPDATE live_sessions SET ended_at = ?, end_reason = ?, stats = ? WHERE id = ?')
      .run(Date.now(), endReason, JSON.stringify({ played, comments, replies }), id)
  }

  sessionGet(id: string): BroadcastSession | null {
    const row = this.db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToSession(row) : null
  }

  /** 还在播的场次（ended_at = 0）：启动时补尾（crash）与「当前是否开着场」判断都用它 */
  sessionListUnfinished(): BroadcastSession[] {
    return (this.db.prepare('SELECT * FROM live_sessions WHERE ended_at = 0').all() as Record<string, unknown>[]).map(rowToSession)
  }

  /** 场次列表：可按节目筛选，新场在前 */
  sessionList(programId?: string): BroadcastSession[] {
    const rows = programId
      ? this.db.prepare('SELECT * FROM live_sessions WHERE script_id = ? ORDER BY started_at DESC').all(programId)
      : this.db.prepare('SELECT * FROM live_sessions ORDER BY started_at DESC').all()
    return (rows as Record<string, unknown>[]).map(rowToSession)
  }

  /** 场次内的话术播出条目：按实际播出顺序（没播完的按入池时间排尾） */
  sessionSpeechItems(sessionId: string): PoolItem[] {
    const rows = this.db
      .prepare('SELECT * FROM pool_items WHERE live_session_id = ? ORDER BY COALESCE(played_at, created_at)')
      .all(sessionId) as unknown as PoolItemRow[]
    return rows.map(rowToItem)
  }

  sessionEvents(sessionId: string): BroadcastEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM broadcast_events WHERE live_session_id = ? ORDER BY ts')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map(rowToEvent)
  }

  /** 场次互动观众聚合：本场评论按作者分组（发言数 + 最近 5 条内容，新的在前），按发言数排序 */
  sessionViewerAgg(sessionId: string): { name: string; count: number; contents: string[] }[] {
    const rows = this.db
      .prepare("SELECT payload FROM broadcast_events WHERE live_session_id = ? AND kind = 'comment' ORDER BY ts")
      .all(sessionId) as Record<string, unknown>[]
    const map = new Map<string, { name: string; count: number; contents: string[] }>()
    for (const row of rows) {
      const payload = parseJson<Record<string, unknown>>(row.payload, {})
      const name = str(payload.author) || '匿名'
      const content = str(payload.content)
      const entry = map.get(name) ?? { name, count: 0, contents: [] }
      entry.count += 1
      if (content) entry.contents = [content, ...entry.contents].slice(0, 5)
      map.set(name, entry)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }

  broadcastEventInsert(event: BroadcastEvent): void {
    this.db
      .prepare('INSERT INTO broadcast_events (id, live_session_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.sessionId, event.ts, event.kind, JSON.stringify(event.payload))
  }

  /**
   * 开场时把**本剧本**的池里存货改挂到新场次：播出事实跟着实际播出的那场走。
   * 必须带 scriptId：以前不带，上一本剧本的存货会被算进这一场（串台）。
   */
  poolItemRestampActive(sessionId: string, scriptId: string): void {
    this.db
      .prepare(
        `UPDATE pool_items SET live_session_id = ?
          WHERE script_id = ? AND status IN ('pending', 'synthesizing', 'ready', 'playing')`
      )
      .run(sessionId, scriptId)
  }

  /** 删场次：连带删它的播出条目与事件镜像，最后删场次行 */
  sessionDelete(id: string): void {
    const items = this.db.prepare('SELECT id FROM pool_items WHERE live_session_id = ?').all(id) as Record<string, unknown>[]
    const delItem = this.db.prepare('DELETE FROM pool_items WHERE id = ?')
    for (const row of items) delItem.run(str(row.id))
    this.db.prepare('DELETE FROM broadcast_events WHERE live_session_id = ?').run(id)
    this.db.prepare('DELETE FROM live_sessions WHERE id = ?').run(id)
    this.onDataChanged?.('sessions')
  }

  // ---------- 统计可视化（docs/REDESIGN 4.11）：场次/互动聚合 SQL ----------

  /** 统计页全局图表一屏数据：KPI + 播出/互动趋势 + 节目/主播排行 + 热词。query.from/to 毫秒，0/缺省 = 不限 */
  statsGlobal(query: StatsQuery = {}): StatsGlobal {
    const conds: string[] = []
    const args: Record<string, string | number> = {}
    if (query.from && query.from > 0) {
      conds.push('started_at >= @from')
      args.from = query.from
    }
    if (query.to && query.to > 0) {
      conds.push('started_at <= @to')
      args.to = query.to
    }
    if (query.programId) {
      conds.push('script_id = @pid')
      args.pid = query.programId
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const sessionIds = `SELECT id FROM live_sessions ${where}`
    const sessions = this.db
      .prepare(
        `SELECT id, script_id, program_name, started_at, ended_at FROM live_sessions ${where} ORDER BY started_at`
      )
      .all(args) as Record<string, unknown>[]
    const comments = this.db
      .prepare(`SELECT live_session_id, ts, payload FROM broadcast_events WHERE kind = 'comment' AND live_session_id IN (${sessionIds})`)
      .all(args) as Record<string, unknown>[]
    const playedItems = this.db
      .prepare(
        `SELECT text FROM pool_items WHERE status IN ('done', 'interrupted') AND live_session_id IN (${sessionIds})`
      )
      .all(args) as Record<string, unknown>[]
    // 合成量走 tts_records（合成事实表；它与场次的口径不同——按自己的 ts/script_id 筛）
    const ttsConds: string[] = []
    const ttsArgs: Record<string, string | number> = {}
    if (query.from && query.from > 0) {
      ttsConds.push('ts >= @from')
      ttsArgs.from = query.from
    }
    if (query.to && query.to > 0) {
      ttsConds.push('ts <= @to')
      ttsArgs.to = query.to
    }
    if (query.programId) {
      ttsConds.push('script_id = @pid')
      ttsArgs.pid = query.programId
    }
    const ttsChars = num(
      (
        this.adb
          .prepare(`SELECT COALESCE(SUM(chars), 0) AS n FROM tts_records ${ttsConds.length > 0 ? `WHERE ${ttsConds.join(' AND ')}` : ''}`)
          .get(ttsArgs) as Record<string, unknown>
      )?.n
    ) ?? 0

    const now = Date.now()
    const sessionMinutes = (row: Record<string, unknown>): number =>
      Math.max(0, ((num(row.ended_at) ?? 0) || now) - (num(row.started_at) ?? 0)) / 60000
    const dayKey = (ts: number): string => {
      const d = new Date(ts)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    // 趋势区间：到 query.to/今天为止，最多 30 天（from 更晚则从 from 起）
    const trendEnd = new Date(query.to && query.to > 0 ? query.to : now)
    const endDayStart = new Date(trendEnd.getFullYear(), trendEnd.getMonth(), trendEnd.getDate()).getTime()
    const trendStart = Math.max(query.from && query.from > 0 ? query.from : 0, endDayStart - 29 * 24 * 3600_000)
    const trendDays: string[] = []
    for (let t = trendStart; t <= endDayStart; t += 24 * 3600_000) trendDays.push(dayKey(t))
    const sessByDay = new Map<string, { sessions: number; minutes: number }>()
    const commentsByDay = new Map<string, number>()
    const viewersByDay = new Map<string, Set<string>>()
    const viewersAll = new Set<string>()
    for (const row of sessions) {
      const key = dayKey(num(row.started_at) ?? 0)
      const entry = sessByDay.get(key) ?? { sessions: 0, minutes: 0 }
      entry.sessions += 1
      entry.minutes += sessionMinutes(row)
      sessByDay.set(key, entry)
    }
    const programOf = new Map(sessions.map((row) => [str(row.id), str(row.script_id)]))
    const commentsByProgram = new Map<string, number>()
    for (const row of comments) {
      const key = dayKey(num(row.ts) ?? 0)
      commentsByDay.set(key, (commentsByDay.get(key) ?? 0) + 1)
      const author = str(parseJson<Record<string, unknown>>(row.payload, {}).author) || '匿名'
      if (!viewersByDay.has(key)) viewersByDay.set(key, new Set())
      viewersByDay.get(key)?.add(author)
      viewersAll.add(author)
      const pid = programOf.get(str(row.live_session_id)) ?? ''
      commentsByProgram.set(pid, (commentsByProgram.get(pid) ?? 0) + 1)
    }

    // 节目排行（场次数 / 总时长 / 场均评论），按场次数排
    const programAgg = new Map<string, { programId: string; programName: string; sessions: number; minutes: number }>()
    for (const row of sessions) {
      const pid = str(row.script_id)
      const entry = programAgg.get(pid) ?? { programId: pid, programName: str(row.program_name) || '未命名节目', sessions: 0, minutes: 0 }
      entry.sessions += 1
      entry.minutes += sessionMinutes(row)
      programAgg.set(pid, entry)
    }
    const byProgram = [...programAgg.values()]
      .map((entry) => ({
        ...entry,
        minutes: Math.round(entry.minutes),
        avgComments: Math.round(((commentsByProgram.get(entry.programId) ?? 0) / entry.sessions) * 10) / 10
      }))
      .sort((a, b) => b.sessions - a.sessions)

    return {
      totals: {
        sessions: sessions.length,
        broadcastMs: Math.round(sessions.reduce((sum, row) => sum + sessionMinutes(row) * 60000, 0)),
        comments: comments.length,
        viewers: viewersAll.size,
        speechChars: ttsChars,
        played: playedItems.length
      },
      trend: trendDays.map((day) => {
        const entry = sessByDay.get(day)
        return { day, sessions: entry?.sessions ?? 0, minutes: Math.round(entry?.minutes ?? 0) }
      }),
      interactionTrend: trendDays.map((day) => ({
        day,
        comments: commentsByDay.get(day) ?? 0,
        viewers: viewersByDay.get(day)?.size ?? 0
      })),
      byProgram,
      commentWords: hotWords(comments.map((row) => str(parseJson<Record<string, unknown>>(row.payload, {}).content))),
      speechWords: hotWords(playedItems.map((row) => stripSpeechTags(str(row.text))))
    }
  }

  /** 单场可视化（场次详情「图表」tab）：KPI + 分钟级互动热度 + 热词 + 来源构成 + 观众榜 */
  statsSession(sessionId: string): SessionStats | null {
    const session = this.sessionGet(sessionId)
    if (!session) return null
    const items = this.sessionSpeechItems(sessionId)
    const events = this.sessionEvents(sessionId)
    const played = items.filter((item) => item.status === 'done' || item.status === 'interrupted')
    const commentEvents = events.filter((event) => event.kind === 'comment')
    const viewers = new Set(commentEvents.map((event) => str(event.payload.author) || '匿名'))

    // 分钟级热度：评论按事件时刻、播出按实际播出时刻（没播完的按入池时刻）
    const heatMap = new Map<number, { comments: number; speech: number }>()
    const bump = (ts: number, key: 'comments' | 'speech') => {
      const offsetMin = Math.max(0, Math.floor((ts - session.startedAt) / 60000))
      const entry = heatMap.get(offsetMin) ?? { comments: 0, speech: 0 }
      entry[key] += 1
      heatMap.set(offsetMin, entry)
    }
    for (const event of commentEvents) bump(event.ts, 'comments')
    for (const item of played) bump(item.playedAt ?? item.createdAt, 'speech')
    const heat = [...heatMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([offsetMin, entry]) => ({ offsetMin, ...entry }))

    const sourceAgg = new Map<PoolSourceKind, number>()
    for (const item of played) sourceAgg.set(item.source.kind, (sourceAgg.get(item.source.kind) ?? 0) + 1)
    const sourceMix = [...sourceAgg.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)

    return {
      durationMs: Math.max(0, (session.endedAt || Date.now()) - session.startedAt),
      played: played.length,
      comments: commentEvents.length,
      viewers: viewers.size,
      heat,
      commentWords: hotWords(commentEvents.map((event) => str(event.payload.content))),
      sourceMix,
      topViewers: this.sessionViewerAgg(sessionId).slice(0, 10).map((v) => ({ name: v.name, count: v.count }))
    }
  }

  // ---------- 知识库 ----------

  materialList(): Material[] {
    return this.db
      .prepare('SELECT * FROM materials ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        const kind = str(r.kind)
        return {
          id: str(r.id),
          name: str(r.name),
          kind: (ENTRY_KINDS as readonly string[]).includes(kind) ? (kind as EntryKind) : 'product',
          price: num(r.price) ?? 0,
          sellingPoints: str(r.selling_points),
          faq: str(r.faq),
          content: str(r.content),
          externalId: str(r.external_id),
          meta: parseJson<Record<string, string>>(r.meta, {}),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  materialSave(product: Material): void {
    this.db
      .prepare(
        `INSERT INTO materials (id, name, kind, price, selling_points, faq, content, external_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, price = excluded.price,
           selling_points = excluded.selling_points, faq = excluded.faq,
           content = excluded.content,
           external_id = excluded.external_id, meta = excluded.meta`
      )
      .run(
        product.id,
        product.name,
        product.kind,
        product.price,
        product.sellingPoints,
        product.faq,
        product.content,
        product.externalId,
        JSON.stringify(product.meta),
        product.createdAt
      )
  }

  materialDelete(id: string): void {
    this.db.prepare('DELETE FROM materials WHERE id = ?').run(id)
  }

  materialFileList(): MaterialFile[] {
    return this.db
      .prepare('SELECT * FROM material_files ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          materialId: str(r.material_id),
          type: (str(r.type) || 'file') as 'file' | 'url',
          url: str(r.url),
          name: str(r.name),
          kind: (str(r.kind) || 'text') as MaterialFile['kind'],
          content: str(r.content),
          filePath: str(r.file_path),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  materialFileInsert(file: MaterialFile): void {
    this.db
      .prepare(
        'INSERT INTO material_files (id, material_id, type, url, name, kind, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(file.id, file.materialId, file.type ?? 'file', file.url ?? '', file.name, file.kind, file.content, file.filePath, file.createdAt)
    this.onDataChanged?.('knowledge', 'files')
  }

  materialFileDelete(id: string): void {
    this.db.prepare('DELETE FROM material_files WHERE id = ?').run(id)
    this.onDataChanged?.('knowledge', 'files')
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

  /** 场次的复盘摘要读写见 sessionGet/sessionSetSummary（episode_summaries 表已废弃并入 live_sessions.summary） */

  // ---------- 触发器 ----------

  triggerList(): Trigger[] {
    return this.adb
      .prepare('SELECT * FROM triggers ORDER BY created_at ASC')
      .all()
      .map((row) => rowToTrigger(row as Record<string, unknown>))
  }

  triggerSave(trigger: Trigger): void {
    this.adb
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
    this.onDataChanged?.('triggers')
  }

  triggerDelete(id: string): void {
    this.adb.prepare('DELETE FROM triggers WHERE id = ?').run(id)
    this.onDataChanged?.('triggers')
  }

  // ---------- 提示词模板（导演手册） ----------

  promptTemplateGet(key: string): { content: string; updatedAt: number } | null {
    const row = this.adb
      .prepare('SELECT content, updated_at FROM prompt_templates WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return { content: String(row.content), updatedAt: Number(row.updated_at) }
  }

  /** 全部模板行（只有用户手改过的 key 才有行；启动时清理死 key / 旧默认残留用） */
  promptTemplateRows(): { key: string; content: string }[] {
    return (this.adb.prepare('SELECT key, content FROM prompt_templates').all() as Record<string, unknown>[]).map(
      (row) => ({ key: str(row.key), content: str(row.content) })
    )
  }

  /** 删模板行：恢复默认就是删行（没行 = 用代码里的默认文本） */
  promptTemplateDelete(key: string): void {
    this.adb.prepare('DELETE FROM prompt_templates WHERE key = ?').run(key)
  }

  promptTemplateUpsert(key: string, content: string): void {
    this.adb
      .prepare(
        `INSERT INTO prompt_templates (key, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(key, content, Date.now())
  }

  // ---------- 事件日志 ----------

  eventLogInsert(event: LiveEvent): void {
    // 事件绑节目：写入时取当前选中节目（评论/触发器事件都落在它名下）
    const programId = this.config.live.activeProgramId || null
    this.db
      .prepare('INSERT INTO event_log (id, type, source, payload, ts, script_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, event.type, event.source, JSON.stringify(event.payload), event.ts, programId)
    // 容量滚动清理：只留最近 5000 条
    this.db.exec(
      `DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY ts DESC LIMIT 5000)`
    )
  }

  /** 最近的事件（按时间正序）：EventHub 启动回填用 */
  eventLogRecent(limit: number): LiveEvent[] {
    const rows = this.db
      .prepare('SELECT id, type, source, payload, ts, script_id FROM event_log ORDER BY ts DESC LIMIT ?')
      .all(limit) as { id: string; type: string; source: string; payload: string; ts: number; script_id: string | null }[]
    return rows.reverse().map((row) => ({
      id: row.id,
      type: row.type,
      source: row.source as LiveEvent['source'],
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      ts: row.ts,
      programId: row.script_id ?? undefined
    }))
  }

  // ---------- 用量采集（DB v3；cost 列已停用，恒 NULL） ----------

  usageInsert(record: UsageRecord): void {
    this.adb
      .prepare(
        `INSERT INTO usage_records
         (id, ts, script_id, persona_id, connection_id, model, kind, input_tokens, output_tokens, cache_read, cache_write, estimated, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.ts,
        record.programId,
        record.personaId,
        record.connectionId,
        record.model,
        record.kind,
        record.inputTokens,
        record.outputTokens,
        record.cacheRead,
        record.cacheWrite,
        record.estimated ? 1 : 0,
        record.cost
      )
  }

  ttsInsert(record: TtsRecord): void {
    this.adb
      .prepare(
        `INSERT INTO tts_records (id, ts, script_id, connection_id, model_id, voice_id, chars, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.ts,
        record.programId,
        record.connectionId,
        record.modelId,
        record.voiceId,
        record.chars,
        record.cost
      )
  }

  /** 用量看板一屏数据：今日/累计合计 + 近 30 天趋势 + 按节目分布。programId 给了就只算那个节目 */
  usageDashboard(programId?: string): UsageDashboard {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const trendStart = todayStart - 29 * 24 * 3600_000
    const where = programId ? 'WHERE script_id = @pid' : ''
    const args: Record<string, string | number> = programId ? { pid: programId } : {}
    const bucket = (table: 'usage_records' | 'tts_records', since?: number): UsageBucket => {
      const row = (
        table === 'usage_records'
          ? this.adb
              .prepare(
                `SELECT COALESCE(SUM(input_tokens), 0) AS li, COALESCE(SUM(output_tokens), 0) AS lo,
                        COALESCE(SUM(cache_read), 0) AS lcr
                 FROM usage_records ${programId ? 'WHERE script_id = @pid' : ''}
                 ${since !== undefined ? (programId ? 'AND' : 'WHERE') + ' ts >= @since' : ''}`
              )
              .get({ ...args, ...(since !== undefined ? { since } : {}) }) as Record<string, unknown>
          : this.adb
              .prepare(
                `SELECT COALESCE(SUM(chars), 0) AS tc
                 FROM tts_records ${programId ? 'WHERE script_id = @pid' : ''}
                 ${since !== undefined ? (programId ? 'AND' : 'WHERE') + ' ts >= @since' : ''}`
              )
              .get({ ...args, ...(since !== undefined ? { since } : {}) }) as Record<string, unknown>
      )
      return table === 'usage_records'
        ? {
            llmInputTokens: num(row.li) ?? 0,
            llmOutputTokens: num(row.lo) ?? 0,
            llmCacheRead: num(row.lcr) ?? 0,
            ttsChars: 0
          }
        : {
            llmInputTokens: 0,
            llmOutputTokens: 0,
            llmCacheRead: 0,
            ttsChars: num(row.tc) ?? 0
          }
    }
    const merge = (a: UsageBucket, b: UsageBucket): UsageBucket => ({
      llmInputTokens: a.llmInputTokens + b.llmInputTokens,
      llmOutputTokens: a.llmOutputTokens + b.llmOutputTokens,
      llmCacheRead: a.llmCacheRead + b.llmCacheRead,
      ttsChars: a.ttsChars + b.ttsChars
    })
    const llmTrend = this.adb
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM usage_records ${where === '' ? 'WHERE' : where + ' AND'} ts >= @start GROUP BY day`
      )
      .all({ ...args, start: trendStart }) as { day: string; tokens: number }[]
    const ttsTrend = this.adb
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(chars), 0) AS chars
         FROM tts_records ${where === '' ? 'WHERE' : where + ' AND'} ts >= @start GROUP BY day`
      )
      .all({ ...args, start: trendStart }) as { day: string; chars: number }[]
    const llmByDay = new Map(llmTrend.map((row) => [row.day, row.tokens]))
    const ttsByDay = new Map(ttsTrend.map((row) => [row.day, row.chars]))
    const trend: UsageDashboard['trend'] = []
    for (let i = 0; i < 30; i++) {
      const date = new Date(trendStart + i * 24 * 3600_000)
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      trend.push({ day, llmTokens: llmByDay.get(day) ?? 0, ttsChars: ttsByDay.get(day) ?? 0 })
    }
    // 按节目分布（不受筛选影响，始终全量——它就是用来做对比的）
    const names = new Map(this.programList().map((program) => [program.id, program.name]))
    const byProgramMap = new Map<string | null, { llmTokens: number; ttsChars: number }>()
    const collect = (table: 'usage_records' | 'tts_records', key: 'llmTokens' | 'ttsChars') => {
      const rows =
        table === 'usage_records'
          ? (this.adb
              .prepare(
                'SELECT script_id AS pid, COALESCE(SUM(input_tokens + output_tokens), 0) AS value FROM usage_records GROUP BY script_id'
              )
              .all() as { pid: string | null; value: number }[])
          : (this.adb
              .prepare('SELECT script_id AS pid, COALESCE(SUM(chars), 0) AS value FROM tts_records GROUP BY script_id')
              .all() as { pid: string | null; value: number }[])
      for (const row of rows) {
        const entry = byProgramMap.get(row.pid) ?? { llmTokens: 0, ttsChars: 0 }
        entry[key] = row.value
        byProgramMap.set(row.pid, entry)
      }
    }
    collect('usage_records', 'llmTokens')
    collect('tts_records', 'ttsChars')
    const byProgram = [...byProgramMap.entries()]
      .map(([pid, usage]) => ({
        programId: pid,
        programName: pid ? (names.get(pid) ?? '已删除节目') : '未绑定节目',
        ...usage
      }))
      .filter((entry) => entry.llmTokens > 0 || entry.ttsChars > 0)
      .sort((a, b) => b.llmTokens + b.ttsChars - (a.llmTokens + a.ttsChars))
    return {
      today: merge(bucket('usage_records', todayStart), bucket('tts_records', todayStart)),
      total: merge(bucket('usage_records'), bucket('tts_records')),
      trend,
      byProgram
    }
  }

  /** 最近的 LLM 请求记录（用量看板的明细表） */
  usageRecent(limit = 100, programId?: string): UsageRecord[] {
    const rows = (
      programId
        ? this.adb
            .prepare('SELECT * FROM usage_records WHERE script_id = ? ORDER BY ts DESC LIMIT ?')
            .all(programId, limit)
        : this.adb.prepare('SELECT * FROM usage_records ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: str(r.id),
      ts: num(r.ts) ?? 0,
      programId: r.script_id ? str(r.script_id) : null,
      personaId: str(r.persona_id),
      connectionId: str(r.connection_id),
      model: str(r.model),
      kind: (str(r.kind) || 'chat') as UsageRecord['kind'],
      inputTokens: num(r.input_tokens) ?? 0,
      outputTokens: num(r.output_tokens) ?? 0,
      cacheRead: num(r.cache_read) ?? 0,
      cacheWrite: num(r.cache_write) ?? 0,
      estimated: num(r.estimated) === 1,
      cost: typeof r.cost === 'number' ? r.cost : null
    }))
  }

  /** 最近的 TTS 合成记录（用量看板的明细表） */
  ttsRecent(limit = 100, programId?: string): TtsRecord[] {
    const rows = (
      programId
        ? this.adb
            .prepare('SELECT * FROM tts_records WHERE script_id = ? ORDER BY ts DESC LIMIT ?')
            .all(programId, limit)
        : this.adb.prepare('SELECT * FROM tts_records ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: str(r.id),
      ts: num(r.ts) ?? 0,
      programId: r.script_id ? str(r.script_id) : null,
      connectionId: str(r.connection_id),
      modelId: str(r.model_id),
      voiceId: str(r.voice_id),
      chars: num(r.chars) ?? 0,
      cost: typeof r.cost === 'number' ? r.cost : null
    }))
  }

  // ---------- 剧本资产 ----------

  // ---------- 项目清单（应用库）----------

  projectRows(): ProjectRecord[] {
    return this.adb
      .prepare('SELECT * FROM projects ORDER BY last_opened_at DESC, created_at DESC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          path: str(r.path),
          name: str(r.name),
          createdAt: num(r.created_at) ?? 0,
          lastOpenedAt: num(r.last_opened_at) ?? 0
        }
      })
  }

  projectRowInsert(record: ProjectRecord): void {
    this.adb
      .prepare(
        'INSERT OR REPLACE INTO projects (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(record.id, record.path, record.name, record.createdAt, record.lastOpenedAt)
    this.onDataChanged?.('scripts')
  }

  projectRowTouch(id: string): void {
    this.adb.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
    this.onDataChanged?.('scripts')
  }

  projectRowRemove(id: string): void {
    this.adb.prepare('DELETE FROM projects WHERE id = ?').run(id)
    this.onDataChanged?.('scripts')
  }

  /**
   * 项目（内置兼容层：`Program` 这个名字暂时保留给上层服务用）。
   * 一个项目库只有一行 project，所以这里永远返回 0 或 1 条。
   */
  programList(): Program[] {
    return this.db
      .prepare('SELECT * FROM project ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: str(r.id),
          name: str(r.name),
          theme: str(r.theme),
          plan: { scenes: parseJson<ScriptScene[]>(r.scenes, []) },
          knowledgeScope: DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
          currentSceneIdx: num(r.scene_idx) ?? 0,
          createdAt: num(r.created_at) ?? 0,
          updatedAt: num(r.updated_at) ?? 0
        }
      })
  }

  programSave(program: Program): void {
    this.db
      .prepare(
        `INSERT INTO project (id, name, type, theme, scenes, scene_idx, created_at, updated_at)
         VALUES (?, ?, 'authored', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           theme = excluded.theme,
           scenes = excluded.scenes,
           updated_at = excluded.updated_at`
      )
      .run(
        program.id,
        program.name,
        program.theme,
        JSON.stringify(program.plan.scenes ?? []),
        program.currentSceneIdx,
        program.createdAt,
        program.updatedAt
      )
    this.onDataChanged?.('scripts', program.id)
  }

  programSetSceneIdx(id: string, idx: number): void {
    this.db.prepare('UPDATE project SET scene_idx = ?, updated_at = ? WHERE id = ?').run(idx, Date.now(), id)
  }

  // ---------- 话术库（draft_units） ----------

  draftUnitList(programId: string): DraftUnit[] {
    // 列表顺序 = 叙事顺序：场景段在前（按场景内创作序号 seq），全场通用沉底
    return this.db
      .prepare(
        `SELECT * FROM draft_units WHERE script_id = ?
         ORDER BY CASE WHEN scene_id = '' THEN 1 ELSE 0 END, scene_id ASC, seq ASC, created_at ASC`
      )
      .all(programId)
      .map((row) => rowToDraftUnit(row as Record<string, unknown>))
  }

  /** 场景内下一个创作序号（write_bits/手动新增都用它；老数据 seq=0 时从 max(created 序) 续） */
  draftUnitNextSeq(programId: string, sceneId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM draft_units WHERE script_id = ? AND scene_id = ?')
      .get(programId, sceneId) as Record<string, unknown>
    return (num(row.m) ?? 0) + 1
  }

  draftUnitSave(u: DraftUnit): void {
    this.db
      .prepare(
        `INSERT INTO draft_units (id, script_id, scene_id, variant_idx, seq, text, bit_type, delivery, speaker, rate, pitch, pause_after_ms, voice_id, audio_path,
                                 status, error, source, sources, rendered, created_at, text_zh)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scene_id = excluded.scene_id, variant_idx = excluded.variant_idx, seq = excluded.seq,
           text = excluded.text, bit_type = excluded.bit_type, delivery = excluded.delivery, speaker = excluded.speaker,
           rate = excluded.rate, pitch = excluded.pitch, pause_after_ms = excluded.pause_after_ms,
           voice_id = excluded.voice_id, audio_path = excluded.audio_path,
           status = excluded.status, error = excluded.error, source = excluded.source,
           sources = excluded.sources, rendered = excluded.rendered, text_zh = excluded.text_zh`
      )
      .run(
        u.id,
        u.programId,
        u.sceneId,
        u.variantIdx,
        u.seq,
        u.text,
        u.bitType,
        u.delivery,
        u.speaker ?? '',
        u.rate ?? null,
        u.pitch ?? null,
        u.pauseAfterMs ?? null,
        u.voiceId,
        u.audioPath ?? null,
        u.status,
        u.error ?? null,
        u.source,
        JSON.stringify(u.sources),
        u.rendered ? JSON.stringify(u.rendered) : null,
        u.createdAt,
        u.textZh ?? ''
      )
  }

  /** 只改主播标识（不碰音频/文稿）：多人直播时改角色名不影响已合成产物 */
  draftUnitSetSpeaker(id: string, speaker: string): void {
    this.db.prepare('UPDATE draft_units SET speaker = ? WHERE id = ?').run(speaker, id)
  }

  /** 只更新预制音频资产（rendered 列）：生产入口/导入外部音频/stale 检测用，不动运行态字段 */
  draftUnitSetRendered(id: string, rendered: RenderedAudioRef | null): void {
    this.db
      .prepare('UPDATE draft_units SET rendered = ? WHERE id = ?')
      .run(rendered ? JSON.stringify(rendered) : null, id)
  }

  draftUnitDelete(id: string): void {
    this.db.prepare('DELETE FROM draft_units WHERE id = ?').run(id)
  }

  /** 按 id 取单条底稿 */
  draftUnitGet(id: string): DraftUnit | null {
    const row = this.db.prepare('SELECT * FROM draft_units WHERE id = ?').get(id)
    return row ? rowToDraftUnit(row as Record<string, unknown>) : null
  }

  /** 批量删除（重生成某场景/清空节目话术库用） */
  draftUnitDeleteWhere(programId: string, sceneId?: string): void {
    if (sceneId === undefined) {
      this.db.prepare('DELETE FROM draft_units WHERE script_id = ?').run(programId)
    } else {
      this.db.prepare('DELETE FROM draft_units WHERE script_id = ? AND scene_id = ?').run(programId, sceneId)
    }
  }

  /** 预合成状态推进（批量合成时逐条更新） */
  draftUnitSetAudio(
    id: string,
    status: DraftUnitStatus,
    audioPath: string | null,
    error?: string,
    synthVoice?: string
  ): void {
    if (synthVoice === undefined) {
      this.db
        .prepare('UPDATE draft_units SET status = ?, audio_path = ?, error = ? WHERE id = ?')
        .run(status, audioPath, error ?? null, id)
    } else {
      this.db
        .prepare('UPDATE draft_units SET status = ?, audio_path = ?, error = ?, synth_voice = ? WHERE id = ?')
        .run(status, audioPath, error ?? null, synthVoice, id)
    }
  }

  /** 所有底稿引用的音频文件（清空/删除底稿时判断文件是否成孤儿） */
  draftUnitAllAudioPaths(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT audio_path AS path FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''")
      .all() as Record<string, unknown>[]).map((row) => str(row.path))
  }

  // ---------- 项目文件（audio/、assets/ 与 tts_cache） ----------

  /** 项目里还被「内容」引用的文件（归一化路径）：稿子、池、附件、场景预制产物。
   *  TTS 缓存不算引用——它只是备忘，文件没了下次重新合成即可。 */
  projectReferencedFiles(): Set<string> {
    return new Set(this.contentFilePaths().map((path) => resolve(path).toLowerCase()))
  }

  /** 项目引用的全部文件路径（含 TTS 缓存；重绑用） */
  projectFilePaths(): string[] {
    return this.contentFilePaths(true)
  }

  private contentFilePaths(includeCache = false): string[] {
    const out: string[] = []
    const add = (value: unknown): void => {
      const path = str(value)
      if (path) out.push(path)
    }
    const union = includeCache
      ? `SELECT audio_path AS p FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION SELECT audio_path AS p FROM pool_items WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION SELECT file_path AS p FROM material_files WHERE file_path IS NOT NULL AND file_path != ''
         UNION SELECT path AS p FROM tts_cache`
      : `SELECT audio_path AS p FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION SELECT audio_path AS p FROM pool_items WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION SELECT file_path AS p FROM material_files WHERE file_path IS NOT NULL AND file_path != ''`
    for (const row of this.db.prepare(union).all() as Record<string, unknown>[]) add(row.p)
    for (const row of this.db
      .prepare('SELECT rendered FROM draft_units WHERE rendered IS NOT NULL')
      .all() as Record<string, unknown>[]) add(parseJson<RenderedAudioRef | null>(row.rendered, null)?.audioPath)
    for (const row of this.db.prepare('SELECT scenes FROM project').all() as Record<string, unknown>[]) {
      for (const scene of parseJson<ScriptScene[]>(row.scenes, [])) add(scene.rendered?.audioPath)
    }
    return out
  }

  /** 目录搬家后把失效的绝对路径改到当前目录（列、rendered JSON、场景 JSON 一起改） */
  projectRewriteFilePath(oldPath: string, newPath: string): void {
    for (const sql of [
      'UPDATE draft_units SET audio_path = ? WHERE audio_path = ?',
      'UPDATE pool_items SET audio_path = ? WHERE audio_path = ?',
      'UPDATE material_files SET file_path = ? WHERE file_path = ?',
      'UPDATE tts_cache SET path = ? WHERE path = ?'
    ]) {
      this.db.prepare(sql).run(newPath, oldPath)
    }
    for (const row of this.db
      .prepare('SELECT id, rendered FROM draft_units WHERE rendered IS NOT NULL')
      .all() as Record<string, unknown>[]) {
      const rendered = parseJson<RenderedAudioRef | null>(row.rendered, null)
      if (rendered?.audioPath !== oldPath) continue
      this.db.prepare('UPDATE draft_units SET rendered = ? WHERE id = ?').run(JSON.stringify({ ...rendered, audioPath: newPath }), str(row.id))
    }
    for (const row of this.db.prepare('SELECT id, scenes FROM project').all() as Record<string, unknown>[]) {
      const scenes = parseJson<ScriptScene[]>(row.scenes, [])
      let changed = false
      for (const scene of scenes) {
        if (scene.rendered?.audioPath === oldPath) {
          scene.rendered.audioPath = newPath
          changed = true
        }
      }
      if (changed) this.db.prepare('UPDATE project SET scenes = ? WHERE id = ?').run(JSON.stringify(scenes), str(row.id))
    }
  }

  projectTtsCacheGet(paramKey: string): string | null {
    const row = this.db.prepare('SELECT path FROM tts_cache WHERE param_key = ?').get(paramKey) as
      | Record<string, unknown>
      | undefined
    return row ? str(row.path) : null
  }

  projectTtsCachePut(paramKey: string, path: string): void {
    this.db
      .prepare(
        `INSERT INTO tts_cache (param_key, path, created_at) VALUES (?, ?, ?)
         ON CONFLICT(param_key) DO UPDATE SET path = excluded.path`
      )
      .run(paramKey, path, Date.now())
  }

  projectTtsCacheDelete(paramKey: string): void {
    this.db.prepare('DELETE FROM tts_cache WHERE param_key = ?').run(paramKey)
  }

  /** 文件被回收后，指向它的缓存别名一起清掉 */
  projectTtsCacheDeleteByPath(path: string): void {
    this.db.prepare('DELETE FROM tts_cache WHERE path = ?').run(path)
  }

  /** 清掉指向已不存在文件的缓存别名 */
  projectTtsCachePruneMissing(): void {
    const rows = this.db.prepare('SELECT param_key, path FROM tts_cache').all() as Record<string, unknown>[]
    for (const row of rows) {
      const path = str(row.path)
      if (path && !existsSync(path)) this.projectTtsCacheDelete(str(row.param_key))
    }
  }

  close(): void {
    this.projectDb.close()
    this.appDb.close()
  }
}

function rowToDraftUnit(r: Record<string, unknown>): DraftUnit {
  return {
    id: str(r.id),
    programId: str(r.script_id),
    sceneId: str(r.scene_id),
    variantIdx: num(r.variant_idx) ?? 0,
    seq: num(r.seq) ?? 0,
    text: str(r.text),
    bitType: str(r.bit_type),
    delivery: str(r.delivery),
    speaker: str(r.speaker) || undefined,
    rate: num(r.rate),
    pitch: num(r.pitch),
    pauseAfterMs: num(r.pause_after_ms),
    voiceId: str(r.voice_id),
    textZh: str(r.text_zh) || undefined,
    audioPath: str(r.audio_path) || null,
    synthVoice: str(r.synth_voice),
    status: (str(r.status) || 'pending') as DraftUnit['status'],
    error: str(r.error) || undefined,
    source: str(r.source) === 'adopted' ? 'adopted' : 'initial',
    sources: parseJson<DraftUnit['sources']>(r.sources, []),
    rendered: parseJson<DraftUnit['rendered']>(r.rendered, undefined),
    createdAt: num(r.created_at) ?? 0
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
