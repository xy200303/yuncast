import { CONTENT_TYPE_LABELS, DEFAULT_PERSONA, LEGACY_DEFAULT_PERSONA_FIELDS, type Persona, type Program, type Script } from '../../shared/types'
import { buildProgramPromptModule } from '../../shared/programPrompt'
import type { StorageService } from './StorageService'
import type { PromptTemplateService } from './PromptTemplateService'
import { resolveVoice } from './anchorTools'

/**
 * 人设卡服务（docs/01 §5 主播团）。
 * M3 只有一张卡：库里没有就播种默认卡；保存即更新，AgentService 重启会话后生效。
 * M6 起人设卡带 roles（编剧模式多音色角色）。
 */
export class PersonaService {
  constructor(
    private readonly storage: StorageService,
    private readonly prompts: PromptTemplateService
  ) {}

  /** 取当前人设卡，不存在就播种内置默认卡；内置卡的人设文本还是旧默认（用户没改过）则自动升级 */
  get(): Persona {
    const existing = this.storage.personaGet()
    if (existing) return this.upgradeLegacyDefault(existing)
    const seeded: Persona = {
      id: 'anchor-default',
      ...DEFAULT_PERSONA,
      updatedAt: Date.now()
    }
    this.storage.personaSave(seeded)
    return seeded
  }

  /**
   * 内置默认卡升级：personality/catchphrases/background/taboos 还跟旧版默认一字不差，
   * 说明用户只配了音色/模型、没动过人设文本——跟随代码升级到新默认；动过任何一个字都不碰。
   */
  private upgradeLegacyDefault(persona: Persona): Persona {
    const legacy = LEGACY_DEFAULT_PERSONA_FIELDS
    const untouched =
      persona.personality === legacy.personality &&
      persona.catchphrases === legacy.catchphrases &&
      persona.background === legacy.background &&
      persona.taboos === legacy.taboos
    if (!untouched) return persona
    const upgraded: Persona = {
      ...persona,
      personality: DEFAULT_PERSONA.personality,
      catchphrases: DEFAULT_PERSONA.catchphrases,
      background: DEFAULT_PERSONA.background,
      taboos: DEFAULT_PERSONA.taboos,
      updatedAt: Date.now()
    }
    this.storage.personaSave(upgraded)
    return upgraded
  }

  /** 主播团：全部人设卡 */
  list(): Persona[] {
    const list = this.storage.personaList()
    if (list.length > 0) return list
    this.get() // 空库播种默认卡
    return this.storage.personaList()
  }

  /** 保存：带 id 更新，不带则新建一张（新建即设为当前主播）。id 只认参数：input 里混进来的 id 不生效。
   *  expectedUpdatedAt：并发保护（docs/10 §10.3.5）——与库里的 updatedAt 不一致说明刚被别处改过，拒绝覆盖 */
  save(input: Omit<Persona, 'id' | 'updatedAt'>, id?: string, expectedUpdatedAt?: number): Persona {
    if (id && expectedUpdatedAt !== undefined) {
      const current = this.storage.personaList().find((p) => p.id === id)
      if (current && current.updatedAt !== expectedUpdatedAt) {
        throw new Error(
          `保存冲突：主播卡「${current.name}」在你读取后刚被改过（当前版本号 ${current.updatedAt}）。先重新读取，再带新的版本号重试，不要强行覆盖`
        )
      }
    }
    const isNew = !id
    const persona: Persona = {
      ...input,
      id: id ?? `anchor-${Date.now().toString(36)}`,
      updatedAt: Date.now()
    }
    this.storage.personaSave(persona)
    if (isNew) this.storage.personaSetActive(persona.id)
    return persona
  }

  /** 设为当前主播（AgentService 用这张卡） */
  setActive(id: string): Persona | null {
    this.storage.personaSetActive(id)
    return this.storage.personaGet()
  }

  /** 删除；删掉的是当前主播时自动改指到剩余的第一张 */
  remove(id: string): void {
    const wasActive = this.storage.personaGet()?.id === id
    this.storage.personaDelete(id)
    if (wasActive) {
      const rest = this.storage.personaList()
      const next = rest[0]
      if (next) this.storage.personaSetActive(next.id)
    }
  }

