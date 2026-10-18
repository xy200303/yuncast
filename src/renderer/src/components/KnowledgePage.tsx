import { useCallback, useEffect, useState } from 'react'
import { BookOpen, FileImage, FileText, Loader2, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ENTRY_KINDS, ENTRY_KIND_LABEL } from '../../../shared/types'
import type { EntryKind, MaterialFile, KnowledgeKind, Material, MaterialInput } from '../../../shared/types'
import { useAppStore } from '../stores/useAppStore'
import { useDataRefresh } from '../lib/useDataRefresh'
import { AssetStaleBanner } from './AssetStaleBanner'

const KIND_LABEL: Record<KnowledgeKind, string> = {
  text: '文本',
  doc: '文档',
  pdf: 'PDF',
  image: '图片'
}

type KindFilter = EntryKind | 'all'

/** 类型筛选/选择 chip（与设置页服务商 chips 同款 pill 样式） */
const chipClass = (active: boolean) =>
  `rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'bg-card text-muted-foreground hover:text-foreground'
  }`

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 素材库：条目（商品/书籍/话题/自定义，价格护栏只认商品）+ 附件（解析入库参与检索） */
export function KnowledgePage() {
  const [products, setProducts] = useState<Material[]>([])
  const [files, setFiles] = useState<MaterialFile[]>([])
  const [editing, setEditing] = useState<{ product?: Material } | null>(null)
  const [deleting, setDeleting] = useState<Material | null>(null)
  /** 待删的文档/图片（删除走确认弹窗：文档是解析过的知识，删错就得重传重解析） */
  const [deletingFile, setDeletingFile] = useState<MaterialFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [imageDraft, setImageDraft] = useState<string | null>(null) // 待填描述的图片路径
  const [tab, setTab] = useState<'products' | 'files'>('products')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [syncing, setSyncing] = useState(false)
  const connector = useAppStore((s) => s.connector)

  const reload = useCallback(async () => {
    const [p, f] = await Promise.all([window.api.knowledge.listMaterials(), window.api.knowledge.listFiles()])
    setProducts(p)
    setFiles(f)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])
  useDataRefresh(['knowledge'], () => void reload())

  // 页面常驻不卸载（App 用显隐切页）：每次回到知识库重新拉一遍。
  // 别的内容源也会改这份数据——主播的 save_knowledge_entry / connector 同步商品——
  // 只在挂载时拉一次的话，这些改动要等重启才看得见（实测：API 刚建的文档，页面仍显示 0）
  const page = useAppStore((s) => s.page)
  useEffect(() => {
    if (page === 'knowledge') void reload()
  }, [page, reload])

  const sync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const result = await window.api.knowledge.syncProducts()
      if (result.ok) {
        toast.success(`同步完成：新增 ${result.added} · 更新 ${result.updated}`)
        await reload()
      } else {
        toast.error('同步失败', { description: result.error })
      }
    } finally {
      setSyncing(false)
    }
  }

  const visibleProducts =
    kindFilter === 'all' ? products : products.filter((product) => product.kind === kindFilter)

  const upload = async () => {
    const filePath = await window.api.dialog.pickFile('资料文件', [
      'txt', 'md', 'docx', 'pdf', ...IMAGE_EXTENSIONS
    ])
    if (!filePath) return
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    if (IMAGE_EXTENSIONS.includes(ext)) {
      // 图片不做 vision，先收一句描述再入库
      setImageDraft(filePath)
      return
    }
    await doUpload(filePath)
  }

  const doUpload = async (filePath: string, description?: string) => {
    setUploading(true)
    try {
      const result = await window.api.knowledge.uploadFile(filePath, description)
      if (result.ok) {
        toast.success('资料已入库', { description: result.file.name })
        await reload()
      } else {
        toast.error('解析失败', { description: result.error })
      }
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <AssetStaleBanner />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BookOpen className="size-4 shrink-0 text-primary" />
        <h1 className="shrink-0 text-sm font-medium">素材</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">条目与附件（主播答题的弹药库）· 剧本单独管理</p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {tab === 'products' && (
            <Button variant="outline" size="sm" onClick={() => setEditing({})}>
              <Plus />
              新建条目
            </Button>
          )}
          {tab === 'files' && (
            <Button size="sm" disabled={uploading} onClick={() => void upload()}>
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
              {uploading ? '解析中…' : '上传资料'}
            </Button>
          )}

        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="products" className="px-3">条目 · {products.length}</TabsTrigger>
            <TabsTrigger value="files" className="px-3">附件 · {files.length}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="products" className="overflow-auto p-4">
          <div className="mb-3 flex items-center gap-2">
            <button type="button" className={chipClass(kindFilter === 'all')} onClick={() => setKindFilter('all')}>
              全部
            </button>
            {ENTRY_KINDS.map((kind) => (
              <button key={kind} type="button" className={chipClass(kindFilter === kind)} onClick={() => setKindFilter(kind)}>
                {ENTRY_KIND_LABEL[kind]}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={connector.state !== 'connected' || syncing}
              title={connector.state !== 'connected' ? '连接器未连接' : undefined}
              onClick={() => void sync()}
            >
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              从抖音商城同步
            </Button>
          </div>
          {visibleProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
              <BookOpen className="size-8" strokeWidth={1.25} />
              <p className="text-sm">
                {products.length === 0
                  ? '还没有条目。主播报价只认这里商品的价格，先建一个'
                  : '这个类型下还没有条目'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0 xl:grid-cols-3">
              {visibleProducts.map((product) => (
                <Card key={product.id} className="group/card gap-2 py-3">
                  <CardHeader className="px-4">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="min-w-0 flex-1 truncate text-sm">
                        {product.name}
                        {product.kind === 'book' && product.meta.author ? (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {product.meta.author}
                          </span>
                        ) : null}
                      </CardTitle>
                      {product.kind === 'product' ? (
                        <span className="shrink-0 text-sm font-semibold text-primary">¥{product.price}</span>
                      ) : (
                        <Badge variant="outline" className="shrink-0">
                          {ENTRY_KIND_LABEL[product.kind]}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="px-4">
                    <p className="line-clamp-3 min-h-9 text-sm text-muted-foreground">
                      {product.sellingPoints || (product.kind === 'product' ? '（还没写卖点）' : '（还没写要点）')}
                    </p>
                    {(() => {
                      const count = files.filter((file) => file.materialId === product.id).length
                      return count > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">附件 {count}</p>
                      ) : null
                    })()}
                    <div className="mt-2 flex justify-end gap-1 opacity-0 group-hover/card:opacity-100">
                      <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditing({ product })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeleting(product)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="overflow-auto p-4">
          {files.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
              <FileText className="size-8" strokeWidth={1.25} />
              <p className="text-sm">上传商品文档/质检报告/FAQ，解析后主播就能查到</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {files.map((file) => (
                <div key={file.id} className="group/row flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                  {file.kind === 'image' ? (
                    <FileImage className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <Badge variant="outline">{KIND_LABEL[file.kind]}</Badge>
                  <span className="shrink-0 text-[13px]">{file.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={file.content}>
                    {file.content.slice(0, 80)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover/row:opacity-100"
                    title="删除"
                    onClick={() => setDeletingFile(file)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

      </Tabs>

      <EntryDialog
        key={editing?.product?.id ?? 'new-entry'}
        open={editing !== null}
        product={editing?.product}
        assets={files.filter((file) => file.materialId === (editing?.product?.id ?? ''))}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除条目</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？
            {deleting?.kind === 'product' ? '主播将查不到它的价格。' : ''}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                void window.api.knowledge.deleteMaterial(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await reload()
                  } else toast.error('删除失败', { description: result.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deletingFile !== null} onOpenChange={(open) => !open && setDeletingFile(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除文档</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deletingFile?.name}」？解析出来的内容会一起删掉，主播就查不到这份资料了（要回来得重新上传解析）。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingFile(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deletingFile
                setDeletingFile(null)
                if (!target) return
                void window.api.knowledge.deleteFile(target.id).then(async (result) => {
                  if (result.ok) {
                    toast.success('已删除')
                    await reload()
                  } else toast.error('删除失败', { description: result.error })
                })
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 换图片时重挂载，靠状态初始化清空描述草稿（见 ImageDescribeDialog 内注释） */}
      <ImageDescribeDialog
        key={imageDraft ?? 'none'}
        filePath={imageDraft}
        onOpenChange={(open) => !open && setImageDraft(null)}
        onConfirm={async (description) => {
          const filePath = imageDraft
          setImageDraft(null)
          if (filePath) await doUpload(filePath, description)
        }}
      />
    </div>
  )
}

/** 条目要点/备注字段的文案（按类型变） */
const ENTRY_FIELD_LABEL: Record<EntryKind, { points: string; pointsPlaceholder: string; note: string; notePlaceholder: string }> = {
  product: {
    points: '卖点',
    pointsPlaceholder: '一行一个卖点，主播讲产品时参考',
    note: 'FAQ（常见问题和答案）',
    notePlaceholder: '问：……\n答：……'
  },
  book: {
    points: '内容要点',
    pointsPlaceholder: '一行一条：这本书讲了什么、金句、适用话题',
    note: '备注',
    notePlaceholder: '主播讲这本书时要注意的口径'
  },
  topic: {
    points: '节目要点',
    pointsPlaceholder: '一行一条：这期节目的话题主线、嘉宾观点、亮点',
    note: '备注',
    notePlaceholder: '主播聊这个话题时要注意的口径'
  },
  custom: {
    points: '要点',
    pointsPlaceholder: '一行一条要点，主播检索素材时参考',
    note: '备注',
    notePlaceholder: '补充说明'
  }
}

/** 条目新建/编辑弹窗：先选类型，字段随类型变（商品才有价格；书籍作者存 meta.author） */
function EntryDialog({
  open,
  product,
  assets,
  onOpenChange,
  onSaved
}: {
  open: boolean
  product?: Material
  /** 这条素材已挂的附件（文件/链接） */
  assets: MaterialFile[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState<EntryKind>(product?.kind ?? 'product')
  const [form, setForm] = useState({
    name: product?.name ?? '',
    price: product?.price ?? 0,
    author: product?.meta.author ?? '',
    sellingPoints: product?.sellingPoints ?? '',
    faq: product?.faq ?? '',
    content: product?.content ?? ''
  })
  const [busy, setBusy] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [assetsLocal, setAssetsLocal] = useState<MaterialFile[]>(assets)
  useEffect(() => setAssetsLocal(assets), [assets])

  const addLink = async () => {
    if (!product || !linkUrl.trim()) return
    const result = await window.api.knowledge.attachUrl(product.id, linkUrl.trim())
    if (!result.ok) {
      toast.error('挂链接失败', { description: result.error })
      return
    }
    setLinkUrl('')
    setAssetsLocal((prev) => [result.file, ...prev])
    toast.success('链接已挂到这条素材')
  }

  const addFile = async () => {
    if (!product) return
    const path = await window.api.dialog.pickFile('资料文件', ['pdf', 'doc', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp'])
    if (!path) return
    const result = await window.api.knowledge.uploadFile(path, undefined, product.id)
    if (!result.ok) {
      toast.error('上传失败', { description: result.error })
      return
    }
    setAssetsLocal((prev) => [result.file, ...prev])
    toast.success('已作为附件挂到这条素材')
  }

  const removeAsset = async (id: string) => {
    const result = await window.api.knowledge.deleteFile(id)
    if (result.ok) setAssetsLocal((prev) => prev.filter((item) => item.id !== id))
  }

  const fieldLabel = ENTRY_FIELD_LABEL[kind]

  const submit = () => {
    if (!form.name.trim() || busy) return
    const meta: Record<string, string> = { ...product?.meta }
    if (kind === 'book') {
      if (form.author.trim()) meta.author = form.author.trim()
      else delete meta.author
    }
    const input: MaterialInput = {
      name: form.name,
      price: kind === 'product' ? form.price : 0,
      sellingPoints: form.sellingPoints,
      content: form.content,
      faq: form.faq,
      kind,
      externalId: product?.externalId ?? '',
      meta
    }
    setBusy(true)
    void window.api.knowledge
      .saveMaterial(input, product?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(product ? '条目已更新' : '条目已创建')
          onOpenChange(false)
          await onSaved()
        } else {
          toast.error('保存失败', { description: result.error })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{product ? '编辑条目' : '新建条目'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label className="mb-1">类型</Label>
            <div className="flex flex-wrap gap-2">
              {ENTRY_KINDS.map((entryKind) => (
                <button
                  key={entryKind}
                  type="button"
                  className={chipClass(kind === entryKind)}
                  onClick={() => setKind(entryKind)}
                >
                  {ENTRY_KIND_LABEL[entryKind]}
                </button>
              ))}
            </div>
          </div>
          <div className={kind === 'product' || kind === 'book' ? 'grid grid-cols-2 gap-3' : ''}>
            <div>
              <Label className="mb-1">名称</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={
                  kind === 'product'
                    ? '例如：麦饭石不粘锅'
                    : kind === 'book'
                      ? '例如：活着（余华）'
                      : kind === 'topic'
                        ? '例如：聊聊县城咖啡馆'
                        : '条目名称'
                }
              />
            </div>
            {kind === 'product' && (
              <div>
                <Label className="mb-1">价格（元）</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={String(form.price)}
                  onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })}
                />
              </div>
            )}
            {kind === 'book' && (
              <div>
                <Label className="mb-1">作者</Label>
                <Input
                  value={form.author}
                  onChange={(e) => setForm({ ...form, author: e.target.value })}
                  placeholder="例如：余华"
                />
              </div>
            )}
          </div>
          <div>
            <Label className="mb-1">正文</Label>
            <Textarea
              value={form.content}
              rows={3}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="文章/讲稿/说明书正文都可以直接放这里；也可以只挂附件或链接"
              className="resize-none"
            />
          </div>
          <div>
            <Label className="mb-1">附件（{assetsLocal.length}）</Label>
            {product ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="贴链接：官网 / 文档 / 商品页"
                  />
                  <Button variant="outline" size="sm" onClick={() => void addLink()}>
                    挂链接
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void addFile()}>
                    上传文件
                  </Button>
                </div>
                {assetsLocal.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    还没有附件。节目只绑这一条素材，agent 需要时才读这里的附件。
                  </p>
                ) : (
                  <div className="space-y-1">
                    {assetsLocal.map((asset) => (
                      <div key={asset.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
                        <span className="shrink-0 text-muted-foreground">{asset.type === 'url' ? '链接' : '文件'}</span>
                        <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                        <Button variant="ghost" size="icon-sm" title="解绑" onClick={() => void removeAsset(asset.id)}>
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">先保存这条素材，再给它挂附件</p>
            )}
          </div>
          <div>
            <Label className="mb-1">{fieldLabel.points}</Label>
            <Textarea
              value={form.sellingPoints}
              onChange={(e) => setForm({ ...form, sellingPoints: e.target.value })}
              placeholder={fieldLabel.pointsPlaceholder}
              className="min-h-24 resize-none"
            />
          </div>
          <div>
            <Label className="mb-1">{fieldLabel.note}</Label>
            <Textarea
              value={form.faq}
              onChange={(e) => setForm({ ...form, faq: e.target.value })}
              placeholder={fieldLabel.notePlaceholder}
              className="min-h-24 resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!form.name.trim() || busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 图片资料入库前收一句描述（第一版不做 vision，描述参与检索） */
function ImageDescribeDialog({
  filePath,
  onOpenChange,
  onConfirm
}: {
  filePath: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (description: string) => Promise<void>
}) {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  // description 是用户没提交的草稿：换图片时靠父层 key 重挂载把状态初始化成空，
  // 就不用 effect 抄 prop，父层因别的原因重渲染也不会冲掉用户已经输入的内容。
  return (
    <Dialog open={filePath !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>描述这张图片</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground break-all">{filePath?.split(/[\\/]/).pop()}</p>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明图里是什么，例如：麦饭石不粘锅的质检报告，涂层检测合格"
          className="min-h-20 resize-none"
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!description.trim() || busy}
            onClick={() => {
              setBusy(true)
              void onConfirm(description.trim()).finally(() => setBusy(false))
            }}
          >
            入库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
