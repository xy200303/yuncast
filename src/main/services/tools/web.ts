import { join } from 'node:path'
import { Type } from 'typebox'
import { httpRequestGuarded, webSearchGuarded } from '../fetchUrl'
import { defineTool } from './types'

/**
 * 网络域：HTTP 请求 + 联网搜索。
 * - curl：GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，自定义 headers/cookies/body/代理（内置实现，不走系统 curl）；
 *   返回状态行 + content-type + 大小（HTML 剥正文、JSON 美化）；二进制（图片/PDF/音视频）落进项目的 assets/downloads
 * - web_search：DuckDuckGo 搜索，返回前 N 条标题/链接/摘要
 * 结果都标注「外部信息，需人工确认」：数字与功效以项目素材为准，别直接照搬进承诺。
 */
export const webTools = [
  defineTool({
    name: 'curl',
    label: 'curl',
    domain: 'web',
    risk: 'write',
    expose: { agent: true, mcp: true },
    description:
      'HTTP 请求（名字叫 curl，但它是内置实现，不用系统 curl、也不起进程）：抓网页、调 API。' +
      '默认 GET；支持 POST/PUT/PATCH/DELETE/HEAD/OPTIONS，headers/cookies/body 都可自定义（body 是 JSON 会自动带 Content-Type）。' +
      '返回第一行是「HTTP 状态 · content-type · 大小」，后面是正文：HTML 自动剥标签取正文，JSON 自动美化，raw=true 强制原文。' +
      '图片/PDF/音视频这类二进制会存进项目的 assets/downloads 并返回本机路径（可用 bash 继续处理）；saveBinary=false 则只报告类型和大小。' +
      'followRedirect=false 时不跟随 3xx，Location 会出现在状态行里。超时默认 15 秒（最多 60）；被墙的站点传 proxy（如 http://127.0.0.1:7897）。' +
      '不需要自定义方法/头/体、只是想看一个网页正文时，用它最直接。',
    parameters: Type.Object({
      url: Type.String({ description: 'http/https 链接' }),
      method: Type.Optional(
        Type.String({ description: 'GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，默认 GET' })
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: '请求头键值对，比如 { "Authorization": "Bearer xxx" }'
        })
      ),
      cookies: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: 'Cookie 键值对，会拼成 Cookie 头' })
      ),
      body: Type.Optional(Type.String({ description: '请求体（POST/PUT/PATCH 用），比如 JSON 字符串' })),
      raw: Type.Optional(Type.Boolean({ description: 'true 返回原始响应不剥 HTML/不美化 JSON，默认自动判断' })),
      followRedirect: Type.Optional(
        Type.Boolean({ description: '是否自动跟随 3xx，默认 true；false 时返回 Location 便于看跳转链' })
      ),
      saveBinary: Type.Optional(
        Type.Boolean({ description: '二进制响应是否落盘到项目 assets/downloads，默认 true' })
      ),
      timeoutSec: Type.Optional(Type.Number({ description: '超时秒数，默认 15，最多 60' })),
      proxy: Type.Optional(
        Type.String({ description: 'HTTP 代理，比如 http://127.0.0.1:7897；站点被墙或直连失败时用' })
      )
    }),
    handler: async (ctx, params) => {
      const url = params.url.trim()
      if (!url) return 'url 不能为空'
      const root = ctx.projectRoot?.()
      const text = await httpRequestGuarded({
        url,
        method: params.method,
        headers: params.headers,
        cookies: params.cookies,
        body: params.body,
        raw: params.raw,
        followRedirect: params.followRedirect,
        downloadDir: params.saveBinary === false || !root ? undefined : join(root, 'assets', 'downloads'),
        timeoutSec: params.timeoutSec,
        proxy: params.proxy
      })
      return `【外部信息，需人工确认】\n${text}`
    }
  }),
  defineTool({
    name: 'web_search',
    label: '联网搜索',
    domain: 'web',
    risk: 'read',
    expose: { agent: true, mcp: true },
    description:
      '联网搜索：给关键词，返回前 N 条「标题 / 链接 / 摘要」（默认 5，最多 10）。优先 DuckDuckGo，国内不可达时自动切必应（cn.bing.com）。' +
      '想细看某条就用 curl 打开它的链接。结果标注「外部信息，需人工确认」，数字/功效以项目素材为准。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词' }),
      limit: Type.Optional(Type.Number({ description: '返回条数，默认 5，最大 10' })),
      timeoutSec: Type.Optional(Type.Number({ description: '超时秒数，默认 15，最多 60' })),
      proxy: Type.Optional(Type.String({ description: 'HTTP 代理，比如 http://127.0.0.1:7897' }))
    }),
    handler: async (_ctx, params) => {
      const hits = await webSearchGuarded(params.query, params.timeoutSec, params.proxy, params.limit)
      const body = hits
        .map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.snippet.slice(0, 200)}`)
        .join('\n\n')
      return `【外部信息，需人工确认】\n${body}`
    }
  })
]
