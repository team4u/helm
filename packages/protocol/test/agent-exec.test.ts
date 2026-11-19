/**
 * Tests for the AgentExecutionInfo.meta namespace envelope boundary validation
 * (@helmx/protocol contract): JSON-safe deep clone / unknown top-level field
 * rejection / at least one of conversationId or executionId / meta shape
 * (non-object, non-object namespace) / non-JSON values (functions/Symbols/
 * undefined/NaN/Infinity/class instances) / cycle, count, length and depth
 * limits / legal array recursion and sparse-hole rejection.
 * Schema tests for business shapes (worktree / controls etc.) live in the
 * corresponding tests of the kernel-side plugin shared contract module
 * (packages/kernel/test/...).
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmxError, sanitizeAgentExecutionInfo, sanitizeAgentGateResult, sanitizeAgentNamespacedMeta } from '../src/index.js'

const timeout = { timeout: 60_000 } as const
const ctx = { agentId: 'agent-x' }

function rejects(value: unknown, reasonPart: string, code = 'execution_info_invalid'): void {
  assert.throws(
    () => sanitizeAgentExecutionInfo(value, ctx),
    (error: unknown) => {
      assert.ok(error instanceof HelmxError)
      assert.equal(error.code, code)
      assert.ok(error.message.includes(reasonPart), `message should contain "${reasonPart}" (actual ${error.message})`)
      return true
    },
  )
}

describe('sanitizeAgentExecutionInfo.meta envelope', () => {
  it('valid JSON-safe namespaces pass and are deep-cloned (including nested array values)', timeout, () => {
    const source: Record<string, unknown> = {
      nodeId: 'local',
      executionId: 'ws:p1',
      effectiveCwd: '/tmp/work',
      meta: {
        'builtin:workflow': { runId: 'r1', flags: [1, 'two', false, null, [3, { deep: true }]] },
        'other-plugin': { note: 'n', nested: { a: [{ b: 'c' }] } },
      },
    }
    const info = sanitizeAgentExecutionInfo(source, ctx)
    assert.deepEqual(info.meta, {
      'builtin:workflow': { runId: 'r1', flags: [1, 'two', false, null, [3, { deep: true }]] },
      'other-plugin': { note: 'n', nested: { a: [{ b: 'c' }] } },
    })
    // Deep clone: mutating the reported source at any level does not affect the converged result.
    const workflowSlot = (source['meta'] as Record<string, Record<string, unknown>>)['builtin:workflow']!
    workflowSlot['runId'] = 'mutated'
    ;(workflowSlot['flags'] as unknown[])[0] = 'mutated'
    assert.equal(info.meta?.['builtin:workflow']?.['runId'], 'r1')
    assert.equal((info.meta?.['builtin:workflow']?.['flags'] as unknown[])[0], 1)
  })

  it('unknown top-level fields rejected', timeout, () => {
    rejects({ executionId: 'e', controls: {} }, 'unknown field "controls"')
    rejects({ executionId: 'e', worktree: { path: '/w' } }, 'unknown field "worktree"')
    rejects({ conversationId: 5, workflowRunId: 'r1' }, 'unknown field "workflowRunId"')
  })

  it('missing both conversationId and executionId rejected', timeout, () => {
    rejects({ nodeId: 'local' }, 'at least one of conversationId or executionId')
    rejects({}, 'at least one of conversationId or executionId')
  })

  it('non-object meta / non-object namespace value rejected', timeout, () => {
    rejects({ executionId: 'e', meta: [] }, 'must be a map from namespaces to plain objects', 'meta_invalid')
    rejects({ executionId: 'e', meta: 'x' }, 'must be a map from namespaces to plain objects', 'meta_invalid')
    rejects({ executionId: 'e', meta: null }, 'must be a map from namespaces to plain objects', 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': null } }, "the value of namespace 'p' must be a plain object", 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': [1] } }, "the value of namespace 'p' must be a plain object", 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': 'str' } }, "the value of namespace 'p' must be a plain object", 'meta_invalid')
    rejects({ executionId: 'e', meta: { '  ': {} } }, 'namespace keys must be non-empty', 'meta_invalid')
  })

  it('non-JSON values rejected: function / Symbol / NaN / Infinity / class instance', timeout, () => {
    rejects({ executionId: 'e', meta: { p: { fn: () => 1 } } }, 'non-JSON-safe value', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { sym: Symbol('s') } } }, 'non-JSON-safe value', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { nan: Number.NaN } } }, 'must be finite', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { inf: Number.POSITIVE_INFINITY } } }, 'must be finite', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { d: new Date(0) } } }, 'must be a plain object', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { m: new Map() } } }, 'must be a plain object', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { arr: [new Date(0)] } } }, 'must be a plain object', 'meta_invalid')
  })

  it('array elements reject undefined and sparse holes (explicit undefined object keys dropped as absent)', timeout, () => {
    rejects({ executionId: 'e', meta: { p: { arr: [1, undefined] } } }, 'must not be undefined', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { arr: [1, , 3] } } }, 'must not be undefined', 'meta_invalid')
    // Explicit undefined object keys follow JSON.stringify semantics: dropped as absent during cloning, no error.
    const info = sanitizeAgentExecutionInfo({ executionId: 'e', meta: { p: { keep: 1, drop: undefined } } }, ctx)
    assert.deepEqual(info.meta, { p: { keep: 1 } })
  })

  it('circular references rejected (foreclosed by depth limit)', timeout, () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    rejects({ executionId: 'e', meta: { p: cyclic } }, 'nesting depth exceeds', 'meta_invalid')
    const cyclicArray: unknown[] = []
    cyclicArray.push(cyclicArray)
    rejects({ executionId: 'e', meta: { p: { arr: cyclicArray } } }, 'nesting depth exceeds', 'meta_invalid')
  })

  it('depth / count / length limits', timeout, () => {
    // Nesting 12 levels deep (limit 8) rejected.
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 12; i += 1) deep = { nested: deep }
    rejects({ executionId: 'e', meta: { p: deep } }, 'nesting depth exceeds', 'meta_invalid')
    // Key count over the limit (64 per level).
    const wide: Record<string, number> = {}
    for (let i = 0; i < 65; i += 1) wide[`k${i}`] = i
    rejects({ executionId: 'e', meta: { p: wide } }, 'object key count exceeds', 'meta_invalid')
    // String length over the limit (65536).
    rejects({ executionId: 'e', meta: { p: { s: 'x'.repeat(65_537) } } }, 'string length exceeds', 'meta_invalid')
    // Array length over the limit (1024).
    rejects({ executionId: 'e', meta: { p: { arr: new Array(1025).fill(0) } } }, 'array length exceeds', 'meta_invalid')
    // Total node limit (4096).
    const many: unknown[] = []
    for (let i = 0; i < 70; i += 1) {
      const chunk: Record<string, number> = {}
      for (let j = 0; j < 64; j += 1) chunk[`k${j}`] = j
      many.push(chunk)
    }
    rejects({ executionId: 'e', meta: { p: { many } } }, 'total meta node limit', 'meta_invalid')
  })

  it('exactly 8 levels of nesting accepted (no false positives within limits)', timeout, () => {
    // The namespace slot's direct value is level 1: { a: { a: ... } } is 8 object levels total; leaf primitives consume no depth.
    let value: unknown = { leaf: true }
    for (let i = 0; i < 7; i += 1) value = { a: value }
    const info = sanitizeAgentExecutionInfo({ executionId: 'e', meta: { p: value } }, ctx)
    assert.ok(info.meta?.['p'])
  })

  it('existing top-level field validation preserved (nodeId/conversationId/executionId/effectiveCwd)', timeout, () => {
    rejects('str', 'callback payload must be an object')
    rejects({ conversationId: 0 }, 'conversationId must be a positive integer')
    rejects({ conversationId: 1.5 }, 'conversationId must be a positive integer')
    rejects({ executionId: '' }, 'executionId must be a non-empty string')
    rejects({ conversationId: 5, nodeId: '  ' }, 'nodeId must be a non-empty string')
    rejects({ conversationId: 5, effectiveCwd: 'rel/path' }, 'effectiveCwd must be an absolute path')
    const info = sanitizeAgentExecutionInfo(
      { nodeId: ' node-1 ', conversationId: 7, executionId: 'e', effectiveCwd: '/abs' },
      ctx,
    )
    assert.deepEqual(info, { nodeId: ' node-1 ', conversationId: 7, executionId: 'e', effectiveCwd: '/abs' })
  })
})

describe('sanitizeAgentGateResult (gate result contract)', () => {
  it('minimal valid payload passes without optional fields (compatible with older reporters)', timeout, () => {
    const out = sanitizeAgentGateResult({ ok: true, output: 'done' }, ctx)
    assert.deepEqual(out, { ok: true, output: 'done' })
  })

  it('full structure passes, preserving exitCode (including null) and timedOut verbatim', timeout, () => {
    const failed = sanitizeAgentGateResult(
      { ok: false, output: 'oops', exitCode: 3, timedOut: false },
      ctx,
    )
    assert.deepEqual(failed, { ok: false, output: 'oops', exitCode: 3, timedOut: false })
    const timedOut = sanitizeAgentGateResult(
      { ok: false, output: 'killed', exitCode: null, timedOut: true },
      ctx,
    )
    assert.deepEqual(timedOut, { ok: false, output: 'killed', exitCode: null, timedOut: true })
    // Negative integer exit codes (signal semantics) are legal integers too.
    const signalled = sanitizeAgentGateResult({ ok: false, output: '', exitCode: -1 }, ctx)
    assert.equal(signalled.exitCode, -1)
  })

  it('non-object / missing ok / non-string output rejected', timeout, () => {
    for (const bad of ['str', null, [], 42, { output: 'x' }, { ok: 1, output: 'x' }, { ok: true }]) {
      assert.throws(
        () => sanitizeAgentGateResult(bad, ctx),
        (error: unknown) => error instanceof HelmxError && error.code === 'gate_result_invalid',
      )
    }
  })

  it('unknown fields rejected (injection protection)', timeout, () => {
    assert.throws(
      () => sanitizeAgentGateResult({ ok: true, output: 'x', signal: 'SIGKILL' }, ctx),
      (error: unknown) =>
        error instanceof HelmxError &&
        error.code === 'gate_result_invalid' &&
        error.message.includes('must not carry unknown fields'),
    )
  })

  it('exitCode non-integer or non-null rejected; timedOut non-boolean rejected', timeout, () => {
    for (const badExit of [1.5, '3', true, {}, Number.NaN]) {
      assert.throws(
        () => sanitizeAgentGateResult({ ok: false, output: '', exitCode: badExit as never }, ctx),
        (error: unknown) =>
          error instanceof HelmxError &&
          error.code === 'gate_result_invalid' &&
          error.message.includes('exitCode'),
        `exitCode=${String(badExit)} should be rejected`,
      )
    }
    assert.throws(
      () => sanitizeAgentGateResult({ ok: false, output: '', timedOut: 'yes' as never }, ctx),
      (error: unknown) =>
        error instanceof HelmxError &&
        error.code === 'gate_result_invalid' &&
        error.message.includes('timedOut'),
    )
  })
})

describe('sanitizeAgentNamespacedMeta (standalone entry, same contract)', () => {
  it('undefined returns an empty object; valid values share the boundary with sanitizeAgentExecutionInfo', timeout, () => {
    assert.deepEqual(sanitizeAgentNamespacedMeta(undefined, ctx), {})
    const out = sanitizeAgentNamespacedMeta({ p: { a: [1, { b: null }] } }, ctx)
    assert.deepEqual(out, { p: { a: [1, { b: null }] } })
  })
})
