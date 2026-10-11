import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  LLM_PROVIDER_META,
  llmConfigured,
  type AgentStatus,
  type LiveComment,
  type LlmConfig
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { SpeechPool } from './SpeechPool'
import type { PersonaService } from './PersonaService'
import type { KnowledgeService } from './KnowledgeService'
import type { MemoryService } from './MemoryService'

/**
 * 主播 Agent（docs/01 §3.1 单脑架构）：唯一话术生产者。
 * - pi-agent SDK 路线：createAgentSession，资源目录全部重定向到 userData/pi（不碰 ~/.pi）
 * - 关掉全部内置编码工具，只挂池操作自定义工具（一切声音走话术池，Agent 不直接碰 TTS）
 * - 凭据运行时注入 ModelRuntime，不落 pi 的盘；我们的 config 里 safeStorage 加密
 * - text_delta 累积成"AI 正在组织语言"预览广播给渲染进程，入池（工具执行）即清
 */

/** pi 内置服务商映射；qwen/doubao 走 OpenAI 兼容，写进 models.json */
const BUILTIN_PROVIDERS: Partial<Record<LlmConfig['provider'], string>> = {
  deepseek: 'deepseek',
  kimi: 'moonshotai-cn',
  zai: 'zai'
}

/** 主播的来源 id（话术池限流按来源算） */
const AGENT_SOURCE_ID = 'anchor'

