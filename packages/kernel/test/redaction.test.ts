/**
 * 脱敏与流式脱敏回归：结构化 JSON 脱敏与 SecretStash 流式分块边界。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactJsonValue } from '../src/redact.js'
import { SecretStash } from '../src/services/secret-stash.js'

test('结构化脱敏覆盖含引号和换行的字段值与字段名，保留已有占位符', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const secret = ['example"value', 'next line'].join('\n')
  const marker = stash.put(1, 'EXAMPLE', secret)
  const result = redactJsonValue({ [secret]: { list: [secret, marker] } }, (text) => stash.redact(text))
  assert.deepEqual(result, { [marker]: { list: [marker, marker] } })
  assert.equal(JSON.stringify(result).includes('example'), false)
})

test('结构化输出拒绝循环、非 JSON 数据与脱敏后字段冲突', { timeout: 60_000 }, () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const value of [cyclic, { value: undefined }, [NaN], new Map(), Array(1)]) {
    assert.throws(() => redactJsonValue(value, (text) => text))
  }
  assert.throws(() => redactJsonValue({ first: 1, second: 2 }, () => 'same'), /冲突/)
})

test('流脱敏覆盖秘密跨分块、重叠前后缀与旧固定切点', { timeout: 60_000 }, () => {
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

test('不同秘密共享前缀时保留最长匹配的逐值脱敏语义', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.put(1, 'SHORT', 'abc')
  stash.put(1, 'LONG', 'abcdef')
  const stream = stash.createStreamingRedactor()
  const output = stream.push('abc') + stream.push('def-more') + stream.flush()
  assert.equal(output, stash.redact('abcdef-more'))
})

test('普通流输出不用等待固定4KiB缓冲，受管 Token 也跨块脱敏', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.addRedaction('managed-credential')
  const stream = stash.createStreamingRedactor()
  assert.equal(stream.push('progress\n'), 'progress\n')
  assert.equal(stream.push('managed-'), '')
  assert.equal(stream.push('credential'), '[REDACTED]')
  assert.equal(stream.flush(), '')
})