  /**
   * 本场生效的音色：人设卡默认音色 + 角色/显式覆盖（docs/07 §8.5）。
   * 音色归主播 agent 定——节目不再指定音色，预合成与开播装载共用同一判定。
   */
  resolveProgramVoice(role?: string, voice?: string): string | undefined {
    return resolveVoice(this.get(), role, voice)
  }

  /** 组装主播 Agent 的 system prompt：角色/节目段在代码里拼好，主模板走主播手册（system.anchor）。
   *  「本场节目」段的演法模块由节目 contentType + broadcastMode 生成（shared/programPrompt，怎么演由节目说，内容仍 agent 自编） */
  buildSystemPrompt(persona: Persona, program?: Program | null, script?: Script | null): string {
    const voice = persona.voiceId

    // 编剧模式的多角色能力只在「多人聊天/分角色表演」启用：一个人讲/照着稿子读时角色卡是反话——明确压住，别让它用 role 虚拟对话者
    const rolesEnabled = !program || program.contentType === 'conversation' || program.contentType === 'roleplay'
    const rolesSection =
      persona.roles.length > 0
        ? rolesEnabled
          ? `\n# 编剧模式（多角色台词）
你一个人写所有角色的台词。需要配合/对话/起哄时，用 say 的 role 参数写对应角色的台词，会按角色音色播出：
${persona.roles.map((r) => `- ${r.name}：${r.style}`).join('\n')}
别滥用：角色台词是调味料，主线还是你自己（${persona.name}）的节奏。`
          : `\n# 编剧模式（多角色台词）
你的人设卡里配置了角色（${persona.roles.map((r) => r.name).join('、')}），但本场是「${CONTENT_TYPE_LABELS[program!.contentType]}」——不要用 say 的 role 参数虚拟对话者，整场就你一个人（${persona.name}）的声音。`
        : ''

    const programSection = program
      ? `\n# 本场节目
- 节目：${program.name}
- 主题/节目说明：${program.theme || '（未设定，自由发挥）'}
${buildProgramPromptModule(program)}${this.programEventLines(program)}${
          script
            ? `
- 剧本场景序列（用 advance_scene 逐场推进，每场播得差不多就推进）：
${script.scenes.map((s, i) => `  ${i + 1}. ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}；要点：${s.keyPoints.replace(/\n/g, '；')}`).join('\n')}${
                program.broadcastMode === 'improvised'
                  ? ''
                  : program.finishMode === 'stop'
                    ? '\n- 播完策略：播完最后一场就收尾下播——把 closer 段 say 出去道别，本场不循环返场'
                    : '\n- 播完策略：播完一轮就循环返场——返场不返词，同一要点换故事换角度重新讲，别逐字复读'
              }`
            : '\n- 本节目没有绑定剧本，按主题自由发挥'
        }`
      : ''

    return this.prompts.render('system.anchor', {
      name: persona.name,
      personality: persona.personality,
      catchphrases: persona.catchphrases,
      background: persona.background,
      taboos: persona.taboos,
      voice: voice || '默认',
      voiceHint: voice ? '' : '（即不传）',
      rolesSection,
      programSection
    })
  }

  /**
   * 「本场节目」段的事件与声音安排（节目字段直述，主播不用猜）：
   * 互动开关、启用的自动化事件清单、节目自定义声音的生效边界（cast 只管预制音频，现场 say 仍走人设音色）。
   */
  private programEventLines(program: Program): string {
    const lines: string[] = []
    if (!program.allowLiveEvents) {
      lines.push('- 互动：本场不接直播间动态——不会有评论/礼物/进场送达，专心按主线讲，别等互动')
    }
    const triggerNames = program.enabledTriggerIds
      .map((id) => this.storage.triggerList().find((t) => t.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    if (triggerNames.length > 0) {
      lines.push(`- 本场启用的自动化事件：${triggerNames.join('、')}——它们触发时你会收到系统通知，照通知内容接`)
    } else if (!program.allowLiveEvents) {
      lines.push('- 本场没有任何外部事件进来：不接直播间动态，也没启用自动化事件，整场按主线走就行')
    }
    if (program.audioConfig.mode === 'custom') {
      lines.push(
        '- 声音安排：本场预制音频的声音由节目自定义配置（选角）决定；你现场 say 的内容仍用你自己的人设音色——节目选角对现场说话不生效'
      )
    }
    return lines.length > 0 ? `\n${lines.join('\n')}` : ''
  }
}
