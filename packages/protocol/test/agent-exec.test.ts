/**
 * AgentExecutionInfo.controls 边界校验测试（@helm/protocol 契约）：
 * 严格对象形状 / 非空 trim 字符串 / 未知键拒绝 / 克隆 / 孤立 controls 拒绝
 * （外部执行必须同时携带 executionId + nodeId）。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError, sanitizeAgentExecutionInfo } from '../src/index.js'

const timeout = { timeout: 60_000 } as const
const ctx = { agentId: 'agent-x' }

function rejects(value: unknown, reasonPart: string): void {
  assert.throws(
    () => sanitizeAgentExecutionInfo(value, ctx),
    (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'execution_info_invalid')
      assert.ok(error.message.includes(reasonPart), `信息应含「${reasonPart}」（实际 ${error.message}）`)
      return true
    },
  )
}

describe('sanitizeAgentExecutionInfo.controls', () => {
  it('合法 controls 通过并深克隆（trim 收敛坐标）', timeout, () => {
    const info = sanitizeAgentExecutionInfo(
      {
        nodeId: 'local',
        executionId: 'ws:p1',
        effectiveCwd: '/tmp/work',
        controls: { steer: { pluginId: ' builtin:herdr ', actionId: 'steer' } },
      },
      ctx,
    )
    assert.deepEqual(info.controls, { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } })
    // 克隆：改写回传源不影响已收敛结果。
    const source = { nodeId: 'local', executionId: 'ws:p1', controls: { steer: { pluginId: 'p', actionId: 'a' } } }
    const sanitized = sanitizeAgentExecutionInfo(source, ctx)
    source.controls!.steer!.pluginId = 'mutated'
    assert.equal(sanitized.controls?.steer?.pluginId, 'p')
  })

  it('孤立 controls 拒绝：缺 executionId 或缺 nodeId 均拒绝', timeout, () => {
    rejects(
      { executionId: 'ws:p1', controls: { steer: { pluginId: 'p', actionId: 'a' } } },
      'executionId + nodeId',
    )
    rejects(
      { nodeId: 'local', controls: { steer: { pluginId: 'p', actionId: 'a' } } },
      'executionId + nodeId',
    )
  })

  it('未知键拒绝（顶层与 steer 内）', timeout, () => {
    rejects(
      { nodeId: 'local', executionId: 'e', controls: { steer: { pluginId: 'p', actionId: 'a' }, abort: { pluginId: 'p' } } },
      'controls 未知字段 "abort"',
    )
    rejects(
      { nodeId: 'local', executionId: 'e', controls: { steer: { pluginId: 'p', actionId: 'a', extra: 1 } } },
      'controls.steer 未知字段 "extra"',
    )
  })

  it('非对象 / 空对象 / 坏坐标拒绝', timeout, () => {
    rejects({ nodeId: 'local', executionId: 'e', controls: null }, 'controls 必须是对象')
    rejects({ nodeId: 'local', executionId: 'e', controls: [] }, 'controls 必须是对象')
    rejects({ nodeId: 'local', executionId: 'e', controls: {} }, 'controls 至少包含 steer')
    rejects({ nodeId: 'local', executionId: 'e', controls: { steer: null } }, 'controls.steer 必须是对象')
    rejects({ nodeId: 'local', executionId: 'e', controls: { steer: { pluginId: '', actionId: 'a' } } }, '非空 trim 字符串')
    rejects({ nodeId: 'local', executionId: 'e', controls: { steer: { pluginId: 'p', actionId: '   ' } } }, '非空 trim 字符串')
    rejects({ nodeId: 'local', executionId: 'e', controls: { steer: { pluginId: 1, actionId: 'a' } } }, '非空 trim 字符串')
  })

  it('无 controls 的既有形状不受影响', timeout, () => {
    const info = sanitizeAgentExecutionInfo({ conversationId: 5 }, ctx)
    assert.equal(info.controls, undefined)
    assert.equal(info.conversationId, 5)
  })
})
