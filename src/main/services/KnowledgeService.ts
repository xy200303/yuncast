import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import type {
  MaterialFile,
  MaterialHit,
  KnowledgeKind,
  Material,
  MaterialInput,
  ProgramKnowledgeScope
} from '../../shared/types'
import type { StorageService } from './StorageService'
import type { BlobStoreService } from './BlobStoreService'

/**
 * 知识库（docs/01 §4）：商品资料 + 文件资料包，关键词检索（第一版零依赖可解释）。
 * 检索照旧版 sonic-anchor 的中文二元词评分：词条短、命中率高。
 */

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

function kindFromPath(filePath: string): KnowledgeKind {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt' || ext === '.md') return 'text'
  if (ext === '.docx') return 'doc'
  if (ext === '.pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  throw new Error('仅支持 TXT / MD / DOCX / PDF / 图片文件')
}

/** 中文二元词切词（照旧版）：英文数字整词，汉字按二元滑窗 */
function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const terms = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu)) {
    const value = match[0]
    if (/^[a-z0-9]+$/.test(value)) {
      terms.add(value)
      continue
    }
    for (let index = 0; index < value.length - 1; index += 1) {
      terms.add(value.slice(index, index + 2))
    }
  }
  return terms
}

function snippetAround(content: string, terms: Set<string>, width = 120): string {
  const lower = content.toLowerCase()
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at >= 0) {
      const start = Math.max(0, at - 20)
      return content.slice(start, start + width).trim()
    }
  }
  return content.slice(0, width).trim()
}

