import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, BookOpen, Clapperboard, FileImage, FileText, Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react'
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
import type { KnowledgeFile, KnowledgeKind, Product, ProductInput, Script, ScriptInput, ScriptScene } from '../../../shared/types'

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
  const [scripts, setScripts] = useState<Script[]>([])
  const [editing, setEditing] = useState<{ product?: Product } | null>(null)
  const [editingScript, setEditingScript] = useState<{ script?: Script } | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [deletingScript, setDeletingScript] = useState<Script | null>(null)
  const [uploading, setUploading] = useState(false)
  const [imageDraft, setImageDraft] = useState<string | null>(null) // 待填描述的图片路径

  const reload = useCallback(async () => {
    const [p, f, s] = await Promise.all([
      window.api.knowledge.listProducts(),
      window.api.knowledge.listFiles(),
      window.api.script.list()
    ])
    setProducts(p)
    setFiles(f)
    setScripts(s)
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

        <div className="mt-6 mb-2 flex items-center gap-2">
          <p className="text-xs text-muted-foreground">剧本 · {scripts.length}</p>
          <Button variant="outline" size="sm" className="ml-auto h-6 text-xs" onClick={() => setEditingScript({})}>
            <Plus className="size-3.5" />
            新建剧本
          </Button>
        </div>
        {scripts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <Clapperboard className="size-8" strokeWidth={1.25} />
            <p className="text-sm">剧本 = 场景序列（开场→痛点→讲解→互动→催单→收尾），场次页绑定后主播按场推进</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {scripts.map((script) => (
              <Card key={script.id} className="group/card gap-2 py-3">
                <CardHeader className="px-4">
                  <CardTitle className="min-w-0 truncate text-sm">{script.title}</CardTitle>
                </CardHeader>
                <CardContent className="px-4">
                  <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{script.theme || '（没写主题）'}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {script.scenes.map((scene, i) => (
                      <Badge key={scene.id} variant="outline" className="text-[11px]">
                        {i + 1}.{scene.title}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end gap-1 opacity-0 group-hover/card:opacity-100">
                    <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditingScript({ script })}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="删除" onClick={() => setDeletingScript(script)}>
                      <Trash2 />
                    </Button>
                  </div>
                </CardContent>
              </Card>
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
      <ScriptDialog
        key={editingScript?.script?.id ?? 'new'}
        open={editingScript !== null}
        script={editingScript?.script}
        onOpenChange={(open) => !open && setEditingScript(null)}
        onSaved={reload}
      />
      <Dialog open={deletingScript !== null} onOpenChange={(open) => !open && setDeletingScript(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除剧本</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确认删除「{deletingScript?.title}」？绑定了它的场次会自动解绑。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingScript(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deletingScript
                setDeletingScript(null)
                if (!target) return
                void window.api.script.remove(target.id).then(async (result) => {
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

/** 剧本编辑弹窗：剧本名/主题 + 场景序列（上下按钮排序，可增删） */
function ScriptDialog({
  open,
  script,
  onOpenChange,
  onSaved
}: {
  open: boolean
  script?: Script
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [title, setTitle] = useState(script?.title ?? '')
  const [theme, setTheme] = useState(script?.theme ?? '')
  const [scenes, setScenes] = useState<ScriptScene[]>(
    script?.scenes ?? [{ id: '', title: '开场', goal: '', keyPoints: '', estDurationMin: 5 }]
  )
  const [busy, setBusy] = useState(false)

  const patchScene = (index: number, part: Partial<ScriptScene>) =>
    setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, ...part } : s)))
  const moveScene = (index: number, dir: -1 | 1) =>
    setScenes((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const submit = () => {
    if (!title.trim() || busy) return
    const input: ScriptInput = {
      title,
      theme,
      scenes: scenes.filter((s) => s.title.trim())
    }
    setBusy(true)
    void window.api.script
      .save(input, script?.id)
      .then(async (result) => {
        if (result.ok) {
          toast.success(script ? '剧本已更新' : '剧本已创建')
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{script ? '编辑剧本' : '新建剧本'}</DialogTitle>
        </DialogHeader>
        <div className="grid shrink-0 grid-cols-2 gap-3">
          <div>
            <Label className="mb-1">剧本名</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：锅具专场标准流程" />
          </div>
          <div>
            <Label className="mb-1">主题</Label>
            <Input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="这场直播的内容方向" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-1 flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">场景序列（{scenes.length} 场）</Label>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() =>
                setScenes((prev) => [...prev, { id: '', title: '', goal: '', keyPoints: '', estDurationMin: 5 }])
              }
            >
              <Plus className="size-3.5" />
              加一场
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {scenes.map((scene, i) => (
              <div key={i} className="rounded-lg border bg-card p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
                  <Input
                    value={scene.title}
                    onChange={(e) => patchScene(i, { title: e.target.value })}
                    placeholder="场景名（开场/痛点/讲解/互动/催单/收尾…）"
                    className="h-7 text-xs"
                  />
                  <Input
                    type="number"
                    min={1}
                    value={String(scene.estDurationMin)}
                    onChange={(e) => patchScene(i, { estDurationMin: Number(e.target.value) || 5 })}
                    title="预计分钟"
                    className="h-7 w-16 shrink-0 text-xs"
                  />
                  <Button variant="ghost" size="icon-sm" title="上移" disabled={i === 0} onClick={() => moveScene(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="下移"
                    disabled={i === scenes.length - 1}
                    onClick={() => moveScene(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="删除这场"
                    disabled={scenes.length === 1}
                    onClick={() => setScenes((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Input
                  value={scene.goal}
                  onChange={(e) => patchScene(i, { goal: e.target.value })}
                  placeholder="目标：这场要达成什么"
                  className="mt-1.5 h-7 text-xs"
                />
                <Textarea
                  value={scene.keyPoints}
                  onChange={(e) => patchScene(i, { keyPoints: e.target.value })}
                  placeholder="必讲要点，一行一条"
                  className="mt-1.5 min-h-12 resize-none text-xs"
                />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!title.trim() || scenes.every((s) => !s.title.trim()) || busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
