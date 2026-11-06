/** 输出渲染：--json 保真 JSON；人类模式为对齐表格 / key-value / 原样文本。 */
import type { Io } from './options.js'

const CELL_LIMIT = 64

function toCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function truncate(text: string): string {
  return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT - 1)}…` : text
}

function printTable(io: Io, rows: Record<string, unknown>[]): void {
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  if (keys.length === 0) {
    io.out('(empty)\n')
    return
  }
  const cells = rows.map((row) => keys.map((key) => truncate(toCell(row[key]))))
  const widths = keys.map((key, i) => Math.min(80, Math.max(key.length, ...cells.map((r) => r[i]!.length))))
  io.out(keys.map((key, i) => key.padEnd(widths[i]!)).join('  ') + '\n')
  io.out(widths.map((width) => '-'.repeat(width)).join('  ') + '\n')
  for (const row of cells) {
    io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ') + '\n')
  }
}

/** 统一结果输出：API 直返实体/数组。 */
export function printValue(io: Io, value: unknown, json: boolean): void {
  if (json) {
    io.out(`${JSON.stringify(value === undefined ? null : value, null, 2)}\n`)
    return
  }
  if (value === undefined || value === null) {
    io.out('ok\n')
    return
  }
  if (typeof value === 'string') {
    io.out(value.endsWith('\n') ? value : `${value}\n`)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    io.out(`${value}\n`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      io.out('(empty)\n')
      return
    }
    if (value.every((item) => item !== null && typeof item === 'object')) {
      printTable(io, value as Record<string, unknown>[])
      return
    }
    for (const item of value) io.out(`${toCell(item)}\n`)
    return
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    io.out('(empty)\n')
    return
  }
  const width = Math.max(...entries.map(([key]) => key.length))
  for (const [key, val] of entries) io.out(`${key.padEnd(width)}  ${toCell(val)}\n`)
}

/** 原样文本输出（skills read / artifacts 文本内容），保证尾部换行。 */
export function printText(io: Io, text: string): void {
  io.out(text.endsWith('\n') ? text : `${text}\n`)
}
