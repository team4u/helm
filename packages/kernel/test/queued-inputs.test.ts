/**
 * queuedInputs（steer / followUp 待生效胶囊）真实链路测试。
 *
 * 覆盖：
 * 1. 纯函数层：deriveConversationLive 从 pi.inbox 排队项派生 queuedInputs
 *    （steer 优先排序、非法项跳过、origin/createdAt/attachments 边界）。
 * 2. 真实 SDK 层：会话 working 期间提交 steer 与 followUp，conversation.live
 *    事件携带 queuedInputs（steer 在前 followUp 在后）；排队项消费落入
 *    entries 后从 queuedInputs 移除。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness } from '@earendil-works/pi-durable'
import { createRegistry } from '@earendil-works/pi-durable'
import type { ConversationLive } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, type InboxItemLike } from '../src/runtime/entries.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, type ConvMeta } from '../src/runtime/store.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { createModels as createRuntimeModels } from '@earendil-works/pi-ai/models'

/** 轮询等待条件成立（防挂死，总超时显式）。 */
async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 快照中指定会话的实时视图（queuedInputs 事实源）。 */
function findLive(kernel: KernelRuntime, conversationId: number): ConversationLive | undefined {
  return (kernel.events.currentSnapshot().conversationLives ?? []).find(
    (l) => l.conversationId === conversationId,
  )
}

