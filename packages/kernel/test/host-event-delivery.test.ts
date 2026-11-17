/**
 * Single-delivery regression tests for host events (real KernelRuntime + faux provider).
 *
 * Fixed bug: before EventHub's internal host delivery (single publish path) was introduced,
 * emitHostEvent's broadcast path called dispatchInternalEvent manually after events.publish,
 * and subscription during build also ran SSE fanout, causing active plugin/host emissions of
 * core conversation events to invoke internal listeners twice (and with mismatched payload shapes:
 * full envelope vs raw payload).
 *
 * Current contract:
 * 1. Public broadcast emitHostEvent('conversation.entry', etc.): internal listeners fire once,
 *    receiving the validated + redacted HelmEvent envelope; returned Promise settles only after
 *    all registered async internal listeners finish (awaitable emitEvent contract); SSE emits 1 frame.
 * 2. Kernel-generated events (real commit -> tracker publishes conversation.entry): internal
 *    listeners and SSE frames correspond 1-to-1, once each with zero duplicates.
 * 3. broadcast:false: skips SSE (seq does not advance), internal listeners fire once.
 * 4. Kernel auto-event publish sites are non-blocking with respect to internal listeners
 *    (fire-and-forget; listener errors are isolated inside delivery with zero unhandledRejection).
 *
 * Runner: tsx --test; every test specifies explicit timeout against deadlocks.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { HelmEventFrame, MaybePromise } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { EventHub } from '../src/runtime/events.js'
import { cleanupDir, deferred, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

let root: string

before(async () => {
  root = await makeTempDir('helm-host-event-delivery-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Registers an internal listener via plugin (real ctx.host.onEvent path, including host-api wrappers). */
async function registerEntryListener(
  kernel: KernelRuntime,
  onCall: (entryId: string) => MaybePromise<void>,
): Promise<void> {
  await kernel.plugins.register({
    id: 'test:entry-listener',
    definePlugin(ctx) {
      ctx.host.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: { id?: string } }).entry
        if (entry?.id === undefined) throw new Error('internal listener must receive HelmEvent envelope (missing entry field)')
        return onCall(entry.id)
      })
    },
  })
}

