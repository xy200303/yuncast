import { playbackLoop } from './playbackLoop'
import { useAppStore } from '../stores/useAppStore'

/**
 * 统一开播控制（docs/07 §8.5）：启动 / 暂停 / 继续 / 结束场次是同一组状态机，
 * 直播台 header 只留这一处入口（原来左边「启动场次」+ 右边「暂停播报」是同一个意思分了两处）。
 *
 * 「暂停」= 停播报 + 停主播产出：主进程收到 playback:set-paused 后，评论和触发器不再派给 LLM，
 * say / insert_next 也被拒——说出去的话收不回，所以宁可不生成。恢复后接着播池里的内容。
 */
export function pauseBroadcast(): void {
  playbackLoop.stop()
  useAppStore.getState().setLoopRunning(false)
  void window.api.agent.setSpeakingPaused(true)
}

export function resumeBroadcast(): void {
  playbackLoop.start()
  useAppStore.getState().setLoopRunning(true)
  void window.api.agent.setSpeakingPaused(false)
}
