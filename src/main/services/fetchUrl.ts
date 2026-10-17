/**
 * fetch_url 护栏（docs/07 §4.3）：高级网络请求工具——抓网页正文 / 调 JSON API / 联网搜索三合一。
 * - 只允许 http/https；拒绝内网/本机地址（SSRF）
 * - 单响应 ≤ 2MB、超时可调（默认 15s，上限 60s）
 * - 自动模式：HTML 剥标签取正文，其它 content-type（JSON/XML/纯文本）原样返回；raw=true 一律原文
 * - 可传 HTTP 代理（proxy 参数或 YUNCAST_PROXY 环境变量），被墙的站点用代理绕
 * - 结果带「外部信息，需人工确认」标记（审阅表高亮的依据）
 */

import { ProxyAgent } from 'undici'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_CHARS_TEXT = 8000
const MAX_CHARS_RAW = 12000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** 内网/本机地址段（解析后的 IP 字面量匹配；域名不解析 DNS，只拦字面量与常见本机名） */
const BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i

export interface HttpRequestInput {
  url: string
  method?: string
  headers?: Record<string, string>
  cookies?: Record<string, string>
  body?: string
  raw?: boolean
  timeoutSec?: number
  /** HTTP 代理，比如 http://127.0.0.1:7897；不传时回退到 YUNCAST_PROXY 环境变量 */
  proxy?: string
}

/** 代理 dispatcher：显式参数优先，其次环境变量；都没有就直连 */
function dispatcherFor(proxy?: string): ProxyAgent | undefined {
  const p = (proxy ?? process.env['YUNCAST_PROXY'] ?? '').trim()
  if (!p) return undefined
  if (!/^https?:\/\//i.test(p)) throw new Error('代理地址只支持 http:// 或 https:// 开头')
  return new ProxyAgent(p)
}

function checkUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL 不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许 http/https 链接')
  }
  if (BLOCKED_HOST.test(url.hostname)) {
    throw new Error('不允许访问内网/本机地址')
  }
  return url
}

/** 读响应体，超 2MB 截断报错 */
async function readBody(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Error('响应超过 2MB，太大了')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

/**
 * 高级网络请求（带护栏）。非 2xx 不抛错，返回 `HTTP <状态码>` 头行 + 响应体，方便排查 API 问题。
 */
export async function httpRequestGuarded(input: HttpRequestInput): Promise<string> {
  const url = checkUrl(input.url.trim())
  const method = (input.method ?? 'GET').trim().toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`不支持的方法 ${method}（可用：${[...ALLOWED_METHODS].join('/')}）`)
  }

  const headers: Record<string, string> = {
    'User-Agent': 'YunCast/0.1 (+http-request)',
    Accept: '*/*',
    ...sanitizeHeaders(input.headers)
  }
  const cookieHeader = serializeCookies(input.cookies)
  if (cookieHeader) headers['Cookie'] = cookieHeader

  const hasBody = typeof input.body === 'string' && input.body.length > 0
  if (hasBody && (method === 'GET' || method === 'HEAD')) {
    throw new Error(`${method} 不能带请求体`)
  }
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = looksLikeJson(input.body!) ? 'application/json' : 'text/plain; charset=utf-8'
  }

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1_000, Math.round((input.timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000))
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const dispatcher = dispatcherFor(input.proxy)
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: hasBody ? input.body : undefined,
      redirect: 'follow',
      // undici 的 dispatcher 不在标准 RequestInit 类型里，Node 18+ 的 fetch 实际支持
      ...(dispatcher ? { dispatcher } : {})
    } as RequestInit)
    const buf = await readBody(res)
    const text = buf.toString('utf-8')
    const contentType = res.headers.get('content-type') ?? ''
    const isHtml = contentType.includes('text/html')
    const body = input.raw || !isHtml ? text : htmlToText(text)
    const cap = input.raw || !isHtml ? MAX_CHARS_RAW : MAX_CHARS_TEXT
    const statusLine = res.ok ? '' : `HTTP ${res.status} ${res.statusText}\n`
    return statusLine + body.slice(0, cap)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒没响应，可以用 timeoutSec 调长，最多 60 秒；被墙的站点传 proxy 走代理）`)
    }
    if (error instanceof TypeError && /fetch failed/i.test(error.message) && !input.proxy) {
      throw new Error('网络连接失败（站点可能不可达或被墙）：可以传 proxy 参数走 HTTP 代理重试，比如 http://127.0.0.1:7897')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 请求头白名单化：去掉 fetch 禁头与明显危险的伪头，值转字符串 */
function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  const banned = /^(host|connection|content-length|transfer-encoding|upgrade|sec-|proxy-)/i
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).trim()
    if (!key || banned.test(key)) continue
    out[key] = String(v)
  }
  return out
}

function serializeCookies(cookies?: Record<string, string>): string {
  if (!cookies) return ''
  return Object.entries(cookies)
    .map(([k, v]) => `${String(k).trim()}=${String(v).replace(/[;\r\n]/g, '')}`)
    .filter((pair) => !pair.startsWith('='))
    .join('; ')
}

function looksLikeJson(body: string): boolean {
  const t = body.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * 联网搜索：DuckDuckGo html 端点，前 5 条「标题/链接/摘要」。
 * 出站链接走 duckduckgo.com/l/?uddg= 跳转链，需要解码出真实地址。
 */
export async function webSearchGuarded(query: string, timeoutSec?: number, proxy?: string): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 200)
  if (!q) throw new Error('搜索词不能为空')
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const html = await httpRequestGuarded({ url: endpoint, raw: true, timeoutSec, proxy })
  const hits: SearchHit[] = []
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const anchors: { url: string; title: string }[] = []
  const snippets: string[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ url: decodeUddg(m[1]), title: clean(m[2]) })
    if (anchors.length >= 5) break
  }
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(clean(m[1]))
    if (snippets.length >= 5) break
  }
  for (let i = 0; i < anchors.length; i++) {
    hits.push({ title: anchors[i].title, url: anchors[i].url, snippet: snippets[i] ?? '' })
  }
  if (hits.length === 0) throw new Error('没搜到结果（可能是网络或反爬），换几个关键词试试')
  return hits
}

/** duckduckgo.com/l/?uddg=<urlencoded> 跳转链 → 真实地址 */
function decodeUddg(href: string): string {
  const raw = href.replace(/&amp;/g, '&')
  const m = /[?&]uddg=([^&]+)/.exec(raw)
  if (!m) return raw.startsWith('//') ? `https:${raw}` : raw
  try {
    return decodeURIComponent(m[1])
  } catch {
    return raw
  }
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 粗暴正文提取：去 script/style/标签/实体，压空白。够用即可，不做 readability。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}
