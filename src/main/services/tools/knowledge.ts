import { Type } from 'typebox'
import { ENTRY_KINDS, type EntryKind } from '../../../shared/types'
import { defineTool } from './types'
import { knowledgeScope } from './util'

/**
 * 知识/商品域：知识库检索与条目维护 + 商品价格护栏 + 连接器商品同步。
 * 合并自旧 search_knowledge/save_knowledge_entry/remove_knowledge_entry/sync_products/check_price
 * （MCP 的 JSON 版 knowledge_search 废弃，统一用这份格式化文本输出）。
 */
export const knowledgeTools = [
  defineTool({
    name: 'knowledge_search',
    label: '查知识库',
    domain: 'knowledge',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '检索商品资料和知识文件（卖点/FAQ/资料描述）。观众问到商品细节先查再答，不要凭印象编。' +
      '只读无副作用；有节目时只查本节目配置的知识范围。返回编号列表（来源/名称/价格/命中片段），查不到就含糊带过或引导观众看小黄车，别编。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词，比如商品名、材质、功效' }),
      limit: Type.Optional(Type.Number({ description: '返回条数，默认 3', default: 3 }))
    }),
    handler: (ctx, params) => {
      const hits = ctx.knowledge.searchKnowledge(params.query, params.limit ?? 3, knowledgeScope(ctx))
      if (hits.length === 0) return '知识库里没有相关内容（限本节目的知识范围），别编，含糊带过或引导观众看小黄车'
      return hits
        .map(
          (hit, i) =>
            `${i + 1}. [${hit.source === 'product' ? '商品' : '资料'}] ${hit.name}` +
            `${hit.price !== undefined ? `（¥${hit.price}）` : ''}\n${hit.snippet}`
        )
        .join('\n')
    }
  }),

  defineTool({
    name: 'knowledge_list',
    label: '列知识库',
    domain: 'knowledge',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '列出知识库全部条目和资料文件：条目的 id/名称/类型/价格/要点摘要，文件的 id/名称/类型。只读无副作用。' +
      '和 knowledge_search 的区别：search 是按关键词模糊找内容，这个是全量清单——盘点库存、找条目 id（knowledge_save/knowledge_remove 要用 id）、看有哪些资料文件用它。',
    parameters: Type.Object({
      kind: Type.Optional(Type.String({ description: `按类型过滤：${ENTRY_KINDS.join('/')}；不传 = 全部` }))
    }),
    handler: (ctx, params) => {
      const kind = params.kind?.trim()
      if (kind && !ENTRY_KINDS.includes(kind as EntryKind)) return `类型只能是：${ENTRY_KINDS.join(' / ')}`
      const products = ctx.knowledge
        .listProducts()
        .filter((p) => !kind || p.kind === kind)
        .map((p) => ({
          id: p.id,
          名称: p.name,
          类型: p.kind,
          价格: p.kind === 'product' ? p.price : undefined,
          要点: p.sellingPoints.slice(0, 60) || undefined,
          来源: p.externalId ? '同步' : '手工'
        }))
      const files = ctx.knowledge.listFiles().map((f) => ({ id: f.id, 名称: f.name, 类型: f.kind }))
      if (products.length === 0 && files.length === 0) {
        return '知识库是空的：用 knowledge_save 录条目，或让导演在知识库页上传资料/同步商品'
      }
      return JSON.stringify({ 条目: products, 资料文件: files }, null, 2)
    }
  }),

  defineTool({
    name: 'knowledge_save',
    label: '存知识条目',
    domain: 'knowledge',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '往知识库写/更新一个条目（商品/书籍/话题/自定义）：观众提到的新商品、导演口头给的新卖点、自己查到的资料。' +
      '副作用：写库。**寻址一律用 id**：带 id 更新那一条（没传的字段沿用旧值），不带 id 新建（名字只是显示，不参与查重）。' +
      '直播里要长期记住的商品信息用它落库，别只记在对话里。返回条目 id；删条目用 knowledge_remove。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '条目 id（knowledge_list/knowledge_search 拿）：更新时必传，不传 = 新建' })),
      name: Type.String({ description: '条目名（商品名/书名/话题名），只用于显示' }),
      kind: Type.Optional(Type.String({ description: `类型：${ENTRY_KINDS.join('/')}（商品默认 product）` })),
      price: Type.Optional(Type.Number({ description: '价格（元），只有商品有意义' })),
      sellingPoints: Type.Optional(Type.String({ description: '要点：商品=卖点；书籍=内容要点；话题=节目要点' })),
      faq: Type.Optional(Type.String({ description: '问答/备注' })),
      author: Type.Optional(Type.String({ description: '作者（书籍类用）' }))
    }),
    handler: (ctx, params) => {
      const kind = (ENTRY_KINDS as readonly string[]).includes(params.kind ?? '') ? (params.kind as EntryKind) : 'product'
      const existing = params.id?.trim()
        ? ctx.knowledge.listProducts().find((p) => p.id === params.id!.trim())
        : undefined
      if (params.id?.trim() && !existing) return `知识条目 ${params.id} 不存在（用 knowledge_list 拿正确的 id）`
      const saved = ctx.knowledge.saveProduct(
        {
          name: params.name,
          kind,
          price: params.price ?? existing?.price ?? 0,
          sellingPoints: params.sellingPoints ?? existing?.sellingPoints ?? '',
          faq: params.faq ?? existing?.faq ?? '',
          externalId: existing?.externalId ?? '',
          meta: {
            ...(existing?.meta ?? {}),
            ...(params.author?.trim() ? { author: params.author.trim() } : {})
          }
        },
        existing?.id
      )
      return `${existing ? '已更新' : '已新建'}知识条目「${saved.name}」（id=${saved.id}，${saved.kind}）${saved.price > 0 ? `，¥${saved.price}` : ''}`
    }
  }),

  defineTool({
    name: 'knowledge_remove',
    label: '删知识条目',
    domain: 'knowledge',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '按 id 删一个知识库条目（过时/下架/录错）。副作用：真删，不可恢复——只有导演明确说删才用。' +
      'id 从 knowledge_list / knowledge_search 拿。返回删除结果；条目不存在时如实告知。',
    parameters: Type.Object({
      id: Type.String({ description: '条目 id（knowledge_list 拿）' })
    }),
    handler: (ctx, params) => {
      const found = ctx.knowledge.listProducts().find((p) => p.id === params.id.trim())
      if (!found) return `知识库里没有 id=${params.id}`
      ctx.knowledge.deleteProduct(found.id)
      return `已删知识条目：「${found.name}」`
    }
  }),

  defineTool({
    name: 'product_sync',
    label: '同步商品',
    domain: 'knowledge',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '从抖音商城（连接器）同步商品数据进知识库：拉绑定商品列表，按外部 id 去重更新。' +
      '副作用：批量写知识库。上架/改价/换卖点后用这个拿最新数据；连接器能力先用 connector_list 探测。' +
      '返回新增/更新/总数统计；同步通道没接线时提示走界面。',
    parameters: Type.Object({}),
    handler: async (ctx) => {
      if (!ctx.syncProducts) return '同步通道没接上，让导演在知识库页点「同步商品」'
      const r = await ctx.syncProducts()
      return `同步完成：新增 ${r.added}、更新 ${r.updated}，共 ${r.total} 个商品`
    }
  }),

  defineTool({
    name: 'price_check',
    label: '查价格',
    domain: 'knowledge',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '查商品价格。硬性规则：直播里报的任何价格/优惠数字必须来自这个工具的返回，查不到就说不确定，绝不许编造。' +
      '只读无副作用；不传商品名返回全部商品价格表。返回「名称：¥价格」列表，查不到时会明说不要报价。',
    parameters: Type.Object({
      product: Type.Optional(Type.String({ description: '商品名（模糊匹配），不传返回全部商品价格表' }))
    }),
    handler: (ctx, params) => {
      const rows = ctx.knowledge.checkPrice(params.product, knowledgeScope(ctx))
      if (rows.length === 0) return '没查到这个商品，价格不确定，不要在直播里报价'
      return rows.map((row) => `${row.name}：¥${row.price}`).join('\n')
    }
  })
]
