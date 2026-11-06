import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { voiceRouteSummary } from '../../lib/voice'
import { useAppStore } from '../../stores/useAppStore'

/** Radix Select 不允许空字符串值：默认档/更多档用哨兵，对外仍是空串 */
const DEFAULT_VALUE = '__default__'
const MORE_VALUE = '__more__'

/**
 * 音色选择：一个下拉就够了。默认档 + 音色库里已就绪的克隆音色；
 * 系统音色 / 手动 ID 收成下拉里的「其他音色…」，选中时才展开三段式选择器。
 *
 * 值仍是可直接路由的 voiceType——名字只是入口，存进库里的是能合成的那串。
 */
export function SpeakerPicker({
  value,
  onChange,
  emptyLabel = '本场默认音色',
  placeholder = '选择音色'
}: {
  value: string
  onChange: (voiceId: string) => void
  emptyLabel?: string
  placeholder?: string
}) {
  const voices = useAppStore((state) => state.voices)
  const providers = useAppStore((state) => state.ttsProviders)
  const connections = useAppStore((state) => state.ttsConnections)
  const [advanced, setAdvanced] = useState(false)
  const ready = voices.filter((voice) => voice.status === 'ready' && voice.voiceType)

  // 当前值不在克隆音色里（系统音色 / 手动 ID / 已被删）：也要在下拉里有名字可显示
  const cloneHit = ready.some((voice) => voice.voiceType === value)
  const currentLabel =
    value && !cloneHit ? voiceRouteSummary(voices, providers, connections, value).voiceName || value : ''

  const selected = advanced ? MORE_VALUE : value || DEFAULT_VALUE

  const handleChange = (next: string): void => {
    if (next === MORE_VALUE) {
      setAdvanced(true)
      return
    }
    setAdvanced(false)
    onChange(next === DEFAULT_VALUE ? '' : next)
  }

  return (
    <div className="flex flex-col gap-2">
      <Select value={selected} onValueChange={handleChange}>
        <SelectTrigger className="h-9">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{emptyLabel}</SelectItem>
          {ready.map((voice) => (
            <SelectItem key={voice.id} value={voice.voiceType}>
              {voice.name}
            </SelectItem>
          ))}
          {currentLabel && <SelectItem value={value}>{currentLabel}</SelectItem>}
          <SelectItem value={MORE_VALUE}>其他音色（系统音色 / 手动 ID）…</SelectItem>
        </SelectContent>
      </Select>
      {advanced && (
        <div className="rounded-lg border p-2">
          <UnifiedVoicePicker
            voiceId={cloneHit ? value : ''}
            onPick={(next) => {
              onChange(next)
              setAdvanced(false)
            }}
            placeholder={placeholder}
          />
        </div>
      )}
    </div>
  )
}
