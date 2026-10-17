import { Type } from 'typebox'
import { defineTool } from './types'

/**
 * 观众域：观众画像查询与记忆。
 * 合并自旧 lookup_viewer/remember_viewer。
 */
export const viewerTools = [
  defineTool({
    name: 'viewer_lookup',
    label: '查观众画像',
    domain: 'viewer',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '查一位观众的画像：互动次数、问过什么、记过的偏好。用来认出老粉——评论里出现眼熟的昵称先查再回应。' +
      '只读无副作用；昵称从评论动态里原样拿。返回画像描述，新观众会明说没有画像；要记新信息用 viewer_note。',
    parameters: Type.Object({
      name: Type.String({ description: '观众昵称' })
    }),
    handler: (ctx, params) => {
      const profile = ctx.memory.lookupViewer(params.name)
      if (!profile) return `${params.name} 是新观众，没有画像`
      return `${profile.name}：${ctx.memory.describeViewer(profile)}`
    }
  }),

  defineTool({
    name: 'viewer_note',
    label: '记住观众',
    domain: 'viewer',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '给观众记一笔偏好/特征（比如「家里有小孩」「预算 200 以内」），下次他来直播能认出他。' +
      '副作用：写入观众画像，长期保留。昵称从评论动态里原样拿；返回已记住的确认。查已有画像用 viewer_lookup。',
    parameters: Type.Object({
      name: Type.String({ description: '观众昵称' }),
      note: Type.String({ description: '要记住的内容，一句话' })
    }),
    handler: (ctx, params) => {
      ctx.memory.rememberViewer(params.name, params.note)
      return `已记住 ${params.name}：${params.note}`
    }
  })
]
