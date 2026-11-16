#!/usr/bin/env node
/**
 * 基于 public/favicon.svg 的几何与配色生成 PWA 与通知图标 PNG 资产。
 *
 * 仅使用 Node 内置模块（node:zlib / node:fs / node:path），以 4x4 超采样
 * 抗锯齿渲染并输出标准 RGBA PNG：
 * - icon-192.png (192x192, any, 透明圆角外边距)
 * - icon-512.png (512x512, any, 透明圆角外边距)
 * - icon-maskable-512.png (512x512, maskable, #ededf2 实体底色 + 75% 安全区缩放)
 * - apple-touch-icon.png (180x180, #ededf2 实体底色)
 * - notification-badge-96.png (96x96, 透明底 + #ffffff 纯白单色字标与圆点)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

const BG_COLOR = [0xed, 0xed, 0xf2] // #ededf2
const MARK_COLOR = [0x1c, 0x1c, 0x21] // #1c1c21
const CORE_COLOR = [0x4f, 0x46, 0xe5] // #4f46e5
const WHITE_COLOR = [0xff, 0xff, 0xff] // #ffffff

const STROKE_RADIUS = 1.3 // stroke-width = 2.6
const STROKE_RADIUS_SQ = STROKE_RADIUS * STROKE_RADIUS
const CORE_RADIUS_SQ = 2.2 * 2.2

const MARK_SEGMENTS = [
  [10.5, 9.5, 10.5, 22.5],
  [21.5, 9.5, 21.5, 22.5],
  [10.5, 16, 12.5, 16],
  [19.5, 16, 21.5, 16],
]

const SUPERSAMPLE = 4
const SUBPIXEL_COUNT = SUPERSAMPLE * SUPERSAMPLE

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const lenBytes = Buffer.allocUnsafe(4)
  lenBytes.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcBytes = Buffer.allocUnsafe(4)
  crcBytes.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBytes, typeBytes, data, crcBytes])
}

function encodeRgbaPng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride)
  }

  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function isInsideRoundedRect(x, y) {
  // rect x=2 y=2 width=28 height=28 rx=7，中心 (16, 16)，内核心半边长 = 14 - 7 = 7
  const dx = Math.max(Math.abs(x - 16) - 7, 0)
  const dy = Math.max(Math.abs(y - 16) - 7, 0)
  return dx * dx + dy * dy <= 49
}

function distSqToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const lenSq = vx * vx + vy * vy
  if (lenSq === 0) {
    const dx = px - x1
    const dy = py - y1
    return dx * dx + dy * dy
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / lenSq))
  const dx = px - (x1 + t * vx)
  const dy = py - (y1 + t * vy)
  return dx * dx + dy * dy
}

function isInsideMark(x, y) {
  for (let i = 0; i < MARK_SEGMENTS.length; i += 1) {
    const [x1, y1, x2, y2] = MARK_SEGMENTS[i]
    if (distSqToSegment(x, y, x1, y1, x2, y2) <= STROKE_RADIUS_SQ) return true
  }
  return false
}

function isInsideCore(x, y) {
  const dx = x - 16
  const dy = y - 16
  return dx * dx + dy * dy <= CORE_RADIUS_SQ
}

function renderIcon({ size, background, markScale, markColor, coreColor }) {
  const rgba = Buffer.allocUnsafe(size * size * 4)
  const invSize = 32 / size
  const invScale = 1 / markScale

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const vy = (py + (sy + 0.5) / SUPERSAMPLE) * invSize
        const my = 16 + (vy - 16) * invScale
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const vx = (px + (sx + 0.5) / SUPERSAMPLE) * invSize
          const mx = 16 + (vx - 16) * invScale

          let sampleColor = null
          if (isInsideCore(mx, my)) {
            sampleColor = coreColor
          } else if (isInsideMark(mx, my)) {
            sampleColor = markColor
          } else if (background === 'solid' || (background === 'rounded' && isInsideRoundedRect(vx, vy))) {
            sampleColor = BG_COLOR
          }

          if (sampleColor !== null) {
            sumR += sampleColor[0]
            sumG += sampleColor[1]
            sumB += sampleColor[2]
            sumA += 1
          }
        }
      }

      const idx = (py * size + px) * 4
      if (sumA === 0) {
        rgba[idx] = 0
        rgba[idx + 1] = 0
        rgba[idx + 2] = 0
        rgba[idx + 3] = 0
      } else {
        rgba[idx] = Math.round(sumR / sumA)
        rgba[idx + 1] = Math.round(sumG / sumA)
        rgba[idx + 2] = Math.round(sumB / sumA)
        rgba[idx + 3] = Math.round((sumA / SUBPIXEL_COUNT) * 255)
      }
    }
  }

  return encodeRgbaPng(size, size, rgba)
}

const TARGETS = [
  {
    filename: 'icon-192.png',
    size: 192,
    background: 'rounded',
    markScale: 1,
    markColor: MARK_COLOR,
    coreColor: CORE_COLOR,
  },
  {
    filename: 'icon-512.png',
    size: 512,
    background: 'rounded',
    markScale: 1,
    markColor: MARK_COLOR,
    coreColor: CORE_COLOR,
  },
  {
    filename: 'icon-maskable-512.png',
    size: 512,
    background: 'solid',
    markScale: 0.75,
    markColor: MARK_COLOR,
    coreColor: CORE_COLOR,
  },
  {
    filename: 'apple-touch-icon.png',
    size: 180,
    background: 'solid',
    markScale: 1,
    markColor: MARK_COLOR,
    coreColor: CORE_COLOR,
  },
  {
    filename: 'notification-badge-96.png',
    size: 96,
    background: 'transparent',
    markScale: 1.4,
    markColor: WHITE_COLOR,
    coreColor: WHITE_COLOR,
  },
]

mkdirSync(PUBLIC_DIR, { recursive: true })
for (const target of TARGETS) {
  const png = renderIcon(target)
  const outPath = path.join(PUBLIC_DIR, target.filename)
  writeFileSync(outPath, png)
  console.log(`generated ${target.filename} (${target.size}x${target.size}, ${png.length} bytes)`)
}