describe('host event single-delivery contract', { timeout: 60_000 }, () => {
  it('public broadcast emitHostEvent(conversation.entry): fires internal once with envelope, Promise waits for async listeners, SSE emits once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'public-emit-once'))
    try {
      const gate = deferred()
      let entered = 0
      let completed = 0
      await registerEntryListener(kernel, async () => {
        entered += 1
        await gate.promise
        completed += 1
      })
      const frames: HelmEventFrame[] = []
      kernel.events.subscribe((frame) => {
        if (frame.event.type === 'conversation.entry') frames.push(frame)
      })

      const settled = deferred()
      const emit = kernel.emitHostEvent('conversation.entry', {
        conversationId: 1,
        entry: { id: 'manual-e1', kind: 'helm.note', createdAt: 1, data: { n: 1 } },
      })
      assert.ok(emit instanceof Promise, 'emitEvent broadcast path returns an awaitable delivery Promise')
      void Promise.resolve(emit).then(() => settled.resolve(), () => settled.resolve())

      // Listener entered but not finished: emit Promise must not settle early (awaitable contract).
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(entered, 1, 'internal listener invoked once')
      assert.equal(completed, 0)
      let settledEarly = false
      void settled.promise.then(() => {
        settledEarly = true
      })
      await new Promise((r) => setImmediate(r))
      assert.equal(settledEarly, false, 'emit Promise must not settle before async listener completes')

      gate.resolve()
      await emit
      assert.equal(completed, 1, 'listener completes after gate opens')
      assert.equal(entered, 1, 'invoked exactly once overall (never double-delivered)')
      // SSE broadcast emits one matching frame.
      const matched = frames.filter((f) => {
        const event = f.event as { conversationId?: number; entry?: { id?: string } }
        return event.conversationId === 1 && event.entry?.id === 'manual-e1'
      })
      assert.equal(matched.length, 1, 'exactly one SSE frame emitted')
    } finally {
      await kernel.close()
    }
  })

  it('plugin.changed special publish path also waits for async internal listeners', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'plugin-event-await'))
    const gate = deferred()
    const entered = deferred()
    let calls = 0
    let settled = false
    let release: (() => void) | undefined
    try {
      await kernel.plugins.register({ id: 'test:lifecycle-event', definePlugin() {} })
      const plugin = kernel.plugins.list().find((item) => item.id === 'test:lifecycle-event')!
      release = kernel.onEvent('plugin.changed', async () => {
        calls++
        entered.resolve()
        await gate.promise
      })
      const published = kernel.emitHostEvent('plugin.changed', { plugin, ui: [] })
      assert.ok(published instanceof Promise)
      void published.then(() => { settled = true })
      await entered.promise
      await new Promise((done) => setImmediate(done))
      assert.equal(settled, false)
      assert.equal(calls, 1)
      gate.resolve()
      await published
      assert.equal(settled, true)
    } finally {
      gate.resolve()
      release?.()
      await kernel.close()
    }
  })

  it('EventHub.close detaches host dispatcher rather than retaining runtime callback', { timeout: 60_000 }, () => {
    const events = new EventHub({
      initialSeq: 0,
      snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }),
      persistSeq: () => {},
    })
    let delivered = 0
    events.setHostDispatcher(() => { delivered++ })
    events.publish('test:before-close', {})
    assert.equal(delivered, 1)
    events.close()
    events.publish('test:after-close', {})
    assert.equal(delivered, 1)
  })

  it('kernel-generated events (real commit): internal listener and SSE frames align 1-to-1, once each', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-events-once'))
    try {
      const internalIds: string[] = []
      const sseIds: string[] = []
      await registerEntryListener(kernel, (entryId) => {
        internalIds.push(entryId)
      })
      kernel.events.subscribe((frame) => {
        if (frame.event.type !== 'conversation.entry') return
        const entry = (frame.event as { entry?: { id?: string } }).entry
        if (entry?.id !== undefined) sseIds.push(entry.id)
      })

      kernel.__faux.setResponses([fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')])
      await kernel.submitInput(1, 'first question')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'second question')
      await kernel.waitForIdle(1)
      // Observer path is fire-and-forget: wait for internal delivery to catch up.
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.ok(internalIds.length >= 2, 'kernel conversation.entry events delivered to internal listener')
      assert.deepEqual(
        [...internalIds].sort(),
        [...sseIds].sort(),
        'internal listener entries and SSE frames match 1-to-1 (delivered once, never duplicated)',
      )
      assert.equal(new Set(internalIds).size, internalIds.length, 'no entry delivered twice')
    } finally {
      await kernel.close()
    }
  })

  it('broadcast:false skips SSE (without advancing seq) and invokes internal listener once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'private-emit-once'))
    try {
      const received: unknown[] = []
      await kernel.plugins.register({
        id: 'test:private-listener',
        definePlugin(ctx) {
          ctx.host.onEvent('conversation.upsert', (raw) => {
            received.push(raw)
          })
        },
      })
      const frames: HelmEventFrame[] = []
      kernel.events.subscribe((frame) => frames.push(frame))
      const seqBefore = kernel.events.seq

      const summary = {
        id: 1,
        title: 't',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp',
        model: '',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 99,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const emit = kernel.emitHostEvent('conversation.upsert', summary, { broadcast: false })
      await emit

      assert.equal(received.length, 1, 'internal listener invoked once')
      // broadcast:false preserves existing semantics: skips buildEvent and delivers payload directly.
      assert.equal((received[0] as { id?: number }).id, 1)
      assert.equal(kernel.events.seq, seqBefore, 'broadcast:false must not advance SSE seq')
      const upsertFrames = frames.filter((f) => f.event.type === 'conversation.upsert')
      assert.equal(upsertFrames.length, 0, 'broadcast:false must not broadcast')
    } finally {
      await kernel.close()
    }
  })

  it('kernel auto-event path is non-blocking: slow listeners do not stall publish, errors produce no unhandledRejection', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-nonblocking'))
    try {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      const gate = deferred()
      let slowEntered = 0
      // Register two listeners for the same type: a gated slow listener + a throwing listener, verifying neither blocks.
      await kernel.plugins.register({
        id: 'test:slow-listener',
        definePlugin(ctx) {
          ctx.host.onEvent('conversation.entry', async () => {
            slowEntered += 1
            await gate.promise
          })
          ctx.host.onEvent('conversation.entry', async () => {
            throw new Error('listener exploded')
          })
        },
      })

      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      // submitInput pipeline (including tracker observer publishing conversation.entry) completes normally while slow
      // listener stays suspended -- auto-event publish sites never await internal delivery.
      const submitted = kernel.submitInput(1, 'prompt under slow listener')
      const deadline = Date.now() + 5_000
      while (slowEntered < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(slowEntered >= 1, 'slow listener was invoked and suspended')
      const idle = kernel.waitForIdle(1)
      await Promise.race([
        idle.then(() => 'idle'),
        new Promise((r) => setTimeout(() => r('timeout'), 5_000)),
      ]).then((v) => assert.notEqual(v, 'timeout', 'slow listener must not block turn progression'))
      await submitted

      gate.resolve()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(unhandled.length, 0, 'listener errors are isolated inside delivery without unhandledRejection')
      process.off('unhandledRejection', onUnhandled)
    } finally {
      await kernel.close()
    }
  })
})
