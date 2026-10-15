/**
 * fetch_url 护栏（docs/07 §4.3）：生成阶段抓网页正文（竞品参数/官网说明）。
 * - 只允许 http/https；拒绝内网/本机地址（SSRF）
 * - 单页 ≤ 2MB、超时 ≤ 10s、只取正文文本（粗暴去标签）
 * - 结果带「外部信息，需人工确认」标记（审阅表高亮的依据）
 */

const MAX_BYTES = 2 * 1024 * 1024
const MAX_CHARS = 8000
const TIMEOUT_MS = 10_000

/** 内网/本机地址段（解析后的 IP 字面量匹配；域名不解析 DNS，只拦字面量与常见本机名） */
const BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i

export async function fetchUrlGuarded(rawUrl: string): Promise<string> {
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'YunCast/0.1 (+content-fetch)', Accept: 'text/html,text/plain,*/*' },
      redirect: 'follow'
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('响应没有内容')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('页面超过 2MB，太大了')
      }
      chunks.push(value)
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8')
    return htmlToText(html).slice(0, MAX_CHARS)
  } finally {
    clearTimeout(timer)
  }
}

/** 同一护栏，但返回原始 HTML（web_search 解析结果页用）。同样限 2MB。 */
export async function fetchRawGuarded(rawUrl: string): Promise<string> {
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'YunCast/0.1 (+search)' },
      redirect: 'follow'
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('响应没有内容')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('页面超过 2MB，太大了')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8')
  } finally {
    clearTimeout(timer)
  }
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * web_search 护栏：DuckDuckGo html 端点，前 5 条「标题/链接/摘要」。
 * 出站链接走 duckduckgo.com/l/?uddg= 跳转链，需要解码出真实地址。
 */
export async function webSearchGuarded(query: string): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 200)
  if (!q) throw new Error('搜索词不能为空')
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const html = await fetchRawGuarded(endpoint)
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
