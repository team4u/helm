/**
 * plugin document body accumulate guard against line test (doc / sessionDoc  initial / set / update):
 * - JSON serialization result exceeds PLUGIN_DOC_MAX_JSON_BYTES(2 MiB) in write mirror, durable layer
 *   and public event before explicit reject (413 plugin_doc_too_large,details contains
 *   pluginId/name/kind/bytes/maxBytes), old value keep do not change;
 * - boundary value (exactly equals cap) let through;
 * - failed after durable store do not write, public event do not;
 * - PluginDocRegistry construct parameter maxDocJsonBytes can inject more small cap (test friend well,
 *   do not break since has API);
 * - JSON cannot serialization / undefined etc. since has explicit failed behavior keep do not change.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
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
// test base create
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
  assert.ok(caught instanceof HelmError, `expectation HelmError, actual:${String(caught)}`)
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
// global doc
// ---------------------------------------------------------------------------

test('doc initial over limit: register reject plugin_doc_too_large,details complete', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const big = 'x'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) // serialization = cap + 2 byte (quotes)
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

test('doc set/update over limit: reject and old value do not change, durable store do not write, public event do not', { timeout: 60_000 }, async () => {
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
  // normal write publish plugin.doc.updated; after continue over limit failed no longer any event.
  assert.ok(events.some((e) => e.type === 'plugin.doc.updated'))
  const baseline = events.length

  const err = throwsCode(
    () => h.set({ keep: 'v2', blob: 'y'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) }),
    'plugin_doc_too_large',
    413,
  )
  assert.equal((err.details as { kind: string }).kind, 'doc')
  assert.equal(h.get().keep, 'v1', 'old value keep do not change')
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline, 'over limit write do not publish plugin.doc.updated')

  throwsCode(
    () => h.update((s) => ({ ...s, blob: 'z'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(), { keep: 'v1' })
  assert.deepEqual(docs.store.get('p:doc:state'), { keep: 'v1' })
  assert.equal(events.length, baseline)
})

test('doc boundary: serialization exactly equals cap when let through', { timeout: 60_000 }, async () => {
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
  // JSON.stringify("...") = content + 2 quotes; content = cap - 2 when exactly equals cap.
  h.set('a'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get().length, PLUGIN_DOC_MAX_JSON_BYTES - 2)
  h.update(() => 'b'.repeat(PLUGIN_DOC_MAX_JSON_BYTES - 2))
  assert.equal(h.get()[0], 'b')
})

// ---------------------------------------------------------------------------
// conversation sessionDoc
// ---------------------------------------------------------------------------

test('sessionDoc initial over limit: register reject plugin_doc_too_large', { timeout: 60_000 }, async () => {
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

test('sessionDoc set/update over limit: reject and old value do not change, durable layer do not write, event do not', { timeout: 60_000 }, async () => {
  let handle: PluginSessionDocHandle<{ n: number; blob?: string }> | undefined
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: {
      ...makeBackend(),
      getConversation: (id: number) => {
        if (id !== 7) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
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
  assert.equal(events.length, baseline, 'over limit write do not publish plugin.session_doc.updated')

  throwsCode(
    () => h.update(7, (s) => ({ ...s, blob: 'v'.repeat(PLUGIN_DOC_MAX_JSON_BYTES) })),
    'plugin_doc_too_large',
    413,
  )
  assert.deepEqual(h.get(7), { n: 1 })
  assert.equal(events.length, baseline)
})

test('sessionDoc boundary: serialization exactly equals cap when let through', { timeout: 60_000 }, async () => {
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
// construct parameter inject & since has explicit failed behavior
// ---------------------------------------------------------------------------

test('maxDocJsonBytes construct parameter: more small cap takes effect (do not break since has API)', { timeout: 60_000 }, () => {
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

test('by default cap constant is 2 MiB; cannot serialization value keep since has explicit failed', { timeout: 60_000 }, async () => {
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
  // undefined / loop reference:jsonClone boundary explicit failed (since has behavior), is not body accumulate error.
  throwsCode(() => h.set(undefined), 'invalid_json_value')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  throwsCode(() => h.set(circular), 'invalid_json_value')
})
