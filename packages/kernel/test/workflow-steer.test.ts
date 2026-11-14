/**
 * builtin:workflow 后台子代理安全插话（steer）测试（tsx --test，确定性 fake）。
 *
 * 覆盖：
 * - 纯逻辑 steerBackgroundSubagent：caller → run → child 授权证明链
 *   （kind/status/取消窗口/无子会话/节点非 running/歧义/跨树 caller/
 *   血统不一致/human 归属/kernel 守卫冲突透传/入参边界）与提交参数
 *   （origin=agent、whenBusy=steer、meta 溯源、ownership+CAS 水位守卫）；
 * - 外部执行委托：controls.steer 动态路由（零硬编码插件 ID）、标准委托输入
 *   （executionId/nodeId/workflowRunId/parentConversationId/text）、原 context
 *   透传（含 signal）、混合 native+external 歧义拒绝、坏产物逐字段拒绝、
 *   委托插件不可用原样透传、非幂等（失败不自动重试）；
 * - isAncestorOrSelf：自身/祖先/环/断链/深度上限；
 * - 插件级端到端：真实 createWorkflowPlugin 注册 + 真实 WorkflowService 后台
 *   run，经 host.invokeAction 与 exposeAsTool 派生工具插话成功；manifest
 *   （exposeAsTool / CLI 命令 / oneOf 输出）冒烟；跨树会话调用拒绝。
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  WORKFLOW_PLUGIN_ID,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type ConversationSummary,
  type MaybePromise,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { steerBackgroundSubagent, parseExternalSteerResult } from '../src/builtin-plugins/workflow/steer.js'
import { isAncestorOrSelf } from '../src/builtin-plugins/lineage.js'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createHelm } from '../src/app.js'
import { waitFor } from './helpers.js'
import { actionToolAlias } from '../src/plugins/capability-registry.js'
import { PluginHost, type PluginDocStore } from '../src/plugins/index.js'
import { PluginHostBackendFixtureBase } from './helpers/plugin-host-backend.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// 纯逻辑 fixtures
// ---------------------------------------------------------------------------

interface RecordedSteer {
  conversationId: number
  text: string
  opts: Record<string, unknown>
  guard: Record<string, unknown>
}

interface RecordedDelegation {
  pluginId: string
  actionId: string
  input: Record<string, unknown>
  context: { conversationId?: number; signal?: AbortSignal }
}

interface PurePorts {
  runs: Map<string, WorkflowRunSummary>
  conversations: Map<number, ConversationSummary>
  ownership: Map<number, 'helm' | 'bot' | 'human'>
  cancelling: Set<number>
  submitted: RecordedSteer[]
  delegations: RecordedDelegation[]
  /** 可编程 submitInputGuarded 行为（缺省成功）。 */
  submitBehavior?: (call: RecordedSteer) => void
  /** 可编程外部委托行为（缺省返回合法 ExternalSteerResult）。 */
  invokeBehavior?: (call: RecordedDelegation) => unknown
}

function conv(id: number, parent: number | undefined, seq = 7): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
    cwd: '/tmp',
    model: 'x/y',
    thinkingLevel: '',
    status: 'working',
    stateChangeSeq: seq,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function subagentRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_run0000000001',
    name: 'subagent:worker',
    conversationId: 1,
    kind: 'subagent',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    nodes: [{ id: 'subagent-0', kind: 'agent', label: 'subagent:worker', status: 'running', conversationId: 42 }],
    ...over,
  }
}

/** 外部 herdr 形态的 run 节点（controls.steer + executionId + nodeId）。 */
function externalRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return subagentRun({
    nodes: [
      {
        id: 'subagent-0',
        kind: 'agent',
        label: 'subagent:herdr:agy',
        status: 'running',
        nodeId: 'local',
        executionId: 'ws:p9',
        controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } },
      },
    ],
    ...over,
  })
}

function makePurePorts(): PurePorts {
  return {
    runs: new Map(),
    conversations: new Map([
      [1, conv(1, undefined, 3)],
      [2, conv(2, undefined, 5)],
      [10, conv(10, 1, 4)],
      [42, conv(42, 1, 7)],
    ]),
    ownership: new Map([[42, 'helm']]),
    cancelling: new Set(),
    submitted: [],
    delegations: [],
  }
}

