/**
 * session.snapshot 外部输入边界测试：
 * - panes[] 必需（全部本机窗格，含人类 shell）；
 * - pane_id / tab_id / workspace_id / focused / agent_status 严格校验（真实五态）；
 * - 可选 cwd / foreground_cwd / label / agent / title 若提供必须是字符串
 *   （允许空字符串，不允许 number / null——静默丢弃即伪造）；
 * - panes 或 agents 中重复 paneId 显式拒绝；
 * - shell 窗格只有 PaneInfo 无 AgentInfo：不虚构 stateChangeSeq。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HelmError } from '@helm/protocol'
import { parseSessionSnapshot } from '../src/builtin-plugins/herdr/rpc.js'

const okResult = (snapshot: Record<string, unknown>): Record<string, unknown> => ({
  type: 'session_snapshot',
  snapshot,
})

/** 真实 shell 窗格：只有 PaneInfo，无 state_change_seq，官方 agent_status 为 unknown。 */
const shellPane = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pane_id: 'w0:p1',
  workspace_id: 'w0',
  tab_id: 'w0:t1',
  focused: false,
  agent_status: 'unknown',
  ...over,
})

/** 完整 human agent 形状（AgentInfo 全字段）。 */
const humanAgent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pane_id: 'w1:p2',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  agent: 'claude',
  name: 'worker',
  agent_status: 'idle',
  state_change_seq: 7,
  launch_pending: false,
  interactive_ready: true,
  focused: true,
  cwd: '/root/code/helm',
  foreground_cwd: '/root/code/helm/packages',
  ...over,
})

const violation = (fn: () => unknown): void => {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HelmError, `应为 HelmError，实际：${String(e)}`)
    assert.equal(e.code, 'herdr_protocol_violation')
    return true
  })
}

test('完整快照可读：shell 窗格 + 完整 human agent；shell 不虚构 stateChangeSeq', { timeout: 60_000 }, () => {
  const data = parseSessionSnapshot(
    okResult({
      agents: [humanAgent()],
      panes: [
        shellPane(),
        {
          pane_id: 'w1:p2',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          focused: true,
          agent_status: 'idle',
          cwd: '/root/code/helm',
          foreground_cwd: '/root/code/helm/packages',
          label: 'worker',
          agent: 'claude',
          title: 'pi@helm',
        },
      ],
    }),
  )

  assert.equal(data.panes.length, 2)
  const shell = data.panes[0]
  assert.ok(shell)
  assert.equal(shell.paneId, 'w0:p1')
  assert.equal(shell.workspaceId, 'w0')
  assert.equal(shell.tabId, 'w0:t1')
  assert.equal(shell.focused, false)
  assert.equal(shell.agentStatus, 'unknown')
  // shell 只有 PaneInfo 无 AgentInfo：解析结果不得出现虚构的 seq。
  assert.equal('stateChangeSeq' in shell, false)

  const agentPane = data.panes[1]
  assert.ok(agentPane)
  assert.equal(agentPane.paneId, 'w1:p2')
  assert.equal(agentPane.cwd, '/root/code/helm')
  assert.equal(agentPane.foregroundCwd, '/root/code/helm/packages')
  assert.equal(agentPane.label, 'worker')
  assert.equal(agentPane.agent, 'claude')
  assert.equal(agentPane.title, 'pi@helm')

  assert.equal(data.agents.length, 1)
  const agent = data.agents[0]
  assert.ok(agent)
  assert.equal(agent.paneId, 'w1:p2')
  assert.equal(agent.agentStatus, 'idle')
  assert.equal(agent.stateChangeSeq, 7)
  assert.equal(agent.launchPending, false)
  assert.equal(agent.interactiveReady, true)
  assert.equal(agent.focused, true)
})

test('快照容器边界：缺 panes / 缺 agents / 非数组 / 错 type 显式拒绝', { timeout: 60_000 }, () => {
  // 非 session_snapshot type。
  violation(() => parseSessionSnapshot({ type: 'agent_info' }))
  // 缺 snapshot 对象。
  violation(() => parseSessionSnapshot({ type: 'session_snapshot' }))
  // 缺 panes（panes[] 必需——它是全部本机窗格的权威来源）。
  violation(() => parseSessionSnapshot(okResult({ agents: [] })))
  // 缺 agents。
  violation(() => parseSessionSnapshot(okResult({ panes: [] })))
  // panes / agents 非数组。
  violation(() => parseSessionSnapshot(okResult({ agents: [], panes: 'nope' })))
  violation(() => parseSessionSnapshot(okResult({ agents: {}, panes: [] })))
})

test('窗格行严格校验：必需字段缺失 / 非法五态 / 坏 focused 显式拒绝', { timeout: 60_000 }, () => {
  const badPanes: Array<unknown> = [
    // 非对象项。
    'not-a-pane',
    // 必需字段缺失 / 非非空字符串。
    shellPane({ pane_id: undefined }),
    shellPane({ workspace_id: '' }),
    shellPane({ tab_id: 42 }),
    // agent_status 必须是真实五态之一，未知值不得静默当 unknown。
    shellPane({ agent_status: 'running' }),
    shellPane({ agent_status: null }),
    shellPane({ agent_status: 3 }),
    // focused 必须是真实布尔。
    shellPane({ focused: 'true' }),
    shellPane({ focused: 1 }),
    shellPane({ focused: undefined }),
  ]
  for (const pane of badPanes) {
    violation(() => parseSessionSnapshot(okResult({ agents: [], panes: [pane] })))
  }
})

test('可选字符串字段：number / null 显式拒绝；空字符串如实保留', { timeout: 60_000 }, () => {
  const fields: Array<[string, 'cwd' | 'foregroundCwd' | 'label' | 'agent' | 'title']> = [
    ['cwd', 'cwd'],
    ['foreground_cwd', 'foregroundCwd'],
    ['label', 'label'],
    ['agent', 'agent'],
    ['title', 'title'],
  ]
  for (const [wire, out] of fields) {
    // 若提供必须是字符串：number / null 是协议违约，不得静默丢弃（丢弃即伪造）。
    for (const bad of [42, null]) {
      violation(() => parseSessionSnapshot(okResult({ agents: [], panes: [shellPane({ [wire]: bad })] })))
    }
    // 空字符串是合法字符串值：如实保留为 ''。
    const data = parseSessionSnapshot(okResult({ agents: [], panes: [shellPane({ [wire]: '' })] }))
    const pane = data.panes[0]
    assert.ok(pane)
    assert.equal(pane[out], '')
  }
})

test('重复 paneId 显式拒绝：panes 与 agents 均不允许', { timeout: 60_000 }, () => {
  // panes 中重复 paneId。
  violation(() =>
    parseSessionSnapshot(okResult({ agents: [], panes: [shellPane(), shellPane({ tab_id: 'w0:t2' })] })),
  )
  // agents 中重复 paneId。
  violation(() =>
    parseSessionSnapshot(
      okResult({ agents: [humanAgent(), humanAgent({ tab_id: 'w1:t9' })], panes: [shellPane()] }),
    ),
  )
})
