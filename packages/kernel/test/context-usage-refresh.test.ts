/**
 * Deterministic unit tests for ConversationTracker contextUsage refresh (fake harness, real tracker):
 *
 * 1. Boundary watermark: historical markers in initial snapshot (e.g., pi.compaction) and non-context-anchor
 *    observations (pi.user / pi.tool-result) never re-schedule refreshes; each new pi.assistant step and each new
 *    boundary marker (pi.compaction / pi.reset / helmx.rewind) above the prior watermark triggers a single refresh;
 * 2. ensureContextUsage: concurrent callers coalesce onto a single in-flight refresh; cached values skip refresh;
 * 3. Epoch generation guard (including undefined transitions): when an unobserved conversation refresh races with
 *    concurrent observe(), stale late results are discarded without poisoning cache;
 * 4. stopObserving / post-deletion late refreshes never resurrect caches or emit ghost events;
 * 5. Initial populate carrying compacting=true must publish upsert (so subscribers never remain blind);
 *    without active compaction, initial populate stays silent;
 * 6. Honest window provenance: default fallback windows with helmxContextWindowKnown === false are omitted
 *    rather than reported as known;
 * 7. Compaction failure notification: each new compactionFailure emits one redacted error notification,
 *    repeated snapshots for the same taskId do not re-notify, and new taskIds report again;
 * 8. Registry-wide invalidation (onModelsChanged): unknown->known / known->removed window transitions update
 *    existing refresh chains, reach summaries via usage-only updates without advancing stateChangeSeq, filter out
 *    unrelated providers, deduplicate unchanged frames, and mark dirty during in-flight updates;
 * 9. Mid-run updates: both contextWindow shifts and newly persisted pi.assistant steps (tokens 0 -> measured,
 *    or post-compaction null -> measured) publish immediately during active runs without advancing stateChangeSeq,
 *    while identical values deduplicate without re-emitting.
 *
 * Determinism: scheduling and harness.conversation() invocations occur synchronously; async propagation uses
 * manually resolved deferreds or ensureContextUsage settlement without relying on sleeps or wall-clock timers.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ContextView, ConversationView, Harness, Observation, Observer } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import type { Models, Provider, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helmx/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import type { ConvMeta, HelmxStore } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// Test builders
// ---------------------------------------------------------------------------

interface EntrySpec {
  id: number
  kind: string
}

function viewOf(spec: { entries?: EntrySpec[]; live?: Record<string, unknown> }): ConversationView {
  return {
    entries: (spec.entries ?? []) as never,
    docs: spec.live !== undefined ? { 'pi.live': spec.live } : {},
  } as never as ConversationView
}

function userContent(chars: number): UserMessage {
  return { role: 'user', content: 'a'.repeat(chars), timestamp: 1 }
}

/** Construct a ContextView whose token estimate matches character count. */
function usageView(chars: number): ContextView {
  return {
    head: undefined,
    entries: [],
    contributions: [],
    messages: [userContent(chars)],
  } as unknown as ContextView
}

function tokensOf(chars: number): number {
  // Pinned expectation (pi-agent chars/4): usageView contains 'a'.repeat(chars).
  return Math.ceil(chars / 4)
}

type ContextResult = { view: ContextView } | { deferred: Promise<ContextView> }

class FakeHarness {
  /** Number of refreshContextUsageOnce invocations (increments synchronously before awaiting context()). */
  contextCalls = 0
  private readonly queue: ContextResult[] = []
  private observer: Observer<ConversationView> | undefined

  constructor(private readonly initial: ConversationView) {}

  pushView(view: ContextView): void {
    this.queue.push({ view })
  }

  pushDeferred(): { resolve: (view: ContextView) => void } {
    let resolve!: (view: ContextView) => void
    const deferred = new Promise<ContextView>((r) => {
      resolve = r
    })
    this.queue.push({ deferred })
    return { resolve }
  }

  /** Simulate SDK snapshot push (synchronously invokes tracker adopt path). */
  advance(view: ConversationView): void {
    this.observer?.advance({ kind: 'value', value: view } as never, undefined as never)
  }

