import { randomUUID } from 'node:crypto'
import type { LiveEvent, Trigger, TriggerInput } from '../../shared/types'
import type { StorageService } from './StorageService'
import type { EventBus } from './EventBus'
import type { SpeechPool } from './SpeechPool'
import type { AgentService, ProgramGate } from './AgentService'

/**
 * 触发器运行时（docs/01 §3.5）：事件 → 过滤 → 聚合 → 冷却 → 单场预算 → 全局 LLM 速率帽 → 执行。
 * 三种模式：tool（模板直连话术池，确定性操作不过 LLM，保留给安全/纯控制类）、
 * steer / task（内容类：不直接生成固定对外话术，渲染后的通知文本进直播间动态收件箱，由主播决定回应——docs/10 §5.4）。
 */

/** 模板插值：{{payload.xxx}} / {{aggregated.count}} / {{aggregated.list}} / {{aggregated.latest.xxx}} */
export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
  aggregated?: { count: number; list: string[]; latest: Record<string, unknown> }
): string {
  const dig = (obj: Record<string, unknown>, keys: string[]): unknown =>
    keys.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, path: string) => {
    const [root, ...rest] = path.split('.')
    let value: unknown
    if (root === 'payload') {
      value = dig(payload, rest)
    } else if (root === 'aggregated' && aggregated) {
      if (rest[0] === 'count') value = aggregated.count
      else if (rest[0] === 'list') value = aggregated.list.join('、')
      else if (rest[0] === 'latest') value = dig(aggregated.latest, rest.slice(1))
    } else {
      return raw
    }
    if (value === undefined || value === null) return raw
    return String(value)
  })
}

/** 条件过滤：键值相等命中；键以 Min 结尾表示数值下限 */
export function matchFilter(filter: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  if (!filter) return true
  for (const [key, expected] of Object.entries(filter)) {
    if (key.endsWith('Min')) {
      const field = key.slice(0, -3)
      const actual = payload[field]
      if (typeof actual !== 'number' || actual < Number(expected)) return false
    } else if (payload[key] !== expected) {
      return false
    }
  }
  return true
}

interface AggregateBuffer {
  payloads: Record<string, unknown>[]
  timer: ReturnType<typeof setTimeout>
}

/**
 * 旧版默认模板（模板升级迁移用）：播种时若库里的模板还跟这些一字不差，
 * 说明用户没改过，跟着升级到新版；改过的一律不动。
 */
const LEGACY_TEMPLATES: Record<string, string[]> = {
  冷场自救: [
    '话术池空了，直播不能冷场。主动带节奏：用 say 补 2-3 句（聊产品、唠家常、做互动都行），别和最近播过的重复。'
  ],
  价格变动提醒: [
    '商品「{{payload.name}}」的价格从 ¥{{payload.oldPrice}} 改成了 ¥{{payload.newPrice}}。用 get_pool_status 看看池里还没播的话术，凡是报价口径不对的用 revise_item 改掉；没有要改的就照常继续，不用特意播报。'
  ],
  点赞里程碑: ['点赞破 {{payload.count}} 了，谢谢家人们！']
}

/**
 * 默认关闭的内建触发器（定时闹钟类：没事也叫 agent，白烧 token）。
 * 老库里的行如果模板还是内置默认（用户没改过），启动时跟着关；改过的尊重用户。
 */
const BUILTIN_DEFAULT_DISABLED = new Set(['整点带节奏'])

/**
 * 已下线的内建触发器：模板没改过的旧行直接删掉。
 * 开场白下线——开场由底稿 hook 段承担（按 seq 第一个播，预合成零 token），
 * 不再让 agent 例行 say（烧 token、刷对话区、还和底稿重复）
 */
const BUILTIN_REMOVED: Record<string, string> = {
  开场白:
    '直播开始了。用 say 工具来一段开场白：打招呼、说说今天在播什么、号召大家点点关注，然后按自己的节奏再补 1-2 句常规话术。'
}

