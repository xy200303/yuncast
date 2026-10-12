import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore } from '../stores/useAppStore'
import { TTS_PROVIDER_SHORT, type TtsConnectionSafe } from '../../../shared/types'
import { formatManualVoice, parseManualVoice } from '../../../shared/voiceProvider'

const NONE = '__none__'

interface VoiceOption {
  id: string
  name: string
}

/**
 * 音色选择：**先选模型，再选音色**（分组在音色下拉里以分组标题展开），需要时切手动输入。
 *
 * 为什么不用自绘的级联面板：音色数量是几百个（火山 2.0 有 244 个），铺开占半屏，
 * 所以收进下拉；而 Radix Select 是项目里到处在用的成熟组件（键盘可达、分组、滚动都现成），
 * 自己画一个多列面板反而容易在状态同步上翻车。
 *
 * - 音色下拉里：克隆音色、各场景分组用 SelectGroup 展开，一次只显示一列，滚动即可
 * - 官方没给音色目录的模型（qwen-audio-3.x / cosyvoice-v3.5）自动切到手动输入，
 *   产出 `接入::模型::音色`（合成路由按这个前缀找接入与模型）
 * - 接入只在有多条时出现；音色严格绑定模型，选了哪个模型的音色就走那条接入与该模型
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
  /** 受控方想同步知道当前选的模型（例如接入测试弹窗） */
  onModelChange?: (modelId: string) => void
  /** 可选范围（测试弹窗只给那一条接入）；默认全部有可用模型的接入 */
  connections?: TtsConnectionSafe[]
  allowManual?: boolean
}) {
  const allConnections = useAppStore((s) => s.ttsConnections)
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)

  // 只按 id 组成判断范围（调用方常传内联数组，按引用算会在每次渲染时重算并把选择冲掉）
  const scoped = connections ?? allConnections.filter((item) => item.usableModels.length > 0)
  const scopeKey = scoped.map((item) => item.id).join('|')
  const scope = useMemo(
    () => scoped.slice(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey]
  )

  const [connectionId, setConnectionId] = useState('')
  const [modelId, setModelId] = useState('')
  /** 手动输入模式：模型没有音色目录时自动开，也可以手动切 */
  const [manual, setManual] = useState(false)
  const [manualDraft, setManualDraft] = useState('')

  const connection = scope.find((item) => item.id === connectionId) ?? scope[0]
  const manifest = providers.find((item) => item.id === connection?.providerId)
  const modelSpec = manifest?.models.find((spec) => spec.id === modelId)

  const modelOptions = useMemo(
    () =>
      (connection?.models ?? [])
        .map((item) => manifest?.models.find((spec) => spec.id === item.id))
        .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec)),
    [connection, manifest]
  )

  /** 音色下拉里的分组：克隆音色 + 各场景分组（一次只列一列，滚动即可） */
  const voiceGroups = useMemo(() => {
    if (!connection || !modelId) return [] as { label: string; voices: VoiceOption[] }[]
    const list: { label: string; voices: VoiceOption[] }[] = []
    const clones = voices.filter(
      (voice) =>
        voice.status === 'ready' &&
        Boolean(voice.voiceType) &&
        voice.connectionId === connection.id &&
        voice.model === modelId
    )
    if (clones.length > 0) {
      list.push({
        label: '克隆音色',
        voices: clones.map((voice) => ({ id: voice.voiceType, name: voice.name }))
      })
    }
    for (const group of modelSpec?.voices ?? []) {
      if (group.voices.length > 0) list.push({ label: group.label, voices: group.voices })
    }
    return list
  }, [connection, modelId, modelSpec, voices])

  const hasCatalog = voiceGroups.length > 0

  /** 外部 voiceId 落回「接入 + 模型 + 是否手动」；只在音色或范围变化时重算，不跟着每次渲染重置 */
  useEffect(() => {
    if (scope.length === 0) return
    const id = voiceId.trim()
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) {
      setConnectionId(clone.connectionId || scope[0].id)
      setModelId(clone.model)
      setManual(false)
      return
    }
    const manualRef = parseManualVoice(id)
    if (manualRef && scope.some((item) => item.id === manualRef.connectionId)) {
      setConnectionId(manualRef.connectionId)
      setModelId(manualRef.modelId)
      setManual(true)
      setManualDraft(manualRef.voice)
      return
    }
    for (const item of scope) {
      const itemManifest = providers.find((entry) => entry.id === item.providerId)
      for (const spec of itemManifest?.models ?? []) {
        if (spec.voices.some((group) => group.voices.some((voice) => voice.id === id))) {
          setConnectionId(item.id)
          setModelId(spec.id)
          setManual(false)
          return
        }
      }
    }
    // 空值/认不出来的值：默认落在第一个「有音色目录」的模型上
    setConnectionId((prev) => (scope.some((item) => item.id === prev) ? prev : scope[0].id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, scopeKey, voices, providers])

  /** 模型级联变化上的对齐：当前模型不在范围里就换到第一个有目录的模型（没有目录的则进手动输入） */
  useEffect(() => {
    if (!connection) return
    if (modelOptions.some((spec) => spec.id === modelId)) return
    // 默认落在第一个「有音色目录」的模型上：一进来就撞上没有目录、只能手填的模型体验很差
    const first = modelOptions.find((spec) => spec.voices.length > 0) ?? modelOptions[0]
    setModelId(first?.id ?? '')
    setManual(first ? first.voices.length === 0 : false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, modelOptions.map((spec) => spec.id).join('|')])

  /** 换模型：没有音色目录的直接进手动输入，别让用户撞一个空下拉 */
  useEffect(() => {
    if (!modelId) return
    if (!hasCatalog && allowManual) setManual(true)
    onModelChange?.(modelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, hasCatalog])

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
              setModelId('')
              setManual(false)
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
          value={modelId}
          onValueChange={(value) => {
            setModelId(value)
            setManualDraft('')
            if (allowManual && (modelOptions.find((spec) => spec.id === value)?.voices.length ?? 0) === 0) {
              setManual(true)
            }
          }}
        >
          <SelectTrigger className="h-8 min-w-36 flex-1 text-xs">
            <SelectValue placeholder="模型" />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((spec) => (
              <SelectItem key={spec.id} value={spec.id}>
                {spec.label}
                {spec.voices.length === 0 ? '（无音色目录）' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {manual ? (
          <Input
            className="h-8 min-w-40 flex-1 text-xs"
            value={manualDraft}
            placeholder="音色 id，如 longanhuan_v3.6"
            onChange={(e) => {
              setManualDraft(e.target.value)
              const value = e.target.value.trim()
              onPick(
                value
                  ? formatManualVoice({ connectionId: connection?.id ?? '', modelId, voice: value })
                  : ''
              )
            }}
          />
        ) : (
          <Select
            value={voiceGroups.some((group) => group.voices.some((v) => v.id === voiceId)) ? voiceId : NONE}
            onValueChange={(value) => onPick(value === NONE ? '' : value)}
          >
            <SelectTrigger className="h-8 min-w-36 flex-1 text-xs">
              <SelectValue placeholder="音色" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={NONE}>留空（用该模型第一个音色）</SelectItem>
              {voiceGroups.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {allowManual && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={() => {
              setManual((prev) => !prev)
              if (manual) {
                setManualDraft('')
                onPick('')
              }
            }}
          >
            {manual ? '改从目录选' : '手动输入音色'}
          </Button>
          {manual && (
            <span className="text-xs text-muted-foreground">存成「接入::模型::音色」，合成时按它路由</span>
          )}
          {!manual && !hasCatalog && (
            <span className="text-xs text-amber-600">这个模型没有内置音色目录，请用手动输入</span>
          )}
        </div>
      )}
    </div>
  )
}
