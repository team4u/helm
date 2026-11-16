/**
 * redaction and streaming redaction regression: structure JSON redaction and SecretStash streaming chunked boundary.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactJsonValue } from '../src/redact.js'
import { SecretStash } from '../src/services/secret-stash.js'

test('structure redaction override contains quotes and newline field value and field name, keep already has placeholder', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const secret = ['example"value', 'next line'].join('\n')
  const marker = stash.put(1, 'EXAMPLE', secret)
  const result = redactJsonValue({ [secret]: { list: [secret, marker] } }, (text) => stash.redact(text))
  assert.deepEqual(result, { [marker]: { list: [marker, marker] } })
  assert.equal(JSON.stringify(result).includes('example'), false)
})

test('structure output reject loop, non- JSON data and redaction after field conflict', { timeout: 60_000 }, () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const value of [cyclic, { value: undefined }, [NaN], new Map(), Array(1)]) {
    assert.throws(() => redactJsonValue(value, (text) => text))
  }
  assert.throws(() => redactJsonValue({ first: 1, second: 2 }, () => 'same'), /冲突/)
})

test('stream redaction override secret across chunked, overlap before suffix and old fixed cut point', { timeout: 60_000 }, () => {
  for (const secret of ['ababa', '{{SECRET_mvch3tgr}}', '😀private😀', 'A'.repeat(5_000) + 'Z']) {
    const stash = new SecretStash()
    stash.put(1, 'TOKEN', secret)
    const input = 'padding'.repeat(600) + secret + 'after'.repeat(900)
    const sizes = [1, 2, 13, 4_096]
    for (const size of sizes) {
      const stream = stash.createStreamingRedactor()
      let actual = ''
      for (let offset = 0; offset < input.length; offset += size) actual += stream.push(input.slice(offset, offset + size))
      actual += stream.flush()
      assert.equal(actual, stash.redact(input), `secret length ${secret.length}, chunk ${size}`)
      assert.equal(actual.includes(secret), false)
    }
  }
})

test('different secret sharing prefix when keep most long match one by one value redaction semantics', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.put(1, 'SHORT', 'abc')
  stash.put(1, 'LONG', 'abcdef')
  const stream = stash.createStreamingRedactor()
  const output = stream.push('abc') + stream.push('def-more') + stream.flush()
  assert.equal(output, stash.redact('abcdef-more'))
})

test('ordinary stream output do not use wait for fixed4KiBbuffer, managed Token also across chunk redaction', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.addRedaction('managed-credential')
  const stream = stash.createStreamingRedactor()
  assert.equal(stream.push('progress\n'), 'progress\n')
  assert.equal(stream.push('managed-'), '')
  assert.equal(stream.push('credential'), '[REDACTED]')
  assert.equal(stream.flush(), '')
})