/** 内建触发器模板（首次启动播种，用户可关可改） */
export function builtinTriggers(): TriggerInput[] {
  return [
    {
      name: '欢迎新人',
      enabled: true,
      on: { event: 'viewer.join' },
      target: {
        agentId: 'anchor',
        mode: 'task',
        promptTemplate:
          '刚进场的朋友：{{aggregated.list}}。用 insert_next 或 say 欢迎他们（人多就点名 1-2 个，说「欢迎 xx 等几位朋友」），自然一点，别打断自己的节奏。'
      },
      throttle: { aggregateMs: 5000, aggregateAs: 'list', cooldownMs: 60_000, maxPerSession: 10 }
    },
    {
      name: '送礼感谢',
      enabled: true,
      on: { event: 'gift.received' },
      target: {
        agentId: 'anchor',
        mode: 'tool',
        toolAction: { template: '感谢 {{payload.author}} 送的 {{payload.giftName}}！', lane: 'next' }
      }
    },
    {
      name: '点赞里程碑',
      enabled: true,
      on: { event: 'like.burst' },
      target: {
        agentId: 'anchor',
        mode: 'tool',
        toolAction: { template: '点赞破 {{payload.count}} 了，多谢诸位捧场！', lane: 'normal' }
      },
      throttle: { cooldownMs: 120_000 }
    },
    {
      name: '冷场自救',
      enabled: true,
      on: { event: 'pool.empty' },
      target: {
        agentId: 'anchor',
        mode: 'steer',
        promptTemplate:
          '话术池空了。先用 get_pool_status 看一眼：如果底稿刚装回来（池里有存货），按节奏播就行，不用补；真的没存货了再用 say 补 2-3 句（聊产品、唠家常、做互动都行），别和最近播过的重复。'
      },
      throttle: { cooldownMs: 120_000 }
    },
    {
      name: '续写补给',
      enabled: true,
      on: { event: 'pool.low' },
      target: {
        agentId: 'anchor',
        mode: 'steer',
        promptTemplate:
          '话术池只剩 {{payload.remaining}} 段了，撑不了几分钟。list_drafts 看看底稿库：还有没轮到的存货就按节奏播（循环会接上）；存货见底了就现场写一个新桥段直接 say 播出——接着刚才的内容往下讲，返场不返词，别冷场。'
      },
      throttle: { cooldownMs: 180_000 }
    },
    {
      name: '整点带节奏',
      // 默认关：定时叫醒 agent 是「没事也运行」的 token 元凶（两小时白烧十几轮）。
      // 低水位有「续写补给」、互动有评论攒批，节奏不需要闹钟；想要节拍器再手动开
      enabled: false,
      on: { event: 'timer.interval' },
      target: {
        agentId: 'anchor',
        mode: 'task',
        promptTemplate:
          '直播进行一段时间了。先用 get_pool_status 看看话术池存货，再决定：补几句产品话术、做一波互动，还是继续当前节奏。别重复最近播过的。'
      },
      throttle: { maxPerSession: 12 }
    },
    {
      name: '价格变动提醒',
      enabled: true,
      on: { event: 'product.price_changed' },
      target: {
        agentId: 'anchor',
        mode: 'task',
        promptTemplate:
          '商品「{{payload.name}}」的价格从 ¥{{payload.oldPrice}} 改成了 ¥{{payload.newPrice}}。用 get_pool_status 看看池里还没播的话术，凡是报价口径不对的用 revise_item 改掉；再用 list_drafts 搜旧价格，底稿库里同口径的用 edit_draft 改掉（长期生效）。没有要改的就照常继续，不用特意播报。'
      },
      throttle: { cooldownMs: 10_000 }
    }
  ]
}

/** 直播动态事件（节目 allowLiveEvents=false 时整类不派）：评论/进场/礼物/点赞 */
const LIVE_DYNAMIC_EVENTS = new Set(['comment.new', 'viewer.join', 'gift.received', 'like.burst'])

