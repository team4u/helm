/**
 * 前台同步 run 的 detach 转后台引擎契约测试（tsx --test，确定性 fake host）。
 *
 * 覆盖（任务契约）：
 * - 同步 subagent detach：foreground 启动 → waitForeground 挂起 → detach 唤醒
 *   'detached'，run 不被中止继续执行；终态后经翻转的 notifyParentOnSettle 恰
 *   一次汇报；record 持久 detachedAt；
 * - 同步 workflow detach 唤醒：service.run(foreground) 挂起 agent 节点 →
 *   detach → 'detached' → 放行后 completed + 恰一次通知；
 * - signal 语义：detach 前父 signal abort 中止 run（同步语义保留）；detach 后
 *   父 signal abort 不再误杀（转后台后 run 继续到终态）；
 * - 自然完成与 detach race：先终态后 detach 显式 detach_not_running，且不通知
 *   （notifyParentOnSettle 未置位）；waitForeground 以 'settled' 返回终态结果；
 * - 状态拒绝：后台启动的 run / 已 detach 的 run / 未知 run / 非活跃 run；
 * - detachForegroundSyncRun 纯逻辑授权：automation 归属拒绝、跨树 scope 拒绝、
 *   祖先放行、空 runId 拒绝、未知 run 404 透传。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/engine/service.js'
import { detachForegroundSyncRun, type DetachEnginePorts, type DetachHostPorts } from '../src/workflow/detach.js'

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

/** 可控 flush 失败的 state store（模拟状态存储队列落盘故障；按需武装下一次失败）。 */
function makeFlushGateStore(): WorkflowStateStore & { failNext(): void } {
  const inner = makeStateStore()
  let failNext = false
  return {
    ...inner,
    flush: async (): Promise<void> => {
      if (failNext) {
        failNext = false
        throw new Error('simulated state flush io failure')
      }
    },
    failNext: (): void => {
      failNext = true
    },
  }
}

function readRecord(dataDir: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, 'artifacts', '1', `workflow-${runId}.record.json`), 'utf-8'))
}

interface SettledCall {
  summary: WorkflowRunSummary
  parentConversationId: number
}

/** 可编程 host：挂起 spawn（手动放行）/ 父 signal 观测 / 结算通知记录。 */
interface ProgrammableHost extends WorkflowServiceHost {
  settledCalls: SettledCall[]
  abortedConversations: number[]
  /** 手动放行挂起的 spawn（工作流 agent 节点用）。 */
  release(): void
  /** 等待 spawn 真正发起（工作流 worker 启动与脚本执行是异步的）。 */
  spawnArrived(): Promise<void>
}