function portsOf(p: PurePorts) {
  return {
    getRun(runId: string): WorkflowRunSummary {
      const run = p.runs.get(runId)
      if (run === undefined) throw new HelmError('not_found', `工作流运行不存在: ${runId}`, 404, { runId })
      return run
    },
    isConversationCancelling: (id: number) => p.cancelling.has(id),
    getConversation(id: number): ConversationSummary {
      const found = p.conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    getConversationOwnership(id: number): 'helm' | 'bot' | 'human' {
      return p.ownership.get(id) ?? 'human'
    },
    async submitInputGuarded(
      conversationId: number,
      text: string,
      opts: Record<string, unknown>,
      guard: Record<string, unknown>,
    ): Promise<unknown> {
      const call = { conversationId, text, opts, guard }
      p.submitBehavior?.(call)
      p.submitted.push(call)
      return { submissionId: 's-1' }
    },
    async invokeAction(
      pluginId: string,
      actionId: string,
      input: unknown,
      context?: { conversationId?: number; signal?: AbortSignal },
    ): Promise<unknown> {
      const call = { pluginId, actionId, input: input as Record<string, unknown>, context: context ?? {} }
      const result = p.invokeBehavior !== undefined ? p.invokeBehavior(call) : {
        steered: true as const,
        executionId: 'ws:p9',
        nodeId: 'local',
        stateChangeSeq: 12,
        ownership: 'helm' as const,
        guardLevel: 'cas' as const,
      }
      if (result instanceof HelmError || result instanceof Error) throw result
      p.delegations.push(call)
      return result
    },
  }
}

async function rejectsWith(
  fn: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<HelmError> {
  let caught: unknown
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof HelmError, `应抛 HelmError（实际 ${String(caught)}）`)
  assert.equal(caught.code, code, `错误码应为 ${code}（实际 ${caught.code}: ${caught.message}）`)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

// ---------------------------------------------------------------------------
// 纯逻辑：steerBackgroundSubagent（原生路径）
// ---------------------------------------------------------------------------

describe('steerBackgroundSubagent 纯逻辑（原生路径）', () => {
  it('成功插话：run 发起会话为 caller，提交参数与守卫事实完整', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    p.ownership.set(42, 'bot')
    const out = await steerBackgroundSubagent(
      portsOf(p),
      { runId: 'wf_run0000000001', text: '  请优先补测试  ' },
      { conversationId: 1 },
    )
    assert.deepEqual(out, {
      steered: true,
      runId: 'wf_run0000000001',
      targetKind: 'native',
      conversationId: 42,
      ownership: 'bot',
      stateChangeSeq: 7,
      guardLevel: 'cas',
    })
    assert.equal(p.submitted.length, 1)
    const call = p.submitted[0]!
    assert.equal(call.conversationId, 42)
    assert.ok(call.text.includes('请优先补测试'), '插话文本原样保留（trim 后）')
    assert.ok(call.text.includes('wf_run0000000001'), '插话文本附运行来源前缀')
    assert.deepEqual(call.opts, {
      origin: 'agent',
      whenBusy: 'steer',
      whenIdle: 'reject',
      meta: { kind: 'subagent_steer', runId: 'wf_run0000000001' },
    })
    assert.deepEqual(call.guard, { expectedOwnership: 'bot', expectedStateSeq: 7 })
    assert.equal(p.delegations.length, 0, '原生路径不得触发外部委托')
  })

  it('无会话上下文（人工 HTTP/CLI）放行；caller 为 run 发起会话的祖先放行', timeout, async () => {
    const p = makePurePorts()
    // run 由 10 发起（10 的父是 1）：1 是祖先，可插话。
    p.runs.set('wf_run0000000001', subagentRun({ conversationId: 10, nodes: [{ id: 'subagent-0', kind: 'agent', label: 'x', status: 'running', conversationId: 42 }] }))
    // 血统：42 → 10 → 1。当前 fixture 中 42 的父是 1，先改挂 10。
    p.conversations.set(42, conv(42, 10, 7))
    await steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'ok' }, {})
    assert.equal(p.submitted.length, 1)
    await steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'ok' }, { conversationId: 1 })
    assert.equal(p.submitted.length, 2)
  })

  it('kind 非 subagent（DSL 工作流）显式拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_dsl', subagentRun({ kind: undefined }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_dsl', text: 'x' }, {}),
      'steer_unsupported_run',
      400,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('非 running 终态拒绝；级联取消窗口拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_done', subagentRun({ status: 'completed' }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_done', text: 'x' }, {}),
      'steer_run_not_running',
      409,
    )
    p.runs.set('wf_c', subagentRun())
    p.cancelling.add(1)
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_c', text: 'x' }, {}),
      'steer_run_cancelling',
      409,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('无可插话目标（外部执行未回传控制引用 / 未就绪）拒绝；节点非 running 拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', subagentRun({ nodes: [{ id: 'subagent-0', kind: 'agent', label: 'x', status: 'running', executionId: 'herdr:pane-7', nodeId: 'local' }] }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, {}),
      'steer_no_steerable_target',
      409,
    )
    p.runs.set('wf_settling', subagentRun({ nodes: [{ id: 'subagent-0', kind: 'agent', label: 'x', status: 'done', conversationId: 42 }] }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_settling', text: 'x' }, {}),
      'steer_subagent_not_running',
      409,
    )
    assert.equal(p.submitted.length, 0)
    assert.equal(p.delegations.length, 0)
  })

  it('run 仍 running 但子会话已结束（Gate 在途），拒绝启动额外回合', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    for (const status of ['idle', 'done', 'error'] as const) {
      p.conversations.set(42, { ...conv(42, 1), status })
      await rejectsWith(
        () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: '调整方案' }, { conversationId: 1 }),
        'steer_subagent_not_running',
        409,
      )
    }
    assert.equal(p.submitted.length, 0)
  })

  it('子会话自身处于取消边界时拒绝插话', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    p.cancelling.add(42)
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: '调整方案' }, { conversationId: 1 }),
      'steer_run_cancelling',
      409,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('父链读取的真实 IO 错误透传', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    const ports = portsOf(p)
    const failure = new Error('state store read failed')
    ports.getConversation = () => { throw failure }
    await assert.rejects(
      steerBackgroundSubagent(ports, { runId: 'wf_run0000000001', text: '调整方案' }, { conversationId: 2 }),
      (error: unknown) => error === failure,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('多个在途子会话歧义拒绝（防御）', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_multi', subagentRun({
      nodes: [
        { id: 'a', kind: 'agent', label: 'x', status: 'running', conversationId: 42 },
        { id: 'b', kind: 'agent', label: 'y', status: 'running', conversationId: 10 },
      ],
    }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_multi', text: 'x' }, {}),
      'steer_ambiguous_subagent',
      409,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('跨树 caller 拒绝：兄弟会话 / 无关会话 / run 后代（含子会话自身）均无权', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    // 2 与 run 发起会话 1 无祖先关系。
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, { conversationId: 2 }),
      'steer_out_of_scope',
      403,
    )
    // 42 是 run 的子会话（发起会话 1 的后代），不是祖先，无权。
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, { conversationId: 42 }),
      'steer_out_of_scope',
      403,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('子会话血统不可达 run 发起会话（记录漂移/伪装）拒绝', timeout, async () => {
    const p = makePurePorts()
    // 42 改挂到无关会话 2 之下：父链 42 → 2，不含 run 发起会话 1。
    p.conversations.set(42, conv(42, 2, 7))
    p.runs.set('wf_run0000000001', subagentRun())
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, {}),
      'steer_lineage_mismatch',
      403,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('human 归属红线拒绝且不提交；bot/helm 之外按 human 处理', timeout, async () => {
    const p = makePurePorts()
    p.ownership.set(42, 'human')
    p.runs.set('wf_run0000000001', subagentRun())
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, {}),
      'steer_human_owned',
      403,
    )
    // 缺省归属（未标记）一律按 human。
    p.ownership.delete(42)
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, {}),
      'steer_human_owned',
      403,
    )
    assert.equal(p.submitted.length, 0)
  })

  it('内核守卫冲突（state_seq_conflict / ownership_conflict）原样透传', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    p.submitBehavior = () => {
      throw new HelmError('state_seq_conflict', '会话 42 权威水位 8 与期望 7 不一致', 409, {
        conversationId: 42,
        currentSeq: 8,
        expectedSeq: 7,
      })
    }
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, {}),
      'state_seq_conflict',
      409,
    )
  })

  it('run 不存在 / 子会话已删除 not_found 透传；空白入参显式拒绝', timeout, async () => {
    const ports = portsOf(makePurePorts())
    await rejectsWith(() => steerBackgroundSubagent(ports, { runId: 'wf_missing', text: 'x' }, {}), 'not_found', 404)
    const p = makePurePorts()
    p.runs.set('wf_run0000000001', subagentRun())
    p.conversations.delete(42)
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: 'x' }, {}),
      'not_found',
      404,
    )
    p.conversations.set(42, conv(42, 1, 7))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_run0000000001', text: '   ' }, {}),
      'validation_error',
      400,
    )
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: '', text: 'x' }, {}),
      'validation_error',
      400,
    )
  })
})

