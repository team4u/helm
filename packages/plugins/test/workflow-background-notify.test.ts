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
 * - 真实启动崩溃恢复（非手工 seed）：真实 WorkflowService.run 启动后台 workflow，
 *   挂起宿主在 onResolved 回报 conversationId 后永不返回——崩溃前 running 记录
 *   已即时持久 childConversationIds（nodes 尚未落盘），第二服务读同一 state 做
 *   prepareRecovery/init 按权威 IDs 标记、守卫中止并补发通知恰一次；
 * - 同步 workflow running 记录恢复语义：同样在 prepareRecovery 与 init 阶段
 *   守卫中止遗留原生子会话以防孤儿任务空跑，但依然绝不通知父会话。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/workflow/engine/service.js'
import { createBackgroundReporter, type BackgroundReporterDeps } from '../src/workflow/background.js'

const timeout = { timeout: 60_000 } as const

/**
 * 新契约读回 helper：完整体在 dataDir/artifacts/<convId>/workflow-<runId>.record.json
 * （本文件全部 run 均属会话 1）；records doc 只存轻量索引。
 */
function readRecord(dataDir: string, runId: string, conversationId = 1): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dataDir, 'artifacts', String(conversationId), `workflow-${runId}.record.json`), 'utf-8'),
  )
}

function seedRecord(dataDir: string, record: Record<string, unknown>): void {
  const dir = join(dataDir, 'artifacts', String(record['conversationId']))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `workflow-${String(record['id'])}.record.json`), JSON.stringify(record), 'utf8')
}

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
  guardedAborts: number[]
  /** 前 N 次 onBackgroundAgentSettled 抛错（outbox 补发演练）。 */
  notifyFailTimes: number
}

