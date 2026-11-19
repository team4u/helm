/**
 * builtin:workflow runs 会话分片投影契约测试：
 * - 跨会话隔离：每父会话分片只含自己的 run，绝不串台；
 * - 全局 run-badges 只含 count/tone/footerText 导航元数据，无完整 run 摘要，
 *   且摘要不变不写（无重复 plugin.doc.updated 事件）；
 * - 分片值不变不发 plugin.session_doc.updated（无写放大）；
 * - 删除的父会话不重建孤儿 doc（会话不存在时跳过；已持久分片在会话仍存在
 *   但无 runs 时清到空）；
 * - 祖先聚合：每个会话分片含自身及后代发起的 runs（run.conversationId
 *   保持原始归属），角标同步聚合、按 run.id 去重；父链环/缺父不虚构投影；
 *   会话删除/树变化经宿主事件触发重投影；
 * - 重启（新 host 同持久层）start 后最终投影与会话分片一致。
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmxError,
  type ConversationSummary,
  type PluginSessionDocHandle,
} from '@helmx/protocol'
import { PluginHost } from '../../kernel/src/plugins/index.js'
import { PluginHostBackendFixtureBase } from '../../kernel/test/helpers/plugin-host-backend.js'
import type { WorkflowRunBadgesDocState, WorkflowRunSessionDocState, WorkflowRunSummary } from '../src/contracts.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createWorktreePlugin } from '../src/worktree.js'
import { createRunsProjection, MAX_PROJECTED_RUNS_PER_CONVERSATION } from '../src/workflow/projection.js'
import { createHelmx } from '../../hub/src/app.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary } from './helpers/plugin-test-env.js'

const makeConversation = (id: number, parent?: number): ConversationSummary =>
  makeConversationSummary({
    id,
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
  })

class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>()
  events: Array<{ type: string; payload: unknown }> = []
  private listeners = new Map<string, Array<(payload: unknown) => void>>()
  constructor() {
    super()
    this.conversations.set(1, makeConversation(1))
    this.conversations.set(2, makeConversation(2))
  }
  dispatchTrigger(): Promise<void> { return Promise.resolve() }
  submitInput(): Promise<void> { return Promise.resolve() }
  createConversation(): Promise<ConversationSummary> { return Promise.resolve(makeConversation(99)) }
  listConversations(): ConversationSummary[] { return [...this.conversations.values()] }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmxError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> { return Promise.resolve(this.getConversation(id)) }
  abortConversation(): Promise<void> { return Promise.resolve() }
  getConversationActivity(): { consecutiveErrors: number } { return { consecutiveErrors: 0 } }
  getConversationOwnership(): 'helmx' | 'bot' | 'human' { return 'human' }
  spawnAgent(): Promise<unknown> { return Promise.resolve('spawned') }
  runGate(): Promise<{ ok: boolean; output: string }> { return Promise.resolve({ ok: true, output: '' }) }
  cleanupWorktree(): Promise<{ removed: boolean; worktreeId: string; path: string; branch: string; nodeId: string; branchDeleted: boolean }> {
    return Promise.resolve({ removed: true, worktreeId: 'local:/x', path: '/x', branch: 'b', nodeId: 'local', branchDeleted: false })
  }
  invokeAction(): Promise<unknown> { return Promise.resolve({}) }
  prepareAction(): { idempotent: boolean } { return { idempotent: false } }
  execEnv(): Promise<never> { return Promise.reject(new HelmxError('unsupported', '本 fixture 不执行节点命令', 501)) }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  listActions(): never[] { return [] }
  manageConversation(): () => void { return () => {} }
  markConversationOwnership(): void {}
  createAsk(): Promise<never> { return Promise.reject(new HelmxError('unsupported', '测试后端不提供 ask', 501)) }
  cancelAsk(): Promise<void> { return Promise.resolve() }
  registerAskSeqResolver(): () => void { return () => {} }
  onEvent(type: string, listener: (payload: unknown) => void): () => void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
    return () => {
      const current = this.listeners.get(type) ?? []
      this.listeners.set(type, current.filter((l) => l !== listener))
    }
  }
  /** 模拟内核事件广播（conversation.upsert / conversation.deleted 等）。 */
  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload)
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
  }
}

