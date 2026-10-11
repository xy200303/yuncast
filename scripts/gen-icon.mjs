/**
 * 生成应用图标：resources/icon.png（256x256）。
 * 纯 Node 手写 PNG（无依赖）：深色圆角底 + 品牌色（暖赭陶 #C4703F）锚形。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const out = join(dirname(fileURLToPath(import.meta.url)), '../resources/icon.png')

// 品牌色与底色
const BRAND = [0xc4, 0x70, 0x3f]
const BG = [0x14, 0x13, 0x11]

const px = new Uint8Array(SIZE * SIZE * 4)

function setPixel(x, y, rgb, alpha = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  // 简单 alpha 叠加
  const a = alpha / 255
  px[i] = Math.round(rgb[0] * a + px[i] * (1 - a))
  px[i + 1] = Math.round(rgb[1] * a + px[i + 1] * (1 - a))
  px[i + 2] = Math.round(rgb[2] * a + px[i + 2] * (1 - a))
  px[i + 3] = 255
}

// 圆角矩形底
const R = 52
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.max(R - x, 0, x - (SIZE - 1 - R))
    const dy = Math.max(R - y, 0, y - (SIZE - 1 - R))
    if (dx * dx + dy * dy <= R * R) setPixel(x, y, BG)
  }
}

// 锚形（粗线绘制，抗锯齿省略）
function disc(cx, cy, r, rgb) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPixel(x, y, rgb)
}
function thickLine(x0, y0, x1, y1, w, rgb) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, rgb)
  }
}

const cx = 128
// 顶部圆环
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    const d = Math.sqrt((x - cx) ** 2 + (y - 62) ** 2)
    if (d >= 18 && d <= 30) setPixel(x, y, BRAND)
  }
// 竖杆
thickLine(cx, 92, cx, 196, 14, BRAND)
// 横杆
thickLine(cx - 44, 118, cx + 44, 118, 12, BRAND)
// 两个锚爪（弧线）
for (const dir of [-1, 1]) {
  for (let a = 0; a <= 1; a += 0.002) {
    const angle = Math.PI * (dir < 0 ? 1 - a * 0.55 : a * 0.55) // 从左下/右下往内卷
    const ax = cx + dir * 56 * Math.cos(angle * 0.9)
    const ay = 150 + 46 * Math.sin(angle)
    disc(ax, ay, 7, BRAND)
  }
}

// PNG 编码
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = -1
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('icon written:', out, png.length, 'bytes')
