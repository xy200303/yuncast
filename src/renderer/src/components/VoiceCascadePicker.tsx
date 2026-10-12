import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProviderIcon } from '@/components/ProviderIcon'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { TTS_PROVIDER_SHORT, type TtsConnectionSafe } from '../../../shared/types'
import { formatManualVoice, parseManualVoice } from '../../../shared/voiceProvider'

interface VoiceLeaf {
  id: string
  name: string
}

interface VoiceGroup {
  key: string
  label: string
  voices: VoiceLeaf[]
}

/**
 * 音色选择：一个紧凑控件 + 级联子菜单（Radix DropdownMenu 的 SubMenu，成熟库，行为由它管）。
 *
 * 形态：点开 → 模型列（每条接入启用的模型）→ 悬停展开「分组」列 → 再展开「音色」列。
 * 每个子列自己滚动，所以 244 个音色也不会拉出一条长列表——这正是把长列表拆成级联的目的。
 *
 * - 手动输入：菜单里选「手动输入…」切到输入框（产出 `接入::模型::音色`），再点「改从目录选」切回
 * - 官方没给音色目录的模型在模型项后面标注，进去只有「手动输入…」可选
 * - 接入有多条时，模型项前面缀上接入名（不再多开一层）
 * - 音色严格绑定模型：选中叶子同时把模型回调出去（接入测试弹窗要用）
 */
