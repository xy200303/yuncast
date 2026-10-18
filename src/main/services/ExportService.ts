import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statfsSync, statSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { app } from 'electron'
import type {
  ProgramExportFormat,
  ProgramExportOptions,
  ProgramExportPlan,
  ProgramExportProgress,
  ProgramExportResult,
  SessionExportOptions,
  SessionExportResult
} from '../../shared/types'
import { listAudioUnits, type AudioUnit } from './programUnits'
import { getFfmpegPath } from './stream/ffmpeg/bin'
import type { StorageService } from './StorageService'
import type { ScriptService } from './ScriptService'

/** Windows 文件名非法字符（模板与节目名/段标题统一过滤） */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g

const DEFAULT_TEMPLATE = '{节目名}-{序号}-{段标题}'

/** 响度归一（一遍法 loudnorm；第一版不做两遍法 True Peak，docs/10 §8.3） */
const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

/** 单元可导出：ready + 指纹一致 + 文件真实存在（外部音频被移走按缺算，不静默跳过） */
function exportable(unit: AudioUnit): boolean {
  const rendered = unit.rendered
  return (
    rendered?.status === 'ready' &&
    rendered.sourceFingerprint === unit.fingerprint &&
    existsSync(rendered.audioPath)
  )
}

/** 缺音频原因（中文，缺章清单与错误反馈共用口径） */
function missingReason(unit: AudioUnit): string {
  const rendered = unit.rendered
  if (!rendered) return '还没合成'
  if (rendered.status === 'synthesizing') return '合成中'
  if (rendered.status === 'failed') return rendered.error || '合成失败'
  if (rendered.status === 'ready' && rendered.sourceFingerprint !== unit.fingerprint) {
    return '文稿已修改，音频与当前文稿不一致（需重新合成）'
  }
  if (rendered.status === 'stale') return '文稿已修改，音频与当前文稿不一致（需重新合成）'
  if (rendered.status === 'ready' && !existsSync(rendered.audioPath)) {
    return '音频文件不存在（可能被移动或清理）'
  }
  return '还没合成'
}

/** 过滤非法字符并收敛空白；空了给兜底名 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(ILLEGAL_CHARS, '_').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned || 'export'
}

/**
 * 节目音频导出（docs/10 §8.3/§15.17，P6）。
 * 数据源 = 节目单元的 rendered.audioPath（播放与导出复用同一批预制音频，不重新调 TTS）。
 * 第一版：全部章节、分章文件 / 合并为一个文件、MP3 / WAV、一遍法响度归一。
 * 同一时刻只跑一个导出任务；取消 = 杀 ffmpeg + 清临时文件，已产出的成品文件保留。
 */
