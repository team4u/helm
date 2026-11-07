/**
 * OverviewProjector 生命周期与归属纪律回归（针对返修缺陷的确定性复现）。
 *
 * 全部用 Deferred 门控 fetch（不 sleep），真实 PaneRegistry / AskCoordinator
 * fixture。覆盖：单飞 dirty 全等待；close 中断零写入零通知；采集失败保留
 * 成功水位（stale/恢复）；streamError 在 fetch 成功后仍 stale 直到真实订阅
 * ACK；远端同 ID 记录与 human takeover 归属；同 seq 真实 cwd/status 变化；
 * 机密字段 redact 落 doc；evict 水位防旧快照复活。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OverviewProjector, type OverviewDoc } from '../src/builtin-plugins/herdr/overview.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedPane } from '../src/builtin-plugins/herdr/panes.js'
import { AskCoordinator } from '../src/builtin-plugins/herdr/asks.js'
import type { HerdrAgentInfo, HerdrPaneSnapshotInfo, SessionSnapshotData } from '../src/builtin-plugins/herdr/rpc.js'
import type { HerdrTarget } from '../src/builtin-plugins/herdr/contracts.js'

class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T) => void
  private rejectFn!: (reason: unknown) => void
  settled = false
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
  }
  resolve(value: T): void {
    this.settled = true
    this.resolveFn(value)
  }
  reject(reason: unknown): void {
    this.settled = true
    this.rejectFn(reason)
  }
}

/** 门控 fetcher：每次调用登记一个 Deferred；whenCalled 提供确定性调用同步点。 */
class GatedFetcher {
  calls = 0
  private readonly gates: Array<Deferred<SessionSnapshotData>> = []
  private readonly waiters: Array<{ n: number; d: Deferred<void> }> = []
  constructor(private produce: () => SessionSnapshotData) {}
  readonly fetch = (target: HerdrTarget, signal: AbortSignal): Promise<SessionSnapshotData> => {
    assert.equal(target.session, 'main')
    const gate = new Deferred<SessionSnapshotData>()
    this.gates.push(gate)
    this.calls += 1
    for (const w of this.waiters.splice(0)) {
      if (w.n <= this.calls) w.d.resolve()
      else this.waiters.push(w)
    }
    signal.addEventListener('abort', () => {
      if (!gate.settled) gate.reject(new Error('aborted'))
    }, { once: true })
    return gate.promise.then(() => this.produce())
  }
  gate(index: number): Deferred<SessionSnapshotData> {
    const gate = this.gates[index]
    assert.ok(gate !== undefined, `gate ${index} 未创建（当前 ${this.calls} 次调用）`)
    return gate
  }
  whenCalled(n: number): Promise<void> {
    if (this.calls >= n) return Promise.resolve()
    const d = new Deferred<void>()
    this.waiters.push({ n, d })
    return d.promise
  }
}

interface Harness {
  projector: OverviewProjector
  fetcher: GatedFetcher
  docs: OverviewDoc[]
  notifications: Array<{ title: string; body: string; level: string }>
  usable: { value: boolean }
  registry: PaneRegistry
  asks: AskCoordinator
}

function pane(paneId: string, overrides: Partial<HerdrPaneSnapshotInfo> = {}): HerdrPaneSnapshotInfo {
  return {
    paneId,
    workspaceId: 'ws1',
    tabId: 'tab1',
    focused: false,
    agentStatus: 'unknown',
    cwd: '/work/dir',
    ...overrides,
  }
}

function agentInfo(paneId: string, overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    paneId,
    tabId: 'tab1',
    workspaceId: 'ws1',
    agentStatus: 'working',
    stateChangeSeq: 7,
    interactiveReady: false,
    ...overrides,
  }
}

function managedPane(paneId: string, overrides: Partial<ManagedPane> = {}): ManagedPane {
  return {
    target: { session: 'main' },
    paneId,
    tabId: 'tab1',
    effectiveCwd: '/work/dir',
    agentName: 'helm-wf-abc123',
    routing: { kind: 'claude' },
    parentConversationId: 1,
    outcome: 'running',
    createdAt: 1_000,
    ...overrides,
  }
}

