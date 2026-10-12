import { useAppStore } from '../stores/useAppStore'

/**
 * 统一开播控制（docs/07 §8.5）：启动 / 暂停 / 继续 / 结束场次是同一组状态机，
 * 直播台 header 只留这一处入口（原来左边「启动场次」+ 右边「暂停播报」是同一个意思分了两处）。
 *
 * 「暂停」= 停播报 + 停主播产出：这一个 IPC 由主进程同时处理——停掉主进程的播放循环
 * （正在播的那条退回 ready，恢复后从头重播）并让评论/触发器不再派给 LLM、say / insert_next 被拒。
 * 说出去的话收不回，所以宁可不生成；恢复后接着播池里的内容。
 */
export function pauseBroadcast(): void {
  useAppStore.getState().setLoopRunning(false)
  void window.api.agent.setSpeakingPaused(true)
}

export function resumeBroadcast(): void {
  useAppStore.getState().setLoopRunning(true)
  void window.api.agent.setSpeakingPaused(false)
}