export function VoiceCascadePicker({
  voiceId,
  onPick,
  onModelChange,
  connections,
  allowManual = true,
  placeholder = '选择音色'
}: {
  voiceId: string
  onPick: (voiceId: string) => void
  onModelChange?: (modelId: string) => void
  /** 可选范围（测试弹窗只给那一条接入）；默认全部有可用模型的接入 */
  connections?: TtsConnectionSafe[]
  allowManual?: boolean
  placeholder?: string
}) {
  const allConnections = useAppStore((s) => s.ttsConnections)
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)

  // 可选范围按「接入 id 串」记忆：调用方常传内联数组，按引用算会在每次渲染时重算
  const scoped = connections ?? allConnections.filter((item) => item.usableModels.length > 0)
  const scopeKey = scoped.map((item) => item.id).join('|')
  const scope = useMemo(
    () => scoped.slice(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey]
  )

  const [manual, setManual] = useState(false)
  const [manualDraft, setManualDraft] = useState('')
  const [manualModel, setManualModel] = useState('')

  /** 每个模型一项：音色分组 + 这条接入里绑它的克隆音色 */
  const modelEntries = useMemo(() => {
    const entries: {
      connection: TtsConnectionSafe
      modelId: string
      label: string
      groups: VoiceGroup[]
    }[] = []
    for (const connection of scope) {
      const manifest = providers.find((item) => item.id === connection.providerId)
      for (const item of connection.models) {
        const spec = manifest?.models.find((model) => model.id === item.id)
        if (!spec) continue
        const groups: VoiceGroup[] = []
        const clones = voices.filter(
          (voice) =>
            voice.status === 'ready' &&
            Boolean(voice.voiceType) &&
            voice.connectionId === connection.id &&
            voice.model === spec.id
        )
        if (clones.length > 0) {
          groups.push({
            key: 'clone',
            label: `克隆音色（${clones.length}）`,
            voices: clones.map((voice) => ({ id: voice.voiceType, name: voice.name }))
          })
        }
        for (const group of spec.voices) {
          if (group.voices.length > 0) {
            groups.push({
              key: group.label,
              label: `${group.label}（${group.voices.length}）`,
              voices: group.voices
            })
          }
        }
        entries.push({
          connection,
          modelId: spec.id,
          label: spec.label,
          groups
        })
      }
    }
    return entries
  }, [scope, providers, voices])

  /** 外部 voiceId 反查（克隆音色 / 目录音色 / 手动串三种都能对上） */
  useEffect(() => {
    const id = voiceId.trim()
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) {
      setManual(false)
      onModelChange?.(clone.model)
      return
    }
    const manualRef = parseManualVoice(id)
    if (manualRef) {
      setManual(true)
      setManualDraft(manualRef.voice)
      setManualModel(manualRef.modelId)
      onModelChange?.(manualRef.modelId)
      return
    }
    if (!id) return
    for (const entry of modelEntries) {
      for (const group of entry.groups) {
        if (group.voices.some((voice) => voice.id === id)) {
          setManual(false)
          onModelChange?.(entry.modelId)
          return
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, scopeKey, voices, providers])

  const selectedName = useMemo(() => {
    const id = voiceId.trim()
    if (!id) return ''
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) return clone.name
    const manualRef = parseManualVoice(id)
    if (manualRef) return manualRef.voice
    for (const entry of modelEntries) {
      for (const group of entry.groups) {
        const hit = group.voices.find((voice) => voice.id === id)
        if (hit) return hit.name
      }
    }
    return id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, modelEntries])

  /** 默认对手动输入用的模型：范围里第一个「有音色目录」的（没有就第一个） */
  const fallbackEntry = useMemo(
    () => modelEntries.find((entry) => entry.groups.length > 0) ?? modelEntries[0],
    [modelEntries]
  )

  if (scope.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        还没有可用的语音接入：先到设置 → 语音合成加一条（填密钥、勾上要用的模型），才有音色可选。
      </p>
    )
  }

  const pickVoice = (entry: (typeof modelEntries)[number], id: string): void => {
    setManual(false)
    onModelChange?.(entry.modelId)
    onPick(id)
  }

  const enterManual = (modelId: string): void => {
    setManual(true)
    setManualDraft('')
    setManualModel(modelId)
    onModelChange?.(modelId)
    onPick('')
  }

  return (
    <div className="flex flex-col gap-2">
      {manual ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-48 flex-1 text-xs"
            value={manualDraft}
            placeholder="音色 id，如 longanhuan_v3.6"
            onChange={(e) => {
              setManualDraft(e.target.value)
              const value = e.target.value.trim()
              onPick(
                value
                  ? formatManualVoice({
                      connectionId:
                        modelEntries.find((entry) => entry.modelId === manualModel)?.connection.id ?? '',
                      modelId: manualModel,
                      voice: value
                    })
                  : ''
              )
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              setManual(false)
              setManualDraft('')
              onPick('')
            }}
          >
            改从目录选
          </Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex h-8 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-2.5 text-xs',
                'hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {fallbackEntry && (
                  <ProviderIcon providerId={fallbackEntry.connection.providerId} size="sm" />
                )}
                <span className={cn('truncate', !selectedName && 'text-muted-foreground')}>
                  {selectedName || placeholder}
                </span>
              </span>
              <ChevronRight className="size-3.5 shrink-0 rotate-90 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem onSelect={() => onPick('')}>留空（用该模型第一个音色）</DropdownMenuItem>
            <DropdownMenuSeparator />

            {modelEntries.map((entry) => (
              <DropdownMenuSub key={`${entry.connection.id}-${entry.modelId}`}>
                <DropdownMenuSubTrigger className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {entry.label}
                    {scope.length > 1 ? `（${entry.connection.name}）` : ''}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-60 overflow-y-auto">
                  {entry.groups.length === 0 && (
                    <DropdownMenuItem disabled>
                      这个模型没有内置音色目录，请用手动输入
                    </DropdownMenuItem>
                  )}
                  {entry.groups.map((group) => (
                    <DropdownMenuSub key={group.key}>
                      <DropdownMenuSubTrigger>{group.label}</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                        {group.voices.map((voice) => (
                          <DropdownMenuItem
                            key={voice.id}
                            onSelect={() => pickVoice(entry, voice.id)}
                          >
                            <span className="min-w-0 flex-1 truncate">{voice.name}</span>
                            {voice.id === voiceId && <Check className="size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                  {allowManual && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => enterManual(entry.modelId)}>
                        手动输入这个模型的音色…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}

            {allowManual && fallbackEntry && modelEntries.length === 0 && (
              <DropdownMenuItem onSelect={() => enterManual(fallbackEntry.modelId)}>
                手动输入…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {!manual && allowManual && (
        <button
          type="button"
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => enterManual(manualModel || fallbackEntry?.modelId || '')}
        >
          手动输入音色
        </button>
      )}
      {manual && <p className="text-xs text-muted-foreground">存成「接入::模型::音色」，合成时按它路由</p>}
    </div>
  )
}
