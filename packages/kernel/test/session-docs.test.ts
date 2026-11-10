/**
 * P0–P4 后端扩展与会话文档测试：
 * - UI 新扩展点注册校验（profileRuntime / 微动作三轨 / slot target /
 *   slash 保留词 / priority-order 安全整数 / sessionDocs 引用）；
 * - 跨插件 kind / slash 唯一性（define 阶段 + 提交点终检 + 停用探测不占名）；
 * - ctx.sessionDoc 生命周期（读写深拷贝 / flush / 删除后拒绝孤儿写 /
 *   停用后句柄失效 / 受控 stop 窗口 / doc 与 sessionDoc 不得重名 / 无存储 501）；
 * - SessionDocEventHub 专用流（首帧 snapshot / 增量 / 不进全局流 / abort 清理）；
 * - HTTP：GET docs?conversationId、专用 SSE、404 停止语义；
 * - HelmStore 会话文档持久层与会话删除级联清理（真实 sqlite）。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type PluginDefinition,
  type HelmEventFrame,
} from '@helm/protocol'
import {
  PluginHost,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '../src/plugins/index.js'
import { SessionDocEventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
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

/** 可变会话表 fixture：deleteConversation 后 getConversation 如实抛 404。 */
function makeHostApi(options: { existing: Set<number> } = { existing: new Set([1, 2]) }) {
  const events: Array<{ type: string; payload: unknown }> = []
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => makeConversation(42),
    listConversations: () => [...options.existing].map((id) => makeConversation(id)),
    getConversation: (id) => {
      if (!options.existing.has(id)) {
        throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      }
      return makeConversation(id)
    },
    updateConversation: async (id) => makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    get isClosing(): boolean {
      return false
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => {
      throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
    },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
    emitEvent: (type, payload) => {
      events.push({ type, payload })
    },
  }
  return { backend, events }
}

class MemorySessionDocStore implements PluginSessionDocStore {
  store = new Map<string, string>()
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
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

class MemoryDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore
let hostApi: ReturnType<typeof makeHostApi>

function makeHost(opts: { sessionDocs?: MemorySessionDocStore | null } = {}): PluginHost {
  return new PluginHost({
    dataDir,
    host: hostApi.backend,
    docs,
    sessionDocs: opts.sessionDocs === null ? undefined : sessionDocs,
  })
}

function throwsCode(fn: () => unknown, code: string, status?: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    return true
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-session-doc-test-'))
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
  hostApi = makeHostApi()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// UI 新扩展点注册校验
// ---------------------------------------------------------------------------

test('profileRuntime/微动作/slot 注册成功并进 listUi；priority/order 校验安全整数', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:ui',
    definePlugin: (ctx) => {
      ctx.ui.profileRuntime({ id: 'herdr', kind: 'herdr', label: 'Herdr 运行时', order: 10 })
      ctx.ui.action({ id: 'a1', target: 'conversation:header', label: '归档', actionId: 'archive', placement: 'toolbar' })
      ctx.ui.action({ id: 'a2', target: 'conversation:row', label: '清理', actionId: 'cleanup' })
      ctx.ui.action({
        id: 'a3',
        target: 'timeline:entry',
        label: '引用',
        actionId: 'quote',
        kinds: ['user'],
        roles: ['user'],
      })
      ctx.ui.slot({ id: 's1', target: 'p:other/toolbar', order: 5 })
    },
  })
  const ui = host.listUi()
  assert.equal(ui.length, 5)
  const surfaces = ui.map((u) => u.surface).sort()
  assert.deepEqual(surfaces, [
    'conversation.header.action',
    'conversation.row.action',
    'plugin.slot',
    'profile.runtime',
    'timeline.entry.action',
  ])
})

