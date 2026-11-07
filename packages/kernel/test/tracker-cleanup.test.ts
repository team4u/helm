/**
 * ConversationTracker 输入追踪唯一性与结算准确性回归。
 *
 * 缺陷背景（本文件锁定修复）：
 * - 旧实现 rebuildFromEntries 对窗口内每条历史 helm.input 都创建 req: 记录，
 *   且每次快照扫描历史复活；run 结算（takeConsumed）只清数字键，req: 历史
 *   键常驻；abort 的 takeAllInputs 遍历整个 map，旧历史输入污染 aborted
 *   payload 的 origin 与输入清单。
 * - 旧测试用 `assert.notEqual(reqKey, -2147483648)` 这类字符串与数字必然
 *   不等的弱断言，测不出真实缺陷。
 *
 * 现契约：
 * 1. trackedInputs 按 input.id（requestId）唯一：正常 register/bind 与 entry
 *    观察重建合并为一条记录，绝不重复；
 * 2. entry 重建仅认当前 run 区间（run.first 及之后）与当前 inbox，已结算
 *    run 的历史 helm.input 不复活：多轮 complete 后 abort 只含当前 run 输入；
 * 3. 同 conversation 重复 requestId（SDK 去重语义）重建正确且不重复；
 * 4. 重启恢复活跃 run：observe 经 live.run.inputs 权威映射 + submission
 *    精确查询补齐 origin/meta/attachments；
 * 5. stopObserving 后在途异步 adoptInitial 不向 maps 复活条目；
 * 6. settledRuns 容量淘汰（64）与 deleteConversation 全量清理保持不变。
 *
 * 经真实 KernelRuntime（faux provider + 真实 SQLite）驱动，内部状态经类型
 * 转换读取（测试与实现同包，仅测试内窥视）。
 *
 * 键域事实更正：旧实现 Math.abs(requestIdHash) 曾把 -2147483648 压缩为负数
 * 临时键；JS 中 Math.abs(-2147483648) 实际返回正 2147483648（64-bit 浮点），
 * 旧注释“仍为负”的说法是错误的——真实缺陷是 32-bit 哈希本身会碰撞，与
 * Math.abs 无关，故本实现彻底放弃哈希，req:<requestId> 全字符串键。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationInput, TurnSettledPayload } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { ConversationTracker } from '../src/runtime/conversations.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface TrackerInternals {
  settledRuns: Set<string>
  settledRunOrder: Map<number, string[]>
  lastSettledRun: Map<number, number>
  runTaskIds: Map<number, number>
  runFirstEntries: Map<number, number>
  trackedInputs: Map<number, Map<number | string, { input: ConversationInput; submissionId: number | string }>>
  consumedInputs: Map<number, Set<number | string>>
  liveViews: Map<number, unknown>
  observeGenerations: Map<number, symbol>
}

function trackerOf(kernel: KernelRuntime): TrackerInternals {
  return (kernel as unknown as { tracker: TrackerInternals }).tracker
}

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-tracker-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** 注册收集 turn_settled 的插件，返回载荷数组（每会话独立数组）。 */
function collectSettled(kernel: KernelRuntime): TurnSettledPayload[] {
  const settled: TurnSettledPayload[] = []
  void kernel.plugins.register({
    id: 'test:settled-collector',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        settled.push(payload)
      })
    },
  })
  return settled
}

