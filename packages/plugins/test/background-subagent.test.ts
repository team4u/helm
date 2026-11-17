/**
 * startBackgroundAgent 后台单子代理生命周期测试（tsx --test，确定性 fake host）。
 *
 * 覆盖：
 * - 启动地平线与后台分离：onResolved 后立即返回 running + 真实 execution，
 *   慢任务随后完成，wait 返回结果，onBackgroundAgentSettled 恰一次并落 notifiedAt；
 * - 前置错误同步抛出：spawn 在 onResolved 前失败当场 reject 原始错误，
 *   durable 记录被后台兜底链结算为 failed（不留僵尸 running，不伪造成功）；
 * - 父信号隔离与显式 abort：onResolved 后父 signal abort 不误杀后台子代理；
 *   service.abort(runId) 经守卫端口 abortConversationGuarded 中止子会话且 run
 *   结算 aborted；
 * - gate 失败传播：spawn 因 gate_failed 抛错时 run 终态 failed（绝不提前
 *   completed），通知收到 status: 'failed' 与错误详情；
 * - 插件从不 onResolved 但 settle：execution 留空（绝不伪造），run 正常结算；
 * - 进程重启恢复：遗留 kind: 'subagent' + running 记录 init() 后标
 *   failed (interrupted) 并补发一次 onBackgroundAgentSettled；已终态但
 *   未 notifiedAt 的记录同样补发（outbox），notifiedAt 落库。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import { withWorkflowSpawnMeta, type WorkflowRunSummary } from '../src/contracts.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

/** 新契约：完整体在 dataDir/artifacts/<convId>/workflow-<runId>.record.json（本文件均属会话 1）。 */
function readRecord(dataDir: string, runId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dataDir, 'artifacts', '1', `workflow-${runId}.record.json`), 'utf-8'),
  )
}

function seedRecord(dataDir: string, record: Record<string, unknown>): void {
  const dir = join(dataDir, 'artifacts', String(record['conversationId']))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `workflow-${String(record['id'])}.record.json`), JSON.stringify(record), 'utf8')
}

// ---------------------------------------------------------------------------
// 确定性 fixtures
// ---------------------------------------------------------------------------

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

/** 可编程 spawn host：挂起/失败/gate 失败/不回 onResolved 等场景。 */
interface ProgrammableHost extends WorkflowServiceHost {
  settledCalls: SettledCall[]
  abortedConversations: number[]
  spawns: Array<Record<string, unknown>>
  /** 控制单次 spawn 行为（每次 startBackgroundAgent 前重设）。 */
  behavior:
    | { kind: 'hanging'; execution: AgentExecutionInfo; result?: unknown }
    | { kind: 'preResolveFail'; error: Error }
    | { kind: 'gateFail'; execution: AgentExecutionInfo }
    | { kind: 'noOnResolved'; result: unknown }
    | { kind: 'slowSuccess'; execution: AgentExecutionInfo; result: unknown }
  /** 手动放行挂起的 spawn。 */
  release(): void
  /** 挂起 spawn 是否已完成。 */
  settled(): boolean
}

