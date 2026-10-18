import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore, selectLlmReady, providerLabel } from '../stores/useAppStore'
import { NAV_ITEMS } from './Sidebar'
import { voiceRouteSummary } from '../lib/voice'

/**
 * 底部状态栏：显示当前**实际生效**的导演大脑与节目卡司的嗓音 + 服务商；
 * 没有「当前出镜」概念——卡司没选音色就照实写「卡司没选音色」。
 * 导演大脑没配 / 嗓音路由断了给红色块，点击直达对应设置页。
 */
export function StatusBar() {
  const page = useAppStore((s) => s.page)
  const config = useAppStore((s) => s.config)
  const connections = useAppStore((s) => s.connections)
  const llmProviders = useAppStore((s) => s.llmProviders)
  const ttsConnections = useAppStore((s) => s.ttsConnections)
  const ttsProviders = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)
  const levels = useAppStore((s) => s.levels)
  const agent = useAppStore((s) => s.agent)
  const pool = useAppStore((s) => s.pool)
  const stream = useAppStore((s) => s.stream)
  const connector = useAppStore((s) => s.connector)
  const openSettings = useAppStore((s) => s.openSettings)
  const current = NAV_ITEMS.find((item) => item.id === page)
  const llmOk = selectLlmReady(connections, config.director)
  const synthesizing = pool.items.filter((item) => item.status === 'synthesizing').length

  // 导演大脑：名字 + 接入服务商名（接入被删了就连服务商名也标出来）
  const directorConnection = config.director.modelConnectionId
    ? connections.find((item) => item.id === config.director.modelConnectionId)
    : undefined
  const directorText = llmOk
    ? `导演 ${config.director.name}（${providerLabel(llmProviders, directorConnection?.providerId ?? '')}）`
    : null

  // 节目卡司：取卡司第一张的嗓音；没配就照实说明
  const [programVoice, setProgramVoice] = useState<{ name: string; voiceId: string; hasCast: boolean } | null>(null)
  useEffect(() => {
    if (!('api' in window)) return
    let alive = true
    const load = () => {
      void window.api.program.list().then(async (list) => {
        if (!alive) return
        const program = list.find((p) => p.id === config.live.activeProgramId)
        if (!program) {
          setProgramVoice(null)
          return
        }
        const castFirst = program.personaIds[0]
        const personas = await window.api.persona.list()
        const voiceId = (castFirst ? personas.find((p) => p.id === castFirst)?.voiceId : '') ?? ''
        setProgramVoice({ name: program.name, voiceId: voiceId.trim(), hasCast: Boolean(castFirst) })
      })
    }
    load()
    const off = window.api.program.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [config.live.activeProgramId])

  // 卡司嗓音 + TTS 服务商；嗓音路由断了（接入被删/模型没启用）红色警示
  const voice = programVoice?.voiceId
    ? voiceRouteSummary(voices, ttsProviders, ttsConnections, programVoice.voiceId)
    : null
  const castText =
    voice && !voice.broken
      ? `卡司嗓音 ${voice.voiceName}${voice.providerShort ? ` · ${voice.providerShort}` : ''}`
      : null

  /**
   * 推流格只说"这一路输出通道"的状态：直推 = 推流，伴侣模式 = 出声。
   * 整机播没播由左边那格（播报中 / 已暂停 / 就绪）负责——两格原来都讲"开播"，
   * 口径撞车且暂停时左边仍写「播报中」。
   */
  const streamBadge = (() => {
    if (stream.state === 'live') {
      return { text: stream.mode === 'direct' ? `推流中 ${stream.bitrateKbps}kbps` : '伴侣出声' }
    }
    if (stream.state === 'error') return { text: '推流出错' }
    if (config.stream.mode === 'direct' && (!config.stream.serverUrl || !config.stream.streamKey)) {
      return { text: '推流未配置' }
    }
    return { text: config.stream.mode === 'direct' ? '未推流' : '未出声' }
  })()

  const gatewayBadge = (() => {
    if (connector.state === 'connected') return { warn: false, text: '连接器已连接' }
    if (connector.state === 'connecting') return { warn: true, text: '连接器连接中…' }
    return { warn: false, text: '连接器未接入' }
  })()

  return (
    <footer className="flex h-7 items-center gap-3 bg-muted/30 px-3 text-xs text-muted-foreground">
      {/* 只报页面与播出状态，不铺稿子文字（正在播什么看内容区）：
          暂停态以主进程 speakingPaused 为准，别在"没在出声"的时候还写「播报中」 */}
      <span className="truncate">
        {current
          ? `${agent.live ? (agent.speakingPaused ? '已暂停' : '播报中') : '就绪'} · ${current.label}`
          : '就绪'}
      </span>
      <WaveMeter level={levels.master} active={Boolean(pool.items.find((item) => item.status === 'playing'))} />
      <div className="ml-auto flex min-w-0 items-center gap-2.5">
        {directorText ? (
          <span title="导演大脑（这场谁在指挥）">{directorText}</span>
        ) : (
          <button
            type="button"
            className="text-destructive hover:underline"
            title="导演还没有大脑，开不了播：点这里去配"
            onClick={() => openSettings('director')}
          >
            导演大脑未配置 → 去配置
          </button>
        )}
        <Dot />
        {castText ? (
          <span title="卡司嗓音">{castText}</span>
        ) : voice?.broken ? (
          <button
            type="button"
            className="text-destructive hover:underline"
            title={`${voice.broken}（点这里去设置 → 语音合成）`}
            onClick={() => openSettings('tts')}
          >
            卡司嗓音失效 → 去修复
          </button>
        ) : (
          <span title={programVoice?.hasCast ? '卡司里的卡还没选音色' : '本节目没配卡司：合成时逐段用 personaId 指定'}>
            {!programVoice ? '未选节目' : programVoice.hasCast ? '卡司没选音色' : '未选主播'}
          </span>
        )}
        {synthesizing > 0 && (
          <>
            <Dot />
            <span className="flex items-center gap-1" title="正在合成的条数">
              <Loader2 className="size-3 animate-spin" />
              合成中 {synthesizing}
            </span>
          </>
        )}
        <Dot />
        <span
          className={stream.state === 'error' ? 'text-destructive' : undefined}
          title={stream.reconnecting ? `推流断了，第 ${stream.reconnectAttempt} 次重连中` : '推流状态'}
        >
          {stream.reconnecting ? `重连中(${stream.reconnectAttempt})` : streamBadge.text}
        </span>
        <Dot />
        <span className={gatewayBadge.warn ? 'text-amber-600' : undefined} title="评论连接器">
          {gatewayBadge.text}
        </span>
      </div>
    </footer>
  )
}

