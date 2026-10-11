import { Badge } from '@/components/ui/badge'
import { useAppStore, selectLlmReady, selectTtsReady } from '../stores/useAppStore'
import { NAV_ITEMS } from './Sidebar'

/** 底部状态栏。LLM/TTS/推流/评论徽章都接真状态。 */
export function StatusBar() {
  const page = useAppStore((s) => s.page)
  const config = useAppStore((s) => s.config)
  const pool = useAppStore((s) => s.pool)
  const agentState = useAppStore((s) => s.agent.state)
  const stream = useAppStore((s) => s.stream)
  const gateway = useAppStore((s) => s.gateway)
  const current = NAV_ITEMS.find((item) => item.id === page)
  const playing = pool.items.find((item) => item.status === 'playing')
  const ttsReady = selectTtsReady(config)
  const llmReady = selectLlmReady(config)

  const streamBadge =
    stream.state === 'live'
      ? { variant: 'secondary' as const, text: stream.mode === 'direct' ? `推流中 ${stream.bitrateKbps}kbps` : '伴侣出声' }
      : stream.state === 'error'
        ? { variant: 'destructive' as const, text: '推流出错' }
        : config.stream.mode === 'direct' && (!config.stream.serverUrl || !config.stream.streamKey)
          ? { variant: 'outline' as const, text: '推流未配置' }
          : { variant: 'outline' as const, text: '未开播' }

  const gatewayBadge = gateway.running
    ? { variant: 'secondary' as const, text: '评论已接入' }
    : { variant: 'outline' as const, text: '评论未接入' }

  return (
    <footer className="flex h-7 items-center gap-2 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
      <span className="truncate">
        {playing ? `播报中 · ${playing.text.slice(0, 30)}` : current ? `就绪 · ${current.label}` : '就绪'}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <Badge variant={streamBadge.variant}>{streamBadge.text}</Badge>
        <Badge variant={llmReady ? 'secondary' : 'outline'}>
          {llmReady ? (agentState === 'running' ? 'LLM 直播中' : 'LLM 已配置') : 'LLM 未配置'}
        </Badge>
        <Badge variant={ttsReady ? 'secondary' : 'outline'}>{ttsReady ? 'TTS 已配置' : 'TTS 未配置'}</Badge>
        <Badge variant={gatewayBadge.variant}>{gatewayBadge.text}</Badge>
      </span>
    </footer>
  )
}
