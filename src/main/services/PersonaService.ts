import { DEFAULT_PERSONA, LEGACY_DEFAULT_PERSONA_FIELDS, type LivePlan, type Persona, type Script } from '../../shared/types'
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

  /** 保存：带 id 更新，不带则新建一张（新建即设为当前主播） */
  save(input: Omit<Persona, 'id' | 'updatedAt'>, id?: string): Persona {
    const isNew = !id
    const persona: Persona = {
      id: id ?? `anchor-${Date.now().toString(36)}`,
      ...input,
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
   * 本场生效的音色（docs/07 §8.5 四层优先级）：场次 > 显式 voice > 角色 > 人设卡。
   * 话术库预合成与开播装载共用它，保证「音频是用哪把声音合成的」两边判断一致。
   */
  resolvePlanVoice(plan: LivePlan | null | undefined, role?: string, voice?: string): string | undefined {
    return resolveVoice(this.get(), role, voice, plan?.voiceId ?? '')
  }

  /** 组装主播 Agent 的 system prompt：角色/场次段在代码里拼好，主模板走主播手册（system.anchor）。
   *  modePromptModule：直播模式预设包的角色定位模块，拼进「本场直播」段（怎么演由模式包说，内容仍 agent 自编） */
  buildSystemPrompt(
    persona: Persona,
    plan?: LivePlan | null,
    script?: Script | null,
    modePromptModule = ''
  ): string {
    const voice = persona.voiceId

    const rolesSection =
      persona.roles.length > 0
        ? `\n# 编剧模式（多角色台词）
你一个人写所有角色的台词。需要配合/对话/起哄时，用 say 的 role 参数写对应角色的台词，会按角色音色播出：
${persona.roles.map((r) => `- ${r.name}：${r.style}`).join('\n')}
别滥用：角色台词是调味料，主线还是你自己（${persona.name}）的节奏。`
        : ''

    const planSection = plan
      ? `\n# 本场直播
- 场次：${plan.name}
- 主题方向：${plan.theme || '（未设定，自由发挥）'}${plan.styleHint ? `\n- 演出形式：${plan.styleHint}` : ''}${modePromptModule ? `\n${modePromptModule}` : ''}${
          script
            ? `
- 剧本场景序列（用 advance_scene 逐场推进，每场播得差不多就推进）：
${script.scenes.map((s, i) => `  ${i + 1}. ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}；要点：${s.keyPoints.replace(/\n/g, '；')}`).join('\n')}
- 播完最后一场后，是收尾下播还是循环返场由你根据现场气氛判断`
            : '\n- 本场没有绑定剧本，按主题自由发挥'
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
      planSection
    })
  }
}