/** 会话文档持久层替身（键语义与 PluginSessionDocStore 一致）。 */
class MemorySessionDocStore {
  store = new Map<string, string>()
  writes: string[] = []
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
    this.writes.push(`${pluginId}:${name}:${conversationId}`)
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
    for (const key of this.store.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const id = Number(key.split('\0')[2])
      if (Number.isSafeInteger(id) && id > 0) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let backend: FakeBackend
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore

function makeHost(): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs, sessionDocs })
}

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-shard-'))
  backend = new FakeBackend()
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** 读公开会话分片（内存瞬态投影）。 */
function readShard(host: PluginHost, convId: number): { runs: Array<{ id: string; status: string; conversationId: number }> } {
  return host.getPublicSessionDoc('builtin:workflow', 'runs', convId).value as {
    runs: Array<{ id: string; status: string; conversationId: number }>
  }
}

function readBadges(host: PluginHost): { byConversation: Record<string, Record<string, unknown>> } {
  return host.getPublicDoc('builtin:workflow', 'run-badges').value as {
    byConversation: Record<string, Record<string, unknown>>
  }
}

function sessionDocEvents(): Array<{ doc: { conversationId: number } }> {
  return backend.events
    .filter((e) => e.type === 'plugin.session_doc.updated')
    .map((e) => (e.payload as { doc: { conversationId: number } }))
}

function badgeDocEvents(): unknown[] {
  return backend.events.filter((e) => e.type === 'plugin.doc.updated' &&
    (e.payload as { doc: { name: string } }).doc.name === 'run-badges')
}

test('真实内核全局流不旁路广播 workflow.updated/settled 的完整输出，内部监听器仍收到终态', { timeout: 60_000 }, async () => {
  const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir })
  const frames: unknown[] = []
  const release = app.kernel.events.subscribe((frame) => frames.push(frame))
  const settled: unknown[] = []
  const offSettled = app.kernel.onEvent('workflow.settled', (payload) => { settled.push(payload) })
  try {
    await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      script: `${META('private-output')}return { privateMarker: 'only-session-projection' }`,
      wait: true,
    }, { conversationId: 1 })
    const doc = app.kernel.plugins.getPublicSessionDoc('builtin:workflow', 'runs', 1)
    assert.match(JSON.stringify(doc.value), /only-session-projection/)
    assert.match(JSON.stringify(settled), /only-session-projection/, '进程内终态监听器收到完整记录')
    assert.doesNotMatch(JSON.stringify(frames), /only-session-projection/, '全局 SSE 不泄露完整运行输出')
    const updates = frames.filter((frame) => (frame as { event: { type: string } }).event.type === 'workflow.updated')
    assert.ok(updates.length > 0, '保留紧凑状态提示')
    for (const frame of updates) {
      const run = (frame as { event: { payload: { run: Record<string, unknown> } } }).event.payload.run
      assert.deepEqual(Object.keys(run).sort(), ['conversationId', 'id', 'status'])
    }
    assert.equal(frames.some((frame) => (frame as { event: { type: string } }).event.type === 'workflow.settled'), false)
  } finally {
    release()
    offSettled()
    await app.close()
  }
})

test('跨会话隔离：每父会话分片只含自己的 run；瞬态投影零持久写入且无全局 runs 文档', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const runIn = async (conversationId: number, name: string) =>
    (await host.invokeAction('builtin:workflow', 'run', { conversationId, script: `${META(name)}return 1` }, { conversationId })) as { run: { id: string } }
  await runIn(1, 'conv-one')
  await runIn(2, 'conv-two')

  const shard1 = readShard(host, 1)
  const shard2 = readShard(host, 2)
  assert.equal(shard1.runs.length, 1, `会话 1 分片恰一条（实际 ${JSON.stringify(shard1)}）`)
  assert.equal(shard2.runs.length, 1, `会话 2 分片恰一条（实际 ${JSON.stringify(shard2)}）`)
  assert.equal(shard1.runs[0]!.conversationId, 1)
  assert.equal(shard2.runs[0]!.conversationId, 2)
  assert.equal(sessionDocs.writes.length, 0, 'runs 为 durable:false 瞬态会话文档，零持久写入')
  assert.equal(docs.store.has('builtin:workflow:runs'), false, '不得写全局 runs 文档')
  assert.equal(docs.store.has('builtin:workflow:run-badges'), false, 'run-badges 为 durable:false 瞬态文档，零持久写入')
  await host.dispose()
})