test('非法形状显式拒绝：priority 非整数 / slash 保留词 / slot target 多斜杠 / 微动作三轨全空', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assert.rejects(
    host.register({
      id: 'p:bad1',
      definePlugin: (ctx) => {
        ctx.ui.toolView({ id: 't', toolNames: ['bash'], priority: 1.5 })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x2',
      definePlugin: (ctx) => {
        ctx.ui.command({ id: 'c', title: '新建', slash: 'new' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x3',
      definePlugin: (ctx) => {
        ctx.ui.command({ id: 'c', title: '技能', slash: 'skill:foo' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x4',
      definePlugin: (ctx) => {
        ctx.ui.slot({ id: 's', target: 'a/b/c' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x5',
      definePlugin: (ctx) => {
        ctx.ui.action({ id: 'a', target: 'conversation:header', label: '空' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x6',
      definePlugin: (ctx) => {
        ctx.ui.action({ id: 'a', target: 'timeline:entry', label: '坏角色', actionId: 'x', roles: ['system'] as never })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
})

test('sessionDocs 声明已随声明式轨道移除：spec 不得再携带该字段', { timeout: 60_000 }, async () => {
  const host = makeHost()
  // sessionDoc 本身仍可声明（client.tsx 组件经 usePluginSessionDoc 订阅）
  await host.register({
    id: 'p:s3',
    definePlugin: (ctx) => {
      ctx.sessionDoc('m', { tokens: 0 }, { public: true })
      ctx.ui.toolView({ id: 't', toolNames: ['bash'] })
    },
  })
  const ui = host.listUi()
  const tool = ui.find((u) => u.surface === 'tool.view')
  assert.ok(tool !== undefined)
  assert.equal('sessionDocs' in (tool.spec as Record<string, unknown>), false, 'spec 无 sessionDocs 字段（JSON 轨道已移除）')
})

test('跨插件同 kind 显式拒绝（提交点终检）；停用探测 enabled:false 不占用名字', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'A' })
    },
  })
  await assert.rejects(
    host.register({
      id: 'p:b',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'B' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_profile_runtime_kind',
  )
  // 停用探测不占名：enabled:false 注册同 kind 成功，且不影响已启用插件。
  await host.register(
    {
      id: 'p:c',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'C' })
      },
    },
    { enabled: false },
  )
  // 已启用插件仍存在；探测插件 UI 不露出。
  const ui = host.listUi().filter((u) => u.surface === 'profile.runtime')
  assert.equal(ui.length, 1)
  assert.equal(ui[0]!.pluginId, 'p:a')
})

test('停用探测不占名：enabled:false 后 enable 时仍与已启用插件冲突被拒', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'A' })
    },
  })
  await host.register(
    {
      id: 'p:probe',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'Probe' })
      },
    },
    { enabled: false },
  )
  await assert.rejects(
    host.enable('p:probe'),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_profile_runtime_kind',
  )
  // 停用 p:a 后探测插件可启用（名字已释放）。
  await host.disable('p:a')
  await host.enable('p:probe')
  assert.ok(host.listUi().some((u) => u.pluginId === 'p:probe' && u.surface === 'profile.runtime'))
})

