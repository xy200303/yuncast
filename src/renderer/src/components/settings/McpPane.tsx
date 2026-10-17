import { useEffect, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { McpConfig, McpRuntime } from '../../../../shared/types'

/** SKILL.md 的在线地址（给 Agent 的安装指引用） */
const SKILL_URL = 'https://raw.githubusercontent.com/xy200303/yuncast/main/skills/yuncast/SKILL.md'

/** 接入指引文本：发给任意 Agent，它自己写 MCP 配置 + 装技能。display=false 时嵌完整令牌 */
function buildPrompt(port: string, token: string): string {
  return `帮我把 YunCast（本机直播/播报系统）接入你：

1. 新增一个 MCP 服务器，名称 yuncast（只新增或更新这一条，别动其它服务器）：
   - 传输：Streamable HTTP，地址 http://127.0.0.1:${port}/mcp
   - 认证：请求头 Authorization: Bearer ${token}
   - 配置文件位置按你的惯例（如 ~/.kimi-code/mcp.json、~/.claude.json、~/.codex/config.toml）
2. 安装操作手册技能：下载 ${SKILL_URL}，按你的惯例安装为名为 yuncast 的技能
3. 完成后调用 yuncast 的 status 工具验证连通，把返回的「修复建议」告诉我

注意：YunCast 应用要保持运行；令牌是本机凭据，不要提交到仓库或公开分享。`
}

/** 开放接口：本机 MCP / CLI，把 YunCast 的能力（对话/播出/TTS/节目）开给本机 Agent */
export function McpPane() {
  const [config, setConfig] = useState<McpConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState('3931')
  const [runtime, setRuntime] = useState<McpRuntime | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    void window.api.mcp.get().then((cfg) => {
      setConfig(cfg)
      setEnabled(cfg.enabled)
      setPort(String(cfg.port))
    })
    void window.api.mcp.state().then(setRuntime)
    return window.api.mcp.onState(setRuntime)
  }, [])

  const dirty = config !== null && (enabled !== config.enabled || port !== String(config.port))

  const save = async () => {
    const next = Number(port)
    if (!Number.isInteger(next) || next <= 0 || next >= 65536) {
      toast.error('端口无效', { description: '填 1-65535 的整数' })
      return
    }
    setSaving(true)
    try {
      const result = await window.api.mcp.save({ enabled, port: next })
      if (!result.ok) {
        toast.error('保存失败', { description: result.error })
        return
      }
      setConfig(result.config)
      toast.success(result.config.enabled ? '开放接口已开启' : '开放接口已关闭')
    } finally {
      setSaving(false)
    }
  }

  const copyToken = async () => {
    if (!config?.token) return
    await navigator.clipboard.writeText(config.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const regenerate = async () => {
    // 防手滑：点一次变确认，再点才真的换
    if (!confirmReset) {
      setConfirmReset(true)
      setTimeout(() => setConfirmReset(false), 3000)
      return
    }
    setConfirmReset(false)
    const result = await window.api.mcp.save({ enabled, port: Number(port), regenerateToken: true })
    if (!result.ok) {
      toast.error('重新生成失败', { description: result.error })
      return
    }
    setConfig(result.config)
    toast.success('令牌已更换', { description: '接入文本里的令牌已更新，发给 Agent 时重新复制一次' })
  }

  const copyPrompt = async () => {
    if (!config?.token) return
    await navigator.clipboard.writeText(buildPrompt(port, config.token))
    setCopiedPrompt(true)
    setTimeout(() => setCopiedPrompt(false), 1500)
  }

  const stateBadge = runtime?.running ? (
    <Badge variant="secondary">运行中 · {runtime.clients} 个会话</Badge>
  ) : runtime?.error ? (
    <Badge variant="destructive" title={runtime.error}>
      {runtime.error}
    </Badge>
  ) : (
    <Badge variant="outline">未开启</Badge>
  )

  return (
    <section>
      <h2 className="text-sm font-medium">开放接口</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        把 YunCast 的能力开给本机的 AI Agent（MCP 协议 + 命令行）：对话、播出、TTS、节目制作。
        只监听本机回环地址，带令牌鉴权，默认关闭。
      </p>

      {/* 开关与端口 */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium">MCP 服务</p>
            <p className="text-xs text-muted-foreground">本机 http://127.0.0.1:{port}/mcp</p>
          </div>
          <div className="flex items-center gap-3">
            {stateBadge}
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
          <div className="w-28">
            <Label className="mb-1">端口</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="3931" />
          </div>
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存并应用
          </Button>
        </div>
        {runtime?.error ? <p className="mt-2 text-xs text-destructive">{runtime.error}</p> : null}
      </div>

      {/* 令牌（不完整显示） */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-4">
        <p className="text-[13px] font-medium">访问令牌</p>
        <p className="text-xs text-muted-foreground">每个请求都要带它；不要贴进公开仓库或聊天记录</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">
            {config?.token ? `${config.token.slice(0, 8)}…` : '…'}
          </code>
          <Button variant="outline" size="sm" onClick={() => void copyToken()} disabled={!config?.token}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : '复制'}
          </Button>
          <Button variant={confirmReset ? 'destructive' : 'outline'} size="sm" onClick={() => void regenerate()}>
            <RefreshCw className="size-3.5" />
            {confirmReset ? '再点一次确认' : '重新生成'}
          </Button>
        </div>
      </div>

      {/* 接入指引：一段文字发给 Agent，它自己完成接入 */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-4">
        <p className="text-[13px] font-medium">接入你的 Agent</p>
        <p className="text-xs text-muted-foreground">
          把下面这段话原样发给任意 AI Agent（Kimi Code / Claude Code / Codex / Cursor…），它会自己写好
          MCP 配置、装好操作手册技能并验证连通。复制的内容包含完整令牌
        </p>
        <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs leading-relaxed">
          {buildPrompt(port, config?.token ? `${config.token.slice(0, 8)}…（完整令牌随复制带上）` : '…')}
        </pre>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => void copyPrompt()}
          disabled={!config?.token}
        >
          {copiedPrompt ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copiedPrompt ? '已复制' : '复制接入文本'}
        </Button>
      </div>

      {/* CLI 用法 */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-4">
        <p className="text-[13px] font-medium">命令行</p>
        <p className="text-xs text-muted-foreground">
          MCP 注册不了时用命令行，同一份工具定义；应用没开时会先把 YunCast 拉起来
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs leading-relaxed">
{`yuncast tools
yuncast schema tts_synthesize
yuncast chat "跟观众打个招呼"
yuncast tts "欢迎光临" --voice <音色id> --out D:/a.mp3
yuncast status
yuncast events --follow --kinds comment.new`}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Agent 操作手册（SKILL.md）：
          <a className="underline" href={SKILL_URL} target="_blank" rel="noreferrer">
            {SKILL_URL}
          </a>
        </p>
      </div>
    </section>
  )
}
