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
  type LlmConfig,
  type PoolSnapshot
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { SpeechPool } from './SpeechPool'
import type { PersonaService } from './PersonaService'

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

/** 池水位低于这个数就催主播补货（normal+filler 道未播条目） */
const LOW_WATER = 2
/** 补货/评论转发的最小间隔，避免把 LLM 打爆 */
const STEER_COOLDOWN_MS = 20_000
/** 主播的来源 id（话术池限流按来源算） */
const AGENT_SOURCE_ID = 'anchor'

export class AgentService {
  private session: AgentSession | null = null
  private state: AgentStatus['state'] = 'stopped'
  private error: string | undefined
  private modelLabel: string | undefined
  private draft = ''
  private busy = false
  private lastSteerAt = 0
  /** 最近一条待回应评论（insert_next 工具挂 replyTo 用） */
  private lastComment: LiveComment | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly pool: SpeechPool,
    private readonly persona: PersonaService,
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
    // 开场：让主播自己说开场白
    void this.ask(
      '直播开始了。用 say 工具来一段开场白，跟大家打个招呼、说说今天在播什么，然后按自己的节奏补 1-2 句常规话术。'
    )
  }

  async stop(): Promise<void> {
    const session = this.session
    this.session = null
    this.draft = ''
    this.lastComment = null
    if (session) {
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

  /** 评论入口（模拟器 / 后续 PipeSDK）：主播自己决定回不回、怎么回 */
  onComment(comment: LiveComment): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    this.lastComment = comment
    void this.ask(
      `[观众评论] ${comment.author} 说：「${comment.content}」\n` +
        '值得回应就用 insert_next 回一句（口语、简短）；不值得回应就忽略它，继续你的节奏。'
    )
  }

  /** 池快照驱动（M3 简化版节奏）：normal+filler 道未播存货不足时催主播补货 */
  onPoolSnapshot(snapshot: PoolSnapshot): void {
    if (!this.session || (this.state !== 'running' && this.state !== 'error')) return
    const stock = snapshot.items.filter(
      (item) => (item.lane === 'normal' || item.lane === 'filler') && item.status !== 'playing'
    ).length
    if (stock >= LOW_WATER) return
    if (Date.now() - this.lastSteerAt < STEER_COOLDOWN_MS) return
    this.lastSteerAt = Date.now()
    void this.ask(
      '话术池里存货不多了。用 say 工具补 1-2 句常规话术（讲讲产品、聊聊日常、做做互动都行），别和最近播过的重复。'
    )
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
      // 只启用池操作工具（allowlist 逐项点名，内置编码工具一个不留）
      customTools: this.buildTools(),
      tools: ['say', 'insert_next', 'get_pool_status', 'get_recent_played'],
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

  /** 池操作工具（docs/01 §3.3 的 M3 子集）：say / insert_next / get_pool_status / get_recent_played */
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
      })
    ]
  }
}