test('run-badges 全局角标只含导航元数据；摘要不变不重复广播', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const badgeEventsBefore = badgeDocEvents().length
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge')}return 1` }, { conversationId: 1 })
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge2')}return 2` }, { conversationId: 1 })

  const badges = readBadges(host)
  const entry = badges.byConversation['1']
  assert.ok(entry, `角标含会话 1（实际 ${JSON.stringify(badges)}）`)
  assert.equal(entry!['count'], 2, '计数为 2')
  // 只允许导航元数据字段：完整 run 摘要（nodes/output/summary）绝不进入全局层。
  for (const key of Object.keys(entry!)) {
    assert.ok(
      key === 'count' || key === 'tone' || key === 'footerText',
      `run-badges 条目只允许 count/tone/footerText，发现 ${key}`,
    )
  }
  const badgeJson = JSON.stringify(badges)
  assert.ok(!badgeJson.includes('nodes'), '角标不得含节点详情')
  assert.ok(!badgeJson.includes('output'), '角标不得含节点产出')

  // 摘要不变不发事件：第三个 run 到终态后取基线，幂等 abort 不改变投影。
  const stable = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge3')}return 3`, wait: true }, { conversationId: 1 })) as { run: { id: string } }
  const badgeEventsStable = badgeDocEvents().length
  assert.ok(badgeEventsStable > badgeEventsBefore, 'run 变更后角标事件真实广播')
  await host.invokeAction('builtin:workflow', 'abort', { runId: stable.run.id })
  assert.equal(badgeDocEvents().length, badgeEventsStable, '摘要不变不得再发角标事件')
  assert.equal(docs.writes.includes('builtin:workflow:run-badges'), false, '瞬态角标零持久写入')
  await host.dispose()
})

test('分片值不变不发 plugin.session_doc.updated（无事件/写放大）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  // wait: true —— run 到终态后才返回，后续 sync 都是同值投影。
  const { run } = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('stable')}return 1`, wait: true }, { conversationId: 1 })) as { run: { id: string; status: string } }
  assert.equal(run.status, 'completed')
  const eventsAfterRun = sessionDocEvents().length

  // 同值投影：对已终态 run 的 abort 是幂等 no-op；handler 尾部的 syncRunsDoc
  // 必须经值比对跳过写入与事件。
  await host.invokeAction('builtin:workflow', 'abort', { runId: run.id })
  assert.equal(sessionDocEvents().length, eventsAfterRun, '值不变不得再发会话文档事件')
  assert.equal(sessionDocs.writes.length, 0, '瞬态分片零持久写入')
  await host.dispose()
})

test('删除的父会话不重建孤儿 doc；存活会话无 runs 时清到空', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('orphan')}return 1` }, { conversationId: 2 })
  assert.equal(readShard(host, 2).runs.length, 1, '会话 2 分片已写入')

  backend.conversations.delete(2)
  assert.throws(
    () => host.getPublicSessionDoc('builtin:workflow', 'runs', 2),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  // 触发一次投影（会话 1 新 run）：会话 2 的孤儿分片不得被重建。
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('after-del')}return 1` }, { conversationId: 1 })
  assert.equal(
    sessionDocEvents().filter((e) => e.doc.conversationId === 2).length,
    1,
    '删除会话 2 后不得再向会话 2 推送重投影事件',
  )

  await host.dispose()
  const host2 = makeHost()
  docs.store.delete('builtin:workflow:records')
  await host2.register(createWorkflowPlugin())
  const shard1 = readShard(host2, 1)
  assert.deepEqual(shard1.runs, [], '会话存在但无 runs：分片为空（不保留旧投影）')
  await host2.dispose()
})

test('重启（同持久层新 host）：start 后最终投影一致，分片与角标在内存中真实恢复', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const started = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('restart')}return 1`, wait: true }, { conversationId: 1 })) as { run: { id: string; status: string } }
  await host.dispose()

  const host2 = makeHost()
  await host2.register(createWorkflowPlugin())
  const shard = readShard(host2, 1)
  const restored = shard.runs.find((r) => r.id === started.run.id)
  assert.ok(restored, `重启后分片含该 run（实际 ${JSON.stringify(shard)}）`)
  assert.equal(restored!.status, started.run.status, '重启后投影状态一致')
  const badges = readBadges(host2)
  assert.equal(badges.byConversation['1']?.['count'], 1, '重启后角标恢复')
  await host2.dispose()
})

