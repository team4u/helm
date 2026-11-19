/**
 * safeResultText: the serialization contract from arbitrary values to
 * model-visible text (strings pass through redaction as-is; objects are
 * JSON-serialized with per-value redaction; undefined becomes the empty string;
 * unserializable values throw explicitly).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeResultText } from '@helmx/protocol'

describe('safeResultText', () => {
  it('strings pass through redaction as-is; undefined becomes the empty string', { timeout: 60_000 }, () => {
    assert.equal(safeResultText('hello'), 'hello')
    assert.equal(safeResultText('secret-token', (t) => t.replaceAll('secret', '***')), '***-token')
    assert.equal(safeResultText(undefined), '')
  })

  it('objects are JSON-serialized with per-value (including key) redaction', { timeout: 60_000 }, () => {
    const redact = (t: string): string => t.replaceAll('sk-123', '[REDACTED]')
    assert.equal(
      safeResultText({ token: 'sk-123', nested: { list: ['ok', 'sk-123'] } }, redact),
      '{"token":"[REDACTED]","nested":{"list":["ok","[REDACTED]"]}}',
    )
    assert.equal(safeResultText({ a: 1, b: null, c: true }), '{"a":1,"b":null,"c":true}')
  })

  it('unserializable values (circular references / non-plain objects) throw explicitly, never silently degrade', { timeout: 60_000 }, () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    assert.throws(() => safeResultText(cyclic), /invalid_json_value|Output must/)
    assert.throws(() => safeResultText({ fn: () => {} }), /invalid_json_value|Output must/)
  })
})
