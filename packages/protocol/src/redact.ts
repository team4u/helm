/**
 * JSON value redaction traversal (the single implementation shared by kernel and plugins).
 *
 * JSON string values are processed before serialization, avoiding misses caused by quote and
 * newline escaping. Strict mode: rejects circular references, sparse arrays, non-plain objects
 * and undefined values — any input that cannot be redacted faithfully throws explicitly,
 * never silently passing through (honesty discipline).
 */
import { HelmxError } from './error.js'

/** Any value -> model-visible text (strings pass through redaction as-is; objects are JSON-serialized with per-value redaction; undefined becomes empty string). */
export function safeResultText(value: unknown, redact: (text: string) => string = (text) => text): string {
  if (typeof value === 'string') return redact(value)
  if (value === undefined) return ''
  return JSON.stringify(redactJsonValue(value, redact))
}

export function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  const visiting = new WeakSet<object>()
  function visit(current: unknown): unknown {
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return redact(current)
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (typeof current !== 'object' || visiting.has(current)) {
      throw new HelmxError('invalid_json_value', 'Output must be JSON data free of cycles and undefined values', 500)
    }
    visiting.add(current)
    try {
      if (Array.isArray(current)) {
        const result: unknown[] = []
        for (let i = 0; i < current.length; i++) {
          if (!Object.hasOwn(current, i)) throw new HelmxError('invalid_json_value', 'Output must not contain sparse arrays', 500)
          result.push(visit(current[i]))
        }
        return result
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new HelmxError('invalid_json_value', 'Output must not contain non-JSON objects', 500)
      }
      const entries = Object.entries(current).map(([key, item]) => [redact(key), visit(item)] as const)
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw new HelmxError('redacted_key_conflict', 'Redacted output fields collide', 500)
      }
      return Object.fromEntries(entries)
    } finally {
      visiting.delete(current)
    }
  }
  return visit(value)
}