// ---------------------------------------------------------------------------
// 纯逻辑：steerBackgroundSubagent（外部执行委托路径）
// ---------------------------------------------------------------------------

describe('steerBackgroundSubagent 纯逻辑（外部委托路径）', () => {
  it('成功委托：标准输入完整、原 context（含 signal）透传、联合结果可辨识', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    const signal = AbortSignal.abort()
    const out = await steerBackgroundSubagent(
      portsOf(p),
      { runId: 'wf_ext', text: '改用方案B' },
      { conversationId: 1, signal },
    )
    assert.deepEqual(out, {
      steered: true,
      runId: 'wf_ext',
      targetKind: 'external',
      executionId: 'ws:p9',
      nodeId: 'local',
      ownership: 'helm',
      stateChangeSeq: 12,
      guardLevel: 'cas',
    })
    assert.equal(p.delegations.length, 1)
    const call = p.delegations[0]!
    assert.equal(call.pluginId, 'builtin:herdr', '委托目标完全来自记录（零硬编码路由）')
    assert.equal(call.actionId, 'steer')
    assert.deepEqual(call.input, {
      executionId: 'ws:p9',
      nodeId: 'local',
      workflowRunId: 'wf_ext',
      parentConversationId: 1,
      text: '改用方案B',
    })
    assert.equal(call.context.conversationId, 1, '原 caller 上下文透传（不伪造）')
    assert.equal(call.context.signal, signal, '取消信号透传到委托动作')
    assert.equal(p.submitted.length, 0, '外部路径不得触发原生子会话提交')
  })

  it('外部 preflight 结果如实透传，不能升级标记为 CAS', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    p.invokeBehavior = () => ({
      steered: true, executionId: 'ws:p9', nodeId: 'local',
      stateChangeSeq: 17, ownership: 'helm', guardLevel: 'preflight',
    })
    const out = await steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: '补充指导' }, { conversationId: 1 })
    assert.equal(out.targetKind, 'external')
    assert.equal(out.guardLevel, 'preflight')
    assert.equal(out.stateChangeSeq, 17)
    assert.equal(p.delegations.length, 1)
    assert.equal(p.submitted.length, 0)
  })

  it('人工 HTTP/CLI（无会话上下文）可委托外部执行', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    await steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'ok' }, {})
    assert.equal(p.delegations.length, 1)
    assert.equal(p.delegations[0]!.context.conversationId, undefined)
  })

  it('跨树 caller 对外部执行同样拒绝（委托前授权）', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, { conversationId: 2 }),
      'steer_out_of_scope',
      403,
    )
    assert.equal(p.delegations.length, 0)
  })

  it('run 取消窗口内拒绝外部委托', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    p.cancelling.add(1)
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, {}),
      'steer_run_cancelling',
      409,
    )
    assert.equal(p.delegations.length, 0)
  })

  it('混合 native + external 候选歧义拒绝（不优先 native 吞掉 external）', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_mixed', subagentRun({
      nodes: [
        { id: 'a', kind: 'agent', label: 'native', status: 'running', conversationId: 42 },
        {
          id: 'b', kind: 'agent', label: 'herdr', status: 'running', nodeId: 'local', executionId: 'ws:p9',
          controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } },
        },
      ],
    }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_mixed', text: 'x' }, {}),
      'steer_ambiguous_subagent',
      409,
    )
    assert.equal(p.submitted.length, 0)
    assert.equal(p.delegations.length, 0)
  })

  it('同一节点同时登记原生子会话与外部控制引用：歧义拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_both', subagentRun({
      nodes: [
        {
          id: 'a', kind: 'agent', label: 'both', status: 'running', conversationId: 42,
          nodeId: 'local', executionId: 'ws:p9',
          controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } },
        },
      ],
    }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_both', text: 'x' }, {}),
      'steer_ambiguous_subagent',
      409,
    )
    assert.equal(p.submitted.length, 0)
    assert.equal(p.delegations.length, 0)
  })

  it('多个外部候选歧义拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_multi-ext', externalRun({
      nodes: [
        { id: 'a', kind: 'agent', label: 'x', status: 'running', nodeId: 'local', executionId: 'ws:p1', controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } },
        { id: 'b', kind: 'agent', label: 'y', status: 'running', nodeId: 'local', executionId: 'ws:p2', controls: { steer: { pluginId: 'builtin:herdr', actionId: 'steer' } } },
      ],
    }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_multi-ext', text: 'x' }, {}),
      'steer_ambiguous_subagent',
      409,
    )
    assert.equal(p.delegations.length, 0)
  })

  it('controls.steer 引用非法（空 pluginId/actionId）：显式拒绝', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_badref', externalRun({
      nodes: [{
        id: 'subagent-0', kind: 'agent', label: 'x', status: 'running', nodeId: 'local', executionId: 'ws:p9',
        controls: { steer: { pluginId: '   ', actionId: 'steer' } },
      }],
    }))
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_badref', text: 'x' }, {}),
      'steer_delegate_invalid',
      502,
    )
    assert.equal(p.delegations.length, 0)
  })

  it('委托产物核销：steered/executionId/nodeId/ownership/guardLevel/seq 逐字段拒绝', timeout, async () => {
    const bad: Array<[string, unknown]> = [
      ['steered 非 true', { steered: false, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1, ownership: 'helm', guardLevel: 'cas' }],
      ['executionId 不一致', { steered: true, executionId: 'ws:other', nodeId: 'local', stateChangeSeq: 1, ownership: 'helm', guardLevel: 'cas' }],
      ['nodeId 不一致', { steered: true, executionId: 'ws:p9', nodeId: 'node-x', stateChangeSeq: 1, ownership: 'helm', guardLevel: 'cas' }],
      ['ownership 非 helm', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1, ownership: 'bot', guardLevel: 'cas' }],
      ['guardLevel 非法', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1, ownership: 'helm', guardLevel: 'none' }],
      ['guardLevel 缺失', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1, ownership: 'helm' }],
      ['seq 负数', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: -1, ownership: 'helm', guardLevel: 'cas' }],
      ['seq 非整数', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1.5, ownership: 'helm', guardLevel: 'cas' }],
      ['seq 缺失', { steered: true, executionId: 'ws:p9', nodeId: 'local', ownership: 'helm', guardLevel: 'cas' }],
      ['未知字段', { steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 1, ownership: 'helm', guardLevel: 'cas', extra: 1 }],
      ['非对象', null],
    ]
    for (const [reason, payload] of bad) {
      const p = makePurePorts()
      p.runs.set('wf_ext', externalRun())
      p.invokeBehavior = () => payload
      await rejectsWith(
        () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, {}),
        'steer_delegate_invalid',
        502,
      )
      assert.equal(p.submitted.length, 0, `${reason}：不产生原生提交`)
    }
  })

  it('委托插件不可用（unknown_action 等）原样透传，绝不重试或伪造成功', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    let attempts = 0
    p.invokeBehavior = () => {
      attempts += 1
      throw new HelmError('unknown_action', "插件 builtin:herdr 未声明动作 steer（插件停用或能力缺失）", 404, {
        pluginId: 'builtin:herdr', actionId: 'steer',
      })
    }
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, {}),
      'unknown_action',
      404,
    )
    assert.equal(attempts, 1, '控制动作非幂等：单次失败后不自动重试')
  })

  it('委托超时/断线真实错误透传且不重试', timeout, async () => {
    const p = makePurePorts()
    p.runs.set('wf_ext', externalRun())
    let attempts = 0
    p.invokeBehavior = () => {
      attempts += 1
      throw new HelmError('herdr_timeout', 'prompt 响应超时（投递结果不确定）', 504)
    }
    await rejectsWith(
      () => steerBackgroundSubagent(portsOf(p), { runId: 'wf_ext', text: 'x' }, {}),
      'herdr_timeout',
      504,
    )
    assert.equal(attempts, 1)
  })
})

