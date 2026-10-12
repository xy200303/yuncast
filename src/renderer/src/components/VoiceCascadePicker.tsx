import { useEffect, useMemo, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore } from '../stores/useAppStore'
import { TTS_PROVIDER_SHORT, type TtsConnectionSafe } from '../../../shared/types'
import { formatManualVoice, parseManualVoice } from '../../../shared/voiceProvider'

const NONE = '__none__'
/** 手动输入的伪分组（选它才显示输入框；产出 接入::模型::音色） */
const MANUAL = '__manual__'

/** 音色 id 是不是「接入::模型::音色」形式（官方没给音色目录的模型手动输入的写法） */
export function isManualVoiceId(voiceId: string): boolean {
  return parseManualVoice(voiceId) !== null
}

interface GroupOption {
  key: string
  label: string
  voices: { id: string; name: string; desc?: string }[]
}

/**
 * 级联式音色选择：接入 → 模型 → 分组 → 音色。
 * 系统音色与克隆音色在同一套级联里（克隆音色是「克隆音色」这一个分组），
 * 所以不再需要铺一大片按钮——占位就是一行下拉（分组只有一个时那一级自动收起）。
 *
 * 路由规则与之一致：音色严格绑定模型，模型属于某条接入；同一模型在多条接入里都启用时，
 * 这里选的是哪条接入就是哪条（不再有"默认接入"这种隐藏兜底）。
 */
