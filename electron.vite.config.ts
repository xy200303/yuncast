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
        exclude: ['@earendil-works/pi-coding-agent', 'typebox']
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
    plugins: [react(), tailwindcss()]
  }
})
