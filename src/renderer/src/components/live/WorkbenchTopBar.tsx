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

export type DrawerTab = 'scenes' | 'chapters' | 'interaction'

export function WorkbenchTopBar({
  program,
  session,
  running,
  prepared,
  onConfigure,
  onOpenDrawer,
  onOpenDirector,
  onManualBroadcast,
  onOpenStreamSettings,
  onFocusQueue
}: {
  program: Program | null
  session: SessionConfig | null
  running: boolean
  prepared: boolean
  onConfigure: () => void
  onOpenDrawer: (tab: DrawerTab) => void
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

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className={cn('mr-1 text-[11px]', running ? 'text-emerald-600' : 'text-muted-foreground')}>
          {running ? '播出中' : '未开播'}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="更多：导演 / 场次大纲 / 评论事件 / 推流与互动">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onFocusQueue}>回到当前</DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenDirector}>导演对话</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenDrawer('scenes')}>场次大纲</DropdownMenuItem>
            {prepared && <DropdownMenuItem onSelect={() => onOpenDrawer('chapters')}>章节点播</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onManualBroadcast}>人工播报</DropdownMenuItem>
            <RecordMenuSub />
            {/* 播出中只留播控与查看：配置类入口全部收起，免得一场里改出两套状态 */}
            {!running && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onOpenDrawer('interaction')}>自动响应设置</DropdownMenuItem>
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
