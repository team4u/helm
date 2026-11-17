/**
 * Real-pipeline tests for conversation timelines and live views.
 *
 * Each layer uses its real boundary (never mirror-implementation mocks):
 * 1. Pure function layer: toConversationEntry / deriveConversationLive contracts
 *    (stringified id, preserved model, JSON validation rejects non-JSON explicitly without silent truncation);
 * 2. EventHub layer: conversation.entry / conversation.live / plugin.doc.updated / workflow.updated
 *    shorthand and full-envelope forms, explicit throws on invalid payloads, redaction preservation,
 *    and required ui/pluginDocs fields on snapshot;
 * 3. Real SDK layer: faux provider driving ConversationTracker -- initial observe does not duplicate history,
 *    new DB entries fire once per id in order, live throttling (75ms window) and terminal flush,
 *    no ghost events after stopObserving, meta preserved from entry.data into turn_settled payload,
 *    and getProbeFacts reflects real activity changes.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness } from '@earendil-works/pi-durable'
import { createRegistry } from '@earendil-works/pi-durable'
import type { ConversationEntry, ConversationLive, HelmEventFrame, HelmSnapshot, HelmTransientLiveFrame } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, toConversationEntry } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, summaryOf, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function convMeta(id: number): ConvMeta {
  return {
    id,
    title: `conversation ${id}`,
    profileId: 'assistant',
    nodeId: 'local',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Test collector for ConversationTracker events. */
interface Collector {
  entries: Array<{ conversationId: number; entry: ConversationEntry }>
  lives: ConversationLive[]
  summaries: number[]
}
function makeCollector(): Collector {
  return { entries: [], lives: [], summaries: [] }
}
function eventsOf(c: Collector): TrackerEvents {
  return {
    onSummaryChanged: (s) => c.summaries.push(s.id),
    onInputCommitted: () => {},
    onAssistantText: () => {},
    onTurnSettled: () => {},
    onEntryCommitted: (conversationId, entry) => c.entries.push({ conversationId, entry }),
    onLiveChanged: (live) => c.lives.push(live),
  }
}

// ---------------------------------------------------------------------------
// 1. Pure function: toConversationEntry
// ---------------------------------------------------------------------------

describe('toConversationEntry', { timeout: 60_000 }, () => {
  it('stringifies id and preserves kind/data/model (model carries assistant text)', () => {
    const entry = toConversationEntry({
      id: 42,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }],
    })
    assert.equal(entry.id, '42')
    assert.equal(entry.kind, 'pi.assistant')
    assert.equal(entry.data, undefined)
    assert.ok(Array.isArray(entry.model))
    assert.deepEqual(entry.model, [{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }])
  })

  it('preserves data verbatim and keeps string id unchanged', () => {
    const entry = toConversationEntry({ id: '7', kind: 'helm.input', data: { origin: 'human' } })
    assert.equal(entry.id, '7')
    assert.deepEqual(entry.data, { origin: 'human' })
    assert.equal(entry.model, undefined)
  })

  it('throws HelmError explicitly for non-JSON values (Date/Map/cyclic/undefined field) without silent conversion', () => {
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: { at: new Date(0) } }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: new Map() }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: cyclic }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', model: [{ role: 'assistant', extra: undefined }] }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
  })

  it('throws explicitly on invalid id/kind without fabricating defaults', () => {
    assert.throws(() => toConversationEntry({ id: null, kind: 'x' } as never), HelmError)
    assert.throws(() => toConversationEntry({ id: 1, kind: 3 } as never), HelmError)
  })
})

// ---------------------------------------------------------------------------
// 2. Pure function: deriveConversationLive
// ---------------------------------------------------------------------------

