import { useCallback, useEffect, useState } from 'react'
import { llmReady } from '../../../shared/types'
import { useAppStore } from '../stores/useAppStore'

/** 首跑引导「全部就绪」的持久化标记（docs/REDESIGN 4.9；设置 → 关于 可清掉重开） */
export const ONBOARDING_DONE_KEY = 'yuncast.onboarding.done'

export interface OnboardingSteps {
  /** ① 导演大脑：director 选了接入 + 模型且接入可用 */
  llm: boolean
  /** ② 语音合成：存在任一可用 TTS 接入 */
  tts: boolean
  /** ③ 主播卡：至少一张 */
  persona: boolean
  /** ④ 节目：至少一个 */
  program: boolean
  /** ③④ 查库回来了（回来前不算就绪，避免闪「已完成」） */
  loaded: boolean
  /** ③④ 重查（引导页停留期间建了主播卡/节目，回来要刷新判定） */
  refresh: () => void
}

/**
 * 开播就绪清单的实时判定：①② 直接读 store（接入库是响应式的，设置里改完立即反映），
 * ③④ 要查库（主播卡/节目列表不在全局 store 里），所以暴露 refresh 给页面在合适时机重查。
 */
export function useOnboardingSteps(): OnboardingSteps {
  const connections = useAppStore((s) => s.connections)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const director = useAppStore((s) => s.config.director)
  const [counts, setCounts] = useState<{ personas: number; programs: number } | null>(null)

  const refresh = useCallback(() => {
    if (!('api' in window)) return
    void Promise.all([window.api.persona.list(), window.api.program.list()]).then(([personas, programs]) => {
      setCounts({ personas: personas.length, programs: programs.length })
    })
  }, [])

  useEffect(refresh, [refresh])

  return {
    llm: llmReady(connections, director),
    tts: ttsConnections.some((connection) => connection.ready),
    persona: (counts?.personas ?? 0) > 0,
    program: (counts?.programs ?? 0) > 0,
    loaded: counts !== null,
    refresh
  }
}
