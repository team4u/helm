/**
 * 内置插件共享契约（@helmx/plugins contracts.ts）边界校验测试：
 * - extractWorkflowExecutionMeta：controls 业务形状（严格对象、非空 trim
 *   坐标、未知键拒绝、克隆、孤立 controls 拒绝）与 envelope 复验；
 * - extractWorktreeExecutionMeta：worktree 业务形状（绝对路径 / 非空分支 /
 *   可选登记字段、未知键拒绝、克隆）与 envelope 复验（'builtin:worktree'
 *   命名空间与 workflow 命名空间正交）；
 * - workflowExecutionMeta / worktreeExecutionMeta：合并语义（保留其他命名空
 *   空间与本命名空间未提及的既有键；防御性克隆/校验合并基底）；
 * - parseWorkflowSpawnMeta / withWorkflowSpawnMeta：spawn meta 业务值
 *   schema 校验与合并写入。
 * （自 @helmx/protocol 迁出后的业务形状权威测试归属 @helmx/plugins；envelope
 *  层测试见 packages/protocol/test/agent-exec.test.ts。）
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import {
  extractWorkflowExecutionMeta,
  extractWorktreeExecutionMeta,
  parseWorkflowSpawnMeta,
  workflowExecutionMeta,
  worktreeExecutionMeta,
  withWorkflowSpawnMeta,
  WORKFLOW_META_NAMESPACE,
  WORKTREE_META_NAMESPACE,
} from '../src/contracts.js'

const timeout = { timeout: 60_000 } as const

describe('extractWorkflowExecutionMeta（execution meta 业务形状）', () => {
  it('合法 controls 通过并深克隆（trim 收敛坐标）', timeout, () => {
    const info: AgentExecutionInfo = {
      nodeId: 'local',
      executionId: 'ws:p1',
      effectiveCwd: '/tmp/work',
      meta: {
        [WORKFLOW_META_NAMESPACE]: {
          controls: { steer: { pluginId: ' builtin:herdr ', actionId: 'steer' } },
        },
      },
    }
    const meta = extractWorkflowExecutionMeta(info)
    assert.deepEqual(meta.controls, { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } })
    // worktree 槽已迁至 'builtin:worktree' 命名空间：workflow 命名空间内出现即未知字段拒绝。
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { worktree: { path: '/wt', branch: 'b' } } } as never,
        }),
      (error: unknown) => error instanceof HelmxError && error.message.includes('未知字段 "worktree"'),
    )
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
      (error: unknown) => error instanceof HelmxError && error.message.includes('executionId + nodeId'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } } } },
        } as never),
      (error: unknown) => error instanceof HelmxError && error.message.includes('executionId + nodeId'),
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
      (error: unknown) => error instanceof HelmxError && error.message.includes('未知字段 "runId"'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' }, abort: { pluginId: 'p' } } } },
        }),
      (error: unknown) => error instanceof HelmxError && error.message.includes('controls 未知字段 "abort"'),
    )
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a', extra: 1 } } } },
        }),
      (error: unknown) => error instanceof HelmxError && error.message.includes('controls.steer 未知字段 "extra"'),
    )
  })

  it('非对象 / 空对象 / 坏坐标拒绝', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => extractWorkflowExecutionMeta({ nodeId: 'local', executionId: 'e', meta: { [WORKFLOW_META_NAMESPACE]: slot } as never }),
        (error: unknown) => error instanceof HelmxError,
      )
    bad({ controls: null })
    bad({ controls: [] })
    bad({ controls: {} })
    bad({ controls: { steer: null } })
    bad({ controls: { steer: { pluginId: '', actionId: 'a' } } })
    bad({ controls: { steer: { pluginId: 'p', actionId: '   ' } } })
    bad({ controls: { steer: { pluginId: 1, actionId: 'a' } } })
  })

  it('envelope 复验：坏 JSON-safe meta 在业务消费前显式拒绝（不当空处理）', timeout, () => {
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } }, fn: () => 1 } } as never,
        }),
      (error: unknown) => error instanceof HelmxError && (error.code === 'meta_invalid' || error.message.includes('业务值非法')),
    )
    // 其他命名空间坏形状同样拒绝（envelope 复验不区分命名空间归属）。
    assert.throws(
      () =>
        extractWorkflowExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { 'other-plugin': { bad: new Date(0) } } as never,
        }),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
  })
})

describe('extractWorktreeExecutionMeta（worktree 命名空间业务形状）', () => {
  it('合法 worktree 通过并深克隆；缺失命名空间返回空对象', timeout, () => {
    assert.deepEqual(extractWorktreeExecutionMeta({ conversationId: 5 }), {})
    assert.deepEqual(extractWorktreeExecutionMeta({}), {})
    const ok = extractWorktreeExecutionMeta({
      nodeId: 'local',
      executionId: 'e',
      meta: {
        [WORKTREE_META_NAMESPACE]: {
          worktree: {
            path: '/wt',
            branch: 'b',
            id: 'local:/wt',
            repoRoot: '/repo',
            baseCommit: 'c1',
            baseBranch: 'helmx/spawn-12ab34cd',
            parentWorktreeId: 'local:/repo/../.helmx-worktrees/repo-12ab34cd',
            dirtySource: true,
          },
        },
      },
    })
    assert.deepEqual(ok.worktree, {
      path: '/wt',
      branch: 'b',
      id: 'local:/wt',
      repoRoot: '/repo',
      baseCommit: 'c1',
      baseBranch: 'helmx/spawn-12ab34cd',
      parentWorktreeId: 'local:/repo/../.helmx-worktrees/repo-12ab34cd',
      dirtySource: true,
    })
    // 与 workflow 命名空间正交：controls 槽不影响 worktree 提取。
    const both = extractWorktreeExecutionMeta({
      nodeId: 'local',
      executionId: 'e',
      meta: {
        [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'p', actionId: 'a' } } },
        [WORKTREE_META_NAMESPACE]: { worktree: { path: '/wt2', branch: 'b2' } },
      },
    })
    assert.deepEqual(both.worktree, { path: '/wt2', branch: 'b2' })
  })

  it('坏 worktree 形状与未知字段拒绝', timeout, () => {
    const bad = (slot: unknown) =>
      assert.throws(
        () => extractWorktreeExecutionMeta({ nodeId: 'local', executionId: 'e', meta: { [WORKTREE_META_NAMESPACE]: slot } as never }),
        (error: unknown) => error instanceof HelmxError,
      )
    bad({ worktree: null })
    bad({ worktree: [] })
    bad({ worktree: { path: 'rel/path', branch: 'b' } })
    bad({ worktree: { path: '/wt', branch: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', repoRoot: 'rel' } })
    bad({ worktree: { path: '/wt', branch: 'b', dirtySource: 'yes' } })
    bad({ worktree: { path: '/wt', branch: 'b', baseBranch: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', baseBranch: 7 } })
    bad({ worktree: { path: '/wt', branch: 'b', parentWorktreeId: '' } })
    bad({ worktree: { path: '/wt', branch: 'b', parentWorktreeId: false } })
    bad({ worktree: { path: '/wt', branch: 'b' }, lease: 'x' })
  })

  it('envelope 复验：坏 JSON-safe meta 在业务消费前显式拒绝', timeout, () => {
    assert.throws(
      () =>
        extractWorktreeExecutionMeta({
          nodeId: 'local',
          executionId: 'e',
          meta: { [WORKTREE_META_NAMESPACE]: { worktree: { path: '/wt', branch: 'b' }, fn: () => 1 } } as never,
        }),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
  })
})

describe('workflowExecutionMeta / worktreeExecutionMeta（合并语义）', () => {
  it('合并保留其他命名空间与本命名空间未提及的既有键', timeout, () => {
    const existing = {
      'other-plugin': { keep: [1, { a: 'b' }] },
      [WORKFLOW_META_NAMESPACE]: { controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } },
    }
    const merged = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'helmx/wf-1', id: 'local:/wt' } }, existing)
    assert.deepEqual(merged['other-plugin'], { keep: [1, { a: 'b' }] })
    // 其他命名空间（含 workflow 槽）原样保留；worktree 写入新命名空间。
    assert.deepEqual(
      merged[WORKFLOW_META_NAMESPACE],
      { controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } },
    )
    assert.deepEqual(
      merged[WORKTREE_META_NAMESPACE],
      { worktree: { path: '/wt', branch: 'helmx/wf-1', id: 'local:/wt' } },
    )
    // 合并结果仍经业务 schema 收敛（两命名空间各自可提取）。
    const info: AgentExecutionInfo = { nodeId: 'local', executionId: 'e', meta: merged }
    assert.equal(extractWorkflowExecutionMeta(info).controls?.steer?.pluginId, 'builtin:herdr')
    assert.equal(extractWorktreeExecutionMeta(info).worktree?.id, 'local:/wt')
  })

  it('workflowExecutionMeta 写 controls 保留既有 worktree 命名空间（herdr 双槽生产方语义）', timeout, () => {
    const withWorktree = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } })
    const merged = workflowExecutionMeta({ controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } }, withWorktree)
    assert.deepEqual(merged[WORKFLOW_META_NAMESPACE], {
      controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } },
    })
    assert.deepEqual(merged[WORKTREE_META_NAMESPACE], { worktree: { path: '/wt', branch: 'b' } })
  })

  it('合并基底防御性克隆/校验：改写 existing 不影响产物；坏基底显式拒绝', timeout, () => {
    const existing = { 'other-plugin': { v: 1 } } as Record<string, { v: number }>
    const merged = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } }, existing)
    existing['other-plugin']!['v'] = 2
    assert.deepEqual(merged['other-plugin'], { v: 1 })
    assert.throws(
      () => workflowExecutionMeta({ controls: { steer: { pluginId: 'p', actionId: 'a' } } }, { bad: { fn: () => 1 } } as never),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
    assert.throws(
      () => worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } }, { bad: { fn: () => 1 } } as never),
      (error: unknown) => error instanceof HelmxError && error.code === 'meta_invalid',
    )
  })

  it('无基底时仅含本命名空间（生产方直接可用）', timeout, () => {
    const meta = workflowExecutionMeta({ controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } })
    assert.deepEqual(Object.keys(meta), [WORKFLOW_META_NAMESPACE])
    const wtMeta = worktreeExecutionMeta({ worktree: { path: '/wt', branch: 'b' } })
    assert.deepEqual(Object.keys(wtMeta), [WORKTREE_META_NAMESPACE])
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
        (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
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
