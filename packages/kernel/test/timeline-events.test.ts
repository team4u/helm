/**
 * timeline and real-time view real link test.
 *
 * three layer each use real boundary (do not write mirror implement test):
 * 1. pure function layer:toConversationEntry / deriveConversationLive contract
 *    (id rotate string,model keep,JSON available validate reject non- JSON, not silently truncate).
 * 2. EventHub layer:conversation.entry / conversation.live / plugin.doc.updated /
 *    workflow.updated four core type direct pass and complete message seal double shape, illegal payload explicit
 *    throws, redaction keep;snapshot required ui/pluginDocs.
 * 3. real SDK layer:faux provider drive ConversationTracker - - observe initial history
 *    do not heavy entry, new written to the database entry each id exactly once,live node stream (75ms window) and terminal state
 *    conflict refresh,stopObserving after without ghost event,meta from entry.data rebuild throughout through back
 *    turn_settled payload,getProbeFacts based on real activity change.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness } from '@earendil-works/pi-durable'
import { createRegistry } from '@earendil-works/pi-durable'
import type { ConversationEntry, ConversationLive, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, toConversationEntry } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, summaryOf, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// tool
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

/** test use tracker event collect. */
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
// 1. pure function:toConversationEntry
// ---------------------------------------------------------------------------