function makeHarness(produce: () => SessionSnapshotData): Harness {
  const fetcher = new GatedFetcher(produce)
  const docs: OverviewDoc[] = []
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const usable = { value: true }
  const projector = new OverviewProjector(
    {
      redact: (t) => t.replaceAll('SECRET', '[REDACTED]'),
      notify: (title, body, level) => notifications.push({ title, body, level }),
    },
    (doc) => docs.push(doc),
    fetcher.fetch,
    () => usable.value,
  )
  const registry = new PaneRegistry({ get: () => EMPTY_MANAGED_DOC, set: () => {} })
  const asks = new AskCoordinator(() => {})
  return { projector, fetcher, docs, notifications, usable, registry, asks }
}

const TARGET: HerdrTarget = { session: 'main' }

test('首次快照完成前保持 stale，订阅 ACK 不伪造采集成功', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [] }))
  h.projector.republish(h.registry, h.asks)
  h.projector.markSubscriptionReady()
  assert.equal(h.docs.at(-1)?.stale, true)
  assert.equal(h.docs.at(-1)?.updatedAt, 0)
  const refresh = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await refresh
  assert.equal(h.docs.at(-1)?.stale, false)
  assert.ok((h.docs.at(-1)?.updatedAt ?? 0) > 0)
})

test('同一 inflight 的 dirty 全等待：返回 promise 等到全部补刷轮结束', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [pane('p1')] }))
  const first = h.projector.refresh(h.registry, h.asks, TARGET)
  assert.equal(h.fetcher.calls, 1)
  const second = h.projector.refresh(h.registry, h.asks, TARGET) // 并入第一轮
  assert.equal(second, first) // 单飞：同一 in-flight promise
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await h.fetcher.whenCalled(2) // 第一轮结束即开始补刷轮（确定性同步点）
  assert.equal(h.fetcher.gate(1).settled, false)
  const third = h.projector.refresh(h.registry, h.asks, TARGET) // 并入补刷轮
  assert.equal(third, first)
  h.fetcher.gate(1).resolve({ agents: [], panes: [] })
  await h.fetcher.whenCalled(3)
  h.fetcher.gate(2).resolve({ agents: [], panes: [] })
  await first // 与 second/third 同一 promise：所有补刷结束后才 settle
  assert.equal(h.fetcher.calls, 3)
  // 每次成功采集都发布（去重不吞成功刷新；时间戳如实推进不回退）。
  assert.equal(h.docs.length, 3)
  for (let i = 1; i < h.docs.length; i += 1) {
    assert.ok(h.docs[i]!.updatedAt >= h.docs[i - 1]!.updatedAt)
  }
  assert.equal(h.docs.at(-1)?.stale, false)
})

test('close 中断在途 fetch：旧快照丢弃，零写入零通知，不重启新 fetch', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [pane('p1')] }))
  const first = h.projector.refresh(h.registry, h.asks, TARGET)
  const closing = h.projector.close()
  await first
  await closing
  assert.equal(h.docs.length, 0) // close 前无成功写入，close 后零写入
  assert.equal(h.notifications.length, 0) // abort 不是采集失败：不通知
  assert.equal(h.fetcher.calls, 1)
  // 关闭后所有入口静默。
  await h.projector.refresh(h.registry, h.asks, TARGET)
  h.projector.republish(h.registry, h.asks)
  h.projector.markSubscriptionFailed(new Error('SECRET boom'))
  h.projector.markSubscriptionReady()
  h.projector.evictPane('p1')
  assert.equal(h.docs.length, 0)
  assert.equal(h.notifications.length, 0)
  assert.equal(h.fetcher.calls, 1)
})

test('采集失败：保留最后成功 updatedAt、置 stale/error 并通知一次；恢复清除', { timeout: 60_000 }, async () => {
  let fail = false
  const h = makeHarness(() => {
    if (fail) throw new Error('SECRET socket broken')
    return { agents: [], panes: [pane('p1')] }
  })
  const ok1 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await ok1
  const successDoc = h.docs.at(-1)!
  assert.equal(successDoc.stale, false)
  assert.ok(successDoc.updatedAt > 0)
  const successUpdatedAt = successDoc.updatedAt
  fail = true
  const failing = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(1).resolve({ agents: [], panes: [] }) // produce 抛错
  await failing
  const errDoc = h.docs.at(-1)!
  assert.equal(errDoc.stale, true)
  assert.equal(errDoc.error, '[REDACTED] socket broken')
  assert.deepEqual(errDoc.panes.map((p) => p.paneId), ['p1']) // 最后成功数据保留
  assert.equal(errDoc.updatedAt, successUpdatedAt) // 成功水位保留
  assert.equal(h.notifications.length, 1)
  assert.equal(h.notifications[0]?.level, 'error')
  fail = false
  const recovering = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(2).resolve({ agents: [], panes: [] })
  await recovering
  const okDoc = h.docs.at(-1)!
  assert.equal(okDoc.stale, false)
  assert.equal(okDoc.error, undefined)
  assert.ok(okDoc.updatedAt >= successUpdatedAt)
})

