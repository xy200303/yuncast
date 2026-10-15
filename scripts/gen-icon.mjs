/**
 * 生成应用图标：把 src/renderer/assets/logo.svg 栅格化成 resources/icon.png（1024x1024）。
 * 图形只有一份源文件（logo.svg，界面侧边栏用的也是它），改图标只动那个文件再跑本脚本。
 * 栅格化用 @napi-rs/canvas（pdf-parse 带进来的依赖，已装好，无需新增依赖）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createCanvas, loadImage } = require('@napi-rs/canvas')

const SIZE = 1024
const here = dirname(fileURLToPath(import.meta.url))
const svgPath = join(here, '../src/renderer/assets/logo.svg')
const out = join(here, '../resources/icon.png')

// SVG 源是 48x48 视窗的矢量图：注入目标宽高，让光栅化直接按 1024 出图而不是放大位图
const svg = readFileSync(svgPath, 'utf-8').replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)

const img = await loadImage(Buffer.from(svg))
const canvas = createCanvas(SIZE, SIZE)
canvas.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE)

mkdirSync(dirname(out), { recursive: true })
const png = canvas.toBuffer('image/png')
writeFileSync(out, png)
console.log('icon written:', out, png.length, 'bytes')
