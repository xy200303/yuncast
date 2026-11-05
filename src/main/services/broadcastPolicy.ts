import type { Program, SessionConfig } from '../../shared/types'
import type { ProgramPlaybackService } from './ProgramPlaybackService'

/**
 * 播出策略（docs/12 §12）：
 * 三种播出方式对「启动装载 / 滚动合成 / 池见底 / 池低水位 / 就绪补装 / 水位触发器」的反应
 * 完全不同，全部封装成策略对象——引擎（index.ts 的水位订阅、launch）只问策略要决策。
 *
 * 模式由「剧本的播出形态 + 本场内容来源」共同决定：
 * - 本场 contentSource=infinite：无底稿，边播边无限生成（内容来源覆盖形态）
 * - 其余按剧本 broadcastMode：prepared（全部做好再播）/ rolling（边播边准备）
 * 收尾只认本场 endMode：stop=一遍播完停，loop/forever=循环返场。
 */

/** 池见底决策：wrap-up=走两阶段收播；reload=循环重装；wait=内容在路上（允许冷场）；ignore=与本模式无关 */
export type PoolEmptyAction = 'wrap-up' | 'reload' | 'wait' | 'ignore'

export interface BroadcastPolicy {
  /** 启动装载：返回装进池的条数（无限生成恒 0） */
  load(program: Program, opts?: { allowPartial?: boolean }): number
  /** 启动后的后台合成：rolling 有欠账就滚动蒸；prepared 走「生成节目音频」入口；无限生成无底稿 */
  kickSynthesis(program: Program): void
  /** 池见底决策 */
  poolEmptyAction(program: Program): PoolEmptyAction
  /** 循环重装（poolEmptyAction=reload 时的回调；复用已有音频，不重新合成） */
  reload(program: Program): number
  /** 池低水位要不要引擎直发续写（rolling 专属；导演随时可在对话里人工叫写） */
  shouldAutoWrite(program: Program): boolean
  /** 底稿/音频就绪事件要不要自动补装进池 */
  readonly autoReloadOnReady: boolean
  /** 水位类触发器（pool.empty/pool.low，如「冷场自救」）是否放行给主播 */
  readonly allowsPoolTriggers: boolean
}

/** 滚动直播：整库装载 + 后台滚动合成；见底看上限，没到等续写（允许冷场），到了按本场收尾 */
function rollingPolicy(pb: ProgramPlaybackService, session: SessionConfig): BroadcastPolicy {
  return {
    autoReloadOnReady: true,
    allowsPoolTriggers: true,
    load: (program) => pb.loadProgramDraftUnits(program.id),
    // 预合成档：开播前就该全部合好（预检会拦），开播后不再后台补蒸
    kickSynthesis: (program) => {
      if (session.synthMode !== 'pre') void pb.kickSynthesis(program.id)
    },
    poolEmptyAction: (program) => {
      if (session.endMode === 'stop') {
        // 「内容在路上」就等——区分「真播完」和「还在合成」
        if (pb.hasIncomingDraftUnits(program.id)) return 'wait'
        return 'wrap-up'
      }
      // 首轮没播完 = 接着播（不是循环）；全播过了要到段数上限才允许循环重播
      if (!pb.hasFreshDraftUnits(program.id) && !pb.atDraftCap(program.id)) return 'wait'
      return 'reload'
    },
    reload: (program) => pb.rewindPool() || pb.loadProgramDraftUnits(program.id),
    // 到顶了叫也写不进，循环闸门会接管，不白烧一轮 LLM
    shouldAutoWrite: (program) => !pb.atDraftCap(program.id)
  }
}

/** 预制节目：门禁后装 rendered 音频单元；见底按本场收尾，loop/forever 复用音频重装；永不续写 */
function preparedPolicy(pb: ProgramPlaybackService, session: SessionConfig): BroadcastPolicy {
  return {
    autoReloadOnReady: false,
    allowsPoolTriggers: false,
    load: (program, opts) => pb.loadPreparedUnits(program, opts?.allowPartial === true),
    kickSynthesis: () => undefined,
    poolEmptyAction: (program) => {
      if (session.endMode === 'stop') {
        // 音频还在出（播放中点了「生成节目音频」）就等，不算播完
        if (pb.hasIncomingRendered(program.id)) return 'wait'
        return 'wrap-up'
      }
      return 'reload'
    },
    reload: (program) => pb.rewindPool() || pb.reloadPreparedUnits(program.id),
    shouldAutoWrite: () => false
  }
}

/** 无限生成：无底稿，装载/合成/循环都不参与；水位触发器放行（「冷场自救」对它=该说话了） */
function infinitePolicy(): BroadcastPolicy {
  return {
    autoReloadOnReady: false,
    allowsPoolTriggers: true,
    load: () => 0,
    kickSynthesis: () => undefined,
    poolEmptyAction: () => 'ignore',
    reload: () => 0,
    shouldAutoWrite: () => false
  }
}

/** 策略工厂：本场的三个开关决定装载/合成/收尾路线（剧本资产不参与） */
export function policyFor(program: Program, session: SessionConfig, pb: ProgramPlaybackService): BroadcastPolicy {
  if (session.contentSource === 'infinite') return infinitePolicy()
  return session.synthMode === 'pre' ? preparedPolicy(pb, session) : rollingPolicy(pb, session)
}