export class TriggerRuntime {
  private triggers: Trigger[] = []
  /** 每个触发器的冷却起点 */
  private lastFiredAt = new Map<string, number>()
  /** 单场已触发次数（stream.started 重置） */
  private firedThisSession = new Map<string, number>()
  /** 聚合窗口缓冲 */
  private buffers = new Map<string, AggregateBuffer>()
  /** 全局 LLM 速率帽：滑动窗口时间戳 */
  private llmFiredAt: number[] = []
  /**
   * 节目事件接线（index.ts 接上，通常指向 AgentService.currentProgramGate）：
   * allowLiveEvents=false → 评论/进场/礼物/点赞等动态事件不进触发器；
   * enabledTriggerIds → 只响节目勾选的触发器（没选节目 = 一个都不响）
   */
  gateProvider: (() => ProgramGate | null) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly bus: EventBus,
    private readonly pool: SpeechPool,
    private readonly agent: AgentService
  ) {
    this.seedMissingBuiltins()
    this.reload()
    bus.subscribe((event) => this.onEvent(event))
  }

  /** 内建触发器按名播种：库里缺的补上；模板升级时，没被用户改过的旧默认模板跟着换新版 */
  private seedMissingBuiltins(): void {
    const byName = new Map(this.storage.triggerList().map((t) => [t.name, t]))
    // 已下线的内建触发器：模板没改过的旧行清掉
    for (const [name, template] of Object.entries(BUILTIN_REMOVED)) {
      const row = byName.get(name)
      if (row && (row.target.promptTemplate ?? '') === template) this.storage.triggerDelete(row.id)
    }
    for (const input of builtinTriggers()) {
      const row = byName.get(input.name)
      if (!row) {
        this.storage.triggerSave({ ...input, id: `tr-${randomUUID().replace(/-/g, '').slice(0, 10)}` })
        continue
      }
      // 默认关的内建触发器：模板没改过的旧行跟着关
      if (
        BUILTIN_DEFAULT_DISABLED.has(input.name) &&
        row.enabled &&
        (row.target.promptTemplate ?? '') === (input.target.promptTemplate ?? '')
      ) {
        this.storage.triggerSave({ ...row, enabled: false })
        row.enabled = false
      }
      const legacy = LEGACY_TEMPLATES[input.name]
      // steer/task 的模板在 promptTemplate，tool 直连的在 toolAction.template——两处都可能藏着旧默认
      const isTool = row.target.mode === 'tool'
      const rowTemplate = (isTool ? row.target.toolAction?.template : row.target.promptTemplate) ?? ''
      if (legacy?.includes(rowTemplate)) {
        this.storage.triggerSave({
          ...row,
          target: isTool
            ? {
                ...row.target,
                toolAction: {
                  template: input.target.toolAction?.template ?? '',
                  lane: row.target.toolAction?.lane ?? input.target.toolAction?.lane ?? 'normal'
                }
              }
            : { ...row.target, promptTemplate: input.target.promptTemplate }
        })
      }
    }
  }

  reload(): void {
    this.triggers = this.storage.triggerList()
  }

  list(): Trigger[] {
    return this.triggers
  }

  save(input: TriggerInput): Trigger {
    const trigger: Trigger = { ...input, id: input.id ?? `tr-${randomUUID().replace(/-/g, '').slice(0, 10)}` }
    this.storage.triggerSave(trigger)
    this.reload()
    return trigger
  }

  remove(id: string): void {
    this.storage.triggerDelete(id)
    this.buffers.get(id)?.timer && clearTimeout(this.buffers.get(id)!.timer)
    this.buffers.delete(id)
    this.reload()
  }

  toggle(id: string, enabled: boolean): void {
    const trigger = this.triggers.find((t) => t.id === id)
    if (!trigger) return
    this.storage.triggerSave({ ...trigger, enabled })
    this.reload()
  }

  dispose(): void {
    for (const buffer of this.buffers.values()) clearTimeout(buffer.timer)
    this.buffers.clear()
  }

  // ---------- 事件处理 ----------

  private onEvent(event: LiveEvent): void {
    // 开播重置单场预算
    if (event.type === 'stream.started') this.firedThisSession.clear()

    // 节目事件接线总闸：节目关闭直播事件时，评论/进场/礼物/点赞这类动态事件一概不进触发器；
    // stream.started（开播信号）与 pool.empty/pool.low（自家水位）不是观众动态，照常放行
    const gate = this.gateProvider?.()
    if (gate && !gate.allowLiveEvents && LIVE_DYNAMIC_EVENTS.has(event.type)) return

    for (const trigger of this.triggers) {
      if (!trigger.enabled || trigger.on.event !== event.type) continue
      // 节目触发器白名单：节目只勾选了一部分触发器时，其余的一律不响（没接线 = 全不响）
      if (!gate?.enabledTriggerIds.includes(trigger.id)) continue
      // 第一道：条件过滤
      if (!matchFilter(trigger.on.filter, event.payload)) continue

      // 第二道：聚合窗口（攒批，窗口结束时再走后面的防护）
      if (trigger.throttle?.aggregateMs) {
        this.bufferEvent(trigger, event)
        continue
      }
      this.fire(trigger, event.payload, this.aggregateOf([event.payload], trigger.throttle?.aggregateAs))
    }
  }

  private bufferEvent(trigger: Trigger, event: LiveEvent): void {
    const existing = this.buffers.get(trigger.id)
    if (existing) {
      existing.payloads.push(event.payload)
      return
    }
    const buffer: AggregateBuffer = {
      payloads: [event.payload],
      timer: setTimeout(() => {
        this.buffers.delete(trigger.id)
        // 聚合窗口结束，继续走冷却/预算/速率帽
        this.fire(trigger, event.payload, this.aggregateOf(buffer.payloads, trigger.throttle?.aggregateAs))
      }, trigger.throttle!.aggregateMs!)
    }
    this.buffers.set(trigger.id, buffer)
  }

  /** 聚合形态：list=名单列表 / count=计数 / latest=只留最新 */
  private aggregateOf(
    payloads: Record<string, unknown>[],
    as?: 'list' | 'count' | 'latest'
  ): { count: number; list: string[]; latest: Record<string, unknown> } {
    const latest = payloads[payloads.length - 1] ?? {}
    const names = payloads.map((p) => String(p.author ?? p.name ?? '')).filter(Boolean)
    return {
      count: payloads.length,
      list: as === 'count' ? [] : as === 'latest' ? names.slice(-1) : names,
      latest
    }
  }

  private fire(
    trigger: Trigger,
    payload: Record<string, unknown>,
    aggregated: { count: number; list: string[]; latest: Record<string, unknown> }
  ): void {
    const now = Date.now()

    // 第三道：冷却
    const cooldown = trigger.throttle?.cooldownMs ?? 0
    const lastAt = this.lastFiredAt.get(trigger.id) ?? 0
    if (cooldown > 0 && now - lastAt < cooldown) return this.drop(trigger, '冷却中')

    // 第四道：单场预算
    const budget = trigger.throttle?.maxPerSession
    if (budget !== undefined && (this.firedThisSession.get(trigger.id) ?? 0) >= budget) {
      return this.drop(trigger, '单场预算用完')
    }

    // 第五道：全局 LLM 速率帽（tool 模式不过 LLM，不受帽限制）
    const useLlm = trigger.target.mode !== 'tool'
    if (useLlm) {
      const cap = this.storage.getConfig().trigger.maxLlmPerMinute
      this.llmFiredAt = this.llmFiredAt.filter((ts) => now - ts < 60_000)
      if (this.llmFiredAt.length >= cap) return this.drop(trigger, 'LLM 速率帽')
    }

    this.lastFiredAt.set(trigger.id, now)
    this.firedThisSession.set(trigger.id, (this.firedThisSession.get(trigger.id) ?? 0) + 1)
    if (useLlm) this.llmFiredAt.push(now)
    this.bus.emit('trigger.fired', { triggerId: trigger.id, name: trigger.name, mode: trigger.target.mode }, 'system')
    this.execute(trigger, payload, aggregated)
  }

  private drop(trigger: Trigger, reason: string): void {
    console.error(`[AgentAnchor] 触发器「${trigger.name}」被拦截：${reason}`)
    this.bus.emit('trigger.dropped', { triggerId: trigger.id, name: trigger.name, reason }, 'system')
  }

  private execute(
    trigger: Trigger,
    payload: Record<string, unknown>,
    aggregated: { count: number; list: string[]; latest: Record<string, unknown> }
  ): void {
    const { mode, toolAction, promptTemplate } = trigger.target
    if (mode === 'tool') {
      // 模板直连话术池，确定性动作不过 LLM
      const text = renderTemplate(toolAction?.template ?? '', payload, aggregated).trim()
      if (!text || text.includes('{{')) return // 模板渲染不完整（缺字段）就别播
      try {
        this.pool.say({
          text,
          lane: toolAction?.lane ?? 'normal',
          sourceAgentId: `trigger:${trigger.id}`,
          sourceKind: 'interact',
          voiceId: this.agent.currentVoice() || undefined
        })
      } catch (error) {
        console.error(`[AgentAnchor] 触发器「${trigger.name}」入池失败:`, error)
      }
      return
    }
    const prompt = renderTemplate(promptTemplate ?? '', payload, aggregated).trim()
    if (!prompt) return
    // 内容类触发器（docs/10 §5.4）：不再直接派固定话术任务，统一进直播间动态收件箱，
    // 攒批/限速/防轰炸由收件箱管；立即回、稍后回还是忽略由主播决定
    try {
      this.agent.pushTriggerEvent(trigger.name, prompt)
    } catch (error) {
      console.error(`[AgentAnchor] 触发器「${trigger.name}」投递失败:`, error)
      this.bus.emit('trigger.dropped', { triggerId: trigger.id, name: trigger.name, reason: 'agent 不可用' }, 'system')
    }
  }
}
