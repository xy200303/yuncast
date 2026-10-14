import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSecretBox, isV2Sealed, open as openSeal, seal } from './secretBox'
import {
  DEFAULT_CONFIG,
  DEFAULT_PROGRAM_AUDIO_CONFIG,
  DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
  ENTRY_KINDS,
  parseAppConfig,
  type AppConfig,
  type EpisodeSummary,
  type KnowledgeFile,
  type ModelConnection,
  type ModelConnectionInput,
  type ModelConnectionSafe,
  type PartialDeep,
  type Persona,
  type Program,
  type ProgramAudioConfig,
  type ProgramKnowledgeScope,
  type Product,
  type Script,
  type EntryKind,
  type SpeechItem,
  type SpeechLane,
  type SpeechReplyTo,
  type SpeechStatus,
  type Trigger,
  type LiveEvent,
  type TtsConnection,
  type TtsConnectionInput,
  type TtsConnectionModel,
  type TtsConnectionSafe,
  type Utterance,
  type UtteranceStatus,
  type ViewerProfile,
  type VoiceRecord
} from '../../shared/types'
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
 * 持久化层（统一 SQLite，userData/agentanchor.db，Node 内置、WAL、免原生重编译）：
 * - 应用配置：app_config 表单行 JSON（tts.accessToken / tts.apiKey / llm.apiKey 等加密内联）；
 *   旧版 config.json 启动时一次性迁入并改名留底
 * - 业务数据：各业务表（话术池/节目/底稿/触发器…）
 * - 供应商接入（model_connections / tts_connections）：密钥字段在 params 里内联加密
 * - 凭据加密用应用自管的 secretBox（AES-256-GCM + userData/secret.key，见 secretBox.ts），
 *   不用系统钥匙串——避免系统密钥轮换后凭据全哑，且行为跨平台一致；
 *   旧 safeStorage 密文启动时尝试迁移（解不开则按凭据缺失提示重填）
 */

type StoredValue = string | { __enc: string }

/**
 * 以 dot path 标记的敏感字段，写入前加密、读出后解密。
 * tts.accessToken / tts.apiKey 只剩迁移用（旧配置的凭据要能解密读出来才能搬进 tts_connections）。
 */