  readonly observeConversation = async (
    _id: never,
    observer: Observer<ConversationView>,
  ): Promise<Observation<ConversationView>> => {
    this.observer = observer
    return { value: this.initial, detach: () => {} } as never
  }

  readonly conversation = async (): Promise<unknown> => {
    this.contextCalls += 1
    const queue = this.queue
    return {
      context: async (): Promise<ContextView> => {
        const item = queue.shift()
        if (item === undefined) return usageView(40)
        return 'deferred' in item ? await item.deferred : item.view
      },
    }
  }
}

class FakeStore {
  readonly convs = new Map<number, ConvMeta>()
  getConv(id: number): ConvMeta | undefined {
    return this.convs.get(id)
  }
  upsertConv(meta: ConvMeta): void {
    this.convs.set(meta.id, meta)
  }
}

function metaOf(model: string): ConvMeta {
  return {
    id: 1,
    title: 'conversation one',
    profileId: 'assistant',
    tags: [],
    nodeId: 'local',
    cwd: '/tmp',
    model,
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function eventsOf(): TrackerEvents & {
  summaries: ConversationSummary[]
  notifications: Array<{ level: string; title: string; body?: string; conversationId: number }>
} {
  const summaries: ConversationSummary[] = []
  const notifications: Array<{ level: string; title: string; body?: string; conversationId: number }> = []
  return {
    summaries,
    notifications,
    onSummaryChanged: (summary) => {
      summaries.push(summary)
    },
    onInputCommitted: () => {},
    onTurnSettled: async () => {},
    onAssistantText: () => {},
    onNotification: (payload) => {
      notifications.push(payload)
    },
  }
}

/** Minimal dual-model catalog with known vs unknown context windows. */
function modelsWithFaux(): Models {
  const models = createModels()
  const known = {
    id: 'm-known',
    name: 'm-known',
    provider: 'faux',
    api: 'openai-completions',
    baseUrl: 'http://faux.local',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 4_096,
  }
  const unknown = { ...known, id: 'm-unknown', contextWindow: 128_000, helmxContextWindowKnown: false }
  const provider = {
    id: 'faux',
    name: 'faux',
    baseUrl: 'http://faux.local',
    auth: {},
    getModels: () => [known, unknown],
    getAllModels: () => [known, unknown],
  } as unknown as Provider
  models.setProvider(provider)
  return models
}

function trackerEnv(options?: {
  model?: string
  initialEntries?: EntrySpec[]
  initialLive?: Record<string, unknown>
  redactError?: (text: string) => string
  /** Dynamic catalog reader (defaults to faux dual-model catalog); swap return value to simulate reload. */
  models?: () => Models
}): {
  harness: FakeHarness
  store: FakeStore
  events: ReturnType<typeof eventsOf>
  tracker: ConversationTracker
} {
  const harness = new FakeHarness(
    viewOf({ entries: options?.initialEntries, live: options?.initialLive ?? {} }),
  )
  const store = new FakeStore()
  store.convs.set(1, metaOf(options?.model ?? 'faux/m-known'))
  const events = eventsOf()
  const models = options?.models ?? modelsWithFaux
  const tracker = new ConversationTracker({
    harness: harness as unknown as Harness,
    store: store as unknown as HelmxStore,
    events,
    models: () => models(),
    ...(options?.redactError !== undefined ? { redactError: options.redactError } : {}),
  })
  return { harness, store, events, tracker }
}

/** Drain pending microtasks/macrotasks after resolving deferred refreshes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// 1. Boundary watermark (avoid redundant observation refreshes)
// ---------------------------------------------------------------------------

describe('context usage refresh: boundary watermark', { timeout: 60_000 }, () => {
  it('ignores historical markers, skips non-assistant/non-boundary entries, and triggers once per new assistant or boundary', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialEntries: [
        { id: 5, kind: 'pi.user' },
        { id: 6, kind: 'pi.compaction' },
      ],
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, 'initial attach (idle conversation) refreshes once')

    // Subsequent observations with only historical markers or non-anchor entries (pi.user / pi.tool-result) do not re-schedule.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.user' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, 'non-assistant/non-boundary new entry must not trigger refresh')
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.user' },
          { id: 8, kind: 'pi.tool-result' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, 'repeated snapshot with historical markers and tool-result must not trigger refresh')

    // New pi.assistant step above watermark: triggers exactly once (keeps long multi-step runs fresh).
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.user' },
          { id: 8, kind: 'pi.tool-result' },
          { id: 9, kind: 'pi.assistant' },
        ],
      }),
    )
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 'new pi.assistant entry triggers exactly one refresh')

    // Repeated snapshot containing the same pi.assistant does not re-trigger.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 9, kind: 'pi.assistant' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 2, 'already-scanned pi.assistant must not trigger again')

    // New boundary entry (id above prior watermark): triggers exactly once.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 9, kind: 'pi.assistant' },
          { id: 10, kind: 'helmx.rewind' },
        ],
      }),
    )
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 3, 'new marker entry triggers exactly one refresh')

    // Watermark advanced: repeated snapshot containing the same marker does not re-trigger.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 10, kind: 'helmx.rewind' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 3, 'already-scanned marker must not trigger again')
  })
})

// ---------------------------------------------------------------------------
// 2. ensureContextUsage: coalescing & cache hit
// ---------------------------------------------------------------------------

describe('context usage refresh: ensureContextUsage', { timeout: 60_000 }, () => {
  it('concurrent calls share a single refresh; cached hits do zero refreshes', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    const first = env.tracker.ensureContextUsage(1)
    const second = env.tracker.ensureContextUsage(1)
    await first
    await second
    assert.equal(env.harness.contextCalls, 1, 'concurrent ensure calls coalesce into one refresh')
    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage, 'cache is populated after awaiting ensureContextUsage')

    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, 'cached ensure call performs no additional refresh')
  })
})

// ---------------------------------------------------------------------------
// 3. Epoch guard (including undefined initial epoch transitions)
// ---------------------------------------------------------------------------

describe('context usage refresh: epoch generation guard', { timeout: 60_000 }, () => {
  it('unobserved refresh racing with concurrent observe: drops stale late value and uses fresh refresh', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    // R1: unobserved (generation === undefined) triggered via cache-miss read in summaryOf.
    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(800))
    env.tracker.summaryOf(1)
    assert.equal(env.harness.contextCalls, 1, 'cache miss read triggers initial refresh')

    // Concurrent observe: advances generation + adoptInitial schedules dirty follow-up (R1 in flight, doesn't spawn yet).
    const observed = env.tracker.observe(1)
    assert.equal(env.harness.contextCalls, 1, 'new trigger during in-flight refresh only sets dirty flag')
    await observed

    gate.resolve(usageView(120)) // R1 arrives late with stale value
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 're-runs once after R1 discarded')

    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage)
    assert.equal(usage.tokens, tokensOf(800), 'stale late result must never overwrite cache')
  })
})

// ---------------------------------------------------------------------------
// 4. stopObserving / late refresh after deletion
// ---------------------------------------------------------------------------

describe('context usage refresh: stopObserving and deletion guards', { timeout: 60_000 }, () => {
  it('late refresh after stopObserving never resurrects cache or emits events', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1)

    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(200))
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2, 'new refresh started (gated)')

    env.tracker.stopObserving(1)
    gate.resolve(usageView(60))
    await flush()
    assert.equal(env.events.summaries.length, 0, 'late result discarded after stopObserving emits zero ghost events')

    // If late refresh had resurrected cache, ensure would hit cache with 0 refreshes; must instead run a fresh refresh.
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 3, 'ensure triggers fresh refresh after stale discard')
    assert.equal(env.events.summaries.length, 1, 'explicit on-demand ensure after cache clear publishes fresh usage once ready')
  })

  it('late result when metadata deleted during refresh never writes back to cache', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)

    const gate = env.harness.pushDeferred()
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2)
    env.store.convs.delete(1)
    gate.resolve(usageView(90))
    await flush()

    // Already deleted: ensure returns immediately without scheduling.
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 'must not start new refresh after deletion')
    assert.equal(env.events.summaries.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 5. Initial populate event discipline
// ---------------------------------------------------------------------------

describe('context usage refresh: initial populate publishing rules', { timeout: 60_000 }, () => {
  it('publishes upsert when initial populate carries compacting=true (otherwise subscribers miss it)', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialLive: { compactions: [{ taskId: 9, trigger: 'manual', blocking: false }] },
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'initial populate with compacting state must publish')
    const usage = env.events.summaries[0]!.contextUsage
    assert.equal(usage?.compacting, true, 'published frame must carry compacting boolean')
  })

  it('stays silent on startup initial populate when not compacting (unchanged frame discipline)', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await flush()
    assert.equal(env.events.summaries.length, 0)
    assert.ok(env.tracker.summaryOf(1).contextUsage, 'quietly populated usage remains visible on read path')
  })

  it('on-demand ensureContextUsage or publishWhenReady publishes upsert when uncached usage becomes ready, without duplicating cached calls', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'uncached on-demand ensureContextUsage pushes upsert once ready')
    assert.ok(env.events.summaries[0]!.contextUsage)

    // Repeat while already cached: no extra refresh or duplicate upsert.
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'cached ensureContextUsage does not re-emit upsert')

    // Clear cache via stopObserving, then trigger fire-and-forget scheduleContextUsageRefresh(..., { publishWhenReady: true }).
    env.tracker.stopObserving(1)
    env.tracker.scheduleContextUsageRefresh(1, { publishWhenReady: true })
    await flush()
    assert.equal(env.events.summaries.length, 2, 'publishWhenReady pushes upsert after background refresh finishes')
  })
})

// ---------------------------------------------------------------------------
// 6. Honest window provenance (helmxContextWindowKnown)
// ---------------------------------------------------------------------------

describe('context usage refresh: honest window provenance', { timeout: 60_000 }, () => {
  it('known-window models carry contextWindow; default-placeholder models omit it', { timeout: 60_000 }, async () => {
    const known = trackerEnv({ model: 'faux/m-known' })
    await known.tracker.observe(1)
    await known.tracker.ensureContextUsage(1)
    const knownUsage = known.tracker.summaryOf(1).contextUsage!
    assert.ok(knownUsage)
    assert.equal(knownUsage.contextWindow, 200_000, 'real model window is carried verbatim')

    const unknown = trackerEnv({ model: 'faux/m-unknown' })
    await unknown.tracker.observe(1)
    await unknown.tracker.ensureContextUsage(1)
    const unknownUsage = unknown.tracker.summaryOf(1).contextUsage!
    assert.ok(unknownUsage)
    assert.ok(unknownUsage.tokens !== null && unknownUsage.tokens > 0, 'token usage estimate is still provided')
    assert.equal(unknownUsage.contextWindow, undefined, 'default placeholder window must not masquerade as known')
  })
})

// ---------------------------------------------------------------------------
// 7. Compaction failure notification (redaction + dedupe)
// ---------------------------------------------------------------------------

describe('context usage refresh: compaction failure notification', { timeout: 60_000 }, () => {
  it('new compactionFailure emits one redacted notification; same taskId repeats skip; new taskId notifies again', { timeout: 60_000 }, async () => {
    const failure = { taskId: 5, trigger: 'manual', error: 'sk-abc gateway 500' }
    const env = trackerEnv({
      initialLive: { compactionFailure: failure },
      redactError: (t) => t.replace('sk-abc', '***'),
    })
    await env.tracker.observe(1)
    assert.equal(env.events.notifications.length, 1, 'initial snapshot failure must report loudly')
    const notice = env.events.notifications[0]!
    assert.equal(notice.level, 'error')
    assert.equal(notice.title, 'Context compaction failed')
    assert.equal(notice.conversationId, 1)
    assert.match(notice.body ?? '', /\*\*\* gateway 500/, 'error summary must pass through redact callback')
    assert.ok(!(notice.body ?? '').includes('sk-abc'), 'secret must never echo back')

    // Same failure recurring in subsequent snapshots: must not duplicate notification.
    env.harness.advance(viewOf({ live: { compactionFailure: failure } }))
    env.harness.advance(viewOf({ live: { compactionFailure: failure, run: { taskId: 3, inputs: [] } } }))
    assert.equal(env.events.notifications.length, 1, 'same taskId must not re-notify')

    // New failure (new taskId): reports once again.
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
    assert.match(env.events.notifications[1]!.body ?? '', /threshold/)

    // Transient empty snapshot followed by identical taskId still suppressed (same-runtime dedupe).
    env.harness.advance(viewOf({ live: {} }))
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
  })
})

// ---------------------------------------------------------------------------
// 8. models.changed full completion (onModelsChanged)
// ---------------------------------------------------------------------------

/** Single-model faux catalog: known carries real window; unknown marks helmxContextWindowKnown=false; served=false simulates removed model. */
function modelsWithWindowState(window: number, known: boolean, served: boolean): Models {
  const models = createModels()
  const base = {
    id: 'm-1',
    name: 'm-1',
    provider: 'faux',
    api: 'openai-completions',
    baseUrl: 'http://faux.local',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    maxTokens: 4_096,
  }
  const model = known
    ? { ...base, contextWindow: window }
    : { ...base, contextWindow: 128_000, helmxContextWindowKnown: false }
  const list = served ? [model] : []
  const provider = {
    id: 'faux',
    name: 'faux',
    baseUrl: 'http://faux.local',
    auth: {},
    getModels: () => list,
    getAllModels: () => list,
  } as unknown as Provider
  models.setProvider(provider)
  return models
}

describe('context usage refresh: models.changed window backfill', { timeout: 60_000 }, () => {
  it('unknown->known: backfills window on idle conversation, delivers summary, and leaves stateChangeSeq untouched', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, undefined, 'initial catalog lacks window')
    const seqBefore = env.store.convs.get(1)!.stateChangeSeq
    env.events.summaries.length = 0

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000, 'window backfilled after catalog refresh')
    assert.equal(env.events.summaries.length, 1, 'usage change publishes summary for SSE')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'usage-only update must not advance stateChangeSeq')
  })

  it('provider filtering: unrelated providers skip refresh; identical-value duplicate events do not re-emit frames', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    const calls = env.harness.contextCalls
    env.tracker.onModelsChanged(['other'])
    assert.equal(env.harness.contextCalls, calls, 'unrelated provider must not trigger refresh')

    models = modelsWithWindowState(300_000, true, true)
    env.tracker.onModelsChanged(['faux'])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 300_000, 'matching provider triggers backfill')
    const published = env.events.summaries.length

    env.tracker.onModelsChanged([])
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, published, 'identical values deduplicate via fingerprint without re-emitting')
  })

  it('known->removed from provider: window reverts to unknown and publishes', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(400_000, true, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000)

    models = modelsWithWindowState(0, false, false)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, undefined, 'removed model reverts window to unknown')
    assert.ok(env.events.summaries.length >= 1, 'reverting to unknown also reaches summary')
  })

  it('second models.changed during in-flight refresh marks dirty rather than spawning concurrent refresh, ending with latest window', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)

    const gate = env.harness.pushDeferred()
    models = modelsWithWindowState(250_000, true, true)
    env.tracker.onModelsChanged([])
    const inFlight = env.harness.contextCalls
    models = modelsWithWindowState(999_000, true, true)
    env.tracker.onModelsChanged([])
    assert.equal(env.harness.contextCalls, inFlight, 'second event during in-flight must not spawn parallel refresh')

    gate.resolve(usageView(100))
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 999_000, 'dirty backfill ends with latest window')
  })

  it('unobserved cached conversation still updates on catalog refresh (even after stopObserving)', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    env.tracker.stopObserving(1)

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000, 'cached conversation updates even without observer')
  })
})

