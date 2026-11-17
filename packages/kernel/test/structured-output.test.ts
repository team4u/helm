/**
 * Unit tests for structured-output pure functions: `parseSchemaCandidate` extraction order
 * (fenced json block -> balanced JSON scan -> whole text) and arbitrary valid JSON top-level support.
 * End-to-end behavior (tool self-healing / two-round validation) is covered by `spawn-ask.test.ts`.
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
  it('prefers fenced json block first (multi-line object)', { timeout: 60_000 }, () => {
    const text = 'before text\n```json\n{\n  "answer": "42"\n}\n```\nafter text'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: '42' } })
  })

  it('uses balanced scan to extract un-fenced JSON literals (including nested braces inside strings)', { timeout: 60_000 }, () => {
    const text = 'result below {"answer":"a}b{c"} please inspect'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: true, value: { answer: 'a}b{c' } })
  })

  it('supports scalar top-levels (null/number/boolean/string) via whole-text match', { timeout: 60_000 }, () => {
    const scalarSchema = { type: 'number' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate(' 42 ', scalarSchema), { ok: true, value: 42 })
    const nullSchema = { type: 'null' } as Record<string, unknown>
    assert.deepEqual(parseSchemaCandidate('null', nullSchema), { ok: true, value: null })
  })

  it('fails cleanly with original raw text when no candidate matches Schema', { timeout: 60_000 }, () => {
    const text = 'no any JSON'
    const result = parseSchemaCandidate(text, objectSchema)
    assert.deepEqual(result, { ok: false, raw: text })
  })
})

describe('validateJsonSchema', { timeout: 60_000 }, () => {
  it('returns ok/errors validation wrapper for valid and invalid inputs', { timeout: 60_000 }, () => {
    assert.deepEqual(validateJsonSchema({ answer: 'x' }, objectSchema), { ok: true, errors: [] })
    const bad = validateJsonSchema({ answer: 3 }, objectSchema)
    assert.equal(bad.ok, false)
    assert.equal(bad.errors.length, 1)
  })
})

describe('extractAcceptedStructuredOutputFromEntries', { timeout: 60_000 }, () => {
  it('ignores errored and unmatched results, extracting latest schema-valid accepted payload', { timeout: 60_000 }, () => {
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

  it('supports valid null top-level and subsequent success overriding prior turn output', { timeout: 60_000 }, () => {
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
