/**
 * host event single one delivery boundary regression (real KernelRuntime + faux provider).
 *
 * fix defect:EventHub internal host delivery (publish exactly once) introduce before, public
 * emitHostEvent broadcast path in events.publish after again self row dispatchInternalEvent,
 * and construct phase SSE frame subscribe rotate throw stack add leads to plugin/host actively emit core conversation event
 * by internal listener execute two iterate (and two time payload shape inconsistent: message seal vs original payload).
 *
 * now contract:
 * 1. public broadcast emitHostEvent('conversation.entry' etc. core type): internal listener
 *    exactly once, receives already verify+redaction HelmEvent message seal; return Promise in all registered
 *    async internal listener after completion only then settle(emitEvent can await contract);SSE exactly one frame.
 * 2. kernel automatically generate event (real commit -> tracker publish conversation.entry): internal
 *    listener and SSE frame one by one one one for should, exactly once without duplicate.
 * 3. broadcast:false: does not enter SSE(seq do not push enter), internal listener exactly once.
 * 4. kernel automatically event path publish point do not by internal listener block (fire-and-forget; listener error
 *    by delivery internal isolated, produces no unhandledRejection).
 *
 * runner: tsx --test; each items explicit timeout guard against deadlock.
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

/** via plugin register internal listener (real ctx.host.onEvent path, contains host-api lifecycle wrap). */
async function registerEntryListener(
  kernel: KernelRuntime,
  onCall: (entryId: string) => MaybePromise<void>,
): Promise<void> {
  await kernel.plugins.register({
    id: 'test:entry-listener',
    definePlugin(ctx) {
      ctx.host.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: { id?: string } }).entry
        if (entry?.id === undefined) throw new Error('internal listener must receives HelmEvent message seal (entry field missing)')
        return onCall(entry.id)
      })
    },
  })
}

describe('host event single one delivery boundary', { timeout: 60_000 }, () => {
  it('public broadcast emitHostEvent(conversation.entry): internal exactly once, message seal shape,Promise wait for async listener complete;SSE exactly one frame', { timeout: 60_000 }, async () => {
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
      assert.ok(emit instanceof Promise, 'emitEvent broadcast path return can await delivery Promise')
      void Promise.resolve(emit).then(() => settled.resolve(), () => settled.resolve())

      // listener already enter but not complete:emit Promise must not mention before settle(can await contract).
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(entered, 1, 'internal listener exactly invoke once')
      assert.equal(completed, 0)
      let settledEarly = false
      void settled.promise.then(() => {
        settledEarly = true
      })
      await new Promise((r) => setImmediate(r))
      assert.equal(settledEarly, false, 'async listener complete before emit Promise must not settle')

      gate.resolve()
      await emit
      assert.equal(completed, 1, 'gate release after listener complete')
      assert.equal(entered, 1, 'all process exactly invoke once (without double heavy delivery)')
      // SSE broadcast exactly one frame and is the same entry.
      const matched = frames.filter((f) => {
        const event = f.event as { conversationId?: number; entry?: { id?: string } }
        return event.conversationId === 1 && event.entry?.id === 'manual-e1'
      })
      assert.equal(matched.length, 1, 'SSE exactly one frame')
    } finally {
      await kernel.close()
    }
  })

  it('plugin.changed special publish path also wait for async internal listener', { timeout: 60_000 }, async () => {
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

  it('EventHub.close solve except host delivery, do not keep runtime call back', { timeout: 60_000 }, () => {
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

  it('kernel automatically generate event (real commit): internal listener and SSE frame one by one one one for should, exactly once', { timeout: 60_000 }, async () => {
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
      await kernel.submitInput(1, 'one question')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'second question')
      await kernel.waitForIdle(1)
      // observer path is fire-and-forget: etc. internal delivery converge (waitFor polling real reach).
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.ok(internalIds.length >= 2, 'automatically conversation.entry already delivery internal listener')
      assert.deepEqual(
        [...internalIds].sort(),
        [...sseIds].sort(),
        'internal listener receives entry and SSE frame one by one consistent (exactly once, without double heavy delivery)',
      )
      assert.equal(new Set(internalIds).size, internalIds.length, 'the same entry does not repeat delivery')
    } finally {
      await kernel.close()
    }
  })

  it('broadcast:false: does not enter SSE(seq do not push enter), internal listener exactly once', { timeout: 60_000 }, async () => {
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

      assert.equal(received.length, 1, 'internal listener exactly once')
      // broadcast:false keep since has semantics: do not via buildEvent, payload original direct reach internal listener.
      assert.equal((received[0] as { id?: number }).id, 1)
      assert.equal(kernel.events.seq, seqBefore, 'broadcast:false do not push enter SSE seq')
      const upsertFrames = frames.filter((f) => f.event.type === 'conversation.upsert')
      assert.equal(upsertFrames.length, 0, 'broadcast:false do not broadcast')
    } finally {
      await kernel.close()
    }
  })

  it('automatically event path do not by listener block: slow listener does not affect publish way push enter, listener error produces no unhandledRejection', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-nonblocking'))
    try {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      const gate = deferred()
      let slowEntered = 0
      // same type register two listener: slow listener (gate suspended)+ throws listener, verify mutual do not block assert.
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
      // submitInput all link (contains tracker observer publish conversation.entry) in slow listener
      // suspended during per common complete - - automatically event publish point do not await internal delivery.
      const submitted = kernel.submitInput(1, 'slow listener under issue')
      const deadline = Date.now() + 5_000
      while (slowEntered < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(slowEntered >= 1, 'slow listener already by delivery (enter suspended)')
      const idle = kernel.waitForIdle(1)
      await Promise.race([
        idle.then(() => 'idle'),
        new Promise((r) => setTimeout(() => r('timeout'), 5_000)),
      ]).then((v) => assert.notEqual(v, 'timeout', 'slow listener must not block turn push enter'))
      await submitted

      gate.resolve()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(unhandled.length, 0, 'listener error by delivery isolated, without unhandledRejection')
      process.off('unhandledRejection', onUnhandled)
    } finally {
      await kernel.close()
    }
  })
})