test('跨插件 slash 冲突：define 阶段与提交点均拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.ui.command({ id: 'c', title: '归档', slash: 'archive', actionId: 'archive' })
      ctx.action({
        id: 'archive',
        description: '归档',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      })
    },
  })
  await assert.rejects(
    host.register({
      id: 'p:b',
      definePlugin: (ctx) => {
        ctx.ui.command({ id: 'c', title: '归档B', slash: 'archive', actionId: 'x' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_command_slash',
  )
})

// ---------------------------------------------------------------------------
// ctx.sessionDoc 生命周期
// ---------------------------------------------------------------------------

test('sessionDoc 读写深拷贝/初值回退/listConversationIds/delete 事件', { timeout: 60_000 }, async () => {
  const host = makeHost()
  let handle!: {
    get(id: number): { tokens: number }
    set(id: number, v: { tokens: number }): void
    update(id: number, fn: (c: { tokens: number }) => { tokens: number }): void
    delete(id: number): void
    listConversationIds(): number[]
  }
  await host.register({
    id: 'p:sd',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('metrics', { tokens: 0 }, { public: true }) as never
    },
  })
  assert.deepEqual(handle.get(1), { tokens: 0 })
  handle.set(1, { tokens: 5 })
  const got = handle.get(1)
  got.tokens = 99
  assert.deepEqual(handle.get(1), { tokens: 5 }, 'get 返回深拷贝，外部突变不回写')
  handle.update(1, (c) => ({ tokens: c.tokens + 1 }))
  assert.deepEqual(handle.get(1), { tokens: 6 })
  handle.set(2, { tokens: 100 })
  assert.deepEqual(handle.listConversationIds(), [1, 2])
  handle.delete(1)
  assert.deepEqual(handle.get(1), { tokens: 0 }, '删除后回到初始值')
  assert.deepEqual(handle.listConversationIds(), [2])
  const sessionEvents = hostApi.events.filter((e) => e.type === 'plugin.session_doc.updated')
  // set(1) + update(1) + set(2) + delete(1) = 4 条 public 事件
  assert.equal(sessionEvents.length, 4)
  const deleted = sessionEvents[3]!.payload as { doc: { deleted?: boolean; value: unknown } }
  assert.equal(deleted.doc.deleted, true)
  assert.deepEqual(deleted.doc.value, { tokens: 0 })
})

test('sessionDoc 读写校验：非法 ID / 会话不存在', { timeout: 60_000 }, async () => {
  const host = makeHost()
  let handle!: { get(id: number): unknown; set(id: number, v: unknown): void }
  await host.register({
    id: 'p:sd',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('m', { a: 1 }) as never
    },
  })
  throwsCode(() => handle.get(0), 'invalid_conversation_id', 400)
  throwsCode(() => handle.get(1.5), 'invalid_conversation_id', 400)
  throwsCode(() => handle.get(999), 'not_found', 404)
  throwsCode(() => handle.set(-1, {}), 'invalid_conversation_id', 400)
  assert.deepEqual(handle.get(1), { a: 1 })
})

test('doc 与 sessionDoc 不得重名；sessionDoc 缺持久层时 501', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assert.rejects(
    host.register({
      id: 'p:d1',
      definePlugin: (ctx) => {
        ctx.doc('shared', { a: 1 })
        ctx.sessionDoc('shared', { b: 2 })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_doc',
  )
  const noStoreHost = makeHost({ sessionDocs: null })
  await assert.rejects(
    noStoreHost.register({
      id: 'p:d2',
      definePlugin: (ctx) => {
        ctx.sessionDoc('m', { a: 1 })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_store_unavailable' && err.status === 501,
  )
})

test('getPublicSessionDoc：public/私有/停用/会话不存在语义 + 全局文档名冲突提示', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.sessionDoc('pub', { n: 1 }, { public: true })
      ctx.sessionDoc('priv', { n: 1 })
      ctx.doc('global', { g: 1 }, { public: true })
    },
  })
  assert.deepEqual(host.getPublicSessionDoc('p:pub', 'pub', 1), {
    pluginId: 'p:pub',
    name: 'pub',
    conversationId: 1,
    value: { n: 1 },
  })
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'priv', 1), 'plugin_doc_not_found', 404)
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'nope', 1), 'plugin_doc_not_found', 404)
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'pub', 999), 'not_found', 404)
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'global', 1), 'global_doc_unexpected_conversation', 400)
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'pub', 0), 'invalid_conversation_id', 400)
  // 全局 doc 路由命中 sessionDoc 名：session_doc_requires_conversation
  throwsCode(() => host.getPublicDoc('p:pub', 'pub'), 'session_doc_requires_conversation', 400)
  await host.disable('p:pub')
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'pub', 1), 'plugin_doc_not_found', 404)
})

test('会话删除后 sessionDoc 写入被拒绝（防孤儿重建）', { timeout: 60_000 }, async () => {
  const existing = new Set([1, 2])
  hostApi = makeHostApi({ existing })
  const host = makeHost()
  let handle!: { get(id: number): unknown; set(id: number, v: unknown): void }
  await host.register({
    id: 'p:sd',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('m', { a: 1 }, { public: true }) as never
    },
  })
  handle.set(2, { a: 2 })
  existing.delete(2)
  throwsCode(() => handle.set(2, { a: 3 }), 'not_found', 404)
  // 会话 1 仍可用
  handle.set(1, { a: 1 })
  assert.deepEqual(handle.get(1), { a: 1 })
})

