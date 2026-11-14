/**
 * 并发缺陷回归测试（run 注册时序 / 停机屏障 / emitEvent 收口 / worktree 租约）：
 *
 * - run() 的 ActiveRun.done 自注册进 active 起即为真实终点（deferred gate）：
 *   running 快照 flush 的 await 窗口内并发 wait()/abort() 不得假返回
 *   （旧实现占位 Promise.resolve() 立即兑现，违背「返回时 run 已终态」）；
 * - 停机屏障复查：close() 与 run() 启动并发（run 挂在 init() 的 await 上）时，
 *   active.set 前复查 closed，拒绝越障启动（与 startBackgroundAgent 对称）；
 * - emitEvent fire-and-forget 收口：宿主适配器签名为 void 但实际 async 且可抛，
 *   调用点不 await 不得把持久层故障放大为 unhandledRejection；
 * - 外部运行时首次回填租约的 flush 失败：显式诊断、无 unhandledRejection，
 *   结算写同一 doc 重试后租约正常释放；
 * - resumeWithWorktree 占位租约先于远端验证打开：验证窗口内并发 cleanup 被租约
 *   fail-closed 拒绝（不再出现「验证秒级窗口内树被移除、resume 携 stale cwd
 *   续接、为已 removed 记录留永久租约」）；验证失败释放租约不留占位。
 *
 * runner: tsx --test；隔离测试用确定性 fake 端口（不开真实 SDK）。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'
import { WorktreeIsolation, type WorktreeIsolationDeps } from '../src/builtin-plugins/workflow/isolation.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

// ---------------------------------------------------------------------------
// unhandledRejection 捕获（观察面故障不得逃逸为进程崩溃）
// ---------------------------------------------------------------------------

async function assertNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    // 给逃逸 rejection 暴露的窗口（Node 在微任务队列排空后才判定 unhandled）。
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], '不得产生 unhandledRejection（观察面故障须就地诊断）')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

// ---------------------------------------------------------------------------
// 引擎级 fake（service host / state store）
// ---------------------------------------------------------------------------

function makeServiceHost(over: { emitEvent?: WorkflowServiceHost['emitEvent'] } = {}): WorkflowServiceHost {
  return {
    async spawnAgent() {
      return 'text:ok'
    },
    async invokeAction(_pluginId, _actionId, input) {
      return { ok: true, input }
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
    async abortConversationGuarded() {},
    emitEvent: over.emitEvent ?? (() => {}),
  }
}

function makeStateStore(): WorkflowStateStore {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string, initial: T): T {
      return (map.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, value)
    },
  }
}

/** 首次 flush（running 快照）在人工放行前挂起：制造 active.set 与结算链之间的窗口。 */
function makeGatedSnapshotStore(): WorkflowStateStore & { release(): void } {
  const inner = makeStateStore()
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstFlush = true
  return {
    get: inner.get,
    set: inner.set,
    async flush() {
      if (firstFlush) {
        firstFlush = false
        await released
      }
    },
    release,
  }
}

/** 断言 promise 在 ms 内未 settle。 */
async function assertPending(promise: Promise<unknown>, ms: number): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])
  assert.equal(outcome, 'pending', '窗口期内不得提前返回（占位 done 会假完成）')
}

// ---------------------------------------------------------------------------
// 隔离级 fake（WorktreeIsolation 确定性端口：不开真实 SDK / git）
// ---------------------------------------------------------------------------

interface FakeIsolationOptions {
  /** exists 探测（目标路径）：首次调用进入可放行闸门（模拟秒级远端验证窗口）。 */
  gatedExistsPath?: string
  /** exists 探测结果（缺省 true；false 模拟目录已被移除）。 */
  existsValue?: boolean
  /** docStore.flush 故障注入：前 failFlush 次 reject。 */
  failFlushFirst?: number
}