export class ExportService {
  /** 逐单元进度广播（index.ts 接 IPC.programExportEvent） */
  onProgress: ((progress: ProgramExportProgress) => void) | null = null
  /** 进行中的任务（全局单任务；cancel 杀所有在跑的 ffmpeg 子进程） */
  private running: { cancelled: boolean; procs: Set<ChildProcess> } | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly script: ScriptService
  ) {}

  /** 取消进行中的导出；没有任务在跑返回 false */
  cancel(): boolean {
    if (!this.running) return false
    this.running.cancelled = true
    for (const proc of this.running.procs) proc.kill()
    return true
  }

  /**
   * 导出前的计划摘要（export_program 确认卡 / UI 弹窗缺章提示）：
   * 可导出与缺失单元的划分口径与导出本体完全一致。
   */
  describeExportPlan(programId: string): ProgramExportPlan {
    const program = this.storage.programList().find((p) => p.id === programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    if (program.broadcastMode !== 'prepared') {
      return { ok: false, error: '滚动/即兴节目的音频是边播边合成的运行态产物，没有节目级预制音频可导出；只有预制节目支持导出' }
    }
    const script = this.script.getScript(program.id)
    const units = listAudioUnits(program, script, this.storage.draftUnitList(programId))
    if (units.length === 0) return { ok: false, error: '节目还没有文稿，没有可导出的音频' }
    const missing: { title: string; reason: string }[] = []
    let totalBytes = 0
    for (const unit of units) {
      if (!exportable(unit)) {
        missing.push({ title: unit.title, reason: missingReason(unit) })
        continue
      }
      try {
        totalBytes += statSync(unit.rendered!.audioPath).size
      } catch {
        missing.push({ title: unit.title, reason: '音频文件不存在（可能被移动或清理）' })
      }
    }
    return { ok: true, total: units.length, ready: units.length - missing.length, missing, totalBytes }
  }

  /** 导出主流程：校验 → 逐单元转码/拷贝（或进临时目录再合并）→ 结束校验 → 清理临时文件 */
  async export(options: ProgramExportOptions): Promise<ProgramExportResult> {
    if (this.running) return { ok: false, error: '已有导出任务在进行，等它完成或先取消' }
    const program = this.storage.programList().find((p) => p.id === options.programId) ?? null
    if (!program) return { ok: false, error: '节目不存在' }
    if (program.broadcastMode !== 'prepared') {
      return { ok: false, error: '滚动/即兴节目的音频是边播边合成的运行态产物，没有节目级预制音频可导出；只有预制节目支持导出' }
    }
    const script = this.script.getScript(program.id)
    const allUnits = listAudioUnits(program, script, this.storage.draftUnitList(program.id))
    if (allUnits.length === 0) return { ok: false, error: '节目还没有文稿，没有可导出的音频' }

    // 缺音频默认阻断并列出缺哪些；显式「仅导出已完成部分」才放行（§15.5/§15.17，不静默跳过）
    const missing = allUnits.filter((unit) => !exportable(unit))
    if (missing.length > 0 && !options.onlyReady) {
      return {
        ok: false,
        error:
          `还有 ${missing.length} 个单元缺音频：\n` +
          missing.map((unit) => `- ${unit.title}（${missingReason(unit)}）`).join('\n') +
          '\n补齐合成，或勾选「仅导出已完成部分」'
      }
    }
    const units = allUnits.filter((unit) => exportable(unit))
    if (units.length === 0) return { ok: false, error: '没有已完成可导出的单元' }

    // 输出目录：空 = Agent 路径的默认目录（UI 路径由 IPC 层先弹目录选择框，传进来的必然非空）
    const outputDir = options.outputDir.trim() || this.defaultOutputDir(program.name)
    try {
      await mkdir(outputDir, { recursive: true })
      const probe = join(outputDir, `.export-probe-${Date.now()}`)
      await writeFile(probe, '')
      await rm(probe, { force: true })
    } catch {
      return { ok: false, error: `输出目录不可写：${outputDir}（换个目录，或检查磁盘权限）` }
    }

    // 磁盘空间预估：源总大小 ×系数（分章≈成品一份；合并≈临时转码一份+成品一份）
    let totalBytes = 0
    for (const unit of units) {
      try {
        totalBytes += statSync(unit.rendered!.audioPath).size
      } catch {
        return { ok: false, error: `音频文件不存在（可能刚被移动）：${unit.title}` }
      }
    }
    try {
      const fsInfo = statfsSync(outputDir)
      const freeBytes = fsInfo.bavail * fsInfo.bsize
      const needBytes = Math.ceil(totalBytes * (options.mode === 'merged' ? 2.5 : 1.5))
      if (freeBytes < needBytes) {
        return {
          ok: false,
          error:
            `磁盘空间不足：预计需要约 ${formatBytes(needBytes)}，可用只有 ${formatBytes(freeBytes)}。` +
            '清理磁盘或换个输出目录'
        }
      }
    } catch {
      // statfs 不可用的平台跳过预检（写失败时 ffmpeg/拷贝会报明确错误）
    }

    // 导出期间源音频被重新合成的检测（§15.17）：记录各单元指纹 + 文件 mtime，结束时校验
    const snapshot = new Map(
      units.map((unit) => [
        unit.id,
        { fingerprint: unit.fingerprint, mtimeMs: statSync(unit.rendered!.audioPath).mtimeMs }
      ])
    )

    const task = { cancelled: false, procs: new Set<ChildProcess>() }
    this.running = task
    const files: string[] = []
    // 合并导出的临时文件放输出目录下 .export-tmp-*：成功/失败/取消都清理
    const tmpDir =
      options.mode === 'merged'
        ? join(outputDir, `.export-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
        : null
    const emit = (progress: ProgramExportProgress) => this.onProgress?.(progress)
    try {
      if (tmpDir) await mkdir(tmpDir, { recursive: true })
      const total = units.length
      // 2 路并行转码：ffmpeg 是 CPU 活，双 worker 接近翻倍；merged 模式临时文件按序号命名，合并顺序不变
      const produced: (string | null)[] = new Array<string | null>(total).fill(null)
      // 分章模式文件名占位登记：两个 worker 同时算 uniquePath 可能撞名（existsSync 之间有空窗）
      const reserved = new Set<string>()
      const reservePath = (index: number, unit: AudioUnit): string => {
        const base =
          this.applyTemplate(options.fileNameTemplate || DEFAULT_TEMPLATE, program.name, index, unit) +
          '.' +
          options.format
        const ext = extname(base)
        const stem = basename(base, ext)
        let candidate = join(outputDir, base)
        for (let n = 2; existsSync(candidate) || reserved.has(candidate); n++) {
          candidate = join(outputDir, `${stem}-${n}${ext}`)
        }
        reserved.add(candidate)
        return candidate
      }
      let next = 0
      let completed = 0
      let firstError: unknown = null
      const worker = async (): Promise<void> => {
        while (!task.cancelled && !firstError) {
          const i = next
          next += 1
          if (i >= total) return
          const unit = units[i]
          emit({ programId: program.id, status: 'running', current: completed + 1, total, title: unit.title })
          // 导出中途外部音频被移走：逐单元再查一次，不静默跳过
          if (!existsSync(unit.rendered!.audioPath)) {
            firstError = new Error(`「${unit.title}」的音频文件在导出过程中不见了（可能被移动或清理），已中止`)
            return
          }
          const dest = tmpDir
            ? join(tmpDir, `${String(i).padStart(3, '0')}.${options.format}`)
            : reservePath(i, unit)
          try {
            await this.processUnit(task, unit.rendered!.audioPath, dest, options.format, options.loudness)
          } catch (error) {
            if (!firstError) firstError = error
            return
          }
          produced[i] = dest
          completed += 1
        }
      }
      await Promise.all([worker(), worker()])
      if (!tmpDir) for (const file of produced) if (file) files.push(file)
      if (firstError) throw firstError
      if (task.cancelled) {
        emit({ programId: program.id, status: 'cancelled', current: 0, total, title: '' })
        return {
          ok: false,
          cancelled: true,
          outputDir,
          files,
          error:
            files.length > 0
              ? `已取消：已产出的 ${files.length} 个文件保留在输出目录`
              : '已取消：还没有产出文件'
        }
      }
      if (tmpDir) {
        emit({ programId: program.id, status: 'running', current: total, total, title: '合并为一个文件' })
        const merged = this.uniquePath(outputDir, sanitizeFileName(program.name) + '.' + options.format)
        await this.concatUnits(task, units.map((_, i) => join(tmpDir, `${String(i).padStart(3, '0')}.${options.format}`)), merged)
        files.push(merged)
      }

      // 结束校验：指纹或 mtime 变了 → 警告但不算失败（结果可能混着新旧音频）
      const staleHits: string[] = []
      const freshUnits = listAudioUnits(program, this.script.getScript(program.id), this.storage.draftUnitList(program.id))
      const freshById = new Map(freshUnits.map((unit) => [unit.id, unit]))
      for (const unit of units) {
        const before = snapshot.get(unit.id)!
        const after = freshById.get(unit.id)
        const mtimeChanged =
          existsSync(unit.rendered!.audioPath) && statSync(unit.rendered!.audioPath).mtimeMs !== before.mtimeMs
        if (!after || after.fingerprint !== before.fingerprint || mtimeChanged) staleHits.push(unit.title)
      }
      const warning =
        staleHits.length > 0
          ? `导出期间有 ${staleHits.length} 个单元的音频被更新（${staleHits.slice(0, 3).join('、')}${staleHits.length > 3 ? ' 等' : ''}），结果可能不一致，建议重新导出`
          : undefined
      emit({ programId: program.id, status: 'done', current: total, total, title: '' })
      return { ok: true, outputDir, files, warning }
    } catch (error) {
      const message =
        task.cancelled ? '已取消' : error instanceof Error ? error.message : String(error)
      emit({ programId: program.id, status: task.cancelled ? 'cancelled' : 'error', current: 0, total: units.length, title: '', error: message })
      return {
        ok: false,
        cancelled: task.cancelled || undefined,
        outputDir,
        files,
        error: files.length > 0 ? `${message}（已产出的 ${files.length} 个文件保留）` : message
      }
    } finally {
      this.running = null
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * 场记导出：一场实际播出的音频按播放顺序导出（与节目导出同一套 ffmpeg 管线）。
   * 数据源 = pool_items 里 session_id 指向这场、播过（done/interrupted）且音频文件还在的条目；
   * 流式播报不落文件，跳过并在结果里明示条数；loop 重播的同一份音频按播出次数重复收录（现场事实）。
   */
  async exportSession(options: SessionExportOptions): Promise<SessionExportResult> {
    if (this.running) return { ok: false, error: '已有导出任务在进行，等它完成或先取消' }
    const session = this.storage.sessionGet(options.sessionId)
    if (!session) return { ok: false, error: '场次不存在（可能刚被删除）' }
    const played = this.storage
      .sessionSpeechItems(session.id)
      .filter((item) => item.status === 'done' || item.status === 'interrupted')
    const sources: { path: string; title: string }[] = []
    for (const item of played) {
      if (item.audioPath && existsSync(item.audioPath)) {
        sources.push({ path: item.audioPath, title: item.text.slice(0, 20) })
      }
    }
    const skippedStream = played.length - sources.length
    if (sources.length === 0) {
      return { ok: false, error: '这场没有可导出的播出音频（流式播报不落文件，只有合成音频能导出）', skippedStream }
    }

    const outputDir = options.outputDir.trim()
    if (!outputDir) return { ok: false, error: '还没选输出目录' }
    try {
      await mkdir(outputDir, { recursive: true })
      const probe = join(outputDir, `.export-probe-${Date.now()}`)
      await writeFile(probe, '')
      await rm(probe, { force: true })
    } catch {
      return { ok: false, error: `输出目录不可写：${outputDir}（换个目录，或检查磁盘权限）` }
    }

    // 文件名：{节目名}-{开播日期时间}[-{序号}]；分章模式按播出顺序编号
    const stamp = new Date(session.startedAt)
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const stem =
      `${sanitizeFileName(session.programName)}-` +
      `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`

    const task = { cancelled: false, procs: new Set<ChildProcess>() }
    this.running = task
    const files: string[] = []
    const tmpDir =
      options.mode === 'merged'
        ? join(outputDir, `.export-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
        : null
    const emit = (progress: ProgramExportProgress) => this.onProgress?.(progress)
    try {
      if (tmpDir) await mkdir(tmpDir, { recursive: true })
      const total = sources.length
      const produced: (string | null)[] = new Array<string | null>(total).fill(null)
      const reserved = new Set<string>()
      const reservePath = (index: number): string => {
        const base = `${stem}-${pad(index + 1, 3)}.${options.format}`
        let candidate = join(outputDir, base)
        for (let n = 2; existsSync(candidate) || reserved.has(candidate); n++) {
          candidate = join(outputDir, `${stem}-${pad(index + 1, 3)}-${n}.${options.format}`)
        }
        reserved.add(candidate)
        return candidate
      }
      let next = 0
      let completed = 0
      let firstError: unknown = null
      const worker = async (): Promise<void> => {
        while (!task.cancelled && !firstError) {
          const i = next
          next += 1
          if (i >= total) return
          const src = sources[i]
          emit({ programId: session.id, status: 'running', current: completed + 1, total, title: src.title })
          if (!existsSync(src.path)) {
            firstError = new Error('播出音频在导出过程中不见了（可能被清理），已中止')
            return
          }
          const dest = tmpDir ? join(tmpDir, `${String(i).padStart(3, '0')}.${options.format}`) : reservePath(i)
          try {
            await this.processUnit(task, src.path, dest, options.format, options.loudness)
          } catch (error) {
            if (!firstError) firstError = error
            return
          }
          produced[i] = dest
          completed += 1
        }
      }
      await Promise.all([worker(), worker()])
      if (!tmpDir) for (const file of produced) if (file) files.push(file)
      if (firstError) throw firstError
      if (task.cancelled) {
        emit({ programId: session.id, status: 'cancelled', current: 0, total, title: '' })
        return {
          ok: false,
          cancelled: true,
          outputDir,
          files,
          skippedStream,
          error: files.length > 0 ? `已取消：已产出的 ${files.length} 个文件保留在输出目录` : '已取消：还没有产出文件'
        }
      }
      if (tmpDir) {
        emit({ programId: session.id, status: 'running', current: total, total, title: '合并为一个文件' })
        const merged = this.uniquePath(outputDir, `${stem}.${options.format}`)
        await this.concatUnits(task, sources.map((_, i) => join(tmpDir, `${String(i).padStart(3, '0')}.${options.format}`)), merged)
        files.push(merged)
      }
      emit({ programId: session.id, status: 'done', current: total, total, title: '' })
      return { ok: true, outputDir, files, skippedStream }
    } catch (error) {
      const message = task.cancelled ? '已取消' : error instanceof Error ? error.message : String(error)
      emit({ programId: session.id, status: task.cancelled ? 'cancelled' : 'error', current: 0, total: sources.length, title: '', error: message })
      return {
        ok: false,
        cancelled: task.cancelled || undefined,
        outputDir,
        files,
        skippedStream,
        error: files.length > 0 ? `${message}（已产出的 ${files.length} 个文件保留）` : message
      }
    } finally {
      this.running = null
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** 文件名模板替换：{节目名} {序号}（两位） {段标题}，再过滤非法字符 */
  private applyTemplate(template: string, programName: string, index: number, unit: AudioUnit): string {
    const applied = template
      .replaceAll('{节目名}', programName)
      .replaceAll('{序号}', String(index + 1).padStart(2, '0'))
      .replaceAll('{段标题}', unit.title)
    return sanitizeFileName(applied)
  }

  /** 重名不覆盖：自动加 -2 -3 后缀 */
  private uniquePath(dir: string, fileName: string): string {
    const ext = extname(fileName)
    const stem = basename(fileName, ext)
    let candidate = join(dir, fileName)
    for (let n = 2; existsSync(candidate); n++) {
      candidate = join(dir, `${stem}-${n}${ext}`)
    }
    return candidate
  }

  /**
   * 单单元产出：源格式与目标一致且不做响度归一时直接拷贝提速；否则 ffmpeg 转码
   * （数组参数不用 shell，Windows 空格路径安全）。
   */
  private async processUnit(
    task: { cancelled: boolean; procs: Set<ChildProcess> },
    src: string,
    dest: string,
    format: ProgramExportFormat,
    loudness: boolean
  ): Promise<void> {
    const srcExt = extname(src).slice(1).toLowerCase()
    if (srcExt === format && !loudness) {
      await copyFile(src, dest)
      return
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src]
    if (loudness) args.push('-af', LOUDNORM_FILTER, '-ar', '44100')
    if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2')
    else args.push('-c:a', 'pcm_s16le')
    args.push(dest)
    await this.runFfmpeg(task, args, dest)
  }

  /** 合并：临时产物已统一成同编码，concat demuxer 流拷贝；拷不动（罕见）时重编码兜底 */
  private async concatUnits(
    task: { cancelled: boolean; procs: Set<ChildProcess> },
    inputs: string[],
    dest: string
  ): Promise<void> {
    const listPath = join(dirname(inputs[0]), 'concat-list.txt')
    const content = inputs.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
    await writeFile(listPath, content, 'utf8')
    const format = extname(dest).slice(1).toLowerCase() as ProgramExportFormat
    try {
      try {
        await this.runFfmpeg(
          task,
          ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'copy', dest],
          dest
        )
      } catch (error) {
        if (task.cancelled) throw error
        await rm(dest, { force: true }).catch(() => undefined)
        const reencode = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath]
        if (format === 'mp3') reencode.push('-c:a', 'libmp3lame', '-q:a', '2')
        else reencode.push('-c:a', 'pcm_s16le')
        reencode.push(dest)
        await this.runFfmpeg(task, reencode, dest)
      }
    } finally {
      await rm(listPath, { force: true }).catch(() => undefined)
    }
  }

  /** 跑一次 ffmpeg：记录子进程供 cancel 杀；退出码非 0 或产物缺失 → 抛中文错误（取 stderr 首行） */
  private async runFfmpeg(
    task: { cancelled: boolean; procs: Set<ChildProcess> },
    args: string[],
    outPath: string
  ): Promise<void> {
    let proc: ChildProcess | null = null
    const result = await new Promise<{ code: number; stderr: string }>((resolvePromise) => {
      proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
      task.procs.add(proc)
      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      proc.on('error', (error) => resolvePromise({ code: -1, stderr: String(error) }))
      proc.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }))
    })
    if (proc) task.procs.delete(proc)
    if (task.cancelled) {
      await rm(outPath, { force: true }).catch(() => undefined)
      throw new Error('已取消')
    }
    if (result.code !== 0 || !existsSync(outPath)) {
      await rm(outPath, { force: true }).catch(() => undefined)
      const detail = result.stderr.trim().split('\n').filter(Boolean)[0]
      throw new Error(detail ? `ffmpeg 处理失败：${detail}` : `ffmpeg 退出码 ${result.code}`)
    }
  }

  /** Agent 路径的默认输出目录（UI 路径由弹窗选目录，走不到这里） */
  private defaultOutputDir(programName: string): string {
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return join(
      app.getPath('userData'),
      'exports',
      `${sanitizeFileName(programName)}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
    )
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.ceil(bytes / 1024 / 1024)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}