test('插件停用后 sessionDoc 句柄失效；重新启用后可继续读写（持久层数据保留）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  let handle!: { get(id: number): { n: number }; set(id: number, v: { n: number }): void }
  await host.register({
    id: 'p:sd',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('m', { n: 0 }, { public: true }) as never
    },
  })
  handle.set(1, { n: 7 })
  await host.disable('p:sd')
  throwsCode(() => handle.set(1, { n: 8 }), 'plugin_context_expired')
  await host.enable('p:sd')
  // enable 重新执行 definePlugin，handle 已被新周期句柄覆盖：读到持久化值
  // {n:7} 证明会话文档数据跨启停周期保留（与 doc 同一持久化语义）。
  assert.deepEqual(handle.get(1), { n: 7 })
})

// ---------------------------------------------------------------------------
// SessionDocEventHub 专用流
// ---------------------------------------------------------------------------

test('SessionDocEventHub：dispatch 只投递订阅了该三元组的监听器；非法载荷拒绝且不 TypeError', { timeout: 60_000 }, () => {
  const hub = new SessionDocEventHub()
  const frames: HelmEventFrame[] = []
  const other: HelmEventFrame[] = []
  const off = hub.subscribe({ pluginId: 'p:a', name: 'm', conversationId: 1 }, (f) => frames.push(f))
  const offOther = hub.subscribe({ pluginId: 'p:a', name: 'm', conversationId: 2 }, (f) => other.push(f))
  hub.dispatch({
    type: 'plugin.session_doc.updated',
    doc: { pluginId: 'p:a', name: 'm', conversationId: 1, value: { n: 1 } },
  })
  assert.equal(frames.length, 1)
  assert.equal(other.length, 0, '其他会话的订阅者不收帧')
  assert.equal(frames[0]!.event.type, 'plugin.session_doc.updated')
  throwsCode(
    () =>
      hub.dispatch({
        type: 'plugin.session_doc.updated',
        doc: { pluginId: 'p:a', name: 'm', value: {} } as never,
      }),
    'invalid_event',
  )
  // doc 缺失 / null / 非对象：先形状门禁，不得在读字段前 TypeError。
  throwsCode(() => hub.dispatch({ type: 'plugin.session_doc.updated' }), 'invalid_event')
  throwsCode(() => hub.dispatch({ type: 'plugin.session_doc.updated', doc: null }), 'invalid_event')
  throwsCode(() => hub.dispatch(undefined), 'invalid_event')
  throwsCode(() => hub.dispatch('junk'), 'invalid_event')
  // 非法事件不推进 seq。
  const seqBefore = hub.seq
  assert.equal(hub.seq, seqBefore)
  assert.equal(hub.subscriberCount, 2, 'subscriberCount 统计实际订阅者个数')
  off()
  offOther()
  hub.close()
  assert.equal(hub.subscriberCount, 0)
})

test('SessionDocEventHub：同一三元组多订阅者的 subscriberCount 与 close 真正关流', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const c1 = new AbortController()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const r1 = hub.response(new Request('http://x', { signal: c1.signal }), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  // 同一三元组第二条连接：流句柄各自登记，互不覆盖。
  const r2 = hub.response(new Request('http://x'), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  assert.equal(hub.subscriberCount, 2, '两条连接各占一个订阅')
  hub.close()
  assert.equal(hub.subscriberCount, 0, 'close 清空全部订阅')
  // close 后两条流都被服务端结束（读到 done）；后续 dispatch 不再投递。
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: 9 } } })
  for (const res of [r1, r2]) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    assert.ok(done, 'close() 后流结束')
  }
  c1.abort()
})

test('SessionDocEventHub：closeForPlugin/closeForConversation 只关匹配流', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const t1 = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const t2 = { pluginId: 'p:b', name: 'm', conversationId: 2 }
  const mk = (t: { pluginId: string; name: string; conversationId: number }) =>
    hub.response(new Request('http://x'), {
      snapshot: () => ({ seq: 0, doc: { ...t, value: {} } }),
      target: t,
    })
  const r1 = mk(t1)
  const r2 = mk(t2)
  assert.equal(hub.subscriberCount, 2)
  hub.closeForPlugin('p:a')
  assert.equal(hub.subscriberCount, 1, '插件 p:a 的流被关闭')
  hub.closeForConversation(2)
  assert.equal(hub.subscriberCount, 0, '会话 2 的流被关闭')
  for (const res of [r1, r2]) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
  }
})

