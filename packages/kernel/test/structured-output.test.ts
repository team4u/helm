/**
 * structured-output 纯函数单测：parseSchemaCandidate 的候选提取顺序
 * （fenced json block -> 平衡扫描 -> 整体文本）与任意合法 JSON 顶层支持。
 * 端到端行为（工具自愈/两轮校验）由 spawn-ask.test.ts 锁定。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseSchemaCandidate, validateJsonSchema } from '../src/runtime/structured-output.js'

const objectSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } as Record<string, unknown>

describe('parseSchemaCandidate', { timeout: 60_000 }, () => {
  it('fenced json block 优先命中（跨行对象）', { timeout: 60_000 }, () => {
    const text = '前言\n```json\n{\n  "answer": "42"\n}\n```\n后记'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: '42' } })
  })

  it('平衡扫描提取无围栏 JSON 字面量（含嵌套与字符串内括号）', { timeout: 60_000 }, () => {
    const text = '结果如下 {"answer":"a}b{c"} 请查收'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: 'a}b{c' } })
  })

  it('标量顶层（null/数字/布尔/字符串）经整体文本命中', { timeout: 60_000 }, () => {
    const scalarSchema = { type: 'number' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate(' 42 ', scalarSchema), { ok: true, value: 42 })
    const nullSchema = { type: 'null' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate('null', nullSchema), { ok: true, value: null })
  })

  it('全部候选不满足 Schema 时如实失败并携带原文', { timeout: 60_000 }, () => {
    const text = '没有任何 JSON'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: false, raw: text })
  })
})

describe('validateJsonSchema', { timeout: 60_000 }, () => {
  it('合法/非法输入的 boolean 包装结果', { timeout: 60_000 }, () => {
    assert.deepEqual(validateJsonSchema({ answer: 'x' }, objectSchema), { ok: true, errors: [] })
    const bad = validateJsonSchema({ answer: 3 }, objectSchema)
    assert.equal(bad.ok, false)
    assert.equal(bad.errors.length, 1)
  })
})
