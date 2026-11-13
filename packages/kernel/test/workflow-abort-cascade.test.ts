/**
 * WorkflowService 级联取消契约测试（tsx --test，确定性 fake host）。
 *
 * 覆盖：
 * - abort(runId) 级联：本 run + 其子会话子树内的全部后代 run 一起取消，
 *   兄弟任务不牵连；子会话经唯一守卫端口 abortConversationGuarded 中止；
 * - cancelRunsUnderConversation：会话子树（含后代发起）全部 run 取消；
 * - 取消窗口防新任务：边界内会话拒绝新 run / 新后台子代理，窗口解除恢复；
 * - human 红线：守卫端口拒绝（内核归属复核失败）时 run 仍确定结算 aborted，
 *   不存在普通中止回退；
 * - 迟到 onResolved 补杀：abort 先于执行元数据落地时登记点立即守卫中止；
 * - 纯同步子代理（SubagentWorkflow）取消：agent 子会话经守卫中止，run aborted；
 * - resume 显式授权透传：agent({ resume, maxSubagentDepth }) 经 service adapter
 *   原样到达 spawn 请求，不被静默丢弃。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type AgentSpawnRequest, type ConversationSummary } from '@helm/protocol'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'

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

function conv(id: number, parent?: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
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
}

/** 单次 spawn 计划：onResolved 回传的子会话与挂起策略。 */
interface SpawnPlan {
  /** onResolved 立即回传的子会话 ID（缺省不回传）。 */
  executionConversationId?: number
  /** signal abort 后才补发 onResolved（迟到 onResolved 场景）。 */
  resolveOnlyOnAbort?: boolean
  /** signal abort 后 reject（缺省挂起不返回）。 */
  rejectOnAbort?: boolean
}

interface CascadeHost extends WorkflowServiceHost {
  conversations: Map<number, ConversationSummary>
  guardedAborts: number[]
  /** 模拟内核红线拒绝（ownership_conflict）的会话集合。 */
  guardRejections: Set<number>
  /** 手动闸住守卫中止的会话集合（测取消窗口长度）。 */
  guardHeld: Set<number>
  guardWaiters: Array<() => void>
  spawns: Array<Record<string, unknown>>
  /** 下一次 spawn 的计划（测试逐个注入）。 */
  plan: SpawnPlan
  releaseGuards(): void
  /** 手动放行当前挂起的 spawn（让未取消的 run 正常完成）。 */
  releaseSpawn(value?: unknown): void
}

function makeHost(): CascadeHost {
  const conversations = new Map<number, ConversationSummary>()
  const guardedAborts: number[] = []
  const guardRejections = new Set<number>()
  const guardHeld = new Set<number>()
  const guardWaiters: Array<() => void> = []
  const spawns: Array<Record<string, unknown>> = []
  let releaseCurrentSpawn: ((value: unknown) => void) | undefined
  const host: CascadeHost = {
    conversations,
    guardedAborts,
    guardRejections,
    guardHeld,
    guardWaiters,
    spawns,
    plan: {},
    releaseGuards() {
      const waiters = [...guardWaiters]
      guardWaiters.length = 0
      for (const resolve of waiters) resolve()
    },
    releaseSpawn(value?: unknown) {
      releaseCurrentSpawn?.(value ?? 'done-result')
    },
    async spawnAgent(request) {
      spawns.push(request as unknown as Record<string, unknown>)
      const plan = host.plan
      const fireResolved = (): void => {
        if (plan.executionConversationId === undefined) return
        request.onResolved?.({ conversationId: plan.executionConversationId, effectiveCwd: '/tmp' })
      }
      if (plan.resolveOnlyOnAbort !== true) fireResolved()
      return new Promise<unknown>((resolve, reject) => {
        releaseCurrentSpawn = resolve
        if (plan.rejectOnAbort === true && request.signal !== undefined) {
          const onAbort = () => {
            fireResolved()
            reject(new HelmError('aborted', '子代理执行被取消', 409))
          }
          if (request.signal.aborted) {
            onAbort()
            return
          }
          request.signal.addEventListener('abort', onAbort, { once: true })
        }
        // 缺省挂起：由 releaseSpawn / signal abort 收尾。
      })
    },
    async invokeAction() {
      throw new HelmError('unknown_action', '级联测试不调用动作', 404)
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
    },
    async abortConversationGuarded(id) {
      guardedAborts.push(id)
      if (guardRejections.has(id)) {
        throw new HelmError('ownership_conflict', `会话 ${id} 当前归属 human，拒绝自动化变更（human 红线）`, 409)
      }
      if (guardHeld.has(id)) {
        await new Promise<void>((resolve) => {
          guardWaiters.push(resolve)
        })
      }
    },
    emitEvent() {},
  }
  return host
}

