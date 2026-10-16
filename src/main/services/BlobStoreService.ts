import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { StorageService } from './StorageService'

/** 无引用 blob 的宽限期：撤销/导出/写一半的竞态都靠它兜底——磁盘多占几天不是事，误删是事故 */
const GRACE_MS = 7 * 24 * 3600_000

/** 缓存级 blob（有 TTS 别名但没 owner 引用）的容量上限，超出按最久未见逐出；AGENT_ANCHOR_AUDIO_CACHE_MB 可覆盖 */
const CACHE_MAX_BYTES = Math.max(0, Number(process.env.AGENT_ANCHOR_AUDIO_CACHE_MB ?? 500)) * 1024 * 1024

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/L16',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4'
}

/** 老 audio-cache 文件名里的 TTS 参数指纹（迁移时提成 tts_cache 别名） */
const LEGACY_TTS_NAME = /^tts-([0-9a-f]{20})\.(\w+)$/

export interface BlobPutResult {
  hash: string
  path: string
  bytes: number
  /** true = 内容已存在，源文件已丢弃，没有多存一份 */
  deduped: boolean
}

/** blob 存储级别：cache（默认，缓存语义）/ temp（到期即删）/ asset（GC 永不主动删，只显式删除） */
export type BlobTier = 'cache' | 'temp' | 'asset'

/** temp 级默认有效期：24 小时（putFile 可用 ttlMs 覆盖） */
const DEFAULT_TEMP_TTL_MS = 24 * 3600_000

/**
 * BlobStore 统一存储引擎：内容寻址（sha256）+ 登记制引用 + 宽限期 GC。
 * 只收二进制资产（音频/图片/视频/文件），文本一律留 DB 内联。
 *
 * 存储级别（tier）：
 * - cache（默认）：有 owner 引用不动；只有缓存别名按容量 LRU 逐出；都没有宽限 7 天删
 * - temp：临时文件（下载暂存、上传转码产物），到期即删（仍被 owner 引用的跳过并报警——那是忘了 promote），不占容量配额
 * - asset：持久资产（音色样本、用户导入素材），GC 永不主动删，只显式删除
 *
 * 纪律：
 * - 写入单流一次过（读流 → 算 hash → 落临时文件），rename 原子进桶，崩溃不留半个文件
 * - 引用登记由 StorageService.onAudioPathChange 钩子驱动，与 owner 行写入同生共死；
 *   服务层只管「把 audio_path 设成 blob 路径」，不用感知引用表
 * - 读取只给路径（播放/导出照旧走 ffmpeg/流），BlobStore 不碰字节
 */
export class BlobStoreService {
  private readonly dir = join(app.getPath('userData'), 'blobs')
  private readonly tmpDir = join(app.getPath('userData'), 'blobs-tmp')
  /** blob 元数据内存缓存：pathOf 是热点（播放前检查），省重复查库/stat */
  private readonly meta = new Map<string, { path: string; bytes: number }>()
  /** 预热去重（同文件不重复读） */
  private readonly warming = new Set<string>()

  constructor(private readonly storage: StorageService) {
    storage.onAudioPathChange = (ownerKind, ownerId, oldPath, newPath) =>
      this.syncRef(ownerKind, ownerId, oldPath, newPath)
  }

  /** blobs/ 目录（外部只需要判断「这个路径归不归 BlobStore 管」时用 isBlobPath） */
  isBlobPath(path: string | null | undefined): boolean {
    return typeof path === 'string' && path.startsWith(this.dir)
  }

  pathFor(hash: string, ext: string): string {
    return join(this.dir, hash.slice(0, 2), `${hash}.${ext}`)
  }

  /** 按 hash 取绝对路径（不存在返回 null） */
  pathOf(hash: string): string | null {
    const cached = this.meta.get(hash)
    if (cached && existsSync(cached.path)) return cached.path
    const row = this.storage.blobGet(hash)
    if (!row) {
      this.meta.delete(hash)
      return null
    }
    const path = this.pathFor(row.hash, row.ext)
    if (!existsSync(path)) {
      // 文件被外部挪走：元数据失效，清掉让调用方按「缺失」处理
      this.meta.delete(hash)
      this.storage.blobDelete(hash)
      return null
    }
    this.storage.blobTouch(hash)
    this.meta.set(hash, { path, bytes: row.bytes })
    return path
  }

