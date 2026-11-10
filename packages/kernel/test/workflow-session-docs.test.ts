/**
 * builtin:workflow runs 会话分片投影契约测试：
 * - 跨会话隔离：每父会话分片只含自己的 run，绝不串台；
 * - 全局 run-badges 只含 count/tone/footerText 导航元数据，无完整 run 摘要，
 *   且摘要不变不写（无重复 plugin.doc.updated 事件）；
 * - 分片值不变不发 plugin.session_doc.updated（无写放大）；
 * - 删除的父会话不重建孤儿 doc（会话不存在时跳过；已持久分片在会话仍存在
 *   但无 runs 时清到空）；
 * - 重启（新 host 同持久层）start 后最终投影与会话分片一致。
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type PluginSessionDocHandle,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'
import { createHelm } from '../src/app.js'

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

class FakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  events: Array<{ type: string; payload: unknown }> = []
  constructor() {
    this.conversations.set(1, makeConversation(1))
    this.conversations.set(2, makeConversation(2))
  }
  dispatchTrigger(): Promise<void> { return Promise.resolve() }
  submitInput(): Promise<void> { return Promise.resolve() }
  createConversation(): Promise<ConversationSummary> { return Promise.resolve(makeConversation(99)) }
  listConversations(): ConversationSummary[] { return [...this.conversations.values()] }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> { return Promise.resolve(this.getConversation(id)) }
  abortConversation(): Promise<void> { return Promise.resolve() }
  getConversationActivity(): { consecutiveErrors: number } { return { consecutiveErrors: 0 } }
  getConversationOwnership(): 'helm' | 'bot' | 'human' { return 'human' }
  get isClosing(): boolean { return false }
  spawnAgent(): Promise<unknown> { return Promise.resolve('spawned') }
  runGate(): Promise<{ ok: boolean; output: string }> { return Promise.resolve({ ok: true, output: '' }) }
  prepareInterruptedConversations(): Promise<void> { return Promise.resolve() }
  cleanupWorktree(): Promise<{ removed: boolean; worktreeId: string; path: string; branch: string; nodeId: string; branchDeleted: boolean }> {
    return Promise.resolve({ removed: true, worktreeId: 'local:/x', path: '/x', branch: 'b', nodeId: 'local', branchDeleted: false })
  }
  invokeAction(): Promise<unknown> { return Promise.resolve({}) }
  prepareAction(): { idempotent: boolean } { return { idempotent: false } }
  execEnv(): Promise<never> { return Promise.reject(new HelmError('unsupported', '本 fixture 不执行节点命令', 501)) }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  listActions(): never[] { return [] }
  manageConversation(): () => void { return () => {} }
  markConversationOwnership(): void {}
  createAsk(): Promise<never> { return Promise.reject(new HelmError('unsupported', '测试后端不提供 ask', 501)) }
  cancelAsk(): Promise<void> { return Promise.resolve() }
  registerAskSeqResolver(): () => void { return () => {} }
  onEvent(): () => void { return () => {} }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  writes: string[] = []
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : structuredClone(initial)
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
    this.writes.push(key)
  }
  async flush(): Promise<void> {}
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
  return new PluginHost({ dataDir, host: backend, docs, sessionDocs })
}

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-shard-'))
  backend = new FakeBackend()
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** 读会话分片（JSON 或 undefined）。 */
function readShard(convId: number): { runs: Array<{ id: string; status: string; conversationId: number }> } | undefined {
  const raw = sessionDocs.get('builtin:workflow', 'runs', convId)
  return raw === undefined ? undefined : (JSON.parse(raw) as { runs: Array<{ id: string; status: string; conversationId: number }> })
}

function readBadges(): { byConversation: Record<string, Record<string, unknown>> } {
  return docs.get<{ byConversation: Record<string, Record<string, unknown>> }>('builtin:workflow:run-badges', { byConversation: {} })
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
  const app = await createHelm({ dataDir, cwd: dataDir })
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

test('跨会话隔离：每父会话分片只含自己的 run；全局 runs 文档不再存在', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const runIn = async (conversationId: number, name: string) =>
    (await host.invokeAction('builtin:workflow', 'run', { conversationId, script: `${META(name)}return 1` }, { conversationId })) as { run: { id: string } }
  await runIn(1, 'conv-one')
  await runIn(2, 'conv-two')

  const shard1 = readShard(1)
  const shard2 = readShard(2)
  assert.equal(shard1?.runs.length, 1, `会话 1 分片恰一条（实际 ${JSON.stringify(shard1)}）`)
  assert.equal(shard2?.runs.length, 1, `会话 2 分片恰一条（实际 ${JSON.stringify(shard2)}）`)
  assert.equal(shard1!.runs[0]!.conversationId, 1)
  assert.equal(shard2!.runs[0]!.conversationId, 2)
  // 全局 runs 文档（旧形态）不再写入：完整 run 摘要不进全局命名空间。
  assert.equal(docs.store.has('builtin:workflow:runs'), false, '不得再写全局 runs 文档')
  await host.dispose()
})