function makeHost(options: { notifyFailTimes?: number } = {}): ProgrammableHost {
  const settledCalls: SettledCall[] = []
  const abortedConversations: number[] = []
  const spawns: Array<Record<string, unknown>> = []
  let releaseSpawn: (() => void) | undefined
  let spawnSettled = false
  let notifyFailures = options.notifyFailTimes ?? 0
  const host: ProgrammableHost = {
    settledCalls,
    abortedConversations,
    spawns,
    behavior: { kind: 'hanging', execution: { conversationId: 42 } },
    release() {
      releaseSpawn?.()
    },
    settled() {
      return spawnSettled
    },
    async spawnAgent(request) {
      spawns.push(request as unknown as Record<string, unknown>)
      const behavior = this.behavior
      if (behavior.kind === 'preResolveFail') throw behavior.error
      if (behavior.kind === 'noOnResolved') return behavior.result
      // 其余场景：先 onResolved，再挂起等待放行或被 signal 取消
      //（与真实 spawn 行为一致：abort → HelmError('aborted') reject）。
      request.onResolved?.(behavior.execution)
      const wait = new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      const cancelled = new Promise<never>((_, reject) => {
        if (request.signal === undefined) return
        if (request.signal.aborted) {
          reject(new HelmError('aborted', '子代理执行被取消', 409))
          return
        }
        request.signal.addEventListener(
          'abort',
          () => reject(new HelmError('aborted', '子代理执行被取消', 409)),
          { once: true },
        )
      })
      let outcome: 'released' | 'cancelled' = 'released'
      try {
        await Promise.race([wait, cancelled])
      } catch (error) {
        spawnSettled = true
        throw error
      }
      spawnSettled = true
      void outcome
      if (behavior.kind === 'gateFail') {
        throw new HelmError('gate_failed', 'gate 验收失败：exit 1', 422)
      }
      return behavior.result ?? 'done-result'
    },
    async invokeAction() {
      throw new HelmError('unknown_action', '后台子代理测试不调用动作', 404)
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      if (id >= 900) {
        throw new HelmError('not_found', `会话 ${id} 不存在`, 404)
      }
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
      abortedConversations.push(id)
    },
    emitEvent() {},
    async onBackgroundAgentSettled(summary, info) {
      if (notifyFailures > 0) {
        notifyFailures--
        throw new Error('simulated notify failure')
      }
      settledCalls.push({ summary, ...info })
    },
  }
  return host
}