test('sessionDoc 声明与 docs 命名空间隔离：runs 与 run-badges 为瞬态公开文档，持久层只存私有记录', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('ns-check')}return 1`, wait: true }, { conversationId: 1 })
  const globalKeys = [...docs.store.keys()].filter((k) => k.startsWith('builtin:workflow:'))
  assert.equal(globalKeys.includes('builtin:workflow:runs'), false)
  assert.equal(globalKeys.includes('builtin:workflow:run-badges'), false, 'run-badges 为 durable:false 瞬态文档，不落持久层')
  assert.deepEqual(
    globalKeys.filter((k) => !k.endsWith(':records') && !k.endsWith(':subagent-conversations') && !k.endsWith(':worktree-state')),
    [],
    `持久层全局命名空间只存私有记录（实际 ${JSON.stringify(globalKeys)}）`,
  )
  assert.ok(host.getPublicDoc('builtin:workflow', 'run-badges'), 'run-badges 仍作为公开瞬态文档可读')
  assert.ok(host.getPublicSessionDoc('builtin:workflow', 'runs', 1), 'runs 仍作为公开瞬态会话文档可读')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 祖先聚合：分片含自身 + 后代发起的 runs（原始归属保留），角标同步聚合
// ---------------------------------------------------------------------------

/** 事件回调经 PluginHost 任务包装异步执行：等一个微任务 + timer 刻。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

test('祖先聚合：后代发起的 run 进入祖先分片且保留原始归属；角标聚合去重；无关会话不串台', { timeout: 60_000 }, async () => {
  // 树：1 ← 11（受管子会话）；2 独立。
  backend.conversations.set(11, makeConversation(11, 1))
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const runIn = async (conversationId: number, name: string) =>
    (await host.invokeAction('builtin:workflow', 'run', { conversationId, script: `${META(name)}return 1` }, { conversationId })) as { run: { id: string; conversationId: number } }

  const rootRun = await runIn(1, 'root-run')
  const childRun = await runIn(11, 'child-run')

  // 后代 run 进入祖先分片；conversationId 保持原始归属（11，不改写为 1）。
  const shard1 = readShard(host, 1)
  const shard11 = readShard(host, 11)
  assert.equal(shard1.runs.length, 2, `根会话分片含自身 + 后代 run（实际 ${JSON.stringify(shard1.runs.map((r) => r.id))}）`)
  assert.equal(shard11.runs.length, 1, '子会话分片只含自己的 run')
  const projectedChild = shard1.runs.find((r) => r.id === childRun.run.id)
  assert.ok(projectedChild, '后代 run 在根分片中')
  assert.equal(projectedChild!.conversationId, 11, 'run.conversationId 保持原始归属（不改写为投影目标）')
  assert.equal(shard11.runs[0]!.conversationId, 11)
  assert.equal(shard1.runs.some((r) => r.id === rootRun.run.id), true, '自身 run 仍在根分片')

  // 无关会话不串台。
  assert.equal(readShard(host, 2).runs.length, 0, '无关会话分片不含该子树 run')

  // 角标同步祖先聚合：根会话计数含后代 run（按 run.id 去重后即 2）。
  const badges = readBadges(host)
  assert.equal(badges.byConversation['1']?.['count'], 2, `根会话角标聚合后代 run（实际 ${JSON.stringify(badges)}）`)
  assert.equal(badges.byConversation['11']?.['count'], 1, '子会话角标只计自己')
  assert.equal(badges.byConversation['2'], undefined, '无关会话无角标')
  await host.dispose()
})

test('父链环与缺父：不虚构祖先投影，投影有界完成', { timeout: 60_000 }, async () => {
  // 环：4 → 5 → 4；缺父：6 → 999（不存在）。
  backend.conversations.set(4, makeConversation(4, 5))
  backend.conversations.set(5, makeConversation(5, 4))
  backend.conversations.set(6, makeConversation(6, 999))
  const host = makeHost()
  await host.register(createWorkflowPlugin())

  await host.invokeAction('builtin:workflow', 'run', { conversationId: 4, script: `${META('cycle-run')}return 1` }, { conversationId: 4 })
  await host.invokeAction('builtin:workflow', 'run', { conversationId: 6, script: `${META('orphan-run')}return 1` }, { conversationId: 6 })

  // 环：有界完成；4 与 5 互为投影目标（各自的 run 各自可见，不重复、不悬挂）。
  const shard4 = readShard(host, 4)
  const shard5 = readShard(host, 5)
  assert.equal(shard4.runs.length, 1, '环上会话 4 分片有界完成（含自己发起的 run）')
  assert.equal(shard5.runs.length, 1, '环上会话 5 分片有界完成（4 视为其祖先）')
  assert.equal(shard4.runs[0]!.conversationId, 4, '原始归属保留')
  // 缺父：只投自己的分片，不虚构 999 的投影。
  const shard6 = readShard(host, 6)
  assert.equal(shard6.runs.length, 1, '缺父会话分片含自己的 run')
  assert.equal(
    sessionDocEvents().some((e) => e.doc.conversationId === 999),
    false,
    '不虚构缺失祖先的分片事件',
  )
  await host.dispose()
})

test('会话删除事件触发重投影：祖先分片失去该子树 run，孤儿分片不重建', { timeout: 60_000 }, async () => {
  backend.conversations.set(11, makeConversation(11, 1))
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', { conversationId: 11, script: `${META('del-run')}return 1` }, { conversationId: 11 })
  assert.equal(readShard(host, 1).runs.length, 1, '删除前根分片含后代 run')

  // 会话 11 删除 → conversation.deleted 事件 → 重投影。
  backend.conversations.delete(11)
  const eventsFor11Before = sessionDocEvents().filter((e) => e.doc.conversationId === 11).length
  backend.emit('conversation.deleted', { conversationId: 11 })
  await tick()

  assert.equal(readShard(host, 1).runs.length, 0, `删除后根分片失去该子树 run（实际 ${JSON.stringify(readShard(host, 1))}）`)
  assert.equal(
    sessionDocEvents().filter((e) => e.doc.conversationId === 11).length,
    eventsFor11Before,
    '孤儿分片不重建',
  )
  assert.equal(readBadges(host).byConversation['1'], undefined, '角标不再计数已删子树 run')
  await host.dispose()
})

test('conversation.upsert 树未变不重写（无事件放大）；树变化（新增后代会话）后重投影', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('upsert-run')}return 1` }, { conversationId: 1 })
  const eventsBefore = sessionDocEvents().filter((e) => e.doc.conversationId === 1).length

  // 树未变化（仅状态字段更新）：指纹不变，跳过重投影。
  const conv1 = backend.conversations.get(1)!
  backend.conversations.set(1, { ...conv1, status: 'working', stateChangeSeq: conv1.stateChangeSeq + 1 })
  backend.emit('conversation.upsert', { conversation: backend.conversations.get(1) })
  await tick()
  assert.equal(
    sessionDocEvents().filter((e) => e.doc.conversationId === 1).length,
    eventsBefore,
    '树未变不得重复推送分片事件',
  )

  // 新增后代会话（树变化）：重投影执行（幂等——无新 run，值不变不推事件），
  // 但指纹前进；随后该后代的 run 会正确进入根分片。
  backend.conversations.set(11, makeConversation(11, 1))
  backend.emit('conversation.upsert', { conversation: backend.conversations.get(11) })
  await tick()
  await host.invokeAction('builtin:workflow', 'run', { conversationId: 11, script: `${META('upsert-child')}return 2` }, { conversationId: 11 })
  assert.equal(readShard(host, 1).runs.length, 2, '新增后代会话发起的 run 进入根分片')
  assert.equal(readShard(host, 11).runs.length, 1)
  await host.dispose()
})