// ---------------------------------------------------------------------------
// 9. Mid-run publishing (window changes and per-step assistant token updates)
// ---------------------------------------------------------------------------

describe('context usage refresh: mid-run updates', { timeout: 60_000 }, () => {
  it('publishes immediately on window change rather than waiting for turn end; skips duplicate frames on unchanged window', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({
      model: 'faux/m-1',
      initialLive: { run: { taskId: 7, inputs: [] } },
      models: () => models,
    })
    await env.tracker.observe(1)
    await flush()
    assert.equal(env.events.summaries.length, 0, 'initial populate without compacting stays silent')
    const seqBefore = env.store.convs.get(1)!.stateChangeSeq

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000)
    assert.equal(env.events.summaries.length, 1, 'window change during active run must publish')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'must not advance stateChangeSeq')

    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'duplicate events with unchanged window must not re-emit')
  })

  it('publishes updated tokens mid-run when new pi.assistant steps commit (never frozen at 0 or stuck at null after in-run compaction)', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      model: 'faux/m-known',
      initialEntries: [{ id: 1, kind: 'helmx.input' }],
      initialLive: { run: { taskId: 11, inputs: [] } },
    })
    // Initial attach sees an empty context (tokens=0) just like a freshly created conversation entering its first long run.
    // (adoptInitial triggers initial refresh + seeds summaryOf while in-flight, queuing one dirty pass; keep both empty.)
    const emptyView = { head: undefined, entries: [], contributions: [], messages: [] } as unknown as ContextView
    env.harness.pushView(emptyView)
    env.harness.pushView(emptyView)
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.tokens, 0)
    env.events.summaries.length = 0
    const seqBefore = env.store.convs.get(1)!.stateChangeSeq
    const entries = (ids: Array<[number, string]>): EntrySpec[] => ids.map(([id, kind]) => ({ id, kind }))

    // Step 1 commits a pi.assistant entry while the run is still active (e.g. tool-use loop).
    env.harness.pushView(usageView(4_000))
    env.harness.advance(
      viewOf({
        entries: entries([
          [1, 'helmx.input'],
          [10, 'pi.assistant'],
        ]),
        live: { run: { taskId: 11, inputs: [] } },
      }),
    )
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.tokens, tokensOf(4_000))
    const step1Frames = env.events.summaries.filter((s) => s.contextUsage?.tokens === tokensOf(4_000))
    assert.equal(step1Frames.length, 1, 'first assistant step mid-run must publish non-zero tokens immediately')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'mid-run usage publish must not advance stateChangeSeq')

    // In-run compaction commits: transitions tokens to null (unknown until next assistant step).
    env.harness.pushView({
      head: { id: 11, kind: 'pi.compaction' } as never,
      entries: [{ id: 11, kind: 'pi.compaction' } as never],
      contributions: [[]],
      messages: [],
    } as unknown as ContextView)
    env.harness.advance(
      viewOf({
        entries: entries([
          [10, 'pi.assistant'],
          [11, 'pi.compaction'],
        ]),
        live: { run: { taskId: 11, inputs: [] } },
      }),
    )
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.tokens, null)
    assert.ok(
      env.events.summaries.some((s) => s.contextUsage?.tokens === null),
      'in-run compaction must publish tokens=null',
    )

    // Step 2 commits a new pi.assistant after compaction while the same run continues: recovers from null immediately.
    env.harness.pushView(usageView(12_000))
    env.harness.advance(
      viewOf({
        entries: entries([
          [10, 'pi.assistant'],
          [11, 'pi.compaction'],
          [12, 'pi.assistant'],
        ]),
        live: { run: { taskId: 11, inputs: [] } },
      }),
    )
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.tokens, tokensOf(12_000))
    const step2Frames = env.events.summaries.filter((s) => s.contextUsage?.tokens === tokensOf(12_000))
    assert.equal(step2Frames.length, 1, 'post-compaction assistant step mid-run must recover from null immediately')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'stateChangeSeq remains untouched across all usage updates')
  })
})