describe('toConversationEntry', { timeout: 60_000 }, () => {
  it('id rotate string,kind/data/model keep (model is assistant text carrier)', () => {
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

  it('data original keep;id is string when do not change shape', () => {
    const entry = toConversationEntry({ id: '7', kind: 'helm.input', data: { origin: 'human' } })
    assert.equal(entry.id, '7')
    assert.deepEqual(entry.data, { origin: 'human' })
    assert.equal(entry.model, undefined)
  })

  it('non- JSON value explicit throw HelmError:Date/Map/loop/undefined field all not silently convert', () => {
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

  it('illegal id/kind explicit throws (do not fabricate)', () => {
    assert.throws(() => toConversationEntry({ id: null, kind: 'x' } as never), HelmError)
    assert.throws(() => toConversationEntry({ id: 1, kind: 3 } as never), HelmError)
  })
})

// ---------------------------------------------------------------------------
// 2. pure function:deriveConversationLive
// ---------------------------------------------------------------------------

describe('deriveConversationLive', { timeout: 60_000 }, () => {
  it('text is generation.message in text chunk cumulative snapshot (many chunk by order concatenate)', () => {
    const live = deriveConversationLive(
      5,
      {
        generation: {
          message: {
            content: [
              { type: 'thinking', thinking: 'push' },
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
    assert.equal(live.thinking, 'push')
    assert.deepEqual(live.tools, [])
    assert.equal(live.updatedAt, 123)
  })

  it('tools and nestedTools unify generate tool card:running/done mapping,input keep', () => {
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

  it('undefined live view is empty snapshot (do not throws)', () => {
    const live = deriveConversationLive(1, undefined, 1)
    assert.equal(live.text, '')
    assert.deepEqual(live.tools, [])
  })
})

// ---------------------------------------------------------------------------
// 3. EventHub: four new core type
// ---------------------------------------------------------------------------

describe('EventHub new core event type', { timeout: 60_000 }, () => {
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
    text: 'streaming in',
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

  it('conversation.entry: direct pass {conversationId,entry} and complete message seal {type,...} double shape', () => {
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

  it('conversation.live: double shape;live original carry do not second embed set', () => {
    const { hub, frames } = makeHub()
    hub.publish('conversation.live', { live })
    hub.publish('conversation.live', { type: 'conversation.live', live })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ live: ConversationLive }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.live, live)
    assert.deepEqual(e2.live, live)
  })

  it('plugin.doc.updated: double shape;doc three field complete', () => {
    const { hub, frames } = makeHub()
    hub.publish('plugin.doc.updated', { doc })
    hub.publish('plugin.doc.updated', { type: 'plugin.doc.updated', doc })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ doc: typeof doc }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.doc, doc)
    assert.deepEqual(e2.doc, doc)
  })

  it('workflow.updated: self define event original pass-through payload(orchestration plugin direct)', () => {
    const { hub, frames } = makeHub()
    hub.publish('workflow.updated', { run })
    hub.publish('workflow.updated', { type: 'workflow.updated', run })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ payload: { run: typeof run } }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.payload.run, run)
    assert.deepEqual(e2.payload.run, run)
  })

  it('illegal payload explicit throw HelmError and do not push enter seq(not silently fall back)', () => {
    const { hub, frames } = makeHub()
    // conversation.entry: missing conversationId / entry shape illegal
    assert.throws(() => hub.publish('conversation.entry', { entry }), HelmError)
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 1, entry: { id: 1 } }),
      HelmError,
    )
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 'x', entry }),
      HelmError,
    )
    // conversation.live: missing field
    assert.throws(() => hub.publish('conversation.live', { live: { conversationId: 1 } }), HelmError)
    assert.throws(() => hub.publish('conversation.live', {}), HelmError)
    // plugin.doc.updated: missing value / pluginId
    assert.throws(
      () => hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n' } }),
      HelmError,
    )
    // workflow.updated now is self define event (payload any JSON direct pass), no longer do
    // shape gate; unique boundary is JSON legal (loop reference etc.).
    assert.equal(hub.seq, 0, 'all failed do not push enter ordinal')
    assert.equal(frames.length, 0)
  })

  it('publish before unify redaction keep:entry/live/doc plaintext secret do not leak', () => {
    const { hub, frames } = makeHub()
    hub.redactFn = (t) => t.replaceAll('sk-plain', '[REDACTED]')
    hub.publish('conversation.entry', {
      conversationId: 1,
      entry: { id: '1', kind: 'helm.input', data: { text: 'upload sk-plain secret key' } },
    })
    hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n', value: 'token=sk-plain' } })
    const text = JSON.stringify(frames.map((f) => f.event))
    assert.ok(!text.includes('sk-plain'), 'event payload must not leak plaintext secret')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('snapshot required ui / pluginDocs field (new contract direct out, without compatibility default)', () => {
    const ui = [{ pluginId: 'p', surface: 'sidebar.item', spec: { id: 's1', label: 'X' } }]
    const docs = [{ pluginId: 'builtin:workflow', name: 'runs', value: { runs: [] } }]
    const { hub } = makeHub({ ui, pluginDocs: docs })
    const snap = hub.currentSnapshot()
    assert.deepEqual(snap.ui, ui)
    assert.deepEqual(snap.pluginDocs, docs)
  })
})

// ---------------------------------------------------------------------------
// 4. real SDK:faux provider drive ConversationTracker
// ---------------------------------------------------------------------------

describe('ConversationTracker real SDK timeline and real-time event', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-timeline-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  /** real Harness + SQLite + faux provider + tracker(do not fabricate KernelRuntime). */
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

  it('faux complete path: initial observe do not entry; new written to the database entry by id order exactly once;live reach and terminal state conflict refresh', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number

      // pre- placement history (observe before written to the database a write).
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 1 } } }, BACKGROUND_CONTEXT)
      await tracker.observe(id)
      assert.equal(collector.entries.length, 0, 'initial observe history item do not heavy')

      // real run:faux text answer -> helm.input + pi.assistant written to the database.
      // via real tracker API register (registerInput -> bindSubmission, and runtime same path;
      // append trace identity i.e. durable input.id = requestId).
      faux.setResponses([fauxAssistantMessage('real answer')])
      tracker.registerInput(id, {
        id: 'in-1',
        text: 'real issue',
        origin: 'human',
        createdAt: 1,
      })
      await conv
        .submit(
          {
            type: 'input',
            content: 'real issue',
            entry: {
              kind: 'helm.input',
              data: { id: 'in-1', text: 'real issue', origin: 'human', createdAt: 1 },
            },
            requestId: 'in-1',
          },
          BACKGROUND_CONTEXT,
        )
        .then((sub) => tracker.bindSubmission(id, 'in-1', sub.id as number))
      await conv.waitForIdle(BACKGROUND_CONTEXT)

      // wait for observer path complete (advance sync, but run compute in micro task inside).
      await waitFor(() => collector.entries.length >= 2, 5_000)
      const ids = collector.entries.map((e) => e.entry.id)
      assert.equal(new Set(ids).size, ids.length, 'each entry exactly once')
      assert.ok(ids.length >= 2)
      // id count value order = commit order keep.
      const numeric = ids.map(Number)
      for (let i = 1; i < numeric.length; i += 1) {
        assert.ok(numeric[i]! > numeric[i - 1]!, 'entry by commit order (id single tune)')
      }
      const kinds = collector.entries.map((e) => e.entry.kind)
      assert.ok(kinds.includes('helm.input'), 'helm.input entry event reach')
      assert.ok(kinds.some((k) => k.startsWith('pi.')), 'SDK internal entry event reach')
      // live terminal state conflict refresh: eventually one frame reach and conversationId correct.
      assert.ok(collector.lives.length >= 1, 'run during/terminal state at least one frame live')
    } finally {
      await close()
    }
  })

  it('live node stream:run during snapshot merge, terminal state after stop; frame interval do not low at node stream window amount level', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      await tracker.observe(id)
      // real run:faux text answer (streaming partial via pi.live.generation drive live derive).
      faux.setResponses([fauxAssistantMessage('streaming answer content')])
      await conv.submit({ type: 'input', content: 'run one round' }, BACKGROUND_CONTEXT)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      // wait for terminal state conflict refresh (emitSettled sync path) after frame count no longer increase long.
      await new Promise((r) => setTimeout(r, 150))
      const frozen = collector.lives.length
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(collector.lives.length, frozen, 'run after end without new live frame')
      // node stream correct: any adjacent two frame updatedAt interval >= 75ms amount level (same window by merge),
      // or frame count is 0/1(single window). do not fabricate frame count floor (take decide at real streaming rhythm).
      for (let i = 1; i < collector.lives.length; i += 1) {
        const prev = collector.lives[i - 1]!
        const curr = collector.lives[i]!
        assert.ok(
          curr.updatedAt - prev.updatedAt >= 60,
          `adjacent live frame interval ${curr.updatedAt - prev.updatedAt}ms low at node stream window (not merge same window snapshot)`,
        )
      }
      // each frame conversationId correct.
      for (const frame of collector.lives) assert.equal(frame.conversationId, id)
    } finally {
      await close()
    }
  })

  it('stopObserving clean timer and no longer produce entry/live event (without ghost event)', { timeout: 60_000 }, async () => {
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
      // stop observe after again write: do not event.
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 3 } } }, BACKGROUND_CONTEXT)
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(collector.entries.length, entriesAfter, 'stop observe after without entry ghost event')
      assert.equal(collector.lives.length, livesAfter, 'stop observe after without live ghost event')
    } finally {
      await close()
    }
  })

  it('meta from helm.input entry.data rebuild throughout through back turn_settled payload', { timeout: 60_000 }, async () => {
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
        text: 'carries meta issue',
        origin: 'agent',
        createdAt: 2,
        meta: { from: 'superagent', turn: 3 },
      })
      await conv
        .submit(
          {
            type: 'input',
            content: 'carries meta issue',
            entry: {
              kind: 'helm.input',
              data: {
                id: 'm-1',
                text: 'carries meta issue',
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
      assert.ok(withMeta, 'turn_settled inputs contains meta')
      assert.deepEqual(withMeta!.meta, { from: 'superagent', turn: 3 })
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })

  it('submissionIndex:bindSubmission after markConsumed can hit; compute after index leaves no residue', { timeout: 60_000 }, async () => {
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
        text: 'index verify issue',
        origin: 'human',
        createdAt: 3,
      })
      const submission = await conv.submit(
        {
          type: 'input',
          content: 'index verify issue',
          entry: { kind: 'helm.input', data: { id: 'ix-1', text: 'index verify issue', origin: 'human', createdAt: 3 } },
          requestId: 'ix-1',
        },
        BACKGROUND_CONTEXT,
      )
      tracker.bindSubmission(id, 'ix-1', submission.id as number)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1, 5_000)
      // run.inputs via index mapping hit:onInputCommitted exactly once and is requestId identity.
      assert.deepEqual(committed, ['ix-1'])
      assert.deepEqual(settled[0]!.inputs.map((i) => i.id), ['ix-1'])
      // compute after append trace record and related index all leaves no residue.
      const internals = (tracker as unknown as {
        mirrors: Map<number, { trackedInputs: Map<string, unknown>; submissionIndex: Map<number, string> }>
      })
      assert.equal(internals.mirrors.get(id)?.trackedInputs.size ?? 0, 0, 'compute after append trace record empty')
      assert.equal(internals.mirrors.get(id)?.submissionIndex.size ?? 0, 0, 'compute after related index empty')
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })
})
