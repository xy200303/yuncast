import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSecretBox, isV2Sealed, open as openSeal, seal } from './secretBox'
import {
  DEFAULT_CONFIG,
  DEFAULT_PLAN_GEN_CONFIG,
  DEFAULT_PLAN_KNOWLEDGE_SCOPE,
  DEFAULT_PLANNED_MINUTES,
  LLM_PROVIDER_META,
  parseAppConfig,
  ttsProviderHasCredentials,
  type AppConfig,
  type EpisodeSummary,
  type KnowledgeFile,
  type ModelConnection,
  type ModelConnectionInput,
  type ModelConnectionSafe,
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
  connectionFirstModel,
  getLlmProvider,
  isModelConnectionReady,
  isTtsConnectionReady,
  isTtsModelUsable,
  getTtsProvider,
  secretFieldKeys,
  ttsConnectionFields,
  ttsModelSpec,
  ttsSecretFieldKeys
} from './providers/registry'

/**
 * 持久化层（统一 SQLite，userData/agentanchor.db，Node 内置、WAL、免原生重编译）：
 * - 应用配置：app_config 表单行 JSON（tts.accessToken / tts.apiKey / llm.apiKey 等加密内联）；
 *   旧版 config.json 启动时一次性迁入并改名留底
 * - 业务数据：各业务表（话术池/场次/底稿/触发器…）
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
  stream: unknown
  origin_utterance_id: unknown
  para_id: unknown
  para_pos: unknown
  para_len: unknown
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
    paraId: str(row.para_id) || undefined,
    paraPos: num(row.para_pos),
    paraLen: num(row.para_len),
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
    // 提示词模板（主播手册：缺 key 播种默认，用户改过的不动）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
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
    // 预设直播时长（分钟）：开播向导按它推算底稿规模
    this.ensureColumn('live_plans', 'planned_minutes', 'INTEGER NOT NULL DEFAULT 60')
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
    // 连贯段落标记（段落合成切句产物，见 shared/paragraph.ts）
    this.ensureColumn('speech_items', 'para_id', 'TEXT')
    this.ensureColumn('speech_items', 'para_pos', 'INTEGER')
    this.ensureColumn('speech_items', 'para_len', 'INTEGER')
    // 底稿条目的段落归属（预合成整段切句时写入）
    this.ensureColumn('utterances', 'para_id', "TEXT NOT NULL DEFAULT ''")
    // 桥段制：内容形态标签（BIT_TYPES；'' = 旧式单句）+ 表演指示（情绪/语速/停顿）
    this.ensureColumn('utterances', 'bit_type', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('utterances', 'delivery', "TEXT NOT NULL DEFAULT ''")
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
    this.migrateModelConnectionColumns()
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
    this.migrateTtsConnections()
    this.ensureColumn('tts_connections', 'realtime', 'INTEGER NOT NULL DEFAULT 0')
    // 先按旧配置把第一条接入抽出来（老库的实时开关要折进它），再折全局偏好
    this.migrateLegacyTts()
    this.migrateTtsGlobalPrefs()
    // 克隆音色绑定目标模型与克隆时的接入（合成路由按它反推，定死不可跨模型）
    this.ensureColumn('voices', 'model', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('voices', 'connection_id', "TEXT NOT NULL DEFAULT ''")
    this.backfillVoiceBindings()
    this.migrateModelProfiles()
    this.migrateLegacyLlm()
    this.migratePersonaBrains()
    // 场次即会话：每个场次一份持久对话（pi 会话 entries + 可见时间线），切场/重启后恢复
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_sessions (
        plan_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL DEFAULT 'prep',
        entries TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS director_timeline (
        plan_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        turn_id TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (plan_id, entry_id)
      )
    `)
    // 凭据加密自管化：旧 safeStorage 密文能解就转 v2（见 secretBox.ts）
    this.migrateLegacySecrets()
  }

  // ---------- 场次会话持久化（场次即会话） ----------

  /** 保存某场次的 pi 会话 entries（stop/切场/每轮结束时覆盖写） */
  savePlanSession(planId: string, purpose: string, entriesJson: string): void {
    this.db
      .prepare(
        `INSERT INTO plan_sessions (plan_id, purpose, entries, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET purpose = excluded.purpose, entries = excluded.entries, updated_at = excluded.updated_at`
      )
      .run(planId, purpose, entriesJson, Date.now())
  }

  loadPlanSession(planId: string): { purpose: string; entries: string } | null {
    const row = this.db.prepare('SELECT purpose, entries FROM plan_sessions WHERE plan_id = ?').get(planId) as
      | { purpose: string; entries: string }
      | undefined
    return row ?? null
  }

  deletePlanSession(planId: string): void {
    this.db.prepare('DELETE FROM plan_sessions WHERE plan_id = ?').run(planId)
    this.db.prepare('DELETE FROM director_timeline WHERE plan_id = ?').run(planId)
  }

  /** 时间线条目落库（按 entry_id upsert：流式快照/工具状态更新都收敛到同一行），每场次修剪到最近 500 条 */
  timelineAppend(planId: string, entryId: string, turnId: string, ts: number, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO director_timeline (plan_id, entry_id, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, entry_id) DO UPDATE SET payload = excluded.payload`
      )
      .run(planId, entryId, turnId, ts, payload)
    this.db
      .prepare(
        `DELETE FROM director_timeline WHERE plan_id = ? AND entry_id NOT IN (
           SELECT entry_id FROM director_timeline WHERE plan_id = ? ORDER BY ts DESC LIMIT 500
         )`
      )
      .run(planId, planId)
  }

  /** 拉某场次的可见时间线（最近 limit 条，按时间正序） */
  timelineList(planId: string, limit = 200): { turnId: string; payload: string }[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id, payload FROM (
           SELECT turn_id, payload, ts FROM director_timeline WHERE plan_id = ? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`
      )
      .all(planId, limit) as { turn_id: string; payload: string }[]
    return rows.map((r) => ({ turnId: r.turn_id, payload: r.payload }))
  }

  timelineClear(planId: string): void {
    this.db.prepare('DELETE FROM director_timeline WHERE plan_id = ?').run(planId)
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

    this.db
      .prepare(
        `INSERT INTO model_connections (id, name, provider_id, params, models, model_windows, created_at, updated_at)
         VALUES (@id, @name, @providerId, @params, @models, @modelWindows, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, provider_id = @providerId, params = @params,
           models = @models, model_windows = @modelWindows, updated_at = @updatedAt`
      )
      .run({
        id,
        name: input.name.trim() || getLlmProvider(input.providerId)?.label || '未命名接入',
        providerId: input.providerId,
        params: JSON.stringify(this.encryptParams(params, input.providerId)),
        models: JSON.stringify(models),
        modelWindows: JSON.stringify(modelContextWindows),
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
    return {
      id: str(r.id),
      name: str(r.name),
      providerId,
      params: this.decryptParams(r.params, providerId),
      models,
      modelContextWindows,
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

  /**
   * 旧「模型条目库」归并成供应商接入：一条模型 = 一次接入时密钥要反复填，改成一家一份凭据。
   * 按 provider_id + params 分组（同一家的同一个密钥共用一条），保留组里第一条的 id 作为新接入 id
   * ——人设卡里存的旧条目 id 因此直接有效，不必重写。
   */
  private migrateModelProfiles(): void {
    const remap = new Map<string, string>()
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_profiles'")
      .get()
    if (!table) {
      this.migratePersonaConnectionId(remap)
      return
    }
    const rows = this.db
      .prepare('SELECT * FROM model_profiles ORDER BY created_at ASC')
      .all()
      .map((row) => row as Record<string, unknown>)

    const groups = new Map<string, Record<string, unknown>[]>()
    for (const row of rows) {
      const key = `${str(row.provider_id)}\u0000${str(row.params)}`
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }

    for (const group of groups.values()) {
      const head = group[0]
      const providerId = str(head.provider_id)
      const def = getLlmProvider(providerId)
      const models = [
        ...new Set(group.map((row) => str(row.model).trim()).filter((model) => model.length > 0))
      ]
      // 老条目模型名留空 = 用服务商默认模型，换成列表后要显式写出来才不至于变「没模型」
      if (models.length === 0 && def?.defaultModel) models.push(def.defaultModel)
      const id = str(head.id)
      for (const row of group) remap.set(str(row.id), id)
      this.connectionSave({
        id,
        name: def?.label ?? providerId,
        providerId,
        params: this.decryptParams(head.params, providerId),
        models
      })
    }

    this.db.exec('DROP TABLE model_profiles')
    this.migratePersonaConnectionId(remap)
  }

  /** 人设卡的绑定从旧列搬到新列（归并过的按 remap 指向保留的那条接入） */
  private migratePersonaConnectionId(remap: Map<string, string>): void {
    // 旧列只在老库里有；新库不再建它，所以先看列在不在
    const hasOldColumn = this.db
      .prepare('PRAGMA table_info(agents)')
      .all()
      .some((row) => (row as Record<string, unknown>).name === 'model_profile_id')
    if (!hasOldColumn) return
    const rows = this.db
      .prepare('SELECT id, model_profile_id, model_connection_id FROM agents')
      .all()
      .map((row) => row as Record<string, unknown>)
    for (const row of rows) {
      if (str(row.model_connection_id)) continue
      const old = str(row.model_profile_id)
      if (!old) continue
      const mapped = remap.get(old) ?? old
      // 指向的接入已不存在就留空：后面 migratePersonaBrains 会挑一条能用的补上
      this.db
        .prepare('UPDATE agents SET model_connection_id = ? WHERE id = ?')
        .run(this.connectionGet(mapped) ? mapped : null, str(row.id))
    }
  }

  /**
   * 旧配置迁移：接入库为空且旧的 config.llm 填过密钥时，用它建一条接入
   * （否则老库没有接入可挑，下面的人设卡迁移会无从下手）。
   * 旧的 config.llm 保留不动，仍是主播卡没选模型时的临时兜底。
   */
  private migrateLegacyLlm(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM model_connections').get() as { n?: unknown } | undefined
    if (Number(row?.n ?? 0) > 0) return
    const { llm } = this.config
    if (!llm.apiKey) return
    this.connectionSave({
      name: LLM_PROVIDER_META[llm.provider].label,
      providerId: llm.provider,
      params: { apiKey: llm.apiKey, baseUrl: llm.baseUrl },
      models: [llm.model]
    })
  }

  /**
   * model_connections 旧列清理：`default_model`（没特别指定时用哪个模型）与
   * `is_default`（「全站默认接入」时代的残留）都删掉——模型一律由人设卡显式指定。
   * SQLite 去列要重建表：逐列按名拷贝，params 里的密钥密文原样搬运。
   */
  private migrateModelConnectionColumns(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(model_connections)')
      .all()
      .map((row) => str((row as Record<string, unknown>).name))
    if (!columns.includes('default_model') && !columns.includes('is_default')) return
    const rows = this.db.prepare('SELECT * FROM model_connections').all().map((row) => row as Record<string, unknown>)
    this.db.exec('DROP TABLE model_connections')
    this.createModelConnectionsTable()
    const insert = this.db.prepare(
      `INSERT INTO model_connections (id, name, provider_id, params, models, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        str(row.id),
        str(row.name),
        str(row.provider_id),
        String(row.params ?? '{}'),
        String(row.models ?? '[]'),
        num(row.created_at) ?? 0,
        num(row.updated_at) ?? 0
      )
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

  /** 模型级上下文窗口列（model_windows，JSON：模型 id → tokens）：老库补列，幂等 */
  private ensureModelConnectionWindows(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(model_connections)')
      .all()
      .map((row) => str((row as Record<string, unknown>).name))
    if (columns.includes('model_windows')) return
    this.db.exec("ALTER TABLE model_connections ADD COLUMN model_windows TEXT NOT NULL DEFAULT '{}'")
  }

  /**
   * tts_connections 结构迁移，两步都走同一套「读旧行 → DROP → 建新表 → 写回」：
   * ① 老表（provider_id UNIQUE、params 平铺凭据与模型单值）没有 models 列 → 转换重建：
   *    百炼旧行 params.model → models=[{id, params}]（languageType 匹配目标模型 ParamSpec 的
   *    language_type 选项才保留，否则丢弃；baseUrl 非官方默认才留）；火山旧行是 V1 凭据
   *    （appId/token/cluster），V3 已放弃 → 凭据清空（API Key 待用户补填）、模型预置全部。
   * ② 已有 models 列但还带 default_model / default_voice / is_default 的表 → 去列重建：
   *    这三列代表的「默认模型 / 默认音色 / 默认接入」已废（模型与音色一律在使用点指定），
   *    只按列名拷贝，params 里的密钥密文原样搬运，realtime 保留。
   * 都做完了就直接返回（幂等：再跑一次不重建、不报错）。
   */
  private migrateTtsConnections(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(tts_connections)')
      .all()
      .map((row) => str((row as Record<string, unknown>).name))
    if (!columns.includes('models')) {
      this.rebuildLegacyTtsConnections()
      return
    }
    if (!columns.includes('default_model') && !columns.includes('default_voice') && !columns.includes('is_default')) {
      return
    }
    const rows = this.db
      .prepare('SELECT * FROM tts_connections ORDER BY created_at ASC')
      .all()
      .map((row) => row as Record<string, unknown>)
    this.db.exec('DROP TABLE tts_connections')
    this.createTtsConnectionsTable()
    const insert = this.db.prepare(
      `INSERT INTO tts_connections (id, provider_id, name, params, models, realtime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        str(row.id),
        str(row.provider_id),
        str(row.name),
        String(row.params ?? '{}'),
        String(row.models ?? '[]'),
        Number(row.realtime) === 1 ? 1 : 0,
        num(row.created_at) ?? 0,
        num(row.updated_at) ?? 0
      )
    }
  }

  private createTtsConnectionsTable(): void {
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
  }

  /** ① 老表（无 models 列）的重建与转换 */
  private rebuildLegacyTtsConnections(): void {
    const rows = this.db
      .prepare('SELECT * FROM tts_connections ORDER BY created_at ASC')
      .all()
      .map((row) => row as Record<string, unknown>)
    this.db.exec('DROP TABLE tts_connections')
    this.createTtsConnectionsTable()
    for (const row of rows) {
      const providerId = str(row.provider_id)
      const legacy = this.decryptTtsParams(row.params, providerId)
      const def = getTtsProvider(providerId)
      const credentials: Record<string, string | number | boolean> = {}
      let models: TtsConnectionModel[]
      if (providerId === 'bailian') {
        credentials.apiKey = String(legacy.apiKey ?? '')
        credentials.workspaceId = String(legacy.workspaceId ?? '')
        const baseUrl = String(legacy.baseUrl ?? '').trim()
        if (baseUrl && baseUrl !== 'https://dashscope.aliyuncs.com/api/v1') {
          credentials.baseUrl = baseUrl
        }
        const modelId = String(legacy.model ?? '').trim() || 'qwen3-tts-flash'
        const modelParams: TtsConnectionModel['params'] = {}
        const languageType = String(legacy.languageType ?? '').trim()
        const langSpec = ttsModelSpec(providerId, modelId)?.params.find(
          (param) => param.key === 'language_type'
        )
        if (languageType && langSpec?.options?.some((option) => option.value === languageType)) {
          modelParams.language_type = languageType
        }
        models = [{ id: modelId, params: modelParams }]
      } else {
        // 火山（及未知 provider）：V1 凭据放弃，凭据字段置空，模型预置全部
        for (const field of ttsConnectionFields(providerId)) credentials[field.key] = ''
        models = (def?.models ?? []).map((spec) => ({ id: spec.id, params: {} }))
      }
      this.ttsConnectionSave({
        id: str(row.id),
        providerId: providerId as TtsConnection['providerId'],
        name: def?.label ?? providerId,
        params: credentials,
        models
      })
    }
  }

  /**
   * 老库克隆音色回填绑定（voices.model / connection_id）：
   * 火山复刻音色统一挂 seed-icl-2.0 + 火山最早那条接入（V1 复刻音色在 V3 的可用性待真机验证，
   * 但绑定语义不变：它们是 ICL 模型吃的 speaker_id）。百炼老库无克隆产物（当时未实现），不留空。
   */
  private backfillVoiceBindings(): void {
    const rows = this.db
      .prepare("SELECT id, provider FROM voices WHERE model = ''")
      .all()
      .map((row) => row as Record<string, unknown>)
    if (rows.length === 0) return
    const volcanoDefault = this.ttsConnectionFirstOf('volcano')
    for (const row of rows) {
      if (str(row.provider) !== 'volcano') continue
      this.db
        .prepare('UPDATE voices SET model = ?, connection_id = ? WHERE id = ?')
        .run('seed-icl-2.0', volcanoDefault?.id ?? '', str(row.id))
    }
  }

  /**
   * 旧配置迁移：接入表为空且旧的 config.tts 填过凭据时，把**当前服务商那家**抽成一条接入（新结构）。
   * 全局偏好 speed/format/sampleRate 折入当时那个模型的 models[].params（仅当目标模型 ParamSpec
   * 有对应键且值在选项里；speed=1 丢弃）。平铺在 config.tts 里的凭据字段自此不再使用
   * （保留字段：加密路径与这次迁移还要读它们）。
   */
  private migrateLegacyTts(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tts_connections').get() as
      | { n?: unknown }
      | undefined
    if (Number(row?.n ?? 0) > 0) return
    const { tts } = this.config
    const providerId = tts.providerId
    if (!ttsProviderHasCredentials(tts, providerId)) return
    const def = getTtsProvider(providerId)
    if (!def) return
    const legacy = tts as unknown as Record<string, string | number | boolean>
    const credentials: Record<string, string | number | boolean> = {}
    for (const field of ttsConnectionFields(providerId)) {
      credentials[field.key] = legacy[field.key] ?? field.default ?? ''
    }
    if (providerId === 'volcano') {
      // 旧 appId/accessToken/cluster 是 V1 凭据，V3 用不了：API Key 留空待用户补填
      credentials.apiKey = ''
    }
    if (providerId === 'bailian' && credentials.baseUrl === 'https://dashscope.aliyuncs.com/api/v1') {
      delete credentials.baseUrl
    }

    let models: TtsConnectionModel[]
    let targetModelId: string
    const legacyModel = String(legacy.model ?? '').trim()
    if (providerId === 'bailian' && legacyModel && def.models.some((spec) => spec.id === legacyModel)) {
      models = [{ id: legacyModel, params: {} }]
      targetModelId = legacyModel
      const languageType = String(legacy.languageType ?? '').trim()
      const langSpec = ttsModelSpec(providerId, legacyModel)?.params.find(
        (param) => param.key === 'language_type'
      )
      if (languageType && langSpec?.options?.some((option) => option.value === languageType)) {
        models[0].params.language_type = languageType
      }
    } else {
      models = def.models.map((spec) => ({ id: spec.id, params: {} }))
      targetModelId = def.models.find((spec) => spec.kind === 'tts')?.id ?? models[0]?.id ?? ''
    }

    // 旧的全局偏好折进这条接入（默认模型已删，折进 models 里当时最该用的那个模型的参数）
    const spec = ttsModelSpec(providerId, targetModelId)
    const target = models.find((model) => model.id === targetModelId)
    if (spec && target) {
      if (tts.speed !== 1 && spec.params.some((param) => param.key === 'speech_rate')) {
        target.params.speech_rate = Math.round((tts.speed - 1) * 100)
      }
      const formatSpec = spec.params.find((param) => param.key === 'format')
      if (formatSpec?.options?.some((option) => option.value === tts.format)) {
        target.params.format = tts.format
      }
      const sampleRate = String(tts.sampleRate)
      const rateSpec = spec.params.find((param) => param.key === 'sample_rate')
      if (rateSpec?.options?.some((option) => option.value === sampleRate)) {
        target.params.sample_rate = sampleRate
      }
    }

    this.ttsConnectionSave({
      providerId,
      name: def.label,
      params: credentials,
      models,
      realtime: Boolean(tts.realtime)
    })
  }

  /**
   * 一次性：清掉旧 config.tts 的全局偏好，折完不再读。
   * 实时合成开关是接入级策略（不是兜底），折进第一条接入里保留；
   * 旧的全局默认音色已经没有落点（默认音色/默认接入都删了），直接清空——
   * 人设卡没选音色就留着空，让开播预检拦下来，不做任何猜测。
   */
  private migrateTtsGlobalPrefs(): void {
    const { tts } = this.config
    const legacyVoice = String(tts.voiceId ?? '').trim()
    const legacyRealtime = Boolean(tts.realtime)
    if (!legacyVoice && !legacyRealtime) return
    if (legacyRealtime) {
      const first = this.ttsConnectionList()[0]
      if (first && !first.realtime) {
        this.db.prepare('UPDATE tts_connections SET realtime = 1 WHERE id = ?').run(first.id)
      }
    }
    this.setConfig({ tts: { voiceId: '', realtime: false } })
  }

  /**
   * 人设卡的大脑迁移：老库里没选过接入的卡，挑一条能用的接入补上（模型用该接入 models[] 的第一个）。
   * 开播必须每张卡都有明确的大脑，不能让升级上来的用户一开播就发现没得选。
   * 语音这边不补默认音色：没选就留着空，交给开播预检。
   */
  private migratePersonaBrains(): void {
    const rows = this.db
      .prepare('SELECT id, model_connection_id, model FROM agents')
      .all()
      .map((row) => row as Record<string, unknown>)
    if (rows.length === 0) return

    const usable = this.connectionList().find((connection) =>
      isModelConnectionReady(connection, getLlmProvider(connection.providerId))
    )

    for (const row of rows) {
      const currentId = str(row.model_connection_id)
      if (currentId) {
        // 已选过接入的卡只补空的模型；接入被删（悬空引用）留给用户重选，不悄悄换一条
        const current = this.connectionGet(currentId)
        if (!current || str(row.model)) continue
        this.db
          .prepare('UPDATE agents SET model = ? WHERE id = ?')
          .run(connectionFirstModel(current, getLlmProvider(current.providerId)), str(row.id))
        continue
      }
      if (!usable) continue
      this.db
        .prepare('UPDATE agents SET model_connection_id = ?, model = ? WHERE id = ?')
        .run(usable.id, connectionFirstModel(usable, getLlmProvider(usable.providerId)), str(row.id))
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
          dedupe_key, expires_at, reply_to, status, audio_path, speech_text, stream,
          origin_utterance_id, para_id, para_pos, para_len, error, sort_order, created_at, played_at)
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
        item.stream ? 1 : 0,
        item.originUtteranceId ?? null,
        item.paraId ?? null,
        item.paraPos ?? null,
        item.paraLen ?? null,
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
          plannedMinutes: num(r.planned_minutes) ?? DEFAULT_PLANNED_MINUTES,
          createdAt: num(r.created_at) ?? 0,
          updatedAt: num(r.updated_at) ?? 0
        }
      })
  }

  planSave(plan: LivePlan): void {
    this.db
      .prepare(
        `INSERT INTO live_plans (id, name, theme, persona_id, style_hint, planned_minutes, script_id,
                                 current_scene_idx, gen_config, knowledge_scope, voice_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, theme = excluded.theme,
           persona_id = excluded.persona_id, style_hint = excluded.style_hint,
           planned_minutes = excluded.planned_minutes,
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
        plan.plannedMinutes,
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
        `INSERT INTO utterances (id, plan_id, scene_id, variant_idx, text, bit_type, delivery, voice_id, audio_path,
                                 status, error, source, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scene_id = excluded.scene_id, variant_idx = excluded.variant_idx,
           text = excluded.text, bit_type = excluded.bit_type, delivery = excluded.delivery,
           voice_id = excluded.voice_id, audio_path = excluded.audio_path,
           status = excluded.status, error = excluded.error, source = excluded.source,
           sources = excluded.sources`
      )
      .run(
        u.id,
        u.planId,
        u.sceneId,
        u.variantIdx,
        u.text,
        u.bitType,
        u.delivery,
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

  /** 段落归属（整段合成切句成功的一组）；paraId 为空串表示清除（改文本/逐条回退时） */
  utteranceSetPara(ids: string[], paraId: string): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE utterances SET para_id = ? WHERE id = ?')
    for (const id of ids) stmt.run(paraId, id)
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
    bitType: str(r.bit_type),
    delivery: str(r.delivery),
    voiceId: str(r.voice_id),
    audioPath: str(r.audio_path) || null,
    synthVoice: str(r.synth_voice),
    status: (str(r.status) || 'pending') as Utterance['status'],
    error: str(r.error) || undefined,
    source: str(r.source) === 'adopted' ? 'adopted' : 'initial',
    sources: parseJson<Utterance['sources']>(r.sources, []),
    paraId: str(r.para_id) || undefined,
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
