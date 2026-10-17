import { Type } from 'typebox'
import { TTS_PROVIDER_SHORT } from '../../../shared/types'
import { defineTool, type ToolCtx } from './types'

/**
 * 元/导演通道域：主播请示导演、外部导演与主播对话、聚合状态、推流与紧急停止。
 * 合并自旧 ask_director（anchorTools）、agent_chat/agent_status/live_status（McpService）、
 * get_system_status/start_rtmp/emergency_stop（anchorSystemTools）。
 */

/**
 * 破坏性操作的两段确认：没带 confirmed=true 时只发导演确认卡；
 * 导演答复「确认执行」后带 confirmed=true 重调才真正执行。
 */
function askConfirm(ctx: ToolCtx, summary: string): string {
  if (!ctx.onDirectorAsk) return '确认通道没接上（ask_director 不可用）：破坏性操作不能执行，让导演在界面手动操作'
  ctx.onDirectorAsk({
    text: summary,
    options: ['确认执行', '取消'],
    timeoutSec: 300,
    defaultAction: '不执行，保持现状'
  })
  return (
    `这是破坏性/对外操作，已向导演发确认卡（5 分钟内有效）：\n${summary}\n` +
    `导演答复「确认执行」后，带 confirmed=true 重新调用本工具才真正执行；导演没确认前不要重复调用，保持现状`
  )
}

