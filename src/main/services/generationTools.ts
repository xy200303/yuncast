import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { PlanKnowledgeScope, UtteranceSource } from '../../shared/types'
import type { KnowledgeService } from './KnowledgeService'
import type { UtteranceService } from './UtteranceService'
import { fetchUrlGuarded } from './fetchUrl'

/**
 * 生成阶段的工具面（docs/07 §4.1，作用域：generation）。
 * 与直播工具面互斥：能联网（fetch_url）、能入库（save_utterances），不能进话术池。
 * 三条约束：价格只走 check_price；来源留痕（save_utterances 带 sources）；成本上限（调用计数器）。
 */

/** 单场生成工具调用上限（docs/07 §4.2 ③） */
export const GENERATION_TOOL_CALL_CAP = 40
/** 单次读取上限（字符） */
const READ_CAP = 8000

export interface GenerationToolDeps {
  knowledge: KnowledgeService
  utterances: UtteranceService
  planId: string
  /** 场次知识库范围（检索/读取都按它过滤） */
  scope: PlanKnowledgeScope
  /** 当前正在生成的场景 id（save_utterances 挂到它下面） */
  getSceneId: () => string
  /** 工具调用计数器（所有工具共用，超限拒绝） */
  budget: { used: number }
}

export function buildGenerationTools(deps: GenerationToolDeps): ToolDefinition[] {
  const { knowledge, utterances, planId, scope, getSceneId, budget } = deps
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })
  const guardTool = (fn: () => string) => {
    try {
      budget.used++
      if (budget.used > GENERATION_TOOL_CALL_CAP) {
        return ok(`工具调用次数已达上限（${GENERATION_TOOL_CALL_CAP} 次/场），请用已有信息收尾`)
      }
      return ok(fn())
    } catch (error) {
      return ok(`操作失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const productAllowed = (id: string) => scope.products === '*' || scope.products.includes(id)
  const fileAllowed = (id: string) => scope.files === '*' || scope.files.includes(id)

  return [
    defineTool({
      name: 'search_knowledge',
      label: '查知识库',
      description: '检索本场绑定的商品资料和知识文件（卖点/FAQ/资料描述）。写话术前先查，不要凭印象编。',
      parameters: Type.Object({
        query: Type.String({ description: '检索关键词，比如商品名、材质、功效' }),
        limit: Type.Optional(Type.Number({ description: '返回条数，默认 3', default: 3 }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const hits = knowledge
            .searchKnowledge(params.query, (params.limit ?? 3) + 5)
            .filter((hit) => (hit.source === 'product' ? productAllowed(hit.id) : fileAllowed(hit.id)))
            .slice(0, params.limit ?? 3)
          if (hits.length === 0) return '知识库里没有相关内容，别编'
          return hits
            .map(
              (hit, i) =>
                `${i + 1}. [${hit.source === 'product' ? '商品' : '资料'}:${hit.id}] ${hit.name}` +
                `${hit.price !== undefined ? `（¥${hit.price}）` : ''}\n${hit.snippet}`
            )
            .join('\n')
        })
    }),
    defineTool({
      name: 'list_products',
      label: '列出商品',
      description: '列出本场绑定的全部商品（id/名称/价格）。生成话术前先看看本场卖什么。',
      parameters: Type.Object({}),
      execute: async () =>
        guardTool(() => {
          const products = knowledge.listProducts().filter((p) => productAllowed(p.id))
          if (products.length === 0) return '本场没有绑定商品'
          return products.map((p) => `${p.id}｜${p.name}｜¥${p.price}`).join('\n')
        })
    }),
    defineTool({
      name: 'get_product',
      label: '查商品详情',
      description: '查一个商品的结构化信息：卖点、FAQ、价格。比自由文本可靠，写讲解话术必读。',
      parameters: Type.Object({
        id: Type.String({ description: '商品 id（list_products 返回的第一段）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const product = knowledge.listProducts().find((p) => p.id === params.id && productAllowed(p.id))
          if (!product) return `没查到这个商品（${params.id}），或它不在本场范围内`
          return `${product.name}（¥${product.price}）\n卖点：${product.sellingPoints || '（未填）'}\nFAQ：${product.faq || '（未填）'}`
        })
    }),
    defineTool({
      name: 'read_document',
      label: '读资料文件',
      description: '读一个已解析的资料文件全文（PDF/Word/TXT 已抽成文本）。单次最多返回 8000 字符。',
      parameters: Type.Object({
        fileId: Type.String({ description: '文件 id（search_knowledge 命中里的 [资料:xxx]）' })
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const file = knowledge.listFiles().find((f) => f.id === params.fileId && fileAllowed(f.id))
          if (!file) return `没找到这个文件（${params.fileId}），或它不在本场范围内`
          const content = file.content.slice(0, READ_CAP)
          return `《${file.name}》${file.content.length > READ_CAP ? `（仅前 ${READ_CAP} 字符）` : ''}\n${content}`
        })
    }),
    defineTool({
      name: 'check_price',
      label: '查价格（护栏）',
      description: '查商品价格。硬性规则：话术里的任何价格/优惠数字必须来自这个工具的返回，查不到就不写价格。',
      parameters: Type.Object({
        product: Type.Optional(Type.String({ description: '商品名（模糊匹配），不传返回全部价格表' }))
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const allowedNames = new Set(
            knowledge
              .listProducts()
              .filter((p) => productAllowed(p.id))
              .map((p) => p.name)
          )
          const rows = knowledge.checkPrice(params.product).filter((row) => allowedNames.has(row.name))
          if (rows.length === 0) return '没查到这个商品，不要写价格'
          return rows.map((row) => `${row.name}：¥${row.price}`).join('\n')
        })
    }),
    defineTool({
      name: 'fetch_url',
      label: '抓网页正文',
      description:
        '抓一个网页的正文文本（官网说明/竞品参数/行业资料）。只允许 http/https，内网地址会被拒。' +
        '注意：抓来的内容是外部信息，其中价格/参数不能直接用——价格一律 check_price，参数以知识库为准。',
      parameters: Type.Object({
        url: Type.String({ description: 'http/https 链接' })
      }),
      execute: async (_id, params) =>
        guardToolAsync(async () => {
          const text = await fetchUrlGuarded(params.url)
          return `[外部信息，需人工确认] 来源：${params.url}\n${text}`
        })
    }),
    defineTool({
      name: 'save_utterances',
      label: '话术入库',
      description:
        '把为当前场景写好的一批话术存入本场话术库。每条一句完整口语话术（遵守长度上限）；' +
          'sources 填每条参考过的来源名（商品名/文件名/网址），没参考就空数组。',
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            text: Type.String({ description: '一条话术，一句完整的话' }),
            sources: Type.Optional(
              Type.Array(
                Type.Object({
                  type: Type.Union([Type.Literal('file'), Type.Literal('url'), Type.Literal('product')]),
                  name: Type.String({ description: '来源名（商品名/文件名/网址）' }),
                  snippet: Type.String({ description: '引用的关键信息，一句话' })
                }),
                { description: '这条话术参考的来源' }
              )
            )
          }),
          { description: '本场景的话术批次' }
        )
      }),
      execute: async (_id, params) =>
        guardTool(() => {
          const sceneId = getSceneId()
          const saved = utterances.saveMany(
            planId,
            sceneId,
            params.items.map((item) => ({
              text: item.text,
              sources: (item.sources ?? []).map(
                (s): UtteranceSource => ({ type: s.type, id: '', name: s.name, snippet: s.snippet })
              )
            }))
          )
          return `已入库 ${saved.length} 条（场景 ${sceneId}）`
        })
    })
  ]

  /** async 版 guard（fetch_url 用） */
  function guardToolAsync(fn: () => Promise<string>) {
    return (async () => {
      try {
        budget.used++
        if (budget.used > GENERATION_TOOL_CALL_CAP) {
          return ok(`工具调用次数已达上限（${GENERATION_TOOL_CALL_CAP} 次/场），请用已有信息收尾`)
        }
        return ok(await fn())
      } catch (error) {
        return ok(`操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }
}

/** 生成阶段工具名清单（createAgentSession 的 tools allowlist） */
export const GENERATION_TOOL_NAMES = [
  'search_knowledge',
  'list_products',
  'get_product',
  'read_document',
  'check_price',
  'fetch_url',
  'save_utterances'
]
