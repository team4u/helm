/**
 * AgentExecutionInfo.meta 命名空间 envelope 边界校验测试（@helm/protocol
 * 契约）：JSON-safe 深克隆 / 未知顶层字段拒绝 / conversationId 或
 * executionId 至少其一 / meta 形状（非对象、非对象命名空间）/ 非 JSON 值
 * （函数/Symbol/undefined/NaN/Infinity/类实例）/ 循环、数量、长度、深度
 * 界限 / 数组合法递归与稀疏洞拒绝。
 * 业务形状（worktree / controls 等）的 schema 测试在内核插件侧共享契约
 * 模块的对应测试（packages/kernel/test/...）。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError, sanitizeAgentExecutionInfo, sanitizeAgentNamespacedMeta } from '../src/index.js'

const timeout = { timeout: 60_000 } as const
const ctx = { agentId: 'agent-x' }

function rejects(value: unknown, reasonPart: string, code = 'execution_info_invalid'): void {
  assert.throws(
    () => sanitizeAgentExecutionInfo(value, ctx),
    (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, code)
      assert.ok(error.message.includes(reasonPart), `信息应含「${reasonPart}」（实际 ${error.message}）`)
      return true
    },
  )
}

describe('sanitizeAgentExecutionInfo.meta envelope', () => {
  it('合法 JSON-safe 命名空间通过并深克隆（含数组递归值）', timeout, () => {
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
    // 深克隆：改写回传源任何层级不影响已收敛结果。
    const workflowSlot = (source['meta'] as Record<string, Record<string, unknown>>)['builtin:workflow']!
    workflowSlot['runId'] = 'mutated'
    ;(workflowSlot['flags'] as unknown[])[0] = 'mutated'
    assert.equal(info.meta?.['builtin:workflow']?.['runId'], 'r1')
    assert.equal((info.meta?.['builtin:workflow']?.['flags'] as unknown[])[0], 1)
  })

  it('未知顶层字段拒绝', timeout, () => {
    rejects({ executionId: 'e', controls: {} }, '未知字段 "controls"')
    rejects({ executionId: 'e', worktree: { path: '/w' } }, '未知字段 "worktree"')
    rejects({ conversationId: 5, workflowRunId: 'r1' }, '未知字段 "workflowRunId"')
  })

  it('缺少 conversationId 与 executionId 拒绝', timeout, () => {
    rejects({ nodeId: 'local' }, '至少回传 conversationId 或 executionId 之一')
    rejects({}, '至少回传 conversationId 或 executionId 之一')
  })

  it('meta 非对象 / 命名空间值非对象拒绝', timeout, () => {
    rejects({ executionId: 'e', meta: [] }, '必须是命名空间到普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: 'x' }, '必须是命名空间到普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: null }, '必须是命名空间到普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': null } }, '命名空间 \'p\' 的值必须是普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': [1] } }, '命名空间 \'p\' 的值必须是普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { 'p': 'str' } }, '命名空间 \'p\' 的值必须是普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { '  ': {} } }, '命名空间键必须是非空非纯空白字符串', 'meta_invalid')
  })

  it('非 JSON 值拒绝：函数 / Symbol / NaN / Infinity / 类实例', timeout, () => {
    rejects({ executionId: 'e', meta: { p: { fn: () => 1 } } }, '含非 JSON-safe 值', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { sym: Symbol('s') } } }, '含非 JSON-safe 值', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { nan: Number.NaN } } }, '数值必须有限', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { inf: Number.POSITIVE_INFINITY } } }, '数值必须有限', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { d: new Date(0) } } }, '必须是普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { m: new Map() } } }, '必须是普通对象', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { arr: [new Date(0)] } } }, '必须是普通对象', 'meta_invalid')
  })

  it('数组元素拒绝 undefined 与稀疏洞（对象显式 undefined 键按缺省丢弃）', timeout, () => {
    rejects({ executionId: 'e', meta: { p: { arr: [1, undefined] } } }, '数组元素不能是 undefined', 'meta_invalid')
    rejects({ executionId: 'e', meta: { p: { arr: [1, , 3] } } }, '数组元素不能是 undefined', 'meta_invalid')
    // 对象显式 undefined 键与 JSON.stringify 语义一致：按缺省克隆丢弃，不报错。
    const info = sanitizeAgentExecutionInfo({ executionId: 'e', meta: { p: { keep: 1, drop: undefined } } }, ctx)
    assert.deepEqual(info.meta, { p: { keep: 1 } })
  })

  it('循环引用拒绝（深度界限封死）', timeout, () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    rejects({ executionId: 'e', meta: { p: cyclic } }, '嵌套深度超过', 'meta_invalid')
    const cyclicArray: unknown[] = []
    cyclicArray.push(cyclicArray)
    rejects({ executionId: 'e', meta: { p: { arr: cyclicArray } } }, '嵌套深度超过', 'meta_invalid')
  })

  it('深度 / 数量 / 长度界限', timeout, () => {
    // 嵌套 12 层（上限 8）拒绝。
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 12; i += 1) deep = { nested: deep }
    rejects({ executionId: 'e', meta: { p: deep } }, '嵌套深度超过', 'meta_invalid')
    // 键数超限（每层 64）。
    const wide: Record<string, number> = {}
    for (let i = 0; i < 65; i += 1) wide[`k${i}`] = i
    rejects({ executionId: 'e', meta: { p: wide } }, '对象键数超过', 'meta_invalid')
    // 字符串长度超限（65536）。
    rejects({ executionId: 'e', meta: { p: { s: 'x'.repeat(65_537) } } }, '字符串长度超过', 'meta_invalid')
    // 数组长度超限（1024）。
    rejects({ executionId: 'e', meta: { p: { arr: new Array(1025).fill(0) } } }, '数组长度超过', 'meta_invalid')
    // 总节点上限（4096）。
    const many: unknown[] = []
    for (let i = 0; i < 70; i += 1) {
      const chunk: Record<string, number> = {}
      for (let j = 0; j < 64; j += 1) chunk[`k${j}`] = j
      many.push(chunk)
    }
    rejects({ executionId: 'e', meta: { p: { many } } }, '超出 meta 总节点上限', 'meta_invalid')
  })

  it('深度恰好 8 层接受（界限内不误伤）', timeout, () => {
    // 命名空间槽直属值为第 1 层：{ a: { a: ... } } 共 8 层对象、叶原语不占深度。
    let value: unknown = { leaf: true }
    for (let i = 0; i < 7; i += 1) value = { a: value }
    const info = sanitizeAgentExecutionInfo({ executionId: 'e', meta: { p: value } }, ctx)
    assert.ok(info.meta?.['p'])
  })

  it('既有顶层字段校验保持（nodeId/conversationId/executionId/effectiveCwd）', timeout, () => {
    rejects('str', '回调载荷必须是对象')
    rejects({ conversationId: 0 }, 'conversationId 必须是正整数')
    rejects({ conversationId: 1.5 }, 'conversationId 必须是正整数')
    rejects({ executionId: '' }, 'executionId 必须是非空字符串')
    rejects({ conversationId: 5, nodeId: '  ' }, 'nodeId 必须是非空字符串')
    rejects({ conversationId: 5, effectiveCwd: 'rel/path' }, 'effectiveCwd 必须是绝对路径')
    const info = sanitizeAgentExecutionInfo(
      { nodeId: ' node-1 ', conversationId: 7, executionId: 'e', effectiveCwd: '/abs' },
      ctx,
    )
    assert.deepEqual(info, { nodeId: ' node-1 ', conversationId: 7, executionId: 'e', effectiveCwd: '/abs' })
  })
})

describe('sanitizeAgentNamespacedMeta（独立入口同契约）', () => {
  it('undefined 返回空对象；合法值与 sanitizeAgentExecutionInfo 同界', timeout, () => {
    assert.deepEqual(sanitizeAgentNamespacedMeta(undefined, ctx), {})
    const out = sanitizeAgentNamespacedMeta({ p: { a: [1, { b: null }] } }, ctx)
    assert.deepEqual(out, { p: { a: [1, { b: null }] } })
  })
})