describe('parseExternalSteerResult（独立边界校验）', () => {
  const expected = { executionId: 'ws:p9', nodeId: 'local', pluginId: 'p', actionId: 'a' }
  it('合法产物通过并提取水位', timeout, () => {
    assert.deepEqual(
      parseExternalSteerResult({ steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 3, ownership: 'helm', guardLevel: 'cas' }, expected),
      { stateChangeSeq: 3, guardLevel: 'cas' },
    )
  })
  it('preflight 产物通过且保留预检级别', timeout, () => {
    assert.deepEqual(
      parseExternalSteerResult({ steered: true, executionId: 'ws:p9', nodeId: 'local', stateChangeSeq: 4, ownership: 'helm', guardLevel: 'preflight' }, expected),
      { stateChangeSeq: 4, guardLevel: 'preflight' },
    )
  })
  it('坏产物显式拒绝', timeout, () => {
    assert.throws(() => parseExternalSteerResult(undefined, expected), HelmError)
    assert.throws(() => parseExternalSteerResult([], expected), HelmError)
    assert.throws(() => parseExternalSteerResult({ steered: 'true' }, expected), HelmError)
  })
})

// ---------------------------------------------------------------------------
// 纯逻辑：isAncestorOrSelf
// ---------------------------------------------------------------------------

