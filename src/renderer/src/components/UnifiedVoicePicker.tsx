import { useMemo, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore } from '../stores/useAppStore'
import { TTS_MODEL_KIND_LABEL, type TtsConnectionSafe, type TtsModelSpec } from '../../../shared/types'
import { formatManualVoice, parseManualVoice } from '../../../shared/voiceProvider'
import { ModelBadgeIcons } from '@/components/ModelBadgeIcons'
import { ttsModelBadges } from '../lib/modelBadges'

const NONE_VALUE = '__none__'
const MANUAL_VALUE = '__manual__'

/** 三段选择：接入 / 模型 / 是否手动输入；draft 手动模式下的输入框内容 */
interface PickState {
  connId: string
  mdlId: string
  manual: boolean
  draft: string
}

/** 用户最近一次交互留下的选择；base 是操作那一刻的外部 voiceId，用来判断外部有没有给出新值 */
interface LocalPick {
  base: string
  sel: PickState
}

const EMPTY_PICK: PickState = { connId: '', mdlId: '', manual: false, draft: '' }

/**
 * 统一音色选择器（docs/REDESIGN 4.4a，全局共享）：三段式「服务商（接入）→ 模型 → 音色」，
 * 任何需要选音色的地方都用它。音色严格绑定「接入 + 模型」：
 * - 音色下拉 = 该接入 + 模型下已登记的音色（音色库克隆音色 + 系统音色目录 manifest）；
 * - 选「手动输入音色 ID」出现输入框，粘贴服务商控制台里的原始 ID——手动 ID 也挂在选好的接入与模型下，
 *   值存成 `接入::模型::音色` 复合串（shared/voiceProvider），合成路由（TtsService.routeManual）按它走，不再是孤儿 voiceId。
 *
 * 输出值：onPick 给出完整可路由的 voiceId（克隆 voiceType / 目录音色 id / 手动复合串），
 * onModelChange 顺带报出生效模型 id（接入测试弹窗这类需要模型的地方用）。
 */