export const agentTools = [
  defineTool({
    name: 'ask_director',
    label: '请示导演',
    domain: 'agent',
    risk: 'write',
    expose: { agent: true },
    description:
      '需要人拍板时问导演：指令有歧义（「把报价改一下」但本场有两个商品）、场景该推进还是循环、观众追问知识库没有的参数、准备做超出知识库的承诺。' +
      '副作用：在对话面板给导演发一张确认卡。问完立刻按 defaultAction 继续播，不要停下等回答——导演的回答会作为新指令进来。' +
      '不许问的（自己定）：回哪条评论、要不要插播、冷场怎么救、语气怎么调。返回已请示的确认文案。',
    parameters: Type.Object({
      question: Type.String({ description: '要请示的问题，一两句话，说清背景' }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: '给导演的快捷选项（2-3 个），导演点一下就能答' })
      ),
      timeoutSec: Type.Optional(Type.Number({ description: '等多久没答就算过期，默认 60 秒' })),
      defaultAction: Type.Optional(Type.String({ description: '没等到回答时你按什么继续，比如「先含糊带过」' }))
    }),
    handler: (ctx, params) => {
      const timeoutSec = Math.min(Math.max(Math.round(params.timeoutSec ?? 60), 10), 600)
      if (!ctx.onDirectorAsk) {
        return `请示通道没接上，别停：${params.defaultAction?.trim() || '照原节奏继续'}`
      }
      ctx.onDirectorAsk({
        text: params.question,
        options: (params.options ?? []).filter((o) => o.trim()).slice(0, 4),
        timeoutSec,
        defaultAction: params.defaultAction?.trim() || undefined
      })
      return (
        `已请示导演（${timeoutSec} 秒没答就算过期）。继续按你的默认策略播，不要停：` +
        `${params.defaultAction?.trim() || '照原节奏继续'}`
      )
    }
  }),

  defineTool({
    name: 'agent_chat',
    label: '和主播说话',
    domain: 'agent',
    risk: 'write',
    expose: { mcp: true },
    description:
      '给主播 Agent 发一条导演指令，等它这轮说完再返回回复文本。需要先选中节目。' +
      '主播正在生成时会拒绝，等上一轮说完再发（先 agent_status 看 busy）。timeoutSec 默认 120 秒。' +
      '返回主播这一轮的回复文本；只说动作没说话时用 agent_status / pool_status 看结果。',
    parameters: Type.Object({
      text: Type.String({ description: '导演指令，一两句话说清要什么' }),
      timeoutSec: Type.Optional(Type.Number({ description: '等待回复的秒数，默认 120' }))
    }),
    handler: async (ctx, params) => {
      if (!ctx.agentChat) return '导演通道没接上'
      return ctx.agentChat(params.text, (params.timeoutSec ?? 120) * 1000)
    }
  }),

  defineTool({
    name: 'agent_status',
    label: '主播状态',
    domain: 'agent',
    risk: 'read',
    expose: { mcp: true },
    description:
      '看主播 Agent 的运行状态：会话状态、是否开播、是否在生成（busy）、当前场景、上下文用量等。' +
      '只读无副作用。发 agent_chat 前先调它确认 busy=false。返回状态 JSON。',
    parameters: Type.Object({}),
    handler: (ctx) => JSON.stringify(ctx.agent.status(), null, 2)
  }),

  defineTool({
    name: 'status',
    label: '系统状态',
    domain: 'agent',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '系统健康总览：当前节目/主播 Agent 状态/话术池/导演配置/语言模型接入/语音合成接入/评论连接器/RTMP 推流，附可操作的修复建议。' +
      '只读无副作用；排查「为什么没动静/说不出话/收不到评论」先调它。密钥只报「已配置/未配置」，谁都读不到明文。返回聚合状态 JSON。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const status = ctx.getStatus?.() ?? ctx.agent.status()
      const cfg = ctx.storage.getConfig()
      const activeId = cfg.live.activeProgramId
      const active = activeId ? ctx.storage.programList().find((p) => p.id === activeId) : undefined
      const cast = ctx.persona.programCast()
      const voiceLabel = (voiceId: string): string => {
        if (!voiceId.trim()) return '（未设置）'
        const found = ctx.voices?.list().find((v) => v.voiceType === voiceId.trim())
        return found ? `${found.name}（${voiceId.trim()}）` : voiceId.trim()
      }
      const llmConnections = ctx.storage.connectionListSafe().map((c) => ({
        id: c.id,
        名称: c.name,
        服务商: c.providerId,
        密钥: c.hasSecret ? '已配置' : '未配置',
        可用: c.ready,
        模型数: c.models.length
      }))
      const ttsConnections = ctx.storage.ttsConnectionListSafe().map((c) => ({
        id: c.id,
        名称: c.name,
        服务商: TTS_PROVIDER_SHORT[c.providerId] ?? c.providerId,
        密钥: c.hasSecret ? '已配置' : '未配置',
        可用: c.ready,
        可用模型: c.usableModels
      }))
      const connector = ctx.connector?.status() ?? null
      const stream = ctx.stream?.getStats() ?? null
      const poolStatus = ctx.pool.getStatus()

      const suggestions: string[] = []
      if (!active) suggestions.push('还没有选中节目：先在界面里选中一个节目（或外部调 program_activate）')
      if (!llmConnections.some((c) => c.可用)) {
        suggestions.push('没有可用的语言模型接入：让导演到设置 → 语言模型添加接入并填密钥')
      }
      if (!cfg.director.modelConnectionId || !cfg.director.model) {
        suggestions.push('导演大脑还没配：让导演到设置 → 语言模型给导演选接入和模型（导演不配上不了工）')
      }
      if (cast.length > 0 && cast.every((p) => !p.voiceId.trim())) {
        suggestions.push('节目卡司里的主播卡都没选音色：写词时逐条 role 会报错，先用 voice_list 给卡配音色')
      }
      if (!ttsConnections.some((c) => c.可用)) {
        suggestions.push('没有可用的语音合成接入：让导演到设置 → 语音合成补齐凭据')
      }
      if (cfg.tts.lastTestAt === 0) suggestions.push('还没测过发音：让导演在设置 → 语音合成点一次「测试发音」')
      if (connector && connector.state !== 'connected') {
        suggestions.push(`评论连接器未连接${connector.error ? `（${connector.error}）` : ''}：确认连接器在运行、设置里的端口和 Token 正确`)
      }
      if (cfg.stream.mode === 'direct' && (!cfg.stream.serverUrl || !cfg.stream.streamKey)) {
        suggestions.push('直推模式还没配推流地址/密钥：让导演到设置 → 接入 → 推流补齐')
      }
      if (status.assetsStale === 'prompt') {
        suggestions.push('人设/剧本/手册在会话启动后改过：点直播台黄条的「立即应用」热更新即生效，不用重开会话')
      } else if (status.assetsStale === 'brain') {
        suggestions.push('导演模型/接入在会话启动后改过：要重开会话才生效（点直播台黄条的「立即应用」，或下次开播自动应用）')
      }

      return JSON.stringify({
        节目: {
          当前节目: active ? active.name : null,
          播出中: status.live === true,
          主播会话: status.state === 'stopped' ? '未启动' : `${status.state}（${status.live ? '直播' : '写稿/待命'}）`,
          正在生成: status.busy === true,
          当前场景: status.scene ?? null
        },
        主播Agent: ctx.agent.status(),
        话术池: {
          未播队列: poolStatus.active,
          分车道: poolStatus.byLane,
          正在播: poolStatus.playing?.text ?? null
        },
        导演: { 名称: cfg.director.name, 模型: cfg.director.model || '（未配大脑）' },
        节目卡司: (() => {
          const program = ctx.script.getActive().program
          const ids = program?.presenterIds ?? []
          const members = ids
            .map((id) => cast.find((p) => p.id === id))
            .filter((p): p is NonNullable<typeof p> => Boolean(p))
          return members.length > 0
            ? {
                成员: members.map((p) => `${p.name}（${voiceLabel(p.voiceId)}）`),
                节目风格指令: program?.instruction || '（未配置）'
              }
            : '（未配卡司：写词时必须逐条用 speaker 指定主播卡 id）'
        })(),
        可用主播卡: cast.map((p) => `${p.name}（${p.id}）`),
        语言模型接入: llmConnections,
        语音合成接入: ttsConnections,
        评论连接器: connector
          ? { 状态: connector.state, 端口: connector.port, 已收事件: connector.receivedCount, 错误: connector.error }
          : '未初始化',
        RTMP推流: stream
          ? {
              模式: cfg.stream.mode === 'direct' ? '直推' : '伴侣采集',
              状态: stream.state,
              推流地址: cfg.stream.serverUrl ? '已配置' : '未配置',
              推流密钥: cfg.stream.streamKey ? '已配置' : '未配置',
              连接口令: cfg.comment.connectorToken ? '已配置' : '未配置',
              码率kbps: stream.bitrateKbps,
              错误: stream.error
            }
          : '未初始化',
        音频输出: '本机出声走系统默认输出设备（主进程音频管线，不枚举声卡）；直播伴侣采集系统声音',
        修复建议: suggestions.length > 0 ? suggestions : ['一切就绪']
      })
    }
  }),

  defineTool({
    name: 'stream_start',
    label: '开始推流',
    domain: 'agent',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '启动 RTMP 直推（对外副作用：开始向已配置的推流地址推送音频流，观众侧可见）。伴侣模式下不需要也调不了（声音由直播伴侣采集）。' +
      '第一次调用不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才执行。推流地址/密钥只能由导演在设置里填。' +
      '返回启动结果；推流状态用 status 看。停推流/停播出用 emergency_stop（紧急）或让导演在直播台操作。',
    parameters: Type.Object({
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡' }))
    }),
    handler: async (ctx, params) => {
      const stream = ctx.stream
      if (!stream) return '推流服务还没初始化'
      const stats = stream.getStats()
      if (stats.streaming) return '推流已经在进行中，不用重复启动'
      const cfg = ctx.storage.getConfig().stream
      if (cfg.mode === 'companion') {
        return '当前是伴侣模式：不需要启动推流进程，声音由直播伴侣采集系统声音。要直推 RTMP 得让导演在设置 → 接入 → 推流改成直推模式并填地址/密钥'
      }
      if (!cfg.serverUrl || !cfg.streamKey) {
        return '直推模式还没配推流地址或密钥：让导演到设置 → 接入 → 推流补齐（密钥我只看得到配没配，读不到也改不了内容）'
      }
      if (!params.confirmed) {
        return askConfirm(ctx, '启动 RTMP 直推：开始向已配置的推流地址推送音频流。\n对外副作用：观众侧可见。可随时在直播台停止。')
      }
      const result = await stream.start()
      return result.ok ? 'RTMP 推流已启动（直播中）' : `推流启动失败：${result.error}`
    }
  }),

  defineTool({
    name: 'emergency_stop',
    label: '紧急停止',
    domain: 'agent',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '紧急停止：安全优先，直接执行不用确认——掐断所有声音、暂停播报、停止主播会话，并立即通知导演。' +
      '说错话/内容违规/导演喊停时用。返回执行结果；恢复播出由导演确认后重新启动节目。',
    parameters: Type.Object({}),
    handler: async (ctx) => {
      try {
        await ctx.onEmergencyStop?.()
        ctx.notifyTimeline?.('—— 主播执行了紧急停止：声音已掐断、播报已暂停、会话已停止。恢复播出请导演确认后重新启动节目 ——')
        return '已紧急停止：所有声音掐断、播报暂停、会话停止。已立即执行并通知导演'
      } catch (error) {
        return `紧急停止执行出错：${error instanceof Error ? error.message : String(error)}（请导演立即在直播台手动停止）`
      }
    }
  })
]
