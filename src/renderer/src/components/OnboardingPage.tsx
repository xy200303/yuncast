import { useEffect, useRef } from 'react'
import { ArrowRight, CheckCircle2, Circle, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import logoUrl from '../../assets/logo.svg'
import { BRAND_NAME_ZH } from '../../../shared/brand'
import { useAppStore } from '../stores/useAppStore'
import { ONBOARDING_DONE_KEY, useOnboardingSteps } from '../lib/onboarding'

/**
 * 首跑引导 · 配置清单页（docs/REDESIGN 4.9）：「还差 N 步就能开播」。
 * 全屏覆盖层：①② 就地开设置弹窗（覆盖层留在底下，设完回来步骤立即变勾），
 * ③④ 撤掉覆盖层跳对应页面去建；全部就绪后⑤可点，落直播台。
 */
export function OnboardingPage() {
  const steps = useOnboardingSteps()
  const openSettings = useAppStore((s) => s.openSettings)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setPage = useAppStore((s) => s.setPage)
  const setOnboardingOpen = useAppStore((s) => s.setOnboardingOpen)

  const baseReady = steps.llm && steps.tts && steps.persona
  const allReady = steps.loaded && baseReady && steps.program
  const remaining = [steps.llm, steps.tts, steps.persona, steps.program].filter((ok) => !ok).length

  // 设置弹窗关回来时重查③④（引导页停留期间可能建过主播卡/节目）
  const wasSettingsOpen = useRef(settingsOpen)
  const refresh = steps.refresh
  useEffect(() => {
    if (wasSettingsOpen.current && !settingsOpen) refresh()
    wasSettingsOpen.current = settingsOpen
  }, [settingsOpen, refresh])

  // 全部就绪：持久化完成标记（下次启动直落直播台，不再落引导页）
  useEffect(() => {
    if (allReady) localStorage.setItem(ONBOARDING_DONE_KEY, '1')
  }, [allReady])

  /** 去别的页面建东西：撤掉覆盖层，下次启动（或设置 → 关于重开）再回来接着看清单 */
  const gotoPage = (page: 'personas' | 'programs') => {
    setOnboardingOpen(false)
    setPage(page)
  }

  const skip = () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1')
    setOnboardingOpen(false)
  }

  const goLive = () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1')
    setOnboardingOpen(false)
    setPage('live')
  }

  const rows: { ok: boolean; title: string; hint: string; action?: { label: string; run: () => void; disabled?: boolean } }[] = [
    {
      ok: steps.llm,
      title: '给导演配大脑（语言模型）',
      hint: '导演思考、写稿全靠它：选一家服务商，填上密钥',
      action: { label: '去配置', run: () => openSettings('director') }
    },
    {
      ok: steps.tts,
      title: '配语音合成（TTS 接入）',
      hint: '主播出声靠它：火山引擎或阿里云百炼，填上密钥',
      action: { label: '去配置', run: () => openSettings('tts') }
    },
    {
      ok: steps.persona,
      title: '建一张主播卡（人设 + 嗓音）',
      hint: '主播是谁、什么性格、用什么声音说话',
      action: { label: '去创建', run: () => gotoPage('personas') }
    },
    {
      ok: steps.program,
      title: '建第一个节目',
      hint: baseReady ? '一场直播播什么、怎么播，都装在节目里' : '先把上面三步做完，再来建节目',
      action: { label: '去创建', run: () => gotoPage('programs'), disabled: !baseReady }
    }
  ]

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center px-6 py-10">
        <img src={logoUrl} alt={BRAND_NAME_ZH} className="size-14" />
        <h1 className="mt-4 text-xl font-semibold">
          {allReady ? '都齐了，可以开播了！' : `还差 ${remaining} 步就能开播`}
        </h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          {allReady
            ? '导演、声音、主播、节目都就位了'
            : '跟着清单一步一步来，每步都有「去配置」带路，不懂技术也能配好'}
        </p>

        <div className="mt-6 flex w-full flex-col gap-2">
          {rows.map((row, index) => (
            <div
              key={row.title}
              className={cn(
                'flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5',
                row.ok && 'border-emerald-600/30'
              )}
            >
              {row.ok ? (
                <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground/50" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {index + 1}. {row.title}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{row.ok ? '已完成' : row.hint}</p>
              </div>
              {!row.ok && row.action && (
                <Button
                  size="sm"
                  variant={row.action.disabled ? 'outline' : 'default'}
                  disabled={row.action.disabled}
                  onClick={row.action.run}
                >
                  {row.action.label}
                  <ArrowRight />
                </Button>
              )}
            </div>
          ))}

          {/* ⑤ 开播 */}
          <div
            className={cn(
              'flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5',
              allReady && 'border-primary/40'
            )}
          >
            {allReady ? (
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
            ) : (
              <Circle className="size-5 shrink-0 text-muted-foreground/50" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">5. 开播！</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {allReady ? '去直播台，选中节目点开播' : '上面四步都完成就能开播'}
              </p>
            </div>
            <Button size="sm" disabled={!allReady} onClick={goLive}>
              <Radio />
              去直播台开播
            </Button>
          </div>
        </div>

        <button
          type="button"
          className="mt-6 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={skip}
        >
          先随便逛逛（以后可从 设置 → 关于 重新打开新手指引）
        </button>
      </div>
    </div>
  )
}
