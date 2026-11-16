/**
 * ConversationTracker context use amount refresh determinism single test (fake harness, real tracker):
 *
 * 1. boundary watermark line: initial snapshot inside history mark record (pi.compaction etc.) and connect continue ordinary observe update
 *    do not heavy scheduling refresh (without write put large); only exceeds old watermark line new mark record item exactly trigger once;
 * 2. ensureContextUsage: many caller merge the same time in-flight refresh; already cache zero refresh;
 * 3. proxy count guard (contains undefined catch): not observe conversation refresh in concurrency observe swap proxy after
 *    late to result discard, do not back write old value;
 * 4. stopObserving / metadata after deletion late to refresh does not resurrect cache, do not ghost event;
 * 5. first time fill carry compacting when must publish upsert(otherwise subscribe way forever see fewer than);
 *    without compress state first time fill keep static default;
 * 6. window source honest:helmContextWindowKnown === false static default window must not
 *    as known window carry (contextWindow omit);
 * 7. compress failed notify: new compactionFailure exactly once redaction error notification,
 *    the same taskId duplicate snapshot does not repeat notify, new taskId again report;
 * 8. models.changed set to force complete (onModelsChanged): unknown→known/known→remove window
 *    change via since has refresh chain append complete,usage-only update can reach summary and do not push enter
 *    stateChangeSeq;providers set to and same value duplicate event dedupe; in-flight placement dirty force complete;
 * 9. leap run during window change still publish (not silently to turn end), identical window does not resend frame.
 *
 * determinism: refresh scheduling and harness.conversation invoke all in sync segment occur (assertion i.e. when can
 * see); async push enter all via manually release deferred / ensureContextUsage settle event,
 * independent of sleep or count when.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ContextView, ConversationView, Harness, Observation, Observer } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import type { Models, Provider } from '@earendil-works/pi-ai'
import type { UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import type { ConvMeta, HelmStore } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// construct tool
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

/** refresh read to ContextView(tokens by message estimate compute length zone). */
function usageView(chars: number): ContextView {
  return {
    head: undefined,
    entries: [],
    contributions: [],
    messages: [userContent(chars)],
  } as unknown as ContextView
}

function tokensOf(chars: number): number {
  // fixed expectation (pi agent chars/4):usageView user message is 'a'.repeat(chars),
  // do not mirror by test implement.
  return Math.ceil(chars / 4)
}

/** refresh result queue items: i.e. when view or manually release deferred. */
type ContextResult = { view: ContextView } | { deferred: Promise<ContextView> }

class FakeHarness {
  /** refreshContextUsageOnce start time count (sync segment pass increase; assertion i.e. when visible). */
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

  /** simulated SDK snapshot push enter (sync invoke tracker adopt path). */
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

/** known/unknown window double model most small Models set (window source honest use). */
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
  const unknown = { ...known, id: 'm-unknown', contextWindow: 128_000, helmContextWindowKnown: false }
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
  /** directory set now read (default fixed faux double model); simulated directory refresh = re- assignment return value. */
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
    store: store as unknown as HelmStore,
    events,
    models: () => models(),
    ...(options?.redactError !== undefined ? { redactError: options.redactError } : {}),
  })
  return { harness, store, events, tracker }
}

