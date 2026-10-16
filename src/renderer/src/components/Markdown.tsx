import { Suspense, lazy } from 'react'
import remarkBreaks from 'remark-breaks'
import { cn } from '@/lib/utils'
import { MiniMarkdown } from './MiniMarkdown'

/**
 * 富文本渲染（表格/任务列表/代码高亮/公式/图示）：用 **streamdown**（专为 AI 流式输出设计，
 * 自带未闭合标记补全，避免流式到一半的 `**加粗` 闪成乱码）。
 *
 * 三件事注意：
 * - **懒加载**：streamdown 核心 gzip ≈150KB，只在真的渲染回复时才加载；加载期间用自研 MiniMarkdown 兜底，
 *   首屏与不说话的界面不受影响。
 * - **样式来源**：它的类名是 Tailwind 工具类，靠 index.css 里的 `@source` 让 Tailwind 扫到；
 *   另需在入口 import 'streamdown/styles.css'（进场动画关键帧）。
 * - **中文**：UI 文案走 translations；CJK 换行/标点由 @streamdown/cjk 插件处理。
 */
/**
 * 懒加载包装：**必须把它自己的默认 remark 插件（gfm/codeMeta）带上**——直接传 remarkPlugins 会把默认项顶掉，
 * 表格/任务列表立刻解析不出来（踩过：原始内容是合法 GFM 表格却渲染成一行竖线）。
 */
const Streamdown = lazy(async () => {
  const mod = await import('streamdown')
  const remarkPlugins = [...Object.values(mod.defaultRemarkPlugins), remarkBreaks]
  /** 透传 streamdown 的 props（包装层不重复声明它的完整 props 类型） */
  const Wrapped = (props: Record<string, unknown>): React.ReactElement => (
    <mod.Streamdown {...(props as Record<string, never>)} remarkPlugins={remarkPlugins} />
  )
  return { default: Wrapped }
})

const TRANSLATIONS = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadFile: '下载文件',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载 CSV',
  downloadTableAsMarkdown: '下载 Markdown',
  downloadDiagram: '下载图示',
  downloadDiagramAsMmd: '下载 .mmd',
  downloadDiagramAsPng: '下载 PNG',
  downloadDiagramAsSvg: '下载 SVG',
  exitFullscreen: '退出全屏',
  externalLinkWarning: '要打开外部链接吗？',
  imageNotAvailable: '图片加载失败',
  mermaidFormatMmd: 'Mermaid 源码',
  mermaidFormatPng: 'PNG',
  mermaidFormatSvg: 'SVG',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  resetView: '重置视图',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: '全屏查看',
  zoomIn: '放大',
  zoomOut: '缩小'
}

/**
 * 富文本的排版外衣：标题/列表/表格/代码的间距与字号统一交给 prose（主题色由 index.css 里的
 * `.prose { --tw-prose-* }` 接到本应用的 token 上），正文仍是 13px/行高 24px，跟其它正文一致。
 */
const PROSE_CLASS = cn(
  'prose prose-sm max-w-none dark:prose-invert',
  'text-[13px] leading-6',
  'prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:font-semibold',
  'prose-h1:text-[15px] prose-h2:text-[14px] prose-h3:text-[13.5px] prose-h4:text-[13px]',
  'prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:marker:text-muted-foreground',
  'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:my-2 prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted/60 prose-pre:text-[12px]',
  'prose-blockquote:my-2 prose-blockquote:border-l-2 prose-blockquote:font-normal prose-blockquote:not-italic',
  'prose-table:my-2 prose-table:text-[12.5px] prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1'
)

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<MiniMarkdown text={text} className={className} />}>
      <div className={cn(PROSE_CLASS, className)}>
      <Streamdown
        // 流式到一半的标记就地补全，不闪乱码
        parseIncompleteMarkdown
        // 新块入场淡入（它的 sd-fadeIn 关键帧）
        animated
        // 表格给「复制」、代码块给「复制」——都是桌面端真用得上的（表格能直接粘进 Excel）；
        // 下载/全屏这类对我们没用，关掉少几个按钮
        controls={{ table: { copy: true, download: false, fullscreen: false }, code: { copy: true, download: false } }}
        // 外链直接交给系统浏览器打开（Electron 侧已接管），不要它自己弹确认框
        linkSafety={{ enabled: false }}
        translations={TRANSLATIONS}
      >
        {text}
      </Streamdown>
      </div>
    </Suspense>
  )
}