/** 条目间的小圆点分隔（不用边框，也不做成一个个胶囊） */
function Dot(): React.ReactElement {
  return <span className="text-border">·</span>
}

/** 每根竖条的相对权重：中间高两侧低，看起来像一段波 */
const WAVE_BARS = [0.42, 0.66, 0.86, 1, 0.86, 0.66, 0.42]

/**
 * 状态栏的音波指示（替代原来的细长电平条）：中间高两侧低的一段波，
 * 有内容在播时每根条错开做起伏动画（看得到"在出声"），主进程推来电平时再按强弱缩放；
 * 没在播就收成一条细线。电平包是按帧节流推的（间隔可能比动画长），所以动画不依赖它。
 */
function WaveMeter({ level, active }: { level: number; active: boolean }) {
  return (
    <span
      className="flex h-3.5 shrink-0 items-center gap-[2px]"
      title={active ? '主输出电平（正在出声）' : '主输出电平（静音）'}
    >
      {WAVE_BARS.map((weight, index) => (
        <span
          // 下标 key：这七根条是写死的常量数组，数量与顺序永不变化
          key={index}
          className="w-[2px] rounded-full bg-primary/70"
          style={{
            // 静态高度先给一段波峰轮廓；有电平就按强弱加号（0.35 是"有声音"的底噪下限）
            height: active ? `${4 + 10 * weight * (0.35 + 0.65 * Math.max(level, 0.25))}px` : '3px',
            transition: 'height 120ms ease-out',
            animation: active ? `yuncast-wave 900ms ease-in-out ${index * 80}ms infinite` : undefined
          }}
        />
      ))}
    </span>
  )
}