describe('deriveConversationLive', { timeout: 60_000 }, () => {
  it('concatenates cumulative text blocks in order from generation.message', () => {
    const live = deriveConversationLive(
      5,
      {
        generation: {
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'alpha' },
              { type: 'text', text: 'beta' },
            ],
          },
        },
      },
      123,
    )
    assert.equal(live.conversationId, 5)
    assert.equal(live.text, 'alphabeta')
    assert.equal(live.thinking, 'reasoning')
    assert.deepEqual(live.tools, [])
    assert.equal(live.updatedAt, 123)
  })

  it('combines tools and nestedTools into uniform tool cards preserving running/done status and input', () => {
    const live = deriveConversationLive(
      1,
      {
        tools: [
          { callId: 'c1', name: 'bash', status: 'running', arguments: { command: 'ls' } },
          { callId: 'c2', name: 'read', status: 'done' },
        ],
        nestedTools: [{ callId: 'c1/1', name: 'grep', status: 'done', arguments: { pattern: 'x' } }],
      },
      9,
    )
    assert.equal(live.text, '')
    assert.equal(live.tools.length, 3)
    assert.deepEqual(live.tools[0], {
      callId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
      status: 'running',
    })
    assert.deepEqual(live.tools[1], { callId: 'c2', toolName: 'read', status: 'done' })
    assert.deepEqual(live.tools[2], {
      callId: 'c1/1',
      toolName: 'grep',
      input: { pattern: 'x' },
      status: 'done',
    })
  })

  it('produces an empty snapshot for undefined live view without throwing', () => {
    const live = deriveConversationLive(1, undefined, 1)
    assert.equal(live.text, '')
    assert.deepEqual(live.tools, [])
  })
})

// ---------------------------------------------------------------------------
// 3. EventHub: four core event types
// ---------------------------------------------------------------------------

