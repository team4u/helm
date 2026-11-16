/**
 * structured-output pure function single test:parseSchemaCandidate choose extract order
 * (fenced json block -> balance scan -> whole text) and any legal JSON top-level support.
 * end-to-end behavior (tool self-heal/two round validate) by spawn-ask.test.ts lock.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  extractAcceptedStructuredOutputFromEntries,
  parseSchemaCandidate,
  validateJsonSchema,
} from '../src/runtime/structured-output.js'

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

describe('extractAcceptedStructuredOutputFromEntries', { timeout: 60_000 }, () => {
  it('忽略错误与未匹配的结果，精确提取最新非错误且通过 Schema 校验的入参', { timeout: 60_000 }, () => {
    const entries = [
      {
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'c1', name: 'register_structured_output', arguments: { output: { answer: 123 } } },
              { type: 'toolCall', id: 'c2', name: 'register_structured_output', arguments: { output: '{"answer":"first"}' } },
              { type: 'toolCall', id: 'c3', name: 'register_structured_output', arguments: { output: { answer: 'interrupted' } } },
            ],
          },
        ],
      },
      {
        kind: 'pi.tool-result',
        model: [
          { role: 'toolResult', toolCallId: 'c1', toolName: 'register_structured_output', isError: true },
          { role: 'toolResult', toolCallId: 'c2', toolName: 'register_structured_output', isError: false },
          { role: 'toolResult', toolCallId: 'c3', toolName: 'register_structured_output', isError: true },
        ],
      },
    ]
    assert.deepEqual(extractAcceptedStructuredOutputFromEntries(entries, objectSchema), {
      found: true,
      value: { answer: 'first' },
    })
  })

  it('支持 null 合法顶层与后续成功覆盖先前回合结果', { timeout: 60_000 }, () => {
    const nullSchema = { type: 'null' } as Record<string, unknown>
    assert.deepEqual(
      extractAcceptedStructuredOutputFromEntries(
        [
          {
            kind: 'pi.assistant',
            model: [
              {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'cn', name: 'register_structured_output', arguments: { output: null } }],
              },
            ],
          },
          {
            kind: 'pi.tool-result',
            model: [{ role: 'toolResult', toolCallId: 'cn', toolName: 'register_structured_output', isError: false }],
          },
        ],
        nullSchema,
      ),
      { found: true, value: null },
    )
    assert.deepEqual(extractAcceptedStructuredOutputFromEntries([], objectSchema), { found: false })
  })
})