test('streamError 在 fetch 成功后仍 stale，直到真实订阅 ACK 才恢复', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [pane('p1')] }))
  const ok1 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await ok1
  const successUpdatedAt = h.docs.at(-1)!.updatedAt
  h.projector.markSubscriptionFailed(new Error('SECRET stream reset'))
  const streamDoc = h.docs.at(-1)!
  assert.equal(streamDoc.stale, true)
  assert.ok(streamDoc.error?.includes('[REDACTED]'))
  assert.equal(streamDoc.updatedAt, successUpdatedAt) // 轻量重投不伪造采集成功
  // fetch 成功不得自动清除 streamError。
  const ok2 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(1).resolve({ agents: [], panes: [] })
  await ok2
  const afterFetch = h.docs.at(-1)!
  assert.equal(afterFetch.stale, true)
  assert.ok(afterFetch.error?.includes('stream reset'))
  assert.ok(afterFetch.updatedAt >= successUpdatedAt) // 采集成功仍推进水位
  // 真实订阅 ACK 后恢复。
  h.projector.markSubscriptionReady()
  const readyDoc = h.docs.at(-1)!
  assert.equal(readyDoc.stale, false)
  assert.equal(readyDoc.error, undefined)
})

test('归属：远端同 ID 记录不认领；human takeover 不带管理信息', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({
    agents: [agentInfo('p1', { name: 'helm-wf-abc123' }), agentInfo('p2', { name: 'human-shell', tabId: 'tab2' })],
    panes: [pane('p1', { agentStatus: 'working' }), pane('p2', { tabId: 'tab2', agentStatus: 'unknown' })],
  }))
  // 远端同 paneId 记录：不得认领本机 p1。
  h.registry.add(managedPane('p1', { target: { machine: 'remote-host', session: 'main' } }))
  // 本机记录但 agentName 已不一致（人类接管重启终端）：human。
  h.registry.add(managedPane('p2', { tabId: 'tab2', agentName: 'helm-wf-other' }))
  const done = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await done
  const doc = h.docs.at(-1)!
  const p1 = doc.panes.find((p) => p.paneId === 'p1')!
  assert.equal(p1.ownedBy, 'human')
  assert.equal(p1.outcome, undefined)
  assert.equal(p1.pendingAsk, undefined)
  const p2 = doc.panes.find((p) => p.paneId === 'p2')!
  assert.equal(p2.ownedBy, 'human')
  assert.equal(p2.outcome, undefined)
  assert.equal(p2.pendingAsk, undefined)
  assert.equal(p2.stateChangeSeq, 7) // Agent join 的真实 seq 是窗格事实，照常展示
})

test('归属全一致才算 helm：本机冻结 target + tabId + agentName + Agent join', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({
    agents: [agentInfo('p1', { name: 'helm-wf-abc123', tabId: 'tab1', workspaceId: 'ws1' })],
    panes: [pane('p1', { tabId: 'tab1', workspaceId: 'ws1', agentStatus: 'working' })],
  }))
  h.registry.add(managedPane('p1')) // target={session:'main'} 与 TARGET 精确一致
  const begun = h.asks.beginBlocked(undefined, 'p1', 7)
  assert.ok('owner' in begun)
  begun.owner.phase = 'pending'
  const done = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await done
  const row = h.docs.at(-1)?.panes.find((p) => p.paneId === 'p1')!
  assert.equal(row.ownedBy, 'helm')
  assert.equal(row.outcome, 'running')
  assert.equal(row.pendingAsk, true)
  assert.equal(row.agentName, 'helm-wf-abc123')
  assert.equal(row.stateChangeSeq, 7)
  assert.deepEqual(h.docs.at(-1)?.asks, [{ paneId: 'p1', machine: 'local', seq: 7, phase: 'pending' }])
})

