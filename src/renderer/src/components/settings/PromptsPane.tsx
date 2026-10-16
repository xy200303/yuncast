import { useCallback, useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { type PromptTemplateInfo } from '../../../../shared/types'

/** 导演手册：所有发给大模型的提示词模板。左列表右编辑；改动对运行中的会话标「资产已变」，重开会话生效。 */
export function PromptsSection() {
  const [templates, setTemplates] = useState<PromptTemplateInfo[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  /**
   * 读模板列表并定位选中项。keepKey = 想保留的选中 key（null = 不保留，落第一项）。
   * key 由调用方显式传进来、不在函数里读 state：这样 init effect 就是纯的（不依赖 selectedKey），
   * 也不会出现"effect 闭包里的旧 load 读到旧选中项"。
   */
  const load = useCallback(async (keepKey: string | null = null): Promise<void> => {
    const list = await window.api.promptTemplates.list()
    const nextKey = keepKey && list.some((t) => t.key === keepKey) ? keepKey : (list[0]?.key ?? null)
    setTemplates(list)
    setSelectedKey(nextKey)
    setDraft(list.find((t) => t.key === nextKey)?.content ?? '')
  }, [])

  useEffect(() => {
    load(null).catch((e) =>
      toast.error('读取导演手册失败', { description: e instanceof Error ? e.message : String(e) })
    )
  }, [load])

  const selected = templates.find((t) => t.key === selectedKey) ?? null
  const dirty = selected !== null && draft !== selected.content

  const select = (item: PromptTemplateInfo) => {
    setSelectedKey(item.key)
    setDraft(item.content)
  }

  const save = async () => {
    if (!selected) return
    setSaving(true)
    const result = await window.api.promptTemplates.save(selected.key, draft)
    setSaving(false)
    if (!result.ok) {
      toast.error('保存失败', { description: result.error })
      return
    }
    toast.success(`「${selected.label}」已保存`, {
      description: '正在运行的会话不受影响，重开会话（切节目/重启节目）后生效'
    })
    await load(selected.key)
  }

  const reset = async () => {
    if (!selected) return
    setSaving(true)
    const result = await window.api.promptTemplates.reset(selected.key)
    setSaving(false)
    if (!result.ok) {
      toast.error('恢复默认失败', { description: result.error })
      return
    }
    toast.success(`「${selected.label}」已恢复默认`)
    await load(selected.key)
  }

  return (
    <section className="flex flex-col">
      <div className="mb-3">
        <h2 className="text-sm font-medium">导演手册</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          导演的脑子由这些模板组装：身份与工作方式、指令包装、直播间动态注入、写稿任务书、上下文压缩等。
          变量用 {'{{变量名}}'} 占位；改完保存，正在运行的会话标「资产已变」，重开会话后生效。
        </p>
      </div>
      <div className="flex min-w-0 gap-3">
        <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto pr-1" style={{ maxHeight: 420 }}>
          {templates.map((item) => (
            <button
              key={item.key}
              type="button"
              className={cn(
                'rounded-lg border px-2.5 py-2 text-left',
                selectedKey === item.key ? 'bg-accent/60 font-medium' : 'hover:bg-muted/60'
              )}
              onClick={() => select(item)}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[13px]">{item.label}</span>
                {!item.isDefault && (
                  <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] text-amber-600">
                    已修改
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.key}</div>
            </button>
          ))}
        </div>
        {selected ? (
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border bg-card p-3">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{selected.description}</p>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={saving || selected.isDefault}
                  onClick={() => void reset()}
                >
                  <RotateCcw className="size-3" />
                  恢复默认
                </Button>
                <Button size="sm" className="h-7 text-xs" disabled={saving || !dirty} onClick={() => void save()}>
                  {saving ? '保存中…' : dirty ? '保存' : '已保存'}
                </Button>
              </div>
            </div>
            <Textarea
              className="h-[340px] resize-none font-mono text-xs leading-5"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            暂无模板
          </div>
        )}
      </div>
    </section>
  )
}