describe('startBackgroundAgent', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-bgsub-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('启动地平线：onResolved 后立即返回 running 与完整 execution；慢任务随后完成并恰一次通知', timeout, async () => {
    const host = makeHost()
    host.behavior = {
      kind: 'hanging',
      execution: {
        conversationId: 42,
        effectiveCwd: '/tmp/wt',
        meta: { 'builtin:workflow': { worktree: { path: '/tmp/wt', branch: 'helm/spawn-1' } } },
      },
      result: 'slow-task-result',
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const started = Date.now()

    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '慢任务',
      agentType: 'researcher',
    })

    // 立即返回（不等慢任务）：running + 真实 execution。
    assert.ok(Date.now() - started < 5_000, 'startBackgroundAgent 不得等待慢任务完成')
    assert.equal(run.status, 'running')
    assert.equal(run.name, '慢任务')
    assert.equal(host.spawns[0]!['title'], '慢任务')
    assert.deepEqual(execution, {
      conversationId: 42,
      effectiveCwd: '/tmp/wt',
      meta: { 'builtin:workflow': { worktree: { path: '/tmp/wt', branch: 'helm/spawn-1' } } },
    })
    // 节点元数据已就位（getRun 实时视图）。
    const live = service.getRun(run.id)
    assert.equal(live.nodes?.[0]?.conversationId, 42)
    assert.equal(live.nodes?.[0]?.worktree?.branch, 'helm/spawn-1')

    // 慢任务完成 → wait 返回结果，run 终态 completed。
    host.release()
    const result = await service.wait(run.id)
    assert.equal(result, 'slow-task-result')
    const final = service.getRun(run.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.nodes?.[0]?.status, 'done')

    // 通知恰一次，携带 execution 与 agentType。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.id, run.id)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    assert.equal(host.settledCalls[0]!.agentType, 'researcher')
    assert.equal(host.settledCalls[0]!.execution?.conversationId, 42)

    // notifiedAt 已持久化（重开服务 init 不再补发）。
    const record = readRecord(dataDir, run.id)
    assert.equal(record['kind'], 'subagent')
    assert.ok(typeof record['notifiedAt'] === 'number')
    await service.close()
    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, '已通知的记录不得重复补发')
    await reopened.close()
  })

  it('durable running 记录先于 spawn 副作用登记（启动挂起期崩溃可恢复）', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '挂起' })
    // 仍挂起中：durable 记录已是 running 且在索引里。
    const record = readRecord(dataDir, run.id)
    assert.equal(record['status'], 'running')
    const index = state.get<Array<{ id: string } | null>>('workflow/runs', [])
    assert.ok(index.some((e) => e?.id === run.id))
    // active 已登记：abort/close 可达。
    assert.ok(service.listRuns().some((r) => r.id === run.id && r.status === 'running'))
    host.release()
    await service.wait(run.id)
    await service.close()
  })

  it('前置错误同步抛出：spawn 在 onResolved 前失败当场 reject，不留僵尸 running', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'preResolveFail', error: new HelmError('not_a_git_repo', '目标目录不是 Git 仓库', 400) }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    await assert.rejects(
      () =>
        service.startBackgroundAgent({
          parentConversationId: 1,
          prompt: '建 worktree',
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_a_git_repo')
        return true
      },
    )

    // 等待后台兜底链结算（异步）：记录必须达到 failed 终态（诚实，不删不悬）。
    const index = state.get<Array<{ id: string } | null>>('workflow/runs', [])
    assert.equal(index.length, 1)
    const runId = index[0]!.id
    await service.wait(runId)
    const final = service.getRun(runId)
    assert.equal(final.status, 'failed')
    assert.ok(final.error?.includes('not_a_git_repo'), final.error)
    // 失败同样通知父会话（恰一次）。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    await service.close()
  })

  it('父信号隔离与显式 abort：父 signal abort 不误杀；abort(runId) 触发 abortConversation(42) 并结算 aborted', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const parentSignal = new AbortController()
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '后台任务',
      signal: parentSignal.signal,
    })

    // onResolved 已触发：父 signal abort 不得传播到后台。
    parentSignal.abort()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(service.getRun(run.id).status, 'running', '父 signal abort 不得误杀后台子代理')
    assert.deepEqual(host.abortedConversations, [])

    // 显式 abort：先经 host.abortConversation 中止子会话，run 结算 aborted。
    const abortPromise = service.abort(run.id)
    // abort 会先触发 signal → abortConversation(42)，再等 spawn reject('aborted')。
    host.release()
    await abortPromise
    assert.deepEqual(host.abortedConversations, [42])
    const final = service.getRun(run.id)
    assert.equal(final.status, 'aborted')
    // 中止同样通知（恰一次）。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await service.close()
  })

  it('启动期（onResolved 前）父 signal 取消传播：当场 aborted 拒绝且 run 不悬挂', timeout, async () => {
    const host = makeHost()
    // 专用行为：onResolved 延迟（留出启动期取消窗口）；signal abort 即取消。
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    let capturedSignal: AbortSignal | undefined
    let releaseSpawn: (() => void) | undefined
    let capturedResolve: (() => void) | undefined
    const spawnEntered = new Promise<void>((resolve) => {
      capturedResolve = resolve
    })
    ;(host as unknown as { spawnAgent: unknown }).spawnAgent = async (request: {
      onResolved?: (info: AgentExecutionInfo) => void
      signal?: AbortSignal
    }) => {
      capturedSignal = request.signal
      capturedResolve?.()
      const cancelled = new Promise<never>((_, reject) => {
        if (request.signal === undefined) return
        request.signal.addEventListener(
          'abort',
          () => reject(new HelmError('aborted', '子代理执行被取消', 409)),
          { once: true },
        )
      })
      const delayed = new Promise<void>((resolve) => setTimeout(resolve, 300))
      // 延迟到启动窗口之后再 onResolved；窗口内 abort 则直接取消。
      await Promise.race([delayed, cancelled])
      request.onResolved?.({ conversationId: 42 })
      const hang = new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      await Promise.race([hang, cancelled])
      return 'unreachable'
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const parentSignal = new AbortController()
    const promise = service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '启动期取消',
      signal: parentSignal.signal,
    })
    // spawn 已进入、onResolved 尚未触发：此窗口内父 signal 取消必须传播。
    await spawnEntered
    assert.ok(capturedSignal !== undefined && !capturedSignal.aborted)
    parentSignal.abort()
    // 情况 A 语义：调用方当场收到 aborted 拒绝（不悬挂等待地平线）。
    await assert.rejects(
      () => promise,
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'aborted')
        return true
      },
    )
    // 后台兜底链把 durable 记录结算为 aborted 终态（不悬挂、不留僵尸 running）。
    const index = state.get<Array<{ id: string } | null>>('workflow/runs', [])
    assert.equal(index.length, 1)
    await service.wait(index[0]!.id)
    const final = service.getRun(index[0]!.id)
    assert.equal(final.status, 'aborted')
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await service.close()
  })

  it('gate 失败传播：run 结算 failed（绝不提前 completed），通知收到失败详情', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'gateFail', execution: { executionId: 'herdr:pane-7', nodeId: 'local' } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '带 gate 任务',
      gate: 'pnpm test',
    })
    assert.equal(execution?.executionId, 'herdr:pane-7')
    assert.equal(execution?.nodeId, 'local')
    // 节点 nodeId 透传（清理按目标节点判断）。
    assert.equal(service.getRun(run.id).nodes?.[0]?.nodeId, 'local')

    host.release()
    await service.wait(run.id)
    const final = service.getRun(run.id)
    assert.equal(final.status, 'failed')
    assert.ok(final.error?.includes('gate_failed'), final.error)
    assert.equal(final.nodes?.[0]?.status, 'failed')
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.ok(host.settledCalls[0]!.summary.error?.includes('gate_failed'))
    await service.close()
  })

  it('插件从不 onResolved 但 settle：execution 留空（绝不伪造），run 正常结算', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'noOnResolved', result: 'external-settled' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '外部运行时',
    })
    // 极快路径：spawn 同步返回且未回 onResolved → 返回值不携带伪造 execution。
    assert.equal(execution, undefined)
    // 返回时可能仍在 running，也可能后台链已极快结算（诚实快路径皆可）。
    assert.ok(run.status === 'running' || run.status === 'completed')
    const result = await service.wait(run.id)
    assert.equal(result, 'external-settled')
    assert.equal(service.getRun(run.id).status, 'completed')
    // 通知同样不带 execution。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.execution, undefined)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    await service.close()
  })

  it('父会话不存在：not_found 透传', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    await assert.rejects(
      () =>
        service.startBackgroundAgent({
          parentConversationId: 999,
          prompt: 'x',
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_found')
        return true
      },
    )
    await service.close()
  })

  it('service 关闭后拒绝启动（service_closed）', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    await service.close()
    await assert.rejects(
      () => service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'service_closed')
        return true
      },
    )
  })

  it('创建前已取消的 signal：当场拒绝', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const signal = new AbortController()
    signal.abort()
    await assert.rejects(
      () => service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x', signal: signal.signal }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'aborted')
        return true
      },
    )
    await service.close()
  })

  it('通知失败不推翻终态：notifiedAt 不置位，重启 init 按 outbox 补发', timeout, async () => {
    const host = makeHost({ notifyFailTimes: 1 })
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'ok' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' })
    host.release()
    await service.wait(run.id)
    // 首次通知失败：终态已落库但 notifiedAt 缺失。
    assert.equal(host.settledCalls.length, 0)
    const record = readRecord(dataDir, run.id)
    assert.equal(record['status'], 'completed')
    assert.equal(record['notifiedAt'], undefined)
    await service.close()

    // 重启 init：补发一次并落 notifiedAt。
    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = readRecord(dataDir, run.id)
    assert.ok(typeof after['notifiedAt'] === 'number')
    // 再次 init 不重复。
    await reopened.close()
    const again = new WorkflowService({ dataDir, host, state })
    await again.init()
    assert.equal(host.settledCalls.length, 1)
    await again.close()
  })

  it('进程重启恢复：遗留 subagent running 记录标 failed(interrupted) 并补发通知', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_restartdead0001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_restartdead0001', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
    seedRecord(dataDir, {
      id: 'wf_restartdead0001',
      name: 'subagent:researcher',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      kind: 'subagent',
      notifyParentOnSettle: true,
      journalPath,
      subagentMeta: { agentType: 'researcher', execution: { conversationId: 42 } },
    })
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await service.init()
    const summary = service.getRun('wf_restartdead0001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('subagent run interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resume'), '错误信息须提示可 resume 续接')
    // 补发恰一次，携带 subagentMeta。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.agentType, 'researcher')
    assert.equal(host.settledCalls[0]!.execution?.conversationId, 42)
    const record = readRecord(dataDir, 'wf_restartdead0001')
    assert.ok(typeof record['notifiedAt'] === 'number')
    // 已终态且未通知的常规 workflow 记录不受影响（不通知）。
    await service.close()
  })

  it('常规 workflow 的 interrupted 记录沿用账本恢复文案（不误用 subagent 文案）', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_wfdsldead00001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_wfdsldead00001', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
    seedRecord(dataDir, {
      id: 'wf_wfdsldead00001',
      name: 'old',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath,
    })
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await service.init()
    const summary = service.getRun('wf_wfdsldead00001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('resumeFromRunId'), summary.error)
    assert.equal(host.settledCalls.length, 0)
    await service.close()
  })

  it('notifyParentOnSettle=false：不通知，但 run 生命周期完整', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'quiet' }
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'x' },
      { notifyParentOnSettle: false },
    )
    host.release()
    const result = await service.wait(run.id)
    assert.equal(result, 'quiet')
    assert.equal(service.getRun(run.id).status, 'completed')
    assert.equal(host.settledCalls.length, 0)
    await service.close()
  })

  it('外部执行环境未回报 gate（executionId 存在）：gateResultMissing 显式失败', timeout, async () => {
    const host = makeHost()
    // hanging + onResolved 带 executionId，但从不 onGateResult。
    host.behavior = { kind: 'hanging', execution: { executionId: 'herdr:pane-9' }, result: 'maybe-done' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'gate 任务',
      gate: 'pnpm build',
    })
    host.release()
    await service.wait(run.id)
    const final = service.getRun(run.id)
    assert.equal(final.status, 'failed', '外部执行环境未回报 gate 不得标 completed')
    assert.ok(final.error?.includes('gate_result_missing'), final.error)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    await service.close()
  })

  it('close() 覆盖在途后台子代理：等待真实退出、移除 active、落终态', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' })
    assert.equal(service.getRun(run.id).status, 'running')
    const closing = service.close()
    // close 触发 abort → abortConversation(42)；放行挂起的 spawn 让其 reject。
    await new Promise<void>((resolve) => {
      const check = () => {
        if (host.abortedConversations.length > 0) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
    host.release()
    await closing
    const final = service.getRun(run.id)
    assert.equal(final.status, 'aborted')
    assert.deepEqual(host.abortedConversations, [42])
    // active 已移除。
    assert.ok(!service.listRuns().some((r) => r.id === run.id && r.status === 'running'))
    // 关停期间不唤醒父模型；待投递回报持久保留，下一次启动补发。
    assert.equal(host.settledCalls.length, 0)
    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await reopened.close()
  })

  it('startBackgroundAgent：保留 request.meta（如 maxSubagentDepth 与自定义字段）并合并 runId', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'ok' }
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const meta = withWorkflowSpawnMeta({ customNs: { tag: 'keep-me' } }, { maxSubagentDepth: 4 })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'with-meta',
      meta,
    })
    host.release()
    await service.wait(run.id)
    assert.equal(host.spawns.length, 1)
    assert.deepEqual(host.spawns[0]!['meta'], {
      customNs: { tag: 'keep-me' },
      'builtin:workflow': { maxSubagentDepth: 4, runId: run.id },
    })
    await service.close()
  })

  it('isHostClosing=true 关停期间：因 Session 关闭中断则标 aborted + pendingChildCleanup=true；若已完成则保留 completed 且延迟到下次重启 outbox 通知', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    let rejectShutdownSpawn!: (error: Error) => void
    const origSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      if (req.prompt === 'close-while-closing') {
        req.onResolved?.({ conversationId: 55 })
        return await new Promise<never>((_resolve, reject) => {
          rejectShutdownSpawn = reject
        })
      }
      return origSpawn(req)
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'close-while-closing',
    })
    host.behavior = { kind: 'hanging', execution: { conversationId: 56 }, result: 'real-finished-result' }
    const { run: completedRun } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'finish-right-before-harness-close',
    })

    // 模拟 Harness.close() 先于 pluginHost.dispose() 到来：host.isHostClosing 已为 true，
    // 在途 run 因 Session is closed 拒绝（绝不调用 abortConversationGuarded）；而在关停
    // 窗口内实际已完成的 completedRun 仍保留 completed 与结果，仅延迟通知到重启 outbox。
    hostClosing = true
    rejectShutdownSpawn(new Error('Session is closed'))
    host.release()
    await service.wait(run.id)
    await service.wait(completedRun.id)

    const saved = readRecord(dataDir, run.id)
    assert.equal(saved['status'], 'aborted')
    assert.equal(saved['pendingChildCleanup'], true)
    const savedCompleted = readRecord(dataDir, completedRun.id)
    assert.equal(savedCompleted['status'], 'completed')
    assert.equal(savedCompleted['result'], 'real-finished-result')
    assert.equal(savedCompleted['pendingChildCleanup'], undefined)
    assert.equal(host.abortedConversations.length, 0, 'host closing 期不再调用已关闭的 abortConversationGuarded')
    assert.equal(host.settledCalls.length, 0, 'host closing 期不向父会话发通知')

    // 重启后恢复（autoRecoverOnRestart=false）：prepareRecovery 收集 55 并守卫中止，init 清除 pendingChildCleanup 并补发两条 outbox
    hostClosing = false
    const reopened = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await reopened.prepareRecovery()
    assert.deepEqual(host.abortedConversations, [55])
    await reopened.init()
    await reopened.awaitPreparedChildrenSettled()
    assert.deepEqual(host.abortedConversations, [55, 55])
    assert.equal(readRecord(dataDir, run.id)['pendingChildCleanup'], undefined, 'init 必须清除 pendingChildCleanup')
    assert.equal(host.settledCalls.length, 2, '重启 outbox 应补发两条待汇报记录')
    assert.equal(host.settledCalls.find((c) => c.summary.id === run.id)?.summary.status, 'aborted')
    assert.equal(host.settledCalls.find((c) => c.summary.id === completedRun.id)?.summary.status, 'completed')
    await reopened.close()
  })

  it('isHostClosing=true 同步工作流 + pendingChildCleanup 严格布尔校验：关停标 aborted 且打标，重启收割子会话且不通知父会话，非布尔损坏拒绝', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    host.behavior = { kind: 'hanging', execution: { conversationId: 77 } }
    let rejectWorkflowSpawn!: (error: Error) => void
    host.spawnAgent = async (req) => {
      req.onResolved?.({ conversationId: 77 })
      return await new Promise<never>((_resolve, reject) => {
        rejectWorkflowSpawn = reject
      })
    }

    const run = await service.run({
      conversationId: 1,
      script: 'export const meta = { name: "sync-close", description: "test" }\nreturn await agent("child")',
    })
    // 等待 spawnAgent 进入
    await new Promise<void>((resolve) => {
      const check = () => {
        if (rejectWorkflowSpawn !== undefined) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
    hostClosing = true
    rejectWorkflowSpawn(new Error('Session is closed'))
    await service.wait(run.id)

    const saved = readRecord(dataDir, run.id)
    assert.equal(saved['status'], 'aborted')
    assert.equal(saved['pendingChildCleanup'], true)
    assert.equal(host.abortedConversations.length, 0)
    assert.equal(host.settledCalls.length, 0)

    hostClosing = false
    const reopened = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    await reopened.prepareRecovery()
    assert.deepEqual(host.abortedConversations, [77])
    await reopened.init()
    await reopened.awaitPreparedChildrenSettled()
    assert.deepEqual(host.abortedConversations, [77, 77])
    assert.equal(readRecord(dataDir, run.id)['pendingChildCleanup'], undefined)
    assert.equal(host.settledCalls.length, 0, '同步工作流绝不能在恢复期向父会话发通知')
    await reopened.close()

    // 非布尔 pendingChildCleanup 必须触发显式 workflow_record_corrupt
    const badId = 'wf_bad_pending_cleanup01'
    seedRecord(dataDir, {
      id: badId,
      name: 'bad',
      conversationId: 1,
      status: 'aborted',
      pendingChildCleanup: 'yes',
      createdAt: 1,
      updatedAt: 1,
      journalPath: join(dataDir, `${badId}.jsonl`),
    })
    const currentIndex = state.get<Array<Record<string, unknown>>>('workflow/runs', [])
    state.set('workflow/runs', [
      ...currentIndex,
      { id: badId, conversationId: 1, status: 'aborted', createdAt: 1, updatedAt: 1 },
    ])
    assert.throws(
      () => reopened.getRun(badId),
      (err: unknown) => err instanceof HelmError && err.code === 'workflow_record_corrupt',
    )
  })

  it('isHostClosing=true 关停窗口账本完整性：已执行完的 action/agent 正常落账，下一步 prepareAction 在写 action_started 前中止不留悬空行', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    host.listActions = () => [
      { pluginId: 'test', id: 'step1', description: 's1', inputSchema: {}, outputSchema: {} },
      { pluginId: 'test', id: 'step2', description: 's2', inputSchema: {}, outputSchema: {} },
    ]
    let step2Invoked = false
    host.invokeAction = async (_pluginId, actionId) => {
      if (actionId === 'step1') {
        // 模拟 step1 实际已完成，恰在返回瞬间宿主进入关停态
        hostClosing = true
        return { done: 1 }
      }
      step2Invoked = true
      return { done: 2 }
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state, autoRecoverOnRestart: false })
    const run = await service.run({
      conversationId: 1,
      script:
        'export const meta = { name: "closing-action-journal", description: "test" }\n' +
        'const a = await action("test.step1", { x: 1 })\n' +
        'const b = await action("test.step2", { x: 2 })\n' +
        'return [a, b]',
    })
    await service.wait(run.id)
    assert.equal(step2Invoked, false, '关停态不得启动后续 step2 动作')
    const saved = readRecord(dataDir, run.id)
    assert.equal(saved['status'], 'aborted')
    const journalLines = readFileSync(String(saved['journalPath']), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; index: number; ok?: boolean })
    // step1 必须同时落盘 action_started 与配对终态 action(ok: true)，且不存在 step2 的悬空 action_started
    assert.deepEqual(
      journalLines.map((l) => ({ type: l.type, index: l.index, ...(l.ok !== undefined ? { ok: l.ok } : {}) })),
      [
        { type: 'action_started', index: 0 },
        { type: 'action', index: 0, ok: true },
      ],
    )
    await service.close()
  })

  it('名称推导与 title 透传：label 优先、prompt 清洗截断脱敏、空 prompt 回退、resume/reattach 不覆写 title', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'noOnResolved', result: 'ok' }
    const service = new WorkflowService({
      dataDir,
      host,
      state: makeStateStore(),
      redact: (text) => text.replace(/SECRET_TOKEN/g, '[REDACTED]'),
    })

    // 1. prompt 剥离 structured_output_contract、Markdown 前缀、多空白、脱敏与 60 字符上限
    const longPrompt = [
      '<structured_output_contract>{"type":"object"}</structured_output_contract>',
      '',
      '---',
      '##   - *   Investigate   SECRET_TOKEN   build   failure   across   packages/plugins/workflow   right   now   please',
      'Second line ignored',
    ].join('\n')
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: longPrompt })
    await service.wait(r1.run.id)
    assert.equal(r1.run.name.length <= 60, true, `derived name length <= 60: ${r1.run.name}`)
    assert.ok(r1.run.name.startsWith('Investigate [REDACTED] build failure'), r1.run.name)
    assert.equal(r1.run.nodes?.[0]?.label, r1.run.name)
    assert.equal(host.spawns[0]!['title'], r1.run.name)

    // 2. 空 prompt 回退 subagent:${agentType} / subagent
    const r2 = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '<structured_output_contract>{}</structured_output_contract>\n###\n   ',
      agentType: 'reviewer',
    })
    await service.wait(r2.run.id)
    assert.equal(r2.run.name, 'subagent:reviewer')
    assert.equal(host.spawns[1]!['title'], 'subagent:reviewer')

    // 3. 显式 label 优先；resume 与 reattach 不透传 title
    const r3 = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'ignored prompt', resume: '42' },
      { label: '续接子代理' },
    )
    await service.wait(r3.run.id)
    assert.equal(r3.run.name, '续接子代理')
    assert.equal(host.spawns[2]!['title'], undefined, 'resume 不得设置/覆写 title')

    const r4 = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'ignored prompt', reattach: { conversationId: 42 } },
      { label: '重挂子代理' },
    )
    await service.wait(r4.run.id)
    assert.equal(host.spawns[3]!['title'], undefined, 'reattach 不得设置/覆写 title')

    await service.close()
  })
})