/** arrange empty micro task chain (manually release deferred after wait for refresh chain converge). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// 1. boundary watermark line (observe refresh write put large)
// ---------------------------------------------------------------------------

describe('context use amount refresh: boundary watermark line', { timeout: 60_000 }, () => {
  it('history mark record does not trigger; ordinary update do not heavy scheduling; new mark record exactly trigger once', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialEntries: [
        { id: 5, kind: 'pi.user' },
        { id: 6, kind: 'pi.compaction' },
      ],
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, 'initial hang connect (idle conversation) exactly once refresh')

    // connect continue ordinary observe update: history contains pi.compaction but low at watermark line, must not heavy scheduling.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, 'ordinary new item must not trigger refresh')
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
          { id: 8, kind: 'pi.user' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, 'duplicate snapshot (contains history mark record) must not trigger refresh')

    // new boundary item (id exceeds old watermark line): exactly trigger once.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
          { id: 8, kind: 'pi.user' },
          { id: 9, kind: 'helm.rewind' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 2, 'new mark record item exactly trigger once refresh')

    // watermark line already push enter: the same mark record duplicate appear no longer trigger.
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 9, kind: 'helm.rewind' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 2, 'already scan mark record must not duplicate trigger')
  })
})

// ---------------------------------------------------------------------------
// 2. ensureContextUsage: merge and zero refresh
// ---------------------------------------------------------------------------

describe('context use amount refresh:ensureContextUsage', { timeout: 60_000 }, () => {
  it('concurrency invoke merge the same time refresh; already cache direct through zero refresh', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    const first = env.tracker.ensureContextUsage(1)
    const second = env.tracker.ensureContextUsage(1)
    await first
    await second
    assert.equal(env.harness.contextCalls, 1, 'concurrency ensure merge is once refresh')
    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage, 'wait for after cache already fill')

    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, 'already cache when ensure no longer refresh')
  })
})

// ---------------------------------------------------------------------------
// 3. proxy count guard (undefined catch same reference and compare)
// ---------------------------------------------------------------------------

describe('context use amount refresh: proxy count guard', { timeout: 60_000 }, () => {
  it('not observe conversation refresh encounter concurrency observe: late to old value discard, only new refresh takes effect', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    // R1: not observe (generation === undefined) when by summaryOf cache missing path trigger.
    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(800))
    env.tracker.summaryOf(1)
    assert.equal(env.harness.contextCalls, 1, 'cache missing read trigger once refresh')

    // concurrency observe: swap proxy + adoptInitial scheduling (R1 in-flight → dirty, do not immediately start).
    const observed = env.tracker.observe(1)
    assert.equal(env.harness.contextCalls, 1, 'in-flight refresh during new trigger only placement dirty')
    await observed

    gate.resolve(usageView(120)) // R1 late to old value
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 'R1 by discard after only heavy run once')

    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage)
    assert.equal(usage.tokens, tokensOf(800), 'late to old value must not back write cache')
  })
})

// ---------------------------------------------------------------------------
// 4. stop observe / after deletion late to refresh
// ---------------------------------------------------------------------------

describe('context use amount refresh: stop observe and delete guard', { timeout: 60_000 }, () => {
  it('stopObserving after late to refresh does not resurrect cache, do not event', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1)

    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(200))
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2, 'new refresh already start (gated)')

    env.tracker.stopObserving(1)
    gate.resolve(usageView(60))
    await flush()

    // if late to refresh re- cache,ensure direct through zero refresh; correct behavior is need to all new refresh.
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 3, 'late to result by discard,ensure must all new refresh')
    assert.equal(env.events.summaries.length, 0, 'stop observe after must not publish any ghost event')
  })

  it('refresh during metadata by delete: late to result do not back write cache', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)

    const gate = env.harness.pushDeferred()
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2)
    env.store.convs.delete(1)
    gate.resolve(usageView(90))
    await flush()

    // deleted:ensure immediately return and no longer scheduling.
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 'after deletion must not again start refresh')
    assert.equal(env.events.summaries.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 5. first time fill event discipline
// ---------------------------------------------------------------------------

describe('context use amount refresh: first time fill publish rule', { timeout: 60_000 }, () => {
  it('first time fill carry compacting when must publish upsert(subscribe way without after continue semantics frame visible)', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialLive: { compactions: [{ taskId: 9, trigger: 'manual', blocking: false }] },
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'first time fill carry compress state must publish')
    const usage = env.events.summaries[0]!.contextUsage
    assert.equal(usage?.compacting, true, 'publish frame must carry compacting boolean')
  })

  it('without compress state first time fill keep static default (frame discipline do not change)', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 0)
    assert.ok(env.tracker.summaryOf(1).contextUsage, 'static default fill via read path still visible')
  })
})

// ---------------------------------------------------------------------------
// 6. window source honest (helmContextWindowKnown)
// ---------------------------------------------------------------------------

describe('context use amount refresh: window source honest', { timeout: 60_000 }, () => {
  it('known window model carry contextWindow; static default mark record model omit', { timeout: 60_000 }, async () => {
    const known = trackerEnv({ model: 'faux/m-known' })
    await known.tracker.observe(1)
    await known.tracker.ensureContextUsage(1)
    const knownUsage = known.tracker.summaryOf(1).contextUsage!
    assert.ok(knownUsage)
    assert.equal(knownUsage.contextWindow, 200_000, 'policy expand window such as carry')

    const unknown = trackerEnv({ model: 'faux/m-unknown' })
    await unknown.tracker.observe(1)
    await unknown.tracker.ensureContextUsage(1)
    const unknownUsage = unknown.tracker.summaryOf(1).contextUsage!
    assert.ok(unknownUsage)
    assert.ok(unknownUsage.tokens !== null && unknownUsage.tokens > 0, 'use amount estimate compute still provide')
    assert.equal(unknownUsage.contextWindow, undefined, 'static default window must not show is known')
  })
})

// ---------------------------------------------------------------------------
// 7. compress failed notify (redaction + dedupe)
// ---------------------------------------------------------------------------

describe('context use amount refresh: compress failed notify', { timeout: 60_000 }, () => {
  it('new compactionFailure exactly once redaction error notification; the same taskId duplicate snapshot does not repeat; new taskId again report', { timeout: 60_000 }, async () => {
    const failure = { taskId: 5, trigger: 'manual', error: 'sk-abc gateway 500' }
    const env = trackerEnv({
      initialLive: { compactionFailure: failure },
      redactError: (t) => t.replace('sk-abc', '***'),
    })
    await env.tracker.observe(1)
    assert.equal(env.events.notifications.length, 1, 'initial snapshot failed must on report (not silently)')
    const notice = env.events.notifications[0]!
    assert.equal(notice.level, 'error')
    assert.equal(notice.title, 'context streamline failed')
    assert.equal(notice.conversationId, 1)
    assert.match(notice.body ?? '', /\*\*\* gateway 500/, 'error summary must via inject redact redaction')
    assert.ok(!(notice.body ?? '').includes('sk-abc'), 'secret must not back visible')

    // the same failed duplicate appear in after continue snapshot: must not duplicate notify.
    env.harness.advance(viewOf({ live: { compactionFailure: failure } }))
    env.harness.advance(viewOf({ live: { compactionFailure: failure, run: { taskId: 3, inputs: [] } } }))
    assert.equal(env.events.notifications.length, 1, 'the same taskId must not duplicate notify')

    // new failed (new taskId): again report once.
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
    assert.match(env.events.notifications[1]!.body ?? '', /threshold/)

    // without failed snapshot: do not; failed clear after again appear the same taskId also do not heavy report (same runtime dedupe).
    env.harness.advance(viewOf({ live: {} }))
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
  })
})

// ---------------------------------------------------------------------------
// 8. models.changed set to force complete (onModelsChanged)
// ---------------------------------------------------------------------------

/** single model faux directory collection:known carry real window; unknown use static default mark record;
 * served=false simulated provider no longer supply should model (getModel life do not in). */
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
    : { ...base, contextWindow: 128_000, helmContextWindowKnown: false }
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

