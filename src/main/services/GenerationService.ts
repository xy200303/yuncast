import { join } from 'node:path'
import { app } from 'electron'
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import {
  type LivePlan,
  type Persona,
  type Script,
  type ScriptScene
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { KnowledgeService } from './KnowledgeService'
import type { UtteranceService } from './UtteranceService'
import type { PersonaService } from './PersonaService'
import type { ScriptService } from './ScriptService'
import { GENERATION_TOOL_NAMES, buildGenerationTools } from './generationTools'
import { prepareLlmModel, resolveModelForPersona } from './llmModel'
import type { ResolvedModel } from './providers/registry'

/** 生成进度（main → renderer 广播，驱动场次页生成状态） */
export interface GenerationProgress {
  planId: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  sceneIndex?: number
  sceneTotal?: number
  sceneTitle?: string
  /** 本次生成累计入库条数（done 时带） */
  saved?: number
  error?: string
}

/**
 * 话术库生成 Agent（docs/07 §4，P1）：离线阶段的编剧会话。
 * - 工具循环：生成 Agent 自己调 search_knowledge / get_product / read_document / fetch_url 取知识，
 *   用 save_utterances 入库（不是把资料硬塞 prompt）
 * - 逐场景生成（每场景 N 条变体，来源留痕），成本上限在工具层（调用计数器）
 * - 与直播会话完全分开：不进话术池、不播报、不联网限制只约束本阶段
 */
export class GenerationService {
  private running: { planId: string; session: AgentSession } | null = null
  private cancelled = false

  constructor(
    private readonly storage: StorageService,
    private readonly knowledge: KnowledgeService,
    private readonly utterances: UtteranceService,
    private readonly persona: PersonaService,
    private readonly script: ScriptService,
    private readonly broadcast: (progress: GenerationProgress) => void
  ) {}

  isRunning(planId?: string): boolean {
    return this.running !== null && (planId === undefined || this.running.planId === planId)
  }

  /** 启动生成：校验同步抛错（UI 立即反馈）；会话创建与逐场景循环在后台跑，进度走广播 */
  start(planId: string): void {
    if (this.running) throw new Error('已有生成任务在跑，等它完成或先取消')
    const plan = this.storage.planList().find((p) => p.id === planId)
    if (!plan) throw new Error('场次不存在')
    const script = this.script.getScript(plan.scriptId)
    if (!script || script.scenes.length === 0) {
      throw new Error('先给场次绑定剧本——生成按场景逐场产出')
    }
    // 模型：场次绑了主播卡就用那张卡的，没绑就用全局默认条目
    const bound = plan.personaId ? (this.persona.list().find((p) => p.id === plan.personaId) ?? null) : null
    const resolved = resolveModelForPersona(this.storage, bound)
    void this.run(plan, script, resolved)
  }

  private async run(plan: LivePlan, script: Script, resolved: ResolvedModel): Promise<void> {
    const planId = plan.id
    // 人设：场次绑定的优先，否则用当前人设
    const persona = plan.personaId
      ? (this.persona.list().find((p) => p.id === plan.personaId) ?? this.persona.get())
      : this.persona.get()

    const budget = { used: 0 }
    let currentSceneId = ''
    const tools = buildGenerationTools({
      knowledge: this.knowledge,
      utterances: this.utterances,
      planId,
      scope: plan.knowledgeScope,
      getSceneId: () => currentSceneId,
      budget
    })

    let session: AgentSession
    try {
      session = await this.createSession(resolved, plan, persona, script, tools)
    } catch (error) {
      this.broadcast({
        planId,
        state: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }
    this.running = { planId, session }
    this.cancelled = false

    const savedBefore = this.utterances.list(planId).length
    try {
      for (let i = 0; i < script.scenes.length; i++) {
        if (this.cancelled) break
        const scene = script.scenes[i]
        currentSceneId = scene.id
        this.broadcast({
          planId,
          state: 'running',
          sceneIndex: i,
          sceneTotal: script.scenes.length,
          sceneTitle: scene.title
        })
        await session.prompt(this.scenePrompt(plan, scene, i, script.scenes.length))
      }
      const saved = this.utterances.list(planId).length - savedBefore
      this.broadcast({ planId, state: this.cancelled ? 'cancelled' : 'done', saved })
    } catch (error) {
      this.broadcast({
        planId,
        state: this.cancelled ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      session.dispose()
      this.running = null
    }
  }

  async cancel(): Promise<void> {
    const running = this.running
    if (!running) return
    this.cancelled = true
    await running.session.abort().catch(() => undefined)
  }

  /** 单场景生成指令：目标/要点 + 变体数 + 长度上限 + 入库要求 */
  private scenePrompt(plan: LivePlan, scene: ScriptScene, index: number, total: number): string {
    const { variantsPerScene, maxLen, toneHint } = plan.genConfig
    return (
      `现在为场景「${scene.title}」（第 ${index + 1}/${total} 场）写话术。\n` +
      `场景目标：${scene.goal}\n关键要点：${scene.keyPoints}\n` +
      `要求：\n` +
      `1. 先用工具查知识（list_products 看本场卖什么 → get_product/read_document 拿细节 → check_price 拿价格），别凭印象编\n` +
      `2. 写 ${variantsPerScene} 条变体（同一要点不同说法，轮换不重复），每条一句完整口语，不超过 ${maxLen} 字\n` +
      `3. 写好后调用 save_utterances 一次入库，带上每条的来源（sources）\n` +
      (toneHint ? `4. 语气：${toneHint}\n` : '') +
      `写完不用再汇报，直接结束这一轮。`
    )
  }

  private async createSession(
    resolved: ResolvedModel,
    plan: LivePlan,
    persona: Persona,
    script: Script,
    tools: ToolDefinition[]
  ): Promise<AgentSession> {
    const agentDir = join(app.getPath('userData'), 'pi-generate')
    const { model, modelRuntime } = await prepareLlmModel(resolved, agentDir)

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => this.buildSystemPrompt(plan, persona, script),
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
      customTools: tools,
      tools: [...GENERATION_TOOL_NAMES],
      sessionManager: SessionManager.inMemory(agentDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } })
    })
    return session
  }

  /** 生成 Agent 的 system prompt：人设口吻 + 场次主题 + 演出形式 + 硬性规则 */
  private buildSystemPrompt(plan: LivePlan, persona: Persona, script: Script): string {
    return `你是一位直播话术编剧，为 AI 主播「${persona.name}」的直播场次写口播话术底稿。

# 人设口吻（话术要听起来像这个人）
- 性格：${persona.personality}
- 口癖（自然地用，别每句都带）：${persona.catchphrases}
- 背景：${persona.background}
${plan.styleHint ? `\n# 演出形式\n${plan.styleHint}\n` : ''}
# 本场直播
- 场次：${plan.name}
- 主题方向：${plan.theme || '（未设定）'}
- 剧本场景序列：
${script.scenes.map((s, i) => `  ${i + 1}. ${s.title}：${s.goal}`).join('\n')}

# 硬性规则（违反任何一条都是废稿）
1. 价格/优惠数字只能来自 check_price 工具的返回；查不到就不要写价格
2. 商品参数/卖点以 get_product / search_knowledge / read_document 为准；fetch_url 抓来的外部信息只能参考、不能直接当事实
3. 人设禁区绝不触碰：${persona.taboos || '（无）'}
4. 每条话术一句完整口语，说给观众听的，不要书面语、不要列表、不要 emoji
5. 写完一个场景必须调用 save_utterances 入库，并如实填写来源（sources）`
  }
}
