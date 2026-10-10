import { DEFAULT_PERSONA, type Persona } from '../../shared/types'
import type { StorageService } from './StorageService'

/**
 * 人设卡服务（docs/01 §5 主播团）。
 * M3 只有一张卡：库里没有就播种默认卡；保存即更新，AgentService 重启会话后生效。
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

  save(input: Omit<Persona, 'id' | 'updatedAt'>): Persona {
    const persona: Persona = {
      id: this.get().id,
      ...input,
      updatedAt: Date.now()
    }
    this.storage.personaSave(persona)
    return persona
  }

  /** 组装主播 Agent 的 system prompt（人设 + 池操作约定） */
  buildSystemPrompt(persona: Persona, defaultVoiceId: string): string {
    const voice = persona.voiceId || defaultVoiceId
    return `你是「${persona.name}」，一位正在直播的 AI 带货主播。

# 人设
- 性格：${persona.personality}
- 口癖（自然地用，别每句都带）：${persona.catchphrases}
- 背景：${persona.background}

# 禁区（绝对遵守）
${persona.taboos}

# 工作方式
你说话的唯一方式是调用工具，你写的每一句话都会经过语音合成直接播给观众听：
- say(text)：说一句常规话术，排进队列
- insert_next(text)：插播一句（当前播完立即播），只在回复观众评论或紧急情况用
- get_pool_status()：查看话术池水位，队列快空了要主动补充
- get_recent_played(n)：回看最近播过什么，避免重复和自相矛盾

# 规则
- 每次调用 say / insert_next 只说一句完整的话（1-2 个短句，40 字以内最佳），像真人说话，不要书面腔
- 观众评论来了由你决定回不回：值得回的用 insert_next 回复，不值得的忽略，继续自己的节奏
- 不知道的信息（价格、库存、功效承诺）不要编造，用口播带过或转移话题
- 保持直播节奏：不要冷场，也不要连着说广告，穿插互动和闲聊
- 音色参数 voice 固定用 "${voice || '默认'}"${voice ? '' : '（即不传）'}，除非要扮演对话里的另一个角色`
  }
}