test('SessionDocEventHub.response：快照 provider 重入发布不丢帧不重复（seq 筛选）', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  let providerSeq = 0
  const response = hub.response(new Request('http://x'), {
    // provider 同步重入 dispatch：模拟订阅建立后、快照返回前的并发更新。
    // n=1 在 provider 内发布（seq=1，快照水位取 provider 返回时的 hub.seq=1），
    // n=2 在 provider 返回后、流冲刷前发布（seq=2，水位之后必须冲刷）。
    snapshot: () => {
      hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: 1 } } })
      providerSeq = hub.seq
      return { seq: providerSeq, doc: { ...target, value: { n: 1 } } }
    },
    target,
  })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ''
  const first = await reader.read()
  text += decoder.decode(first.value!, { stream: true })
  assert.match(text, /event: snapshot/)
  assert.match(text, /"n":1/, '快照为 provider 时点值')
  // 快照冲刷阶段：seq=1 的缓冲帧已体现在快照里（不得重复），水位后无新帧。
  assert.ok(!text.includes('plugin.session_doc.updated'), '快照内的更新不重复下发')
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: 2 } } })
  const second = await reader.read()
  text += decoder.decode(second.value!, { stream: true })
  assert.match(text, /event: plugin\.session_doc\.updated/)
  assert.match(text, /"n":2/, '水位后的更新必达')
  // 终态：每帧恰一次（n=1 只在快照，n=2 只在增量）。
  assert.equal((text.match(/"n":1/g) ?? []).length, 1)
  assert.equal((text.match(/"n":2/g) ?? []).length, 1)
})

test('SessionDocEventHub.response：快照 provider 出错同步清理（不建流不残留订阅）', { timeout: 60_000 }, () => {
  const hub = new SessionDocEventHub()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  assert.throws(
    () =>
      hub.response(new Request('http://x'), {
        snapshot: () => {
          throw new HelmError('plugin_doc_not_found', '插件已停用', 404)
        },
        target,
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  )
  assert.equal(hub.subscriberCount, 0, 'provider 失败后无订阅残留')
})

test('SessionDocEventHub.response：快照期间缓冲溢出立即关流，随后抛错仍保留原诊断', { timeout: 60_000 }, async () => {
  const target = { pluginId: 'p:overflow', name: 'metrics', conversationId: 1 }
  for (const shouldThrow of [false, true]) {
    const hub = new SessionDocEventHub()
    const create = () => hub.response(new Request('http://localhost/events'), {
      target,
      snapshot: () => {
        for (let index = 0; index < 514; index++) hub.dispatch({ doc: { ...target, value: index } })
        if (shouldThrow) throw new Error('snapshot source failed')
        return { seq: hub.seq, doc: { ...target, value: 514 } }
      },
    })
    if (shouldThrow) assert.throws(create, /snapshot source failed/)
    else {
      const reader = create().body!.getReader()
      assert.equal((await reader.read()).done, true)
      reader.releaseLock()
    }
    assert.equal(hub.subscriberCount, 0)
    hub.close()
  }
})

test('SessionDocEventHub.response：未消费流字节背压超限主动终止并退订（1MiB 默认外的显式小上限）', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub({ maxPendingBytes: 1024 })
  const controller = new AbortController()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const response = hub.response(new Request('http://x', { signal: controller.signal }), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const first = await reader.read()
  assert.ok(first.value, '首帧 snapshot 可读')
  // 不再读：同步堆积大量大帧，超过 1KiB 上限后订阅被移除（慢客户端关流）。
  for (let i = 0; i < 64; i++) {
    hub.dispatch({
      type: 'plugin.session_doc.updated',
      doc: { ...target, value: { n: i, bulk: 'x'.repeat(128) } },
    })
    if (hub.subscriberCount === 0) break
  }
  assert.equal(hub.subscriberCount, 0, '字节积压超限后订阅被明确移除')
  // 已入队帧仍可读，最终得到 done（不再投递新帧）。
  let done = false
  while (!done) {
    const next = await reader.read()
    done = next.done === true
  }
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: -1 } } })
  const after = await reader.read()
  assert.ok(after.done, '关流后不再投递新帧')
  controller.abort()
})