describe('isAncestorOrSelf', () => {
  const parents = new Map<number, number>([
    [3, 2],
    [2, 1],
  ])
  const parentOf = (id: number) => parents.get(id)

  it('自身与祖先命中；无关与断链不命中', timeout, () => {
    assert.equal(isAncestorOrSelf(3, 3, parentOf), true)
    assert.equal(isAncestorOrSelf(3, 1, parentOf), true, '1 是 3 的祖父')
    assert.equal(isAncestorOrSelf(3, 9, parentOf), false, '无关会话')
    assert.equal(isAncestorOrSelf(1, 3, parentOf), false, '方向不可颠倒（后代不是祖先）')
    assert.equal(isAncestorOrSelf(9, 1, parentOf), false, '起点父链缺失即断链')
  })

  it('父链环不死循环；深度上限按不可证明处理', timeout, () => {
    const cyclic = new Map<number, number>([
      [5, 6],
      [6, 5],
    ])
    assert.equal(isAncestorOrSelf(5, 7, (id) => cyclic.get(id)), false)
    assert.equal(isAncestorOrSelf(5, 1, () => 2, 3), false, '超深度上限安全终止')
  })
})

// ---------------------------------------------------------------------------
// 插件级端到端（真实 createWorkflowPlugin + 真实 WorkflowService）
// ---------------------------------------------------------------------------

class SteerFakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>()
  ownership = new Map<number, string>()
  submitted: RecordedSteer[] = []
  spawnRequests: AgentSpawnRequest[] = []
  /** 提交前钩子：模拟探针与提交之间的事实变化（如人类按键推进水位）。 */
  onBeforeGuardedSubmit: (() => void) | undefined

  constructor() {
    super()
    this.conversations.set(1, conv(1, undefined, 3))
    this.conversations.set(2, conv(2, undefined, 5))
    this.conversations.set(42, conv(42, 1, 7))
    this.ownership.set(42, 'bot')
  }

  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    this.spawnRequests.push(request)
    // 模拟原生子会话执行行：onResolved 回传真实子会话后挂起，
    // 直到引擎 abort 信号才取消（与真实 spawn 行为一致）。
    request.onResolved?.({ conversationId: 42, executionId: 'exec-42', effectiveCwd: '/tmp' } satisfies AgentExecutionInfo)
    return new Promise((_resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new HelmError('aborted', '子代理执行被取消', 409))
        return
      }
      request.signal?.addEventListener('abort', () => reject(new HelmError('aborted', '子代理执行被取消', 409)), { once: true })
    })
  }

  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()]
  }

  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
    return found
  }

  getConversationOwnership(id: number): 'helm' | 'bot' | 'human' {
    return (this.ownership.get(id) ?? 'human') as 'helm' | 'bot' | 'human'
  }

  // 注意：宿主 host-api 对 guarded 端口采用解绑调用（const port = backend
  // .submitInputGuarded），类原型方法会丢失 this——必须用箭头函数属性。
  submitInputGuarded = (
    ...args: Parameters<PluginHostBackendFixtureBase['submitInputGuarded']>
  ): ReturnType<PluginHostBackendFixtureBase['submitInputGuarded']> => {
    const [conversationId, text, opts, guard] = args
    // 模拟内核提交点原子复核：同步、零 await，事实不匹配即无副作用拒绝。
    this.onBeforeGuardedSubmit?.()
    const current = this.conversations.get(conversationId)
    if (current === undefined) {
      return Promise.reject(new HelmError('not_found', `会话不存在：${conversationId}`, 404, { conversationId }))
    }
    const ownedBy = this.getConversationOwnership(conversationId)
    if (ownedBy === 'human' || guard?.expectedOwnership !== ownedBy) {
      return Promise.reject(
        new HelmError('ownership_conflict', `会话 ${conversationId} 当前归属 ${ownedBy}，拒绝自动化变更`, 409, {
          conversationId,
          currentOwnership: ownedBy,
        }),
      )
    }
    if (guard?.expectedStateSeq !== current.stateChangeSeq) {
      return Promise.reject(
        new HelmError('state_seq_conflict', `会话 ${conversationId} 权威水位与期望不一致`, 409, {
          conversationId,
          currentSeq: current.stateChangeSeq,
          expectedSeq: guard?.expectedStateSeq,
        }),
      )
    }
    this.submitted.push({ conversationId, text, opts: opts as Record<string, unknown>, guard: guard as Record<string, unknown> })
    return Promise.resolve()
  }

  submitInput(): Promise<void> {
    return Promise.resolve()
  }

  abortConversationGuarded(): Promise<void> {
    return Promise.resolve()
  }

  prepareInterruptedConversations(): Promise<void> {
    return Promise.resolve()
  }

  invokeAction(): Promise<unknown> {
    return Promise.resolve({})
  }

  listActions(): never[] {
    return []
  }

  onEvent(): () => void {
    return () => {}
  }

  emitEvent(): MaybePromise<void> {}
}

