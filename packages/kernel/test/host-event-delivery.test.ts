/**
 * 宿主事件单一投递边界回归（真实 KernelRuntime + faux provider）。
 *
 * 修复缺陷：EventHub 内部宿主投递器（publish 恰一次）引入前，公开
 * emitHostEvent 广播路径在 events.publish 之后再自行 dispatchInternalEvent，
 * 与构造器期的 SSE 帧订阅转投叠加导致插件/host 主动 emit 的核心会话事件
 * 被内部监听器执行两遍（且两次载荷形状不一致：信封 vs 原始载荷）。
 *
 * 现契约：
 * 1. 公开广播 emitHostEvent('conversation.entry' 等核心类型)：内部监听器
 *    恰一次、收到已验证+脱敏的 HelmEvent 信封；返回的 Promise 在全部已注册
 *    异步内部监听器完成后才 settle（emitEvent 可 await 契约）；SSE 恰一帧。
 * 2. 内核自动生成事件（真实提交 -> tracker 发布 conversation.entry）：内部
 *    监听器与 SSE 帧逐条一一对应，恰一次无重复。
 * 3. broadcast:false：不进 SSE（seq 不推进）、内部监听器恰一次。
 * 4. 内核自动事件路径发布点不被内部监听器阻塞（fire-and-forget；监听器错误
 *    由投递器内部隔离，不产生 unhandledRejection）。
 *
 * runner: tsx --test；每项显式 timeout 防死锁。
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

/** 经插件注册内部监听器（真实 ctx.host.onEvent 路径，含 host-api 生命周期包装）。 */
async function registerEntryListener(
  kernel: KernelRuntime,
  onCall: (entryId: string) => MaybePromise<void>,
): Promise<void> {
  await kernel.plugins.register({
    id: 'test:entry-listener',
    definePlugin(ctx) {
      ctx.host.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: { id?: string } }).entry
        if (entry?.id === undefined) throw new Error('内部监听器必须收到 HelmEvent 信封（entry 字段缺失）')
        return onCall(entry.id)
      })
    },
  })
}

describe('宿主事件单一投递边界', { timeout: 60_000 }, () => {
  it('公开广播 emitHostEvent(conversation.entry)：内部恰一次、信封形状、Promise 等待异步监听器完成；SSE 恰一帧', { timeout: 60_000 }, async () => {
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
      assert.ok(emit instanceof Promise, 'emitEvent 广播路径返回可 await 的投递 Promise')
      void Promise.resolve(emit).then(() => settled.resolve(), () => settled.resolve())

      // 监听器已进入但未完成：emit Promise 不得提前 settle（可 await 契约）。
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(entered, 1, '内部监听器恰调用一次')
      assert.equal(completed, 0)
      let settledEarly = false
      void settled.promise.then(() => {
        settledEarly = true
      })
      await new Promise((r) => setImmediate(r))
      assert.equal(settledEarly, false, '异步监听器完成前 emit Promise 不得 settle')

      gate.resolve()
      await emit
      assert.equal(completed, 1, 'gate 释放后监听器完成')
      assert.equal(entered, 1, '全程恰调用一次（无双重投递）')
      // SSE 广播恰一帧且为同一 entry。
      const matched = frames.filter((f) => {
        const event = f.event as { conversationId?: number; entry?: { id?: string } }
        return event.conversationId === 1 && event.entry?.id === 'manual-e1'
      })
      assert.equal(matched.length, 1, 'SSE 恰一帧')
    } finally {
      await kernel.close()
    }
  })

  it('plugin.changed 特殊发布路径也等待异步内部监听器', { timeout: 60_000 }, async () => {
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

  it('EventHub.close 解除宿主投递器，不保留运行时回调', { timeout: 60_000 }, () => {
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

  it('内核自动生成事件（真实提交）：内部监听器与 SSE 帧逐条一一对应，恰一次', { timeout: 60_000 }, async () => {
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

      kernel.__faux.setResponses([fauxAssistantMessage('回答一'), fauxAssistantMessage('回答二')])
      await kernel.submitInput(1, '第一问')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '第二问')
      await kernel.waitForIdle(1)
      // 观察者路径为 fire-and-forget：等内部投递收敛（waitFor 轮询真实到达）。
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.ok(internalIds.length >= 2, '自动 conversation.entry 已投递内部监听器')
      assert.deepEqual(
        [...internalIds].sort(),
        [...sseIds].sort(),
        '内部监听器收到的 entry 与 SSE 帧逐条一致（恰一次，无双重投递）',
      )
      assert.equal(new Set(internalIds).size, internalIds.length, '同一 entry 不重复投递')
    } finally {
      await kernel.close()
    }
  })

  it('broadcast:false：不进 SSE（seq 不推进），内部监听器恰一次', { timeout: 60_000 }, async () => {
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

      assert.equal(received.length, 1, '内部监听器恰一次')
      // broadcast:false 保持既有语义：不经 buildEvent，载荷原样直达内部监听器。
      assert.equal((received[0] as { id?: number }).id, 1)
      assert.equal(kernel.events.seq, seqBefore, 'broadcast:false 不推进 SSE seq')
      const upsertFrames = frames.filter((f) => f.event.type === 'conversation.upsert')
      assert.equal(upsertFrames.length, 0, 'broadcast:false 不广播')
    } finally {
      await kernel.close()
    }
  })

  it('自动事件路径不被监听器阻塞：慢监听器不影响发布方推进，监听器错误不产生 unhandledRejection', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-nonblocking'))
    try {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      const gate = deferred()
      let slowEntered = 0
      // 同类型注册两个监听器：慢监听器（gate 挂起）+ 抛错监听器，验证互不阻断。
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

      kernel.__faux.setResponses([fauxAssistantMessage('回答')])
      // submitInput 全链路（含 tracker 观察者发布 conversation.entry）在慢监听器
      // 挂起期间照常完成——自动事件发布点不 await 内部投递。
      const submitted = kernel.submitInput(1, '慢监听器下的问题')
      const deadline = Date.now() + 5_000
      while (slowEntered < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(slowEntered >= 1, '慢监听器已被投递（进入挂起）')
      const idle = kernel.waitForIdle(1)
      await Promise.race([
        idle.then(() => 'idle'),
        new Promise((r) => setTimeout(() => r('timeout'), 5_000)),
      ]).then((v) => assert.notEqual(v, 'timeout', '慢监听器不得阻塞回合推进'))
      await submitted

      gate.resolve()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(unhandled.length, 0, '监听器错误由投递器隔离，无 unhandledRejection')
      process.off('unhandledRejection', onUnhandled)
    } finally {
      await kernel.close()
    }
  })
})