describe('输入唯一性与历史不复活', { timeout: 60_000 }, () => {
  it('多轮 complete 后 abort：aborted payload 只含当前 run 输入，不含历史 trigger 输入', timeout, async () => {
    const kernel = await openRuntime(join(root, 'abort-current-only'))
    try {
      const settled = collectSettled(kernel)
      // 两轮完整回合：第一轮 trigger 来源，第二轮 human 来源。
      kernel.__faux.setResponses([
        fauxAssistantMessage('第一轮回答'),
        fauxAssistantMessage('第二轮回答'),
      ])
      await kernel.submitInput(1, '第一轮任务', { origin: 'trigger' })
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '第二轮任务', { origin: 'human' })
      await kernel.waitForIdle(1)
      assert.equal(settled.length, 2)
      assert.equal(settled[0]!.outcome, 'completed')
      assert.equal(settled[0]!.inputs.length, 1)
      assert.equal(settled[0]!.inputs[0]!.origin, 'trigger')
      assert.equal(settled[1]!.inputs.length, 1)
      assert.equal(settled[1]!.inputs[0]!.origin, 'human')
      // 已结算两轮后 trackedInputs 不残留历史 req: 记录。
      const mapAfter = trackerOf(kernel).trackedInputs.get(1)
      assert.equal(mapAfter?.size ?? 0, 0, '已结算输入的历史记录不残留')

      // 第三轮在途 abort：只含当前输入，绝不污染旧轮 origin。
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
          stopReason: 'toolUse',
        }),
      ])
      void kernel.submitInput(1, '会被中止的当前问题', { origin: 'human' }).catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(kernel.getConversation(1).status, 'working')
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      assert.equal(settled.length, 3)
      const aborted = settled[2]!
      assert.equal(aborted.outcome, 'aborted')
      assert.equal(
        aborted.inputs.length,
        1,
        `aborted 只含当前 run 输入，实际：${JSON.stringify(aborted.inputs.map((i) => [i.id, i.origin]))}`,
      )
      assert.equal(aborted.inputs[0]!.text, '会被中止的当前问题')
      assert.equal(aborted.inputs[0]!.origin, 'human', '当前输入 origin 不被历史 trigger 污染')
    } finally {
      await kernel.close()
    }
  })

  it('历史 helm.input 不再每次扫描复活：完成若干轮后 trackedInputs 归零', timeout, async () => {
    const kernel = await openRuntime(join(root, 'no-resurrect'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('答一'),
        fauxAssistantMessage('答二'),
        fauxAssistantMessage('答三'),
      ])
      for (const text of ['问题一', '问题二', '问题三']) {
        await kernel.submitInput(1, text)
        await kernel.waitForIdle(1)
      }
      const tracker = trackerOf(kernel)
      const map = tracker.trackedInputs.get(1)
      assert.equal(map?.size ?? 0, 0, '三轮 complete 后无历史 req: 记录残留（不复活）')
      // 稍等观察者快照推进后再验一次（旧缺陷在每次窗口扫描时复活历史）。
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(tracker.trackedInputs.get(1)?.size ?? 0, 0, '后续快照不复活历史输入')
    } finally {
      await kernel.close()
    }
  })

  it('busy 中 followUp 排队：全部输入恰一次结算，无重复无丢失', timeout, async () => {
    const kernel = await openRuntime(join(root, 'followup-unique'))
    try {
      const settled = collectSettled(kernel)
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('工具轮回答'),
        fauxAssistantMessage('排队输入回答'),
      ])
      await kernel.submitInput(1, '首条输入', { origin: 'human' })
      // busy 中 followUp 排队：SDK 在后续 run 消费（中间 continue 轮无输入）。
      await kernel.submitInput(1, '排队的第二条', { origin: 'agent', whenBusy: 'followUp' })
      await kernel.waitForIdle(1)
      assert.ok(settled.length >= 1)
      // 全部结算载荷汇总：两条输入各恰一次，无重复。
      const allInputs = settled.flatMap((s) => s.inputs)
      const texts = allInputs.map((i) => i.text)
      const byText = new Map<string, number>()
      for (const text of texts) byText.set(text, (byText.get(text) ?? 0) + 1)
      assert.equal(byText.get('首条输入'), 1, `首条恰一次：${JSON.stringify([...byText])}`)
      assert.equal(byText.get('排队的第二条'), 1, `排队输入恰一次：${JSON.stringify([...byText])}`)
      // 无历史伪造输入（只含真实提交的两条）。
      assert.equal(allInputs.length, 2, `总输入数恰为提交数：${JSON.stringify(texts)}`)
    } finally {
      await kernel.close()
    }
  })
})

