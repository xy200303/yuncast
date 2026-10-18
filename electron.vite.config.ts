import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // pi SDK 系列是 ESM-only（exports 只给 import 条件），外部化成 CJS require 会炸，
      // 全部打进 bundle；node:sqlite 是 Electron 内置模块，交给运行时解析
      externalizeDeps: {
        // umzug 一起打进 bundle：打包只带 out/ ，不落 node_modules
        exclude: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox', 'umzug']
      },
      rollupOptions: {
        external: ['node:sqlite']
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // 富文本渲染（streamdown）按需加载，但它内部的 mermaid 与 shiki 很大：
          // 单独拆出去，只有真的出现图示/代码块时才下载（不拆的话会跟核心合成一个近 1MB 的包）
          manualChunks(id: string) {
            if (id.includes('mermaid')) return 'mermaid'
            if (id.includes('shiki') || id.includes('@shikijs')) return 'shiki'
            // streamdown 核心（含 unified/remark/rehype 生态与 katex）单独成块：
            // 不拆的话会跟 mermaid 合成一个 ~1MB 的异步包，第一次渲染回复就得整包下载
            if (
              id.includes('streamdown') ||
              id.includes('hast-util') ||
              id.includes('mdast-util') ||
              id.includes('micromark') ||
              id.includes('remark-') ||
              id.includes('rehype-') ||
              id.includes('/unified/') ||
              id.includes('katex') ||
              id.includes('remend')
            ) {
              return 'markdown'
            }
            return undefined
          }
        }
      }
    }
  }
})