test('分片瘦身：runs 会话分片剥离大体积 result 并保留 hasResult/resultPreview，inspect 与 runs 动作仍返回完整 result', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const bigLine = `first-line-${'x'.repeat(260)}\nsecond-line-hidden`
  const started = (await host.invokeAction(
    'builtin:workflow',
    'run',
    { conversationId: 1, script: `${META('slim-str')}return ${JSON.stringify(bigLine)}`, wait: true },
    { conversationId: 1 },
  )) as { run: WorkflowRunSummary }

  const shard = host.getPublicSessionDoc('builtin:workflow', 'runs', 1).value as { runs: WorkflowRunSummary[] }
  const projected = shard.runs.find((r) => r.id === started.run.id)
  assert.ok(projected)
  assert.equal('result' in projected, false, 'runs 分片必须剥离原始 result')
  assert.equal(projected.hasResult, true)
  assert.equal(projected.resultPreview?.includes('\n'), false, 'resultPreview 必须单行')
  assert.equal(projected.resultPreview?.length, 200, '超长预览截断至 200 字符')
  assert.equal(projected.resultPreview?.includes('second-line-hidden'), false)

  const inspected = (await host.invokeAction('builtin:workflow', 'inspect', { runId: started.run.id })) as { run: WorkflowRunSummary }
  assert.equal(inspected.run.result, bigLine, 'inspect 仍返回完整原始 result')
  const listed = (await host.invokeAction('builtin:workflow', 'runs', { conversationId: 1 })) as { runs: WorkflowRunSummary[] }
  assert.equal(listed.runs.find((r) => r.id === started.run.id)?.result, bigLine, 'runs 动作仍返回完整原始 result')
  await host.dispose()
})

