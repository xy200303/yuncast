import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { RecordMenuSub } from './RecordControl'
import {
  PROGRAM_LANGUAGE_LABELS,
  SESSION_PRESETS,
  type Program,
  type SessionConfig
} from '../../../../shared/types'

/**
 * 工作台顶栏（docs/12 §7）：本场 = 剧本 + 主播 + 语言 + 预设。
 * 等价于直播伴侣的「场景」：一眼看清这场用什么人、什么嗓子、什么语言、怎么播；
 * 具体设置都在开播配置里改，这里只显示与进入。
 */

export function WorkbenchTopBar({
  program,
  session,
  running,
  onConfigure,
  onOpenAutoResponse,
  onOpenDirector,
  onManualBroadcast,
  onOpenStreamSettings,
  onFocusQueue
}: {
  program: Program | null
  session: SessionConfig | null
  running: boolean
  onConfigure: () => void
  /** 打开自动响应弹窗（本场唯一的互动接线入口） */
  onOpenAutoResponse: () => void
  onOpenDirector: () => void
  onManualBroadcast: () => void
  onOpenStreamSettings: () => void
  /** 回到当前正在播的卡片 */
  onFocusQueue: () => void
}) {
  const languageLabel = session ? PROGRAM_LANGUAGE_LABELS[session.language] : '未配置'
  const presetLabel = session
    ? session.preset
      ? (SESSION_PRESETS.find((item) => item.id === session.preset)?.label ?? '自定义')
      : '自定义'
    : '未配置'
  /** 播出中这两项只读：它们决定整场的声音与播出方式，改了下半场会和新内容打架 */
  const lockedHint = '播出中锁定：语言与预设决定整场的声音和播出方式，结束本场后再改'
  const metaClass = 'flex shrink-0 items-center gap-1 rounded px-1 py-1 text-[12px]'

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <span className="shrink-0 text-[12px] text-muted-foreground">项目</span>
      <span className="max-w-64 truncate text-[13px] font-medium">{program?.name ?? '未打开项目'}</span>

      <Divider />

      {running ? (
        <>
          <span className={cn(metaClass, 'text-muted-foreground/80')} title={lockedHint}>
            <span className="text-muted-foreground">语言</span>
            <span>{languageLabel}</span>
          </span>
          <span className={cn(metaClass, 'text-muted-foreground/80')} title={lockedHint}>
            <span className="text-muted-foreground">预设</span>
            <span>{presetLabel}</span>
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onConfigure}
            className={cn(metaClass, 'hover:bg-muted/60')}
            title="本场语言（只决定写什么语言，不传给 TTS）"
          >
            <span className="text-muted-foreground">语言</span>
            <span>{languageLabel}</span>
          </button>

          <button
            type="button"
            onClick={onConfigure}
            className={cn(metaClass, 'hover:bg-muted/60')}
            title="播出预设（内容来源 / 合成时机 / 收尾）"
          >
            <span className="text-muted-foreground">预设</span>
            <span>{presetLabel}</span>
          </button>
        </>
      )}

      <Divider />

      {/* 自动响应是播出中的实时开关（改完立刻生效），不算「一场的配置」，播出中也能点 */}
      <button
        type="button"
        onClick={onOpenAutoResponse}
        disabled={!program}
        className={cn(metaClass, 'hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50')}
        title="自动响应：决定哪些直播间动态派给主播（欢迎/送礼/点赞/冷场自救…），改动立刻生效"
      >
        <span className="text-muted-foreground">自动响应</span>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className={cn('mr-1 text-[11px]', running ? 'text-emerald-600' : 'text-muted-foreground')}>
          {running ? '播出中' : '未开播'}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="更多：导演 / 人工播报 / 录屏 / 推流">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onFocusQueue}>回到当前</DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenDirector}>导演对话</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onManualBroadcast}>人工播报</DropdownMenuItem>
            <RecordMenuSub />
            {/* 播出中只留播控与查看：配置类入口全部收起，免得一场里改出两套状态
               （自动响应是实时开关，已经提到顶栏，不在菜单里重复） */}
            {!running && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenStreamSettings}>推流设置</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function Divider() {
  return <span className="h-4 w-px shrink-0 bg-border" />
}
