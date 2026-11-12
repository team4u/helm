/**
 * safeResultText：任意值 -> 模型可见文本的序列化契约（字符串原样过脱敏、
 * 对象 JSON 序列化并逐值脱敏、undefined 为空串、不可序列化值显式抛错）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeResultText } from '@helm/protocol'

describe('safeResultText', () => {
  it('字符串原样过脱敏，undefined 为空串', { timeout: 60_000 }, () => {
    assert.equal(safeResultText('hello'), 'hello')
    assert.equal(safeResultText('secret-token', (t) => t.replaceAll('secret', '***')), '***-token')
    assert.equal(safeResultText(undefined), '')
  })

  it('对象 JSON 序列化并逐值（含键）脱敏', { timeout: 60_000 }, () => {
    const redact = (t: string): string => t.replaceAll('sk-123', '[REDACTED]')
    assert.equal(
      safeResultText({ token: 'sk-123', nested: { list: ['ok', 'sk-123'] } }, redact),
      '{"token":"[REDACTED]","nested":{"list":["ok","[REDACTED]"]}}',
    )
    assert.equal(safeResultText({ a: 1, b: null, c: true }), '{"a":1,"b":null,"c":true}')
  })

  it('不可序列化值（循环引用 / 非纯对象）显式抛错，绝不静默降级', { timeout: 60_000 }, () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    assert.throws(() => safeResultText(cyclic), /invalid_json_value|输出必须/)
    assert.throws(() => safeResultText({ fn: () => {} }), /invalid_json_value|输出必须/)
  })
})