  /** 写入临时区路径：putFile 的源文件放这里，和 blob 桶同卷，rename 零拷贝 */
  tmpPath(fileName: string): string {
    return join(this.tmpDir, fileName)
  }

  /** 临时区目录（转码/下载暂存用；启动时 sweepTmp 清空） */
  stagingDir(): string {
    return this.tmpDir
  }

  /** blob 路径 → hash（非 blob 路径返回 null）；外部判断「这文件归不归 BlobStore 管、管的是谁」用 */
  hashForPath(path: string | null | undefined): string | null {
    return this.hashFromPath(path ?? null)
  }

  /**
   * 文件入库：流式算 sha256 → 内容已存在则弃源文件（去重）→ 否则 rename 原子进桶。
   * 调用方的源文件写完未落 DB，这里负责兜底清理。
   * tier：cache 默认；temp 带 expires_at（ttlMs 可覆盖，默认 24h），到期由 sweep 删除；asset 永不自动删。
   * move=false 时源文件是用户自己的（不能拿走）：读流单遍同时算 hash + 抄进临时区，再 rename 进桶。
   */
  async putFile(
    srcPath: string,
    ext: string,
    options?: { mime?: string; tier?: BlobTier; ttlMs?: number; move?: boolean }
  ): Promise<BlobPutResult> {
    const tier = options?.tier ?? 'cache'
    const normalizedExt = ext.replace(/^\./, '').toLowerCase()
    // move（默认）：源文件是我们的（合成产物/暂存），rename 零拷贝；否则单流抄一份进临时区
    let staged = srcPath
    let hash: string
    if (options?.move === false) {
      staged = this.tmpPath(`copy-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
      await mkdir(this.tmpDir, { recursive: true })
      hash = await this.copyWithHash(srcPath, staged)
    } else {
      hash = await this.hashFile(srcPath)
    }
    const info = await stat(staged)
    const path = this.pathFor(hash, normalizedExt)
    const upsert = () =>
      this.storage.blobUpsert({
        hash,
        ext: normalizedExt,
        bytes: info.size,
        mime: options?.mime ?? EXT_MIME[normalizedExt] ?? '',
        tier,
        expiresAt: tier === 'temp' ? Date.now() + (options?.ttlMs ?? DEFAULT_TEMP_TTL_MS) : null
      })
    if (existsSync(path)) {
      await rm(staged, { force: true }).catch(() => undefined)
      // 同内容再入库也走 upsert：tier 只升不降（temp 的内容被当资产再存一次就转正）
      upsert()
      this.meta.set(hash, { path, bytes: info.size })
      return { hash, path, bytes: info.size, deduped: true }
    }
    await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true })
    await rename(staged, path)
    upsert()
    this.meta.set(hash, { path, bytes: info.size })
    return { hash, path, bytes: info.size, deduped: false }
  }

  /** temp → asset/cache 晋级（如上传暂存样本转正为音色资产）；文件不动，只改元数据 */
  promote(hash: string, tier: Exclude<BlobTier, 'temp'>): void {
    this.storage.blobSetTier(hash, tier)
  }

  /** asset 级显式删除的入口：确认无引用无别名才删文件；还有人在用就返回 false 不动 */
  async deleteIfUnreferenced(hash: string): Promise<boolean> {
    if (!this.storage.blobIsOrphan(hash)) return false
    const path = this.pathOf(hash)
    this.storage.blobDelete(hash)
    this.meta.delete(hash)
    if (path) await rm(path, { force: true }).catch(() => undefined)
    return true
  }

  /**
   * 预热：后台把文件读进 OS 页面缓存（读出来的数据直接丢弃）。
   * 开播装池/条目就绪时调——第一条播出时 ffmpeg 读的是热缓存，不等磁盘。
   * 去重 + 不 await，调用方随便点火。
   */
  warm(path: string | null | undefined): void {
    if (!path || !this.isBlobPath(path) || this.warming.has(path)) return
    this.warming.add(path)
    const stream = createReadStream(path)
    stream.on('error', () => undefined)
    stream.on('end', () => this.warming.delete(path))
    stream.on('error', () => this.warming.delete(path))
    stream.resume()
  }

  /** GC：temp 到期删（有引用的跳过报警） → cache 级无引用且无别名过宽限期删 → 缓存级（有 TTS 别名无引用）超容量 LRU 逐出；asset 永不进列表 */
  async sweep(): Promise<{ removed: number; freedBytes: number }> {
    let removed = 0
    let freedBytes = 0
    const drop = async (hash: string, bytes: number): Promise<void> => {
      const path = this.pathOf(hash)
      this.storage.blobDelete(hash)
      this.meta.delete(hash)
      if (path) await rm(path, { force: true }).catch(() => undefined)
      removed += 1
      freedBytes += bytes
    }
    // ⓪ temp 到期：没人引用的直接删（不占容量配额）；仍被引用的跳过并报警——owner 忘了 promote，删了就是数据丢失
    for (const blob of this.storage.blobExpiredTemps(Date.now())) await drop(blob.hash, blob.bytes)
    for (const stuck of this.storage.blobExpiredTempsReferenced(Date.now())) {
      console.warn(
        `[BlobStore] temp blob 已到期但仍被引用，跳过删除（owner 未 promote）：${stuck.hash.slice(0, 12)}… ← ${stuck.owners.map((o) => `${o.kind}:${o.id}`).join('、')}`
      )
    }
    // ① 彻底孤儿（连缓存别名都没有）过宽限期才删
    for (const blob of this.storage.blobGcCandidates(Date.now() - GRACE_MS)) await drop(blob.hash, blob.bytes)
    // ② 缓存级超容量逐出（LRU by last_seen）
    const entries = this.storage.blobCacheEntries()
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of entries) {
      if (total <= CACHE_MAX_BYTES) break
      await drop(entry.hash, entry.bytes)
      total -= entry.bytes
    }
    if (removed > 0) {
      console.log(`[BlobStore] GC：回收 ${removed} 个 blob（${(freedBytes / 1024 / 1024).toFixed(1)}MB）`)
    }
    return { removed, freedBytes }
  }

  /**
   * 一次性迁移：老 audio-cache 全部文件搬进 blobs。
   * 文件名里的参数指纹（tts-<sha1-20>.<ext>）提成 tts_cache 别名，缓存语义无缝延续；
   * 被 speech_items/utterances 引用的补登记引用，并把行内路径改写到新位置。
   */
  async migrateLegacyAudioCache(): Promise<{ moved: number }> {
    const legacyDir = join(app.getPath('userData'), 'audio-cache')
    const names = await readdir(legacyDir).catch(() => [] as string[])
    if (names.length === 0) return { moved: 0 }
    // 迁移期间引用快照：同一路径可能被多个 owner 引用，逐个补登记。
    // 库里存的路径可能是正斜杠，join 出来的是反斜杠——两边都 resolve+小写归一化再比对
    const referenced = this.storage.speechReferencedAudioPaths()
    const ownersByPath = new Map<string, { kind: 'utterance' | 'speech_item'; id: string }[]>()
    if (referenced.length > 0) {
      for (const row of this.storage.audioPathOwners()) {
        const key = resolve(row.path).toLowerCase()
        const list = ownersByPath.get(key) ?? []
        list.push({ kind: row.ownerKind, id: row.ownerId })
        ownersByPath.set(key, list)
      }
    }
    let moved = 0
    for (const name of names) {
      const src = join(legacyDir, name)
      const srcKey = resolve(src).toLowerCase()
      const info = await stat(src).catch(() => null)
      if (!info?.isFile()) continue
      const match = LEGACY_TTS_NAME.exec(name)
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'mp3'
      try {
        const put = await this.putFile(src, ext)
        moved += 1
        if (match) this.storage.ttsCachePut(`tts-${match[1]}`, put.hash)
        const owners = ownersByPath.get(srcKey) ?? []
        for (const owner of owners) {
          this.storage.blobAddRef(put.hash, owner.kind, owner.id)
          this.storage.rewriteOwnerPath(owner.kind, owner.id, put.path)
        }
      } catch (error) {
        console.warn(`[BlobStore] 迁移老缓存失败（留在原处）：${name}`, error)
      }
    }
    if (moved > 0) console.log(`[BlobStore] 老缓存迁移完成：${moved} 个文件入 blobs`)
    return { moved }
  }

  /**
   * 一次性迁移：老 voices/ 目录里的克隆音色样本搬进 blobs（asset 档）。
   * 样本是用户原始录音、不可再生，所以是资产级；迁移后 voices.sample_path 改写到 blob 路径并登记引用。
   * 文件已丢失的行保持原样（试听本来就坏了，路径留着便于诊断）。
   */
  async migrateVoiceSamples(): Promise<{ moved: number }> {
    const voices = this.storage.listVoices()
    let moved = 0
    for (const voice of voices) {
      const samplePath = voice.samplePath
      if (!samplePath || this.isBlobPath(samplePath)) continue
      const info = await stat(samplePath).catch(() => null)
      if (!info?.isFile()) continue
      const ext = samplePath.includes('.') ? samplePath.split('.').pop()!.toLowerCase() : 'mp3'
      try {
        const put = await this.putFile(samplePath, ext, { tier: 'asset' })
        this.storage.blobAddRef(put.hash, 'voice', voice.id)
        this.storage.rewriteOwnerPath('voice', voice.id, put.path)
        moved += 1
      } catch (error) {
        console.warn(`[BlobStore] 音色样本迁移失败（留在原处）：${voice.name}`, error)
      }
    }
    if (moved > 0) console.log(`[BlobStore] 音色样本迁移完成：${moved} 个入 blobs（asset 档）`)
    // 收尾：老 voices 目录里没被任何音色引用的残留（旧 saveSample 的遗弃暂存，新版走 temp 档不再漏）清掉
    const legacyDir = join(app.getPath('userData'), 'voices')
    const keep = new Set(
      this.storage
        .listVoices()
        .map((voice) => voice.samplePath)
        .filter(Boolean)
        .map((path) => resolve(path).toLowerCase())
    )
    let cleaned = 0
    for (const name of await readdir(legacyDir).catch(() => [] as string[])) {
      const file = join(legacyDir, name)
      if (keep.has(resolve(file).toLowerCase())) continue
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) continue
      await rm(file, { force: true }).then(() => (cleaned += 1)).catch(() => undefined)
    }
    if (cleaned > 0) console.log(`[BlobStore] 老 voices 目录残留清理：${cleaned} 个遗弃暂存文件`)
    return { moved }
  }

  /**
   * 一次性迁移：老 program-audio/ 目录（整章拼接产物 + 导入的外部音频）搬进 blobs（cache 档）。
   * owner 是 rendered JSON（utterances.rendered / scripts.scenes[].rendered），迁移后改写 JSON 里的
   * audioPath 并登记引用（ownerKind = utterance_rendered / scene_rendered）。
   * 没被任何 rendered 引用的残留文件不入库——cache 档无引用宽限期会清，直接删掉。
   */
  async migrateProgramAudio(): Promise<{ moved: number }> {
    const legacyDir = join(app.getPath('userData'), 'program-audio')
    const names = await readdir(legacyDir).catch(() => [] as string[])
    if (names.length === 0) return { moved: 0 }
    const ownersByPath = new Map<string, { kind: 'utterance_rendered' | 'scene_rendered'; id: string }[]>()
    for (const row of this.storage.renderedPathOwners()) {
      const key = resolve(row.path).toLowerCase()
      const list = ownersByPath.get(key) ?? []
      list.push({ kind: row.ownerKind, id: row.ownerId })
      ownersByPath.set(key, list)
    }
    let moved = 0
    let dropped = 0
    for (const name of names) {
      const src = join(legacyDir, name)
      const srcKey = resolve(src).toLowerCase()
      const info = await stat(src).catch(() => null)
      if (!info?.isFile()) continue
      const owners = ownersByPath.get(srcKey) ?? []
      if (owners.length === 0) {
        // 无引用的历史残留（旧版孤儿清理漏网的）：不迁移，直接删
        await rm(src, { force: true }).then(() => (dropped += 1)).catch(() => undefined)
        continue
      }
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'mp3'
      try {
        const put = await this.putFile(src, ext)
        moved += 1
        for (const owner of owners) {
          this.storage.blobAddRef(put.hash, owner.kind, owner.id)
          this.storage.rewriteRenderedPath(owner.kind, owner.id, put.path)
        }
      } catch (error) {
        console.warn(`[BlobStore] program-audio 迁移失败（留在原处）：${name}`, error)
      }
    }
    if (moved > 0 || dropped > 0) {
      console.log(`[BlobStore] program-audio 迁移完成：${moved} 个入 blobs，${dropped} 个无引用残留清除`)
    }
    return { moved }
  }

  /**
   * 一次性迁移：知识库附件复制进 blobs（asset 档——用户文档，GC 永不主动删）。
   * 注意是 copy（move=false）：老库 file_path 指向用户自己的文件，不能拿走；
   * 迁移后 file_path 指向 blob，用户移动/删除原文件不影响重新解析。
   */
  async migrateKnowledgeFiles(): Promise<{ moved: number }> {
    let moved = 0
    for (const file of this.storage.knowledgeFileList()) {
      if (!file.filePath || this.isBlobPath(file.filePath)) continue
      const info = await stat(file.filePath).catch(() => null)
      if (!info?.isFile()) continue
      const ext = file.filePath.includes('.') ? file.filePath.split('.').pop()!.toLowerCase() : ''
      try {
        const put = await this.putFile(file.filePath, ext, { tier: 'asset', move: false })
        this.storage.blobAddRef(put.hash, 'knowledge_file', file.id)
        this.storage.rewriteOwnerPath('knowledge_file', file.id, put.path)
        moved += 1
      } catch (error) {
        console.warn(`[BlobStore] 知识库附件迁移失败（留在原处）：${file.name}`, error)
      }
    }
    if (moved > 0) console.log(`[BlobStore] 知识库附件迁移完成：${moved} 个入 blobs（asset 档）`)
    return { moved }
  }

  /** 启动时清写入残留的临时目录（崩溃安全的一环） */
  async sweepTmp(): Promise<void> {
    await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** 流式 sha256：数据按 64KB+ 块过一遍，不整读进内存 */
  private hashFile(path: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolvePromise(hash.digest('hex')))
    })
  }

  /** 单流一遍：读源文件 → 边算 sha256 边写临时文件（pipeline 自带背压），源文件不动 */
  private async copyWithHash(srcPath: string, destPath: string): Promise<string> {
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(createReadStream(srcPath), meter, createWriteStream(destPath))
    return hash.digest('hex')
  }

  /** 引用同步：owner 行的音频路径变了，blobs 路径才登记/解除（legacy 路径不碰） */
  private syncRef(ownerKind: string, ownerId: string, oldPath: string | null, newPath: string | null): void {
    const oldHash = this.hashFromPath(oldPath)
    const newHash = this.hashFromPath(newPath)
    if (oldHash === newHash) return
    if (oldHash) this.storage.blobReleaseRef(oldHash, ownerKind, ownerId)
    if (newHash) this.storage.blobAddRef(newHash, ownerKind, ownerId)
  }

  private hashFromPath(path: string | null): string | null {
    if (!path || !this.isBlobPath(path)) return null
    const name = path.split(/[\\/]/).pop() ?? ''
    const hash = name.split('.')[0]
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null
  }
}