function convMeta(id: number): ConvMeta {
  return {
    id,
    title: `会话 ${id}`,
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

// ---------------------------------------------------------------------------
// 1. 纯函数：deriveConversationLive queuedInputs 派生
// ---------------------------------------------------------------------------

describe('deriveConversationLive queuedInputs', { timeout: 60_000 }, () => {
  it('steer 排在 followUp 之前（同 mode 保持原序），字段映射完整', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 11, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'fu-1', text: '第二个排队的', origin: 'human', createdAt: 200 } } },
      { id: 12, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'st-1', text: '插话引导的', origin: 'agent', createdAt: 100 } } },
      { id: 13, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'st-2', text: '第二个 steer', origin: 'trigger', createdAt: 150 } } },
    ]
    const live = deriveConversationLive(7, undefined, 999, inbox)
    assert.deepEqual(live.queuedInputs?.map((q) => q.id), ['st-1', 'st-2', 'fu-1'])
    const [first, second, third] = live.queuedInputs!.map((q) => q)
    assert.ok(first && second && third)
    assert.equal(first!.submissionId, '12')
    assert.equal(first!.mode, 'steer')
    assert.equal(first!.origin, 'agent')
    assert.equal(first!.createdAt, 100)
    assert.equal(second!.origin, 'trigger')
    assert.equal(third!.mode, 'followUp')
    assert.equal(third!.createdAt, 200)
  })

  it('非法项跳过：write 模式、非 helm.input、缺 id/text 均不产生 queuedInput', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 1, mode: 'write', entry: { kind: 'helm.note', data: { id: 'w', text: '写' } } },
      { id: 2, mode: 'steer', entry: { kind: 'pi.user', data: { id: 'x', text: '非 helm.input' } } },
      { id: 3, mode: 'followUp', entry: { kind: 'helm.input', data: { text: '缺 id' } } },
      { id: 4, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'no-text' } } },
      { id: 5, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'ok-1', text: '合法项' } } },
    ]
    const live = deriveConversationLive(1, undefined, 50, inbox)
    assert.deepEqual(live.queuedInputs?.map((q) => q.id), ['ok-1'])
    // origin 非法回退 human；createdAt 非法取 updatedAt。
    const q = live.queuedInputs![0]!
    assert.equal(q.origin, 'human')
    assert.equal(q.createdAt, 50)
  })

  it('attachments 非空数组保留、空数组省略；无排队项时 queuedInputs 省略', { timeout: 60_000 }, () => {
    const withAttachments = deriveConversationLive(1, undefined, 10, [
      {
        id: 9,
        mode: 'steer',
        entry: {
          kind: 'helm.input',
          data: {
            id: 'q-1',
            text: '带附件',
            attachments: [{ id: 'art_1', name: 'a.png', mimeType: 'image/png', size: 5 }],
          },
        },
      },
    ])
    assert.equal(withAttachments.queuedInputs?.[0]?.attachments?.length, 1)
    const emptyAttachments = deriveConversationLive(1, undefined, 10, [
      { id: 9, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'q-2', text: '空附件', attachments: [] } } },
    ])
    assert.equal(emptyAttachments.queuedInputs?.[0]?.attachments, undefined)
    const none = deriveConversationLive(1, undefined, 10, [])
    assert.equal(none.queuedInputs, undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. 真实 SDK：working 期间 steer / followUp 入队与消费
// ---------------------------------------------------------------------------

describe('ConversationTracker queuedInputs 实时事件', { timeout: 60_000 }, () => {
  let root = ''

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-queued-'))
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  type FauxHandle = ReturnType<typeof fauxProvider>
  async function openTracker(): Promise<{
    tracker: ConversationTracker
    harness: Harness
    store: HelmStore
    lives: ConversationLive[]
    faux: FauxHandle
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all', steeringMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const lives: ConversationLive[] = []
    const events: TrackerEvents = {
      onSummaryChanged: () => {},
      onInputCommitted: () => {},
      onAssistantText: () => {},
      onTurnSettled: () => {},
      onLiveChanged: (live) => lives.push(live),
    }
    const tracker = new ConversationTracker({ harness, store, events })
    return {
      tracker,
      harness,
      store,
      lives,
      faux,
      close: async () => {
        // 先停观察（清 live 节流 timer），再关 SDK 与数据库，防 timer 泄漏。
        for (const id of [...trackedIds]) tracker.stopObserving(id)
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
    }
  }
  const trackedIds = new Set<number>()

  it('working 期间提交 steer 与 followUp：live 携带 queuedInputs（steer 在前），消费后移除', { timeout: 60_000 }, async () => {
    const { tracker, harness, store, lives, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      trackedIds.add(id)
      // tracker 依赖 store meta 派生摘要（emitRunSummary/summaryOf）：
      // 观察前先登记会话镜像，否则 getConv miss 导致摘要路径跳过。
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      // 第一轮 run（长文本流式，保证提交排队项时 run 仍在进行）。
      faux.setResponses([fauxAssistantMessage('第一轮回答')])
      await conv.submit(
        {
          type: 'input',
          content: '第一轮问题',
          entry: { kind: 'helm.input', data: { id: 'base-1', text: '第一轮问题', origin: 'human', createdAt: 1 } },
          requestId: 'base-1',
        },
        BACKGROUND_CONTEXT,
      )

      // 等 run 开始（live 第一帧到达；观察推送在微任务/timer 后异步到达）。
      await waitFor(() => lives.length >= 1 || tracker.hasLiveWork(id), 5_000)

      // working 中提交 followUp（先入队）与 steer（后入队但优先级高）。
      await conv.submit(
        {
          type: 'input',
          content: '排队的后续输入',
          whenBusy: 'followUp',
          entry: { kind: 'helm.input', data: { id: 'q-fu', text: '排队的后续输入', origin: 'human', createdAt: 2 } },
          requestId: 'q-fu',
        },
        BACKGROUND_CONTEXT,
      )
      await conv.submit(
        {
          type: 'input',
          content: '插话引导的补充',
          whenBusy: 'steer',
          entry: { kind: 'helm.input', data: { id: 'q-st', text: '插话引导的补充', origin: 'human', createdAt: 3 } },
          requestId: 'q-st',
        },
        BACKGROUND_CONTEXT,
      )

      // queuedInputs 到达：steer 在前、followUp 在后（入队 0ms 冲刷路径）。
      await waitFor(() => lives.some((l) => (l.queuedInputs?.length ?? 0) >= 2), 5_000)
      const queuedFrame = lives.findLast((l) => (l.queuedInputs?.length ?? 0) >= 2)!
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.id), ['q-st', 'q-fu'])
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.mode), ['steer', 'followUp'])

      // 第一轮结束后 followUp 消费：新 run 的 helm.input entry 落库，
      // queuedInputs 移除（等待最后一帧不再携带这两个排队项）。
      faux.appendResponses([fauxAssistantMessage('第二轮回答')])
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(
        () => {
          const tail = lives[lives.length - 1]
          return tail === undefined || (tail.queuedInputs ?? []).every((q) => q.id !== 'q-st' && q.id !== 'q-fu')
        },
        5_000,
      )
      const tail = lives[lives.length - 1]!
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-st'), false, 'steer 消费后从 queuedInputs 移除')
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-fu'), false, 'followUp 消费后从 queuedInputs 移除')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 真实 KernelRuntime：SSE 快照恢复 queuedInputs（faux Promise gate 控时）
// ---------------------------------------------------------------------------

describe('KernelRuntime snapshot conversationLives', { timeout: 60_000 }, () => {
  let root = ''

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-queued-snap-'))
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('run 进行中 followUp/steer 入队后，重连快照携带 queuedInputs（无需再提交或再 token）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'snap1')
    const models = createRuntimeModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    let entered!: () => void
    let answer!: (message: ReturnType<typeof fauxAssistantMessage>) => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { answer = resolve })
    faux.setResponses([async () => { entered(); return held }])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      watchdogIntervalMs: 0,
    })
    try {
      const conv = await kernel.createConversation({ title: '快照恢复' })
      const submit1 = kernel.submitInput(conv.id, '第一轮问题')
      await started
      // run 已在途（模型请求被 gate 挂起）：提交 steer 与 followUp 入队。
      await Promise.all([
        kernel.submitInput(conv.id, '排队的后续输入', { whenBusy: 'followUp' }),
        kernel.submitInput(conv.id, '插话引导的补充', { whenBusy: 'steer' }),
      ])
      // 队列事实落库后取快照：重连场景下客户端凭这一帧恢复胶囊，
      // 不需要再提交输入或等待下一个模型 token。
      await waitFor(() => {
        const snap = kernel.events.currentSnapshot()
        const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const snap = kernel.events.currentSnapshot()
      const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
      assert.ok(live, '快照应包含该会话的实时视图')
      // requestId 由内核随机生成（无法预知），按 text+mode 断言两条排队事实。
      const queued = live!.queuedInputs!
      assert.equal(queued.length, 2)
      const byText = new Map(queued.map((q) => [q.text, q]))
      assert.equal(byText.get('插话引导的补充')?.mode, 'steer')
      assert.equal(byText.get('排队的后续输入')?.mode, 'followUp')
      for (const q of queued) {
        assert.equal(typeof q.id === 'string' && q.id !== '', true, 'queued id 非空')
        assert.equal(typeof q.submissionId === 'string' && q.submissionId !== '', true, 'queued submissionId 非空')
        assert.equal(q.origin, 'human')
      }
      // 释放 gate：run 完成，后续 followUp 消费，队列最终清空。
      answer(fauxAssistantMessage('第一轮回答'))
      await submit1
      faux.appendResponses([fauxAssistantMessage('第二轮回答')])
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const tail = (kernel.events.currentSnapshot().conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return tail === undefined || (tail.queuedInputs?.length ?? 0) === 0
      }, 5_000)
    } finally {
      await kernel.close()
    }
  })

  it('忙碌中省略 whenBusy 默认 steer；显式 followUp 仍排队；reject 报 409 conversation_busy', { timeout: 60_000 }, async () => {
    const dir = join(root, 'default-steer')
    const models = createRuntimeModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    let entered!: () => void
    let answer!: (message: ReturnType<typeof fauxAssistantMessage>) => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { answer = resolve })
    faux.setResponses([async () => { entered(); return held }])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      watchdogIntervalMs: 0,
    })
    try {
      const conv = await kernel.createConversation({ title: '默认插话' })
      const submit1 = kernel.submitInput(conv.id, '第一轮问题')
      await started
      // run 在途（模型请求被 gate 挂起）：省略 whenBusy 提交——按有效默认 steer 入队，
      // 直接以 pi.inbox 事实断言（不依据最终回答猜）。
      await kernel.submitInput(conv.id, '省略 whenBusy 的补充')
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 1
      }, 5_000)
      const omitQueued = findLive(kernel, conv.id)!.queuedInputs!
      assert.equal(omitQueued.length, 1)
      assert.equal(omitQueued[0]!.mode, 'steer', '省略 whenBusy 应按默认 steer 入队')
      assert.equal(omitQueued[0]!.text, '省略 whenBusy 的补充')
      // 显式 followUp 仍排队（不因默认改变而失效）。
      await kernel.submitInput(conv.id, '显式排队的后续', { whenBusy: 'followUp' })
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const twoQueued = findLive(kernel, conv.id)!.queuedInputs!
      const byText = new Map(twoQueued.map((q) => [q.text, q]))
      assert.equal(byText.get('省略 whenBusy 的补充')?.mode, 'steer')
      assert.equal(byText.get('显式排队的后续')?.mode, 'followUp')
      // 显式 reject：正忙时拒绝（不静默入队）。
      await assert.rejects(
        () => kernel.submitInput(conv.id, '应被拒绝的输入', { whenBusy: 'reject' }),
        (err: unknown) => {
          const helmErr = err as { name?: string; code?: string; status?: number }
          return helmErr?.name === 'HelmError' && helmErr?.code === 'conversation_busy' && helmErr?.status === 409
        },
      )
      // 释放 gate：run 完成，队列消费后清空。
      answer(fauxAssistantMessage('第一轮回答'))
      faux.appendResponses([fauxAssistantMessage('后续回答')])
      await submit1
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 5_000)
      // helm.input entry 落库携带有效 whenBusy（省略路径固化为 steer）。
      const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
      const stored = detail.entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => (e.data ?? {}) as { text?: string; whenBusy?: string })
        .find((d) => d.text === '省略 whenBusy 的补充')
      assert.equal(stored?.whenBusy, 'steer', 'helm.input entry 应记录有效默认 steer')
    } finally {
      await kernel.close()
    }
  })

  it('空闲会话不复活 idle 空 live（快照不含无内容条目）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'snap2')
    const models = createRuntimeModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('仅一轮')])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      watchdogIntervalMs: 0,
    })
    try {
      const conv = await kernel.createConversation({ title: '空闲' })
      await kernel.submitInput(conv.id, '问题')
      await kernel.waitForIdle(conv.id)
      const snap = kernel.events.currentSnapshot()
      assert.equal(
        (snap.conversationLives ?? []).some((l) => l.conversationId === conv.id),
        false,
        '空闲会话不应出现在快照 conversationLives',
      )
    } finally {
      await kernel.close()
    }
  })
})