describe('context use amount refresh:models.changed set to force complete', { timeout: 60_000 }, () => {
  it('unknown→known:idle conversation do not new input also append complete window,summary can reach and do not push enter stateChangeSeq', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, undefined, 'initial directory without window')
    const seqBefore = env.store.convs.get(1)!.stateChangeSeq
    env.events.summaries.length = 0

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000, 'directory refresh after window append complete')
    assert.equal(env.events.summaries.length, 1, 'use amount change must publish summary(can reach SSE)')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'usage-only must not push enter stateChangeSeq')
  })

  it('providers set to: non- target provider does not refresh; same value duplicate event does not resend frame', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    const calls = env.harness.contextCalls
    env.tracker.onModelsChanged(['other'])
    assert.equal(env.harness.contextCalls, calls, 'non- target provider must not trigger refresh')

    models = modelsWithWindowState(300_000, true, true)
    env.tracker.onModelsChanged(['faux'])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 300_000, 'set to hit after append complete')
    const published = env.events.summaries.length

    env.tracker.onModelsChanged([])
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, published, 'same value duplicate event via refer grain dedupe does not resend frame')
  })

  it('known→provider no longer supply should: window restore unknown concurrency publish', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(400_000, true, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000)

    models = modelsWithWindowState(0, false, false)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, undefined, 'model do not in set: window restore unknown')
    assert.ok(env.events.summaries.length >= 1, 'restore unknown also want can reach summary')
  })

  it('refresh in-flight during second event placement dirty force complete: do not and start new refresh, eventually take most new window', { timeout: 60_000 }, async () => {
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
    assert.equal(env.harness.contextCalls, inFlight, 'in-flight during second event must not and start new refresh')

    gate.resolve(usageView(100))
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 999_000, 'dirty force complete after take most new window')
  })

  it('not observe but has cache conversation same append complete (stopObserving after directory refresh still update cache)', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({ model: 'faux/m-1', models: () => models })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    env.tracker.stopObserving(1)

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000, 'cache conversation do not observe also append complete')
  })
})

// ---------------------------------------------------------------------------
// 9. leap run during window change publish
// ---------------------------------------------------------------------------

describe('context use amount refresh: leap run during window change', { timeout: 60_000 }, () => {
  it('window change still publish (not silently to turn end); identical window duplicate event does not resend frame', { timeout: 60_000 }, async () => {
    let models = modelsWithWindowState(0, false, true)
    const env = trackerEnv({
      model: 'faux/m-1',
      initialLive: { run: { taskId: 7, inputs: [] } },
      models: () => models,
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 0, 'first time fill without compacting keep static default')
    const seqBefore = env.store.convs.get(1)!.stateChangeSeq

    models = modelsWithWindowState(400_000, true, true)
    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.tracker.summaryOf(1).contextUsage?.contextWindow, 400_000)
    assert.equal(env.events.summaries.length, 1, 'active run during window change must publish')
    assert.equal(env.store.convs.get(1)!.stateChangeSeq, seqBefore, 'do not push enter stateChangeSeq')

    env.tracker.onModelsChanged([])
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, 'identical window duplicate event must not duplicate frame')
  })
})
