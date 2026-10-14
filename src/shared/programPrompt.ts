import type { BroadcastMode, ContentType, Program } from './types'

/**
 * 「本场节目」提示词模块（替代旧直播模式的 promptModule）：
 * 由节目的 contentType + broadcastMode 生成，拼进主播 system prompt 的「本场节目」段。
 * 内容类型管表达规范，播出方式管节奏；内容本身仍是 agent 自编自导。
 */

const CONTENT_TYPE_MODULE: Record<ContentType, string> = {
  solo: `- 内容形式：一个人讲。整场都是你一个人的单口讲述——像电台主播、像说书先生，把主题讲透；没有搭档，别虚拟出对话者`,
  conversation: `- 内容形式：多人聊天。要出对话感：用 say 的 role 参数写不同角色的台词（按角色音色播出），互相接话、补充、抬杠，像一档真的多人节目，别写成你一个人的独白`,
  reading: `- 内容形式：照着稿子读。忠实朗读稿件内容，不自由发挥、不改写事实与数字；你的发挥空间只在语气、停顿和段落之间的衔接语上`,
  roleplay: `- 内容形式：分角色表演。用 say 的 role 参数写各个角色的台词（按角色音色播出），把戏演出来——每个角色要有自己的口吻，别念成同一个旁白`
}

const BROADCAST_MODE_MODULE: Record<BroadcastMode, string> = {
  improvised: `- 播出方式：现场发挥。没有固定底稿，内容全靠你现场组织；直播间有动态（评论/礼物/进场）就接着聊，没动态可以不说——自然停顿比硬凑废话强`,
  rolling: `- 播出方式：边播边准备。按底稿推进主线，滚动合成窗口跟在你后面；话术池快空了自己续写新桥段——返场不返词：同一要点换故事换角度重新讲，别逐字复读最近播过的`,
  prepared: `- 播出方式：全部做好再播。本场音频开播前已全部预制好，按顺序播出即可；你主要负责开场、段落衔接和现场互动，别临时改稿重写`
}

/** 生成注入主播 system prompt 的「本场节目」段（内容类型 + 播出方式两行） */
export function buildProgramPromptModule(program: Program): string {
  return `${CONTENT_TYPE_MODULE[program.contentType]}\n${BROADCAST_MODE_MODULE[program.broadcastMode]}`
}