describe('EventHub core event types', { timeout: 60_000 }, () => {
  function makeHub(snapshot?: Partial<HelmSnapshot>): { hub: EventHub; frames: HelmEventFrame[] } {
    const frames: HelmEventFrame[] = []
    const hub = new EventHub({
      initialSeq: 0,
      snapshot: () =>
        ({
          seq: 0,
          conversations: [],
          pendingAsks: [],
          plugins: [],
          ui: [],
          pluginDocs: [],
          ...snapshot,
        }) as HelmSnapshot,
    })
    hub.subscribe((f) => frames.push(f))
    return { hub, frames }
  }

  const entry: ConversationEntry = { id: '11', kind: 'pi.assistant', model: [{ role: 'assistant' }] }
  const live: ConversationLive = {
    conversationId: 3,
    text: 'streaming',
    tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }],
    updatedAt: 111,
  }
  const doc = { pluginId: 'builtin:superagent', name: 'index', value: { next: 4 } }
  const run = {
    id: 'wf_abc',
    name: 'inspection',
    conversationId: 2,
    status: 'running' as const,
    createdAt: 1,
    updatedAt: 2,
  }

  it('conversation.entry accepts both shorthand {conversationId, entry} and full envelope {type, ...}', () => {
    const { hub, frames } = makeHub()
    hub.publish('conversation.entry', { conversationId: 3, entry })
    hub.publish('conversation.entry', { type: 'conversation.entry', conversationId: 4, entry })
    const [e1, e2] = frames.map((f) => f.event) as Array<{
      type: string
      conversationId: number
      entry: ConversationEntry
    }>
    assert.ok(e1 && e2)
    assert.equal(e1.type, 'conversation.entry')
    assert.equal(e1.conversationId, 3)
    assert.deepEqual(e1.entry, entry)
    assert.equal(e2.conversationId, 4)
    assert.deepEqual(e2.entry, entry)
  })

  it('conversation.live: EventHub.publish rejects as transient; publishTransientLive delivers via subscribeTransientLive and keeps seq=0', { timeout: 60_000 }, async () => {
    const { hub, frames } = makeHub()
    try {
      assert.throws(
        () => hub.publish('conversation.live', { live }),
        (err: unknown) => err instanceof HelmError && err.code === 'invalid_event',
      )
      assert.throws(
        () => hub.publish('conversation.live', { type: 'conversation.live', live }),
        (err: unknown) => err instanceof HelmError && err.code === 'invalid_event',
      )
      const received: HelmTransientLiveFrame[] = []
      const unsub = hub.subscribeTransientLive((f) => received.push(f))
      hub.publishTransientLive(live)
      unsub()
      hub.publishTransientLive({ ...live, text: 'after unsub' })
      assert.equal(hub.seq, 0, 'transient live must never advance EventHub.seq')
      assert.equal(frames.length, 0, 'transient live must never enter durable subscriber queue')
      assert.equal(received.length, 1)
      assert.deepEqual(received[0], { live })
    } finally {
      hub.close()
    }
  })

  it('plugin.doc.updated supports both forms with all three doc fields preserved', () => {
    const { hub, frames } = makeHub()
    hub.publish('plugin.doc.updated', { doc })
    hub.publish('plugin.doc.updated', { type: 'plugin.doc.updated', doc })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ doc: typeof doc }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.doc, doc)
    assert.deepEqual(e2.doc, doc)
  })

  it('workflow.updated passes custom event payload through untouched (owned by workflow plugin)', () => {
    const { hub, frames } = makeHub()
    hub.publish('workflow.updated', { run })
    hub.publish('workflow.updated', { type: 'workflow.updated', run })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ payload: { run: typeof run } }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.payload.run, run)
    assert.deepEqual(e2.payload.run, run)
  })

  it('invalid payloads throw HelmError explicitly without advancing seq or falling back silently', () => {
    const { hub, frames } = makeHub()
    // conversation.entry: missing conversationId or malformed entry
    assert.throws(() => hub.publish('conversation.entry', { entry }), HelmError)
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 1, entry: { id: 1 } }),
      HelmError,
    )
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 'x', entry }),
      HelmError,
    )
    // conversation.live: EventHub.publish always rejects; publishTransientLive rejects malformed shapes too
    assert.throws(() => hub.publish('conversation.live', { live: { conversationId: 1 } }), HelmError)
    assert.throws(() => hub.publish('conversation.live', {}), HelmError)
    assert.throws(() => hub.publishTransientLive({ conversationId: 1 } as never), HelmError)
    assert.throws(() => hub.publishTransientLive(null as never), HelmError)
    // plugin.doc.updated: missing value / pluginId
    assert.throws(
      () => hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n' } }),
      HelmError,
    )
    // workflow.updated is a custom event (arbitrary JSON payload passes through); only JSON validity (cycles, etc.) is checked.
    assert.equal(hub.seq, 0, 'failed publishes must not advance seq')
    assert.equal(frames.length, 0)
  })

  it('unified pre-publish redaction protects entry/live/doc against leaking plaintext secrets', { timeout: 60_000 }, () => {
    const { hub, frames } = makeHub()
    hub.redactFn = (t) => t.replaceAll('sk-plain', '[REDACTED]')
    const liveReceived: HelmTransientLiveFrame[] = []
    hub.subscribeTransientLive((f) => liveReceived.push(f))
    hub.publish('conversation.entry', {
      conversationId: 1,
      entry: { id: '1', kind: 'helm.input', data: { text: 'upload sk-plain secret key' } },
    })
    hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n', value: 'token=sk-plain' } })
    hub.publishTransientLive({ conversationId: 1, text: 'secret sk-plain', tools: [], updatedAt: 10 })
    const text = JSON.stringify([...frames.map((f) => f.event), ...liveReceived])
    assert.ok(!text.includes('sk-plain'), 'event payload must not leak plaintext secrets')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('snapshot includes required ui and pluginDocs fields directly without compat defaults', () => {
    const ui = [{ pluginId: 'p', surface: 'sidebar.item', spec: { id: 's1', label: 'X' } }]
    const docs = [{ pluginId: 'builtin:workflow', name: 'runs', value: { runs: [] } }]
    const { hub } = makeHub({ ui, pluginDocs: docs })
    const snap = hub.currentSnapshot()
    assert.deepEqual(snap.ui, ui)
    assert.deepEqual(snap.pluginDocs, docs)
  })
})

// ---------------------------------------------------------------------------
// 4. Real SDK: faux provider driving ConversationTracker
// ---------------------------------------------------------------------------

