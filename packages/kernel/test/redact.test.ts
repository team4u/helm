import assert from 'node:assert/strict';
import test from 'node:test';
import { redactJsonValue } from '../src/redact.js';
import { SecretStash } from '../src/services/secret-stash.js';

test('结构化脱敏覆盖含引号和换行的字段值与字段名，保留已有占位符', { timeout: 60_000 }, () => {
  const stash = new SecretStash();
  const secret = ['example"value', 'next line'].join('\n');
  const marker = stash.put(1, 'EXAMPLE', secret);
  const result = redactJsonValue({ [secret]: { list: [secret, marker] } }, (text) => stash.redact(text));
  assert.deepEqual(result, { [marker]: { list: [marker, marker] } });
  assert.equal(JSON.stringify(result).includes('example'), false);
});

test('结构化输出拒绝循环、非 JSON 数据与脱敏后字段冲突', { timeout: 60_000 }, () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, { value: undefined }, [NaN], new Map(), Array(1)]) {
    assert.throws(() => redactJsonValue(value, (text) => text));
  }
  assert.throws(() => redactJsonValue({ first: 1, second: 2 }, () => 'same'), /冲突/);
});