class MemoryDocStore implements PluginDocStore {
  private store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

class MemorySessionDocStore {
  private store = new Map<string, string>()
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    this.store.delete(`${pluginId}\0${name}\0${conversationId}`)
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }
  listConversationIds(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of [...this.store.keys()]) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const id = Number(key.split('\0')[2])
      if (Number.isSafeInteger(id) && id > 0) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  async flush(): Promise<void> {}
}

describe('workflow 插件 steer 动作（端到端）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-steer-e2e-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  async function setup(): Promise<{ host: PluginHost; backend: SteerFakeBackend; runId: string }> {
    const backend = new SteerFakeBackend()
    const host = new PluginHost({
      dataDir,
      host: backend,
      docs: new MemoryDocStore(),
      sessionDocs: new MemorySessionDocStore(),
    })
    const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
    await host.register(createWorkflowPlugin())
    const toolResult = (await host.executeTool(
      'subagent',
      { prompt: '后台慢任务', background: true },
      { conversationId: 1, callId: 'call-1' },
    )) as { structuredOutput?: { runId?: string } }
    const runId = toolResult.structuredOutput?.runId
    assert.ok(typeof runId === 'string' && runId !== '', `后台启动应返回 runId（实际 ${JSON.stringify(toolResult)}）`)
    return { host, backend, runId }
  }

  it('manifest 冒烟：exposeAsTool 直投、CLI 命令 workflows steer、oneOf 输出双分支', timeout, async () => {
    const backend = new SteerFakeBackend()
    const host = new PluginHost({
      dataDir,
      host: backend,
      docs: new MemoryDocStore(),
      sessionDocs: new MemorySessionDocStore(),
    })
    const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
    await host.register(createWorkflowPlugin())
    const manifest = host
      .listActions()
      .find((m) => m.pluginId === WORKFLOW_PLUGIN_ID && m.id === 'steer')
    assert.ok(manifest !== undefined, 'steer 动作应注册')
    assert.equal(manifest.exposeAsTool, true, 'steer 应 exposeAsTool 直投 Agent 工具')
    assert.deepEqual(manifest.cli?.command, ['workflows', 'steer'])
    assert.deepEqual(manifest.cli?.positional, [{ field: 'runId', required: true }])
    const oneOf = (manifest.outputSchema as { oneOf?: unknown[] }).oneOf
    assert.ok(Array.isArray(oneOf) && oneOf.length === 2, '输出 Schema 应为 native/external oneOf 双分支')
    await host.dispose()
  })

  it('发起会话经 invokeAction 插话成功：参数、溯源 meta 与 CAS 守卫事实完整', timeout, async () => {
    const { host, backend, runId } = await setup()
    const out = (await host.invokeAction(
      WORKFLOW_PLUGIN_ID,
      'steer',
      { runId, text: '优先修复失败的测试' },
      { conversationId: 1 },
    )) as Record<string, unknown>
    assert.deepEqual(out, {
      steered: true,
      runId,
      targetKind: 'native',
      conversationId: 42,
      ownership: 'bot',
      stateChangeSeq: 7,
      guardLevel: 'cas',
    })
    assert.equal(backend.submitted.length, 1)
    const call = backend.submitted[0]!
    assert.equal(call.conversationId, 42)
    assert.ok(call.text.includes('优先修复失败的测试'))
    assert.ok(call.text.includes(runId))
    assert.deepEqual(call.opts, {
      origin: 'agent',
      whenBusy: 'steer',
      whenIdle: 'reject',
      meta: { kind: 'subagent_steer', runId },
    })
    assert.deepEqual(call.guard, { expectedOwnership: 'bot', expectedStateSeq: 7 })
    await host.dispose()
  })

  it('exposeAsTool 派生工具双路径（全限定名与 provider-safe 别名）可达', timeout, async () => {
    const { host, backend, runId } = await setup()
    const alias = actionToolAlias(WORKFLOW_PLUGIN_ID, 'steer')
    for (const name of ['builtin:workflow.steer', alias]) {
      const out = (await host.executeTool(name, { runId, text: '换个思路' }, { conversationId: 1, callId: 'c2' })) as Record<string, unknown>
      assert.equal(out['steered'], true, `${name} 应解析到 steer 动作`)
      assert.equal(out['conversationId'], 42)
      assert.equal(out['targetKind'], 'native')
    }
    assert.equal(backend.submitted.length, 2)
    await host.dispose()
  })

  it('跨树会话（非发起会话自身/祖先）调用拒绝且不提交', timeout, async () => {
    const { host, backend, runId } = await setup()
    const err = await rejectsWith(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: 'x' }, { conversationId: 2 }),
      'steer_out_of_scope',
      403,
    )
    assert.ok(err.details !== undefined && (err.details as Record<string, unknown>)['callerConversationId'] === 2)
    assert.equal(backend.submitted.length, 0)
    await host.dispose()
  })

  it('子会话归属 human 时拒绝（红线），恢复 bot 后可插话', timeout, async () => {
    const { host, backend, runId } = await setup()
    backend.ownership.set(42, 'human')
    await rejectsWith(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: 'x' }, { conversationId: 1 }),
      'steer_human_owned',
      403,
    )
    assert.equal(backend.submitted.length, 0)
    backend.ownership.set(42, 'bot')
    const out = (await host.invokeAction(
      WORKFLOW_PLUGIN_ID,
      'steer',
      { runId, text: '继续' },
      { conversationId: 1 },
    )) as Record<string, unknown>
    assert.equal(out['steered'], true)
    await host.dispose()
  })

  it('事实过期（探针后水位被推进，如人类按键）时内核守卫冲突原样透传', timeout, async () => {
    const { host, backend, runId } = await setup()
    // 模拟探针（现读 seq=7）与提交点之间子会话事实推进：内核原子复核拦下。
    backend.onBeforeGuardedSubmit = () => {
      const child = backend.conversations.get(42)!
      backend.conversations.set(42, { ...child, stateChangeSeq: 9 })
    }
    await rejectsWith(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: 'x' }, { conversationId: 1 }),
      'state_seq_conflict',
      409,
    )
    assert.equal(backend.submitted.length, 0, '守卫拒绝不得产生提交副作用')
    await host.dispose()
  })

  it('run 已终态（abort 后）拒绝插话', timeout, async () => {
    const { host, backend, runId } = await setup()
    await host.invokeAction(WORKFLOW_PLUGIN_ID, 'abort', { runId })
    const final = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId })) as { run: { status: string } }
    assert.equal(final.run.status, 'aborted')
    await rejectsWith(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: 'x' }, { conversationId: 1 }),
      'steer_run_not_running',
      409,
    )
    assert.equal(backend.submitted.length, 0)
    await host.dispose()
  })
})