const SECRET_KEYS = [
  'tts.accessToken',
  'tts.apiKey',
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
  delivery: unknown
  rate: unknown
  pitch: unknown
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
    delivery: str(row.delivery) || undefined,
    rate: num(row.rate),
    pitch: num(row.pitch),
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
  /** 旧版配置文件路径：只用于启动时向数据库迁移，迁完改名留底 */
  private readonly configFile: string
  private config: AppConfig
  private configListeners = new Set<(config: AppConfig) => void>()
  private db: DatabaseSync

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    initSecretBox(dir)
    this.configFile = join(dir, 'config.json')

    this.db = new DatabaseSync(join(dir, 'agentanchor.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // 应用配置也存数据库（单行 JSON，敏感字段照样加密内联）：一份存储、一次初始化、不用等两个文件
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS app_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)'
    )
    this.config = this.loadConfig()
    // 节目化迁移（破坏性，docs/10 §9.4）：live_plans/modes/plan_sessions/plan_id 列 → programs/program_id。
    // 必须跑在相关业务表 CREATE 之前：迁移负责把旧结构抬到最终结构，CREATE 只兜全新库
    this.migratePrograms()
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
    // 知识库：条目（商品/书籍/话题/自定义；商品是价格护栏数据源）+ 资料文件
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
    // 条目通用化：类型（默认商品）+ 外部来源 id（抖音商城同步去重）+ 类型扩展字段
    this.ensureColumn('products', 'kind', "TEXT NOT NULL DEFAULT 'product'")
    this.ensureColumn('products', 'external_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('products', 'meta', "TEXT NOT NULL DEFAULT '{}'")
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
    // 记忆：老粉画像 + 节目摘要
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
    // 提示词模板（主播手册：缺 key 播种默认，用户改过的不动）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 剧本 + 节目（M6；docs/10 §9 节目化：一场直播/一期播客/一本有声书都是一个节目）
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
      CREATE TABLE IF NOT EXISTS programs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        theme TEXT NOT NULL DEFAULT '',
        content_type TEXT NOT NULL DEFAULT 'solo',
        broadcast_mode TEXT NOT NULL DEFAULT 'rolling',
        finish_mode TEXT NOT NULL DEFAULT 'loop',
        allow_live_events INTEGER NOT NULL DEFAULT 1,
        enabled_trigger_ids TEXT NOT NULL DEFAULT '[]',
        audio_config TEXT NOT NULL DEFAULT '{"mode":"follow-presenter"}',
        script_id TEXT,
        knowledge_scope TEXT NOT NULL DEFAULT '{}',
        current_scene_idx INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.ensureColumn('agents', 'roles', "TEXT NOT NULL DEFAULT '[]'")
    // 多张人设卡（主播团）：active=1 的那张是当前主播
    this.ensureColumn('agents', 'active', 'INTEGER NOT NULL DEFAULT 0')
    // 节目话术库（docs/07 §3 utterances：底稿库，与运行态 speech_items 分工）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS utterances (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
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
    this.db.exec('CREATE INDEX IF NOT EXISTS utterances_program ON utterances(program_id, scene_id, status)')
    // 预合成时实际用的音色：装载进池时比对，音色改过就不复用旧音频
    this.ensureColumn('utterances', 'synth_voice', "TEXT NOT NULL DEFAULT ''")
    // 话术取自哪条库底稿（复盘溯源，docs/07 §3）
    this.ensureColumn('speech_items', 'origin_utterance_id', 'TEXT')
    // 实时合成条目标记（M9）
    this.ensureColumn('speech_items', 'stream', 'INTEGER NOT NULL DEFAULT 0')
    // 语音稿（显示稿与念法分离）
    this.ensureColumn('speech_items', 'speech_text', 'TEXT')
    // 现场表演指示（情绪/语气）：模型支持语气指令时随这次合成发出去
    this.ensureColumn('speech_items', 'delivery', 'TEXT')
    // 演法硬参数：语速/音调倍率（agent 下沉，空 = 接入默认）
    this.ensureColumn('speech_items', 'rate', 'REAL')
    this.ensureColumn('speech_items', 'pitch', 'REAL')
    // 桥段制：内容形态标签（BIT_TYPES；'' = 旧式单句）+ 表演指示（情绪/语速/停顿）
    this.ensureColumn('utterances', 'bit_type', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('utterances', 'delivery', "TEXT NOT NULL DEFAULT ''")
    // 演法硬参数：语速/音调倍率（agent 下沉，空 = 接入默认）
    this.ensureColumn('utterances', 'rate', 'REAL')
    this.ensureColumn('utterances', 'pitch', 'REAL')
    // 场景内创作顺序号：装池按它排（首轮严格按叙事顺序播放）
    this.ensureColumn('utterances', 'seq', 'INTEGER NOT NULL DEFAULT 0')
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
    // 供应商接入（设置 → 语言模型）：一条 = 一个服务商 + 一份凭据 + 一串可用模型
    // 没有默认模型：用哪个模型由人设卡显式指定
    this.createModelConnectionsTable()
    this.ensureModelConnectionWindows()
    // 人设卡的「大脑」：引用一条接入与其中一个模型，两列都要有值（开播时必须明确）
    this.ensureColumn('agents', 'model_connection_id', 'TEXT')
    this.ensureColumn('agents', 'model', "TEXT NOT NULL DEFAULT ''")
    // 语音合成的服务商接入（设置 → 语音合成）：一个条目 = 一个服务商账号 + 一份凭据 + 它的模型与参数
    // 同一服务商允许多条（不同账号/参数）；实时开关按接入走。没有默认模型 / 默认音色 / 默认接入：
    // 用哪条接入的哪个模型由音色决定（克隆音色带接入与模型，系统音色在目录里反查，手动音色写复合串）
    this.db.exec(`
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
    this.ensureColumn('tts_connections', 'realtime', 'INTEGER NOT NULL DEFAULT 0')
    // 克隆音色绑定目标模型与克隆时的接入（合成路由按它反推，定死不可跨模型）
    this.ensureColumn('voices', 'model', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('voices', 'connection_id', "TEXT NOT NULL DEFAULT ''")
    // 节目即会话：每个节目一份持久对话（pi 会话 entries + 可见时间线），切节目/重启后恢复
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS program_sessions (
        program_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL DEFAULT 'prep',
        entries TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS director_timeline (
        program_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        turn_id TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (program_id, entry_id)
      )
    `)
    // 凭据加密自管化：旧 safeStorage 密文能解就转 v2（见 secretBox.ts）
    this.migrateLegacySecrets()
  }

  // ---------- 节目会话持久化（节目即会话） ----------

  /** 保存某节目的 pi 会话 entries（stop/切节目/每轮结束时覆盖写） */
  saveProgramSession(programId: string, purpose: string, entriesJson: string): void {
    this.db
      .prepare(
        `INSERT INTO program_sessions (program_id, purpose, entries, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET purpose = excluded.purpose, entries = excluded.entries, updated_at = excluded.updated_at`
      )
      .run(programId, purpose, entriesJson, Date.now())
  }

  loadProgramSession(programId: string): { purpose: string; entries: string } | null {
    const row = this.db.prepare('SELECT purpose, entries FROM program_sessions WHERE program_id = ?').get(programId) as
      | { purpose: string; entries: string }
      | undefined
    return row ?? null
  }

  deleteProgramSession(programId: string): void {
    this.db.prepare('DELETE FROM program_sessions WHERE program_id = ?').run(programId)
    this.db.prepare('DELETE FROM director_timeline WHERE program_id = ?').run(programId)
  }

  /** 时间线条目落库（按 entry_id upsert：流式快照/工具状态更新都收敛到同一行），每节目修剪到最近 500 条 */
  timelineAppend(programId: string, entryId: string, turnId: string, ts: number, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO director_timeline (program_id, entry_id, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(program_id, entry_id) DO UPDATE SET payload = excluded.payload`
      )
      .run(programId, entryId, turnId, ts, payload)
    this.db
      .prepare(
        `DELETE FROM director_timeline WHERE program_id = ? AND entry_id NOT IN (
           SELECT entry_id FROM director_timeline WHERE program_id = ? ORDER BY ts DESC LIMIT 500
         )`
      )
      .run(programId, programId)
  }

  /** 拉某节目的可见时间线（最近 limit 条，按时间正序） */
  timelineList(programId: string, limit = 200): { turnId: string; payload: string }[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id, payload FROM (
           SELECT turn_id, payload, ts FROM director_timeline WHERE program_id = ? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`
      )
      .all(programId, limit) as { turn_id: string; payload: string }[]
    return rows.map((r) => ({ turnId: r.turn_id, payload: r.payload }))
  }

  timelineClear(programId: string): void {
    this.db.prepare('DELETE FROM director_timeline WHERE program_id = ?').run(programId)
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
          model: String(r.model ?? ''),
          connectionId: String(r.connection_id ?? ''),
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
        `INSERT INTO voices (id, name, provider, voice_type, model, connection_id, sample_path, status, error, authorized, authorized_at, created_at, updated_at)
         VALUES (@id, @name, @provider, @voiceType, @model, @connectionId, @samplePath, @status, @error, @authorized, @authorizedAt, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, provider=@provider, voice_type=@voiceType, model=@model, connection_id=@connectionId, sample_path=@samplePath,
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

  // ---------- 供应商接入（设置 → 语言模型） ----------

  /** 读出全部接入（密钥字段已解密），按创建顺序 */
  connectionList(): ModelConnection[] {
    return this.db
      .prepare('SELECT * FROM model_connections ORDER BY created_at ASC')
      .all()
      .map((row) => this.toModelConnection(row as Record<string, unknown>))
  }

  connectionGet(id: string): ModelConnection | null {
    const row = this.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id)
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

    this.db
      .prepare(
        `INSERT INTO model_connections (id, name, provider_id, params, models, model_windows, model_thinking, model_params, created_at, updated_at)
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
    this.db.prepare('DELETE FROM model_connections WHERE id = ?').run(id)
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
    return this.db
      .prepare('SELECT * FROM tts_connections ORDER BY created_at ASC')
      .all()
      .map((row) => this.toTtsConnection(row as Record<string, unknown>))
  }

  ttsConnectionGet(id: string): TtsConnection | null {
    const row = this.db.prepare('SELECT * FROM tts_connections WHERE id = ?').get(id)
    return row ? this.toTtsConnection(row as Record<string, unknown>) : null
  }

  /** 该服务商最早建的那条接入。只给「没有音色可依据」的内部场景用（实时通道凭据、老库回填），不是默认接入 */
  ttsConnectionFirstOf(providerId: string): TtsConnection | null {
    const row = this.db
      .prepare('SELECT * FROM tts_connections WHERE provider_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(providerId)
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
    this.db
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
    this.db.prepare('DELETE FROM tts_connections WHERE id = ?').run(id)
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

  /**
   * 解一个密文值：v2 走 secretBox；旧 safeStorage 密文尝试解开（解得开则由启动迁移统一转 v2）。
   * 解不开返回 null，调用方置空——界面按"凭据缺失"提示重填。
   */
  private unsealValue(sealed: string): string | null {
    if (isV2Sealed(sealed)) {
      try {
        return openSeal(sealed)
      } catch {
        return null
      }
    }
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
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

  /**
   * 启动迁移：库里的旧 safeStorage 密文统一转成 v2（secretBox）。
   * 解不开的（系统密钥已轮换）保持原样——读出时会落为空，界面照常提示重填，重填后即是 v2。
   */
  private migrateLegacySecrets(): void {
    for (const table of ['model_connections', 'tts_connections']) {
      let rows: { id: unknown; provider_id: unknown; params: unknown }[]
      try {
        rows = this.db.prepare(`SELECT id, provider_id, params FROM ${table}`).all() as typeof rows
      } catch {
        continue // 表还没建（全新库）就跳过
      }
      const update = this.db.prepare(`UPDATE ${table} SET params = ? WHERE id = ?`)
      let migrated = 0
      let unmigratable = 0
      for (const row of rows) {
        const secrets = table === 'tts_connections' ? ttsSecretFieldKeys(str(row.provider_id)) : secretFieldKeys(str(row.provider_id))
        const parsed = parseJson<Record<string, unknown>>(row.params, {})
        let dirty = false
        for (const [key, value] of Object.entries(parsed)) {
          if (!secrets.includes(key)) continue
          if (!value || typeof value !== 'object' || !('__enc' in value)) continue
          const sealed = String((value as { __enc: unknown }).__enc)
          if (isV2Sealed(sealed)) continue
          try {
            const plain = safeStorage.decryptString(Buffer.from(sealed, 'base64'))
            parsed[key] = { __enc: seal(plain) }
            dirty = true
          } catch {
            unmigratable++
          }
        }
        if (dirty) {
          update.run(JSON.stringify(parsed), str(row.id))
          migrated++
        }
      }
      if (migrated > 0 || unmigratable > 0) {
        console.log(`[凭据] ${table} 旧密文迁移：转 v2 ${migrated} 行；解不开 ${unmigratable} 个字段（读出时按缺失提示重填）`)
      }
    }
  }

  /** 数据库结构版本（PRAGMA user_version）：1 = 节目化改造（programs 落成，modes/live_plans/plan_id 全删） */
  private static readonly DB_VERSION = 1

  /**
   * 节目化迁移（docs/10 §9.4，破坏性，一次性）：事务内直接得到最终表结构，不留兼容分支。
   * live_plans → 建新 programs（复制仍有价值的字段，节目新字段给默认值，mode_id/voice_id/
   * planned_minutes/gen_config/style_hint 随之入土）；plan_sessions → program_sessions；
   * utterances/director_timeline 的 plan_id 列改名 program_id；modes 表删除。
   * 迁完用 PRAGMA table_info 校验旧表旧列不存在，不一致直接抛错（启动失败好过脏结构）。
   */
  private migratePrograms(): void {
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version ?? 0
    )
    if (version >= StorageService.DB_VERSION) return
    const hasTable = (name: string): boolean =>
      this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
    const columnsOf = (name: string): Set<string> =>
      new Set(
        this.db.prepare(`PRAGMA table_info(${name})`).all().map((row) => str((row as Record<string, unknown>).name))
      )
    this.db.exec('BEGIN')
    try {
      if (hasTable('live_plans')) {
        // 老库的 knowledge_scope 列是后期补的，补不齐就没法复制（其余列自首版就有）
        this.ensureColumn('live_plans', 'knowledge_scope', "TEXT NOT NULL DEFAULT '{}'")
        this.db.exec(`
          CREATE TABLE programs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            theme TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT 'solo',
            broadcast_mode TEXT NOT NULL DEFAULT 'rolling',
            finish_mode TEXT NOT NULL DEFAULT 'loop',
            allow_live_events INTEGER NOT NULL DEFAULT 1,
            enabled_trigger_ids TEXT NOT NULL DEFAULT '[]',
            audio_config TEXT NOT NULL DEFAULT '{"mode":"follow-presenter"}',
            script_id TEXT,
            knowledge_scope TEXT NOT NULL DEFAULT '{}',
            current_scene_idx INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        this.db.exec(`
          INSERT INTO programs (id, name, theme, script_id, current_scene_idx, knowledge_scope, created_at, updated_at)
          SELECT id, name, theme, script_id, current_scene_idx, knowledge_scope, created_at, updated_at FROM live_plans
        `)
        this.db.exec('DROP TABLE live_plans')
      }
      if (hasTable('plan_sessions')) {
        this.db.exec(`
          CREATE TABLE program_sessions (
            program_id TEXT PRIMARY KEY,
            purpose TEXT NOT NULL DEFAULT 'prep',
            entries TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL
          )
        `)
        this.db.exec(
          'INSERT INTO program_sessions (program_id, purpose, entries, updated_at) SELECT plan_id, purpose, entries, updated_at FROM plan_sessions'
        )
        this.db.exec('DROP TABLE plan_sessions')
      }
      // 外键列 plan_id → program_id（SQLite ≥ 3.25 的 RENAME COLUMN，索引定义随列自动改）
      if (hasTable('utterances') && columnsOf('utterances').has('plan_id')) {
        this.db.exec('ALTER TABLE utterances RENAME COLUMN plan_id TO program_id')
      }
      if (hasTable('director_timeline') && columnsOf('director_timeline').has('plan_id')) {
        this.db.exec('ALTER TABLE director_timeline RENAME COLUMN plan_id TO program_id')
      }
      // 直播模式预设包整体退役
      if (hasTable('modes')) this.db.exec('DROP TABLE modes')
      // 校验：旧表旧列必须不存在
      for (const table of ['live_plans', 'plan_sessions', 'modes']) {
        if (hasTable(table)) throw new Error(`旧表 ${table} 迁移后仍存在`)
      }
      if (hasTable('programs')) {
        const legacy = ['mode_id', 'voice_id', 'planned_minutes', 'gen_config', 'style_hint'].filter((column) =>
          columnsOf('programs').has(column)
        )
        if (legacy.length > 0) throw new Error(`programs 残留旧列：${legacy.join(', ')}`)
      }
      for (const table of ['utterances', 'director_timeline']) {
        if (hasTable(table) && columnsOf(table).has('plan_id')) throw new Error(`${table}.plan_id 迁移后仍存在`)
      }
      this.db.exec(`PRAGMA user_version = ${StorageService.DB_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private createModelConnectionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        models TEXT NOT NULL DEFAULT '[]',
        model_windows TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  /** 模型级上下文窗口列（model_windows）与思考强度列（model_thinking）：老库补列，幂等 */
  private ensureModelConnectionWindows(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(model_connections)')
      .all()
      .map((row) => str((row as Record<string, unknown>).name))
    if (!columns.includes('model_windows')) {
      this.db.exec("ALTER TABLE model_connections ADD COLUMN model_windows TEXT NOT NULL DEFAULT '{}'")
    }
    if (!columns.includes('model_thinking')) {
      this.db.exec("ALTER TABLE model_connections ADD COLUMN model_thinking TEXT NOT NULL DEFAULT '{}'")
    }
    // 模型级高级参数列（model_params，JSON：模型 id → { vision/temperature/maxTokens }）
    if (!columns.includes('model_params')) {
      this.db.exec("ALTER TABLE model_connections ADD COLUMN model_params TEXT NOT NULL DEFAULT '{}'")
    }
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
      const row = this.db.prepare('SELECT data FROM app_config WHERE id = 1').get() as
        | { data?: unknown }
        | undefined
      if (row && typeof row.data === 'string') {
        return this.parseStoredConfig(JSON.parse(row.data) as Record<string, unknown>)
      }
      // 旧版 config.json 一次性迁入数据库（统一存储前版本）；迁完改名留底，不再使用
      if (existsSync(this.configFile)) {
        const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as Record<string, unknown>
        const config = this.parseStoredConfig(raw)
        this.config = config
        this.saveConfig()
        renameSync(this.configFile, `${this.configFile}.migrated`)
        console.log('[AgentAnchor] config.json 已并入数据库，原文件改名 config.json.migrated 留底')
        return config
      }
      return structuredClone(DEFAULT_CONFIG)
    } catch (error) {
      console.error('[AgentAnchor] 读取配置失败，用默认值:', error)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  /** 解密敏感字段 + 校验成 AppConfig（数据库行与旧 config.json 共用一套读写） */
  private parseStoredConfig(raw: Record<string, unknown>): AppConfig {
    // 解密敏感字段；解开的旧 safeStorage 密文标记一下，读完落盘时转 v2
    let migrated = false
    for (const key of SECRET_KEYS) {
      const value = getPath(raw, key) as StoredValue | undefined
      if (value && typeof value === 'object' && '__enc' in value) {
        const plain = this.unsealValue(value.__enc)
        if (!isV2Sealed(value.__enc) && plain) migrated = true
        setPath(raw, key, plain ?? '')
      }
    }
    const config = parseAppConfig(raw)
    if (migrated) {
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
    return this.config
  }

  /** 配置变了就回调（主进程里用来同步窗口 chrome） */
  onConfigChange(listener: (config: AppConfig) => void): () => void {
    this.configListeners.add(listener)
    return () => this.configListeners.delete(listener)
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
      this.db
        .prepare('INSERT INTO app_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
        .run(JSON.stringify(clone))
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
          dedupe_key, expires_at, reply_to, status, audio_path, speech_text, delivery, rate, pitch, stream,
          origin_utterance_id, error, sort_order, created_at, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        item.delivery ?? null,
        item.rate ?? null,
        item.pitch ?? null,
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

  /** 按 dedupeKey 找未播条目（去重合并用）。playing 也算「在池里」：正在播的不能重装，否则一段话在队列里出现两次 */
  speechFindActiveByDedupeKey(dedupeKey: string): SpeechItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM speech_items WHERE dedupe_key = ? AND status IN ('pending', 'synthesizing', 'ready', 'playing') ORDER BY created_at DESC LIMIT 1`
      )
      .get(dedupeKey)
    return row ? rowToItem(row as unknown as SpeechRow) : null
  }

  /**
   * 每条底稿（origin_utterance_id）最近一次进池的时间（轮播公平排序用：
   * 没播过的最优先，播过的按最久没播排，整个场景的话术轮得上，不饿死队尾）
   */
  speechLastLoadedByOrigin(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT origin_utterance_id AS origin, MAX(created_at) AS last_at
         FROM speech_items WHERE origin_utterance_id IS NOT NULL AND origin_utterance_id != ''
         GROUP BY origin_utterance_id`
      )
      .all() as { origin: unknown; last_at: unknown }[]
    const map = new Map<string, number>()
    for (const row of rows) map.set(str(row.origin), num(row.last_at) ?? 0)
    return map
  }

  /** 清理过期终态：done 只留最近 200 条，其余终态 1 小时后删除 */
  /** 仍被引用的音频路径（缓存清理时跳过）：话术池条目 + 底稿库条目（含段落切片的 wav） */
  speechReferencedAudioPaths(): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT audio_path AS path FROM speech_items WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION
         SELECT DISTINCT audio_path AS path FROM utterances WHERE audio_path IS NOT NULL AND audio_path != ''`
      )
      .all()
      .map((row) => str((row as Record<string, unknown>).path))
      .filter(Boolean)
  }

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
      modelConnectionId: str(r.model_connection_id) || null,
      model: str(r.model),
      roles,
      updatedAt: num(r.updated_at) ?? 0
    }
  }

  personaSave(persona: Persona): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, personality, catchphrases, background, taboos, voice_id, model_connection_id, model, roles, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, personality = excluded.personality,
           catchphrases = excluded.catchphrases, background = excluded.background,
           taboos = excluded.taboos, voice_id = excluded.voice_id,
           model_connection_id = excluded.model_connection_id,
           model = excluded.model,
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
        persona.modelConnectionId ?? null,
        persona.model,
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
        const kind = str(r.kind)
        return {
          id: str(r.id),
          name: str(r.name),
          kind: (ENTRY_KINDS as readonly string[]).includes(kind) ? (kind as EntryKind) : 'product',
          price: num(r.price) ?? 0,
          sellingPoints: str(r.selling_points),
          faq: str(r.faq),
          externalId: str(r.external_id),
          meta: parseJson<Record<string, string>>(r.meta, {}),
          createdAt: num(r.created_at) ?? 0
        }
      })
  }

  productSave(product: Product): void {
    this.db
      .prepare(
        `INSERT INTO products (id, name, kind, price, selling_points, faq, external_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, price = excluded.price,
           selling_points = excluded.selling_points, faq = excluded.faq,
           external_id = excluded.external_id, meta = excluded.meta`
      )
      .run(
        product.id,
        product.name,
        product.kind,
        product.price,
        product.sellingPoints,
        product.faq,
        product.externalId,
        JSON.stringify(product.meta),
        product.createdAt
      )
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

  // ---------- 提示词模板（主播手册） ----------

  promptTemplateGet(key: string): { content: string; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT content, updated_at FROM prompt_templates WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return { content: String(row.content), updatedAt: Number(row.updated_at) }
  }

  promptTemplateUpsert(key: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO prompt_templates (key, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(key, content, Date.now())
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

  // ---------- 节目 ----------

  programList(): Program[] {
    return this.db
      .prepare('SELECT * FROM programs ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>
        const contentType = str(r.content_type)
        const broadcastMode = str(r.broadcast_mode)
        const finishMode = str(r.finish_mode)
        const triggerIds = parseJson<unknown>(r.enabled_trigger_ids, [])
        return {
          id: str(r.id),
          name: str(r.name),
          theme: str(r.theme),
          contentType:
            contentType === 'conversation' || contentType === 'reading' || contentType === 'roleplay'
              ? contentType
              : 'solo',
          broadcastMode: broadcastMode === 'improvised' || broadcastMode === 'prepared' ? broadcastMode : 'rolling',
          finishMode: finishMode === 'stop' ? 'stop' : 'loop',
          allowLiveEvents: num(r.allow_live_events) !== 0,
          enabledTriggerIds: Array.isArray(triggerIds) ? triggerIds.map(String).filter(Boolean) : [],
          audioConfig: { ...DEFAULT_PROGRAM_AUDIO_CONFIG, ...parseJson<Partial<ProgramAudioConfig>>(r.audio_config, {}) },
          scriptId: str(r.script_id) || null,
          knowledgeScope: {
            ...DEFAULT_PROGRAM_KNOWLEDGE_SCOPE,
            ...parseJson<Partial<ProgramKnowledgeScope>>(r.knowledge_scope, {})
          },
          currentSceneIdx: num(r.current_scene_idx) ?? 0,
          createdAt: num(r.created_at) ?? 0,
          updatedAt: num(r.updated_at) ?? 0
        }
      })
  }

  programSave(program: Program): void {
    this.db
      .prepare(
        `INSERT INTO programs (id, name, theme, content_type, broadcast_mode, finish_mode, allow_live_events,
                               enabled_trigger_ids, audio_config, script_id, knowledge_scope, current_scene_idx,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, theme = excluded.theme,
           content_type = excluded.content_type, broadcast_mode = excluded.broadcast_mode,
           finish_mode = excluded.finish_mode, allow_live_events = excluded.allow_live_events,
           enabled_trigger_ids = excluded.enabled_trigger_ids, audio_config = excluded.audio_config,
           script_id = excluded.script_id, knowledge_scope = excluded.knowledge_scope,
           updated_at = excluded.updated_at`
      )
      .run(
        program.id,
        program.name,
        program.theme,
        program.contentType,
        program.broadcastMode,
        program.finishMode,
        program.allowLiveEvents ? 1 : 0,
        JSON.stringify(program.enabledTriggerIds),
        JSON.stringify(program.audioConfig),
        program.scriptId ?? null,
        JSON.stringify(program.knowledgeScope),
        program.currentSceneIdx,
        program.createdAt,
        program.updatedAt
      )
  }

  programDelete(id: string): void {
    this.db.prepare('DELETE FROM programs WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM utterances WHERE program_id = ?').run(id)
  }

  /** 场景推进进度落库（断播能续） */
  programSetSceneIdx(id: string, idx: number): void {
    this.db.prepare('UPDATE programs SET current_scene_idx = ? WHERE id = ?').run(idx, id)
  }

  // ---------- 话术库（utterances） ----------

  utteranceList(programId: string): Utterance[] {
    // 列表顺序 = 叙事顺序：场景段在前（按场景内创作序号 seq），全场通用沉底
    return this.db
      .prepare(
        `SELECT * FROM utterances WHERE program_id = ?
         ORDER BY CASE WHEN scene_id = '' THEN 1 ELSE 0 END, scene_id ASC, seq ASC, created_at ASC`
      )
      .all(programId)
      .map((row) => rowToUtterance(row as Record<string, unknown>))
  }

  /** 场景内下一个创作序号（write_bits/手动新增都用它；老数据 seq=0 时从 max(created 序) 续） */
  utteranceNextSeq(programId: string, sceneId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM utterances WHERE program_id = ? AND scene_id = ?')
      .get(programId, sceneId) as Record<string, unknown>
    return (num(row.m) ?? 0) + 1
  }

  utteranceSave(u: Utterance): void {
    this.db
      .prepare(
        `INSERT INTO utterances (id, program_id, scene_id, variant_idx, seq, text, bit_type, delivery, rate, pitch, voice_id, audio_path,
                                 status, error, source, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scene_id = excluded.scene_id, variant_idx = excluded.variant_idx, seq = excluded.seq,
           text = excluded.text, bit_type = excluded.bit_type, delivery = excluded.delivery,
           rate = excluded.rate, pitch = excluded.pitch,
           voice_id = excluded.voice_id, audio_path = excluded.audio_path,
           status = excluded.status, error = excluded.error, source = excluded.source,
           sources = excluded.sources`
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
        u.rate ?? null,
        u.pitch ?? null,
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

  /** 按 id 取单条底稿（删除前取音频路径用） */
  utteranceGet(id: string): Utterance | null {
    const row = this.db.prepare('SELECT * FROM utterances WHERE id = ?').get(id)
    return row ? rowToUtterance(row as Record<string, unknown>) : null
  }

  /** 批量删除（重生成某场景/清空节目话术库用） */
  utteranceDeleteWhere(programId: string, sceneId?: string): void {
    if (sceneId === undefined) {
      this.db.prepare('DELETE FROM utterances WHERE program_id = ?').run(programId)
    } else {
      this.db.prepare('DELETE FROM utterances WHERE program_id = ? AND scene_id = ?').run(programId, sceneId)
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

  /** 所有底稿引用的音频文件（清空/删除底稿时判断缓存是否成孤儿） */
  utteranceAllAudioPaths(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT audio_path AS path FROM utterances WHERE audio_path IS NOT NULL AND audio_path != ''")
      .all() as Record<string, unknown>[]).map((row) => str(row.path))
  }

  close(): void {
    this.db.close()
  }
}

function rowToUtterance(r: Record<string, unknown>): Utterance {
  return {
    id: str(r.id),
    programId: str(r.program_id),
    sceneId: str(r.scene_id),
    variantIdx: num(r.variant_idx) ?? 0,
    seq: num(r.seq) ?? 0,
    text: str(r.text),
    bitType: str(r.bit_type),
    delivery: str(r.delivery),
    rate: num(r.rate),
    pitch: num(r.pitch),
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
