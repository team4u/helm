/**
 * P0-P4 backend extend and conversation document test:
 * - UI new extension point register validate (profileRuntime / micro action three track / slot target /
 *   slash keep term / priority-order security integer / sessionDocs reference);
 * - across plugin kind / slash uniqueness (define phase + commit point final inspect + deactivate probe do not occupy name);
 * - ctx.sessionDoc lifecycle (read write deep copy / flush / after deletion reject orphan child write /
 *   deactivate after handle expires / subject to control stop window / doc and sessionDoc must not heavy name / without store 501);
 * - SessionDocEventHub dedicated use stream (first frame snapshot / incremental / does not enter global stream / abort clean up);
 * - HTTP:GET docs?conversationId, dedicated use SSE,404 stop semantics;
 * - HelmStore conversation document durable layer and conversation delete level join clean up (real sqlite).
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HelmError,
  type PluginDefinition,
  type HelmEventFrame,
  type SessionDocMultiplexFrame,
  type SessionDocSubscription,
} from '@helm/protocol'
import {
  PluginHost,
  type PluginDocStore,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '../src/plugins/index.js'
import { PluginDocRegistry } from '../src/plugins/doc-registry.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { SessionDocEventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import {
  MemoryDocStore,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
  waitFor,
} from './helpers.js'

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' })
}

/** can change conversation table fixture:deleteConversation after getConversation such as throw 404. */
function makeHostApi(options: { existing: Set<number> } = { existing: new Set([1, 2]) }) {
  const events: Array<{ type: string; payload: unknown }> = []
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => makeConversation(42),
    listConversations: () => [...options.existing].map((id) => makeConversation(id)),
    getConversation: (id) => {
      if (!options.existing.has(id)) {
        throw new HelmError('not_found', `conversation missing: ${id}`, 404)
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
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => {
      throw new HelmError('unsupported', 'this fixture do not execute node command', 501)
    },
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
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\u0000`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore
let hostApi: ReturnType<typeof makeHostApi>

function makeHost(opts: { sessionDocs?: MemorySessionDocStore | null } = {}): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: hostApi.backend,
    docs,
    sessionDocs: opts.sessionDocs === null ? undefined : sessionDocs,
  })
}

function throwsCode(fn: () => unknown, code: string, status?: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    return true
  })
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-session-doc-test-')
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
  hostApi = makeHostApi()
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// UI new extension point register validate
// ---------------------------------------------------------------------------

test('profileRuntime/micro action/slot register succeeded and enter listUi;priority/order validate security integer', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:ui',
    definePlugin: (ctx) => {
      ctx.ui.profileRuntime({ id: 'herdr', kind: 'herdr', label: 'Herdr runtime', order: 10 })
      ctx.ui.action({ id: 'a1', target: 'conversation:header', label: 'archive', actionId: 'archive', placement: 'toolbar' })
      ctx.ui.action({ id: 'a2', target: 'conversation:row', label: 'clean up', actionId: 'cleanup' })
      ctx.ui.action({
        id: 'a3',
        target: 'timeline:entry',
        label: 'reference',
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

test('illegal shape explicit reject:priority non- integer / slash keep term / slot target many slash / micro action three track all empty', { timeout: 60_000 }, async () => {
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
        ctx.ui.command({ id: 'c', title: 'creates new', slash: 'new' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x3',
      definePlugin: (ctx) => {
        ctx.ui.command({ id: 'c', title: 'skill', slash: 'skill:foo' })
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
        ctx.ui.action({ id: 'a', target: 'conversation:header', label: 'empty' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
  await assert.rejects(
    host.register({
      id: 'p:x6',
      definePlugin: (ctx) => {
        ctx.ui.action({ id: 'a', target: 'timeline:entry', label: 'broken role', actionId: 'x', roles: ['system'] as never })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
})

test('sessionDocs declaration already follow declaration style track path remove:spec must not again carry the field', { timeout: 60_000 }, async () => {
  const host = makeHost()
  // sessionDoc itself still can declaration (client.tsx component via usePluginSessionDoc subscribe)
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
  assert.equal('sessionDocs' in (tool.spec as Record<string, unknown>), false, 'spec without sessionDocs field (JSON track path already remove)')
})

test('across plugin same kind explicit reject (commit point final inspect); deactivate probe enabled:false does not occupy name', { timeout: 60_000 }, async () => {
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
  // deactivate probe do not occupy name:enabled:false register same kind succeeded, and does not affect enabled plugin.
  await host.register(
    {
      id: 'p:c',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'r', kind: 'herdr', label: 'C' })
      },
    },
    { enabled: false },
  )
  // enabled plugin still store in; probe plugin UI do not expose out.
  const ui = host.listUi().filter((u) => u.surface === 'profile.runtime')
  assert.equal(ui.length, 1)
  assert.equal(ui[0]!.pluginId, 'p:a')
})

test('deactivate probe do not occupy name:enabled:false after enable when still and enabled plugin conflict by refuse', { timeout: 60_000 }, async () => {
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
  // deactivate p:a after probe plugin can enable (name already release).
  await host.disable('p:a')
  await host.enable('p:probe')
  assert.ok(host.listUi().some((u) => u.pluginId === 'p:probe' && u.surface === 'profile.runtime'))
})

test('across plugin slash conflict:define phase and commit point all reject', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.ui.command({ id: 'c', title: 'archive', slash: 'archive', actionId: 'archive' })
      ctx.action({
        id: 'archive',
        description: 'archive',
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
        ctx.ui.command({ id: 'c', title: 'archiveB', slash: 'archive', actionId: 'x' })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_command_slash',
  )
})

// ---------------------------------------------------------------------------
// ctx.sessionDoc lifecycle
// ---------------------------------------------------------------------------

test('sessionDoc read write deep copy/initial value fall back/listConversationIds/delete event', { timeout: 60_000 }, async () => {
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
  assert.deepEqual(handle.get(1), { tokens: 5 }, 'get return deep copy, external sudden change do not back write')
  handle.update(1, (c) => ({ tokens: c.tokens + 1 }))
  assert.deepEqual(handle.get(1), { tokens: 6 })
  handle.set(2, { tokens: 100 })
  assert.deepEqual(handle.listConversationIds(), [1, 2])
  handle.delete(1)
  assert.deepEqual(handle.get(1), { tokens: 0 }, 'after deletion back to initial value')
  assert.deepEqual(handle.listConversationIds(), [2])
  const sessionEvents = hostApi.events.filter((e) => e.type === 'plugin.session_doc.updated')
  // set(1) + update(1) + set(2) + delete(1) = 4  public event
  assert.equal(sessionEvents.length, 4)
  const deleted = sessionEvents[3]!.payload as { doc: { deleted?: boolean; value: unknown } }
  assert.equal(deleted.doc.deleted, true)
  assert.deepEqual(deleted.doc.value, { tokens: 0 })
})

test('sessionDoc read write validate: illegal ID / conversation missing', { timeout: 60_000 }, async () => {
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

test('doc and sessionDoc must not heavy name;sessionDoc missing durable layer when 501', { timeout: 60_000 }, async () => {
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

test('getPublicSessionDoc:public/private/deactivate/conversation missing semantics + global document name conflict hint', { timeout: 60_000 }, async () => {
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
  // global doc routing hit sessionDoc name:session_doc_requires_conversation
  throwsCode(() => host.getPublicDoc('p:pub', 'pub'), 'session_doc_requires_conversation', 400)
  await host.disable('p:pub')
  throwsCode(() => host.getPublicSessionDoc('p:pub', 'pub', 1), 'plugin_doc_not_found', 404)
})

test('conversation after deletion sessionDoc write by reject (guard against orphan child rebuild)', { timeout: 60_000 }, async () => {
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
  // conversation 1 still available
  handle.set(1, { a: 1 })
  assert.deepEqual(handle.get(1), { a: 1 })
})

test('plugin deactivate after sessionDoc handle expires; re- enable after can continue read write (durable layer data keep)', { timeout: 60_000 }, async () => {
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
  // enable re- execute definePlugin,handle already by new cycle handle override: read to persist value
  // {n:7} verify conversation document data across start stop cycle keep (and doc the same persist semantics).
  assert.deepEqual(handle.get(1), { n: 7 })
})

// ---------------------------------------------------------------------------
// SessionDocEventHub dedicated use stream
// ---------------------------------------------------------------------------

test('SessionDocEventHub:dispatch only delivery subscribe the three meta group listener; illegal payload reject and do not TypeError', { timeout: 60_000 }, () => {
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
  assert.equal(other.length, 0, 'other conversation subscribe do not frame')
  assert.equal(frames[0]!.event.type, 'plugin.session_doc.updated')
  throwsCode(
    () =>
      hub.dispatch({
        type: 'plugin.session_doc.updated',
        doc: { pluginId: 'p:a', name: 'm', value: {} } as never,
      }),
    'invalid_event',
  )
  // doc missing / null / non- object: first shape gate, must not in read field before TypeError.
  throwsCode(() => hub.dispatch({ type: 'plugin.session_doc.updated' }), 'invalid_event')
  throwsCode(() => hub.dispatch({ type: 'plugin.session_doc.updated', doc: null }), 'invalid_event')
  throwsCode(() => hub.dispatch(undefined), 'invalid_event')
  throwsCode(() => hub.dispatch('junk'), 'invalid_event')
  // illegal event do not push enter seq.
  const seqBefore = hub.seq
  assert.equal(hub.seq, seqBefore)
  assert.equal(hub.subscriberCount, 2, 'subscriberCount count actual subscribe count')
  off()
  offOther()
  hub.close()
  assert.equal(hub.subscriberCount, 0)
})

test('SessionDocEventHub: the same three meta group many subscribe subscriberCount and close truly closure stream', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const c1 = new AbortController()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const r1 = hub.response(new Request('http://x', { signal: c1.signal }), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  // the same three meta group second connect: stream handle each register, mutual does not override.
  const r2 = hub.response(new Request('http://x'), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  assert.equal(hub.subscriberCount, 2, 'two connect each occupy a subscribe')
  hub.close()
  assert.equal(hub.subscriberCount, 0, 'close empty all subscribe')
  // close after two stream all by server side end (read to done); after continue dispatch no longer delivery.
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: 9 } } })
  for (const res of [r1, r2]) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    assert.ok(done, 'close() after stream end')
  }
  c1.abort()
})

test('SessionDocEventHub:closeForPlugin/closeForConversation only closure match stream', { timeout: 60_000 }, async () => {
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
  assert.equal(hub.subscriberCount, 1, 'plugin p:a stream by close')
  hub.closeForConversation(2)
  assert.equal(hub.subscriberCount, 0, 'conversation 2 stream by close')
  for (const res of [r1, r2]) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
  }
})

test('SessionDocEventHub.response: snapshot provider heavy publish do not lose frame does not repeat (seq filter choose)', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  let providerSeq = 0
  const response = hub.response(new Request('http://x'), {
    // provider sync heavy dispatch: simulated subscribe establish after, snapshot return before concurrency update.
    // n=1 in provider inside publish (seq=1, snapshot watermark take provider return when hub.seq=1),
    // n=2 in provider return after, stream conflict refresh before publish (seq=2, watermark after must conflict refresh).
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
  assert.match(text, /"n":1/, 'snapshot is provider when point value')
  // snapshot conflict refresh phase:seq=1 buffer frame already body now snapshot in (must not duplicate), watermark after without new frame.
  assert.ok(!text.includes('plugin.session_doc.updated'), 'snapshot inside update does not repeat under')
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: 2 } } })
  const second = await reader.read()
  text += decoder.decode(second.value!, { stream: true })
  assert.match(text, /event: plugin\.session_doc\.updated/)
  assert.match(text, /"n":2/, 'watermark after update must reach')
  // terminal state: each frame exactly once (n=1 only in snapshot,n=2 only in incremental).
  assert.equal((text.match(/"n":1/g) ?? []).length, 1)
  assert.equal((text.match(/"n":2/g) ?? []).length, 1)
  await reader.cancel().catch(() => {})
  hub.close()
  assert.equal(hub.subscriberCount, 0)
})

test('SessionDocEventHub.response: snapshot provider fails sync clean up (do not create stream leaves no residue subscribe)', { timeout: 60_000 }, () => {
  const hub = new SessionDocEventHub()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  assert.throws(
    () =>
      hub.response(new Request('http://x'), {
        snapshot: () => {
          throw new HelmError('plugin_doc_not_found', 'plugin deactivated', 404)
        },
        target,
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  )
  assert.equal(hub.subscriberCount, 0, 'provider failed after without subscribe leftover')
})

test('SessionDocEventHub.response: snapshot during buffer overflow immediately closure stream, then throws still keep original diagnose', { timeout: 60_000 }, async () => {
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

test('SessionDocEventHub.response: unconsumed stream byte back press over limit actively terminate and unsubscribe (1MiB by default outside explicit small cap)', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub({ maxPendingBytes: 1024 })
  const controller = new AbortController()
  const target = { pluginId: 'p:a', name: 'm', conversationId: 1 }
  const response = hub.response(new Request('http://x', { signal: controller.signal }), {
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
    target,
  })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const first = await reader.read()
  assert.ok(first.value, 'first frame snapshot can read')
  // no longer read: sync heap accumulate large amount large frame, exceeds 1KiB cap after subscribe by remove (slow client closure stream).
  for (let i = 0; i < 64; i++) {
    hub.dispatch({
      type: 'plugin.session_doc.updated',
      doc: { ...target, value: { n: i, bulk: 'x'.repeat(128) } },
    })
    if (hub.subscriberCount === 0) break
  }
  assert.equal(hub.subscriberCount, 0, 'byte accumulate press over limit after subscribe by explicit remove')
  // already queue frame still can read, eventually obtain to done(no longer delivery new frame).
  let done = false
  while (!done) {
    const next = await reader.read()
    done = next.done === true
  }
  hub.dispatch({ type: 'plugin.session_doc.updated', doc: { ...target, value: { n: -1 } } })
  const after = await reader.read()
  assert.ok(after.done, 'closure stream after no longer delivery new frame')
  controller.abort()
})

test('SessionDocEventHub.response: first frame snapshot after incremental;abort clean up subscribe', { timeout: 60_000 }, async () => {
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
  assert.equal(hub.subscriberCount, 0, 'abort after subscribe clean up')
})

// ---------------------------------------------------------------------------
// HelmStore durable layer (real sqlite)
// ---------------------------------------------------------------------------

test('HelmStore conversation document CRUD + conversation delete level join clean up (real sqlite)', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-store-sd-')
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
    // conversation delete: same transaction clean up the conversation all conversation document
    store.deleteConv(1)
    assert.equal(store.getPluginSessionDoc('p:a', 'm', 1), undefined)
    assert.equal(store.getPluginSessionDoc('p:b', 'x', 1), undefined)
    await store.flushPublic()
    const rows = await db.db.all<{ conversation_id: number }>(
      'SELECT conversation_id FROM helm_plugin_session_docs',
    )
    assert.equal(rows.length, 0, 'conversation 1 after deletion store in no residue')
    // illegal JSON reject
    assert.throws(() => store.putPluginSessionDoc('p:a', 'bad', 2, '{oops'))
    await store.close()
    await db.close()
  } finally {
    await cleanupDir(dir)
  }
})

test('HelmStore after restart mirror restore conversation document (real sqlite)', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helm-store-sd2-')
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
    await cleanupDir(dir)
  }
})

// ---------------------------------------------------------------------------
// SessionDocEventHub keepalive & multiplexResponse
// ---------------------------------------------------------------------------

function parseMultiplexSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '' || block.trimStart().startsWith(':')) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data += line.slice('data: '.length)
    }
    frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
  }
  return frames
}

test('SessionDocEventHub.response idle keepalive sends comment lines, disables via keepaliveMs=0, and cleans timer on abort/cancel', { timeout: 60_000 }, async () => {
  const target = { pluginId: 'p:ka', name: 'm', conversationId: 1 }

  // 1. Active keepalive sends `: keepalive\n\n` without incrementing hub.seq, and abort cleans timer.
  const hub = new SessionDocEventHub({ keepaliveMs: 20 })
  const controller = new AbortController()
  const res = hub.response(new Request('http://localhost/events', { signal: controller.signal }), {
    target,
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  try {
    const first = await reader.read()
    assert.match(decoder.decode(first.value!), /event: snapshot/)
    const beat = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('keepalive timeout')), 2_000)),
    ])
    const beatText = decoder.decode(beat.value!)
    assert.equal(beatText, ': keepalive\n\n')
    assert.equal(hub.seq, 0, 'keepalive must not increment SessionDocEventHub.seq')
    controller.abort()
    assert.equal(hub.subscriberCount, 0)
    await new Promise((r) => setTimeout(r, 60))
    const done = await reader.read()
    assert.equal(done.done, true, 'no further heartbeat bytes after abort')
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
    hub.close()
  }

  // 2. keepaliveMs=0 disables heartbeat completely.
  const silentHub = new SessionDocEventHub({ keepaliveMs: 0 })
  const silentCtrl = new AbortController()
  const silentRes = silentHub.response(new Request('http://localhost/events', { signal: silentCtrl.signal }), {
    target,
    snapshot: () => ({ seq: 0, doc: { ...target, value: { n: 0 } } }),
  })
  const silentReader = silentRes.body!.getReader()
  try {
    await silentReader.read()
    const gotExtra = await Promise.race([
      silentReader.read().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 80)),
    ])
    assert.equal(gotExtra, false, 'keepaliveMs=0 must not emit heartbeat comments')
  } finally {
    silentCtrl.abort()
    await silentReader.cancel().catch(() => {})
    silentHub.close()
  }
})

test('SessionDocEventHub.multiplexResponse validates subscriptions, emits snapshots + isolated updates/deletes, and dedupes atomic window', { timeout: 60_000 }, async () => {
  const hub = new SessionDocEventHub({ keepaliveMs: 0 })
  const subA: SessionDocSubscription = { pluginId: 'p:a', name: 'runs', conversationId: 1 }
  const subB: SessionDocSubscription = { pluginId: 'p:b', name: 'state', conversationId: 2 }

  assert.throws(
    () => hub.multiplexResponse([], new Request('http://localhost/m'), { snapshot: () => ({ seq: 0, doc: { pluginId: 'p:a', name: 'runs', conversationId: 1, value: null } }) }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  assert.throws(
    () =>
      hub.multiplexResponse([subA, { ...subA }], new Request('http://localhost/m'), {
        snapshot: () => ({ seq: 0, doc: { ...subA, value: null } }),
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  assert.equal(hub.subscriberCount, 0)

  const ctrl = new AbortController()
  const response = hub.multiplexResponse([subA, subB], new Request('http://localhost/m', { signal: ctrl.signal }), {
    snapshot: (sub) => {
      if (sub.pluginId === 'p:a') {
        // Dispatch inside snapshot gathering: same seq is covered by snapshot (deduped), later seq passes through.
        hub.dispatch({ doc: { ...subA, value: { phase: 'during-snap' } } })
        const seq = hub.seq
        hub.dispatch({ doc: { ...subB, value: { phase: 'after-b-will-see' } } })
        return { seq, doc: { ...subA, value: { phase: 'during-snap' } } }
      }
      return { seq: hub.seq, doc: { ...subB, value: { phase: 'snap-b' } } }
    },
  })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(hub.subscriberCount, 2)

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const collected: SessionDocMultiplexFrame[] = []
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseMultiplexSse(buffer)
      collected.length = 0
      for (const f of parsed) {
        if (f.event === 'session_doc' && f.data !== null) collected.push(f.data as SessionDocMultiplexFrame)
      }
    }
  })()

  try {
    await waitFor(() => collected.length >= 2)
    assert.deepEqual(
      collected.slice(0, 2).map((f) => ({ action: f.action, pluginId: f.pluginId, name: f.name, conversationId: f.conversationId, value: f.doc.value })),
      [
        { action: 'snapshot', pluginId: 'p:a', name: 'runs', conversationId: 1, value: { phase: 'during-snap' } },
        { action: 'snapshot', pluginId: 'p:b', name: 'state', conversationId: 2, value: { phase: 'snap-b' } },
      ],
    )

    // Unsubscribed targets must not leak onto this multiplexed connection.
    hub.dispatch({ doc: { pluginId: 'p:other', name: 'x', conversationId: 1, value: { leak: true } } })
    hub.dispatch({ doc: { pluginId: 'p:a', name: 'runs', conversationId: 99, value: { leak: true } } })
    hub.dispatch({ doc: { ...subA, value: { step: 2 } } })
    hub.dispatch({ doc: { ...subB, value: null, deleted: true } })

    await waitFor(() => collected.length >= 4)
    assert.equal(collected.length, 4, 'unsubscribed targets must be filtered out')
    assert.deepEqual(
      collected.slice(2).map((f) => ({
        action: f.action,
        pluginId: f.pluginId,
        name: f.name,
        conversationId: f.conversationId,
        value: f.doc.value,
        deleted: f.doc.deleted,
      })),
      [
        { action: 'updated', pluginId: 'p:a', name: 'runs', conversationId: 1, value: { step: 2 }, deleted: undefined },
        { action: 'deleted', pluginId: 'p:b', name: 'state', conversationId: 2, value: null, deleted: true },
      ],
    )
  } finally {
    ctrl.abort()
    await reader.cancel().catch(() => {})
    await readLoop.catch(() => {})
    hub.close()
  }
  assert.equal(hub.subscriberCount, 0)
})

test('SessionDocEventHub.multiplexResponse handles snapshot failure cleanup, keepalive, closeForPlugin/closeForConversation, and backpressure', { timeout: 60_000 }, async () => {
  const subA: SessionDocSubscription = { pluginId: 'p:a', name: 'runs', conversationId: 1 }
  const subB: SessionDocSubscription = { pluginId: 'p:b', name: 'state', conversationId: 2 }

  // 1. Throwing on 2nd snapshot cleans up 1st subscription without leaking.
  const errHub = new SessionDocEventHub({ keepaliveMs: 0 })
  assert.throws(
    () =>
      errHub.multiplexResponse([subA, subB], new Request('http://localhost/m'), {
        snapshot: (sub) => {
          if (sub.pluginId === 'p:b') throw new HelmError('plugin_doc_not_found', 'missing doc', 404)
          return { seq: 0, doc: { ...sub, value: {} } }
        },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  )
  assert.equal(errHub.subscriberCount, 0)

  // 2. closeForPlugin / closeForConversation close the multiplexed stream cleanly when ANY tuple matches.
  for (const killer of [
    (h: SessionDocEventHub) => h.closeForPlugin('p:b'),
    (h: SessionDocEventHub) => h.closeForConversation(2),
  ]) {
    const hub = new SessionDocEventHub({ keepaliveMs: 25 })
    const res = hub.multiplexResponse([subA, subB], new Request('http://localhost/m'), {
      snapshot: (sub) => ({ seq: 0, doc: { ...sub, value: { ok: true } } }),
    })
    assert.equal(hub.subscriberCount, 2)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    try {
      let seenKeepalive = false
      let snapshotCount = 0
      const deadline = Date.now() + 2_000
      while (!seenKeepalive) {
        const remaining = deadline - Date.now()
        assert.ok(remaining > 0, 'multiplex keepalive timeout')
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('multiplex keepalive timeout')), remaining)),
        ])
        assert.equal(chunk.done, false)
        const text = decoder.decode(chunk.value!)
        if (text === ': keepalive\n\n') {
          seenKeepalive = true
        } else {
          assert.match(text, /event: session_doc/)
          snapshotCount += (text.match(/event: session_doc/g) ?? []).length
        }
      }
      assert.equal(snapshotCount, 2, 'should emit both initial snapshots before keepalive')
      killer(hub)
      assert.equal(hub.subscriberCount, 0)
      let done = false
      while (!done) {
        done = (await reader.read()).done === true
      }
      assert.equal(done, true)
    } finally {
      await reader.cancel().catch(() => {})
      hub.close()
    }
  }

  // 3. Slow consumer backpressure terminates stream and cleans up subscriptions.
  const bpHub = new SessionDocEventHub({ maxPendingBytes: 512, keepaliveMs: 0 })
  const ctrl = new AbortController()
  const bpRes = bpHub.multiplexResponse([subA], new Request('http://localhost/m', { signal: ctrl.signal }), {
    snapshot: (sub) => ({ seq: 0, doc: { ...sub, value: { init: true } } }),
  })
  const bpReader = bpRes.body!.getReader()
  try {
    await bpReader.read()
    for (let i = 0; i < 32; i++) {
      bpHub.dispatch({ doc: { ...subA, value: { fill: 'x'.repeat(128), i } } })
      if (bpHub.subscriberCount === 0) break
    }
    assert.equal(bpHub.subscriberCount, 0)
  } finally {
    ctrl.abort()
    await bpReader.cancel().catch(() => {})
    bpHub.close()
  }
})

// ---------------------------------------------------------------------------
// Transient in-memory plugin docs (`durable: false`)
// ---------------------------------------------------------------------------

test('durable: false on ctx.doc performs zero store I/O, broadcasts SSE, appears in public snapshots, enforces byte cap, and clears on disable', { timeout: 60_000 }, async () => {
  let storeCalls = 0
  const spyDocStore: PluginDocStore = {
    get() {
      storeCalls += 1
      throw new Error('transient doc must not call store.get')
    },
    set() {
      storeCalls += 1
      throw new Error('transient doc must not call store.set')
    },
    deletePlugin() {},
    async flush() {
      storeCalls += 1
      throw new Error('transient doc flush must not call store.flush')
    },
  }
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: hostApi.backend,
    docs: spyDocStore,
    sessionDocs,
  })

  let handle!: {
    get(): { tps: number }
    set(v: { tps: number }): void
    update(fn: (c: { tps: number }) => { tps: number }): void
    flush(): Promise<void>
  }
  await host.register({
    id: 'p:transient-doc',
    definePlugin: (ctx) => {
      handle = ctx.doc('live', { tps: 0 }, { public: true, durable: false }) as never
    },
  })

  assert.deepEqual(handle.get(), { tps: 0 })
  assert.deepEqual(host.getPublicDoc('p:transient-doc', 'live'), {
    pluginId: 'p:transient-doc',
    name: 'live',
    value: { tps: 0 },
  })
  assert.deepEqual(host.listPublicDocs(), [
    { pluginId: 'p:transient-doc', name: 'live', value: { tps: 0 } },
  ])

  handle.set({ tps: 42 })
  handle.update((cur) => ({ tps: cur.tps + 8 }))
  await handle.flush()
  assert.deepEqual(handle.get(), { tps: 50 })
  assert.deepEqual(host.getPublicDoc('p:transient-doc', 'live').value, { tps: 50 })
  assert.equal(storeCalls, 0, 'durable: false must perform zero PluginDocStore reads/writes/flushes')

  const docEvents = hostApi.events.filter((e) => e.type === 'plugin.doc.updated')
  assert.equal(docEvents.length, 2)

  // Disable clears transient state; re-enabling resets back to initial value.
  await host.disable('p:transient-doc')
  throwsCode(() => handle.get(), 'plugin_context_expired')
  await host.enable('p:transient-doc')
  assert.deepEqual(handle.get(), { tps: 0 }, 're-enabling transient doc starts fresh at initial value')
  assert.equal(storeCalls, 0)
})

test('durable: false on ctx.sessionDoc works without sessionStore, performs zero SQLite/store writes, broadcasts SSE, enforces byte limit, and clears on conversation delete / plugin stop', { timeout: 60_000 }, async () => {
  const existing = new Set([1, 2, 3])
  hostApi = makeHostApi({ existing })

  // 1. Works even when sessionStore is completely absent (`sessionDocs: undefined`).
  const noStoreHost = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: hostApi.backend,
    docs,
    sessionDocs: undefined,
  })
  let handle!: {
    get(id: number): { runs: string[] }
    set(id: number, v: { runs: string[] }): void
    update(id: number, fn: (c: { runs: string[] }) => { runs: string[] }): void
    delete(id: number): void
    listConversationIds(): number[]
    flush(): Promise<void>
  }
  await noStoreHost.register({
    id: 'p:transient-sd',
    definePlugin: (ctx) => {
      handle = ctx.sessionDoc('runs', { runs: [] }, { public: true, durable: false }) as never
    },
  })

  assert.deepEqual(handle.get(1), { runs: [] })
  handle.set(1, { runs: ['r1'] })
  handle.update(1, (cur) => ({ runs: [...cur.runs, 'r2'] }))
  handle.set(2, { runs: ['r3'] })
  await handle.flush()
  assert.deepEqual(handle.get(1), { runs: ['r1', 'r2'] })
  assert.deepEqual(noStoreHost.getPublicSessionDoc('p:transient-sd', 'runs', 1), {
    pluginId: 'p:transient-sd',
    name: 'runs',
    conversationId: 1,
    value: { runs: ['r1', 'r2'] },
  })
  assert.deepEqual(handle.listConversationIds(), [1, 2])

  // Conversation 2 deleted: listConversationIds prunes dead conversation, reads/writes reject 404.
  existing.delete(2)
  assert.deepEqual(handle.listConversationIds(), [1])
  throwsCode(() => handle.get(2), 'not_found', 404)
  throwsCode(() => handle.set(2, { runs: ['orphan'] }), 'not_found', 404)

  // Explicit delete on live conversation emits deleted: true with initial value.
  handle.delete(1)
  assert.deepEqual(handle.get(1), { runs: [] })
  assert.deepEqual(handle.listConversationIds(), [])

  const sdEvents = hostApi.events.filter((e) => e.type === 'plugin.session_doc.updated')
  assert.equal(sdEvents.length, 4)
  const lastPayload = sdEvents[3]!.payload as { doc: { deleted?: boolean; value: unknown } }
  assert.equal(lastPayload.doc.deleted, true)
  assert.deepEqual(lastPayload.doc.value, { runs: [] })

  // Disable clears transient state; re-enable resets to initial value.
  handle.set(3, { runs: ['r-before-stop'] })
  assert.deepEqual(handle.listConversationIds(), [3])
  await noStoreHost.disable('p:transient-sd')
  await noStoreHost.enable('p:transient-sd')
  assert.deepEqual(handle.get(3), { runs: [] })
  assert.deepEqual(handle.listConversationIds(), [])

  // 2. Direct PluginDocRegistry test: zero sessionStore writes + maxDocJsonBytes cap + deleteConversation + invalid option rejection.
  let sessionStoreCalls = 0
  const spySessionStore: PluginSessionDocStore = {
    get() { sessionStoreCalls += 1; return undefined },
    put() { sessionStoreCalls += 1 },
    delete() { sessionStoreCalls += 1 },
    deletePlugin() {},
    listConversationIds() { sessionStoreCalls += 1; return [] },
    async flush() { sessionStoreCalls += 1 },
  }
  const smallRegistry = new PluginDocRegistry(
    docs,
    () => {},
    {
      sessionStore: spySessionStore,
      assertConversationExists: (cid) => {
        if (!existing.has(cid)) throw new HelmError('not_found', 'missing', 404)
      },
      emitSessionDocUpdated: () => {},
      maxDocJsonBytes: 64,
    },
  )

  throwsCode(
    () => smallRegistry.registerDoc('p:bad', 'd', {}, { durable: 'nope' as never }, () => {}),
    'invalid_doc_spec',
    400,
  )

  const cappedDoc = smallRegistry.registerDoc('p:cap', 'd', { s: 'ok' }, { public: true, durable: false }, () => {})
  const cappedSd = smallRegistry.registerSessionDoc('p:cap', 'sd', { s: 'ok' }, { public: true, durable: false }, () => {})
  cappedDoc.set({ s: 'fine' })
  cappedSd.set(1, { s: 'fine' })
  throwsCode(() => cappedDoc.set({ s: 'x'.repeat(200) }), 'plugin_doc_too_large', 413)
  throwsCode(() => cappedSd.set(1, { s: 'x'.repeat(200) }), 'plugin_doc_too_large', 413)
  assert.deepEqual(cappedDoc.get(), { s: 'fine' }, 'rejected oversized write preserves previous transient doc value')
  assert.deepEqual(cappedSd.get(1), { s: 'fine' }, 'rejected oversized write preserves previous transient sessionDoc value')
  assert.equal(sessionStoreCalls, 0, 'transient sessionDoc never touches sessionStore even when provided')

  smallRegistry.deleteConversation(1)
  assert.deepEqual(cappedSd.get(1), { s: 'ok' }, 'deleteConversation clears transient sessionDoc entry')
  assert.deepEqual(cappedSd.listConversationIds(), [])
})