test('增量投影与 100 条滑窗：upsertRun 零 listRuns 磁盘读，超出 100 条时保留全部 running + 最新终态且角标计数精确', { timeout: 60_000 }, () => {
  let listRunsCalls = 0
  const initialRuns: WorkflowRunSummary[] = [
    {
      id: 'wf_old_running_1',
      name: 'old-running-1',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'wf_old_running_2',
      name: 'old-running-2',
      conversationId: 1,
      status: 'running',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  for (let i = 1; i <= 108; i++) {
    initialRuns.push({
      id: `wf_done_${i}`,
      name: `done-${i}`,
      conversationId: 1,
      status: i === 108 ? 'failed' : 'completed',
      createdAt: 10 + i,
      updatedAt: 10 + i,
      result: { idx: i },
      ...(i === 108 ? { error: 'boom', errorCode: 'workflow_failed', resumable: true } : {}),
    })
  }

  let latestSessionDoc: WorkflowRunSessionDocState | undefined
  let latestBadges: WorkflowRunBadgesDocState = { byConversation: {} }
  const runsDoc = {
    set(_convId: number, value: WorkflowRunSessionDocState) {
      latestSessionDoc = value
    },
    get: () => latestSessionDoc ?? { runs: [] },
    update: () => {},
    delete: () => {},
    listConversationIds: () => [],
    flush: async () => {},
  } as unknown as PluginSessionDocHandle<WorkflowRunSessionDocState>

  const projection = createRunsProjection({
    runsDoc,
    badgesDoc: {
      get: () => latestBadges,
      set: (value: WorkflowRunBadgesDocState) => { latestBadges = value },
      update: () => {},
      flush: async () => {},
    },
    listRuns: () => {
      listRunsCalls += 1
      return initialRuns
    },
    listConversations: () => [{ id: 1 }],
  })

  projection.sync()
  assert.equal(listRunsCalls, 1)
  assert.ok(latestSessionDoc)
  assert.equal(latestSessionDoc.runs.length, MAX_PROJECTED_RUNS_PER_CONVERSATION)
  // 2 条最旧的 running 必须被保留在 100 条分片内
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_old_running_1'), true)
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_old_running_2'), true)
  // 最旧的 10 条 completed（done_1..done_10）滑出窗口，最新的 done_108 仍在窗口首位
  assert.equal(latestSessionDoc.runs[0]?.id, 'wf_done_108')
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_done_1'), false)
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_done_10'), false)
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_done_11'), true)
  // 角标基于全量会话聚合计算，不受 100 条分片截断影响
  assert.equal(latestBadges.byConversation['1']?.count, 110)
  assert.equal(latestBadges.byConversation['1']?.footerText, '2 运行中 · 1 失败')

  // 运行期 upsertRun 单条增量更新：零 listRuns 调用
  projection.upsertRun({
    id: 'wf_old_running_1',
    name: 'old-running-1',
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 999,
    result: 'now-settled',
  })
  assert.equal(listRunsCalls, 1, 'upsertRun 绝不得触发 listRuns 全量磁盘重读')
  assert.equal(latestBadges.byConversation['1']?.footerText, '1 运行中 · 1 失败')
  // wf_old_running_1 变为 createdAt=1 的终态后自然滑出 100 窗口，done_10 补位进入
  assert.equal(latestSessionDoc.runs.length, MAX_PROJECTED_RUNS_PER_CONVERSATION)
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_old_running_1'), false)
  assert.equal(latestSessionDoc.runs.some((r) => r.id === 'wf_done_10'), true)
})

test('conversation.deleted 同时清理受管子代理登记表与已移除 worktree 绑定元数据（保留 active worktree；worktree 绑定归 builtin:worktree 裁剪）', { timeout: 60_000 }, async () => {
  backend.conversations.set(21, makeConversation(21, 1))
  docs.set('builtin:workflow:subagent-conversations', {
    '21': { depth: 1, parentConversationId: 1, maxSubagentDepth: 2, createdAt: 1 },
  })
  docs.set('builtin:worktree:worktree-state', {
    'worktree-agent-bindings': {
      'agent-21': { childId: 21, parentConversationId: 1 },
      'agent-keep': { childId: 22, parentConversationId: 1 },
    },
    'runtime/worktrees': {
      version: 1,
      records: [
        {
          id: 'local:/wt/removed-21',
          nodeId: 'local',
          repoRoot: '/repo',
          path: '/wt/removed-21',
          branch: 'helmx/spawn-21',
          baseBranch: 'main',
          baseCommit: 'abc1234',
          conversationId: 21,
          status: 'removed',
          createdAt: 1,
          removedAt: 2,
        },
        {
          id: 'local:/wt/active-21',
          nodeId: 'local',
          repoRoot: '/repo',
          path: '/wt/active-21',
          branch: 'helmx/spawn-active-21',
          baseBranch: 'main',
          baseCommit: 'abc1234',
          conversationId: 21,
          status: 'active',
          createdAt: 1,
        },
      ],
    },
  })
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.register(createWorktreePlugin())
  const beforeGc = docs.get<Record<string, unknown>>('builtin:workflow:subagent-conversations', {})
  assert.ok('21' in beforeGc, '派生子会话 21 已存在于 subagent-conversations')

  backend.conversations.delete(21)
  backend.emit('conversation.deleted', { type: 'conversation.deleted', conversationId: 21 })
  await tick()

  const afterGc = docs.get<Record<string, unknown>>('builtin:workflow:subagent-conversations', {})
  assert.equal('21' in afterGc, false, '会话删除后必须回收 subagent-conversations 中的孤儿条目')
  const wtAfter = docs.get<Record<string, unknown>>('builtin:worktree:worktree-state', {})
  const bindingsAfter = wtAfter['worktree-agent-bindings'] as Record<string, unknown>
  assert.equal('agent-21' in bindingsAfter, false, '会话删除后必须回收 worktree-agent-bindings 中指向 21 的绑定')
  assert.equal('agent-keep' in bindingsAfter, true, '无关会话绑定保持不变')
  const recordsAfter = (wtAfter['runtime/worktrees'] as { records: Array<{ id: string }> }).records
  assert.deepEqual(
    recordsAfter.map((r) => r.id),
    ['local:/wt/active-21'],
    '已 removed 记录应被裁剪，active 记录必须保留',
  )
  await host.dispose()
})