export function VoiceCascadePicker({
  voiceId,
  onPick,
  onModelChange,
  connections,
  allowManual = true
}: {
  voiceId: string
  onPick: (voiceId: string) => void
  /** 受控方想同步知道当前选了哪个模型（例如接入测试弹窗） */
  onModelChange?: (modelId: string) => void
  /** 可选范围（测试弹窗只给那一条接入）；默认全部已配齐的接入 */
  connections?: TtsConnectionSafe[]
  allowManual?: boolean
}) {
  const allConnections = useAppStore((s) => s.ttsConnections)
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)

  const scope = useMemo(
    () => (connections ?? allConnections.filter((item) => item.usableModels.length > 0)),
    [connections, allConnections]
  )

  const [connectionId, setConnectionId] = useState('')
  const [modelId, setModelId] = useState('')
  const [groupKey, setGroupKey] = useState('')
  const [manualText, setManualText] = useState('')

  const connection = scope.find((item) => item.id === connectionId) ?? scope[0]

  /** 这条接入里「有音色可选」的模型：目录非空，或绑这条接入+模型且有就绪的克隆音色 */
  const modelOptions = useMemo(() => {
    if (!connection) return []
    const manifest = providers.find((item) => item.id === connection.providerId)
    return connection.models
      .map((item) => manifest?.models.find((spec) => spec.id === item.id))
      .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
      .map((spec) => {
        const clones = voices.filter(
          (voice) =>
            voice.status === 'ready' &&
            Boolean(voice.voiceType) &&
            voice.connectionId === connection.id &&
            voice.model === spec.id
        )
        return {
          id: spec.id,
          label: spec.label,
          hasVoices: spec.voices.length > 0 || clones.length > 0,
          groups: spec.voices.length
        }
      })
  }, [connection, providers, voices])

  const groups = useMemo<GroupOption[]>(() => {
    if (!connection || !modelId) return []
    const manifest = providers.find((item) => item.id === connection.providerId)
    const spec = manifest?.models.find((item) => item.id === modelId)
    const list: GroupOption[] = []
    const clones = voices.filter(
      (voice) =>
        voice.status === 'ready' &&
        Boolean(voice.voiceType) &&
        voice.connectionId === connection.id &&
        voice.model === modelId
    )
    if (clones.length > 0) {
      list.push({
        key: 'clone',
        label: '克隆音色',
        voices: clones.map((voice) => ({ id: voice.voiceType, name: voice.name }))
      })
    }
    for (const group of spec?.voices ?? []) {
      list.push({ key: group.label, label: group.label, voices: group.voices })
    }
    if (allowManual) list.push({ key: MANUAL, label: '手动输入…', voices: [] })
    return list
  }, [connection, modelId, providers, voices, allowManual])

  /** 外部给的 voiceId 落到级联的哪一层（克隆音色 / 目录音色 / 手动串都能对上） */
  useEffect(() => {
    if (!scope.length) return
    const id = voiceId.trim()
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) {
      const owner = scope.find((item) => item.id === clone.connectionId) ?? scope[0]
      setConnectionId(owner.id)
      setModelId(clone.model)
      setGroupKey('clone')
      return
    }
    const manual = parseManualVoice(id)
    if (manual && scope.some((item) => item.id === manual.connectionId)) {
      setConnectionId(manual.connectionId)
      setModelId(manual.modelId)
      setGroupKey(MANUAL)
      setManualText(manual.voice)
      return
    }
    for (const item of scope) {
      const manifest = providers.find((entry) => entry.id === item.providerId)
      for (const spec of manifest?.models ?? []) {
        const group = spec.voices.find((entry) => entry.voices.some((voice) => voice.id === id))
        if (group) {
          setConnectionId(item.id)
          setModelId(spec.id)
          setGroupKey(group.label)
          return
        }
      }
    }
    // 空音色或认不出来的值：停在第一层，让用户从目录里挑
    setConnectionId((prev) => prev || scope[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, scope, voices, providers])

  // 接入/模型变化后，把模型与分组对齐到合法值，并同步给父组件
  useEffect(() => {
    if (!connection) return
    const valid = modelOptions.find((item) => item.id === modelId)
    if (!valid) {
      // 默认落在「有音色可选」的第一个模型上：无音色目录的模型进来就得手填，先别让用户撞上
      const first = modelOptions.find((item) => item.hasVoices) ?? modelOptions[0]
      setModelId(first?.id ?? '')
      if (first) onModelChange?.(first.id)
      return
    }
    onModelChange?.(modelId)
    const allowed = groups.map((group) => group.key)
    if (allowed.length > 0 && !allowed.includes(groupKey)) setGroupKey(allowed[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, modelId, groups.map((group) => group.key).join('|')])

  const currentGroup = groups.find((group) => group.key === groupKey)
  const showGroupLevel = groups.filter((group) => group.key !== MANUAL).length > 1 || groupKey === MANUAL

  if (scope.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        还没有可用的语音接入：先到设置 → 语音合成加一条（填密钥、勾上要用的模型），才有音色可选。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {scope.length > 1 && (
          <Select
            value={connection?.id ?? ''}
            onValueChange={(value) => {
              setConnectionId(value)
              setGroupKey('')
              setManualText('')
            }}
          >
            <SelectTrigger className="h-8 min-w-40 flex-1 text-xs">
              <SelectValue placeholder="接入" />
            </SelectTrigger>
            <SelectContent>
              {scope.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className="flex items-center gap-2">
                    <ProviderIcon providerId={item.providerId} size="sm" />
                    {TTS_PROVIDER_SHORT[item.providerId]} · {item.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={modelId || NONE}
          onValueChange={(value) => {
            setModelId(value === NONE ? '' : value)
            setGroupKey('')
            setManualText('')
          }}
        >
          <SelectTrigger className="h-8 min-w-36 flex-1 text-xs">
            <SelectValue placeholder="模型" />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.length === 0 && (
              <SelectItem value={NONE}>这条接入没有可选的模型</SelectItem>
            )}
            {modelOptions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
                {item.hasVoices ? '' : '（无音色目录）'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {showGroupLevel && (
          <Select value={groupKey || NONE} onValueChange={setGroupKey}>
            <SelectTrigger className="h-8 min-w-32 flex-1 text-xs">
              <SelectValue placeholder="分组" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectItem key={group.key} value={group.key}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {groupKey !== MANUAL && (
          <Select
            value={currentGroup?.voices.some((voice) => voice.id === voiceId) ? voiceId : NONE}
            onValueChange={(value) => onPick(value === NONE ? '' : value)}
          >
            <SelectTrigger className="h-8 min-w-32 flex-1 text-xs">
              <SelectValue placeholder="音色" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>留空（用该模型第一个音色）</SelectItem>
              {(currentGroup?.voices ?? []).map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  {voice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {groupKey === MANUAL && (
        <div>
          <Input
            className="h-8 text-xs"
            value={manualText}
            placeholder="官方没给目录的音色 id，例如 longanhuan_v3.6"
            onChange={(e) => {
              setManualText(e.target.value)
              const value = e.target.value.trim()
              onPick(
                value
                  ? formatManualVoice({
                      connectionId: connection?.id ?? '',
                      modelId,
                      voice: value
                    })
                  : ''
              )
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            会存成「接入::模型::音色」，合成时按它找接入与模型
          </p>
        </div>
      )}

      {groupKey !== MANUAL && (currentGroup?.voices.length ?? 0) === 0 && (
        <p className="text-[13px] text-muted-foreground">
          这个模型没有内置音色目录：选「手动输入…」按 接入::模型::音色 填，或到音色库克隆一个。
        </p>
      )}

      {voiceId && isManualVoiceId(voiceId) && groupKey !== MANUAL && (
        <p className="text-[13px] text-muted-foreground">当前：{voiceId}</p>
      )}
    </div>
  )
}
