/**
 * 插件文档体积防线测试（doc / sessionDoc 的 initial / set / update）：
 * - JSON 序列化结果超过 PLUGIN_DOC_MAX_JSON_BYTES（2 MiB）在写入镜像、持久层
 *   与公共事件之前显式拒绝（413 plugin_doc_too_large，details 含
 *   pluginId/name/kind/bytes/maxBytes），旧值保持不变；
 * - 边界值（恰好等于上限）放行；
 * - 失败后持久 store 不写、公共事件不发；
 * - PluginDocRegistry 构造参数 maxDocJsonBytes 可注入更小上限（测试友好，
 *   不破坏既有 API）；
 * - JSON 不可序列化 / undefined 等既有显式失败行为保持不变。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type PluginDocHandle, type PluginSessionDocHandle } from '@helm/protocol'
import {
  PluginHost,
  PLUGIN_DOC_MAX_JSON_BYTES,
  type PluginDocStore,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '../src/plugins/index.js'
import { PluginDocRegistry } from '../src/plugins/doc-registry.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
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
    return [...this.store.keys()]
      .filter((k) => k.startsWith(`${pluginId}\0${name}\0`))
      .map((k) => Number(k.split('\0')[2]))
      .sort((a, b) => a - b)
  }
  deletePlugin(pluginId: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${pluginId}\0`)) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore
let events: Array<{ type: string; payload: unknown }>

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    getConversation: () => {
      throw new HelmError('not_found', 'unused', 404)
    },
    emitEvent: (type, payload) => {
      events.push({ type, payload })
    },
  }
}

function makeHost(): PluginHost {
  return new PluginHost({ dataDir, host: makeBackend(), docs, sessionDocs })
}

function throwsCode(fn: () => unknown, code: string, status?: number): HelmError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `期望 HelmError，实际：${String(caught)}`)
  assert.equal(caught.code, code)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<HelmError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `期望 HelmError，实际：${String(caught)}`)
  assert.equal(caught.code, code)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-doc-limits-'))
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
  events = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 全局 doc
// ---------------------------------------------------------------------------

test('doc initial 超限：注册拒绝 plugin_doc_too_large，details 完整', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const big = 'x'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) // 序列化 = 上限 + 2 字节（引号）
  await rejectsCode(
    host.register({
      id: 'p:big',
      definePlugin: (ctx) => {
        ctx.doc('big', big)
      },
    }),
    'plugin_doc_too_large',
    413,
  ).then((err) => {
    assert.deepEqual(
      { ...(err.details as Record<string, unknown>) },
      { pluginId: 'p:big', name: 'big', kind: 'doc', bytes: PLUGIN_DOC_MAX_JSON_BYTES + 2, maxBytes: PLUGIN_DOC_MAX_JSON_BYTES },
    )
  })
  assert.equal(host.list().length, 0)
  assert.equal(docs.store.size, 0)
})

test('doc set/update 超限：拒绝且旧值不变、持久 store 不写、公共事件不发', { timeout: 60_000 }, async () => {
  let handle: PluginDocHandle<{ keep: string; blob?: string }> | undefined
  const host = makeHost()
  await host.register({
    id: 'p:doc',
    definePlugin: (ctx) => {
      handle = ctx.doc('state', { keep: 'old' }, { public: true })
    },
  })
  assert.ok(handle)
  const h = handle
  h.set({ keep: 'v1' })
  // 正常写入发布 plugin.doc.updated；后续超限失败不再发任何事件。
  assert.ok(events.some((e) => e.type === 'plugin.doc.updated'))
  const baseline = events.length

  const err = throwsCode(
    () => h.set({ keep: 'v2', blob: 'y'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) }),
    'plugin_doc_too_large',
    413,
  )
  assert.equal((err.details as { kind: string }).kind, 'doc')
  assert.equal(h.get().keep, 'v1', '旧值保持不变')
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline, '超限写入不发布 plugin.doc.updated')

  throwsCode(
    () => h.update((s) => ({ ...s, blob: 'z'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(), { keep: 'v1' })
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline)
})

test('doc 边界：序列化恰好等于上限时放行', { timeout: 60_000 }, async () => {
  let handle: PluginDocHandle<string> | undefined
  const host = makeHost()
  await host.register({
    id: 'p:edge',
    definePlugin: (ctx) => {
      handle = ctx.doc('edge', '')
    },
  })
  assert.ok(handle)
  const h = handle
  // JSON.stringify("...") = 内容 + 2 个引号；内容 = 上限 - 2 时恰好等于上限。
  h.set('a'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get().length, PLUGIN_DOC_MAX_JSON_BYTES - 2)
  h.update(() => 'b'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get()[0], 'b')
})

// ---------------------------------------------------------------------------
// 会话 sessionDoc
// ---------------------------------------------------------------------------

test('sessionDoc initial 超限：注册拒绝 plugin_doc_too_large', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await rejectsCode(
    host.register({
      id: 'p:sbig',
      definePlugin: (ctx) => {
        ctx.sessionDoc('big', 'q'.repeat(PLUGIN_DOC_MAX_JSON_BYTES))
      },
    }),
    'plugin_doc_too_large',
    413,
  ).then((err) => {
    const details = err.details as Record<string, unknown>
    assert.equal(details.kind, 'sessionDoc')
    assert.equal(details.pluginId, 'p:sbig')
    assert.equal(details.maxBytes, PLUGIN_DOC_MAX_JSON_BYTES)
  })
  assert.equal(sessionDocs.store.size, 0)
})

test('sessionDoc set/update 超限：拒绝且旧值不变、持久层不写、事件不发', { timeout: 60_000 }, async () => {
  let handle: PluginSessionDocHandle<{ n: number; blob?: string }> | undefined
  const host = new PluginHost({
    dataDir,
    host: {
      ...makeBackend(),
      getConversation: (id: number) => {
        if (id !== 7) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
        return { id } as never
      },
    },
    docs,
    sessionDocs,
  })
  await host.register({
    id: 'p:sdoc',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('runs', { n: 0 }, { public: true })
    },
  })
  assert.ok(handle)
  const h = handle
  h.set(7, { n: 1 })
  const baseline = events.length

  const err = throwsCode(
    () => h.set(7, { n: 2, blob: 'w'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) }),
    'plugin_doc_too_large',
    413,
  )
  const details = err.details as Record<string, unknown>
  assert.equal(details.kind, 'sessionDoc')
  assert.equal(details.conversationId, 7)
  assert.deepEqual(h.get(7), { n: 1 })
  assert.equal(sessionDocs.store.get(`p:sdoc\0runs\0${7}`), JSON.stringify({ n: 1 }))
  assert.equal(events.length, baseline, '超限写入不发布 plugin.session_doc.updated')

  throwsCode(
    () => h.update(7, (s) => ({ ...s, blob: 'v'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(7), { n: 1 })
  assert.equal(events.length, baseline)
})

test('sessionDoc 边界：序列化恰好等于上限时放行', { timeout: 60_000 }, async () => {
  let handle: PluginSessionDocHandle<string> | undefined
  const host = new PluginHost({
    dataDir,
    host: {
      ...makeBackend(),
      getConversation: (id: number) => ({ id } as never),
    },
    docs,
    sessionDocs,
  })
  await host.register({
    id: 'p:sedge',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('edge', '')
    },
  })
  assert.ok(handle)
  const h = handle
  h.set(3, 'c'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get(3).length, PLUGIN_DOC_MAX_JSON_BYTES - 2)
})

// ---------------------------------------------------------------------------
// 构造参数注入 & 既有显式失败行为
// ---------------------------------------------------------------------------

test('maxDocJsonBytes 构造参数：更小上限生效（不破坏既有 API）', { timeout: 60_000 }, () => {
  const store = new MemoryDocStore()
  const registry = new PluginDocRegistry(
    store,
    () => {},
    { maxDocJsonBytes: 64 },
  )
  let handle: PluginDocHandle<string> | undefined
  handle = registry.registerDoc('p:small', 'blob', '', undefined, () => {})
  handle.set('a'.repeat(61)) // 61 + 2 = 63 <= 64
  const err = throwsCode(() => handle.set('a'.repeat(63)), 'plugin_doc_too_large', 413)
  assert.equal((err.details as { maxBytes: number }).maxBytes, 64)
  assert.equal(handle.get().length, 61)
  assert.equal(store.get('p:small:blob', '').length, 61)
})

test('默认上限常量为 2 MiB；不可序列化值保持既有显式失败', { timeout: 60_000 }, async () => {
  assert.equal(PLUGIN_DOC_MAX_JSON_BYTES, 2 * 1024 * 1024)
  let handle: PluginDocHandle<unknown> | undefined
  const host = makeHost()
  await host.register({
    id: 'p:json',
    definePlugin: (ctx) => {
      handle = ctx.doc('val', 0)
    },
  })
  assert.ok(handle)
  const h = handle
  // undefined / 循环引用：jsonClone 边界显式失败（既有行为），不是体积错误。
  throwsCode(() => h.set(undefined), 'invalid_json_value')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  throwsCode(() => h.set(circular), 'invalid_json_value')
})
