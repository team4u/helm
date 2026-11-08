/**
 * startBackgroundAgent 后台单子代理生命周期测试（tsx --test，确定性 fake host）。
 *
 * 覆盖：
 * - 启动地平线与后台分离：onResolved 后立即返回 running + 真实 execution，
 *   慢任务随后完成，wait 返回结果，onBackgroundAgentSettled 恰一次并落 notifiedAt；
 * - 前置错误同步抛出：spawn 在 onResolved 前失败当场 reject 原始错误，
 *   durable 记录被后台兜底链结算为 failed（不留僵尸 running，不伪造成功）；
 * - 父信号隔离与显式 abort：onResolved 后父 signal abort 不误杀后台子代理；
 *   service.abort(runId) 触发 host.abortConversation(childId) 且 run 结算 aborted；
 * - gate 失败传播：spawn 因 gate_failed 抛错时 run 终态 failed（绝不提前
 *   completed），通知收到 status: 'failed' 与错误详情；
 * - 插件从不 onResolved 但 settle：execution 留空（绝不伪造），run 正常结算；
 * - 进程重启恢复：遗留 kind: 'subagent' + running 记录 init() 后标
 *   failed (interrupted) 并补发一次 onBackgroundAgentSettled；已终态但
 *   未 notifiedAt 的记录同样补发（outbox），notifiedAt 落库。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type AgentExecutionInfo, type WorkflowRunSummary } from '@helm/protocol'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/service.js'

const timeout = { timeout: 60_000 } as const

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
    async abortConversation(id: number) {
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
        worktree: { path: '/tmp/wt', branch: 'helm/spawn-1' },
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
    assert.equal(run.name, 'subagent:researcher')
    assert.deepEqual(execution, {
      conversationId: 42,
      effectiveCwd: '/tmp/wt',
      worktree: { path: '/tmp/wt', branch: 'helm/spawn-1' },
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
    const record = state.get<{ notifiedAt?: number; kind?: string } | null>(`workflow/run/${run.id}`, null)
    assert.ok(record !== null)
    assert.equal(record.kind, 'subagent')
    assert.ok(typeof record.notifiedAt === 'number')
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
    const record = state.get<{ status: string } | null>(`workflow/run/${run.id}`, null)
    assert.ok(record !== null)
    assert.equal(record.status, 'running')
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
    const record = state.get<{ status: string; notifiedAt?: number } | null>(`workflow/run/${run.id}`, null)
    assert.equal(record!.status, 'completed')
    assert.equal(record!.notifiedAt, undefined)
    await service.close()

    // 重启 init：补发一次并落 notifiedAt。
    const reopened = new WorkflowService({ dataDir, host, state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = state.get<{ notifiedAt?: number } | null>(`workflow/run/${run.id}`, null)
    assert.ok(typeof after!.notifiedAt === 'number')
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
    state.set('workflow/runs', [{ id: 'wf_restartdead0001', conversationId: 1, createdAt: 1 }])
    state.set('workflow/run/wf_restartdead0001', {
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
    const service = new WorkflowService({ dataDir, host, state })
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
    const record = state.get<{ notifiedAt?: number } | null>('workflow/run/wf_restartdead0001', null)
    assert.ok(typeof record!.notifiedAt === 'number')
    // 已终态且未通知的常规 workflow 记录不受影响（不通知）。
    await service.close()
  })

  it('常规 workflow 的 interrupted 记录沿用账本恢复文案（不误用 subagent 文案）', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_wfdsldead00001.jsonl')
    state.set('workflow/runs', [{ id: 'wf_wfdsldead00001', conversationId: 1, createdAt: 1 }])
    state.set('workflow/run/wf_wfdsldead00001', {
      id: 'wf_wfdsldead00001',
      name: 'old',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath,
    })
    const service = new WorkflowService({ dataDir, host, state })
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
})