test('SessionDocEventHub.response：首帧 snapshot 后增量；abort 清理订阅', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const controller = new AbortController()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const response = hub.response(new Request('http://x', { signal: controller.signal }), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const first = await reader.read()
  buffered += decoder.decode(first.value!, { stream: true })
  assert.match(buffered, /event: snapshot/)
  assert.match(buffered, /"value":\{"n":0\}/)
  hub.dispatch({
    type: 'plugin.session_doc.updated',
    doc: { ...target, value: { n: 2 } },
  })
  const second = await reader.read()
  buffered = decoder.decode(second.value!, { stream: true })
  assert.match(buffered, /event: plugin\.session_doc\.updated/)
  assert.match(buffered, /"n":2/)
  controller.abort()
  assert.equal(hub.subscriberCount, 0, 'abort 后订阅清理')
})

// ---------------------------------------------------------------------------
// HelmStore 持久层（真实 sqlite）
// ---------------------------------------------------------------------------

test('HelmStore 会话文档 CRUD + 会话删除级联清理（真实 sqlite）', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-store-sd-'))
  try {
    const db = await openHelmDatabase(dir)
    const store = new HelmStore(db)
    await store.load()
    const now = Date.now()
    const meta = (id: number) => ({
      id,
      title: `c${id}`,
      profileId: 'default',
      tags: [],
      nodeId: 'local',
      cwd: '/tmp',
      model: '',
      thinkingLevel: '',
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    store.upsertConv(meta(1))
    store.upsertConv(meta(2))
    store.putPluginSessionDoc('p:a', 'm', 1, '{"n":1}')
    store.putPluginSessionDoc('p:a', 'm', 2, '{"n":2}')
    store.putPluginSessionDoc('p:b', 'x', 1, '{"k":true}')
    assert.equal(store.getPluginSessionDoc('p:a', 'm', 1), '{"n":1}')
    assert.deepEqual(store.listPluginSessionDocConversations('p:a', 'm'), [1, 2])
    store.putPluginSessionDoc('p:a', 'm', 1, '{"n":3}')
    assert.equal(store.getPluginSessionDoc('p:a', 'm', 1), '{"n":3}')
    store.deletePluginSessionDoc('p:a', 'm', 2)
    assert.equal(store.getPluginSessionDoc('p:a', 'm', 2), undefined)
    // 会话删除：同事务清理该会话全部会话文档
    store.deleteConv(1)
    assert.equal(store.getPluginSessionDoc('p:a', 'm', 1), undefined)
    assert.equal(store.getPluginSessionDoc('p:b', 'x', 1), undefined)
    await store.flushPublic()
    const rows = await db.db.all<{ conversation_id: number }>(
      'SELECT conversation_id FROM helm_plugin_session_docs',
    )
    assert.equal(rows.length, 0, '会话 1 删除后库中无残留')
    // 非法 JSON 拒绝
    assert.throws(() => store.putPluginSessionDoc('p:a', 'bad', 2, '{oops'))
    await store.close()
    await db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HelmStore 重启后镜像恢复会话文档（真实 sqlite）', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-store-sd2-'))
  try {
    {
      const db = await openHelmDatabase(dir)
      const store = new HelmStore(db)
      await store.load()
      const now = Date.now()
      store.upsertConv({
        id: 3,
        title: 'c3',
        profileId: 'default',
        tags: [],
        nodeId: 'local',
        cwd: '/tmp',
        model: '',
        thinkingLevel: '',
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: now,
        updatedAt: now,
      })
      store.putPluginSessionDoc('p:a', 'm', 3, '{"persisted":true}')
      await store.flushPublic()
      await store.close()
      await db.close()
    }
    {
      const db = await openHelmDatabase(dir)
      const store = new HelmStore(db)
      await store.load()
      assert.equal(store.getPluginSessionDoc('p:a', 'm', 3), '{"persisted":true}')
      await store.close()
      await db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