describe('ConversationTracker real SDK timeline and live events', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-timeline-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  /** Real Harness + SQLite + faux provider + tracker (never mocks KernelRuntime). */
  type FauxHandle = ReturnType<typeof makeFauxModels>['faux']
  async function openTracker(): Promise<{
    tracker: ConversationTracker
    harness: Harness
    collector: Collector
    faux: FauxHandle
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels()
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const collector = makeCollector()
    const tracker = new ConversationTracker({
      harness,
      store,
      events: eventsOf(collector),
    })
    return {
      tracker,
      harness,
      collector,
      faux,
      close: async () => {
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
    }
  }

  it('full faux path: initial observe skips history; new persisted entries emit once in id order; live updates and flushes on settle', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number

      // Pre-existing history (entry persisted before observe).
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 1 } } }, BACKGROUND_CONTEXT)
      await tracker.observe(id)
      assert.equal(collector.entries.length, 0, 'initial observe must not replay historical entries')

      // Real run: faux text response -> helm.input + pi.assistant persisted.
      // Register through real tracker API (registerInput -> bindSubmission, same path as runtime;
      // tracking identity is durable input.id = requestId).
      faux.setResponses([fauxAssistantMessage('real response')])
      tracker.registerInput(id, {
        id: 'in-1',
        text: 'real prompt',
        origin: 'human',
        createdAt: 1,
      })
      await conv
        .submit(
          {
            type: 'input',
            content: 'real prompt',
            entry: {
              kind: 'helm.input',
              data: { id: 'in-1', text: 'real prompt', origin: 'human', createdAt: 1 },
            },
            requestId: 'in-1',
          },
          BACKGROUND_CONTEXT,
        )
        .then((sub) => tracker.bindSubmission(id, 'in-1', sub.id as number))
      await conv.waitForIdle(BACKGROUND_CONTEXT)

      // Wait for observer path to finish (runs synchronously up to microtasks).
      await waitFor(() => collector.entries.length >= 2, 5_000)
      const ids = collector.entries.map((e) => e.entry.id)
      assert.equal(new Set(ids).size, ids.length, 'each entry emitted once')
      assert.ok(ids.length >= 2)
      // Numeric id ordering matches commit order.
      const numeric = ids.map(Number)
      for (let i = 1; i < numeric.length; i += 1) {
        assert.ok(numeric[i]! > numeric[i - 1]!, 'entries must arrive in monotonic commit id order')
      }
      const kinds = collector.entries.map((e) => e.entry.kind)
      assert.ok(kinds.includes('helm.input'), 'helm.input entry event arrives')
      assert.ok(kinds.some((k) => k.startsWith('pi.')), 'SDK internal entry event arrives')
      // Live terminal flush: at least one frame arrives with matching conversationId.
      assert.ok(collector.lives.length >= 1, 'at least one live frame emitted during/after run')
    } finally {
      await close()
    }
  })

  it('live throttling: merges snapshots during run and stops on terminal state; interval obeys throttle window', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      await tracker.observe(id)
      // Real run: faux text response (streaming partial via pi.live.generation drives live derivation).
      faux.setResponses([fauxAssistantMessage('streaming response body')])
      await conv.submit({ type: 'input', content: 'run one turn' }, BACKGROUND_CONTEXT)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      // After terminal flush (emitSettled synchronous path), live frames stop growing.
      await new Promise((r) => setTimeout(r, 150))
      const frozen = collector.lives.length
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(collector.lives.length, frozen, 'no further live frames after run finishes')
      // Throttling check: consecutive frames stay >= ~75ms apart (merged within window) or total frames is 0/1
      // (single window); never asserts an artificial minimum frame count because cadence follows real streaming.
      for (let i = 1; i < collector.lives.length; i += 1) {
        const prev = collector.lives[i - 1]!
        const curr = collector.lives[i]!
        assert.ok(
          curr.updatedAt - prev.updatedAt >= 60,
          `interval between adjacent live frames (${curr.updatedAt - prev.updatedAt}ms) fell below throttle window (same-window snapshots were not merged)`,
        )
      }
      // Every frame carries the right conversationId.
      for (const frame of collector.lives) assert.equal(frame.conversationId, id)
    } finally {
      await close()
    }
  })

  it('stopObserving clears timers and emits no more entry/live events (zero ghost events)', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      await tracker.observe(id)
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 2 } } }, BACKGROUND_CONTEXT)
      await waitFor(() => collector.entries.length === 1, 5_000)
      tracker.stopObserving(id)
      const entriesAfter = collector.entries.length
      const livesAfter = collector.lives.length
      // Writing again after stopObserving must emit nothing.
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 3 } } }, BACKGROUND_CONTEXT)
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(collector.entries.length, entriesAfter, 'no ghost entry events after stopObserving')
      assert.equal(collector.lives.length, livesAfter, 'no ghost live events after stopObserving')
    } finally {
      await close()
    }
  })

  it('preserves meta from helm.input entry.data end-to-end into turn_settled payload', { timeout: 60_000 }, async () => {
    const settled: Array<{ inputs: Array<{ meta?: Record<string, unknown> }> }> = []
    const dir = join(root, `meta-${Date.now()}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('ok')])
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      store.upsertConv(convMeta(id))
      const tracker = new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: (payload) => {
            settled.push(payload as { inputs: Array<{ meta?: Record<string, unknown> }> })
          },
        },
      })
      await tracker.observe(id)
      tracker.registerInput(id, {
        id: 'm-1',
        text: 'prompt carrying meta',
        origin: 'agent',
        createdAt: 2,
        meta: { from: 'superagent', turn: 3 },
      })
      await conv
        .submit(
          {
            type: 'input',
            content: 'prompt carrying meta',
            entry: {
              kind: 'helm.input',
              data: {
                id: 'm-1',
                text: 'prompt carrying meta',
                origin: 'agent',
                createdAt: 2,
                meta: { from: 'superagent', turn: 3 },
              },
            },
            requestId: 'm-1',
          },
          BACKGROUND_CONTEXT,
        )
        .then((sub) => tracker.bindSubmission(id, 'm-1', sub.id as number))
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1, 5_000)
      const inputs = settled[0]?.inputs ?? []
      const withMeta = inputs.find((i) => i.meta !== undefined)
      assert.ok(withMeta, 'turn_settled inputs should include meta')
      assert.deepEqual(withMeta!.meta, { from: 'superagent', turn: 3 })
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })

  it('submissionIndex: bindSubmission hits on markConsumed and clears index on settle without leaks', { timeout: 60_000 }, async () => {
    const settled: Array<{ inputs: Array<{ id: string; meta?: Record<string, unknown> }> }> = []
    const dir = join(root, `index-${Date.now()}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('ok')])
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      store.upsertConv(convMeta(id))
      const committed: string[] = []
      const tracker = new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: (_cid, input) => {
            committed.push(input.id)
          },
          onAssistantText: () => {},
          onTurnSettled: (payload) => {
            settled.push(payload as { inputs: Array<{ id: string }> })
          },
        },
      })
      await tracker.observe(id)
      tracker.registerInput(id, {
        id: 'ix-1',
        text: 'index verification prompt',
        origin: 'human',
        createdAt: 3,
      })
      const submission = await conv.submit(
        {
          type: 'input',
          content: 'index verification prompt',
          entry: { kind: 'helm.input', data: { id: 'ix-1', text: 'index verification prompt', origin: 'human', createdAt: 3 } },
          requestId: 'ix-1',
        },
        BACKGROUND_CONTEXT,
      )
      tracker.bindSubmission(id, 'ix-1', submission.id as number)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1, 5_000)
      // run.inputs matched via index: onInputCommitted fires once with requestId identity.
      assert.deepEqual(committed, ['ix-1'])
      assert.deepEqual(settled[0]!.inputs.map((i) => i.id), ['ix-1'])
      // Tracking records and correlation index are cleared after settle.
      const internals = (tracker as unknown as {
        mirrors: Map<number, { trackedInputs: Map<string, unknown>; submissionIndex: Map<number, string> }>
      })
      assert.equal(internals.mirrors.get(id)?.trackedInputs.size ?? 0, 0, 'tracking records cleared after settle')
      assert.equal(internals.mirrors.get(id)?.submissionIndex.size ?? 0, 0, 'correlation index cleared after settle')
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })

  it('ConversationSummary.lastEntryId tracks latest visible entry across observe, turn, system-only write, and restart', { timeout: 60_000 }, async () => {
    const dir = join(root, `last-entry-${Date.now()}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('hello back')])
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    let expectedVisibleId = 0
    let convId = 0
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      convId = conv.id as number
      store.upsertConv(convMeta(convId))

      const emittedSummaries: Array<{ lastEntryId?: number }> = []
      const tracker = new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: (s) => emittedSummaries.push({ lastEntryId: s.lastEntryId }),
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: () => {},
        },
      })

      // Write an initial hidden pi.system entry before observe: visible lastEntryId must remain 0.
      await conv.submit(
        { type: 'write', entry: { kind: 'pi.system', data: { content: 'boot prompt' } } },
        BACKGROUND_CONTEXT,
      )
      await tracker.observe(convId)
      assert.equal(tracker.summaryOf(convId)?.lastEntryId, 0)
      assert.equal(summaryOf(store.getConv(convId)!, 'idle', 0).lastEntryId, 0)

      // Submit a visible turn: lastEntryId advances to the newest visible entry (assistant message).
      await conv.submit(
        {
          type: 'input',
          content: 'hi',
          entry: { kind: 'helm.input', data: { id: 'le-1', text: 'hi', origin: 'human', createdAt: 10 } },
          requestId: 'le-1',
        },
        BACKGROUND_CONTEXT,
      )
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      const viewAfterTurn = await conv.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT)
      const latestTurnVisible = [...viewAfterTurn.items].reverse().find((e) => e.kind !== 'pi.system')
      assert.ok(latestTurnVisible, 'expected visible entry after turn')
      expectedVisibleId = Number(latestTurnVisible.id)
      await waitFor(() => tracker.summaryOf(convId)?.lastEntryId === expectedVisibleId, 5_000)
      assert.equal(summaryOf(store.getConv(convId)!, 'idle', 0).lastEntryId, expectedVisibleId)
      assert.ok(
        emittedSummaries.some((s) => s.lastEntryId === expectedVisibleId),
        'onSummaryChanged should carry updated lastEntryId',
      )

      // Hidden pi.system entry written while idle must NOT advance lastEntryId.
      await conv.submit(
        { type: 'write', entry: { kind: 'pi.system', data: { content: 'hidden update' } } },
        BACKGROUND_CONTEXT,
      )
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(tracker.summaryOf(convId)?.lastEntryId, expectedVisibleId)

      // Visible pi.reset entry written while idle advances lastEntryId and notifies onSummaryChanged.
      await conv.submit(
        { type: 'write', entry: { kind: 'pi.reset', data: { handoff: 'fresh' } } },
        BACKGROUND_CONTEXT,
      )
      const viewAfterReset = await conv.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT)
      const latestAfterReset = [...viewAfterReset.items].reverse().find((e) => e.kind !== 'pi.system')
      assert.ok(latestAfterReset)
      expectedVisibleId = Number(latestAfterReset.id)
      await waitFor(() => tracker.summaryOf(convId)?.lastEntryId === expectedVisibleId, 5_000)
      assert.equal(summaryOf(store.getConv(convId)!, 'idle', 0).lastEntryId, expectedVisibleId)

      tracker.close()
      await store.flushPublic()
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }

    // Reopen database + HelmStore + ConversationTracker: lastEntryId is restored accurately.
    const db2 = await openHelmDatabase(dir)
    const store2 = new HelmStore(db2)
    await store2.load()
    const { models: models2 } = makeFauxModels()
    const registry2 = createRegistry()
    const harness2 = await Harness.open(
      db2.storage,
      { models: () => models2, registry: registry2, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness2.resume()
    try {
      const tracker2 = new ConversationTracker({
        harness: harness2,
        store: store2,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: () => {},
        },
      })
      await tracker2.observe(convId)
      assert.equal(summaryOf(store2.getConv(convId)!, 'idle', 0).lastEntryId, expectedVisibleId)
      assert.equal(tracker2.summaryOf(convId)?.lastEntryId, expectedVisibleId)
      tracker2.close()
    } finally {
      await harness2.close(BACKGROUND_CONTEXT)
      await store2.close()
      await db2.close()
    }
  })
})