function makeHost(): NotifyHost {
  const host: NotifyHost = {
    settledCalls: [],
    guardedAborts: [],
    notifyFailTimes: 0,
    async spawnAgent() {
      return '后台节点结果'
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

    const record = readRecord(dataDir, started.id)
    assert.equal(record['kind'], 'workflow')
    assert.equal(record['notifyParentOnSettle'], true)
    assert.ok(typeof record['notifiedAt'] === 'number', 'notifiedAt 必须持久化')

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
    const record = readRecord(dataDir, started.id)
    assert.equal(record['notifyParentOnSettle'], undefined)
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
    const record = readRecord(dataDir, started.id)
    assert.equal(record['status'], 'completed')
    assert.equal(record['notifiedAt'], undefined)
    await service.close()

    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, 'init 应按 outbox 补发恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = readRecord(dataDir, started.id)
    assert.ok(typeof after['notifiedAt'] === 'number')
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
    state.set('workflow/runs', [{ id: 'wf_bgdead000001', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
    seedRecord(dataDir, {
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
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await service.prepareRecovery()
    assert.deepEqual(
      host.guardedAborts,
      [77],
      'prepareRecovery 必须收集后台 workflow 的 nodes 子会话并逐个守卫中止（paused 相位落持久 abort 标记）',
    )
    await service.init()
    const summary = service.getRun('wf_bgdead000001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resumeFromRunId'), '后台 workflow 中断须保留账本恢复提示')
    assert.deepEqual(host.guardedAborts, [77, 77], 'init 再次守卫中止同批子会话（调度器已恢复，等待真实终态）')
    assert.ok(summary.nodes?.every((n) => n.status === 'failed'), '中断节须如实标 failed')
    assert.equal(host.settledCalls.length, 1, '中断的后台 workflow 须补发通知恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    const record = readRecord(dataDir, 'wf_bgdead000001')
    assert.ok(typeof record['notifiedAt'] === 'number')
    await service.close()
  })

  it('真实启动崩溃恢复：onResolved 子会话即时持久，第二服务按权威 IDs 标记/守卫中止/补发通知', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    // 挂起宿主：真实宿主在子会话建立时经 onResolved 回报 conversationId=42，
    // 随后进程在 spawn 返回前崩溃（promise 永不 settle，不手工 seed 任何记录）。
    let resolveSpawned: () => void = () => {}
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve
    })
    host.spawnAgent = async (request) => {
      request.onResolved?.({ conversationId: 42 })
      resolveSpawned()
      await new Promise<never>(() => {})
    }
    const service = new WorkflowService({ dataDir, host, state })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    assert.equal(started.status, 'running')

    let failLate: (error: Error) => void = () => {}
    const watchdog = new Promise<never>((_, reject) => {
      failLate = reject
    })
    const timer = setTimeout(() => failLate(new Error('等待 host.spawnAgent onResolved 超时')), 5_000)
    timer.unref?.()
    try {
      await Promise.race([spawned, watchdog])
    } finally {
      clearTimeout(timer)
    }

    // 崩溃前事实：running 记录已持久权威子会话 IDs；nodes 尚未落盘（旧实现
    // 此处没有任何子会话坐标，重启恢复无从标记/中止——本用例守护的缺陷）。
    const crashed = readRecord(dataDir, started.id) as {
      status: string
      childConversationIds?: number[]
      nodes?: unknown
    }
    assert.equal(crashed.status, 'running')
    assert.deepEqual(crashed.childConversationIds, [42], 'onResolved 子会话必须在 running 记录中即时持久')
    assert.equal(crashed.nodes, undefined, '真实运行中 nodes 尚未落盘，恢复不得依赖它')

    // 模拟重启（autoRecoverOnRestart=false 回退路径）：第二个 WorkflowService 读同一 state 做恢复。
    const revived = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await revived.prepareRecovery()
    assert.deepEqual(host.guardedAborts, [42], 'prepareRecovery 必须按持久 IDs 逐个守卫中止（落持久 abort 标记）')
    await revived.init()
    assert.deepEqual(host.guardedAborts, [42, 42], 'init 再次守卫中止同批子会话（调度器已恢复，等待真实终态）')
    const summary = revived.getRun(started.id)
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resumeFromRunId'), '中断须保留账本恢复提示')
    assert.equal(host.settledCalls.length, 1, '中断的后台 run 须补发通知恰一次')
    assert.equal(host.settledCalls[0]!.summary.id, started.id)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    const record = readRecord(dataDir, started.id)
    assert.ok(typeof record['notifiedAt'] === 'number')

    // 清理：终止仍挂起的首服务（其结算不再影响以上事实断言）。
    await revived.close()
    await service.close()
  })

  it('重启恢复（同步 workflow running）：同样守卫中止遗留子会话以防孤儿，但绝不通知父会话', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_syncdead0001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_syncdead0001', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
    seedRecord(dataDir, {
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
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await service.prepareRecovery()
    assert.deepEqual(host.guardedAborts, [88], '同步 workflow 必须在 prepareRecovery 收集并标记子会话，防孤儿原生子会话继续运行')
    await service.init()
    const summary = service.getRun('wf_syncdead0001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('resumeFromRunId'))
    assert.deepEqual(host.guardedAborts, [88, 88], 'init 同样守卫中止同步 workflow 子会话')
    assert.ok(summary.nodes?.every((n) => n.status === 'failed'), '中断节点须如实标 failed')
    assert.equal(host.settledCalls.length, 0, '同步 workflow 中断依然绝不通知父会话')
    await service.close()
  })
})

// ---------------------------------------------------------------------------
// prepareRecovery 屏障失败注入：意外错误必须阻断（可重试）；确定性红线
// 拒绝（ownership_conflict = human 接管）与 not_found 可诊断跳过
// ---------------------------------------------------------------------------

/** 种子一条含两个子会话的后台 running run（索引入 state，完整体入文件）。 */
function seedTwoChildren(dataDir: string, state: WorkflowStateStore, runId: string): void {
  const now = Date.now()
  state.set('workflow/runs', [{ id: runId, conversationId: 1, status: 'running', createdAt: now, updatedAt: now }])
  seedRecord(dataDir, {
    id: runId,
    name: 'subagent:worker',
    conversationId: 1,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    kind: 'subagent',
    notifyParentOnSettle: true,
    journalPath: '/tmp/nonexistent.jsonl',
    nodes: [
      { id: 'subagent-0', kind: 'agent', label: 'subagent:worker', status: 'running', startedAt: now, conversationId: 31 },
      { id: 'subagent-1', kind: 'agent', label: 'subagent:worker', status: 'running', startedAt: now, conversationId: 32 },
    ],
    subagentMeta: { agentType: 'worker', execution: { nodeId: 'local', conversationId: 31 } },
  })
}

it('prepareRecovery 屏障：意外错误上抛且 recoveryPrepared 不置位（重试可恢复），绝不带未落标记启动', timeout, async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'wf-barrier-io-'))
  after(() => rmSync(barrierDir, { recursive: true, force: true }))
  const state = makeStateStore()
  seedTwoChildren(barrierDir, state, 'wf_barrier_io')
  const host = makeHost()
  const realAbort = host.abortConversationGuarded.bind(host)
  let failFirst = true
  host.abortConversationGuarded = async (id: number) => {
    if (failFirst && id === 31) throw new Error('simulated persistence IO failure')
    return realAbort(id)
  }
  const service = new WorkflowService({ dataDir: barrierDir, state, host })

  // 意外错误必须上抛：服务 prepare 失败 -> 宿主屏障阻断 start（调度器不 resume）。
  await assert.rejects(() => service.prepareRecovery(), /simulated persistence IO failure/)

  // 重试语义：失败注入解除后同一 service 再 prepare 成功（recoveryPrepared 未被置位）。
  failFirst = false
  host.guardedAborts.length = 0
  await service.prepareRecovery()
  assert.deepEqual(host.guardedAborts, [31, 32], '重试必须完整覆盖全部遗留子会话（不含错误期间未落标记的半程）')
})

