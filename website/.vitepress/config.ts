import { defineConfig } from 'vitepress'

const SITE_URL = 'https://yuncast.xyun.dev'
const SITE_NAME = '小云播客坊 YunCast'
const SITE_DESC =
  '面向不会直播的商家与实体店：桌面工作台把写稿、配音、播出、控场、互动串成一条流水线。声音可克隆成店家的，成品音频能整场导出。开源免费（MIT），Windows / macOS / Linux。'
const OG_IMAGE = `${SITE_URL}/og-image.png`

const softwareJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  alternateName: 'YunCast',
  description: SITE_DESC,
  url: SITE_URL,
  downloadUrl: 'https://github.com/xy200303/yuncast/releases/latest',
  softwareVersion: '0.1.3',
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Windows, macOS, Linux',
  inLanguage: 'zh-CN',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
  license: 'https://opensource.org/licenses/MIT',
  author: { '@type': 'Person', name: '小云', email: '3483421977@qq.com', url: 'https://github.com/xy200303' },
  keywords: 'AI直播,AI主播,无人直播,直播带货,声音克隆,TTS,有声书,播客,评论自动回复,虚拟主播',
  featureList:
    '智能主播 Agent 写稿播报,四种节目形态,三种播出方式,声音克隆,评论自动互动,话术池播出控制,音频导出 MP3/WAV,用量看板'
}

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: 'YunCast',
  url: SITE_URL,
  inLanguage: 'zh-CN',
  description: SITE_DESC
}

export default defineConfig({
  lang: 'zh-CN',
  title: SITE_NAME,
  titleTemplate: ':title | 小云播客坊 YunCast',
  description: SITE_DESC,
  appearance: 'force-light',
  base: '/',
  lastUpdated: true,
  sitemap: { hostname: SITE_URL },
  head: [
    ['link', { rel: 'icon', href: '/logo.svg' }],
    ['link', { rel: 'preload', href: '/fonts/SmileySans-Oblique.ttf.woff2', as: 'font', type: 'font/woff2', crossorigin: '' }],
    // 正文中文用 Noto Sans SC（SIL OFL，自托管、按 unicode-range 切片，浏览器只取用到的那几片）
    ['link', { rel: 'stylesheet', href: '/fonts/noto/noto-sans-sc.css' }],
    ['meta', { name: 'keywords', content: 'AI直播,AI主播,无人直播,直播带货,商品宣讲,声音克隆,TTS语音合成,有声书制作,播客制作,评论自动回复,虚拟主播,直播软件,小云播客坊,YunCast' }],
    ['meta', { name: 'author', content: '小云 (xy200303)' }],
    ['meta', { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' }],
    ['meta', { name: 'theme-color', content: '#4f46e5' }],
    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:title', content: `${SITE_NAME} - 不会直播，也能自己开一场` }],
    ['meta', { property: 'og:description', content: SITE_DESC }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    ['meta', { property: 'og:image', content: OG_IMAGE }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: '小云播客坊 YunCast - AI 直播工作台' }],
    // Twitter
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: `${SITE_NAME} - 不会直播，也能自己开一场` }],
    ['meta', { name: 'twitter:description', content: SITE_DESC }],
    ['meta', { name: 'twitter:image', content: OG_IMAGE }],
    // 结构化数据：软件 + 站点（FAQPage 由首页 Home.vue 注入，与可见 FAQ 一致）
    ['script', { type: 'application/ld+json' }, JSON.stringify(softwareJsonLd)],
    ['script', { type: 'application/ld+json' }, JSON.stringify(websiteJsonLd)]
  ],
  transformHead({ pageData }) {
    const path = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '')
    const canonical = `${SITE_URL}/${path}`
    const head: [string, Record<string, string>][] = [['link', { rel: 'canonical', href: canonical }]]
    if (pageData.frontmatter.description) {
      head.push(['meta', { property: 'og:url', content: canonical }])
    }
    return head
  },
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: '首页', link: '/' },
      { text: '演示', link: '/#demo' },
      { text: '使用文档', link: '/guide/quickstart' },
      { text: '下载', link: '/download' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '上手',
          items: [
            { text: '快速上手', link: '/guide/quickstart' },
            { text: '核心概念', link: '/guide/concepts' },
            { text: '界面一览', link: '/guide/interface' }
          ]
        },
        {
          text: '使用与运维',
          items: [
            { text: '费用与选型', link: '/guide/cost' },
            { text: '运行要求与排错', link: '/guide/troubleshooting' }
          ]
        }
      ]
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/xy200303/yuncast' }],
    outline: { label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2026 小云播客坊 YunCast'
    }
  }
})
