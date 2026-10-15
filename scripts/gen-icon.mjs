/**
 * 生成应用图标：resources/icon.png（1024x1024）。
 * 图形与渲染层 src/renderer/src/assets/logo.svg 一致：天蓝→靛→紫渐变圆角底 + 白云 + 靛蓝声波柱。
 * 出图用 @napi-rs/canvas（pdf-parse 带进来的依赖，已装好，无需新增依赖）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')

const SIZE = 1024
const S = SIZE / 48 // 图形按 48x48 网格设计，放大到 1024
const out = join(dirname(fileURLToPath(import.meta.url)), '../resources/icon.png')

const canvas = createCanvas(SIZE, SIZE)
const ctx = canvas.getContext('2d')

/** 单位都是 48 网格坐标 */
function roundRect48(x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo((x + r) * S, y * S)
  ctx.arcTo((x + w) * S, y * S, (x + w) * S, (y + h) * S, r * S)
  ctx.arcTo((x + w) * S, (y + h) * S, x * S, (y + h) * S, r * S)
  ctx.arcTo(x * S, (y + h) * S, x * S, y * S, r * S)
  ctx.arcTo(x * S, y * S, (x + w) * S, y * S, r * S)
  ctx.closePath()
}
function circle48(cx, cy, r) {
  ctx.beginPath()
  ctx.arc(cx * S, cy * S, r * S, 0, Math.PI * 2)
  ctx.fill()
}

// 底：圆角方块 + 对角渐变
roundRect48(0, 0, 48, 48, 10.8)
const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE)
gradient.addColorStop(0, '#38BDF8')
gradient.addColorStop(0.55, '#818CF8')
gradient.addColorStop(1, '#C084FC')
ctx.fillStyle = gradient
ctx.fill()

// 云朵（三个圆鼓包 + 平底）
ctx.fillStyle = '#FFFFFF'
circle48(17, 23.5, 6)
circle48(24, 19.5, 8)
circle48(31, 23.5, 6)
roundRect48(10, 24, 28, 9.5, 4.75)
ctx.fill()

// 声波柱（五根圆头柱，关于中线对称）
ctx.fillStyle = '#4F46E5'
const bars = [
  [13.5, 5.5],
  [18.1, 9],
  [22.7, 12.5],
  [27.3, 9],
  [31.9, 5.5]
]
for (const [x, h] of bars) {
  roundRect48(x, 27 - h / 2, 2.6, h, 1.3)
  ctx.fill()
}

mkdirSync(dirname(out), { recursive: true })
const png = canvas.toBuffer('image/png')
writeFileSync(out, png)
console.log('icon written:', out, png.length, 'bytes')
