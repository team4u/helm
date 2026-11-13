/**
 * 后台启动的 workflow run（notifyParentOnSettle）通知与恢复语义测试。
 *
 * 覆盖（WorkflowService 层，确定性 fake host；subagent kind 的对应语义见
 * background-subagent.test.ts，此处同时守护其不回归）：
 * - run(notifyParentOnSettle:true)：结算后 onBackgroundAgentSettled 恰一次
 *   （kind=workflow、无 agentType/execution），notifiedAt 持久化，重开 init
 *   不重复补发；
 * - 同步 run（无 notify）：绝不通知；
 * - 通知失败：不推翻终态，notifiedAt 不置位，重启 init 按 outbox 补发恰一次；
 * - 进程重启恢复（后台 workflow running 记录）：prepareRecovery 收集其 nodes
 *   子会话先落 abort 标记，init 守卫中止这些子会话、标 failed(interrupted)
 *  （保留 resumeFromRunId 提示）并补发通知恰一次；
 * - 同步 workflow running 记录恢复语义不变：不守卫中止子会话、不通知。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { AgentExecutionInfo, WorkflowRunSummary } from '@helm/protocol'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

function makeStateStore(): WorkflowStateStore {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string, initial: T): T {
      return (map.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, JSON.parse(JSON.stringify(value)))
    },
  }
}

interface SettledCall {
  summary: WorkflowRunSummary
  parentConversationId: number
  agentType?: string
  execution?: AgentExecutionInfo
}

interface NotifyHost extends WorkflowServiceHost {
  settledCalls: SettledCall[]
  preparedIds: number[][]
  guardedAborts: number[]
  /** 前 N 次 onBackgroundAgentSettled 抛错（outbox 补发演练）。 */
  notifyFailTimes: number
}

function makeHost(): NotifyHost {
  const host: NotifyHost = {
    settledCalls: [],
    preparedIds: [],
    guardedAborts: [],
    notifyFailTimes: 0,
    async spawnAgent() {
      return '后台节点结果'
    },
    async prepareInterruptedConversations(ids) {
      host.preparedIds.push([...ids])
    },
    async invokeAction() {
      throw new Error('此测试不调用动作')
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      return {
        id,
        title: `conv-${id}`,
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp',
        model: 'x/y',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }
    },
    async abortConversationGuarded(id: number) {
      host.guardedAborts.push(id)
    },
    emitEvent() {},
    async onBackgroundAgentSettled(summary, info) {
      if (host.notifyFailTimes > 0) {
        host.notifyFailTimes--
        throw new Error('simulated notify failure')
      }
      host.settledCalls.push({ summary, ...info })
    },
  }
  return host
}

const AGENT_SCRIPT =
  'export const meta = { name: "bg-notify", description: "t" }\nreturn await agent("后台任务")'

