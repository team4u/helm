/**
 * structured-output pure function single test:parseSchemaCandidate choose extract order
 * (fenced json block -> balance scan -> whole text) and any legal JSON top-level support.
 * end-to-end behavior (tool self-heal/two round validate) by spawn-ask.test.ts lock.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseSchemaCandidate, validateJsonSchema } from '../src/runtime/structured-output.js'

const objectSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } as Record<string, unknown>

describe('parseSchemaCandidate', { timeout: 60_000 }, () => {
  it('fenced json block takes precedence hit (across row object)', { timeout: 60_000 }, () => {
    const text = 'before say\n```json\n{\n  "answer": "42"\n}\n```\nafter record'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: '42' } })
  })

  it('balance scan extract without surround column JSON literal (contains embed set and string inside parentheses)', { timeout: 60_000 }, () => {
    const text = 'result below {"answer":"a}b{c"} please inspect'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: 'a}b{c' } })
  })

  it('mark amount top-level (null/number/boolean/string) via whole text hit', { timeout: 60_000 }, () => {
    const scalarSchema = { type: 'number' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate(' 42 ', scalarSchema), { ok: true, value: 42 })
    const nullSchema = { type: 'null' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate('null', nullSchema), { ok: true, value: null })
  })

  it('all choose do not satisfy Schema when such as failed and carry original text', { timeout: 60_000 }, () => {
    const text = 'no any JSON'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: false, raw: text })
  })
})

describe('validateJsonSchema', { timeout: 60_000 }, () => {
  it('legal/invalid input boolean wrap result', { timeout: 60_000 }, () => {
    assert.deepEqual(validateJsonSchema({ answer: 'x' }, objectSchema), { ok: true, errors: [] })
    const bad = validateJsonSchema({ answer: 3 }, objectSchema)
    assert.equal(bad.ok, false)
    assert.equal(bad.errors.length, 1)
  })
})