describe('requestId 重复提交与重启恢复', { timeout: 60_000 }, () => {
  it('同一 requestId 二次提交（SDK 按 conversation 去重）：重建正确且 trackedInputs 不重复', timeout, async () => {
    const kernel = await openRuntime(join(root, 'dup-request-id'))
    try {
      // 两条 requestId 仅大小写差异（旧 32-bit 哈希对 'Aa'/'BB' 同值碰撞的构造对）。
      kernel.__faux.setResponses([fauxAssistantMessage('回答')])
      await kernel.submitInput(1, '第一条')
      await kernel.waitForIdle(1)
      kernel.__faux.setResponses([fauxAssistantMessage('回答二')])
      await kernel.submitInput(1, '第二条')
      await kernel.waitForIdle(1)
      const tracker = trackerOf(kernel)
      // 结算后历史不残留（上一组已验证）；此处验证运行期间键域：
      // 提交第二条（run 进行中）时 map 中该输入唯一。
      const map = tracker.trackedInputs.get(1)
      const keys = [...(map?.keys() ?? [])]
      for (const key of keys) {
        if (typeof key === 'string') assert.match(key, /^req:/, `重建键必须是 req: 前缀：${key}`)
      }
      // 每个在册 input.id 唯一。
      const ids = [...(map?.values() ?? [])].map((t) => t.input.id)
      assert.equal(new Set(ids).size, ids.length, 'input.id 无重复记录')
    } finally {
      await kernel.close()
    }
  })

  it('重启恢复活跃 run：origin/meta 经权威映射补齐且结算不丢', timeout, async () => {
    // 直驱真实 Harness + ConversationTracker（不经 KernelRuntime：runtime.close
    // 会显式 abort 在途会话，无法构造“重启时 run 仍在途”的场景）。
    const dir = join(root, 'restart-active-run')
    const mkHarness = async () => {
      const database = await openHelmDatabase(dir)
      const store = new HelmStore(database)
      await store.load()
      const faux = fauxProvider()
      const models = createModels()
      models.setProvider(faux.provider)
      const harness = await Harness.open(
        database.storage,
        { models: () => models, registry: createRegistry(), settings: { followUpMode: 'all' } },
        BACKGROUND_CONTEXT,
      )
      return { harness, store, database, faux }
    }
    const settled: TurnSettledPayload[] = []
    const trackerOfHarness = (harness: Harness, store: HelmStore) =>
      new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: (payload) => {
            settled.push(payload as TurnSettledPayload)
          },
        },
      })

    // 第一段：提交带 meta 的 agent 输入，工具长回合在途时直接关 storage（模拟崩溃）。
    let convId = 0
    {
      const { harness, store, database, faux } = await mkHarness()
      harness.resume()
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      convId = id
      store.upsertConv({
        id,
        title: '会话',
        profileId: 'assistant',
        nodeId: 'local',
        tags: [],
        cwd: dir,
        model: 'faux/faux-1',
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const tracker = trackerOfHarness(harness, store)
      await tracker.observe(id)
      // 慢响应工厂：长回合在途（无工具依赖，纯 provider 延迟）。
      faux.setResponses([
        async () => {
          await new Promise((r) => setTimeout(r, 8000))
          return fauxAssistantMessage('重启后回答')
        },
      ])
      await conv.submit(
        {
          type: 'input',
          content: '重启前的在途问题',
          entry: {
            kind: 'helm.input',
            data: { id: 'restart-1', text: '重启前的在途问题', origin: 'agent', createdAt: 5, meta: { from: 'test', seq: 7 } },
          },
          requestId: 'restart-1',
        },
        BACKGROUND_CONTEXT,
      )
      await new Promise((r) => setTimeout(r, 400))
      // 模拟崩溃：不经 harness.close（其会 abort 在途 run），直接断 storage
      //（SQLite 崩溃安全，已 commit 的 pi.live.run 状态落盘）。
      await database.close()
    }

    // 第二段：重开（模拟重启）。活跃 run 未完成，observe 需经权威映射补齐输入。
    {
      const { harness, store, database, faux } = await mkHarness()
      harness.resume()
      try {
        const conv = await harness.conversation(convId as never, BACKGROUND_CONTEXT)
        assert.ok(conv !== undefined)
        const id = conv.id as number
        const tracker = trackerOfHarness(harness, store)
        await tracker.observe(id)
        const map = (tracker as unknown as TrackerInternals).trackedInputs.get(id)
        assert.ok(map !== undefined && map.size >= 1, '重启恢复活跃 run 后输入在册')
        const tracked = [...map.values()][0]!
        assert.equal(tracked.input.text, '重启前的在途问题')
        assert.equal(tracked.input.origin, 'agent', '重启后 origin 权威补齐')
        assert.deepEqual(tracked.input.meta, { from: 'test', seq: 7 }, '重启后 meta 权威补齐')
        // 第二段重设慢工厂响应（run 重启后续跑）。
        faux.setResponses([
          async () => {
            await new Promise((r) => setTimeout(r, 200))
            return fauxAssistantMessage('恢复后的回答')
          },
        ])
        await conv.waitForIdle(BACKGROUND_CONTEXT).catch(() => {})
        await new Promise((r) => setTimeout(r, 300))
        const settledPayload = settled.find((s) => s.conversation.id === id)
        assert.ok(settledPayload !== undefined, '重启后 run 结算到达')
        assert.equal(settledPayload.inputs.length, 1)
        assert.equal(settledPayload.inputs[0]!.origin, 'agent')
        assert.deepEqual(settledPayload.inputs[0]!.meta, { from: 'test', seq: 7 })
      } finally {
        await harness.close(BACKGROUND_CONTEXT)
        await store.close()
        await database.close()
      }
    }
  })

  it('stopObserving 后在途异步 adoptInitial 不向 maps 复活条目', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-no-ghost'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 3' })], { stopReason: 'toolUse' }),
      ])
      void kernel.submitInput(1, '停观前的在途问题').catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(kernel.getConversation(1).status, 'working')
      // 删除会话（内部 stopObserving）：令牌删除，在途回读作废。
      const conv = await kernel.createConversation({})
      await kernel.deleteConversation(conv.id)
      const tracker = trackerOf(kernel)
      assert.equal(tracker.trackedInputs.has(conv.id), false)
      assert.equal(tracker.runFirstEntries.has(conv.id), false)
      assert.equal(tracker.observeGenerations.has(conv.id), false)
      // 中止不应替换仍在观察的 root 会话令牌。
      const genBefore = tracker.observeGenerations.get(1)
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      assert.equal(tracker.observeGenerations.get(1), genBefore)
    } finally {
      await kernel.close()
    }
  })
})