test('同 seq 下真实 cwd/status 变化仍发布', { timeout: 60_000 }, async () => {
  let cwd = '/old'
  let status: HerdrAgentInfo['agentStatus'] = 'working'
  const h = makeHarness(() => ({
    agents: [agentInfo('p1', { name: 'a', stateChangeSeq: 9, agentStatus: status, cwd, foregroundCwd: cwd })],
    panes: [pane('p1', { agentStatus: status, cwd })],
  }))
  const r1 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await r1
  const before = h.docs.at(-1)?.panes.find((p) => p.paneId === 'p1')!
  assert.equal(before.cwd, '/old')
  assert.equal(before.agentStatus, 'working')
  cwd = '/new'
  status = 'idle'
  const r2 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(1).resolve({ agents: [], panes: [] })
  await r2
  const after = h.docs.at(-1)?.panes.find((p) => p.paneId === 'p1')!
  assert.equal(after.cwd, '/new')
  assert.equal(after.foregroundCwd, '/new')
  assert.equal(after.agentStatus, 'idle')
  assert.equal(after.stateChangeSeq, 9) // seq 未变但真实变化已发布
})

test('机密脱敏：cwd/foregroundCwd/label/title/agent/agentName 落 doc 前 redact', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({
    agents: [agentInfo('p1', { name: 'helm-wf-SECRET-name', foregroundCwd: '/home/SECRET/proj' })],
    panes: [pane('p1', { cwd: '/work/SECRET-path', label: 'label-SECRET', title: 'title-SECRET', agent: 'claude-SECRET' })],
  }))
  const done = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await done
  const row = h.docs.at(-1)?.panes[0]!
  assert.equal(row.cwd, '/work/[REDACTED]-path')
  assert.equal(row.foregroundCwd, '/home/[REDACTED]/proj')
  assert.equal(row.label, 'label-[REDACTED]')
  assert.equal(row.title, 'title-[REDACTED]')
  assert.equal(row.agent, 'claude-[REDACTED]')
  assert.equal(row.agentName, 'helm-wf-[REDACTED]-name')
  assert.equal(JSON.stringify(h.docs.at(-1)).includes('SECRET'), false)
})

test('evictPane：立即移除缓存行，后续快照不含已关行；evict 后新起一轮可重建', { timeout: 60_000 }, async () => {
  let p1Open = true
  const h = makeHarness(() => ({ agents: [], panes: p1Open ? [pane('p1'), pane('p2')] : [pane('p2')] }))
  const r1 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await r1
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), ['p1', 'p2'])
  p1Open = false
  h.projector.evictPane('p1')
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), ['p2']) // 立即反映消失
  const r2 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(1).resolve({ agents: [], panes: [] })
  await r2
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), ['p2'])
  // evict 之后新起一轮的快照（p1 真实重建）可重新建行。
  p1Open = true
  const r3 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(2).resolve({ agents: [], panes: [] })
  await r3
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), ['p1', 'p2'])
})

test('evict 水位：事件前开始的旧 inflight 快照丢弃该 pane，之后新一轮才重建', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [pane('p1')] }))
  const r1 = h.projector.refresh(h.registry, h.asks, TARGET) // 第一轮 fetch 在途
  assert.equal(h.fetcher.calls, 1)
  h.projector.evictPane('p1') // 关闭事件先于快照返回到达（标脏并记水位）
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  // evict 已标脏：循环会自动补一轮（确定性同步点）。
  await h.fetcher.whenCalled(2)
  // 第一轮（事件前开始）的快照丢弃 p1：旧快照不复活。
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), [])
  // evict 之后新起一轮的快照（p1 真实重建）可重新建行。
  h.fetcher.gate(1).resolve({ agents: [], panes: [] })
  await r1 // 补刷轮结束后 settle
  assert.deepEqual(h.docs.at(-1)?.panes.map((p) => p.paneId), ['p1'])
})

test('usable 翻转后 close：abort 静默收尾，无通知无写入', { timeout: 60_000 }, async () => {
  const h = makeHarness(() => ({ agents: [], panes: [] }))
  const r1 = h.projector.refresh(h.registry, h.asks, TARGET)
  h.fetcher.gate(0).resolve({ agents: [], panes: [] })
  await r1
  const r2 = h.projector.refresh(h.registry, h.asks, TARGET) // 采集挂起中
  h.usable.value = false // 停用
  const closing = h.projector.close() // abort 在途
  await r2
  await closing
  assert.equal(h.notifications.length, 0)
  assert.equal(h.docs.length, 1) // 仅第一轮成功写入
})