it('真实内核：在工具挂起期间纠偏，子代理读到新指令并将最终结果交回后台 run', timeout, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-steer-native-'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  let releaseTool!: () => void
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve })
  try {
    await app.kernel.plugins.register({
      id: 'test:steer-barrier',
      name: 'steer barrier',
      definePlugin(ctx) {
        ctx.tool({
          name: 'hold_for_steer',
          description: '等待本次测试放行',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() {
            await toolGate
            return { output: [{ type: 'text', text: '工具已放行' }] }
          },
        })
      },
    })
    let sawSteer = false
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_for_steer', {})], { stopReason: 'toolUse' }),
      (context) => {
        sawSteer = context.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('改用方案B'))
        return fauxAssistantMessage('已按方案B完成')
      },
      fauxAssistantMessage('主会话收到最终结果'),
    ])
    const started = await app.kernel.plugins.executeTool(
      'subagent',
      { prompt: '执行原方案' },
      { conversationId: 1, callId: 'native-steer' },
    ) as { structuredOutput: { runId: string; execution: { conversationId: number } } }
    const { runId, execution } = started.structuredOutput
    const childId = execution.conversationId
    await waitFor(() => app.kernel.getConversation(childId).doing?.startsWith('hold_for_steer:') === true)
    await app.kernel.plugins.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: '改用方案B' }, { conversationId: 1 })
    releaseTool()
    await app.kernel.waitForIdle(childId)
    await waitFor(async () => {
      const { run } = await app.kernel.plugins.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId }) as { run: WorkflowRunSummary }
      return run.status === 'completed'
    })
    const { run } = await app.kernel.plugins.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId }) as { run: WorkflowRunSummary }
    assert.equal(sawSteer, true, '子代理下一次模型调用应包含纠偏指令')
    assert.equal(run.result, '已按方案B完成')
    const detail = await app.kernel.getConversationDetail(childId)
    assert.ok(detail.entries.some((entry) => entry.kind === 'helm.input' && (entry.data as { meta?: { runId?: string } })?.meta?.runId === runId))
  } finally {
    releaseTool()
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
