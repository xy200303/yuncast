import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UnifiedVoicePicker } from '@/components/UnifiedVoicePicker'
import { useAppStore } from '../../stores/useAppStore'

/** Radix Select 不允许空字符串值：默认档用哨兵，对外仍是空串 */
const DEFAULT_VALUE = '__default__'

/**
 * 主播选择：第一层只列名字（音色库里已就绪的克隆音色），选谁就是指定哪个主播；
 * 系统音色与手动 ID 收进「其他音色」，一般用不到。
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
  const ready = voices.filter((voice) => voice.status === 'ready' && voice.voiceType)

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={value || DEFAULT_VALUE}
        onValueChange={(next) => onChange(next === DEFAULT_VALUE ? '' : next)}
      >
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
        </SelectContent>
      </Select>
      <details>
        <summary className="cursor-pointer text-[12px] text-muted-foreground">其他音色（系统音色 / 手动 ID）</summary>
        <div className="mt-2">
          <UnifiedVoicePicker
            voiceId={value}
            onPick={onChange}
            emptyLabel={emptyLabel}
            placeholder={placeholder}
          />
        </div>
      </details>
    </div>
  )
}
