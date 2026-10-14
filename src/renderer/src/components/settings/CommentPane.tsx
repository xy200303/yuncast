import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '../../stores/useAppStore'

/** 评论接入状态卡：本地平台连接器（docs/04 解耦架构，主应用不内置平台 SDK） */
export function CommentGatewayCard() {
  const connector = useAppStore((s) => s.connector)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const [port, setPort] = useState(String(config.comment.connectorPort))
  const [token, setToken] = useState(config.comment.connectorToken)

  const STATE_LABEL: Record<string, string> = {
    idle: '未连接',
    connecting: '连接中…',
    connected: `已连接 · 收 ${connector.receivedCount} 条`,
    error: '连接失败（自动重试中）'
  }

  const saveAccess = () => {
    const next = Number(port)
    if (!Number.isInteger(next) || next <= 0 || next >= 65536) {
      toast.error('端口无效', { description: '填 1-65535 的整数' })
      return
    }
    void saveConfig({ comment: { connectorPort: next, connectorToken: token.trim() } }).then(() =>
      toast.success('连接器配置已保存并重连')
    )
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">平台连接器</p>
          <p className="text-xs text-muted-foreground">
            主应用不内置平台 SDK：连接器是独立 MCP server，事件经 notifications/live_event 推进来，出站动作走同一连接
          </p>
        </div>
        <Badge
          variant={connector.state === 'connected' ? 'secondary' : connector.state === 'error' ? 'destructive' : 'outline'}
          title={connector.error}
        >
          {STATE_LABEL[connector.state]}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div className="w-28">
          <Label className="mb-1">MCP 端口</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8102" />
        </div>
        <div className="col-span-3">
          <Label className="mb-1">Bearer Token（连接器「设置 → 智能体接口」里复制）</Label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="连接器的 MCP Token"
          />
        </div>
        <div className="col-span-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={port === String(config.comment.connectorPort) && token === config.comment.connectorToken}
            onClick={saveAccess}
          >
            保存并重连
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void window.api.connector.restart()}>
            立即重连
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        连接器没开时会自动退避重试；开发调试可单独运行连接器的独立模式（内置演示数据，走同一条事件总线）。
      </p>
    </div>
  )
}