function makeHost(): ProgrammableHost {
  const settledCalls: SettledCall[] = []
  const abortedConversations: number[] = []
  let releaseSpawn: (() => void) | undefined
  let notifySpawnArrived: (() => void) | undefined
  const spawnArrivedPromise = new Promise<void>((resolve) => {
    notifySpawnArrived = resolve
  })
  const host: ProgrammableHost = {
    settledCalls,
    abortedConversations,
    release() {
      releaseSpawn?.()
    },
    spawnArrived() {
      return spawnArrivedPromise
    },
    async spawnAgent(request) {
      const execution: AgentExecutionInfo = { conversationId: 42 }
      request.onResolved?.(execution)
      notifySpawnArrived?.()
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
      await Promise.race([wait, cancelled])
      return 'slow-result'
    },
    async invokeAction() {
      throw new HelmError('unknown_action', '测试不调用动作', 404)
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      if (id >= 900) throw new HelmError('not_found', `会话 ${id} 不存在`, 404)
      return {
        id,
        title: `conv-${id}`,
        profileId: 'assistant',
        tags: [],
        ...(id >= 100 ? { parentConversationId: id - 100 } : {}),
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
      settledCalls.push({ summary, ...info })
    },
  }
  return host
}

describe('前台同步 subagent detach（startBackgroundAgent foreground 模式）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-fg-detach-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('detach 唤醒等待中的工具调用：立即后台化，signal 不再误杀，终态恰一次汇报', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    const parentSignal = new AbortController()
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: '同步任务', signal: parentSignal.signal },
      { parentToolCallId: 'call-fg-1', foreground: true },
    )
    assert.equal(run.status, 'running')
    assert.equal(run.syncForeground, true, '前台 run 应携带 syncForeground 标记')
    assert.equal((readRecord(dataDir, run.id) as { notifyParentOnSettle?: boolean }).notifyParentOnSettle, false, '初始不通知')

    // 模拟同步工具的挂起等待（waitForeground），并 detach。
    const waitPromise = service.waitForeground(run.id)
    const detached = await service.detachForegroundRun(run.id)
    assert.equal(detached.status, 'running')
    assert.equal(detached.syncForeground, true)
    assert.ok(typeof detached.detachedAt === 'number')
    assert.equal(await waitPromise, 'detached', 'detach 必须立即唤醒等待中的工具调用')

    // detach 后父 signal abort 不得误杀（转后台，只受 abort(runId)/close 控制）。
    parentSignal.abort()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(service.getRun(run.id).status, 'running', 'detach 后父 signal abort 不得中止 run')

    // 终态：notifyParentOnSettle 已翻转，恰一次结算汇报。
    host.release()
    assert.equal(await service.wait(run.id), 'slow-result')
    const final = service.getRun(run.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.detachedAt, detached.detachedAt, 'detachedAt 保留到终态')
    assert.equal(host.settledCalls.length, 1, '转后台的 run 终态恰一次汇报')
    assert.equal(host.settledCalls[0]!.summary.id, run.id)
    const record = readRecord(dataDir, run.id)
    assert.equal(record['notifyParentOnSettle'], true)
    assert.equal(record['detachedAt'], detached.detachedAt)
    assert.ok(typeof record['notifiedAt'] === 'number', 'notifiedAt 落库（重启不补发）')
    await service.close()
  })

  it('detach 前父 signal abort 仍中止 run（同步语义保留）', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const parentSignal = new AbortController()
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: '同步任务', signal: parentSignal.signal },
      { foreground: true },
    )
    const waitPromise = service.waitForeground(run.id)
    parentSignal.abort()
    assert.equal(await waitPromise, 'settled', '前台绑定下父 signal abort 应中止 run 并唤醒等待')
    assert.equal(service.getRun(run.id).status, 'aborted')
    // 同步 run 自然中止不通知（notifyParentOnSettle 未置位）。
    assert.equal(host.settledCalls.length, 0)
    await service.close()
  })

  it('自然完成与 detach race：先终态后 detach 显式拒绝，不产生通知', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: '快任务' },
      { foreground: true },
    )
    const waitPromise = service.waitForeground(run.id)
    host.release()
    assert.equal(await waitPromise, 'settled')
    assert.equal(await service.wait(run.id), 'slow-result')
    assert.equal(host.settledCalls.length, 0, '自然完成的前台 run 不通知')
    await assert.rejects(
      () => service.detachForegroundRun(run.id),
      (err: unknown) => err instanceof HelmError && err.code === 'detach_not_running' && err.status === 409,
    )
    await service.close()
  })

  it('已 detach 的 run 重复 detach 显式拒绝（幂等防重复转后台）', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: '同步任务' },
      { foreground: true },
    )
    await service.detachForegroundRun(run.id)
    await assert.rejects(
      () => service.detachForegroundRun(run.id),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'detach_not_foreground' && err.status === 409 && /已在后台/.test(err.message),
    )
    await service.abort(run.id)
    await service.close()
  })

  it('后台启动的 run（非前台同步）拒绝 detach；未知 run 404 透传', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '后台任务' })
    assert.equal(run.syncForeground, undefined, '后台 run 不携带前台标记')
    await assert.rejects(
      () => service.detachForegroundRun(run.id),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'detach_not_foreground' && /已在后台/.test(err.message),
    )
    await assert.rejects(
      () => service.detachForegroundRun('wf_nonexistent'),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
    )
    assert.rejects(
      () => service.waitForeground('wf_nonexistent'),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )
    await service.abort(run.id)
    await service.close()
  })
})

