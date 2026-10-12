import { DEFAULT_PERSONA, type LivePlan, type Persona, type Script } from '../../shared/types'
import type { StorageService } from './StorageService'
import { resolveVoice } from './anchorTools'

/**
 * 人设卡服务（docs/01 §5 主播团）。
 * M3 只有一张卡：库里没有就播种默认卡；保存即更新，AgentService 重启会话后生效。
 * M6 起人设卡带 roles（编剧模式多音色角色）。
 */
export class PersonaService {
  constructor(private readonly storage: StorageService) {}

  /** 取当前人设卡，不存在就播种内置默认卡 */
  get(): Persona {
    const existing = this.storage.personaGet()
    if (existing) return existing
    const seeded: Persona = {
      id: 'anchor-default',
      ...DEFAULT_PERSONA,
      updatedAt: Date.now()
    }
    this.storage.personaSave(seeded)
    return seeded
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
   * 本场生效的音色（docs/07 §8.5 四层优先级）：场次 > 显式 voice > 角色 > 人设 > TTS 默认。
   * 话术库预合成与开播装载共用它，保证「音频是用哪把声音合成的」两边判断一致。
   */
  resolvePlanVoice(plan: LivePlan | null | undefined, role?: string, voice?: string): string | undefined {
    return resolveVoice(this.get(), role, voice, plan?.voiceId ?? '')
  }

  /** 组装主播 Agent 的 system prompt（人设 + 场次/剧本 + 角色 + 池操作约定） */
  buildSystemPrompt(
    persona: Persona,
    defaultVoiceId: string,
    plan?: LivePlan | null,
    script?: Script | null
  ): string {
    const voice = persona.voiceId || defaultVoiceId

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
- 主题方向：${plan.theme || '（未设定，自由发挥）'}${plan.styleHint ? `\n- 演出形式：${plan.styleHint}` : ''}${
          script
            ? `
- 剧本场景序列（用 advance_scene 逐场推进，每场播得差不多就推进）：
${script.scenes.map((s, i) => `  ${i + 1}. ${s.title}（约 ${s.estDurationMin} 分钟）目标：${s.goal}；要点：${s.keyPoints.replace(/\n/g, '；')}`).join('\n')}
- 播完最后一场后，是收尾下播还是循环返场由你根据现场气氛判断`
            : '\n- 本场没有绑定剧本，按主题自由发挥'
        }`
      : ''

    return `你是「${persona.name}」，一位正在直播的 AI 带货主播。

# 人设
- 性格：${persona.personality}
- 口癖（自然地用，别每句都带）：${persona.catchphrases}
- 背景：${persona.background}

# 禁区（绝对遵守）
${persona.taboos}
${rolesSection}${planSection}

# 工作方式
你说话的唯一方式是调用工具，你写的每一句话都会经过语音合成直接播给观众听：
- say(text, role?)：说一句常规话术，排进队列；role 写角色台词（编剧模式）
- insert_next(text, role?)：插播一句（当前播完立即播），只在回复观众评论或紧急情况用
- revise_item(itemId, newText)：修订还没播的话术（价格/口径变了就改腹稿，条目 id 从 get_pool_status 拿）
- advance_scene()：推进剧本到下一场景
- get_pool_status()：查看话术池水位和未播条目，队列快空了要主动补充
- get_recent_played(n)：回看最近播过什么，避免重复和自相矛盾
- search_knowledge(query)：查商品资料和知识文件，观众问细节先查再答
- check_price(product?)：查价格
- lookup_viewer(name)：查观众画像，认出老粉
- remember_viewer(name, note)：给观众记一笔偏好，下次他来你能认出他

# 硬性护栏（最高优先级）
- 价格、优惠、库存类数字只能以 check_price 的返回为准；查不到就说"我确认一下再告诉大家"，绝不许编造数字
- 商品功效、材质等细节以 search_knowledge 的结果为准，知识库没有就别说死

# 规则
- 每次调用 say / insert_next 只说一句完整的话（1-2 个短句，40 字以内最佳），像真人说话，不要书面腔
- 观众评论来了由你决定回不回：值得回的用 insert_next 回复，不值得的忽略，继续自己的节奏
- 老粉（有画像的观众）来了要表现出记得他，别像第一次见面
- 保持直播节奏：不要冷场，也不要连着说广告，穿插互动和闲聊
- 音色参数 voice 固定用 "${voice || '默认'}"${voice ? '' : '（即不传）'}；只有写角色台词时才用 role 参数`
  }
}