const META = (name: string) => `export const meta = { name: "${name}", description: "t" }\n`
const SYNC_SCRIPT = `${META('cascade-sync')}const a = await agent("p", { label: "s1" }); return a`
const FAST_SCRIPT = `${META('cascade-fast')}return 1`
const RESUME_SCRIPT =
  `${META('cascade-resume')}const a = await agent("p1", { label: "first" }); ` +
  `const b = await agent("p2", { resume: "first", maxSubagentDepth: 3 }); return [a, b]`

/** 轮询直到谓词为真（确定性等待，不 sleep 固定时长）。 */
async function until(predicate: () => boolean, what: string, maxMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('WorkflowService 级联取消', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-cascade-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('多级后台级联：abort(runId) 连同后代 run 与子会话一起取消，兄弟不牵连', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(11, conv(11, 1))
    host.conversations.set(21, conv(21, 11))
    host.conversations.set(12, conv(12, 1))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    host.plan = { executionConversationId: 11 }
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '一级' })
    host.plan = { executionConversationId: 21 }
    const r2 = await service.startBackgroundAgent({ parentConversationId: 11, prompt: '二级' })
    // 兄弟：父会话 1 的另一个后台任务（不在 R1 的子会话子树内）。
    host.plan = { executionConversationId: 12 }
    const sibling = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '兄弟' })

    await service.abort(r1.run.id)

    assert.equal(service.getRun(r1.run.id).status, 'aborted', '一级 run aborted')
    assert.equal(service.getRun(r2.run.id).status, 'aborted', '二级 run（后代发起）一并 aborted')
    assert.ok(host.guardedAborts.includes(11), `子会话 11 经守卫端口中止（实际 ${JSON.stringify(host.guardedAborts)}）`)
    assert.ok(host.guardedAborts.includes(21), `孙会话 21 经守卫端口中止（实际 ${JSON.stringify(host.guardedAborts)}）`)
    // 兄弟任务不受牵连：仍 running，随后正常放行完成。
    assert.equal(service.getRun(sibling.run.id).status, 'running', '兄弟 run 不被级联取消')
    const siblingDone = service.wait(sibling.run.id)
    host.releaseSpawn('sibling-done')
    await siblingDone
    assert.equal(service.getRun(sibling.run.id).status, 'completed', '兄弟 run 正常完成')
    // 取消窗口全部解除。
    assert.equal(service.isConversationCancelling(1), false)
    assert.equal(service.isConversationCancelling(11), false)
    await service.close()
  })

  it('cancelRunsUnderConversation：会话子树内全部 run 取消，无关会话不受影响', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(11, conv(11, 1))
    host.conversations.set(21, conv(21, 11))
    host.conversations.set(99, conv(99))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    host.plan = { executionConversationId: 11 }
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'a' })
    host.plan = { executionConversationId: 21 }
    const r2 = await service.startBackgroundAgent({ parentConversationId: 11, prompt: 'b' })
    host.plan = { executionConversationId: 98 }
    const other = await service.startBackgroundAgent({ parentConversationId: 99, prompt: 'c' })

    await service.cancelRunsUnderConversation(1)

    assert.equal(service.getRun(r1.run.id).status, 'aborted')
    assert.equal(service.getRun(r2.run.id).status, 'aborted', '后代发起的 run 一并取消')
    assert.equal(service.getRun(other.run.id).status, 'running', '无关会话的 run 不受影响')
    const otherDone = service.wait(other.run.id)
    host.releaseSpawn('other-done')
    await otherDone
    assert.equal(service.getRun(other.run.id).status, 'completed')
    await service.close()
  })

  it('取消窗口防新任务：边界内会话拒绝新 run 与新后台子代理，窗口解除后恢复', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(11, conv(11, 1))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    host.plan = { executionConversationId: 11 }
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '挂起' })
    // 闸住子会话 11 的守卫中止：取消停留在 settle 等待 pendingAborts 的窗口内。
    host.guardHeld.add(11)

    const aborting = service.abort(r1.run.id)
    await until(() => host.guardedAborts.includes(11), '守卫中止已进入窗口')
    assert.equal(service.isConversationCancelling(11), true, '子会话在取消窗口内')

    // 边界内会话的新 run 被拒（不静默排队）。
    await assert.rejects(
      () => service.run({ conversationId: 11, script: FAST_SCRIPT }),
      (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 409,
    )
    // 边界内会话的新后台子代理同样被拒。
    host.plan = { executionConversationId: 21 }
    await assert.rejects(
      () => service.startBackgroundAgent({ parentConversationId: 11, prompt: '不该启动' }),
      (err: unknown) => err instanceof HelmError && err.code === 'aborted',
    )

    // 解除窗口：新 run 恢复允许。
    host.releaseGuards()
    await aborting
    assert.equal(service.isConversationCancelling(11), false, '取消完成后窗口解除')
    const ok = await service.run({ conversationId: 11, script: FAST_SCRIPT })
    await service.wait(ok.id)
    assert.equal(service.getRun(ok.id).status, 'completed', '窗口解除后新 run 正常执行')
    await service.close()
  })

  it('human 红线：守卫端口拒绝时 run 仍确定结算 aborted，无普通中止回退', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(11, conv(11, 1))
    host.conversations.set(21, conv(21, 11))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    host.plan = { executionConversationId: 11 }
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'a' })
    host.plan = { executionConversationId: 21 }
    const r2 = await service.startBackgroundAgent({ parentConversationId: 11, prompt: 'b' })
    // 内核对孙会话 21 的守卫复核拒绝（归属已翻转 human）。
    host.guardRejections.add(21)

    await service.abort(r1.run.id)

    assert.equal(service.getRun(r1.run.id).status, 'aborted')
    assert.equal(service.getRun(r2.run.id).status, 'aborted', '守卫拒绝不阻塞 run 终态（不等待被保护子会话）')
    assert.ok(host.guardedAborts.includes(21), '守卫端口确被调用（拒绝发生在端口实现内）')
    assert.equal(host.guardedAborts.filter((id) => id === 21).length, 1, '确定性放弃，不重试')
    await service.close()
  })

  it('迟到 onResolved 补杀：abort 后才回传的子会话在登记点立即守卫中止', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(11, conv(11, 1))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    // spawn 挂起且不回 onResolved；abort 信号触发时才回传执行元数据并 reject。
    //（启动地平线尚未到达：startBackgroundAgent 本身阻塞在等 onResolved——
    // 取消必须能穿透这个窗口，这正是本用例要钉住的时序。）
    host.plan = { executionConversationId: 11, resolveOnlyOnAbort: true, rejectOnAbort: true }
    const startedPromise = service.startBackgroundAgent({ parentConversationId: 1, prompt: '迟到' })
    await until(
      () => service.listRuns().some((r) => r.kind === 'subagent' && r.conversationId === 1 && r.status === 'running'),
      'durable run 记录落地（启动地平线之前）',
    )
    const runId = service.listRuns().find((r) => r.kind === 'subagent' && r.conversationId === 1)!.id

    await service.abort(runId)
    const r1 = await startedPromise

    assert.equal(service.getRun(r1.run.id).status, 'aborted')
    assert.ok(
      host.guardedAborts.includes(11),
      `迟到 onResolved 的子会话被补杀（实际 ${JSON.stringify(host.guardedAborts)}）`,
    )
    await service.close()
  })

  it('纯同步子代理取消：SubagentWorkflow 的 agent 子会话经守卫中止，run aborted', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(31, conv(31, 1))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    // agent 子会话挂起（不回结果）：引擎在 abort 时终止 worker 并守卫中止子会话。
    host.plan = { executionConversationId: 31 }
    const started = await service.run({ conversationId: 1, script: SYNC_SCRIPT })
    await until(
      () => service.getRun(started.id).nodes?.some((n) => n.status === 'running') === true,
      'agent 节点进入 running',
    )

    await service.abort(started.id)

    assert.equal(service.getRun(started.id).status, 'aborted', 'run 终态 aborted（非悬挂 running）')
    assert.ok(
      host.guardedAborts.includes(31),
      `同步子会话 31 经守卫端口中止（实际 ${JSON.stringify(host.guardedAborts)}）`,
    )
    await service.close()
  })

  it('resume 显式授权透传：agent({ resume, maxSubagentDepth }) 原样到达 spawn 请求', timeout, async () => {
    const host = makeHost()
    host.conversations.set(1, conv(1))
    host.conversations.set(51, conv(51, 1))
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })

    // 首个 agent 立即完成；resume 续接携带显式 maxSubagentDepth。
    let call = 0
    host.spawnAgent = async (request: AgentSpawnRequest) => {
      host.spawns.push(request as unknown as Record<string, unknown>)
      call += 1
      request.onResolved?.({ conversationId: 50 + call, effectiveCwd: '/tmp' })
      return `ok-${call}`
    }
    const started = await service.run({ conversationId: 1, script: RESUME_SCRIPT })
    const result = await service.wait(started.id)

    assert.equal(service.getRun(started.id).status, 'completed')
    assert.deepEqual(result, ['ok-1', 'ok-2'])
    const resumeSpawn = host.spawns[1] as { resume?: string; maxSubagentDepth?: number; prompt?: string }
    assert.equal(resumeSpawn.maxSubagentDepth, 3, '显式续接授权透传到 spawn 请求（不被静默丢弃）')
    assert.equal(typeof resumeSpawn.resume, 'string', '续接引用随请求传递')
    await service.close()
  })
})
