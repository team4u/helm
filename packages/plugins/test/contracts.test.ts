/**
 * 内置插件共享契约（@helm/plugins contracts.ts）边界校验测试：
 * - extractWorkflowExecutionMeta：worktree / controls 业务形状（严格对象、
 *   非空 trim 坐标、未知键拒绝、克隆、孤立 controls 拒绝）与 envelope 复验；
 * - workflowExecutionMeta：合并语义（保留其他命名空间与 workflow 命名空间
 *   未提及的既有键；防御性克隆/校验合并基底）；
 * - parseWorkflowSpawnMeta / withWorkflowSpawnMeta：spawn meta 业务值
 *   schema 校验与合并写入。
 * （自 @helm/protocol 迁出后的业务形状权威测试归属 @helm/plugins；envelope
 *  层测试见 packages/protocol/test/agent-exec.test.ts。）
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import {
  extractWorkflowExecutionMeta,
  parseWorkflowSpawnMeta,
  workflowExecutionMeta,
  withWorkflowSpawnMeta,
  WORKFLOW_META_NAMESPACE,
} from '../src/contracts.js'

const timeout = { timeout: 60_000 } as const

describe('extractWorkflowExecutionMeta（execution meta 业务形状）', () => {
  it('合法 worktree + controls 通过并深克隆（trim 收敛坐标）', timeout, () => {
    const info: AgentExecutionInfo = {
      nodeId: 'local',
      executionId: 'ws:p1',
      effectiveCwd: '/tmp/work',
      meta: {
        [WORKFLOW_META_NAMESPACE]: {
          worktree: { path: '/wt/main', branch: 'helm/wf-1' },
          controls: { steer: { pluginId: ' builtin:herdr ', actionId: 'steer' } },
        },
      },
    }
    const meta = extractWorkflowExecutionMeta(info)
    assert.deepEqual(meta.controls, { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } })
    assert.deepEqual(meta.worktree, { path: '/wt/main', branch: 'helm/wf-1' })
    // 克隆：改写源不影响已收敛结果。
    const source: AgentExecutionInfo = {
      nodeId: 'local',
      executionId: 'ws:p1',
      meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } } } },
    }
    const sanitized = extractWorkflowExecutionMeta(source)
    ;(source.meta![WORKFLOW_META_NAMESPACE] as Record<string, unknown>)['controls'] = { steer: { pluginId: 'mutated', actionId: 'x' } }
    assert.equal(sanitized.controls?.steer?.pluginId, 'p')
  })

  it('孤立 controls 拒绝：缺 executionId 或缺 nodeId 均拒绝', timeout, () => {
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          executionId: 'ws:p1',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } } } },
        } as never),
      (error: unknown) => error instanceof HelmError && error.message.includes('executionId + nodeId'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } } } },
        } as never),
      (error: unknown) => error instanceof HelmError && error.message.includes('executionId + nodeId'),
    )
    // 原生执行（conversationId 回传）不带 controls 不受影响。
    assert.deepEqual(extractWorkflowExecutionMeta({ conversationId: 5 }), {})
  })

  it('未知字段拒绝（命名空间内与 controls 内）', timeout, () => {
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { runId: 'r1' } },
        }),
      (error: unknown) => error instanceof HelmError && error.message.includes('未知字段 "runId"'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' }, abort: { pluginId: 'p' } } } },
        }),
      (error: unknown) => error instanceof HelmError && error.message.includes('controls 未知字段 "abort"'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a', extra: 1 } } } },
        }),
      (error: unknown) => error instanceof HelmError && error.message.includes('controls.steer 未知字段 "extra"'),
    )
  })

  it('非对象 / 空对象 / 坏坐标 / 坏 worktree 拒绝', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => extractWorkflowExecutionMeta({ nodeId: 'local', executionId: 'e', meta: { [WORKFLOW_META_NAMESPACE]: slot } as never }),
        (error: unknown) => error instanceof HelmError,
      )
    bad({ controls: null })
    bad({ controls: [] })
    bad({ controls: {} })
    bad({ controls: { steer: null } })
    bad({ controls: { steer: { pluginId: '', actionId: 'a' } } })
    bad({ controls: { steer: { pluginId: 'p', actionId: '   ' } } })
    bad({ controls: { steer: { pluginId: 1, actionId: 'a' } } })
    bad({ worktree: null })
    bad({ worktree: { path: 'rel/path', branch: 'b' } })
    bad({ worktree: { path: '/wt', branch: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', repoRoot: 'rel' } })
    bad({ worktree: { path: '/wt', branch: 'b', dirtySource: 'yes' } })
    // 可选登记字段合法形状通过。
    const ok = extractWorkflowExecutionMeta({
      nodeId: 'local',
      executionId: 'e',
      meta: {
        [WORKFLOW_META_NAMESPACE]: {
          worktree: { path: '/wt', branch: 'b', id: 'local:/wt', repoRoot: '/repo', baseCommit: 'c1', dirtySource: true },
        },
      },
    })
    assert.deepEqual(ok.worktree, { path: '/wt', branch: 'b', id: 'local:/wt', repoRoot: '/repo', baseCommit: 'c1', dirtySource: true })
  })

  it('envelope 复验：坏 JSON-safe meta 在业务消费前显式拒绝（不当空处理）', timeout, () => {
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { worktree: { path: '/wt', branch: 'b' }, fn: () => 1 } } as never,
        }),
      (error: unknown) => error instanceof HelmError && (error.code === 'meta_invalid' || error.message.includes('业务值非法')),
    )
    // 其他命名空间坏形状同样拒绝（envelope 复验不区分命名空间归属）。
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { 'other-plugin': { bad: new Date(0) } } as never,
        }),
      (error: unknown) => error instanceof HelmError && error.code === 'meta_invalid',
    )
  })
})

describe('workflowExecutionMeta（合并语义）', () => {
  it('合并保留其他命名空间与 workflow 命名空间未提及的既有键', timeout, () => {
    const existing = {
      'other-plugin': { keep: [1, { a: 'b' }] },
      [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } },
    }
    const merged = workflowExecutionMeta({ worktree: { path: '/wt', branch: 'helm/wf-1', id: 'local:/wt' } }, existing)
    assert.deepEqual(merged['other-plugin'], { keep: [1, { a: 'b' }] })
    // controls 未提及即保留；worktree 写入新值。
    assert.deepEqual(
      merged[WORKFLOW_META_NAMESPACE],
      {
        controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } },
        worktree: { path: '/wt', branch: 'helm/wf-1', id: 'local:/wt' },
      },
    )
    // 合并结果仍经业务 schema 收敛。
    const info: AgentExecutionInfo = { nodeId: 'local', executionId: 'e', meta: merged }
    const parsed = extractWorkflowExecutionMeta(info)
    assert.equal(parsed.controls?.steer?.pluginId, 'builtin:herdr')
    assert.equal(parsed.worktree?.id, 'local:/wt')
  })

  it('合并基底防御性克隆/校验：改写 existing 不影响产物；坏基底显式拒绝', timeout, () => {
    const existing = { 'other-plugin': { v: 1 } } as Record<string, { v: number }>
    const merged = workflowExecutionMeta({ worktree: { path: '/wt', branch: 'b' } }, existing)
    existing['other-plugin']!['v'] = 2
    assert.deepEqual(merged['other-plugin'], { v: 1 })
    assert.throws(
      () => workflowExecutionMeta({ controls: { steer: { pluginId: 'p', actionId: 'a' } } }, { bad: { fn: () => 1 } } as never),
      (error: unknown) => error instanceof HelmError && error.code === 'meta_invalid',
    )
  })

  it('无基底时仅含 workflow 命名空间（herdr 生产方直接可用）', timeout, () => {
    const meta = workflowExecutionMeta({ controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } })
    assert.deepEqual(Object.keys(meta), [WORKFLOW_META_NAMESPACE])
  })
})

describe('parseWorkflowSpawnMeta / withWorkflowSpawnMeta（spawn meta 业务值）', () => {
  it('缺失命名空间返回空对象；合法值通过', timeout, () => {
    assert.deepEqual(parseWorkflowSpawnMeta(undefined), {})
    assert.deepEqual(parseWorkflowSpawnMeta({}), {})
    assert.deepEqual(parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: {} }), {})
    assert.deepEqual(
      parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: { runId: 'r1', maxSubagentDepth: 3 } }),
      { runId: 'r1', maxSubagentDepth: 3 },
    )
  })

  it('非法业务值显式拒绝（未知字段 / 越界深度 / 空 runId）', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => parseWorkflowSpawnMeta({ [WORKFLOW_META_NAMESPACE]: slot } as never),
        (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
      )
    bad({ unknown: 1 })
    bad({ runId: '' })
    bad({ maxSubagentDepth: 0 })
    bad({ maxSubagentDepth: 6 })
    bad({ maxSubagentDepth: 2.5 })
  })

  it('withWorkflowSpawnMeta 合并保留其他命名空间与既有业务键；undefined 键不写入', timeout, () => {
    const base = { 'other-plugin': { a: 1 }, [WORKFLOW_META_NAMESPACE]: { runId: 'r1' } }
    const merged = withWorkflowSpawnMeta(base, { maxSubagentDepth: 3 })
    assert.deepEqual(merged, { 'other-plugin': { a: 1 }, [WORKFLOW_META_NAMESPACE]: { runId: 'r1', maxSubagentDepth: 3 } })
    assert.deepEqual(withWorkflowSpawnMeta(undefined, { runId: 'x' }), { [WORKFLOW_META_NAMESPACE]: { runId: 'x' } })
    // undefined 值不写入（不改写既有 runId）。
    const untouched = withWorkflowSpawnMeta(base, { runId: undefined })
    assert.deepEqual(untouched[WORKFLOW_META_NAMESPACE], { runId: 'r1' })
  })
})
