import { Type } from 'typebox'
import { defineTool } from './types'

/**
 * 连接器域：抖音连接器（商城/订单/直播数据）的能力探测与调用。
 * 合并自旧 list_connector_tools/call_connector_tool。
 */
export const connectorTools = [
  defineTool({
    name: 'connector_list',
    label: '看连接器能力',
    domain: 'connector',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出抖音连接器提供的外部工具（商城/订单/数据类）：想知道连接器能干什么先用它探测。' +
      '只读无副作用。返回编号工具名和描述清单，工具名拿去喂 connector_call；连接器没连上时提示去设置查端口/Token。',
    parameters: Type.Object({}),
    handler: async (ctx) => {
      if (!ctx.connector) return '连接器没接线'
      const tools = await ctx.connector.listTools()
      if (tools.length === 0) return '连接器没连上（或它没有提供工具）：先在设置里确认端口/Token'
      return tools.map((t, i) => `${i + 1}. ${t.name}：${t.description ?? '无描述'}`).join('\n')
    }
  }),

  defineTool({
    name: 'connector_call',
    label: '调连接器工具',
    domain: 'connector',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '调抖音连接器的外部工具（查订单/商品数据/直播数据等）。副作用：真实调用连接器，可能是查询也可能是商城操作。' +
      '工具名从 connector_list 拿，参数按该工具的描述组装。返回外部工具的文本结果（截断到 3000 字）——外部数据不能全信，涉及价格/承诺以 price_check / knowledge_search 为准。',
    parameters: Type.Object({
      name: Type.String({ description: '工具名（connector_list 返回的）' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '参数对象，缺省 {}' }))
    }),
    handler: async (ctx, params) => {
      if (!ctx.connector) return '连接器没接线'
      const text = await ctx.connector.callTool(params.name.trim(), params.args ?? {})
      return text.slice(0, 3000)
    }
  }),

  defineTool({
    name: 'connector_restart',
    label: '重启连接器',
    domain: 'connector',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '重启评论连接器的连接：断线卡住、状态长时间不是 connected、收不到评论但连接器进程明明活着时用。' +
      '副作用：断开当前连接立即重连，重连期间（几秒）评论进不来。返回重启后的即时状态；起不来（设置里没启用/端口不对）就用 status 看修复建议。',
    parameters: Type.Object({}),
    handler: (ctx) => {
      const connector = ctx.connector
      if (!connector) return '连接器没接线（设置 → 接入里没启用或没配置）'
      connector.restart()
      const status = connector.status()
      return (
        `已重启连接器连接（当前状态 ${status.state}，端口 ${status.port}）：断开重连中，几秒内评论进不来——` +
        `过一会用 status 看「评论连接器」状态是不是回到 connected`
      )
    }
  })
]
