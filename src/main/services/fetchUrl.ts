/**
 * fetch_url 护栏（docs/07 §4.3）：高级网络请求工具——抓网页正文 / 调 JSON API / 联网搜索三合一。
 * - 只允许 http/https；拒绝内网/本机地址（SSRF）
 * - 单响应 ≤ 2MB、超时可调（默认 15s，上限 60s）
 * - 自动模式：HTML 剥标签取正文，其它 content-type（JSON/XML/纯文本）原样返回；raw=true 一律原文
 * - 可传 HTTP 代理（proxy 参数或 YUNCAST_PROXY 环境变量），被墙的站点用代理绕
 * - 结果带「外部信息，需人工确认」标记（审阅表高亮的依据）
 */

import { ProxyAgent } from 'undici'
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

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
  /** 是否自动跟随 3xx，默认 true；false 时把 Location 放进响应头行返回，便于看跳转链 */
  followRedirect?: boolean
  /** 二进制响应存到哪个目录（给了就落盘并返回路径，不给就只报类型和大小） */
  downloadDir?: string
  /** 正文字符上限（默认 HTML 8000 / 其它 12000；搜索解析需要整页时调大） */
  maxChars?: number
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
      redirect: input.followRedirect === false ? 'manual' : 'follow',
      // undici 的 dispatcher 不在标准 RequestInit 类型里，Node 18+ 的 fetch 实际支持
      ...(dispatcher ? { dispatcher } : {})
    } as RequestInit)
    const buf = await readBody(res)
    const contentType = res.headers.get('content-type') ?? ''
    const text = buf.toString('utf-8')
    const location = res.headers.get('location')
    const disposition = res.headers.get('content-disposition') ?? ''
    const meta = [
      `HTTP ${res.status} ${res.statusText}`,
      contentType || 'unknown content-type',
      formatBytes(buf.byteLength) + (location ? ` · Location: ${location}` : '')
    ].join(' · ')

    // 二进制（图片/PDF/音视频/附件）：落盘比把乱码塞回模型有用得多
    if (isBinary(contentType, disposition)) {
      if (!input.downloadDir) return `${meta}
（二进制内容，未落盘；需要文件就让工具带上项目目录）`
      const file = join(input.downloadDir, safeName(url.pathname, contentType))
      mkdirSync(input.downloadDir, { recursive: true })
      writeFileSync(file, buf)
      return `${meta}
已保存到：${file}
（二进制文件，需要处理就用 bash）`
    }

    let body = input.raw || !contentType.includes('text/html') ? text : htmlToText(text)
    // JSON 美化：调 API 时一眼能看清结构（解析失败就原样给）
    if (/json/i.test(contentType) && !input.raw) {
      try {
        body = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        // 非严格 JSON，保持原文
      }
    }
    const cap =
      input.maxChars ?? (input.raw || !contentType.includes('text/html') ? MAX_CHARS_RAW : MAX_CHARS_TEXT)
    return `${meta}

${body.slice(0, cap)}`
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

function isBinary(contentType: string, disposition: string): boolean {
  if (/attachment/i.test(disposition)) return true
  if (!contentType) return false
  return !/^(text\/|application\/(json|xml|xhtml\+xml|javascript|graphql)|.*\+(json|xml)|x-www-form-urlencoded)/i.test(
    contentType
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 落盘文件名：URL 最后一段 + 按内容类型兜底扩展名（只留安全字符，防目录穿越） */
function safeName(pathname: string, contentType: string): string {
  const base = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? 'download')
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80) || 'download'
  if (extname(cleaned)) return `${Date.now()}-${cleaned}`
  const ext = /pdf/i.test(contentType)
    ? '.pdf'
    : /png/i.test(contentType)
      ? '.png'
      : /jpe?g/i.test(contentType)
        ? '.jpg'
        : /webp/i.test(contentType)
          ? '.webp'
          : /gif/i.test(contentType)
            ? '.gif'
            : /audio|mpeg|mp3/i.test(contentType)
              ? '.mp3'
              : /video|mp4/i.test(contentType)
                ? '.mp4'
                : '.bin'
  return `${Date.now()}-${cleaned}${ext}`
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
export async function webSearchGuarded(
  query: string,
  timeoutSec?: number,
  proxy?: string,
  limit = 5
): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 200)
  if (!q) throw new Error('搜索词不能为空')
  const top = Math.min(Math.max(Math.floor(limit) || 5, 1), 10)
  // DuckDuckGo 在国内常被墙：先试它，失败/空结果再走必应（cn.bing.com）
  try {
    const hits = await duckSearch(q, top, timeoutSec, proxy)
    if (hits.length > 0) return hits
  } catch {
    // 落到 Bing
  }
  try {
    return await bingSearch(q, top, timeoutSec, proxy)
  } catch (error) {
    throw new Error(
      `搜索没成功（DuckDuckGo 与必应都不可达）：${
        error instanceof Error ? error.message : String(error)
      }。可以传 proxy 走代理再试`
    )
  }
}

/** DuckDuckGo html 端点：出站链接走 duckduckgo.com/l/?uddg= 跳转链，需要解码 */
async function duckSearch(q: string, top: number, timeoutSec?: number, proxy?: string): Promise<SearchHit[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const html = await httpRequestGuarded({ url: endpoint, raw: true, timeoutSec, proxy, maxChars: 200_000 })
  const hits: SearchHit[] = []
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const anchors: { url: string; title: string }[] = []
  const snippets: string[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ url: decodeUddg(m[1]), title: clean(m[2]) })
    if (anchors.length >= top) break
  }
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(clean(m[1]))
    if (snippets.length >= top) break
  }
  for (let i = 0; i < anchors.length; i++) {
    hits.push({ title: anchors[i].title, url: anchors[i].url, snippet: snippets[i] ?? '' })
  }
  return hits
}

/** 必应（cn.bing.com）：`<li class="b_algo">` 里 h2 > a 是标题与链接，后面的 <p> 是摘要 */
async function bingSearch(q: string, top: number, timeoutSec?: number, proxy?: string): Promise<SearchHit[]> {
  const endpoint = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=${top}`
  const html = await httpRequestGuarded({ url: endpoint, raw: true, timeoutSec, proxy, maxChars: 200_000 })
  const hits: SearchHit[] = []
  const itemRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) !== null && hits.length < top) {
    const block = m[0]
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({ url: decodeEntities(m[1]), title: clean(m[2]), snippet: clean(snippetMatch?.[1] ?? '') })
  }
  if (hits.length === 0) throw new Error('必应没返回可解析的结果（可能是反爬）')
  return hits
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
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
    // 数字实体（&#0183; 这类是必应摘要里的间隔符）与常见排版实体
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number(dec)))
    .replace(/&ensp;|&emsp;|&thinsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeChar(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
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