describe('前台同步 workflow detach（service.run foreground 上下文）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-fg-detach-wf-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('同步工作流挂起节点 detach 唤醒：转后台继续执行，终态恰一次汇报', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const started = await service.run(
      {
        conversationId: 1,
        script:
          'export const meta = { name: "fg-detach-wf", description: "t" }\n' +
          'const r = await agent("挂起节点")\nreturn ["done", r]',
      },
      { parentToolCallId: 'call-wf-fg-1', foreground: true },
    )
    assert.equal(started.status, 'running')
    assert.equal(started.syncForeground, true, '同步工作流 run 应标记 syncForeground')

    // 等待 agent 节点真正发起（worker 启动是异步的）再挂起等待与 detach。
    await host.spawnArrived()

    const waitPromise = service.waitForeground(started.id)
    const detached = await service.detachForegroundRun(started.id)
    assert.equal(await waitPromise, 'detached', '工作流同步等待同样被 detach 唤醒')
    assert.ok(typeof detached.detachedAt === 'number')

    // 放行挂起的 agent 节点：run 推进到 completed，翻转的通知恰一次。
    host.release()
    const result = await service.wait(started.id)
    assert.deepEqual(result, ['done', 'slow-result'])
    assert.equal(service.getRun(started.id).status, 'completed')
    assert.equal(host.settledCalls.length, 1, '转后台的工作流终态恰一次汇报')
    assert.equal(host.settledCalls[0]!.summary.id, started.id)
    assert.equal(readRecord(dataDir, started.id)['detachedAt'], detached.detachedAt)
    await service.close()
  })

  it('同步工作流自然完成：waitForeground settled 携带终态，不通知', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const started = await service.run(
      {
        conversationId: 1,
        script: 'export const meta = { name: "fg-settle-wf", description: "t" }\nreturn 7',
      },
      { foreground: true },
    )
    assert.equal(await service.waitForeground(started.id), 'settled')
    assert.equal(service.getRun(started.id).result, 7)
    assert.equal(host.settledCalls.length, 0, '自然完成的前台工作流不通知')
    await service.close()
  })

  it('同步工作流工具形状 onDetached：detach 临界段同步解绑父 signal，紧邻 abort 不误杀', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const started = await service.run(
      {
        conversationId: 1,
        script:
          'export const meta = { name: "fg-detach-signal", description: "t" }\n' +
          'const r = await agent("挂起节点")\nreturn r',
      },
      { foreground: true },
    )
    await host.spawnArrived()

    // 复刻 tools.ts 同步工作流路径的工具侧绑定：父 signal → abort(runId)，
    // waitForeground 以 onDetached 解绑（detach 临界段在唤醒前同步执行）。
    const parentSignal = new AbortController()
    const onAbort = (): void => {
      void service.abort(started.id).catch(() => {})
    }
    parentSignal.signal.addEventListener('abort', onAbort, { once: true })
    const waitPromise = service.waitForeground(started.id, {
      onDetached: () => parentSignal.signal.removeEventListener('abort', onAbort),
    })
    await service.detachForegroundRun(started.id)
    // detach 临界段已同步解绑：紧随其后的父 signal abort 不得取消已转后台 run。
    parentSignal.abort()
    assert.equal(await waitPromise, 'detached')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(service.getRun(started.id).status, 'running', 'detach 后紧邻的父 signal abort 不得中止 run')

    host.release()
    assert.equal(await service.wait(started.id), 'slow-result')
    assert.equal(host.settledCalls.length, 1, '转后台 run 终态恰一次汇报')
    await service.close()
  })

  it('同步工作流工具形状：detach 前父 signal abort 仍中止 run（同步语义保留）', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const started = await service.run(
      {
        conversationId: 1,
        script:
          'export const meta = { name: "fg-abort-signal", description: "t" }\n' +
          'const r = await agent("挂起节点")\nreturn r',
      },
      { foreground: true },
    )
    await host.spawnArrived()

    const parentSignal = new AbortController()
    const onAbort = (): void => {
      void service.abort(started.id).catch(() => {})
    }
    parentSignal.signal.addEventListener('abort', onAbort, { once: true })
    const waitPromise = service.waitForeground(started.id, {
      onDetached: () => parentSignal.signal.removeEventListener('abort', onAbort),
    })
    // detach 之前父 signal abort：onAbort 生效，run 中止并唤醒等待为 settled。
    parentSignal.abort()
    assert.equal(await waitPromise, 'settled')
    assert.equal(service.getRun(started.id).status, 'aborted', 'detach 前父 signal abort 应中止 run')
    assert.equal(host.settledCalls.length, 0, '未 detach 的前台 run 中止不通知')
    await service.close()
  })

  it('状态存储 flush 失败：动作如实报错但不回滚已持久 detach（run 继续后台语义并汇报）', timeout, async () => {
    const host = makeHost()
    const state = makeFlushGateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: '同步任务' },
      { foreground: true },
    )
    const waitPromise = service.waitForeground(run.id)
    // 武装下一次 flush 失败（即 detach 临界段之后的落盘等待），再 detach：
    // 临界段完成（记录文件已 fsync、等待者已唤醒）后 flush 失败——如实抛
    // detach_flush_failed，绝不回滚已落盘事实。
    state.failNext()
    const failure = await service.detachForegroundRun(run.id).then(
      () => assert.fail('flush 失败必须显式报错'),
      (error: unknown) => error,
    )
    assert.ok(failure instanceof HelmError)
    assert.equal((failure as HelmError).code, 'detach_flush_failed')
    assert.equal((failure as HelmError).status, 500)
    assert.ok(/已转入后台/.test((failure as HelmError).message), '错误须如实说明 detach 已生效')
    // 语义锁定：记录文件已持久 detachedAt/notifyParentOnSettle；等待者已被
    // 唤醒为 detached（工具返回后台句柄，不悬挂）；run 不被取消。
    assert.equal(await waitPromise, 'detached', 'flush 失败不得误取消/悬挂等待中的工具调用')
    const record = readRecord(dataDir, run.id)
    assert.ok(typeof record['detachedAt'] === 'number', '记录文件已持久 detachedAt（不回滚）')
    assert.equal(record['notifyParentOnSettle'], true)
    assert.equal(service.getRun(run.id).status, 'running')
    // 重复 detach：已是后台（幂等拒绝），不得因 flush 失败重放转后台。
    await assert.rejects(
      () => service.detachForegroundRun(run.id),
      (err: unknown) => err instanceof HelmError && err.code === 'detach_not_foreground',
    )
    // 终态：notify 已翻转 → 恰一次结算汇报（重启恢复以 record 文件为权威）。
    host.release()
    assert.equal(await service.wait(run.id), 'slow-result')
    assert.equal(host.settledCalls.length, 1)
    await service.close()
  })
})