describe('后台 workflow run 通知与恢复', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-bgnotify-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('notifyParentOnSettle：结算后恰一次通知（kind=workflow、无 agentType/execution），notifiedAt 持久，重开不补发', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    assert.equal(started.status, 'running')
    assert.equal(await service.wait(started.id), '后台节点结果')

    assert.equal(host.settledCalls.length, 1, '后台 workflow 结算后应恰通知一次')
    const call = host.settledCalls[0]!
    assert.equal(call.summary.id, started.id)
    assert.equal(call.summary.kind, 'workflow')
    assert.equal(call.summary.status, 'completed')
    assert.equal(call.parentConversationId, 1)
    assert.equal(call.agentType, undefined, 'workflow kind 通知不携带 agentType')
    assert.equal(call.execution, undefined, 'workflow kind 通知不携带 execution')

    const record = state.get<{ kind?: string; notifyParentOnSettle?: boolean; notifiedAt?: number } | null>(`workflow/run/${started.id}`, null)
    assert.equal(record!.kind, 'workflow')
    assert.equal(record!.notifyParentOnSettle, true)
    assert.ok(typeof record!.notifiedAt === 'number', 'notifiedAt 必须持久化')

    await service.close()
    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, '已通知的后台 workflow 不得重复补发')
    await reopened.close()
  })

  it('同步 run（无 notify）：不创建通知义务，onBackgroundAgentSettled 绝不触发', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT })
    await service.wait(started.id)
    assert.equal(service.getRun(started.id).status, 'completed')
    assert.equal(host.settledCalls.length, 0, '同步 run 不得触发父会话通知')
    const record = state.get<{ notifyParentOnSettle?: boolean } | null>(`workflow/run/${started.id}`, null)
    assert.equal(record!.notifyParentOnSettle, undefined)
    await service.close()
    await new WorkflowService({ dataDir, host, state }).init()
    assert.equal(host.settledCalls.length, 0)
  })

  it('通知失败不推翻终态：notifiedAt 不置位，重启 init 按 outbox 补发恰一次', timeout, async () => {
    const host = makeHost()
    host.notifyFailTimes = 1
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    await service.wait(started.id)
    assert.equal(service.getRun(started.id).status, 'completed', '通知失败不得推翻终态')
    assert.equal(host.settledCalls.length, 0, '首次通知失败：未成功投递')
    const record = state.get<{ status: string; notifiedAt?: number } | null>(`workflow/run/${started.id}`, null)
    assert.equal(record!.status, 'completed')
    assert.equal(record!.notifiedAt, undefined)
    await service.close()

    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, 'init 应按 outbox 补发恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = state.get<{ notifiedAt?: number } | null>(`workflow/run/${started.id}`, null)
    assert.ok(typeof after!.notifiedAt === 'number')
    await reopened.close()

    const again = new WorkflowService({ dataDir, host, state })
    await again.init()
    assert.equal(host.settledCalls.length, 1, '已补发后不得再次投递')
    await again.close()
  })

  it('重启恢复（后台 workflow running）：prepareRecovery 标记子会话、init 守卫中止、failed(interrupted) 保留 resume 提示并补发通知', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_bgdead000001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_bgdead000001', conversationId: 1, createdAt: 1 }])
    state.set('workflow/run/wf_bgdead000001', {
      id: 'wf_bgdead000001',
      name: 'bg-notify',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      kind: 'workflow',
      notifyParentOnSettle: true,
      journalPath,
      nodes: [
        { id: 'agent-0', kind: 'agent', label: '后台任务', status: 'running', startedAt: 1, conversationId: 77 },
      ],
    })
    const service = new WorkflowService({ dataDir, host, state })
    await service.prepareRecovery()
    assert.deepEqual(
      host.preparedIds.map((ids) => [...ids].sort()),
      [[77]],
      'prepareRecovery 必须收集后台 workflow 的 nodes 子会话并先落 abort 标记',
    )
    await service.init()
    const summary = service.getRun('wf_bgdead000001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resumeFromRunId'), '后台 workflow 中断须保留账本恢复提示')
    assert.deepEqual(host.guardedAborts, [77], 'init 必须守卫中止后台 workflow 的在途子会话')
    assert.ok(summary.nodes?.every((n) => n.status === 'failed'), '中断节须如实标 failed')
    assert.equal(host.settledCalls.length, 1, '中断的后台 workflow 须补发通知恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    const record = state.get<{ notifiedAt?: number } | null>('workflow/run/wf_bgdead000001', null)
    assert.ok(typeof record!.notifiedAt === 'number')
    await service.close()
  })

  it('重启恢复（同步 workflow running）：不守卫中止子会话、不通知（原有语义不回归）', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_syncdead0001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_syncdead0001', conversationId: 1, createdAt: 1 }])
    state.set('workflow/run/wf_syncdead0001', {
      id: 'wf_syncdead0001',
      name: 'sync',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath,
      nodes: [
        { id: 'agent-0', kind: 'agent', label: '同步任务', status: 'running', startedAt: 1, conversationId: 88 },
      ],
    })
    const service = new WorkflowService({ dataDir, host, state })
    await service.prepareRecovery()
    assert.deepEqual(host.preparedIds, [], '同步 workflow 不参与子会话 abort 预标记')
    await service.init()
    assert.equal(service.getRun('wf_syncdead0001').status, 'failed')
    assert.ok(service.getRun('wf_syncdead0001').error?.includes('resumeFromRunId'))
    assert.deepEqual(host.guardedAborts, [], '同步 workflow 中断不守卫中止子会话（账本恢复语义）')
    assert.equal(host.settledCalls.length, 0, '同步 workflow 中断不通知父会话')
    await service.close()
  })
})
