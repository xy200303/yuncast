import { Type } from 'typebox'
import { defineTool, type ToolCtx } from './types'

/** 内置主播侧的危险确认（与其它 danger 工具同口径）；外部调用本身是导演角色，直接放行 */
function askConfirm(ctx: ToolCtx, summary: string): string | null {
  if (ctx.caller === 'external') return null
  if (!ctx.onDirectorAsk) return '确认通道没接上（ask_director 不可用）：让导演在播放条 ⋯ 菜单里手动开始录屏'
  ctx.onDirectorAsk({
    text: summary,
    options: ['确认执行', '取消'],
    timeoutSec: 300,
    defaultAction: '不录制'
  })
  return (
    `录屏是对外可见性较高的操作，已向导演发确认卡（5 分钟内有效）：\n${summary}\n` +
    `导演答复「确认执行」后，带 confirmed=true 重新调用本工具才真正开始录制`
  )
}

/**
 * 录屏域：应用窗口录屏/截图（只采 YunCast 自己的窗口——遮挡、其它窗口、用户的真实鼠标都不会进画面）。
 * 录制本体在渲染进程，主进程 RecordingService 管状态机和落盘。
 */
export const recordTools = [
  defineTool({
    name: 'screen_record',
    label: '录屏',
    domain: 'record',
    risk: 'danger',
    expose: { agent: true, mcp: true },
    description:
      '录屏：录制 YunCast 应用窗口的画面 + 系统声音（含 YunCast 自己的播出声），mp4 落在 userData/recordings 目录（环境不支持 mp4 时自动回退 webm）。' +
      '只录本应用窗口：窗口被遮挡、用户切换窗口都不影响画面内容。' +
      '用途：留档本场直播/节目、给导演做演示视频、复盘取证。' +
      'action=start 开始（可传 name 作文件名后缀、showCursor=false 连画出来的虚拟指针也不要）；action=stop 停止并返回文件路径；action=status 查状态。' +
      '副作用：录制的画面内容可能含敏感信息，文件体积随时长增长。' +
      '内置主播第一次 start 不传 confirmed：向导演发确认卡；确认后带 confirmed=true 重调才开始。外部调用直接执行。' +
      '同一时间只能录一路；停止后文件路径就是成品，可直接拿去剪辑或上传。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('status')], {
        description: 'start 开始 / stop 停止 / status 查状态'
      }),
      name: Type.Optional(Type.String({ description: '文件名后缀（action=start 时可用），如「保温杯专场复盘」' })),
      showCursor: Type.Optional(
        Type.Boolean({
          description:
            '画面里要不要指针（action=start 时可用），默认 true。是软件画出来的虚拟指针（跟手真实操作、自动化点击也会显示），不是系统真鼠标——真鼠标永远不会被录进去'
        })
      ),
      confirmed: Type.Optional(Type.Boolean({ description: '导演已确认 = true；不传 = 先发确认卡（仅内置主播侧，action=start 时）' }))
    }),
    handler: async (ctx, params) => {
      const recorder = ctx.recorder
      if (!recorder) return '录屏服务还没初始化'
      if (params.action === 'status') {
        const state = recorder.state()
        return state.recording
          ? `录制中：已录 ${Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000)} 秒，文件 ${state.file}`
          : '当前没在录制'
      }
      if (params.action === 'start') {
        if (!params.confirmed) {
          const msg = askConfirm(
            ctx,
            `开始录屏：YunCast 窗口画面 + 系统声音，mp4 落盘。录到的内容可能含界面上的敏感信息，停止前注意画面。`
          )
          if (msg) return msg
        }
        const result = await recorder.start(params.name, params.showCursor ?? true)
        return result.ok ? `已开始录制：${result.file}\n停止用 screen_record action=stop` : `启动失败：${result.error}`
      }
      const result = await recorder.stop()
      return result.ok ? `已停止录制，成品文件：${result.file}` : `停止失败：${result.error}`
    }
  }),

  defineTool({
    name: 'screen_capture',
    label: '截图',
    domain: 'record',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '截图：抓一张 YunCast 应用窗口当前画面的 PNG 截图（全分辨率，不受其它窗口遮挡影响），落在 userData/screenshots 目录，返回文件路径。' +
      '用途：给导演看界面现状、留证据、做图文素材。' +
      '一次只截当前这一帧，不含声音；要连续画面用 screen_record 录屏。' +
      '注意：截图会原样包含界面上的内容（可能有敏感信息），发出去之前自己看一眼。',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: '文件名后缀，如「开播前检查」' }))
    }),
    handler: async (ctx, params) => {
      const recorder = ctx.recorder
      if (!recorder) return '录屏服务还没初始化'
      const result = await recorder.captureScreenshot(params.name)
      return result.ok ? `截图完成：${result.file}` : `截图失败：${result.error}`
    }
  })
]