describe('detachForegroundSyncRun 纯逻辑授权（动作入口）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-fg-detach-auth-'))
  before(() => {
    assert.ok(dataDir)
  })
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  function ports(
    run: WorkflowRunSummary | undefined,
    options: { ownership?: (id: number) => 'helm' | 'bot' | 'human' } = {},
  ): DetachHostPorts & DetachEnginePorts {
    const ownership = options.ownership ?? ((id: number) => (id === 1 ? 'human' : id === 2 ? 'helm' : 'human'))
    return {
      getRun: (id: string): WorkflowRunSummary => {
        if (run === undefined || run.id !== id) throw new HelmError('not_found', `工作流运行 ${id} 不存在`, 404, { runId: id })
        return run
      },
      detach: async (id: string): Promise<WorkflowRunSummary> => {
        if (run === undefined || run.id !== id) throw new HelmError('not_found', '不存在', 404)
        return { ...run, detachedAt: 123 }
      },
      getConversation: (id: number) => {
        if (id >= 900) throw new HelmError('not_found', `会话 ${id} 不存在`, 404)
        return {
          id,
          title: `conv-${id}`,
          profileId: 'assistant',
          tags: [],
          ...(id >= 100 ? { parentConversationId: id - 100 } : {}),
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
      getConversationOwnership: ownership,
    }
  }

  const fgRun: WorkflowRunSummary = {
    id: 'wf_fg1',
    name: 'subagent',
    conversationId: 1,
    kind: 'subagent',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    syncForeground: true,
  }

  it('发起会话自身 detach 放行（human-owned）', timeout, async () => {
    const output = await detachForegroundSyncRun(ports(fgRun), { runId: 'wf_fg1' }, { conversationId: 1 })
    assert.equal(output.detached, true)
    assert.equal(output.runId, 'wf_fg1')
    assert.ok(typeof output.run.detachedAt === 'number')
  })

  it('人工 HTTP/CLI（无会话上下文）放行；发起会话祖先放行', timeout, async () => {
    // 祖先：conversationId 101（父 = 1）。
    const childRun = { ...fgRun, conversationId: 101 }
    assert.equal((await detachForegroundSyncRun(ports(childRun), { runId: 'wf_fg1' }, {})).detached, true)
    assert.equal((await detachForegroundSyncRun(ports(childRun), { runId: 'wf_fg1' }, { conversationId: 1 })).detached, true)
  })

  it('automation 归属会话的前台 run 拒绝（防早结算）', timeout, async () => {
    const helmRun = { ...fgRun, conversationId: 2 }
    await assert.rejects(
      () => detachForegroundSyncRun(ports(helmRun), { runId: 'wf_fg1' }, { conversationId: 2 }),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'detach_forbidden' && err.status === 403 && /归属 helm/.test(err.message),
    )
    // 无会话上下文的人工通道同样拒绝 automation run。
    await assert.rejects(
      () => detachForegroundSyncRun(ports(helmRun), { runId: 'wf_fg1' }, {}),
      (err: unknown) => err instanceof HelmError && err.code === 'detach_forbidden',
    )
  })

  it('跨树 caller（非自身亦非祖先）拒绝；未知 run 404 透传；空 runId 拒绝', timeout, async () => {
    // conversationId 300 的父链是 200 → 100，不经过 1。
    const otherRun = { ...fgRun, conversationId: 300 }
    await assert.rejects(
      () => detachForegroundSyncRun(ports(otherRun), { runId: 'wf_fg1' }, { conversationId: 1 }),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'detach_out_of_scope' && err.status === 403 && /自身或祖先/.test(err.message),
    )
    await assert.rejects(
      () => detachForegroundSyncRun(ports(undefined), { runId: 'wf_none' }, {}),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
    )
    await assert.rejects(
      () => detachForegroundSyncRun(ports(fgRun), { runId: '   ' }, {}),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )
  })

  it('引擎状态拒绝原样透传（终态 run：detach_not_running）', timeout, async () => {
    const engineRejecting = ports(fgRun)
    engineRejecting.detach = async () => {
      throw new HelmError('detach_not_running', '运行 wf_fg1 已终态', 409, { runId: 'wf_fg1' })
    }
    await assert.rejects(
      () => detachForegroundSyncRun(engineRejecting, { runId: 'wf_fg1' }, { conversationId: 1 }),
      (err: unknown) => err instanceof HelmError && err.code === 'detach_not_running' && err.status === 409,
    )
  })
})