export class KnowledgeService {
  /** 知识库变更（保存/删除/同步/导入）：index.ts 接上 → 广播让界面重拉 */
  onChanged: ((scope: 'entries' | 'files') => void) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly blobs: BlobStoreService
  ) {}

  // ---------- 知识条目（商品/书籍/话题/自定义；商品是价格护栏数据源） ----------

  listMaterials(): Material[] {
    return this.storage.materialList()
  }

  saveMaterial(input: MaterialInput, id?: string): Material {
    const name = input.name.trim()
    if (!name) throw new Error('条目名称不能为空')
    const product: Material = {
      id: id ?? `pd-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      name,
      kind: input.kind ?? 'product',
      price: input.kind === 'product' || input.price > 0 ? input.price : 0,
      sellingPoints: input.sellingPoints.trim(),
      faq: input.faq.trim(),
      content: (input.content ?? '').trim(),
      externalId: input.externalId?.trim() ?? '',
      meta: input.meta ?? {},
      createdAt: id ? (this.storage.materialList().find((p) => p.id === id)?.createdAt ?? Date.now()) : Date.now()
    }
    this.storage.materialSave(product)
    this.onChanged?.('entries')
    return product
  }

  deleteMaterial(id: string): void {
    this.storage.materialDelete(id)
    this.onChanged?.('entries')
  }

  // ---------- 资料文件 ----------

  listFiles(): MaterialFile[] {
    return this.storage.materialFileList()
  }

  /**
   * 上传资料文件：解析入库。
   * 图片第一版不做 vision——content 存用户填的一句话描述（检索照样能命中）。
   */
  /** 给素材挂一条外部链接（官网/文档/商品页）：agent 需要时按名称与标题去检索，不主动抓正文 */
  attachUrl(materialId: string, url: string, title?: string): MaterialFile {
    const clean = url.trim()
    if (!/^https?:\/\//i.test(clean)) throw new Error('链接要以 http:// 或 https:// 开头')
    const material = this.storage.materialList().find((item) => item.id === materialId)
    if (!material) throw new Error('素材不存在（可能已被删除）')
    const file: MaterialFile = {
      id: `kf-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      materialId,
      type: 'url',
      url: clean,
      name: title?.trim() || clean.replace(/^https?:\/\//i, '').slice(0, 60),
      kind: 'text',
      content: '',
      filePath: '',
      createdAt: Date.now()
    }
    this.storage.materialFileInsert(file)
    this.onChanged?.('files')
    return file
  }

  async uploadFile(filePath: string, description?: string, materialId?: string): Promise<MaterialFile> {
    const kind = kindFromPath(filePath)
    let content: string
    if (kind === 'image') {
      content = (description ?? '').trim()
      if (!content) throw new Error('图片资料需要一句话描述（比如：某款锅的质检报告）')
    } else {
      content = await this.extractText(filePath, kind)
      if (!content) throw new Error('文件里没有解析出可用文字（扫描件/加密文件不支持）')
      if (description?.trim()) content = `${description.trim()}\n${content}`
    }
    // 附件复制进 BlobStore（asset 档，move=false 不动用户原文件）：之后用户移动/删了原文件，重新解析照样能读
    const put = await this.blobs.putFile(filePath, extname(filePath).replace(/^\./, '').toLowerCase(), {
      tier: 'asset',
      move: false
    })
    const file: MaterialFile = {
      id: `kf-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      materialId: materialId?.trim() ?? '',
      name: basename(filePath),
      kind,
      content: content.slice(0, 20000),
      filePath: put.path,
      createdAt: Date.now()
    }
    this.storage.materialFileInsert(file)
    return file
  }

  deleteFile(id: string): void {
    const file = this.storage.materialFileList().find((item) => item.id === id)
    this.storage.materialFileDelete(id)
    // blob 附件：删行的钩子已解除引用，没别的资料共用同一文件才删（asset 档只能显式删）
    const hash = file ? this.blobs.hashForPath(file.filePath) : null
    if (hash) void this.blobs.deleteIfUnreferenced(hash)
  }

  private async extractText(filePath: string, kind: KnowledgeKind): Promise<string> {
    if (kind === 'text') return (await readFile(filePath)).toString('utf8').replace(/\x00/g, '').trim()
    if (kind === 'doc') {
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value.replace(/\x00/g, '').trim()
    }
    const parser = new PDFParse({ data: await readFile(filePath) })
    try {
      const result = await parser.getText()
      return result.text.replace(/\x00/g, '').trim()
    } finally {
      await parser.destroy()
    }
  }

  // ---------- 检索（主播工具的数据源） ----------

  /** 关键词检索商品 + 资料文件，按命中评分排序。scope：当前节目的知识范围（'*' = 全库；id 数组 = 只查这些条目/文件） */
  searchKnowledge(query: string, limit = 3, scope?: ProgramKnowledgeScope): MaterialHit[] {
    const terms = tokenize(query)
    if (terms.size === 0) return []
    const normalized = query.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

    const scored: { hit: MaterialHit; score: number }[] = []
    for (const product of this.storage.materialList()) {
      if (scope && scope.materials !== '*' && !scope.materials.includes(product.id)) continue
      const haystack = `${product.name}\n${product.sellingPoints}\n${product.faq}`.toLowerCase()
      let score = normalized.includes(product.name.toLowerCase()) ? 100 : 0
      for (const term of terms) if (haystack.includes(term)) score += term.length
      if (score > 0) {
        scored.push({
          hit: {
            source: 'material',
            id: product.id,
            name: product.name,
            snippet: snippetAround(`${product.sellingPoints}\n${product.faq}`, terms),
            price: product.kind === 'product' ? product.price : undefined,
            kind: product.kind
          },
          score
        })
      }
    }
    for (const file of this.storage.materialFileList()) {
      if (scope && file.materialId && scope.materials !== '*' && !scope.materials.includes(file.materialId)) continue
      const haystack = `${file.name}\n${file.content}`.toLowerCase()
      let score = normalized.includes(file.name.toLowerCase()) ? 50 : 0
      for (const term of terms) if (haystack.includes(term)) score += term.length
      if (score > 0) {
        scored.push({
          hit: {
            source: 'file',
            id: file.id,
            name: file.name,
            snippet: snippetAround(file.content, terms)
          },
          score
        })
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((entry) => entry.hit)
  }

  /** 价格护栏：主播报价只能出自这里（只有「商品」类型的条目参与，且限在 scope 范围内）。不传名字返回全部商品价格表。 */
  checkPrice(productName?: string, scope?: ProgramKnowledgeScope): { name: string; price: number; sellingPoints: string }[] {
    const products = this.storage
      .materialList()
      .filter((p) => p.kind === 'product' && (!scope || scope.materials === '*' || scope.materials.includes(p.id)))
    if (!productName?.trim()) return products.map(({ name, price, sellingPoints }) => ({ name, price, sellingPoints }))
    const keyword = productName.trim().toLowerCase()
    return products
      .filter((p) => p.name.toLowerCase().includes(keyword))
      .map(({ name, price, sellingPoints }) => ({ name, price, sellingPoints }))
  }

  // ---------- 外部同步（抖音商城等，走连接器 MCP 工具） ----------

  /**
   * 从连接器同步商品（抖音商城绑定的商品数据）：
   * 发现式——先 listTools 找商品类工具（名字含 product/goods/shop），调它拿列表，
   * 按 externalId 去重 upsert（已存在的更新价格/卖点，不新建重复条目）。
   */
  async syncFromConnector(connector: {
    listTools: () => Promise<{ name: string; description?: string }[]>
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  }): Promise<{ added: number; updated: number; total: number }> {
    const tools = await connector.listTools()
    const tool = tools.find((t) => /product|goods|shop|商品/i.test(`${t.name} ${t.description ?? ''}`))
    if (!tool) {
      throw new Error(
        `连接器没提供商品工具（现有：${tools.map((t) => t.name).join('、') || '无'}）——升级连接器到带商品列表工具的版本`
      )
    }
    const raw = await connector.callTool(tool.name, {})
    const items = parseConnectorProducts(raw)
    if (items.length === 0) throw new Error(`连接器返回的商品列表是空的或格式不认识（${raw.slice(0, 100)}）`)
    let added = 0
    let updated = 0
    const existing = this.storage.materialList()
    for (const item of items) {
      const dup = item.externalId
        ? existing.find((p) => p.externalId === item.externalId)
        : existing.find((p) => !p.externalId && p.name === item.name)
      this.saveMaterial(
        {
          name: item.name,
          kind: 'product',
          price: item.price,
          sellingPoints: item.sellingPoints,
          faq: dup?.faq ?? '',
          content: dup?.content ?? '',
          externalId: item.externalId,
          meta: { 来源: '抖音商城', ...(dup?.meta ?? {}) }
        },
        dup?.id
      )
      if (dup) updated++
      else added++
    }
    return { added, updated, total: items.length }
  }
}

/** 连接器返回的商品文本 → 条目：优先按 JSON 解析（数组或 {list|products|items}），字段名中英文都认 */
function parseConnectorProducts(raw: string): { externalId: string; name: string; price: number; sellingPoints: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>)?.list ??
      (parsed as Record<string, unknown>)?.products ??
      (parsed as Record<string, unknown>)?.items ??
      (parsed as Record<string, unknown>)?.data)
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const r = item as Record<string, unknown>
    const name = String(r.name ?? r.title ?? r.productName ?? '').trim()
    if (!name) continue
    const priceRaw = r.price ?? r.finalPrice ?? r.salePrice ?? r.售价 ?? r.价格
    const price = typeof priceRaw === 'number' ? priceRaw : Number(String(priceRaw ?? '').replace(/[¥￥\s]/g, '')) || 0
    const sellingPoints = String(r.description ?? r.sellingPoints ?? r.卖点 ?? r.desc ?? '').trim()
    const externalId = String(r.id ?? r.productId ?? r.product_id ?? r.itemId ?? '').trim()
    out.push({ externalId, name, price, sellingPoints })
  }
  return out
}
