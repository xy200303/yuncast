import { useState } from 'react'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppStore } from '../stores/useAppStore'
import { audioEngine } from '../audio/engine'
import {
  LLM_PROVIDER_META,
  LLM_PROVIDERS,
  ttsConfigured,
  type AppTheme,
  type LlmConfig,
  type LlmProvider,
  type TtsConfig,
  type TtsProvider
} from '../../../shared/types'

const THEME_OPTIONS: { id: AppTheme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor }
]

/** 设置页。选项卡组织：外观 / 接入（M2 接入 TTS，LLM/推流/评论继续占位）。 */
export function SettingsPage() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Settings className="size-4 text-primary" />
        <h1 className="text-sm font-medium">设置</h1>
      </header>
      <Tabs defaultValue="appearance" className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="appearance" className="px-3">外观</TabsTrigger>
            <TabsTrigger value="access" className="px-3">接入</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="appearance" className="overflow-auto p-6">
          <section className="max-w-xl">
            <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
              <div>
                <p className="text-[13px]">主题</p>
                <p className="text-xs text-muted-foreground">界面配色，跟随系统时随系统自动切换</p>
              </div>
              <ToggleGroup
                type="single"
                value={theme}
                onValueChange={(v) => {
                  if (!v) return
                  setTheme(v as AppTheme).catch((e) =>
                    toast.error('保存主题失败', { description: e instanceof Error ? e.message : String(e) })
                  )
                }}
                className="rounded-lg bg-muted p-0.5"
              >
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon
                  return (
                    <ToggleGroupItem
                      key={option.id}
                      value={option.id}
                      className="h-7 gap-1.5 rounded-md px-3 text-[13px] data-[state=on]:bg-background data-[state=on]:shadow-sm"
                    >
                      <Icon className="size-3.5" />
                      {option.label}
                    </ToggleGroupItem>
                  )
                })}
              </ToggleGroup>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="access" className="overflow-auto p-6">
          <section className="max-w-xl">
            <LlmSection />
            <div className="mt-3">
              <TtsSection />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {['推流', '评论接入'].map((name) => (
                <div
                  key={name}
                  className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground"
                >
                  {name}
                  <br />
                  后续里程碑开放
                </div>
              ))}
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** LLM 表单：主播 Agent 的大脑。provider 切换时带出默认模型和默认地址 */
function LlmSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [form, setForm] = useState<LlmConfig>({ ...config.llm })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.llm)
  const patch = (part: Partial<LlmConfig>) => setForm((prev) => ({ ...prev, ...part }))
  const meta = LLM_PROVIDER_META[form.provider]

  const save = () => {
    setSaving(true)
    saveConfig({ llm: form })
      .then(() => toast.success('LLM 配置已保存', { description: '已启动的主播重启后使用新配置' }))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">语言模型（LLM）</p>
          <p className="text-xs text-muted-foreground">主播 Agent 的大脑，DeepSeek / 通义 / 豆包 / Kimi / 智谱</p>
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">服务商</Label>
          <Select
            value={form.provider}
            onValueChange={(v) => {
              const provider = v as LlmProvider
              // 切换服务商时如果模型还是上一个服务商的默认值，跟随换默认值
              const followDefault =
                !form.model || form.model === LLM_PROVIDER_META[form.provider].defaultModel
              patch({
                provider,
                model: followDefault ? LLM_PROVIDER_META[provider].defaultModel : form.model
              })
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {LLM_PROVIDER_META[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field
          label="API Key"
          value={form.apiKey}
          onChange={(v) => patch({ apiKey: v })}
          type="password"
          placeholder="sk-…"
        />
        <Field
          label="模型"
          value={form.model}
          onChange={(v) => patch({ model: v })}
          placeholder={meta.defaultModel}
        />
        <div className="col-span-2">
          <Field
            label="自定义 API 地址（留空走默认）"
            value={form.baseUrl}
            onChange={(v) => patch({ baseUrl: v })}
            placeholder={meta.defaultBaseUrl}
          />
        </div>
      </div>

      {!form.apiKey && (
        <p className="mt-3 text-xs text-muted-foreground">填好 API Key 后，到「主播团」启动主播</p>
      )}
    </div>
  )
}

/** TTS 双通道表单（火山引擎 / 阿里云百炼），字段照旧版 SettingsView */function TtsSection() {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [form, setForm] = useState<TtsConfig>({ ...config.tts })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(config.tts)
  const patch = (part: Partial<TtsConfig>) => setForm((prev) => ({ ...prev, ...part }))

  const save = () => {
    setSaving(true)
    saveConfig({ tts: form })
      .then(() => toast.success('TTS 配置已保存'))
      .catch((e) => toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setSaving(false))
  }

  const test = () => {
    if (testing) return
    setTesting(true)
    void window.api.tts
      .test('你好，欢迎来到直播间，这里是 Agent Anchor 智能体主播。')
      .then(async (result) => {
        if (result.ok && result.audioPath) {
          toast.success('合成成功，正在播放')
          await audioEngine.playTts(result.audioPath)
        } else {
          toast.error('合成失败', { description: result.error })
        }
      })
      .finally(() => setTesting(false))
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">语音合成（TTS）</p>
          <p className="text-xs text-muted-foreground">火山引擎与阿里云百炼双通道，二选一</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={testing} onClick={test}>
            {testing ? '合成中…' : '测试发音'}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="mb-1">服务商</Label>
          <Select value={form.provider} onValueChange={(v) => patch({ provider: v as TtsProvider })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="volcano">火山引擎（豆包语音）</SelectItem>
              <SelectItem value="bailian">阿里云百炼（Qwen-TTS）</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {form.provider === 'volcano' ? (
          <>
            <Field label="AppId" value={form.appId} onChange={(v) => patch({ appId: v })} placeholder="控制台 → 语音技术 → 应用管理" />
            <Field label="Access Token" value={form.accessToken} onChange={(v) => patch({ accessToken: v })} type="password" />
            <Field label="接入集群 Cluster" value={form.cluster} onChange={(v) => patch({ cluster: v })} placeholder="volcano_tts" />
            <Field label="语速" value={String(form.speed)} onChange={(v) => patch({ speed: Number(v) || 1.0 })} placeholder="1.0" />
          </>
        ) : (
          <>
            <Field label="API Key" value={form.apiKey} onChange={(v) => patch({ apiKey: v })} type="password" placeholder="sk-…" />
            <Field label="模型" value={form.model} onChange={(v) => patch({ model: v })} placeholder="qwen3-tts-flash" />
            <Field label="API 地址" value={form.baseUrl} onChange={(v) => patch({ baseUrl: v })} placeholder="https://dashscope.aliyuncs.com/api/v1" />
            <Field label="语种" value={form.languageType} onChange={(v) => patch({ languageType: v })} placeholder="Chinese" />
          </>
        )}
        <div className="col-span-2">
          <Field
            label="默认音色 voiceId"
            value={form.voiceId}
            onChange={(v) => patch({ voiceId: v })}
            placeholder={form.provider === 'volcano' ? '火山 voice_type，例如 zh_female_…' : '百炼 voice，例如 Cherry'}
          />
        </div>
      </div>

      {!ttsConfigured(form) && (
        <p className="mt-3 text-xs text-muted-foreground">
          还没配齐：{form.provider === 'volcano' ? 'AppId / Access Token / 音色' : 'API Key / 模型 / 音色'} 都是必填
        </p>
      )}
    </div>
  )
}

function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div>
      <Label className="mb-1">{props.label}</Label>
      <Input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}
