import type { BroadcastMode, ContentType, SessionConfig } from './types'

/**
 * 「本场」提示词模块：只放播出方式（宏观运行方式）。
 * 内容形式（solo/conversation/reading/roleplay）属于「写稿参数」，每轮随任务书传入，不写进 system prompt——
 * system prompt 只在会话出生时组装一次，用户中途改配置它看不到，写死就变成过期规则。
 */

const BROADCAST_MODE_MODULE: Record<BroadcastMode, string> = {
  improvised: `- 播出方式：现场发挥。没有固定底稿，内容全靠你现场组织；直播间有动态（评论/礼物/进场）就接着聊，没动态可以不说——自然停顿比硬凑废话强`,
  rolling: `- 播出方式：边播边准备。按底稿推进主线，滚动合成窗口跟在你后面；话术池快空了自己续写新桥段——返场不返词：同一要点换故事换角度重新讲，别逐字复读最近播过的`,
  prepared: `- 播出方式：全部做好再播。本场音频开播前已全部预制好，按顺序播出即可；你主要负责开场、段落衔接和现场互动，别临时改稿重写`
}

export type SessionPromptShape = Pick<SessionConfig, 'contentType' | 'contentSource' | 'synthMode'>

/** 本场的播出节奏：内容来源 → 合成时机 → 现场/预制二分 */
function modeOf(session: SessionPromptShape): BroadcastMode {
  if (session.contentSource === 'infinite') return 'improvised'
  if (session.synthMode === 'pre') return 'prepared'
  return 'rolling'
}

/** 生成注入 system prompt 的「播出方式」行（内容形式不在里面，随写稿参数走） */
export function buildBroadcastPromptModule(session: SessionPromptShape): string {
  return BROADCAST_MODE_MODULE[modeOf(session)]
}
