import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSecretBox, isV2Sealed, open as openSeal, seal } from './secretBox'
import { hotWords } from './statsWords'
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
  type UsageBucket,
  type UsageDashboard,
  type MaterialFile,
  type ModelConnection,
  type ModelConnectionInput,
  type ModelConnectionSafe,
  type PartialDeep,
  type Persona,
  type Program,
  type ProgramKnowledgeScope,
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
 * 持久化层（统一 SQLite，userData/agentanchor.db，Node 内置、WAL、免原生重编译）：
 * - 应用配置：app_config 表单行 JSON（tts.accessToken / tts.apiKey / llm.apiKey 等加密内联）；
 *   旧版 config.json 启动时一次性迁入并改名留底
 * - 业务数据：各业务表（话术池/节目/底稿/触发器…）
 * - 供应商接入（llm_connections / tts_connections）：密钥字段在 params 里内联加密
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
  text: unknown
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
  language_type: unknown
  pause_after_ms: unknown
  stream: unknown
  origin_draft_unit_id: unknown
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
  'Portuguese'
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
    text: str(row.text),
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
    languageType: str(row.language_type) || undefined,
    pauseAfterMs: num(row.pause_after_ms),
    stream: num(row.stream) === 1,
    originDraftUnitId: str(row.origin_draft_unit_id) || undefined,
    error: str(row.error) || undefined,
    sortOrder: num(row.sort_order),
    createdAt: num(row.created_at) ?? 0,
    playedAt: num(row.played_at)
  }
}

const ACTIVE_STATUSES: PoolItemStatus[] = ['pending', 'synthesizing', 'ready', 'playing']

// ---------- live_sessions / broadcast_events 行映射 ----------

