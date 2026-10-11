import { useCallback, useEffect, useState } from 'react'
import { BookOpen, FileImage, FileText, Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import type { KnowledgeFile, KnowledgeKind, Product, ProductInput } from '../../../shared/types'

const KIND_LABEL: Record<KnowledgeKind, string> = {
  text: '文本',
  doc: '文档',
  pdf: 'PDF',
  image: '图片'
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 知识库：商品（价格护栏数据源）+ 资料文件（解析入库参与检索） */
export function KnowledgePage() {
  const [products, setProducts] = useState<Product[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [editing, setEditing] = useState<{ product?: Product } | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [uploading, setUploading] = useState(false)
  const [imageDraft, setImageDraft] = useState<string | null>(null) // 待填描述的图片路径

  const reload = useCallback(async () => {
    const [p, f] = await Promise.all([window.api.knowledge.listProducts(), window.api.knowledge.listFiles()])
    setProducts(p)
    setFiles(f)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <BookOpen className="size-4 text-primary" />
        <h1 className="text-sm font-medium">知识库</h1>
        <p className="text-xs text-muted-foreground">商品资料 · 文件资料包（主播答题的弹药库）</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing({})}>
            <Plus />
            新建商品
          </Button>
          <Button size="sm" disabled={uploading} onClick={() => void upload()}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? '解析中…' : '上传资料'}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-2 text-xs text-muted-foreground">商品 · {products.length}</p>
        {products.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <BookOpen className="size-8" strokeWidth={1.25} />
            <p className="text-sm">还没有商品。主播报价只认这里的价格，先建一个</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {products.map((product) => (
              <Card key={product.id} className="group/card gap-2 py-3">
                <CardHeader className="px-4">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="min-w-0 truncate text-sm">{product.name}</CardTitle>
                    <span className="shrink-0 text-sm font-semibold text-primary">¥{product.price}</span>
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <p className="line-clamp-3 min-h-9 text-xs text-muted-foreground">
                    {product.sellingPoints || '（还没写卖点）'}
                  </p>
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

        <p className="mt-6 mb-2 text-xs text-muted-foreground">资料文件 · {files.length}</p>
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
                  onClick={() => {
                    void window.api.knowledge.deleteFile(file.id).then(async (result) => {
                      if (result.ok) {
                        toast.success('已删除')
                        await reload()
                      } else toast.error('删除失败', { description: result.error })
                    })
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ProductDialog
        key={editing?.product?.id ?? 'new'}
        open={editing !== null}
        product={editing?.product}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={reload}
      />
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除商品</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deleting?.name}」？主播将查不到它的价格。
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
                void window.api.knowledge.deleteProduct(target.id).then(async (result) => {
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
      <ImageDescribeDialog
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

/** 商品新建/编辑弹窗 */
function ProductDialog({
  open,
  product,
  onOpenChange,
  onSaved
}: {
  open: boolean
  product?: Product
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<ProductInput>({
    name: product?.name ?? '',
    price: product?.price ?? 0,
    sellingPoints: product?.sellingPoints ?? '',
    faq: product?.faq ?? ''
  })
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (!form.name.trim() || busy) return
    setBusy(true)
    void window.api.knowledge
      .saveProduct(form, product?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(product ? '商品已更新' : '商品已创建')
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
          <DialogTitle>{product ? '编辑商品' : '新建商品'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1">名称</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：麦饭石不粘锅"
              />
            </div>
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
          </div>
          <div>
            <Label className="mb-1">卖点</Label>
            <Textarea
              value={form.sellingPoints}
              onChange={(e) => setForm({ ...form, sellingPoints: e.target.value })}
              placeholder="一行一个卖点，主播讲产品时参考"
              className="min-h-24 resize-none"
            />
          </div>
          <div>
            <Label className="mb-1">FAQ（常见问题和答案）</Label>
            <Textarea
              value={form.faq}
              onChange={(e) => setForm({ ...form, faq: e.target.value })}
              placeholder="问：……&#10;答：……"
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

  useEffect(() => {
    if (filePath) setDescription('')
  }, [filePath])

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
