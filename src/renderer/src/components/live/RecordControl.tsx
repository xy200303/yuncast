import { useEffect, useState } from 'react'
import { Loader2, Square, Video } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { RecordingState } from '../../../../shared/types'

/**
 * 通用录屏 UI：状态 hook + ⋯ 菜单里的「录屏」子菜单 + 播放条上的录制中红点指示器。
 * 录制本体在渲染进程（screenRecorder.ts），这里只是发令和显示状态。
 */

/** 录屏鼠标指针开关的本地记忆（1/0；默认开） */
const SHOW_CURSOR_KEY = 'yuncast.record.showCursor'

export function useRecording(): RecordingState {
  const [state, setState] = useState<RecordingState>({ recording: false })
  useEffect(() => {
    void window.api.record.state().then(setState)
    return window.api.record.onState(setState)
  }, [])
  return state
}

/** 开始/停止共用；返回 false 表示动作没成（toast 已发） */
async function toggleRecording(recording: boolean, showCursor: boolean): Promise<boolean> {
  if (recording) {
    const result = await window.api.record.stop()
    if (result.ok) toast.success('录制完成', { description: result.file })
    else toast.error('停止录制失败', { description: result.error })
    return result.ok
  }
  const result = await window.api.record.start(undefined, showCursor)
  if (!result.ok) toast.error('启动录制失败', { description: result.error })
  return result.ok
}

/** ⋯ 动作菜单里的「录屏」子菜单：开始/停止 + 鼠标指针开关 + 录制状态 */
export function RecordMenuSub() {
  const state = useRecording()
  const [busy, setBusy] = useState(false)
  /** 画面里带不带鼠标指针：演示教程要指针，留档纯净画面关掉；记住上次选择 */
  const [showCursor, setShowCursor] = useState(() => localStorage.getItem(SHOW_CURSOR_KEY) !== '0')
  /** 录制中每秒刷一次已录时长 */
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!state.recording) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [state.recording])

  const onToggle = () => {
    setBusy(true)
    void toggleRecording(state.recording, showCursor).finally(() => setBusy(false))
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Video />
        录屏
        {state.recording && <span className="ml-auto size-2 rounded-full bg-red-500" />}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        {state.recording && (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              已录 {Math.max(0, Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000))} 秒
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem disabled={busy} onSelect={onToggle}>
          {busy ? <Loader2 className="animate-spin" /> : state.recording ? <Square /> : <Video />}
          {state.recording ? '停止录屏' : '开始录屏'}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={showCursor}
          disabled={state.recording}
          onCheckedChange={(checked) => {
            const on = checked === true
            setShowCursor(on)
            localStorage.setItem(SHOW_CURSOR_KEY, on ? '1' : '0')
          }}
        >
          画面里显示鼠标指针
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal leading-5 text-muted-foreground">
          只录应用窗口 + 系统声音，mp4 落盘到 recordings 目录
        </DropdownMenuLabel>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** 播放条右侧的录制中指示器：红点呼吸，点击停止；没在录时不占位 */
export function RecordIndicator() {
  const state = useRecording()
  const [busy, setBusy] = useState(false)
  if (!state.recording && !busy) return null
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={busy}
      title="录制中，点击停止（应用窗口 + 系统声音）"
      onClick={() => {
        setBusy(true)
        void toggleRecording(true, true).finally(() => setBusy(false))
      }}
    >
      {busy ? (
        <Loader2 className="animate-spin" />
      ) : (
        <span className="relative flex size-3">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
          <span className="relative inline-flex size-3 rounded-full bg-red-500" />
        </span>
      )}
    </Button>
  )
}