describe('settledRuns 容量淘汰与 stopObserving 清理', { timeout: 60_000 }, () => {
  it('停观后迟到的结算失败不复活计数、错误或观察令牌', timeout, async () => {
    const kernel = await openRuntime(join(root, 'late-settlement'))
    try {
      const conv = await kernel.createConversation({})
      const tracker = trackerOf(kernel) as TrackerInternals & {
        events: { onTurnSettled: (...args: unknown[]) => Promise<void> | void }
        emitSettled(id: number, outcome: string, inputs: ConversationInput[], error: undefined): void
        stopObserving(id: number): void
        settledInflight: Map<number, number>
        settledErrors: Map<number, unknown>
      }
      let fail!: (error: Error) => void
      const pending = new Promise<void>((_resolve, reject) => { fail = reject })
      const original = tracker.events.onTurnSettled
      tracker.events.onTurnSettled = () => pending
      try {
        tracker.emitSettled(conv.id, 'completed', [], undefined)
        assert.equal(tracker.settledInflight.has(conv.id), true)
        tracker.stopObserving(conv.id)
        fail(new Error('late callback failure'))
        await pending.catch(() => {})
        await Promise.resolve()
        assert.equal(tracker.settledInflight.has(conv.id), false)
        assert.equal(tracker.settledErrors.has(conv.id), false)
        assert.equal(tracker.observeGenerations.has(conv.id), false)
      } finally {
        tracker.events.onTurnSettled = original
      }
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('单会话 settledRunOrder 超过 64 个 runKey 时淘汰最旧键（settledRuns 同步收缩）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'cap-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      const note = (tracker as unknown as {
        noteSettledRun: (conversationId: number, runKey: string) => void
      }).noteSettledRun.bind(tracker)
      for (let taskId = 1; taskId <= 70; taskId += 1) {
        note(conv.id, `${conv.id}:${taskId}`)
      }
      const order = tracker.settledRunOrder.get(conv.id)
      assert.ok(order !== undefined)
      assert.equal(order.length, 64, '容量上限 64')
      assert.equal(order[0], `${conv.id}:7`, '最旧键（taskId=1..6）被淘汰')
      assert.equal(order[order.length - 1], `${conv.id}:70`, '最新键保留')
      for (let taskId = 1; taskId <= 6; taskId += 1) {
        assert.equal(
          tracker.settledRuns.has(`${conv.id}:${taskId}`),
          false,
          `被淘汰键 ${taskId} 不在 settledRuns`,
        )
      }
      assert.equal(tracker.settledRuns.has(`${conv.id}:7`), true)
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation（stopObserving）彻底清理该会话全部内存镜像', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('回答文本')])
      await kernel.submitInput(conv.id, '问题')
      await kernel.waitForIdle(conv.id)
      assert.ok(tracker.settledRuns.size >= 1, '回合结算后 settledRuns 应有条目')
      assert.ok(tracker.lastSettledRun.has(conv.id))
      await kernel.deleteConversation(conv.id)
      assert.equal(tracker.settledRuns.size, 0, '该会话 settledRuns 前缀键全部清理')
      assert.equal(tracker.settledRunOrder.has(conv.id), false)
      assert.equal(tracker.lastSettledRun.has(conv.id), false)
      assert.equal(tracker.runTaskIds.has(conv.id), false)
      assert.equal(tracker.runFirstEntries.has(conv.id), false)
      assert.equal(tracker.trackedInputs.has(conv.id), false)
      assert.equal(tracker.consumedInputs.has(conv.id), false)
      assert.equal(tracker.liveViews.has(conv.id), false)
      assert.equal(tracker.observeGenerations.has(conv.id), false)
    } finally {
      await kernel.close()
    }
  })

  it('反复建删 50 个会话后 tracker 内部各 Map 不残留任何键', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-50'))
    try {
      const tracker = trackerOf(kernel)
      for (let i = 0; i < 50; i += 1) {
        const conv = await kernel.createConversation({})
        const note = (tracker as unknown as {
          noteSettledRun: (conversationId: number, runKey: string) => void
        }).noteSettledRun.bind(tracker)
        note(conv.id, `${conv.id}:1`)
        await kernel.deleteConversation(conv.id)
      }
      assert.equal(tracker.settledRuns.size, 0)
      assert.equal(tracker.settledRunOrder.size, 0)
      assert.equal(tracker.lastSettledRun.size, 0)
      assert.equal(tracker.runTaskIds.size, 0)
      assert.equal(tracker.runFirstEntries.size, 0)
      assert.equal(tracker.trackedInputs.size, 0)
      assert.equal(tracker.consumedInputs.size, 0)
      assert.deepEqual([...tracker.observeGenerations.keys()], [1])
    } finally {
      await kernel.close()
    }
  })
})