it('prepareRecovery 容忍边界：ownership_conflict（human 接管）与 not_found 诊断跳过，其余子会话仍落标记', timeout, async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'wf-barrier-human-'))
  after(() => rmSync(barrierDir, { recursive: true, force: true }))
  const state = makeStateStore()
  seedTwoChildren(barrierDir, state, 'wf_barrier_human')
  const host = makeHost()
  const realAbort = host.abortConversationGuarded.bind(host)
  host.abortConversationGuarded = async (id: number) => {
    host.guardedAborts.push(id)
    // 31 号模拟内核 human 红线拒绝（human 绝不 abort）；32 号模拟会话已删除。
    if (id === 31) throw new HelmError('ownership_conflict', '会话 31 当前归属 human，拒绝自动化变更（human 红线）', 409, { conversationId: 31 })
    if (id === 32) throw new HelmError('not_found', '会话不存在：32', 404, { conversationId: 32 })
    return realAbort(id)
  }
  const service = new WorkflowService({ dataDir: barrierDir, state, host })
  await service.prepareRecovery()
  assert.deepEqual(host.guardedAborts, [31, 32], '两个子会话都尝试过守卫中止（human 由内核拒绝、已删会话 404），屏障不放行前先尝试')
})

// ---------------------------------------------------------------------------
// Background reports interject for every run kind and terminal status.
// ---------------------------------------------------------------------------

it('createBackgroundReporter 契约矩阵：kind × 终态（completed/failed/aborted）投递均 whenBusy=steer，requestId/meta 不变', timeout, async () => {
  interface RecordedSubmit {
    conversationId: number
    text: string
    opts: { origin: string; whenBusy: string; requestId: string; meta: Record<string, unknown> }
  }
  const submits: RecordedSubmit[] = []
  const deps: BackgroundReporterDeps = {
    getConversation: () => ({ id: 1 }),
    emitEvent: () => {},
    submitInput: async (conversationId, text, opts) => {
      submits.push({ conversationId, text, opts })
    },
    isConversationCancelling: () => false,
    listActiveRuns: () => [],
  }
  const reporter = createBackgroundReporter(deps)

  const kinds = ['subagent', 'workflow'] as const
  const statuses = ['completed', 'failed', 'aborted'] as const
  for (const kind of kinds) {
    for (const status of statuses) {
      const runId = `wf_matrix_${kind}_${status}`
      const run: WorkflowRunSummary = {
        id: runId,
        name: 'matrix',
        conversationId: 1,
        kind,
        status,
        createdAt: 1,
        updatedAt: 2,
        ...(status === 'completed' ? { result: { done: true } } : {}),
        ...(status === 'failed' ? { error: 'boom' } : {}),
        ...(status === 'aborted' ? { error: 'aborted by operator' } : {}),
      }
      await reporter.deliver(run, { parentConversationId: 1, ...(kind === 'subagent' ? { agentType: 'worker' } : {}) })
      const call = submits.at(-1)!
      assert.equal(call.opts.meta['backgroundRunId'], runId)
      assert.equal(call.opts.meta['kind'], `${kind}_report`)
      const report = JSON.parse(call.text.slice(call.text.indexOf('\n') + 1)) as { runId: string; status: string }
      assert.equal(report.runId, runId)
      assert.equal(report.status, status)
      assert.deepEqual(call.opts.meta['report'], report)
    }
  }

  assert.equal(submits.length, kinds.length * statuses.length, '每个 kind × 终态恰投递一次')
  for (const call of submits) {
    assert.equal(call.conversationId, 1)
    assert.equal(call.opts.origin, 'agent')
    assert.equal(call.opts.whenBusy, 'steer', `忙时策略必须 steer：${JSON.stringify(call.opts)}`)
    const kind = call.opts.meta['kind'] as string
    const expectedKindLabel = kind === 'subagent_report' ? 'subagent' : 'workflow'
    assert.equal(call.opts.requestId, `helm:${expectedKindLabel}-report:${String(call.opts.meta['backgroundRunId'])}`)
    assert.equal(call.opts.meta['renderer'], 'workflow:background-report')
    assert.ok(call.text.includes(`"${String(call.opts.meta['backgroundRunId'])}"`), '汇报正文应携带 run 结果数据')
  }
  assert.equal(submits.filter((s) => s.opts.meta['kind'] === 'subagent_report').length, statuses.length)
  assert.equal(submits.filter((s) => s.opts.meta['kind'] === 'workflow_report').length, statuses.length)
})