function rowToSession(row: Record<string, unknown>): BroadcastSession {
  return {
    id: str(row.id),
    programId: str(row.program_id),
    programName: str(row.program_name),
    directorModelDesc: str(row.director_model_desc),
    personas: parseJson(row.personas, []),
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
  /** 旧版配置文件路径：只用于启动时向数据库迁移，迁完改名留底 */
  private readonly configFile: string
  private config: AppConfig
  private configListeners = new Set<(config: AppConfig) => void>()
  private db: DatabaseSync
  /** 命令行在应用没开时按这个路径把它拉起来（main 启动时 setLaunch 写入） */
  private launchApp = ''
  private launchArgs: string[] = []

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
    // 开放接口令牌：首次启动生成一次（randomUUID），之后随配置持久化（落库加密）
    if (!this.config.mcp.token) {
      this.config.mcp.token = randomUUID()
      this.saveConfig()
    } else {
      // 端点文件跟随最新配置（端口/开关可能被外部改过）
      this.writeMcpFile()
    }
    // 节目化迁移（破坏性，docs/10 §9.4）：live_plans/modes/plan_sessions/plan_id 列 → programs/program_id。
    // 必须跑在相关业务表 CREATE 之前：迁移负责把旧结构抬到最终结构，CREATE 只兜全新库
    this.migratePrograms()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_items (
        id TEXT PRIMARY KEY,
        live_session_id TEXT NOT NULL DEFAULT '',
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
        created_at INTEGER NOT NULL,
        played_at INTEGER
      )
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS pool_items_status ON pool_items(status, created_at)'
    )
    // 人设卡（M3 单主播，表结构为多主播预留）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
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
      )
    `)
    this.db.exec(`
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
    // 摘要并入场次表（live_sessions.summary），episode_summaries 废弃
    this.db.exec('DROP TABLE IF EXISTS episode_summaries')
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
    // v14 之后编排在 programs.plan：历史 scripts 表彻底退役（建表语句已删，这里兜底清理旧库）
    this.db.exec('DROP TABLE IF EXISTS scripts')
    // v3 起事件绑节目（评论/触发器等事件写入时带当前 activeProgramId）
    this.ensureColumn('event_log', 'program_id', 'TEXT')
    // 提示词模板（导演手册）：**有行 = 用户手改过，没行 = 用代码里的默认**。
    // 所以这里不播种、也不存「是否默认」标记——恢复默认就是把行删掉。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 节目（一场直播/一期播客/一本有声书都是一个节目）
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
        persona_ids TEXT NOT NULL DEFAULT '[]',
        script_id TEXT,
        knowledge_scope TEXT NOT NULL DEFAULT '{}',
        current_scene_idx INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 节目卡司（主播卡 id 数组；空 = 导演自选）：存量节目补列默认 []
    this.ensureColumn('programs', 'persona_ids', "TEXT NOT NULL DEFAULT '[]'")
    // 节目语言（多语言节目）：auto = 自动识别，其余为语言标识（Chinese/English/…）
    this.ensureColumn('programs', 'language', "TEXT NOT NULL DEFAULT 'auto'")
    // 节目级风格指令（≤100 字）：节目不再存声音配置，只存这一条演法底色
    this.ensureColumn('programs', 'instruction', 'TEXT')
    // 节目话术库（docs/07 §3 draft_units：底稿库，与运行态 pool_items 分工）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS draft_units (
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
    this.db.exec('CREATE INDEX IF NOT EXISTS draft_units_program ON draft_units(program_id, scene_id, status)')
    // 预合成时实际用的音色：装载进池时比对，音色改过就不复用旧音频
    this.ensureColumn('draft_units', 'synth_voice', "TEXT NOT NULL DEFAULT ''")
    // 话术取自哪条库底稿（复盘溯源，docs/07 §3）
    this.ensureColumn('pool_items', 'origin_draft_unit_id', 'TEXT')
    // 实时合成条目标记（M9）
    this.ensureColumn('pool_items', 'stream', 'INTEGER NOT NULL DEFAULT 0')
    // 语音稿（显示稿与念法分离）
    this.ensureColumn('pool_items', 'speech_text', 'TEXT')
    // 现场表演指示（情绪/语气）：模型支持语气指令时随这次合成发出去
    this.ensureColumn('pool_items', 'delivery', 'TEXT')
    // 演法硬参数：语速/音调倍率（agent 下沉，空 = 接入默认）
    this.ensureColumn('pool_items', 'rate', 'REAL')
    this.ensureColumn('pool_items', 'pitch', 'REAL')
    // 情感参数（火山 emotion / emotion_scale）：按条指定情绪，空 = 接入默认
    this.ensureColumn('pool_items', 'emotion', 'TEXT')
    this.ensureColumn('pool_items', 'emotion_scale', 'REAL')
    // 语种提示（百炼 qwen3-tts language_type）：空 = 接入默认/自动
    this.ensureColumn('pool_items', 'language_type', 'TEXT')
    // 播完这条后的停顿毫秒（播放时调度，不进合成；NULL = 连续播）
    this.ensureColumn('pool_items', 'pause_after_ms', 'INTEGER')
    // 桥段制：内容形态标签（BIT_TYPES；'' = 旧式单句）+ 表演指示（情绪/语速/停顿）
    this.ensureColumn('draft_units', 'bit_type', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('draft_units', 'delivery', "TEXT NOT NULL DEFAULT ''")
    // 这段归哪张主播卡（稳定寻址；空 = 合成时用卡司第一张）
    this.ensureColumn('draft_units', 'persona_id', 'TEXT')
    // 演法硬参数：语速/音调倍率（agent 下沉，空 = 接入默认）
    this.ensureColumn('draft_units', 'rate', 'REAL')
    this.ensureColumn('draft_units', 'pitch', 'REAL')
    // 播完这段后的停顿毫秒（播放时调度，不进合成；NULL = 连续播）
    this.ensureColumn('draft_units', 'pause_after_ms', 'INTEGER')
    // 场景内创作顺序号：装池按它排（首轮严格按叙事顺序播放）
    this.ensureColumn('draft_units', 'seq', 'INTEGER NOT NULL DEFAULT 0')
    // 预制音频资产（RenderedAudioRef JSON，docs/10 §9.6）：预制节目的正式产物挂在段/章上
    this.ensureColumn('draft_units', 'rendered', 'TEXT')
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
    // 用量采集（DB v3，数据页用量看板）：LLM 每次请求一条 usage_records，TTS 每次合成一条 tts_records
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        program_id TEXT,
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
    this.db.exec('CREATE INDEX IF NOT EXISTS usage_records_ts ON usage_records(ts)')
    this.db.exec('CREATE INDEX IF NOT EXISTS usage_records_program ON usage_records(program_id, ts)')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tts_records (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        program_id TEXT,
        connection_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        voice_id TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL DEFAULT 0,
        cost REAL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS tts_records_ts ON tts_records(ts)')
    this.db.exec('CREATE INDEX IF NOT EXISTS tts_records_program ON tts_records(program_id, ts)')
    // BlobStore 统一存储引擎（docs 设计：内容寻址 + 登记制引用 + 宽限期 GC；文本不进，只有二进制资产）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        ext TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        mime TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT 'cache',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `)
    // tier：cache（默认，缓存语义）/ temp（到期即删）/ asset（GC 永不主动删）；老库补列
    this.ensureColumn('blobs', 'tier', "TEXT NOT NULL DEFAULT 'cache'")
    this.ensureColumn('blobs', 'expires_at', 'INTEGER')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blob_refs (
        blob_hash TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blob_hash, owner_kind, owner_id)
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS blob_refs_hash ON blob_refs(blob_hash)')
    // TTS 参数指纹 → blob：「同文同参免合成」的查找表，本身也是 blob 的缓存级别名（无 owner 引用时按容量 LRU 逐出）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tts_cache (
        param_key TEXT PRIMARY KEY,
        blob_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    // 克隆音色绑定目标模型与克隆时的接入（合成路由按它反推，定死不可跨模型）
    this.ensureColumn('voices', 'model', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('voices', 'connection_id', "TEXT NOT NULL DEFAULT ''")
    // 音色级风格指令（合成优先级：agent 演法 > 节目级 > 音色级 > 接入×模型默认）
    this.ensureColumn('voices', 'instruction', "TEXT NOT NULL DEFAULT ''")
    // 节目即会话：每个节目一份持久对话（pi 会话 entries + 可见时间线），切节目/重启后恢复
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS director_sessions (
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
    // 全局单会话迁移（导演模型，docs/REDESIGN §3.2）：prep/live 双会话废弃，
    // director_sessions 退化为 program_id='director' 的单条滚动存档；
    // 老库把当前节目那份会话改 key 留下，其余节目的存档废弃
    this.migrateToGlobalSession()
    // 场记（场次记录）：一次开播一份留档。话术播出事实靠 pool_items.live_session_id 指向这里，
    // 音频不复制（audio_path 是 blob 路径，blob_refs 保活）；评论/事件镜像进 broadcast_events。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_sessions (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        program_name TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL DEFAULT 0,
        end_reason TEXT NOT NULL DEFAULT '',
        stats TEXT NOT NULL DEFAULT '{}'
      )
    `)
    // 下播复盘摘要与开播快照直接挂在场次上
    this.ensureColumn('live_sessions', 'summary', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('live_sessions', 'director_model_desc', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('live_sessions', 'personas', "TEXT NOT NULL DEFAULT '[]'")
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS live_sessions_program ON live_sessions(program_id, started_at)'
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broadcast_events (
        id TEXT PRIMARY KEY,
        live_session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS broadcast_events_session ON broadcast_events(live_session_id, ts)')
    // 启动清扫：上次退出遗留的 rendered synthesizing 重置为 failed（docs/10 §15.14）
    this.sweepInterruptedRendered()
    // 凭据加密自管化：旧 safeStorage 密文能解就转 v2（见 secretBox.ts）
    this.migrateLegacySecrets()
    // 品牌改名后目录从 AgentAnchor 搬到 YunCast：库里存量绝对路径（音频缓存/预制音频/音色样本/知识库文件）跟着改写
    this.rewriteLegacyDataPaths()
  }

  /** 一次性路径迁移：把库里以旧品牌目录开头的绝对路径改写到当前 userData（文件本身由 index.ts 的目录搬迁保证已就位） */
  private rewriteLegacyDataPaths(): void {
    const dir = app.getPath('userData')
    const legacyDir = join(app.getPath('appData'), 'AgentAnchor')
    if (legacyDir === dir) return
    const targets: [string, string][] = [
      ['pool_items', 'audio_path'],
      ['draft_units', 'audio_path'],
      ['material_files', 'file_path'],
      ['voices', 'sample_path']
    ]
    let total = 0
    for (const [table, column] of targets) {
      const { changes } = this.db
        .prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE instr(${column}, ?) = 1`)
        .run(dir, legacyDir.length + 1, legacyDir)
      total += Number(changes)
    }
    if (total > 0) console.log(`[YunCast] 存量音频/文件路径迁移：改写 ${total} 行（${legacyDir} → ${dir}）`)
  }

  // ---------- 节目会话持久化（全局单会话：key 固定 'director'，单条滚动存档） ----------

  /** 全局唯一导演会话的存档 key（director_sessions 退化而来的单条记录） */
  static readonly DIRECTOR_SESSION_KEY = 'director'

  /** 老库一次性迁移：当前节目那份会话改 key 成 'director'，其余节目存档废弃；已是新结构就跳过 */
  private migrateToGlobalSession(): void {
    const existing = this.db
      .prepare(`SELECT 1 FROM director_sessions WHERE program_id = '${StorageService.DIRECTOR_SESSION_KEY}' LIMIT 1`)
      .get()
    if (existing) return
    const activeId = this.config.live.activeProgramId
    const row = activeId
      ? (this.db
          .prepare('SELECT purpose, entries, updated_at FROM director_sessions WHERE program_id = ?')
          .get(activeId) as { purpose: string; entries: string; updated_at: number } | undefined)
      : undefined
    this.db
      .prepare(`DELETE FROM director_sessions WHERE program_id <> '${StorageService.DIRECTOR_SESSION_KEY}'`)
      .run()
    if (row) {
      this.db
        .prepare('INSERT INTO director_sessions (program_id, purpose, entries, updated_at) VALUES (?, ?, ?, ?)')
        .run(StorageService.DIRECTOR_SESSION_KEY, row.purpose, row.entries, row.updated_at)
      console.log('[YunCast] 会话存档迁移：当前节目的会话已并入全局导演会话')
    }
  }

  /** 保存某节目的 pi 会话 entries（stop/切节目/每轮结束时覆盖写） */
  saveProgramSession(programId: string, purpose: string, entriesJson: string): void {
    this.db
      .prepare(
        `INSERT INTO director_sessions (program_id, purpose, entries, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET purpose = excluded.purpose, entries = excluded.entries, updated_at = excluded.updated_at`
      )
      .run(programId, purpose, entriesJson, Date.now())
  }

  loadProgramSession(programId: string): { purpose: string; entries: string } | null {
    const row = this.db.prepare('SELECT purpose, entries FROM director_sessions WHERE program_id = ?').get(programId) as
      | { purpose: string; entries: string }
      | undefined
    return row ?? null
  }

  deleteProgramSession(programId: string): void {
    this.db.prepare('DELETE FROM director_sessions WHERE program_id = ?').run(programId)
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
    const oldSamplePath = str(
      (this.db.prepare('SELECT sample_path AS p FROM voices WHERE id = ?').get(voice.id) as Record<string, unknown> | undefined)?.p
    )
    this.db
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
    const newSamplePath = voice.samplePath || ''
    if (oldSamplePath !== newSamplePath) {
      this.onAudioPathChange?.('voice', voice.id, oldSamplePath || null, newSamplePath || null)
    }
  }

  deleteVoice(id: string): void {
    const oldSamplePath = str(
      (this.db.prepare('SELECT sample_path AS p FROM voices WHERE id = ?').get(id) as Record<string, unknown> | undefined)?.p
    )
    this.db.prepare('DELETE FROM voices WHERE id = ?').run(id)
    if (oldSamplePath) this.onAudioPathChange?.('voice', id, oldSamplePath, null)
  }

  // ---------- 供应商接入（设置 → 语言模型） ----------

  /** 读出全部接入（密钥字段已解密），按创建顺序 */
  connectionList(): ModelConnection[] {
    return this.db
      .prepare('SELECT * FROM llm_connections ORDER BY created_at ASC')
      .all()
      .map((row) => this.toModelConnection(row as Record<string, unknown>))
  }

  connectionGet(id: string): ModelConnection | null {
    const row = this.db.prepare('SELECT * FROM llm_connections WHERE id = ?').get(id)
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
    // 模型级单价（已停用：UI 不再发送，仅为兼容旧调用与旧库数据保留读写；两个价都空的键不落盘）
    const modelPrices: Record<string, { input?: number; output?: number }> = {}
    for (const [key, value] of Object.entries(input.modelPrices ?? {})) {
      const id2 = key.trim()
      if (!models.includes(id2) || !value || typeof value !== 'object') continue
      const clean: { input?: number; output?: number } = {}
      const inputPrice = Number(value.input)
      if (Number.isFinite(inputPrice) && inputPrice >= 0) clean.input = inputPrice
      const outputPrice = Number(value.output)
      if (Number.isFinite(outputPrice) && outputPrice >= 0) clean.output = outputPrice
      if (clean.input !== undefined || clean.output !== undefined) modelPrices[id2] = clean
    }

    this.db
      .prepare(
        `INSERT INTO llm_connections (id, name, provider_id, params, models, model_windows, model_thinking, model_params, model_prices, created_at, updated_at)
         VALUES (@id, @name, @providerId, @params, @models, @modelWindows, @modelThinking, @modelParams, @modelPrices, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, provider_id = @providerId, params = @params,
           models = @models, model_windows = @modelWindows, model_thinking = @modelThinking, model_params = @modelParams, model_prices = @modelPrices, updated_at = @updatedAt`
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
        modelPrices: JSON.stringify(modelPrices),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })

    return this.connectionGet(id) as ModelConnection
  }

  connectionDelete(id: string): void {
    this.db.prepare('DELETE FROM llm_connections WHERE id = ?').run(id)
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
    const rawPrices = parseJson<unknown>(r.model_prices, {})
    const modelPrices: ModelConnection['modelPrices'] = {}
    if (rawPrices && typeof rawPrices === 'object' && !Array.isArray(rawPrices)) {
      for (const [key, value] of Object.entries(rawPrices as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const v = value as Record<string, unknown>
          const price: { input?: number; output?: number } = {}
          if (typeof v.input === 'number' && v.input >= 0) price.input = v.input
          if (typeof v.output === 'number' && v.output >= 0) price.output = v.output
          if (price.input !== undefined || price.output !== undefined) modelPrices[key] = price
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
      modelPrices,
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
    for (const table of ['llm_connections', 'tts_connections']) {
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

    /** 数据库结构版本（PRAGMA user_version）：1 = 节目化改造（programs 落成，modes/live_plans/plan_id 全删）；2 = 预制音频资产（utterances.rendered 列，docs/10 §9.6）；3 = 用量与成本采集（usage_records/tts_records 表 + event_log.program_id 列 + llm_connections.model_prices 列）；4 = 底层表名改造（agents→personas / utterances→draft_units / speech_items→pool_items / model_connections→llm_connections / program_sessions→director_sessions / broadcast_sessions→live_sessions）；5 = 主播卡去掉大脑/角色/当前出镜旧列；6 = 删 model_profile_id 死列；7 = 节目不再存声音配置（audio_config 的 instruction 提到顶层）；10 = 命名收口（presenter_* → persona_*、blob 引用类型跟新实体名）；11 = 主播卡 id 前缀 anchor-* → persona-*（含节目卡司/底稿/时间线/场次快照里的引用）；12 = 素材统一（products→materials、knowledge_files→material_files，knowledge_scope 键改名）；14 = 编排并入节目（programs.plan），script_id 与 scripts 表退役；15 = 素材支持正文与链接附件，节目素材范围只留 materials */
  private static readonly DB_VERSION = 15

  /**
   * 节目化迁移（docs/10 §9.4，破坏性，一次性）：事务内直接得到最终表结构，不留兼容分支。
   * v1：live_plans → 建新 programs（复制仍有价值的字段，节目新字段给默认值，mode_id/voice_id/
   * planned_minutes/gen_config/style_hint 随之入土）；plan_sessions → program_sessions；
   * utterances/director_timeline 的 plan_id 列改名 program_id；modes 表删除。
   * v2：utterances 加 rendered 列（预制音频资产 JSON；scripts.scenes[].rendered 是可选字段不用迁）。
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
      if (version < 1) {
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
      }
      if (version < 2 && hasTable('utterances')) {
        // 预制音频资产列（RenderedAudioRef JSON）；全新库此时表还没建，由后面的 ensureColumn 兜底
        this.ensureColumn('utterances', 'rendered', 'TEXT')
      }
      if (version < 3) {
        // 用量与成本采集：两张新表 + event_log 绑节目列 + 接入的模型单价列。
        // 都是纯增量：全新库由构造器的 CREATE IF NOT EXISTS / ensureColumn 兜底，这里管老库抬升
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS usage_records (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            program_id TEXT,
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
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS tts_records (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            program_id TEXT,
            connection_id TEXT NOT NULL DEFAULT '',
            model_id TEXT NOT NULL DEFAULT '',
            voice_id TEXT NOT NULL DEFAULT '',
            chars INTEGER NOT NULL DEFAULT 0,
            cost REAL
          )
        `)
        if (hasTable('event_log')) this.ensureColumn('event_log', 'program_id', 'TEXT')
        if (hasTable('model_connections')) {
          this.ensureColumn('model_connections', 'model_prices', "TEXT NOT NULL DEFAULT '{}'")
        }
        // 校验：v3 产物必须都在
        for (const table of ['usage_records', 'tts_records']) {
          if (!hasTable(table)) throw new Error(`v3 迁移后 ${table} 表不存在`)
        }
        if (hasTable('event_log') && !columnsOf('event_log').has('program_id')) {
          throw new Error('event_log.program_id 迁移后仍不存在')
        }
      }
      // v4：底层表名改造（agents→personas / utterances→draft_units / speech_items→pool_items /
      // model_connections→llm_connections / program_sessions→director_sessions / broadcast_sessions→live_sessions）
      if (version < 4) {
        const renames: [string, string][] = [
          ['agents', 'personas'],
          ['utterances', 'draft_units'],
          ['speech_items', 'pool_items'],
          ['model_connections', 'llm_connections'],
          ['program_sessions', 'director_sessions'],
          ['broadcast_sessions', 'live_sessions']
        ]
        for (const [from, to] of renames) {
          if (hasTable(from) && !hasTable(to)) this.db.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
        }
        // 旧索引名跟着表走会保留旧名：删掉，由 init 里的 CREATE INDEX 用新名重建
        for (const index of ['speech_items_status', 'utterances_program', 'utterances_plan', 'broadcast_sessions_program']) {
          this.db.exec(`DROP INDEX IF EXISTS ${index}`)
        }
        for (const [, to] of renames) {
          if (!hasTable(to)) throw new Error(`v4 迁移后 ${to} 表不存在`)
        }
      }
      // v7：节目不再存声音配置——audio_config 列里的 instruction 提到顶层 instruction 列，然后整列删除
      // （迁移跑在 CREATE 之前，instruction 列要先补上）
      if (version < 7) {
        if (hasTable('programs') && !columnsOf('programs').has('instruction')) {
          this.db.exec('ALTER TABLE programs ADD COLUMN instruction TEXT')
        }
        if (hasTable('programs') && columnsOf('programs').has('audio_config')) {
          const rows = this.db.prepare('SELECT id, audio_config FROM programs').all() as Record<string, unknown>[]
          const update = this.db.prepare('UPDATE programs SET instruction = ? WHERE id = ?')
          for (const row of rows) {
            const cfg = parseJson<{ instruction?: string }>(row.audio_config, {})
            const instruction = typeof cfg.instruction === 'string' ? cfg.instruction.trim() : ''
            if (instruction) update.run(instruction, str(row.id))
          }
          this.db.exec('ALTER TABLE programs DROP COLUMN audio_config')
        }
      }
      // v6：最后一个死列（model_profile_id 是更早的「模型档案」残留，代码零引用）
      if (version < 6) {
        if (columnsOf('personas').has('model_profile_id')) {
          this.db.exec('ALTER TABLE personas DROP COLUMN model_profile_id')
        }
      }
      // v5：字段改造——删掉主播卡的废弃列（大脑/角色/当前出镜时代的残留），
      // 并把与新表名不一致的列改名（session_id→live_session_id、source_agent_id→source_actor_id、
      // origin_utterance_id→origin_draft_unit_id，pool_items 与 broadcast_events 同步）
      if (version < 5) {
        const personaCols = columnsOf('personas')
        for (const col of ['roles', 'active', 'model_connection_id', 'model']) {
          if (personaCols.has(col)) this.db.exec(`ALTER TABLE personas DROP COLUMN ${col}`)
        }
        const renameColumn = (table: string, cols: Set<string>, from: string, to: string) => {
          if (cols.has(from) && !cols.has(to)) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
        }
        const poolCols = columnsOf('pool_items')
        renameColumn('pool_items', poolCols, 'session_id', 'live_session_id')
        renameColumn('pool_items', poolCols, 'source_agent_id', 'source_actor_id')
        renameColumn('pool_items', poolCols, 'origin_utterance_id', 'origin_draft_unit_id')
        renameColumn('broadcast_events', columnsOf('broadcast_events'), 'session_id', 'live_session_id')
        this.db.exec('DROP INDEX IF EXISTS broadcast_events_session')
      }
      // v15：素材附件支持链接；条目加正文；节目的素材范围只留 materials（附件随条目走）
      if (version < 15) {
        if (hasTable('materials') && !columnsOf('materials').has('content')) {
          this.db.exec("ALTER TABLE materials ADD COLUMN content TEXT NOT NULL DEFAULT ''")
        }
        if (hasTable('material_files') && !columnsOf('material_files').has('type')) {
          this.db.exec("ALTER TABLE material_files ADD COLUMN type TEXT NOT NULL DEFAULT 'file'")
        }
        if (hasTable('material_files') && !columnsOf('material_files').has('url')) {
          this.db.exec("ALTER TABLE material_files ADD COLUMN url TEXT NOT NULL DEFAULT ''")
        }
        if (hasTable('programs') && columnsOf('programs').has('knowledge_scope')) {
          const rows = this.db.prepare('SELECT id, knowledge_scope FROM programs').all() as Record<string, unknown>[]
          const update = this.db.prepare('UPDATE programs SET knowledge_scope = ? WHERE id = ?')
          for (const row of rows) {
            const scope = parseJson<{ materials?: unknown }>(row.knowledge_scope, {})
            update.run(JSON.stringify({ materials: scope.materials ?? '*' }), str(row.id))
          }
        }
      }
      // v14：编排并入节目——programs.plan 存场景序列，script_id 与 scripts 表退役
      if (version < 14) {
        if (hasTable('programs') && !columnsOf('programs').has('plan')) {
          this.db.exec(`ALTER TABLE programs ADD COLUMN plan TEXT NOT NULL DEFAULT '{"scenes":[]}'`)
        }
        if (hasTable('programs') && hasTable('scripts') && columnsOf('programs').has('script_id')) {
          const rows = this.db.prepare('SELECT id, script_id FROM programs').all() as Record<string, unknown>[]
          const getScenes = this.db.prepare('SELECT scenes FROM scripts WHERE id = ?')
          const update = this.db.prepare('UPDATE programs SET plan = ? WHERE id = ?')
          for (const row of rows) {
            const scriptId = str(row.script_id)
            if (!scriptId) continue
            const hit = getScenes.get(scriptId) as Record<string, unknown> | undefined
            if (!hit) continue
            update.run(JSON.stringify({ scenes: parseJson(hit.scenes, []) }), str(row.id))
          }
        }
        if (hasTable('programs') && columnsOf('programs').has('script_id')) {
          this.db.exec('ALTER TABLE programs DROP COLUMN script_id')
        }
        this.db.exec('DROP TABLE IF EXISTS scripts')
      }
      // v12：素材统一——products → materials（条目），knowledge_files → material_files（附属于条目）；
      // programs.knowledge_scope 的 products 键 → materials
      if (version < 12) {
        if (hasTable('products') && !hasTable('materials')) {
          this.db.exec('ALTER TABLE products RENAME TO materials')
        }
        if (hasTable('knowledge_files') && !hasTable('material_files')) {
          this.db.exec('ALTER TABLE knowledge_files RENAME TO material_files')
        }
        if (hasTable('material_files') && !columnsOf('material_files').has('material_id')) {
          this.db.exec("ALTER TABLE material_files ADD COLUMN material_id TEXT NOT NULL DEFAULT ''")
        }
        if (hasTable('programs') && columnsOf('programs').has('knowledge_scope')) {
          const rows = this.db.prepare('SELECT id, knowledge_scope FROM programs').all() as Record<string, unknown>[]
          const update = this.db.prepare('UPDATE programs SET knowledge_scope = ? WHERE id = ?')
          for (const row of rows) {
            const scope = parseJson<Record<string, unknown>>(row.knowledge_scope, {})
            if ('products' in scope || !('materials' in scope)) {
              update.run(
                JSON.stringify({ materials: scope.products ?? '*', files: scope.files ?? '*' }),
                str(row.id)
              )
            }
          }
        }
      }
      // v11：id 前缀去掉历史品牌——主播卡 id `anchor-*` → `persona-*`。
      // 主播卡 id 是外部可见的稳定寻址（节目卡司、底稿归属、对话时间线、场次快照都存着它），
      // 所以一次把库里所有引用一起改写，不只是 personas.id。
      if (version < 11) {
        const rewrite = (table: string, column: string, quoted = false): void => {
          if (!hasTable(table) || !columnsOf(table).has(column)) return
          const col = quoted ? `"${column}"` : column
          this.db
            .prepare(`UPDATE ${table} SET ${col} = REPLACE(${col}, 'anchor-', 'persona-') WHERE ${col} LIKE '%anchor-%'`)
            .run()
        }
        rewrite('personas', 'id')
        rewrite('programs', 'persona_ids')
        rewrite('draft_units', 'persona_id')
        rewrite('director_timeline', 'payload')
        rewrite('director_sessions', 'entries')
        rewrite('live_sessions', 'cast', true)
        rewrite('live_sessions', 'personas', true)
        // 场次卡司快照列跟着改名：cast 是 SQL 关键字，之前一直带引号用，这里一并正名
        if (hasTable('live_sessions') && columnsOf('live_sessions').has('cast') && !columnsOf('live_sessions').has('personas')) {
          this.db.exec('ALTER TABLE live_sessions RENAME COLUMN "cast" TO personas')
        }
      }
      // v10：命名收口——主播卡列名 presenter_* → persona_*；blob 引用类型跟着新实体名
      // （utterance → draft_unit / speech_item → pool_item / utterance_rendered → draft_unit_rendered）
      if (version < 10) {
        const renameCol = (table: string, from: string, to: string) => {
          const cols = columnsOf(table)
          if (cols.has(from) && !cols.has(to)) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
        }
        if (hasTable('programs')) renameCol('programs', 'presenter_ids', 'persona_ids')
        if (hasTable('draft_units')) renameCol('draft_units', 'presenter_id', 'persona_id')
        if (hasTable('blob_refs')) {
          const kindMap: [string, string][] = [
            ['utterance', 'draft_unit'],
            ['speech_item', 'pool_item'],
            ['utterance_rendered', 'draft_unit_rendered']
          ]
          const update = this.db.prepare('UPDATE blob_refs SET owner_kind = ? WHERE owner_kind = ?')
          for (const [from, to] of kindMap) update.run(to, from)
        }
      }
      this.db.exec(`PRAGMA user_version = ${StorageService.DB_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 启动清扫（docs/10 §15.14，每次启动都跑）：上次退出遗留的 rendered.status='synthesizing'
   * 一律重置为 'failed'（error='应用重启中断'），完成产物保留，用户手动继续合成。
   * draft_units.rendered 列与 scripts.scenes[].rendered 都要扫。
   */
  private sweepInterruptedRendered(): void {
    try {
      const rows = this.db
        .prepare(`SELECT id, rendered FROM draft_units WHERE rendered LIKE '%"synthesizing"%'`)
        .all() as { id: unknown; rendered: unknown }[]
      const update = this.db.prepare('UPDATE draft_units SET rendered = ? WHERE id = ?')
      for (const row of rows) {
        const rendered = parseJson<RenderedAudioRef | null>(row.rendered, null)
        if (!rendered || rendered.status !== 'synthesizing') continue
        update.run(JSON.stringify({ ...rendered, status: 'failed', error: '应用重启中断' }), str(row.id))
      }
      if (rows.length > 0) console.log(`[存储] 清扫中断的预制合成：draft_units ${rows.length} 条重置为失败`)
    } catch {
      // rendered 列还没建（首次启动走到这之前 ensureColumn 已跑，这里只是兜底）
    }
    try {
      const rows = this.db
        .prepare(`SELECT id, plan FROM programs WHERE plan LIKE '%"synthesizing"%'`)
        .all() as { id: unknown; plan: unknown }[]
      const update = this.db.prepare('UPDATE programs SET plan = ? WHERE id = ?')
      let swept = 0
      for (const row of rows) {
        const plan = parseJson<{ scenes: ScriptScene[] }>(row.plan, { scenes: [] })
        const scenes = plan.scenes
        let dirty = false
        for (const scene of scenes) {
          if (scene.rendered?.status !== 'synthesizing') continue
          scene.rendered = { ...scene.rendered, status: 'failed', error: '应用重启中断' }
          dirty = true
          swept++
        }
        if (dirty) update.run(JSON.stringify(scenes), str(row.id))
      }
      if (swept > 0) console.log(`[存储] 清扫中断的预制合成：剧本场景 ${swept} 条重置为失败`)
    } catch {
      // 表还没建就跳过
    }
  }

  private createModelConnectionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_connections (
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
      .prepare('PRAGMA table_info(llm_connections)')
      .all()
      .map((row) => str((row as Record<string, unknown>).name))
    if (!columns.includes('model_windows')) {
      this.db.exec("ALTER TABLE llm_connections ADD COLUMN model_windows TEXT NOT NULL DEFAULT '{}'")
    }
    if (!columns.includes('model_thinking')) {
      this.db.exec("ALTER TABLE llm_connections ADD COLUMN model_thinking TEXT NOT NULL DEFAULT '{}'")
    }
    // 模型级高级参数列（model_params，JSON：模型 id → { vision/temperature/maxTokens }）
    if (!columns.includes('model_params')) {
      this.db.exec("ALTER TABLE llm_connections ADD COLUMN model_params TEXT NOT NULL DEFAULT '{}'")
    }
    // 模型级单价列（model_prices，JSON：模型 id → { input/output }，元/百万 tokens）
    if (!columns.includes('model_prices')) {
      this.db.exec("ALTER TABLE llm_connections ADD COLUMN model_prices TEXT NOT NULL DEFAULT '{}'")
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
        console.log('[YunCast] config.json 已并入数据库，原文件改名 config.json.migrated 留底')
        return config
      }
      return structuredClone(DEFAULT_CONFIG)
    } catch (error) {
      console.error('[YunCast] 读取配置失败，用默认值:', error)
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
    // 导演大脑迁移（导演模型，破坏性）：没有 directorConfig 时取当前主播卡摘下来的
    // modelConnectionId/model 落盘——这是主播卡摘脑后唯一保留的迁移
    if (!('director' in raw)) {
      // 旧版从主播卡摘下来的大脑：v5 之后这两列已删除，查不到就用默认值
      let legacy: { connectionId?: unknown; model?: unknown } | undefined
      try {
        legacy = this.db
          .prepare('SELECT model_connection_id AS connectionId, model FROM personas LIMIT 1')
          .get() as { connectionId?: unknown; model?: unknown } | undefined
      } catch {
        legacy = undefined
      }
      raw.director = {
        name: DEFAULT_DIRECTOR_CONFIG.name,
        modelConnectionId: typeof legacy?.connectionId === 'string' && legacy.connectionId ? legacy.connectionId : null,
        model: typeof legacy?.model === 'string' ? legacy.model : ''
      }
      migrated = true
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
      this.db
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
   * 音频归属变化钩子（BlobStoreService 注入）：owner 行的 audio_path 变化时回调，
   * 由它对 blobs/ 目录下的文件登记/解除引用（登记制 GC 的唯一入口，外部不要直接操作 blob_refs）。
   * 注意同步调用：better-sqlite3 单连接，回调里再查库是安全的。
   */
  /**
   * 音频/文件路径变更钩子（BlobStore 引用登记的驱动）。
   * ownerKind：draftUnit/speech_item（audio_path 列）、voice（sample_path）、
   * draft_unit_rendered/scene_rendered（rendered JSON 里的 audioPath）、knowledge_file（file_path）。
   */
  onAudioPathChange:
    | ((
        ownerKind: 'draft_unit' | 'pool_item' | 'voice' | 'draft_unit_rendered' | 'scene_rendered' | 'knowledge_file',
        ownerId: string,
        oldPath: string | null,
        newPath: string | null
      ) => void)
    | null = null

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
         (id, live_session_id, text, turn_id, seq, voice_id, source_actor_id, source_kind, lane,
          dedupe_key, expires_at, reply_to, status, audio_path, speech_text, delivery, rate, pitch, emotion, emotion_scale, language_type, pause_after_ms, stream,
          origin_draft_unit_id, error, sort_order, created_at, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        item.emotion ?? null,
        item.emotionScale ?? null,
        item.languageType ?? null,
        item.pauseAfterMs ?? null,
        item.stream ? 1 : 0,
        item.originDraftUnitId ?? null,
        item.error ?? null,
        item.sortOrder ?? null,
        item.createdAt,
        item.playedAt ?? null
      )
    if (item.audioPath) this.onAudioPathChange?.('pool_item', item.id, null, item.audioPath)
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
    if (patch.speechText !== undefined) columns.speech_text = patch.speechText ?? null
    if (patch.emotion !== undefined) columns.emotion = patch.emotion || null
    if (patch.emotionScale !== undefined) columns.emotion_scale = patch.emotionScale ?? null
    if (patch.languageType !== undefined) columns.language_type = patch.languageType || null
    const keys = Object.keys(columns)
    if (keys.length === 0) return
    // audio_path 变化要先取旧值（BlobStore 引用登记需要新旧两个路径）
    const oldAudioPath =
      patch.audioPath !== undefined
        ? (str(
            (this.db.prepare('SELECT audio_path AS p FROM pool_items WHERE id = ?').get(id) as Record<string, unknown> | undefined)?.p
          ) || null)
        : undefined
    const sql = `UPDATE pool_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    this.db.prepare(sql).run(...(keys.map((k) => columns[k]) as never[]), id)
    if (oldAudioPath !== undefined) {
      this.onAudioPathChange?.('pool_item', id, oldAudioPath, (patch.audioPath ?? null) as string | null)
    }
  }

  poolItemGet(id: string): PoolItem | null {
    const row = this.db.prepare('SELECT * FROM pool_items WHERE id = ?').get(id)
    return row ? rowToItem(row as unknown as PoolItemRow) : null
  }

  /** 未播完的条目（pending/synthesizing/ready/playing），排序由 SpeechPool 负责 */
  poolItemActive(): PoolItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pool_items WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
      )
      .all(...ACTIVE_STATUSES)
    return rows.map((row) => rowToItem(row as unknown as PoolItemRow))
  }

  /** 某时间点之后进入终态失败的条目 */
  poolItemFailedSince(since: number): PoolItem[] {
    const rows = this.db
      .prepare("SELECT * FROM pool_items WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC")
      .all(since)
    return rows.map((row) => rowToItem(row as unknown as PoolItemRow))
  }

  /** 最近播完的条目（get_recent_played 工具用） */
  poolItemRecentPlayed(n: number): PoolItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pool_items WHERE status IN ('done', 'interrupted') ORDER BY played_at DESC LIMIT ?"
      )
      .all(n)
    return rows.map((row) => rowToItem(row as unknown as PoolItemRow))
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
    // 删除前把要删行的音频路径取出来，删完逐个解除 blob 引用（GC 按登记回收文件）。
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
    for (const row of doomed) {
      del.run(str(row.id))
      const path = str(row.audio_path)
      if (path) this.onAudioPathChange?.('pool_item', str(row.id), path, null)
    }
  }

  // ---------- 场记（场次记录，docs 见 SessionRecorder） ----------

  sessionInsert(session: BroadcastSession): void {
    this.db
      .prepare(
        `INSERT INTO live_sessions (id, program_id, program_name, director_model_desc, personas, started_at, ended_at, end_reason, stats, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.programId,
        session.programName,
        session.directorModelDesc,
        JSON.stringify(session.personas),
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
      ? this.db.prepare('SELECT * FROM live_sessions WHERE program_id = ? ORDER BY started_at DESC').all(programId)
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

  /** 开场时把池里存货（未播完的活跃条目）改挂到新场次：播出事实跟着实际播出的那场走 */
  poolItemRestampActive(sessionId: string): void {
    this.db
      .prepare(
        `UPDATE pool_items SET live_session_id = ? WHERE status IN ('pending', 'synthesizing', 'ready', 'playing')`
      )
      .run(sessionId)
  }

  /** 删场次：连带删它的播出条目（逐条解 blob 引用）与事件镜像，最后删场次行 */
  sessionDelete(id: string): void {
    const items = this.db
      .prepare('SELECT id, audio_path FROM pool_items WHERE live_session_id = ?')
      .all(id) as Record<string, unknown>[]
    const delItem = this.db.prepare('DELETE FROM pool_items WHERE id = ?')
    for (const row of items) {
      delItem.run(str(row.id))
      const path = str(row.audio_path)
      if (path) this.onAudioPathChange?.('pool_item', str(row.id), path, null)
    }
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
      conds.push('program_id = @pid')
      args.pid = query.programId
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const sessionIds = `SELECT id FROM live_sessions ${where}`
    const sessions = this.db
      .prepare(
        `SELECT id, program_id, program_name, personas, started_at, ended_at FROM live_sessions ${where} ORDER BY started_at`
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
    // 合成量走 tts_records（合成事实表；它与场次的口径不同——按自己的 ts/program_id 筛）
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
      ttsConds.push('program_id = @pid')
      ttsArgs.pid = query.programId
    }
    const ttsChars = num(
      (
        this.db
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
    const programOf = new Map(sessions.map((row) => [str(row.id), str(row.program_id)]))
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
      const pid = str(row.program_id)
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

    // 主播排行：主播 = 场次快照里的 personaName（一场多卡各记一场）
    const personaAgg = new Map<string, { personaName: string; sessions: number; minutes: number }>()
    for (const row of sessions) {
      const sessionPersonas = parseJson<{ personaName?: string }[]>(row.personas, [])
      const seen = new Set<string>()
      for (const member of sessionPersonas) {
        const name = str(member.personaName)
        if (!name || seen.has(name)) continue
        seen.add(name)
        const entry = personaAgg.get(name) ?? { personaName: name, sessions: 0, minutes: 0 }
        entry.sessions += 1
        entry.minutes += sessionMinutes(row)
        personaAgg.set(name, entry)
      }
    }
    const byCast = [...personaAgg.values()]
      .map((entry) => ({ ...entry, minutes: Math.round(entry.minutes) }))
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
      byCast,
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

  // ---------- BlobStore（统一二进制资产存储：内容寻址 + 登记制引用 + 宽限期 GC） ----------

  /** 写入/触碰 blob 元数据。同内容重复 put 时 tier 只升不降（temp < cache < asset），temp 的到期时间取更早的那个 */
  blobUpsert(blob: { hash: string; ext: string; bytes: number; mime: string; tier?: string; expiresAt?: number | null }): void {
    const now = Date.now()
    const tier = blob.tier ?? 'cache'
    const expiresAt = tier === 'temp' ? (blob.expiresAt ?? null) : null
    this.db
      .prepare(
        `INSERT INTO blobs (hash, ext, bytes, mime, tier, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           tier = CASE
             WHEN blobs.tier = 'asset' OR excluded.tier = 'asset' THEN 'asset'
             WHEN blobs.tier = 'cache' OR excluded.tier = 'cache' THEN 'cache'
             ELSE 'temp' END,
           expires_at = CASE
             WHEN blobs.tier != 'temp' OR excluded.tier != 'temp' THEN NULL
             ELSE MIN(COALESCE(blobs.expires_at, excluded.expires_at), COALESCE(excluded.expires_at, blobs.expires_at)) END`
      )
      .run(blob.hash, blob.ext, blob.bytes, blob.mime, tier, expiresAt, now, now)
  }

  blobGet(
    hash: string
  ): { hash: string; ext: string; bytes: number; mime: string; tier: string; expiresAt: number | null; lastSeenAt: number } | null {
    const row = this.db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      hash: str(row.hash),
      ext: str(row.ext),
      bytes: num(row.bytes) ?? 0,
      mime: str(row.mime),
      tier: str(row.tier) || 'cache',
      expiresAt: num(row.expires_at) ?? null,
      lastSeenAt: num(row.last_seen_at) ?? 0
    }
  }

  blobTouch(hash: string): void {
    this.db.prepare('UPDATE blobs SET last_seen_at = ? WHERE hash = ?').run(Date.now(), hash)
  }

  /** 删 blob 行并连带清掉它的别名与引用登记（sweep 各路径共用，这里兜底防悬挂） */
  blobDelete(hash: string): void {
    this.db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash)
    this.db.prepare('DELETE FROM tts_cache WHERE blob_hash = ?').run(hash)
    this.db.prepare('DELETE FROM blob_refs WHERE blob_hash = ?').run(hash)
  }

  /** 已到期的 temp 级 blob（sweep 第一步：到期即删、不进容量统计）；仍被 owner 引用的不在此列——见 blobExpiredTempsReferenced */
  blobExpiredTemps(now: number): { hash: string; bytes: number }[] {
    return (
      this.db
        .prepare(
          `SELECT b.hash, b.bytes FROM blobs b
           WHERE b.tier = 'temp' AND b.expires_at IS NOT NULL AND b.expires_at < ?
             AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_hash = b.hash)`
        )
        .all(now) as Record<string, unknown>[]
    ).map((row) => ({ hash: str(row.hash), bytes: num(row.bytes) ?? 0 }))
  }

  /** 已到期但仍被 owner 引用的 temp 级 blob：有人忘了 promote，sweep 跳过删除并按 owner 报警 */
  blobExpiredTempsReferenced(now: number): { hash: string; owners: { kind: string; id: string }[] }[] {
    const rows = this.db
      .prepare(
        `SELECT b.hash, r.owner_kind, r.owner_id FROM blobs b
         JOIN blob_refs r ON r.blob_hash = b.hash
         WHERE b.tier = 'temp' AND b.expires_at IS NOT NULL AND b.expires_at < ?`
      )
      .all(now) as Record<string, unknown>[]
    const byHash = new Map<string, { kind: string; id: string }[]>()
    for (const row of rows) {
      const list = byHash.get(str(row.hash)) ?? []
      list.push({ kind: str(row.owner_kind), id: str(row.owner_id) })
      byHash.set(str(row.hash), list)
    }
    return [...byHash].map(([hash, owners]) => ({ hash, owners }))
  }

  /** 调整 blob 级别（temp 转正 asset/cache 时清掉到期时间） */
  blobSetTier(hash: string, tier: 'cache' | 'temp' | 'asset'): void {
    this.db
      .prepare('UPDATE blobs SET tier = ?, expires_at = CASE WHEN ? = \'temp\' THEN expires_at ELSE NULL END WHERE hash = ?')
      .run(tier, tier, hash)
    this.blobTouch(hash)
  }

  /** 真孤儿判定：没有任何 owner 引用、也没有缓存别名（asset 级显式删除前的安全检查） */
  blobIsOrphan(hash: string): boolean {
    const refs = this.db.prepare('SELECT COUNT(*) AS c FROM blob_refs WHERE blob_hash = ?').get(hash) as Record<string, unknown>
    const aliases = this.db.prepare('SELECT COUNT(*) AS c FROM tts_cache WHERE blob_hash = ?').get(hash) as Record<string, unknown>
    return (num(refs.c) ?? 0) === 0 && (num(aliases.c) ?? 0) === 0
  }

  blobAddRef(hash: string, ownerKind: string, ownerId: string): void {
    this.db
      .prepare(
        'INSERT INTO blob_refs (blob_hash, owner_kind, owner_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
      )
      .run(hash, ownerKind, ownerId, Date.now())
    this.blobTouch(hash)
  }

  blobReleaseRef(hash: string, ownerKind: string, ownerId: string): void {
    this.db
      .prepare('DELETE FROM blob_refs WHERE blob_hash = ? AND owner_kind = ? AND owner_id = ?')
      .run(hash, ownerKind, ownerId)
  }

  /** GC 候选：没有任何 owner 引用、且不在 tts_cache 别名里、且过了宽限期的 blob */
  blobGcCandidates(graceBefore: number): { hash: string; bytes: number }[] {
    return (
      this.db
        .prepare(
          `SELECT b.hash, b.bytes FROM blobs b
           WHERE b.tier = 'cache' AND b.last_seen_at < ?
             AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_hash = b.hash)
             AND NOT EXISTS (SELECT 1 FROM tts_cache c WHERE c.blob_hash = b.hash)`
        )
        .all(graceBefore) as Record<string, unknown>[]
    ).map((row) => ({ hash: str(row.hash), bytes: num(row.bytes) ?? 0 }))
  }

  /** 缓存级 blob（有 tts_cache 别名但没有 owner 引用）：按 last_seen 升序，供容量 LRU 逐出 */
  blobCacheEntries(): { hash: string; bytes: number; lastSeenAt: number }[] {
    return (
      this.db
        .prepare(
          `SELECT b.hash, b.bytes, b.last_seen_at FROM blobs b
           WHERE b.tier = 'cache'
             AND EXISTS (SELECT 1 FROM tts_cache c WHERE c.blob_hash = b.hash)
             AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_hash = b.hash)
           ORDER BY b.last_seen_at ASC`
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({ hash: str(row.hash), bytes: num(row.bytes) ?? 0, lastSeenAt: num(row.last_seen_at) ?? 0 }))
  }

  ttsCacheGet(paramKey: string): string | null {
    const row = this.db.prepare('SELECT blob_hash AS h FROM tts_cache WHERE param_key = ?').get(paramKey) as
      | Record<string, unknown>
      | undefined
    return row ? str(row.h) : null
  }

  ttsCachePut(paramKey: string, blobHash: string): void {
    this.db
      .prepare(
        `INSERT INTO tts_cache (param_key, blob_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(param_key) DO UPDATE SET blob_hash = excluded.blob_hash`
      )
      .run(paramKey, blobHash, Date.now())
    this.blobTouch(blobHash)
  }

  ttsCacheDelete(paramKey: string): void {
    this.db.prepare('DELETE FROM tts_cache WHERE param_key = ?').run(paramKey)
  }

  /** 所有音频路径及其 owner（BlobStore 老缓存迁移用）：pool_items + draft_units 两表并集 */
  audioPathOwners(): { path: string; ownerKind: 'draft_unit' | 'pool_item'; ownerId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT audio_path AS path, 'pool_item' AS kind, id AS oid FROM pool_items WHERE audio_path IS NOT NULL AND audio_path != ''
         UNION ALL
         SELECT audio_path AS path, 'draft_unit' AS kind, id AS oid FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''`
      )
      .all() as Record<string, unknown>[]
    return rows.map((row) => ({
      path: str(row.path),
      ownerKind: str(row.kind) as 'draft_unit' | 'pool_item',
      ownerId: str(row.oid)
    }))
  }

  /** 迁移期路径改写：把 owner 行的文件路径改成 newPath。按行 id 定位（库内路径斜杠风格不一，不做字符串比对）；不触发引用钩子——迁移过程已显式登记过引用 */
  rewriteOwnerPath(
    ownerKind: 'draft_unit' | 'pool_item' | 'voice' | 'knowledge_file',
    ownerId: string,
    newPath: string
  ): void {
    const target =
      ownerKind === 'draft_unit'
        ? { table: 'draft_units', column: 'audio_path' }
        : ownerKind === 'pool_item'
          ? { table: 'pool_items', column: 'audio_path' }
          : ownerKind === 'voice'
            ? { table: 'voices', column: 'sample_path' }
            : { table: 'material_files', column: 'file_path' }
    this.db.prepare(`UPDATE ${target.table} SET ${target.column} = ? WHERE id = ?`).run(newPath, ownerId)
  }

  // ---------- 人设卡 ----------

  /** 取第一张人设卡（M3 单主播）；库里没有返回 null，由 PersonaService 负责播种 */
  /** 人设卡列表（主播团），按创建顺序 */
  personaList(): Persona[] {
    return this.db
      .prepare('SELECT * FROM personas ORDER BY rowid ASC')
      .all()
      .map((row) => this.toPersona(row as Record<string, unknown>))
  }

  personaDelete(id: string): void {
    this.db.prepare('DELETE FROM personas WHERE id = ?').run(id)
  }

  private toPersona(r: Record<string, unknown>): Persona {
    return {
      id: str(r.id),
      name: str(r.name),
      personality: str(r.personality),
      catchphrases: str(r.catchphrases),
      background: str(r.background),
      taboos: str(r.taboos),
      voiceId: str(r.voice_id),
      updatedAt: num(r.updated_at) ?? 0
    }
  }

  personaSave(persona: Persona): void {
    this.db
      .prepare(
        `INSERT INTO personas (id, name, personality, catchphrases, background, taboos, voice_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, personality = excluded.personality,
           catchphrases = excluded.catchphrases, background = excluded.background,
           taboos = excluded.taboos, voice_id = excluded.voice_id,
           updated_at = excluded.updated_at`
      )
      .run(
        persona.id,
        persona.name,
        persona.personality,
        persona.catchphrases,
        persona.background,
        persona.taboos,
        persona.voiceId,
        persona.updatedAt
      )
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
    if (file.filePath) this.onAudioPathChange?.('knowledge_file', file.id, null, file.filePath)
    this.onDataChanged?.('knowledge', 'files')
  }

  materialFileDelete(id: string): void {
    const oldPath =
      str(
        (this.db.prepare('SELECT file_path AS p FROM material_files WHERE id = ?').get(id) as Record<string, unknown> | undefined)?.p
      ) || null
    this.db.prepare('DELETE FROM material_files WHERE id = ?').run(id)
    if (oldPath) this.onAudioPathChange?.('knowledge_file', id, oldPath, null)
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
    this.onDataChanged?.('triggers')
  }

  triggerDelete(id: string): void {
    this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id)
    this.onDataChanged?.('triggers')
  }

  // ---------- 提示词模板（导演手册） ----------

  promptTemplateGet(key: string): { content: string; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT content, updated_at FROM prompt_templates WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return { content: String(row.content), updatedAt: Number(row.updated_at) }
  }

  /** 全部模板行（只有用户手改过的 key 才有行；启动时清理死 key / 旧默认残留用） */
  promptTemplateRows(): { key: string; content: string }[] {
    return (this.db.prepare('SELECT key, content FROM prompt_templates').all() as Record<string, unknown>[]).map(
      (row) => ({ key: str(row.key), content: str(row.content) })
    )
  }

  /** 删模板行：恢复默认就是删行（没行 = 用代码里的默认文本） */
  promptTemplateDelete(key: string): void {
    this.db.prepare('DELETE FROM prompt_templates WHERE key = ?').run(key)
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
    // 事件绑节目：写入时取当前选中节目（评论/触发器事件都落在它名下）
    const programId = this.config.live.activeProgramId || null
    this.db
      .prepare('INSERT INTO event_log (id, type, source, payload, ts, program_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, event.type, event.source, JSON.stringify(event.payload), event.ts, programId)
    // 容量滚动清理：只留最近 5000 条
    this.db.exec(
      `DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY ts DESC LIMIT 5000)`
    )
  }

  /** 最近的事件（按时间正序）：EventHub 启动回填用 */
  eventLogRecent(limit: number): LiveEvent[] {
    const rows = this.db
      .prepare('SELECT id, type, source, payload, ts, program_id FROM event_log ORDER BY ts DESC LIMIT ?')
      .all(limit) as { id: string; type: string; source: string; payload: string; ts: number; program_id: string | null }[]
    return rows.reverse().map((row) => ({
      id: row.id,
      type: row.type,
      source: row.source as LiveEvent['source'],
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      ts: row.ts,
      programId: row.program_id ?? undefined
    }))
  }

  // ---------- 用量采集（DB v3；cost 列已停用，恒 NULL） ----------

  usageInsert(record: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_records
         (id, ts, program_id, persona_id, connection_id, model, kind, input_tokens, output_tokens, cache_read, cache_write, estimated, cost)
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
    this.db
      .prepare(
        `INSERT INTO tts_records (id, ts, program_id, connection_id, model_id, voice_id, chars, cost)
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
    const where = programId ? 'WHERE program_id = @pid' : ''
    const args: Record<string, string | number> = programId ? { pid: programId } : {}
    const bucket = (table: 'usage_records' | 'tts_records', since?: number): UsageBucket => {
      const row = (
        table === 'usage_records'
          ? this.db
              .prepare(
                `SELECT COALESCE(SUM(input_tokens), 0) AS li, COALESCE(SUM(output_tokens), 0) AS lo,
                        COALESCE(SUM(cache_read), 0) AS lcr
                 FROM usage_records ${programId ? 'WHERE program_id = @pid' : ''}
                 ${since !== undefined ? (programId ? 'AND' : 'WHERE') + ' ts >= @since' : ''}`
              )
              .get({ ...args, ...(since !== undefined ? { since } : {}) }) as Record<string, unknown>
          : this.db
              .prepare(
                `SELECT COALESCE(SUM(chars), 0) AS tc
                 FROM tts_records ${programId ? 'WHERE program_id = @pid' : ''}
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
    const llmTrend = this.db
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM usage_records ${where === '' ? 'WHERE' : where + ' AND'} ts >= @start GROUP BY day`
      )
      .all({ ...args, start: trendStart }) as { day: string; tokens: number }[]
    const ttsTrend = this.db
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
          ? (this.db
              .prepare(
                'SELECT program_id AS pid, COALESCE(SUM(input_tokens + output_tokens), 0) AS value FROM usage_records GROUP BY program_id'
              )
              .all() as { pid: string | null; value: number }[])
          : (this.db
              .prepare('SELECT program_id AS pid, COALESCE(SUM(chars), 0) AS value FROM tts_records GROUP BY program_id')
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
        ? this.db
            .prepare('SELECT * FROM usage_records WHERE program_id = ? ORDER BY ts DESC LIMIT ?')
            .all(programId, limit)
        : this.db.prepare('SELECT * FROM usage_records ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: str(r.id),
      ts: num(r.ts) ?? 0,
      programId: r.program_id ? str(r.program_id) : null,
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
        ? this.db
            .prepare('SELECT * FROM tts_records WHERE program_id = ? ORDER BY ts DESC LIMIT ?')
            .all(programId, limit)
        : this.db.prepare('SELECT * FROM tts_records ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: str(r.id),
      ts: num(r.ts) ?? 0,
      programId: r.program_id ? str(r.program_id) : null,
      connectionId: str(r.connection_id),
      modelId: str(r.model_id),
      voiceId: str(r.voice_id),
      chars: num(r.chars) ?? 0,
      cost: typeof r.cost === 'number' ? r.cost : null
    }))
  }

  /** 迁移期 rendered 路径改写（不触发引用钩子——迁移过程已显式登记） */
  rewriteRenderedPath(ownerKind: 'draft_unit_rendered' | 'scene_rendered', ownerId: string, newPath: string): void {
    if (ownerKind === 'draft_unit_rendered') {
      const row = this.db.prepare('SELECT rendered AS r FROM draft_units WHERE id = ?').get(ownerId) as Record<string, unknown> | undefined
      const rendered = parseJson<RenderedAudioRef | null>(row?.r, null)
      if (!rendered) return
      this.db
        .prepare('UPDATE draft_units SET rendered = ? WHERE id = ?')
        .run(JSON.stringify({ ...rendered, audioPath: newPath }), ownerId)
      return
    }
    for (const row of this.db.prepare('SELECT id, plan FROM programs').all() as Record<string, unknown>[]) {
      const plan = parseJson<{ scenes: { id?: string; rendered?: RenderedAudioRef }[] }>(row.plan, { scenes: [] })
      const index = plan.scenes.findIndex((scene) => scene.id === ownerId)
      if (index < 0) continue
      const rendered = plan.scenes[index].rendered
      if (!rendered) return
      const scenes = [...plan.scenes]
      scenes[index] = { ...scenes[index], rendered: { ...rendered, audioPath: newPath } }
      this.db.prepare('UPDATE programs SET plan = ? WHERE id = ?').run(JSON.stringify({ scenes }), str(row.id))
      return
    }
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
        const personaIds = parseJson<unknown>(r.persona_ids, [])
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
          personaIds: Array.isArray(personaIds) ? personaIds.map(String).filter(Boolean) : [],
          instruction: str(r.instruction) || undefined,
          language: programLanguageOf(r.language),
          plan: parseJson<{ scenes: ScriptScene[] }>(r.plan, { scenes: [] }),
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
                               enabled_trigger_ids, persona_ids, instruction, language, plan, knowledge_scope, current_scene_idx,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, theme = excluded.theme,
           content_type = excluded.content_type, broadcast_mode = excluded.broadcast_mode,
           finish_mode = excluded.finish_mode, allow_live_events = excluded.allow_live_events,
           enabled_trigger_ids = excluded.enabled_trigger_ids, persona_ids = excluded.persona_ids,
           instruction = excluded.instruction, language = excluded.language,
           plan = excluded.plan, knowledge_scope = excluded.knowledge_scope,
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
        JSON.stringify(program.personaIds),
        program.instruction?.trim() || null,
        program.language ?? 'auto',
        JSON.stringify(program.plan),

        JSON.stringify(program.knowledgeScope),
        program.currentSceneIdx,
        program.createdAt,
        program.updatedAt
      )
  }

  programDelete(id: string): void {
    this.db.prepare('DELETE FROM programs WHERE id = ?').run(id)
    // 走 draftUnitDeleteWhere 而不是裸 DELETE：BlobStore 引用要逐条解除
    this.draftUnitDeleteWhere(id)
    // 场记级联：节目的历史场次一起删（播出条目的 blob 引用在 sessionDelete 里逐条解除）
    for (const session of this.sessionList(id)) this.sessionDelete(session.id)
  }

  /** 场景推进进度落库（断播能续） */
  renderedPathOwners(): { path: string; ownerKind: 'draft_unit_rendered' | 'scene_rendered'; ownerId: string }[] {
    const out: { path: string; ownerKind: 'draft_unit_rendered' | 'scene_rendered'; ownerId: string }[] = []
    for (const row of this.db.prepare('SELECT id, rendered FROM draft_units').all() as Record<string, unknown>[]) {
      const rendered = parseJson<RenderedAudioRef | null>(row.rendered, null)
      if (rendered?.audioPath) out.push({ path: rendered.audioPath, ownerKind: 'draft_unit_rendered', ownerId: str(row.id) })
    }
    for (const row of this.db.prepare('SELECT id, plan FROM programs').all() as Record<string, unknown>[]) {
      const plan = parseJson<{ scenes: { id?: string; rendered?: RenderedAudioRef }[] }>(row.plan, { scenes: [] })
      for (const scene of plan.scenes) {
        if (scene.rendered?.audioPath && scene.id) {
          out.push({ path: scene.rendered.audioPath, ownerKind: 'scene_rendered', ownerId: scene.id })
        }
      }
    }
    return out
  }

  programSetSceneIdx(id: string, idx: number): void {
    this.db.prepare('UPDATE programs SET current_scene_idx = ? WHERE id = ?').run(idx, id)
  }

  // ---------- 话术库（draft_units） ----------

  draftUnitList(programId: string): DraftUnit[] {
    // 列表顺序 = 叙事顺序：场景段在前（按场景内创作序号 seq），全场通用沉底
    return this.db
      .prepare(
        `SELECT * FROM draft_units WHERE program_id = ?
         ORDER BY CASE WHEN scene_id = '' THEN 1 ELSE 0 END, scene_id ASC, seq ASC, created_at ASC`
      )
      .all(programId)
      .map((row) => rowToDraftUnit(row as Record<string, unknown>))
  }

  /** 场景内下一个创作序号（write_bits/手动新增都用它；老数据 seq=0 时从 max(created 序) 续） */
  draftUnitNextSeq(programId: string, sceneId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM draft_units WHERE program_id = ? AND scene_id = ?')
      .get(programId, sceneId) as Record<string, unknown>
    return (num(row.m) ?? 0) + 1
  }

  draftUnitSave(u: DraftUnit): void {
    // 音频归属变化（全文 upsert，先取旧路径给 BlobStore 引用登记用）
    const oldAudioPath =
      (str(
        (this.db.prepare('SELECT audio_path AS p FROM draft_units WHERE id = ?').get(u.id) as Record<string, unknown> | undefined)?.p
      ) || null)
    this.db
      .prepare(
        `INSERT INTO draft_units (id, program_id, scene_id, variant_idx, seq, text, bit_type, delivery, rate, pitch, pause_after_ms, persona_id, voice_id, audio_path,
                                 status, error, source, sources, rendered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scene_id = excluded.scene_id, variant_idx = excluded.variant_idx, seq = excluded.seq,
           text = excluded.text, bit_type = excluded.bit_type, delivery = excluded.delivery,
           rate = excluded.rate, pitch = excluded.pitch, pause_after_ms = excluded.pause_after_ms,
           persona_id = excluded.persona_id, voice_id = excluded.voice_id, audio_path = excluded.audio_path,
           status = excluded.status, error = excluded.error, source = excluded.source,
           sources = excluded.sources, rendered = excluded.rendered`
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
        u.pauseAfterMs ?? null,
        u.personaId ?? null,
        u.voiceId,
        u.audioPath ?? null,
        u.status,
        u.error ?? null,
        u.source,
        JSON.stringify(u.sources),
        u.rendered ? JSON.stringify(u.rendered) : null,
        u.createdAt
      )
    this.onAudioPathChange?.('draft_unit', u.id, oldAudioPath, u.audioPath ?? null)
  }

  /** 只更新预制音频资产（rendered 列）：生产入口/导入外部音频/stale 检测用，不动运行态字段 */
  draftUnitSetRendered(id: string, rendered: RenderedAudioRef | null): void {
    const oldRendered = (
      this.db.prepare('SELECT rendered AS r FROM draft_units WHERE id = ?').get(id) as Record<string, unknown> | undefined
    )?.r
    const oldPath = parseJson<RenderedAudioRef | null>(oldRendered, null)?.audioPath || null
    this.db
      .prepare('UPDATE draft_units SET rendered = ? WHERE id = ?')
      .run(rendered ? JSON.stringify(rendered) : null, id)
    const newPath = rendered?.audioPath || null
    if (oldPath !== newPath) this.onAudioPathChange?.('draft_unit_rendered', id, oldPath, newPath)
  }

  draftUnitDelete(id: string): void {
    const row = this.db.prepare('SELECT audio_path AS p, rendered AS r FROM draft_units WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    const oldAudioPath = str(row?.p) || null
    const oldRenderedPath = parseJson<RenderedAudioRef | null>(row?.r, null)?.audioPath || null
    this.db.prepare('DELETE FROM draft_units WHERE id = ?').run(id)
    if (oldAudioPath) this.onAudioPathChange?.('draft_unit', id, oldAudioPath, null)
    if (oldRenderedPath) this.onAudioPathChange?.('draft_unit_rendered', id, oldRenderedPath, null)
  }

  /** 按 id 取单条底稿（删除前取音频路径用） */
  draftUnitGet(id: string): DraftUnit | null {
    const row = this.db.prepare('SELECT * FROM draft_units WHERE id = ?').get(id)
    return row ? rowToDraftUnit(row as Record<string, unknown>) : null
  }

  /** 批量删除（重生成某场景/清空节目话术库用） */
  draftUnitDeleteWhere(programId: string, sceneId?: string): void {
    const doomed = (
      (sceneId === undefined
        ? this.db.prepare('SELECT id, audio_path, rendered FROM draft_units WHERE program_id = ?').all(programId)
        : this.db
            .prepare('SELECT id, audio_path, rendered FROM draft_units WHERE program_id = ? AND scene_id = ?')
            .all(programId, sceneId)) as Record<string, unknown>[]
    ).map((row) => ({
      id: str(row.id),
      audioPath: str(row.audio_path) || null,
      renderedPath: parseJson<RenderedAudioRef | null>(row.rendered, null)?.audioPath || null
    }))
    if (sceneId === undefined) {
      this.db.prepare('DELETE FROM draft_units WHERE program_id = ?').run(programId)
    } else {
      this.db.prepare('DELETE FROM draft_units WHERE program_id = ? AND scene_id = ?').run(programId, sceneId)
    }
    for (const row of doomed) {
      if (row.audioPath) this.onAudioPathChange?.('draft_unit', row.id, row.audioPath, null)
      if (row.renderedPath) this.onAudioPathChange?.('draft_unit_rendered', row.id, row.renderedPath, null)
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
    const oldAudioPath =
      str(
        (this.db.prepare('SELECT audio_path AS p FROM draft_units WHERE id = ?').get(id) as Record<string, unknown> | undefined)?.p
      ) || null
    if (synthVoice === undefined) {
      this.db
        .prepare('UPDATE draft_units SET status = ?, audio_path = ?, error = ? WHERE id = ?')
        .run(status, audioPath, error ?? null, id)
    } else {
      this.db
        .prepare('UPDATE draft_units SET status = ?, audio_path = ?, error = ?, synth_voice = ? WHERE id = ?')
        .run(status, audioPath, error ?? null, synthVoice, id)
    }
    if (oldAudioPath !== (audioPath ?? null)) {
      this.onAudioPathChange?.('draft_unit', id, oldAudioPath, audioPath ?? null)
    }
  }

  /** 所有底稿引用的音频文件（清空/删除底稿时判断缓存是否成孤儿） */
  draftUnitAllAudioPaths(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT audio_path AS path FROM draft_units WHERE audio_path IS NOT NULL AND audio_path != ''")
      .all() as Record<string, unknown>[]).map((row) => str(row.path))
  }

  close(): void {
    this.db.close()
  }
}

function rowToDraftUnit(r: Record<string, unknown>): DraftUnit {
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
    pauseAfterMs: num(r.pause_after_ms),
    personaId: str(r.persona_id) || undefined,
    voiceId: str(r.voice_id),
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
