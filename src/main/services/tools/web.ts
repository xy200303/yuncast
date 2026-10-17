import { Type } from 'typebox'
import { httpRequestGuarded, webSearchGuarded } from '../fetchUrl'
import { defineTool } from './types'

/**
 * 网络域：抓网页 / 调 API / 联网搜索。
 * 合并自旧 fetch_url（实现原样照搬，走 fetchUrl.ts 的护栏版请求）。
 */
export const webTools = [
  defineTool({
    name: 'web_fetch',
    label: '网络请求',
    domain: 'web',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      '高级网络请求：抓网页、调 API、联网搜索都走它。' +
      '给 url 直接发请求（默认 GET；HTML 自动剥标签取正文，JSON/XML 等原样返回，raw=true 强制原文）；' +
      '给 query 则联网搜索（前 5 条标题/链接/摘要）。url 和 query 二选一，都传时优先搜索。' +
      '支持自定义 method/headers/cookies/body：调 JSON API 时 method=POST、body 传 JSON 字符串即可（Content-Type 会自动补）。' +
      '超时默认 15 秒，可用 timeoutSec 调长（最多 60）；站点被墙/直连失败时传 proxy（如 http://127.0.0.1:7897）走代理。' +
      '结果标注「外部信息，需人工确认」：数字/功效以知识库为准（knowledge_search/price_check），别直接照搬进承诺。',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'http/https 链接（和 query 二选一）' })),
      query: Type.Optional(Type.String({ description: '搜索关键词（和 url 二选一）：联网搜索前 5 条' })),
      method: Type.Optional(
        Type.String({ description: 'GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，默认 GET' })
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: '请求头键值对，比如 { "Authorization": "Bearer xxx" }' })
      ),
      cookies: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: 'Cookie 键值对，会拼成 Cookie 头' })
      ),
      body: Type.Optional(
        Type.String({ description: '请求体（POST/PUT/PATCH 用），比如 JSON 字符串' })
      ),
      raw: Type.Optional(
        Type.Boolean({ description: 'true 返回原始响应不剥 HTML，默认自动判断' })
      ),
      timeoutSec: Type.Optional(Type.Number({ description: '超时秒数，默认 15，最多 60' })),
      proxy: Type.Optional(
        Type.String({ description: 'HTTP 代理，比如 http://127.0.0.1:7897；站点被墙或直连失败时用' })
      )
    }),
    handler: async (ctx, params) => {
      const query = params.query?.trim()
      if (query) {
        const hits = await webSearchGuarded(query, params.timeoutSec, params.proxy)
        const body = hits
          .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet.slice(0, 150)}`)
          .join('\n')
        return `【外部信息，需人工确认】\n${body}`
      }
      const url = params.url?.trim()
      if (!url) return '要么给 url 发请求，要么给 query 搜索，二选一'
      const text = await httpRequestGuarded({
        url,
        method: params.method,
        headers: params.headers,
        cookies: params.cookies,
        body: params.body,
        raw: params.raw,
        timeoutSec: params.timeoutSec,
        proxy: params.proxy
      })
      return `【外部信息，需人工确认】\n${text}`
    }
  })
]
