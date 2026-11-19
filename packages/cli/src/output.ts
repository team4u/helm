/** Output rendering: `--json` preserves exact JSON; human mode renders aligned tables, key-value pairs, or raw text. */
import {
  createLocaleTranslator,
  DEFAULT_HELMX_LOCALE,
  parseLocalizedText,
  type LocaleTranslator,
} from '@helmx/protocol'
import type { Io } from './options.js'

const CELL_LIMIT = 64

/**
 * Human-mode display-copy translator: the CLI keeps no locale state of its
 * own, so per the protocol copy model human output resolves `LocalizedText`
 * with the default locale ('en'); `--json` always keeps the raw shape.
 */
const humanDisplayCopy: LocaleTranslator = createLocaleTranslator(DEFAULT_HELMX_LOCALE)

/** Plain JSON-shaped record (Object.prototype or null prototype) safe to rebuild for display. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep display-copy resolution for human rendering only (never the --json
 * path): values shaped exactly as a LocalizedText map (validated by the
 * shared protocol parser — closed locale keys, string entries) collapse to
 * one display string; arrays and plain records recurse so nested display
 * metadata (plugin summaries, app catalog entries, config schema labels)
 * renders resolved instead of raw `{"en":...}` JSON. Non-plain objects
 * (class instances, Dates) pass through untouched.
 */
function resolveDisplayCopy(value: unknown): unknown {
  const parsed = parseLocalizedText(value)
  if (parsed !== undefined && typeof parsed !== 'string') return humanDisplayCopy(parsed)
  if (Array.isArray(value)) return value.map((item) => resolveDisplayCopy(item))
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = resolveDisplayCopy(entry)
    return out
  }
  return value
}

function toCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function truncate(text: string): string {
  return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT - 1)}...` : text
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

/** Unified result output for entities/arrays returned directly by the API. */
export function printValue(io: Io, value: unknown, json: boolean): void {
  if (json) {
    io.out(`${JSON.stringify(value === undefined ? null : value, null, 2)}\n`)
    return
  }
  // human path only: resolve protocol display copy (LocalizedText maps) before
  // rendering; JSON fidelity above is never touched.
  const display = resolveDisplayCopy(value)
  if (display === undefined || display === null) {
    io.out('ok\n')
    return
  }
  if (typeof display === 'string') {
    io.out(display.endsWith('\n') ? display : `${display}\n`)
    return
  }
  if (typeof display === 'number' || typeof display === 'boolean') {
    io.out(`${display}\n`)
    return
  }
  if (Array.isArray(display)) {
    if (display.length === 0) {
      io.out('(empty)\n')
      return
    }
    if (display.every((item) => item !== null && typeof item === 'object')) {
      printTable(io, display as Record<string, unknown>[])
      return
    }
    for (const item of display) io.out(`${toCell(item)}\n`)
    return
  }
  const entries = Object.entries(display as Record<string, unknown>)
  if (entries.length === 0) {
    io.out('(empty)\n')
    return
  }
  const width = Math.max(...entries.map(([key]) => key.length))
  for (const [key, val] of entries) io.out(`${key.padEnd(width)}  ${toCell(val)}\n`)
}

/** Raw text output (for skills read / text artifacts), ensuring a trailing newline. */
export function printText(io: Io, text: string): void {
  io.out(text.endsWith('\n') ? text : `${text}\n`)
}
