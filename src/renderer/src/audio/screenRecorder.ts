/**
 * 录屏采集端（渲染进程是录制本体）：主进程 RecordingService 发命令，这里执行。
 * start → getDisplayMedia（整屏 + 系统回放声，授权闸门在主进程）+ MediaRecorder 分块回传；
 * stop → 收尾 flush 后回报 done。采集开始后先报 ready（带上实际容器格式，主进程按此定扩展名），失败报 fail。
 * 返回取消订阅函数；重复调用是幂等的（StrictMode 双挂载/热更新不会叠出第二个录制器）。
 *
 * 容器默认 mp4（Chromium 内置封装，通用性最好）；当前环境不支持时按序回退 webm。
 *
 * 鼠标：系统真鼠标永远不采（cursor 固定 never）——录到的光标会跟着用户真实鼠标乱跑、
 * 还会把别人的操作录进去。showCursor=true 时改为显示 virtualCursor 画出来的指针
 * （跟手真实输入 + 支持 window.__vc 自动化编排），视频光标和用户真实鼠标完全脱钩。
 */
import { hideVirtualCursor, showVirtualCursor } from '../overlay/virtualCursor'
const MIME_CANDIDATES: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' }
]

let cmdOff: (() => void) | null = null

export function initScreenRecorder(): () => void {
  if (cmdOff) return cmdOff
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null

  const cleanup = () => {
    recorder = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }

  const start = async (showCursor: boolean) => {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // 真鼠标永不进画面；要光标就走 virtualCursor 画出来的那套（见文件头说明）。
        // width/height 给满分辨率 ideal：窗口采集默认按窗口 CSS 尺寸给轨，高分屏/缩放场景会糊
        video: {
          frameRate: 30,
          cursor: 'never',
          width: { ideal: 8192 },
          height: { ideal: 8192 }
        } as MediaTrackConstraints & { cursor?: string },
        audio: true
      })
      if (showCursor) showVirtualCursor()
      const picked = MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mime))
      if (!picked) throw new Error('当前环境不支持任何可用的录制容器（mp4/webm 都不行）')
      recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 6_000_000 })
      // 分块发送串行化：arrayBuffer() 是异步的，并发 resolve 会乱序落盘（文件头被污染过），链式保证顺序
      let chain: Promise<void> = Promise.resolve()
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return
        chain = chain.then(async () => {
          const buf = await e.data.arrayBuffer()
          let binary = ''
          const bytes = new Uint8Array(buf)
          const step = 0x8000
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode(...bytes.subarray(i, i + step))
          }
          await window.api.record.chunk(btoa(binary))
        })
      }
      recorder.onstop = () => {
        // 等最后一个分块真正落盘后再报 done，不然文件尾部会被截掉
        void chain.then(() => {
          cleanup()
          void window.api.record.done()
        })
      }
      // 用户从系统条上直接停止共享：等同 stop，回报 done 让主进程收尾
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        hideVirtualCursor()
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      })
      recorder.start(500)
      void window.api.record.ready(picked.ext)
    } catch (error) {
      hideVirtualCursor()
      cleanup()
      void window.api.record.fail(error instanceof Error ? error.message : String(error))
    }
  }

  const stop = () => {
    hideVirtualCursor()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else {
      cleanup()
      void window.api.record.done()
    }
  }

  const off = window.api.record.onCmd((cmd) => {
    if (cmd.action === 'start') void start(cmd.showCursor ?? true)
    else stop()
  })
  cmdOff = () => {
    off()
    cmdOff = null
  }
  return cmdOff
}
