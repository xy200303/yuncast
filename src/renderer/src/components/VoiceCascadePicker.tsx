import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useAppStore } from '../stores/useAppStore'
import { TTS_PROVIDER_SHORT, type TtsConnectionSafe } from '../../../shared/types'
import { formatManualVoice, parseManualVoice } from '../../../shared/voiceProvider'

/** 手动输入的伪分组：选中它时最后一列变成输入框（产出 接入::模型::音色） */
const MANUAL = '__manual__'

interface VoiceLeaf {
  id: string
  name: string
}

interface Group {
  key: string
  label: string
  voices: VoiceLeaf[]
}

interface CascadeColumn {
  key: string
  items: { key: string; label: string; note?: string; hasChildren: boolean; active: boolean }[]
}

/**
 * 级联音色选择（一个下拉，点父级往右展开子级；与 Ant Design Cascader 同形）：
 * 接入（只有一条时省略）→ 模型 → 分组 → 音色，最后点叶子完成选择。
 *
 * 为什么做成级联而不是并排几个下拉/一大片按钮：音色数量是几百个（火山 2.0 有 244 个），
 * 铺开必然占掉半屏；级联把"模型的音色是几百个"这件事收进一个下拉里，一次只展开一层。
 *
 * 系统音色与克隆音色在同一套级联里（克隆音色是「克隆音色」这一组）；
 * 官方没给音色目录的模型（qwen-audio-3.x / cosyvoice-v3.5）走「手动输入…」，
 * 借用已选的接入+模型拼成 `接入::模型::音色`（合成路由按这个前缀找接入与模型）。
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
  /** 受控方想同步知道当前路径上的模型（例如接入测试弹窗） */
  onModelChange?: (modelId: string) => void
  /** 可选范围（测试弹窗只给那一条接入）；默认全部有可用模型的接入 */
  connections?: TtsConnectionSafe[]
  allowManual?: boolean
  placeholder?: string
}) {
  const allConnections = useAppStore((s) => s.ttsConnections)
  const providers = useAppStore((s) => s.ttsProviders)
  const voices = useAppStore((s) => s.voices)

  const scope = useMemo(
    () => (connections ?? allConnections.filter((item) => item.usableModels.length > 0)),
    [connections, allConnections]
  )

  const [open, setOpen] = useState(false)
  /** 级联路径：接入 → 模型 → 分组（悬停/点击父级就往右展开一层） */
  const [pathConnection, setPathConnection] = useState('')
  const [pathModel, setPathModel] = useState('')
  const [pathGroup, setPathGroup] = useState('')
  const [manualDraft, setManualDraft] = useState('')
  /** 弹层位置：弹窗里有 overflow-hidden，绝对定位会被裁，所以用 portal + fixed 贴着触发器算 */
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const connection = scope.find((item) => item.id === pathConnection) ?? scope[0]

  /** 这条接入里「有音色可选」的模型（目录非空，或绑这条接入+模型有就绪的克隆音色） */
  const modelItems = useMemo(() => {
    if (!connection) return []
    const manifest = providers.find((item) => item.id === connection.providerId)
    return connection.models
      .map((item) => ({
        spec: manifest?.models.find((spec) => spec.id === item.id),
        id: item.id
      }))
      .filter((item) => Boolean(item.spec))
      .map((item) => {
        const clones = voices.filter(
          (voice) =>
            voice.status === 'ready' &&
            Boolean(voice.voiceType) &&
            voice.connectionId === connection.id &&
            voice.model === item.id
        )
        return {
          id: item.id,
          label: item.spec?.label ?? item.id,
          note: (item.spec?.voices.length ?? 0) > 0 || clones.length > 0 ? undefined : '无音色目录',
          hasVoices: (item.spec?.voices.length ?? 0) > 0 || clones.length > 0
        }
      })
  }, [connection, providers, voices])

  const groups = useMemo<Group[]>(() => {
    if (!connection || !pathModel) return []
    const manifest = providers.find((item) => item.id === connection.providerId)
    const spec = manifest?.models.find((item) => item.id === pathModel)
    const list: Group[] = []
    const clones = voices.filter(
      (voice) =>
        voice.status === 'ready' &&
        Boolean(voice.voiceType) &&
        voice.connectionId === connection.id &&
        voice.model === pathModel
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
  }, [connection, pathModel, providers, voices, allowManual])

  /** 外部给的 voiceId 反查到级联路径（克隆音色 / 目录音色 / 手动串都能对上） */
  useEffect(() => {
    if (!scope.length) return
    const id = voiceId.trim()
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) {
      setPathConnection(clone.connectionId || scope[0].id)
      setPathModel(clone.model)
      setPathGroup('clone')
      return
    }
    const manual = parseManualVoice(id)
    if (manual && scope.some((item) => item.id === manual.connectionId)) {
      setPathConnection(manual.connectionId)
      setPathModel(manual.modelId)
      setPathGroup(MANUAL)
      setManualDraft(manual.voice)
      return
    }
    for (const item of scope) {
      const manifest = providers.find((entry) => entry.id === item.providerId)
      for (const spec of manifest?.models ?? []) {
        const group = spec.voices.find((entry) => entry.voices.some((voice) => voice.id === id))
        if (group) {
          setPathConnection(item.id)
          setPathModel(spec.id)
          setPathGroup(group.label)
          return
        }
      }
    }
    // 空值/认不出来的值：停在第一个「有音色可选」的模型上，别让用户一进来就撞上手填
    setPathConnection((prev) => prev || scope[0].id)
    setPathModel((prev) => {
      if (prev) return prev
      const first = modelItems.find((item) => item.hasVoices) ?? modelItems[0]
      return first?.id ?? ''
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, scope, voices, providers])

  // 路径变化后把模型/分组对齐到合法值，并把模型同步给父组件；分组没选时自动落到第一组
  useEffect(() => {
    if (!connection) return
    const valid = modelItems.find((item) => item.id === pathModel)
    if (!valid) {
      const first = modelItems.find((item) => item.hasVoices) ?? modelItems[0]
      setPathModel(first?.id ?? '')
      return
    }
    onModelChange?.(pathModel)
    if (pathGroup === MANUAL) return
    if (!groups.some((group) => group.key === pathGroup)) {
      const first = groups.find((group) => group.key !== MANUAL) ?? groups[0]
      setPathGroup(first?.key ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, pathModel, groups.map((group) => group.key).join('|')])

  // 点空白关掉（级联是自绘弹层，没有 Popover 依赖）
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** 列数（定位时估算面板宽度用）：接入? + 模型 + 分组 + 音色? */
  const columnsCount = (scope.length > 1 ? 1 : 0) + 1 + 1 + (pathGroup !== MANUAL ? 1 : 0)

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const measure = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      // 估算面板宽度做右边界收敛（列宽 152px，手动输入那一列 224px）
      const estimated = 8 + columnsCount * 152 + (pathGroup === MANUAL ? 224 : 0)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - estimated - 8))
      setAnchor({ left, top: rect.bottom + 4 })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, pathGroup, columnsCount])

  const currentGroup = groups.find((group) => group.key === pathGroup)
  const selectedVoiceName = (() => {
    const id = voiceId.trim()
    if (!id) return ''
    const clone = voices.find((voice) => voice.voiceType === id && voice.status === 'ready')
    if (clone) return clone.name
    const manual = parseManualVoice(id)
    if (manual) return manual.voice
    for (const entry of scope) {
      const manifest = providers.find((item) => item.id === entry.providerId)
      for (const spec of manifest?.models ?? []) {
        for (const group of spec.voices) {
          const hit = group.voices.find((voice) => voice.id === id)
          if (hit) return hit.name
        }
      }
    }
    return id
  })()

  const columns: CascadeColumn[] = []
  if (scope.length > 1) {
    columns.push({
      key: 'connection',
      items: scope.map((item) => ({
        key: item.id,
        label: `${TTS_PROVIDER_SHORT[item.providerId]} · ${item.name}`,
        hasChildren: true,
        active: item.id === connection?.id
      }))
    })
  }
  columns.push({
    key: 'model',
    items: modelItems.map((item) => ({
      key: item.id,
      label: item.label,
      note: item.note,
      hasChildren: true,
      active: item.id === pathModel
    }))
  })
  const pickableGroups = groups.filter((group) => group.key !== MANUAL)
  if (pickableGroups.length > 1 || pathGroup === MANUAL || allowManual) {
    columns.push({
      key: 'group',
      items: groups.map((group) => ({
        key: group.key,
        label: group.label,
        hasChildren: group.key !== MANUAL,
        active: group.key === pathGroup
      }))
    })
  }
  if (pathGroup !== MANUAL) {
    columns.push({
      key: 'voice',
      items: (currentGroup?.voices ?? []).map((voice) => ({
        key: voice.id,
        label: voice.name,
        hasChildren: false,
        active: voice.id === voiceId.trim()
      }))
    })
  }

  const pickLeaf = (id: string): void => {
    onPick(id)
    setOpen(false)
  }

  if (scope.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        还没有可用的语音接入：先到设置 → 语音合成加一条（填密钥、勾上要用的模型），才有音色可选。
      </p>
    )
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-2.5 text-xs',
          'hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {connection && <ProviderIcon providerId={connection.providerId} size="sm" />}
          <span className={cn('truncate', !selectedVoiceName && 'text-muted-foreground')}>
            {selectedVoiceName || placeholder}
          </span>
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: anchor.left, top: anchor.top }}
            className="z-50 flex max-h-72 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
          {columns.map((column) => (
            <div
              key={column.key}
              className="flex max-h-72 min-w-36 flex-col overflow-y-auto border-r p-1 last:border-r-0"
            >
              {column.items.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">（没有可选项）</p>
              )}
              {column.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onMouseEnter={() => {
                    if (column.key === 'connection') {
                      setPathConnection(item.key)
                      setPathGroup('')
                    } else if (column.key === 'model') {
                      setPathModel(item.key)
                      setPathGroup('')
                    } else if (column.key === 'group') {
                      setPathGroup(item.key)
                    }
                  }}
                  onClick={() => {
                    if (!item.hasChildren) pickLeaf(item.key)
                  }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px]',
                    item.active ? 'bg-accent font-medium' : 'hover:bg-accent/60'
                  )}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {item.note && <span className="text-[11px] text-muted-foreground">{item.note}</span>}
                    {!item.hasChildren && item.active && <Check className="size-3.5" />}
                    {item.hasChildren && (
                      <ChevronRight
                        className={cn('size-3 text-muted-foreground', item.active && 'text-foreground')}
                      />
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}

          {pathGroup === MANUAL && (
            <div className="flex w-56 flex-col gap-1 border-l p-2">
              <Input
                className="h-7 text-xs"
                autoFocus
                value={manualDraft}
                placeholder="音色 id，如 longanhuan_v3.6"
                onChange={(e) => {
                  setManualDraft(e.target.value)
                  const value = e.target.value.trim()
                  onPick(
                    value
                      ? formatManualVoice({
                          connectionId: connection?.id ?? '',
                          modelId: pathModel,
                          voice: value
                        })
                      : ''
                  )
                }}
              />
              <p className="text-[11px] text-muted-foreground">存成「接入::模型::音色」，合成时按它路由</p>
            </div>
          )}
          </div>,
          document.body
        )}
    </div>
  )
}
