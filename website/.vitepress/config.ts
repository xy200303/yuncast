import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: '小云播客坊 YunCast',
  description: '你的 AI 主播，开场就能播——直播带货、有声书、播客节目，一个工作台全包',
  base: '/',
  head: [['link', { rel: 'icon', href: '/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: '首页', link: '/' },
      { text: '使用文档', link: '/guide/quickstart' },
      { text: '下载', link: '/download' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '使用文档',
          items: [
            { text: '快速上手', link: '/guide/quickstart' },
            { text: '核心概念', link: '/guide/concepts' },
            { text: '界面一览', link: '/guide/interface' }
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