test('run-badges 全局角标只含导航元数据；摘要不变不重复写', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const badgeWritesBefore = docs.writes.filter((k) => k === 'builtin:workflow:run-badges').length
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge')}return 1` }, { conversationId: 1 })
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge2')}return 2` }, { conversationId: 1 })

  const badges = readBadges()
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
  const badgeJson = JSON.stringify(docs.get('builtin:workflow:run-badges', { byConversation: {} }))
  assert.ok(!badgeJson.includes('nodes'), '角标不得含节点详情')
  assert.ok(!badgeJson.includes('output'), '角标不得含节点产出')

  // 摘要不变不写：第三个 run 到终态后取基线，幂等 abort 不改变投影
  // → 不得新增角标写入与事件。
  const stable = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('badge3')}return 3`, wait: true }, { conversationId: 1 })) as { run: { id: string } }
  const badgeWritesStable = docs.writes.filter((k) => k === 'builtin:workflow:run-badges').length
  const badgeEventsStable = badgeDocEvents().length
  assert.ok(badgeWritesStable > badgeWritesBefore, 'run 变更后角标真实写入')
  await host.invokeAction('builtin:workflow', 'abort', { runId: stable.run.id })
  assert.equal(
    docs.writes.filter((k) => k === 'builtin:workflow:run-badges').length,
    badgeWritesStable,
    `幂等 abort 不改变摘要：不得再写角标（实际新增 ${docs.writes.filter((k) => k === 'builtin:workflow:run-badges').length - badgeWritesStable} 次）`,
  )
  assert.equal(badgeDocEvents().length, badgeEventsStable, '摘要不变不得再发角标事件')
  await host.dispose()
})

test('分片值不变不发 plugin.session_doc.updated（无写放大）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  // wait: true —— run 到终态后才返回，后续 sync 都是同值投影。
  const { run } = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('stable')}return 1`, wait: true }, { conversationId: 1 })) as { run: { id: string; status: string } }
  assert.equal(run.status, 'completed')
  const eventsAfterRun = sessionDocEvents().length
  const writesAfterRun = sessionDocs.writes.filter((k) => k === 'builtin:workflow:runs:1').length

  // 同值投影：对已终态 run 的 abort 是幂等 no-op；handler 尾部的 syncRunsDoc
  // 必须经值比对跳过写入与事件（无写放大）。
  await host.invokeAction('builtin:workflow', 'abort', { runId: run.id })
  assert.equal(sessionDocEvents().length, eventsAfterRun, '值不变不得再发会话文档事件')
  assert.equal(
    sessionDocs.writes.filter((k) => k === 'builtin:workflow:runs:1').length,
    writesAfterRun,
    '值不变不得再写持久层',
  )
  await host.dispose()
})

test('删除的父会话不重建孤儿 doc；已持久分片无 runs 时清到空', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('orphan')}return 1` }, { conversationId: 2 })
  assert.ok(readShard(2), '会话 2 分片已写入')

  // 会话 2 删除：store 级联清理（真实 HelmStore 同事务删除）；此处直接模拟
  // 后续 sync——插件侧只依赖 listConversations 存在集合过滤，不重建分片。
  backend.conversations.delete(2)
  sessionDocs.delete('builtin:workflow', 'runs', 2)
  // 触发一次投影（会话 1 新 run）：会话 2 的孤儿分片不得被重建。
  await host.invokeAction('builtin:workflow', 'run', { script: `${META('after-del')}return 1` }, { conversationId: 1 })
  assert.equal(sessionDocs.get('builtin:workflow', 'runs', 2), undefined, '删除会话后不得重建孤儿分片')

  // 已持久分片但 run 已不在（模拟引擎记录清空）：会话仍在 → 清到空分片。
  // 通过 dispose+reopen 用空 records 持久层模拟：直接构造第二 host。
  await host.dispose()
  const host2 = makeHost()
  docs.store.delete('builtin:workflow:records')
  await host2.register(createWorkflowPlugin())
  const shard1 = readShard(1)
  assert.ok(shard1, '会话 1 分片仍存在')
  assert.deepEqual(shard1!.runs, [], '会话存在但无 runs：分片清到空（不保留旧投影）')
  await host2.dispose()
})

test('重启（同持久层新 host）：start 后最终投影一致，分片与角标真实恢复', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  const started = (await host.invokeAction('builtin:workflow', 'run', { script: `${META('restart')}return 1`, wait: true }, { conversationId: 1 })) as { run: { id: string; status: string } }
  await host.dispose()

  const host2 = makeHost()
  await host2.register(createWorkflowPlugin())
  const shard = readShard(1)
  const restored = shard?.runs.find((r) => r.id === started.run.id)
  assert.ok(restored, `重启后分片含该 run（实际 ${JSON.stringify(shard)}）`)
  assert.equal(restored!.status, started.run.status, '重启后投影状态一致')
  const badges = readBadges()
  assert.equal(badges.byConversation['1']?.['count'], 1, '重启后角标恢复')
  await host2.dispose()
})

test('sessionDoc 声明与 docs 命名空间隔离：runs 为会话文档，records 保持私有全局', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(createWorkflowPlugin())
  // UI 声明合法性（sessionDocs 引用 public sessionDoc）在注册边界已通过（未抛）。
  // 全局层只应存在 records（私有）与 run-badges（public）。
  const globalKeys = [...docs.store.keys()].filter((k) => k.startsWith('builtin:workflow:'))
  assert.deepEqual(
    globalKeys.filter((k) => !k.endsWith(':records')).sort(),
    ['builtin:workflow:run-badges'],
    `全局命名空间只留 records 与 run-badges（实际 ${JSON.stringify(globalKeys)}）`,
  )
  await host.dispose()
})
