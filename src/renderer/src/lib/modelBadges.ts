import { BookOpenText, Fingerprint, Megaphone, Sparkles, Users, Zap, type LucideIcon } from 'lucide-react'
import type { TtsModelSpec } from '../../../shared/types'

export interface ModelBadge {
  /** 语义名（设置页徽章文字；选择器里只在 tooltip 出现） */
  label: string
  title: string
  icon: LucideIcon
  /** 图标颜色（三种能力三个色，选择器里纯图标靠颜色区分） */
  className: string
}

/**
 * TTS 模型的能力标识（设置页模型列表 + 音色选择器 + 主播卡共用同一份）：
 * 实时（流式合成，绿 Zap）/ 语气指令（整段 delivery，蓝 Megaphone）/ 演法标记（稿内 <cot>/<fx>/<pause>，紫 Sparkles）
 * / 克隆（能吃音色库克隆音色，琥珀 Fingerprint）/ 长文（整篇朗读，青 BookOpenText）
 * / 双人播客（两位主播轮次成片，粉 Users）。
 * 「要填业务空间 ID」那种**配置要求**不在这里标：缺空间 ID 的模型压根不会进可选列表（usableModels 已按 isTtsModelUsable 过滤），
 * 真缺的时候由接入表单 / 选择器的路由校验给人话指引，不该混进"这把嗓子能干什么"的表达里。
 * 界面上只画图标 + tooltip（文字徽章太吵，设置页模型列表除外）；火山复刻 2.0 的演法标记只在选 expressive 时生效，tooltip 里说明。
 */
export function ttsModelBadges(spec: TtsModelSpec): ModelBadge[] {
  const badges: ModelBadge[] = []
  if (spec.streaming) {
    badges.push({
      label: '实时',
      title: '实时：支持流式合成，动态内容（评论回复等）边合成边播，首包更快',
      icon: Zap,
      className: 'text-emerald-600 dark:text-emerald-400'
    })
  }
  if (spec.instruction) {
    badges.push({
      label: '语气指令',
      title: '语气指令：支持整段自然语言演法（agent 的 delivery 会发给它）',
      icon: Megaphone,
      className: 'text-sky-600 dark:text-sky-400'
    })
  }
  if (spec.inlineTags) {
    badges.push({
      label: '演法标记',
      title: '演法标记：支持稿内标记 <cot text=情绪>句子</cot>、<fx>音效</fx>、<pause>停顿</pause>',
      icon: Sparkles,
      className: 'text-violet-600 dark:text-violet-400'
    })
  } else if (spec.id === 'seed-icl-2.0') {
    badges.push({
      label: '演法标记',
      title: '演法标记：复刻版本选 expressive 时支持 <cot>/<fx>/<pause>（接入 → 模型参数里切换）',
      icon: Sparkles,
      className: 'text-violet-600 dark:text-violet-400'
    })
  }
  if (spec.kind === 'clone' || spec.capabilities?.supportsCloneVoice) {
    badges.push({
      label: '克隆',
      title: '克隆：能吃音色库里用你的声音样本训练出来的音色',
      icon: Fingerprint,
      className: 'text-amber-600 dark:text-amber-400'
    })
  }
  if (spec.capabilities?.kind === 'longform' || spec.capabilities?.input === 'longText') {
    badges.push({
      label: '长文',
      title: '长文：适合整篇朗读，一次合成一章/一篇长文本',
      icon: BookOpenText,
      className: 'text-cyan-600 dark:text-cyan-400'
    })
  }
  if (spec.capabilities?.kind === 'podcast' || spec.capabilities?.input === 'dialogueTurns') {
    badges.push({
      label: '双人播客',
      title: '双人播客：两位主播轮次成片，整期一次合成（带片头/片尾处理）',
      icon: Users,
      className: 'text-pink-600 dark:text-pink-400'
    })
  }
  return badges
}