interface FakeIsolationHandle {
  isolation: WorktreeIsolation
  docStore: WorktreeIsolationDeps['docStore']
  /** gatedExistsPath 的首次 exists 探测已进入（验证窗口打开）。 */
  probeEntered: Promise<void>
  /** 放行 gatedExistsPath 的首次 exists 探测（关闭验证窗口）。 */
  releaseProbe(): void
  execCalls: Array<{ command: string | string[]; cwd?: string }>
}

function makeFakeIsolation(options: FakeIsolationOptions = {}): FakeIsolationHandle {
  const docs = new Map<string, unknown>()
  let flushes = 0
  const docStore: WorktreeIsolationDeps['docStore'] = {
    get<T>(key: string, initial: T): T {
      return (docs.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      docs.set(key, value)
    },
    async flush() {
      flushes++
      if (options.failFlushFirst !== undefined && flushes <= options.failFlushFirst) {
        throw new Error('simulated doc flush failure')
      }
    },
  }
  let releaseProbe: () => void = () => {}
  let probeEnteredNotify: () => void = () => {}
  const probeEntered = new Promise<void>((resolve) => {
    probeEnteredNotify = resolve
  })
  const gatedPath = options.gatedExistsPath
  let gateConsumed = false
  const execCalls: FakeIsolationHandle['execCalls'] = []
  const handle: FakeIsolationHandle = {
    docStore,
    probeEntered,
    releaseProbe: () => releaseProbe(),
    execCalls,
    isolation: new WorktreeIsolation({
      host: {
        resolveSpawnTarget: async (input) => ({
          nodeId: 'local',
          sourceCwd: input.requestCwd ?? '/repo',
          parentCwd: '/repo',
        }),
        execEnv: async (req) => {
          execCalls.push({ command: req.command, cwd: req.cwd })
          // verifyForResume 的 git 探测（rev-parse --is-inside-work-tree）足够。
          return { ok: true, exitCode: 0, output: 'true\n', timedOut: false }
        },
        probeNodeFs: async (input) => {
          if (
            input.op === 'exists' && gatedPath !== undefined && input.path === gatedPath && !gateConsumed
          ) {
            gateConsumed = true
            probeEnteredNotify()
            await new Promise<void>((resolve) => {
              releaseProbe = resolve
            })
            return { value: options.existsValue ?? true }
          }
          if (input.op === 'exists') return { value: options.existsValue ?? true }
          return { value: input.path }
        },
        listActiveSpawnExecutions: () => [],
        redactText: (text) => text,
        // 进程占用探测：本文件调 cleanup 的用例均在租约/占用层被拒（到不了
        // 进程扫描），补全空快照不会伪造任何被断言的行为。
        inspectNodePathUsage: async (input: { nodeId: string; path: string }) => ({
          path: input.path,
          processes: [],
          matchedTotal: 0,
          processesTruncated: false,
          complete: true,
          diagnostics: [],
        }),
        getConversation: () => ({ cwd: gatedPath ?? '/repo', nodeId: 'local', status: 'idle' }),
      },
      docStore,
    }),
  }
  return handle
}

/** 读取租约表条目数（结算后应为 0：不留永久占位）。 */
function leaseCount(docStore: WorktreeIsolationDeps['docStore']): number {
  return Object.keys(docStore.get<Record<string, unknown>>('worktree-leases', {})).length
}

let dataDir: string

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-concurrency-'))
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. run() 注册时序：done 无占位窗口
// ---------------------------------------------------------------------------

describe('run 注册时序（done gate）', timeout, () => {
  it('启动窗口内 wait() 不得假返回：放行 running 快照后才拿真实结果', timeout, async () => {
    const host = makeServiceHost()
    const state = makeGatedSnapshotStore()
    // 从 running 快照 writeRecord 捕获 runId（run() 在 flush 挂起期间尚未返回）。
    let runId = ''
    const capturing: WorkflowStateStore = {
      get: state.get,
      set(key, value) {
        if (runId === '' && key.startsWith('workflow/run/')) runId = key.slice('workflow/run/'.length)
        state.set(key, value)
      },
      flush: async () => {
        await state.flush?.()
      },
    }
    const service = new WorkflowService({ dataDir, host, state: capturing })

    const runPromise = service.run({ conversationId: 1, script: META('wait-gate') + 'return 42' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(runId !== '', 'runId 应已随 running 快照写入可捕获')

    const waitPromise = service.wait(runId)
    await assertPending(waitPromise, 80)

    state.release()
    const summary = await runPromise
    assert.equal(summary.status, 'running')
    assert.equal(await waitPromise, 42, '放行后 wait 拿到真实结果（非占位 undefined）')
    assert.equal(service.getRun(runId).status, 'completed')
    await service.close()
  })

  it('启动窗口内 abort() 返回时 run 必已终态（契约与 wait 同一 done 通道）', timeout, async () => {
    const host = makeServiceHost()
    const state = makeGatedSnapshotStore()
    let runId = ''
    const capturing: WorkflowStateStore = {
      get: state.get,
      set(key, value) {
        if (runId === '' && key.startsWith('workflow/run/')) runId = key.slice('workflow/run/'.length)
        state.set(key, value)
      },
      flush: async () => {
        await state.flush?.()
      },
    }
    const service = new WorkflowService({ dataDir, host, state: capturing })

    const runPromise = service.run({ conversationId: 1, script: META('abort-gate') + 'return 7' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(runId !== '')

    const abortPromise = service.abort(runId)
    await assertPending(abortPromise, 80)

    state.release()
    await runPromise
    await abortPromise
    const final = service.getRun(runId)
    assert.notEqual(final.status, 'running', 'abort 返回时 run 必已终态')
    assert.equal(final.status, 'aborted')
    await service.close()
  })
})

// ---------------------------------------------------------------------------
// 2. 停机屏障复查
// ---------------------------------------------------------------------------

describe('停机屏障（close 与 run 启动并发）', timeout, () => {
  it('init 完成后、active.set 前复查 closed：越障启动显式拒绝', timeout, async () => {
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    // run() 同步段过入口检查后挂在 await init()；close() 的同步前缀置位 closed。
    const runPromise = service.run({ conversationId: 1, script: META('closed-race') + 'return 1' })
    const rejection = assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'closed')
      return true
    })
    await service.close()
    await rejection
  })
})

// ---------------------------------------------------------------------------
// 3. emitEvent fire-and-forget 收口
// ---------------------------------------------------------------------------

describe('emitEvent 收口（宿主适配器 async 抛错）', timeout, () => {
  it('run 生命周期不受影响且不产生 unhandledRejection', timeout, async () => {
    const host = makeServiceHost({
      // 真实适配器（builtin:workflow）内部 syncRunsDoc/emitEvent 均可抛——以
      // async reject 模拟持久层故障（workflow_index_corrupt 等）。
      emitEvent: async () => {
        throw new HelmError('workflow_index_corrupt', '读取工作流 run 索引失败（模拟）', 500)
      },
    })
    await assertNoUnhandledRejection(async () => {
      const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
      const summary = await service.run({ conversationId: 1, script: META('emit-safe') + 'return 5' })
      assert.equal(await service.wait(summary.id), 5, '事件观察面故障不得影响 run 结果')
      assert.equal(service.getRun(summary.id).status, 'completed')
      await service.close()
    })
  })
})

// ---------------------------------------------------------------------------
// 4. 外部运行时租约首写 flush 失败
// ---------------------------------------------------------------------------

describe('外部运行时租约首写 flush 失败', timeout, () => {
  it('显式诊断、无 unhandledRejection；结算写重试后租约释放', timeout, async () => {
    const stderrLines: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrLines.push(String(chunk))
      return (originalWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    try {
      const handle = makeFakeIsolation({ failFlushFirst: 1 })
      await assertNoUnhandledRejection(async () => {
        let resolved: { worktree?: { id?: string } } | undefined
        const result = await handle.isolation.aroundSpawn(
          {
            parentConversationId: 1,
            prompt: '外部任务',
            agentType: 'ext:demo',
            isolation: 'worktree',
            onResolved: (info: { worktree?: { id?: string } }) => {
              resolved = info as { worktree?: { id?: string } }
            },
          } as never,
          async (final) => {
            // 模拟外部运行时回报 worktree（首次回填即触发租约 flush 失败）。
            ;(final as AgentSpawnRequest).onResolved?.({
              nodeId: 'local',
              worktree: { path: '/wt/ext-1', branch: 'helm/spawn-ext1' },
              conversationId: 7,
              executionId: 'exec-1',
            })
            return 'ext-done'
          },
        )
        assert.equal(result, 'ext-done')
        assert.ok(resolved?.worktree?.id, 'enriched worktree 元数据应回传调用方')
        assert.equal(leaseCount(handle.docStore), 0, '结算后租约必须释放（settle 写重试整页落盘）')
      })
      assert.ok(
        stderrLines.some((line) => line.includes('租约') && line.includes('落盘失败')),
        `flush 失败必须 stderr 显式诊断（实际 ${JSON.stringify(stderrLines)}）`,
      )
    } finally {
      process.stderr.write = originalWrite
    }
  })
})

// ---------------------------------------------------------------------------
// 5. resumeWithWorktree：租约先于远端验证
// ---------------------------------------------------------------------------

describe('resumeWithWorktree 租约前置', timeout, () => {
  const WT_PATH = '/wt/resume-race'

  function seedResumeRecord(handle: FakeIsolationHandle): string {
    const record = handle.isolation.allocator.registerExternal({
      nodeId: 'local',
      path: WT_PATH,
      branch: 'helm/spawn-resume1',
      parentConversationId: 1,
      conversationId: 42,
    })
    return record.id
  }

  it('远端验证窗口内并发 cleanup 被租约 fail-closed 拒绝；resume 正常续接', timeout, async () => {
    const handle = makeFakeIsolation({ gatedExistsPath: WT_PATH })
    const worktreeId = seedResumeRecord(handle)

    const nextCwds: Array<string | undefined> = []
    const resumePromise = handle.isolation.aroundSpawn(
      { parentConversationId: 1, prompt: '续接', resume: '42', onResolved: () => {} } as never,
      async (final) => {
        nextCwds.push((final as AgentSpawnRequest).cwd)
        return 'resumed'
      },
    )
    // 验证窗口打开：resume 挂在远端 exists 探测上（此刻子会话 idle、无在途
    // 执行、旧实现无租约——cleanup 三重占用检查全空）。
    await handle.probeEntered

    await assert.rejects(
      () => handle.isolation.cleanup({ worktreeId }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        // 占位租约先行拒绝（worktree_execution_unknown / worktree_in_use 均为
        // 租约驱动的 fail-closed；旧实现会放行到 git 取证阶段）。
        assert.ok(
          err.code === 'worktree_execution_unknown' || err.code === 'worktree_in_use',
          `cleanup 应被租约拒绝（实际 ${err.code}）`,
        )
        return true
      },
    )

    handle.releaseProbe()
    assert.equal(await resumePromise, 'resumed')
    assert.deepEqual(nextCwds, [WT_PATH], 'resume 必须沿用原 worktree cwd')
    assert.equal(leaseCount(handle.docStore), 0, '结算后租约释放，不留永久占位')
    // 记录仍 active（未被清理动过）。
    assert.equal(handle.isolation.allocator.findActive({ worktreeId })?.path, WT_PATH)
  })

  it('验证失败（目录已消失）释放占位租约，不留永久占位', timeout, async () => {
    const handle = makeFakeIsolation({ existsValue: false })
    seedResumeRecord(handle)

    await assert.rejects(
      () =>
        handle.isolation.aroundSpawn(
          { parentConversationId: 1, prompt: '续接', resume: '42', onResolved: () => {} } as never,
          async () => 'unreachable',
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_missing')
        return true
      },
    )
    assert.equal(leaseCount(handle.docStore), 0, 'neverStarted 路径必须释放占位租约')
  })
})
