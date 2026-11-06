import { useEffect, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Globe, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import logoUrl from '../../../assets/logo.svg'
import { BRAND_DISPLAY, BRAND_NAME_ZH } from '../../../../shared/brand'
import type { AppInfo, UpdateStatus } from '../../../../shared/types'

/** GitHub 品牌图标（lucide 已移除品牌图标，用官方 mark 的 path） */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

const REPO_URL = 'https://github.com/xy200303/yuncast'
const SITE_URL = 'https://yuncast.xyun.dev'

/** 关于：品牌 / 版本 / 开源入口 / 手动检查更新（electron-updater 走 GitHub Releases） */
export function AboutPane() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => {})
    return window.api.update.onStatus(setStatus)
  }, [])

  const check = async () => {
    setBusy(true)
    try {
      setStatus(await window.api.update.check())
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setBusy(true)
    try {
      await window.api.update.download()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium">关于</h2>

      {/* 品牌卡 */}
      <div className="mt-3 flex items-center gap-4 rounded-lg border bg-card px-4 py-4">
        <img src={logoUrl} alt={BRAND_NAME_ZH} className="size-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">{BRAND_DISPLAY}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            版本 {info?.version ?? '…'} · 专为不会直播的商家和企业而生
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => window.open(REPO_URL, '_blank', 'noopener,noreferrer')}
          >
            <GithubIcon className="size-3.5" />
            GitHub
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => window.open(SITE_URL, '_blank', 'noopener,noreferrer')}
          >
            <Globe className="size-3.5" />
            官网
          </Button>
        </div>
      </div>

      {/* 更新卡 */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[13px]">软件更新</p>
            <p className="text-xs text-muted-foreground">
              {statusLine(status)}
            </p>
          </div>
          {status.state === 'available' ? (
            <Button size="sm" className="h-8" disabled={busy} onClick={download}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              下载 v{status.version}
            </Button>
          ) : status.state === 'downloaded' ? (
            <Button size="sm" className="h-8" onClick={() => window.api.update.install()}>
              <CheckCircle2 className="size-3.5" />
              重启安装 v{status.version}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={busy || status.state === 'checking' || status.state === 'downloading'}
              onClick={check}
            >
              {status.state === 'checking' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {status.state === 'checking' ? '检查中' : '检查更新'}
            </Button>
          )}
        </div>
        {status.state === 'downloading' && (
          <div className="mt-3 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${status.percent ?? 0}%` }}
              />
            </div>
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {status.percent ?? 0}%
            </span>
          </div>
        )}
      </div>

      {/* 开源信息 */}
      <div className="mt-3 rounded-lg border bg-card px-4 py-3">
        <p className="text-[13px]">开源与反馈</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          MIT License · © 2026 {BRAND_NAME_ZH}。数据全部保存在本机，无服务端、不上传。
          遇到问题或想参与共建，欢迎来仓库提 Issue / PR。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() => window.open(`${REPO_URL}/issues`, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="size-3" />
            反馈问题
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() => window.open(`${REPO_URL}/releases`, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="size-3" />
            更新日志
          </Button>
        </div>
      </div>
    </section>
  )
}

function statusLine(status: UpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return '正在向 GitHub Releases 查询新版本…'
    case 'available':
      return `发现新版本 v${status.version}，可立即下载`
    case 'not-available':
      return '已是最新版本'
    case 'downloading':
      return '正在下载更新包…'
    case 'downloaded':
      return '下载完成，重启后生效'
    case 'error':
      return status.message ?? '检查失败，请稍后再试'
    default:
      return '有新版本时会在这里提示，也可以手动检查'
  }
}
