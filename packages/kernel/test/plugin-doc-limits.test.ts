/**
 * Size guard tests for plugin docs (doc / sessionDoc initial / set / update):
 * - If serialized JSON exceeds PLUGIN_DOC_MAX_JSON_BYTES (2 MiB), rejects explicitly BEFORE
 *   updating mirror, durable store, or public events (413 plugin_doc_too_large, details carry
 *   pluginId/name/kind/bytes/maxBytes) while leaving prior values intact;
 * - Exact boundary values (equal to cap) succeed;
 * - Rejected writes never write to durable store or emit public events;
 * - PluginDocRegistry constructor accepts maxDocJsonBytes for a smaller test cap without breaking
 *   existing APIs;
 * - Existing failure semantics (non-JSON-serializable / undefined, etc.) remain unchanged.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HelmError, type PluginDocHandle, type PluginSessionDocHandle } from '@helm/protocol'
import {
  PluginHost,
  PLUGIN_DOC_MAX_JSON_BYTES,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '../src/plugins/index.js'
import { PluginDocRegistry } from '../src/plugins/doc-registry.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, assertRejectsCode, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

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
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend(), docs, sessionDocs })
}

function throwsCode(fn: () => unknown, code: string, status?: number): HelmError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `expected HelmError, got ${String(caught)}`)
  assert.equal(caught.code, code)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-doc-limits-')
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
  events = []
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// Global doc
// ---------------------------------------------------------------------------

test('doc initial exceeds limit: register rejects with plugin_doc_too_large and complete details', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const big = 'x'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) // serialized = cap + 2 bytes (quotes)
  const err = (await assertRejectsCode(
    () =>
      host.register({
        id: 'p:big',
        definePlugin: (ctx) => {
          ctx.doc('big', big)
        },
      }),
    'plugin_doc_too_large',
    413,
  )) as HelmError
  assert.deepEqual(
    { ...(err.details as Record<string, unknown>) },
    { pluginId: 'p:big', name: 'big', kind: 'doc', bytes: PLUGIN_DOC_MAX_JSON_BYTES + 2, maxBytes: PLUGIN_DOC_MAX_JSON_BYTES },
  )
  assert.equal(host.list().length, 0)
  assert.equal(docs.store.size, 0)
})

test('doc set/update exceeds limit: rejects leaving prior value unchanged, skips durable store and public events', { timeout: 60_000 }, async () => {
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
  // Normal write publishes plugin.doc.updated; subsequent oversized failures must emit no further events.
  assert.ok(events.some((e) => e.type === 'plugin.doc.updated'))
  const baseline = events.length

  const err = throwsCode(
    () => h.set({ keep: 'v2', blob: 'y'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) }),
    'plugin_doc_too_large',
    413,
  )
  assert.equal((err.details as { kind: string }).kind, 'doc')
  assert.equal(h.get().keep, 'v1', 'prior value stays intact')
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline, 'oversized write must not publish plugin.doc.updated')

  throwsCode(
    () => h.update((s) => ({ ...s, blob: 'z'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(), { keep: 'v1' })
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline)
})

test('doc boundary: serialized JSON exactly equal to cap succeeds', { timeout: 60_000 }, async () => {
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
  // JSON.stringify("...") = content + 2 quotes; content = cap - 2 hits the exact cap.
  h.set('a'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get().length, PLUGIN_DOC_MAX_JSON_BYTES - 2)
  h.update(() => 'b'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get()[0], 'b')
})

// ---------------------------------------------------------------------------
// Conversation sessionDoc
// ---------------------------------------------------------------------------

test('sessionDoc initial exceeds limit: register rejects with plugin_doc_too_large', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:sbig',
        definePlugin: (ctx) => {
          ctx.sessionDoc('big', 'q'.repeat(PLUGIN_DOC_MAX_JSON_BYTES))
        },
      }),
    'plugin_doc_too_large',
    413,
  ).then((err) => {
    const details = (err as { details: Record<string, unknown> }).details
    assert.equal(details.kind, 'sessionDoc')
    assert.equal(details.pluginId, 'p:sbig')
    assert.equal(details.maxBytes, PLUGIN_DOC_MAX_JSON_BYTES)
  })
  assert.equal(sessionDocs.store.size, 0)
})

test('sessionDoc set/update exceeds limit: rejects leaving prior value intact, skips durable store and events', { timeout: 60_000 }, async () => {
  let handle: PluginSessionDocHandle<{ n: number; blob?: string }> | undefined
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: {
      ...makeBackend(),
      getConversation: (id: number) => {
        if (id !== 7) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
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
  assert.equal(events.length, baseline, 'oversized write must not publish plugin.session_doc.updated')

  throwsCode(
    () => h.update(7, (s) => ({ ...s, blob: 'v'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(7), { n: 1 })
  assert.equal(events.length, baseline)
})

test('sessionDoc boundary: serialized JSON exactly equal to cap succeeds', { timeout: 60_000 }, async () => {
  let handle: PluginSessionDocHandle<string> | undefined
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
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
// Constructor cap injection & existing explicit failures
// ---------------------------------------------------------------------------

test('maxDocJsonBytes constructor parameter enforces smaller cap without breaking existing API', { timeout: 60_000 }, () => {
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

test('default cap constant is 2 MiB; unserializable values keep existing explicit failures', { timeout: 60_000 }, async () => {
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
  // undefined / cyclic references fail explicitly at the jsonClone boundary (existing behavior), not as size errors.
  throwsCode(() => h.set(undefined), 'invalid_json_value')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  throwsCode(() => h.set(circular), 'invalid_json_value')
})

test('sessionDoc set/update serializes JSON once and preserves full isolation across transient/durable/emit boundaries', { timeout: 60_000 }, () => {
  const sStore = new MemorySessionDocStore()
  const emittedSession: Array<{ value: { nested: { n: number } }; deleted?: boolean }> = []
  const emittedGlobal: Array<{ nested: { n: number } }> = []
  const registry = new PluginDocRegistry(
    new MemoryDocStore(),
    (_pluginId, _name, value) => {
      emittedGlobal.push(value as { nested: { n: number } })
    },
    {
      sessionStore: sStore,
      assertConversationExists: () => {},
      emitSessionDocUpdated: (doc) => {
        emittedSession.push({ value: doc.value as { nested: { n: number } }, deleted: doc.deleted })
      },
    },
  )

  const durableSess = registry.registerSessionDoc('p:opt', 'durable', { nested: { n: 0 } }, { public: true }, () => {})
  const transientSess = registry.registerSessionDoc(
    'p:opt',
    'transient',
    { nested: { n: 0 } },
    { public: true, durable: false },
    () => {},
  )
  const transientDoc = registry.registerDoc(
    'p:opt',
    'tglobal',
    { nested: { n: 0 } },
    { public: true, durable: false },
    () => {},
  )

  // Single JSON.stringify pass per write (reused for both 2 MiB check and store.put).
  const origStringify = JSON.stringify
  let stringifyCalls = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifyCalls += 1
    return origStringify(...args)
  }) as typeof JSON.stringify
  try {
    durableSess.set(1, { nested: { n: 10 } })
    assert.equal(stringifyCalls, 1, 'sessionDoc.set must serialize JSON only once')
    durableSess.update(1, (cur) => ({ nested: { n: cur.nested.n + 5 } }))
    assert.equal(stringifyCalls, 2, 'sessionDoc.update must serialize JSON only once')
  } finally {
    JSON.stringify = origStringify
  }
  assert.equal(sStore.get('p:opt', 'durable', 1), '{"nested":{"n":15}}')
  assert.deepEqual(durableSess.get(1), { nested: { n: 15 } })

  // Transient isolation: mutating caller input, get() output, update() argument, and emitted payloads must not corrupt state.
  const input = { nested: { n: 1 } }
  transientSess.set(1, input)
  input.nested.n = 999
  emittedSession.at(-1)!.value.nested.n = 888
  const read1 = transientSess.get(1)
  read1.nested.n = 777
  assert.deepEqual(transientSess.get(1), { nested: { n: 1 } })

  transientSess.update(1, (cur) => {
    cur.nested.n = 555
    return { nested: { n: 2 } }
  })
  assert.deepEqual(transientSess.get(1), { nested: { n: 2 } })

  transientSess.delete(1)
  emittedSession.at(-1)!.value.nested.n = 666
  assert.deepEqual(transientSess.get(1), { nested: { n: 0 } })

  transientDoc.set({ nested: { n: 3 } })
  emittedGlobal.at(-1)!.nested.n = 444
  transientDoc.get().nested.n = 333
  assert.deepEqual(transientDoc.get(), { nested: { n: 3 } })
})