export class AgentService {
  private session: AgentSession | null = null
  private state: AgentStatus['state'] = 'stopped'
  private error: string | undefined
  private modelLabel: string | undefined
  private draft = ''
  private busy = false
  /** 最近一条待回应评论（insert_next 工具挂 replyTo 用） */
  private lastComment: LiveComment | null = null
  /** 本场开播时间（下播总结用） */
  private startedAt = 0
  /** 本场发生过几轮对话（没对话就不写总结） */
  private exchanges = 0

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly broadcast: (status: AgentStatus) => void
  ) {}

  status(): AgentStatus {
    return {
      state: this.state,
      error: this.error,
      model: this.modelLabel,
      personaName: this.state === 'stopped' ? undefined : this.persona.get().name,
      draft: this.draft
    }
  }

  /** 启动主播会话。未配置 LLM 时抛清晰中文错误（UI 弹 toast + 引导去设置页）。 */
  async start(): Promise<void> {
    if (this.session) return
    const llm = this.storage.getConfig().llm
    if (!llmConfigured(llm)) {
      throw new Error('LLM 未配置：先到「设置 → 接入」填 API Key 和模型')
    }
    this.setState('starting')
    try {
      this.session = await this.createSession(llm)
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.setState('running')
    this.startedAt = Date.now()
    this.exchanges = 0
    // 开场白由「开场白」触发器（stream.started → task）负责，见 TriggerRuntime
  }

  async stop(): Promise<void> {
    const session = this.session
    this.session = null
    this.draft = ''
    this.lastComment = null
    if (session) {
      // 下播总结：本场有过对话就让主播自我复盘，写进场次摘要（本场记忆）
      if (this.exchanges > 0 && this.state === 'running') {
        await this.summarizeEpisode(session).catch(() => undefined)
      }
      try {
        await session.abort()
      } catch {
        // 停止时 abort 失败不影响关闭
      }
      session.dispose()
    }
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** 评论入口（模拟器 / 后续 PipeSDK）：主播自己决定回不回、怎么回。老粉画像随评论注入。 */
  onComment(comment: LiveComment): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    // 先查画像（老粉识别），再记一次互动
    const known = this.memory.lookupViewer(comment.author)
    const isQuestion = /[?？]$/.test(comment.content.trim())
    this.memory.touchViewer(comment.author, isQuestion ? comment.content : undefined)
    this.lastComment = comment
    const profileHint = known
      ? `\n[老粉画像] ${comment.author}：${this.memory.describeViewer(known)}`
      : '\n[新观众] 没见过这位观众'
    void this.ask(
      `[观众评论] ${comment.author} 说：「${comment.content}」${profileHint}\n` +
        '值得回应就用 insert_next 回一句（口语、简短）；答不上来的商品信息先用 search_knowledge / check_price 查；' +
        '聊出值得记住的偏好就顺手 remember_viewer 记一笔；不值得回应就忽略它，继续你的节奏。'
    )
  }

  /** 触发器入口（docs/01 §3.5）：steer=生成中插一句，task=派一个任务。主播没在跑就丢弃。 */
  inject(text: string, mode: 'steer' | 'task'): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    if (mode === 'steer' && this.busy) {
      try {
        this.session.steer(text)
      } catch (error) {
        console.error('[AgentAnchor] steer 失败:', error)
      }
      return
    }
    void this.ask(text)
  }

  /** 急停（配合 renderer 停播放 + 清池）：停会话即可，池由调用方清 */
  async panic(): Promise<void> {
    await this.stop()
  }

  // ---------- 内部 ----------

  private setState(state: AgentStatus['state'], error?: string): void {
    this.state = state
    this.error = error
    if (state !== 'running') this.draft = ''
    this.broadcast(this.status())
  }

  /** 给主播派一句话：生成中走 steer 插队，空闲走 prompt；失败记状态不崩溃 */
  private async ask(text: string): Promise<void> {
    const session = this.session
    if (!session) return
    try {
      if (this.busy) {
        session.steer(text)
        return
      }
      this.busy = true
      this.exchanges += 1
      await session.prompt(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[AgentAnchor] 主播 Agent 调用失败:', message)
      this.setState('error', `LLM 调用失败：${message.slice(0, 200)}`)
      // 会话还活着就留着重试（下一条评论/水位催补会再试），不要一报错就死透
    } finally {
      this.busy = false
    }
  }

  /** 下播总结：让主播自我复盘本场亮点/高频问题，写入 episode_summaries。失败静默，不挡下播。 */
  private async summarizeEpisode(session: AgentSession): Promise<void> {
    const endedAt = Date.now()
    await Promise.race([
      (async () => {
        await session.waitForIdle()
        await session.prompt(
          '直播结束了。不要用任何工具，直接用一段话复盘本场：亮点、翻车、观众高频问题，120 字以内。'
        )
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('总结超时')), 30_000))
    ])
    const summary = session.getLastAssistantText()?.trim()
    if (summary) this.memory.saveEpisodeSummary(this.startedAt, endedAt, summary)
  }

  private async createSession(llm: LlmConfig): Promise<AgentSession> {
    const agentDir = join(app.getPath('userData'), 'pi')
    mkdirSync(agentDir, { recursive: true })

    const meta = LLM_PROVIDER_META[llm.provider]
    const providerId = BUILTIN_PROVIDERS[llm.provider] ?? llm.provider
    const modelId = llm.model || meta.defaultModel
    const baseUrl = llm.baseUrl.trim() || meta.defaultBaseUrl

    // qwen/doubao 是 pi 不内置的 OpenAI 兼容端点，写 models.json 自定义 provider；
    // 内置服务商自定义了 baseUrl 时也写 provider 级覆盖。
    const isBuiltin = llm.provider in BUILTIN_PROVIDERS
    const needModelsJson = !isBuiltin || baseUrl !== meta.defaultBaseUrl
    const modelsPath = join(agentDir, 'models.json')
    if (needModelsJson) {
      const providerEntry: Record<string, unknown> = isBuiltin
        ? { baseUrl }
        : { baseUrl, api: 'openai-completions', models: [{ id: modelId }] }
      writeFileSync(
        modelsPath,
        JSON.stringify({ providers: { [providerId]: providerEntry } }, null, 2),
        'utf8'
      )
    } else {
      // 配置回退到默认时清掉旧的自定义文件，避免残留旧端点
      writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), 'utf8')
    }

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath
    })
    // 凭据运行时注入，不落 pi 的 auth.json
    await modelRuntime.setRuntimeApiKey(providerId, llm.apiKey)

    const model = modelRuntime.getModel(providerId, modelId)
    if (!model) {
      throw new Error(`模型不可用：${providerId}/${modelId}（检查设置页的模型名）`)
    }
    this.modelLabel = `${meta.label} · ${modelId}`

    const persona = this.persona.get()
    const systemPrompt = this.persona.buildSystemPrompt(persona, this.storage.getConfig().tts.voiceId)

    // 全自定义 ResourceLoader：不读 ~/.pi，不发现项目资源，system prompt 就是人设卡
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {}
    }

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      model,
      thinkingLevel: 'off',
      modelRuntime,
      resourceLoader,
      // 只启用主播工具（allowlist 逐项点名——M3 踩过坑：tools: [] 会连 customTools 一起清掉）
      customTools: this.buildTools(),
      tools: [
        'say',
        'insert_next',
        'get_pool_status',
        'get_recent_played',
        'search_knowledge',
        'check_price',
        'lookup_viewer',
        'remember_viewer'
      ],
      sessionManager: SessionManager.inMemory(agentDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } })
    })

    session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        // 生成中预览：累积 text_delta 广播给提词器
        this.draft += event.assistantMessageEvent.delta
        this.broadcast(this.status())
      } else if (event.type === 'tool_execution_start') {
        // 一句话说完入了池，清掉生成中预览
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      } else if (event.type === 'agent_end') {
        // prompt() 在 LLM 失败时也会正常 resolve——错误要看末条 assistant 消息的 stopReason
        const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant') as
          | { stopReason?: string; errorMessage?: string }
          | undefined
        if (lastAssistant?.stopReason === 'error') {
          const detail = lastAssistant.errorMessage ?? '未知错误'
          console.error('[AgentAnchor] 主播 Agent 调用失败:', detail)
          this.setState('error', `LLM 调用失败：${detail.slice(0, 200)}`)
        } else if (this.state === 'error') {
          this.setState('running')
        }
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      } else if (event.type === 'agent_settled') {
        if (this.draft) {
          this.draft = ''
          this.broadcast(this.status())
        }
      }
    })

    return session
  }

  /** 主播工具（docs/01 §3.3）：池操作 + 知识库/价格护栏 + 观众记忆 */
  private buildTools(): ToolDefinition[] {
    const pool = this.pool
    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })
    const guardTool = (fn: () => string) => {
      try {
        return ok(fn())
      } catch (error) {
        // 池的护栏错误（满/限流）如实告诉主播，让它换策略而不是崩溃
        return ok(`操作被拒绝：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return [
      defineTool({
        name: 'say',
        label: '说一句',
        description: '说一句常规话术，排进话术池队列等待播出。每次只说一句完整的话（40 字以内最佳），口语化。',
        parameters: Type.Object({
          text: Type.String({ description: '要说的话，一句' }),
          voice: Type.Optional(Type.String({ description: '音色 id，不传用默认音色' }))
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            pool.say({
              text: params.text,
              voiceId: params.voice,
              sourceAgentId: AGENT_SOURCE_ID,
              sourceKind: 'scene'
            })
            return `已排进队列：「${params.text}」`
          })
      }),
      defineTool({
        name: 'insert_next',
        label: '插播一句',
        description: '插播一句话：当前正在播的内容播完后立即播这条。只在回复观众评论或紧急情况使用。',
        parameters: Type.Object({
          text: Type.String({ description: '要插播的话，一句' }),
          voice: Type.Optional(Type.String({ description: '音色 id，不传用默认音色' }))
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            const replyTo = this.lastComment
              ? { commentId: this.lastComment.id, author: this.lastComment.author }
              : undefined
            pool.insertNext({
              text: params.text,
              voiceId: params.voice,
              sourceAgentId: AGENT_SOURCE_ID,
              sourceKind: 'reply',
              replyTo
            })
            return `已插播：「${params.text}」`
          })
      }),
      defineTool({
        name: 'get_pool_status',
        label: '查看话术池状态',
        description: '查看话术池水位：各车道未播条数、正在播什么。队列快空了就主动补货。',
        parameters: Type.Object({}),
        execute: async () =>
          guardTool(() => {
            const status = pool.getStatus()
            return JSON.stringify({
              未播总数: status.active,
              分车道: status.byLane,
              正在播: status.playing?.text ?? null
            })
          })
      }),
      defineTool({
        name: 'get_recent_played',
        label: '回看最近播过的话',
        description: '回看最近播出的 n 条话术，避免重复和自相矛盾。',
        parameters: Type.Object({
          n: Type.Optional(Type.Number({ description: '条数，默认 5', default: 5 }))
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            const played = pool.getRecentPlayed(params.n ?? 5)
            if (played.length === 0) return '还没有播过任何话术'
            return played.map((item, i) => `${i + 1}. ${item.text}`).join('\n')
          })
      }),
      defineTool({
        name: 'search_knowledge',
        label: '查知识库',
        description: '检索商品资料和上传的知识文件（卖点/FAQ/资料描述）。观众问到商品细节先查再答，不要凭印象编。',
        parameters: Type.Object({
          query: Type.String({ description: '检索关键词，比如商品名、材质、功效' }),
          limit: Type.Optional(Type.Number({ description: '返回条数，默认 3', default: 3 }))
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            const hits = this.knowledge.searchKnowledge(params.query, params.limit ?? 3)
            if (hits.length === 0) return '知识库里没有相关内容，别编，含糊带过或引导观众看小黄车'
            return hits
              .map(
                (hit, i) =>
                  `${i + 1}. [${hit.source === 'product' ? '商品' : '资料'}] ${hit.name}` +
                  `${hit.price !== undefined ? `（¥${hit.price}）` : ''}\n${hit.snippet}`
              )
              .join('\n')
          })
      }),
      defineTool({
        name: 'check_price',
        label: '查价格（护栏）',
        description:
          '查商品价格。硬性规则：直播里报的任何价格/优惠数字必须来自这个工具的返回，查不到就说不确定，绝不许编造。',
        parameters: Type.Object({
          product: Type.Optional(Type.String({ description: '商品名（模糊匹配），不传返回全部商品价格表' }))
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            const rows = this.knowledge.checkPrice(params.product)
            if (rows.length === 0) return '没查到这个商品，价格不确定，不要在直播里报价'
            return rows.map((row) => `${row.name}：¥${row.price}`).join('\n')
          })
      }),
      defineTool({
        name: 'lookup_viewer',
        label: '查观众画像',
        description: '查一位观众的画像：互动次数、问过什么、你记过的偏好。用来认出老粉。',
        parameters: Type.Object({
          name: Type.String({ description: '观众昵称' })
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            const profile = this.memory.lookupViewer(params.name)
            if (!profile) return `${params.name} 是新观众，没有画像`
            return `${profile.name}：${this.memory.describeViewer(profile)}`
          })
      }),
      defineTool({
        name: 'remember_viewer',
        label: '记住观众',
        description: '给观众记一笔偏好/特征（比如「家里有小孩」「预算 200 以内」），下次他来直播你能认出他。',
        parameters: Type.Object({
          name: Type.String({ description: '观众昵称' }),
          note: Type.String({ description: '要记住的内容，一句话' })
        }),
        execute: async (_id, params) =>
          guardTool(() => {
            this.memory.rememberViewer(params.name, params.note)
            return `已记住 ${params.name}：${params.note}`
          })
      })
    ]
  }
}