export function UnifiedVoicePicker({
  voiceId,
  onPick,
  onModelChange,
  connections,
  fixedModelId,
  allowManual = true,
  emptyLabel,
  placeholder = '选择音色'
}: {
  voiceId: string
  onPick: (voiceId: string) => void
  onModelChange?: (modelId: string, connectionId: string) => void
  /** 可选范围（测试弹窗只给那一条接入；播客主持人锁定到选中的接入）；默认全部有可用模型的接入 */
  connections?: TtsConnectionSafe[]
  /** 锁定模型（播客主持人音色必须挂在选中的播客模型下）：模型下拉禁用并固定为这个 */
  fixedModelId?: string
  allowManual?: boolean
  /** 允许清空（如「留空用主播自己的音色」）：传了就在音色下拉第一项放这个选项 */
  emptyLabel?: string
  placeholder?: string
}) {
  const allConnections = useAppStore((s) => s.ttsConnections)
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)

  // 可选范围按「接入 id 串」记忆：调用方常传内联数组，按引用算会在每次渲染时重算
  const scoped = connections ?? allConnections.filter((item) => item.usableModels.length > 0)
  const scopeKey = scoped.map((item) => item.id).join('|')
  const scope = useMemo(
    () => scoped.slice().sort((a, b) => a.createdAt - b.createdAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey]
  )

  const [localPick, setLocalPick] = useState<LocalPick | null>(null)
  /** 手动输入框里用户敲的原文，按它对应的复合串记：外部 voiceId 还是这次输入的结果就显示原文，免得敲到一半的空白被格式化抹掉 */
  const [typed, setTyped] = useState<{ id: string; text: string }>({ id: '', text: '' })

  const specOf = (connection: TtsConnectionSafe | undefined, modelId: string): TtsModelSpec | undefined =>
    providers.find((item) => item.id === connection?.providerId)?.models.find((model) => model.id === modelId)

  const sourceId = voiceId.trim()

  /** 反查：voiceId → 三段选择（克隆音色 / 手动复合串 / 目录音色都能对上）。用户动作与外部给的 voiceId 共用同一条规则，算出来的结果一致 */
  const resolvePick = (id: string): PickState | null => {
    if (!id) return null
    const clone = voices.find((voice) => voice.voiceType === id)
    if (clone && scope.some((item) => item.id === clone.connectionId)) {
      return { connId: clone.connectionId, mdlId: clone.model, manual: false, draft: '' }
    }
    const ref = parseManualVoice(id)
    if (ref && scope.some((item) => item.id === ref.connectionId)) {
      return { connId: ref.connectionId, mdlId: ref.modelId, manual: true, draft: ref.voice }
    }
    for (const connection of scope) {
      for (const modelId of connection.usableModels) {
        const spec = specOf(connection, modelId)
        if (spec?.voices.some((group) => group.voices.some((voice) => voice.id === id))) {
          return { connId: connection.id, mdlId: modelId, manual: false, draft: '' }
        }
      }
    }
    return null
  }

  /** 外部 voiceId 反查出的三段选择：渲染期直接算，不再用 effect 把 prop 抄进 state——抄一遍会让用户在 effect 落地前看到旧值 */
  const externalPick = useMemo(
    () => resolvePick(sourceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId, scopeKey, voices, providers]
  )

  /**
   * 生效的三段选择 = 外部反查结果（父层给的 voiceId 就是事实）；用户刚操作、父层还没接住（如切接入时 onPick('') 尚未生效）时保留用户的选择，
   * 不然回拉会把刚选的接入冲掉。base 记的是用户操作那一刻的 voiceId：外部给出新值才让反查结果接管，等价于原来「只在来源变了才重置」。
   */
  const sel: PickState =
    localPick && localPick.base === sourceId ? localPick.sel : (externalPick ?? localPick?.sel ?? EMPTY_PICK)

  // 生效的接入与模型：没选过（或选过的已被删）就取范围里第一个，只读不回写
  const connection = scope.find((item) => item.id === sel.connId) ?? scope[0]
  const modelId =
    fixedModelId && connection?.usableModels.includes(fixedModelId)
      ? fixedModelId
      : connection && connection.usableModels.includes(sel.mdlId)
        ? sel.mdlId
        : (connection?.usableModels[0] ?? '')
  const spec = specOf(connection, modelId)

  /** 当前接入 + 模型下的已登记音色：克隆音色一组（音色库，ready 且有产物），目录分组原样展开 */
  const cloneVoices = useMemo(
    () =>
      voices.filter(
        (voice) =>
          voice.status === 'ready' &&
          Boolean(voice.voiceType) &&
          voice.connectionId === connection?.id &&
          voice.model === modelId
      ),
    [voices, connection?.id, modelId]
  )

  /** 旧数据裸 voiceId（查不到归属）：摆一个禁用项让它显示出来并提示重选，不静默吞掉 */
  const unknownId = useMemo(() => {
    const id = voiceId.trim()
    if (!id || parseManualVoice(id)) return ''
    if (voices.some((voice) => voice.voiceType === id)) return ''
    if (spec?.voices.some((group) => group.voices.some((voice) => voice.id === id))) return ''
    // 目录音色可能在别的接入/模型下（反查出的那对不一定是当前显示的这一对）
    const inCatalog = scope.some((conn) =>
      conn.usableModels.some((m) => specOf(conn, m)?.voices.some((group) => group.voices.some((voice) => voice.id === id)))
    )
    return inCatalog ? '' : id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, voices, spec, scopeKey])

  if (scope.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        还没有可用的语音接入：先到设置 → 语音合成加一条（填密钥、勾上要用的模型），才有音色可选。
      </p>
    )
  }

  const changeConnection = (id: string): void => {
    setLocalPick({ base: sourceId, sel: { connId: id, mdlId: '', manual: false, draft: '' } })
    onPick('')
    const next = scope.find((item) => item.id === id)
    onModelChange?.(next?.usableModels[0] ?? '', id)
  }

  const changeModel = (id: string): void => {
    setLocalPick({ base: sourceId, sel: { ...sel, mdlId: id, manual: false, draft: '' } })
    onPick('')
    if (connection) onModelChange?.(id, connection.id)
  }

  const changeVoice = (value: string): void => {
    if (value === NONE_VALUE) {
      setLocalPick({ base: sourceId, sel: { ...sel, manual: false } })
      onPick('')
      return
    }
    if (value === MANUAL_VALUE) {
      setLocalPick({ base: sourceId, sel: { ...sel, manual: true, draft: '' } })
      onPick('')
      return
    }
    setLocalPick({ base: sourceId, sel: { ...sel, manual: false } })
    onPick(value)
    // 目录音色可能挂在别的接入/模型下：生效模型按反查结果直接报给调用方（原来由回拉 effect 顺带报）
    const picked = resolvePick(value)
    if (picked) onModelChange?.(picked.mdlId, picked.connId)
  }

  const typeManual = (value: string): void => {
    const trimmed = value.trim()
    const next =
      trimmed && connection && modelId
        ? formatManualVoice({ connectionId: connection.id, modelId, voice: trimmed })
        : ''
    setTyped({ id: next, text: value })
    setLocalPick({ base: sourceId, sel: { ...sel, manual: true, draft: value } })
    onPick(next)
    // 手动 ID 就挂在上面那对「接入 + 模型」下：生效模型跟着报一次（原来由回拉 effect 顺带报）
    if (next && connection) onModelChange?.(modelId, connection.id)
  }

  const voiceValue = sel.manual ? MANUAL_VALUE : sourceId
  const manualText = typed.id === sourceId ? typed.text : sel.draft

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* 服务商（接入） */}
        <Select value={connection?.id ?? ''} onValueChange={changeConnection}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" title="服务商接入">
            <SelectValue placeholder="服务商" />
          </SelectTrigger>
          <SelectContent>
            {scope.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                <span className="flex items-center gap-1.5">
                  <ProviderIcon providerId={item.providerId} size="sm" />
                  <span className="truncate">{item.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 模型（锁定 = 播客主持人这类必须挂在指定模型下的场景） */}
        <Select value={modelId} onValueChange={changeModel} disabled={Boolean(fixedModelId)}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" title="模型">
            <SelectValue placeholder="模型" />
          </SelectTrigger>
          <SelectContent>
            {connection?.usableModels.map((id) => {
              const modelSpec = specOf(connection, id)
              const kind = modelSpec?.capabilities?.kind ?? 'standard'
              return (
                <SelectItem key={id} value={id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">
                      {modelSpec?.label ?? id}
                      {kind === 'standard' ? '' : `（${TTS_MODEL_KIND_LABEL[kind]}）`}
                    </span>
                    <ModelBadgeIcons spec={modelSpec} max={4} />
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        {/* 音色：该接入 + 模型下已登记的音色 + 手动输入 */}
        <Select value={voiceValue} onValueChange={changeVoice}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" title="音色">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {emptyLabel && <SelectItem value={NONE_VALUE}>{emptyLabel}</SelectItem>}
            {unknownId && (
              <SelectItem value={unknownId} disabled>
                「{unknownId.length > 14 ? `${unknownId.slice(0, 14)}…` : unknownId}」需重选
              </SelectItem>
            )}
            {cloneVoices.length > 0 && (
              <SelectGroup>
                <SelectLabel className="flex items-center gap-2">
                  克隆音色（音色库）
                  <ModelBadgeIcons spec={spec} />
                </SelectLabel>
                {cloneVoices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.voiceType}>
                    {voice.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {spec?.voices.map(
              (group) =>
                group.voices.length > 0 && (
                  <SelectGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )
            )}
            {allowManual && <SelectItem value={MANUAL_VALUE}>手动输入音色 ID…</SelectItem>}
            {!allowManual && cloneVoices.length === 0 && (spec?.voices.length ?? 0) === 0 && !unknownId && (
              <SelectItem value="__empty__" disabled>
                这个模型下还没有已登记音色
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* 当前生效模型能干什么：纯图标 + tooltip（含义见 lib/modelBadges），没能力位就不画这行 */}
      {spec && ttsModelBadges(spec).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">这把嗓子：</span>
          <ModelBadgeIcons spec={spec} />
        </div>
      )}

      {sel.manual && (
        <div className="flex flex-col gap-1">
          <Input
            className="h-8 text-xs"
            value={manualText}
            autoFocus
            placeholder="粘贴服务商控制台里的原始 ID"
            onChange={(e) => typeManual(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            粘贴服务商控制台里的原始 ID（如火山的 speaker ID / 百炼的 voice id），会挂在上面选好的接入与模型下
          </p>
        </div>
      )}
    </div>
  )
}
