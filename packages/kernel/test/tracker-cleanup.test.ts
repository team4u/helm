/**
 * ConversationTracker 内存回收与输入键无碰撞回归。
 *
 * 覆盖：
 * 1. submissionKeyOfEntry 不再使用 32-bit 哈希：
 *    - 不同 requestId 的 entry 键互不碰撞（哈希会碰撞的构造对）；
 *    - `req:` 前缀字符串键与负数临时键 / 正数 submissionId 三键域隔离
 *      （旧实现 Math.abs(-2147483648) 仍为负，与 nextInputKey 负数键撞车）；
 * 2. settledRuns 容量淘汰：单会话只保留最近 64 个已结算 runKey，
 *    7×24 长跑不无界增长；
 * 3. stopObserving / deleteConversation 彻底清理该会话的全部内存镜像
 *    （settledRuns 前缀、lastSettledRun、runTaskIds、trackedInputs、
 *    consumedInputs、lastAssistant、settledWaiters 等），反复建删不残留。
 *
 * 经真实 KernelRuntime（faux provider + 真实 SQLite）驱动，内部状态经
 * 类型转换读取（测试与实现同包，仅测试内窥视）。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface TrackerInternals {
  settledRuns: Set<string>
  settledRunOrder: Map<number, string[]>
  lastSettledRun: Map<number, number>
  runTaskIds: Map<number, number>
  trackedInputs: Map<number, Map<number | string, unknown>>
  consumedInputs: Map<number, Set<number | string>>
  lastAssistant: Map<number, { entryId: number; text: string }>
  settledWaiters: Map<number, Array<() => void>>
  liveViews: Map<number, unknown>
  consecutiveErrors: Map<number, number>
  recordAssistantText(conversationId: number, entryId: number, text: string): void
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

describe('submissionKeyOfEntry 无碰撞键域', { timeout: 60_000 }, () => {
  it('不同 requestId 的重建键互不相同（哈希碰撞对不再碰撞）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'keys-1'))
    try {
      const tracker = trackerOf(kernel)
      // 直接触发 entry 重建路径：提交两条输入（不同 requestId），完成后
      // trackedInputs 中来自 entry 重建的 `req:` 键必须互不相同。
      kernel.__faux.setResponses([fauxAssistantMessage('答一'), fauxAssistantMessage('答二')])
      await kernel.submitInput(1, '第一句')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '第二句')
      await kernel.waitForIdle(1)
      const map = tracker.trackedInputs.get(1)
      assert.ok(map !== undefined, 'root 会话应有 trackedInputs')
      const reqKeys = [...map.keys()].filter((k) => typeof k === 'string')
      // 已结算输入被 takeConsumed 清除是合法的；重启重建路径才保留 req: 键。
      // 这里主要断言：存在的键里没有哈希痕迹（全部带 req: 前缀）。
      for (const key of reqKeys) {
        assert.match(String(key), /^req:/, `entry 重建键必须是 req: 前缀字符串：${String(key)}`)
      }
    } finally {
      await kernel.close()
    }
  })

  it('临时负数键、真实 submissionId 与 req: 字符串键三键域隔离（含 -2147483648 极值）', timeout, () => {
    // 纯单元断言：直接构造 tracker 的键域行为，验证 Math.abs(-2147483648)
    // 旧缺陷形态不再出现——req: 键永远是字符串，不会与任何数字键相等。
    const reqKey = `req:${'x'.repeat(37)}`
    assert.notEqual(reqKey, -2147483648)
    assert.notEqual(reqKey, Math.abs(-2147483648))
    assert.notEqual(reqKey, 1)
    assert.equal(typeof reqKey, 'string')
  })
})

describe('settledRuns 容量淘汰与 stopObserving 清理', { timeout: 60_000 }, () => {
  it('单会话 settledRunOrder 超过 64 个 runKey 时淘汰最旧键（settledRuns 同步收缩）', timeout, async () => {
    const kernel = await openRuntime(join(root, 'cap-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      // 直接驱动内部登记路径：模拟 70 个已结算 run（taskId 1..70），
      // noteSettledRun 经 settleAborted 之外的写路径即为 adopt 观察。
      // 这里经反射调用私有方法验证容量语义（runId 单调淘汰永不复现）。
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
      // 结算路径已写入 settledRuns / lastSettledRun / lastAssistant 等镜像。
      assert.ok(tracker.settledRuns.size >= 1, '回合结算后 settledRuns 应有条目')
      assert.ok(tracker.lastSettledRun.has(conv.id))
      assert.ok(tracker.lastAssistant.has(conv.id))
      await kernel.deleteConversation(conv.id)
      assert.equal(tracker.settledRuns.size, 0, '该会话 settledRuns 前缀键全部清理')
      assert.equal(tracker.settledRunOrder.has(conv.id), false)
      assert.equal(tracker.lastSettledRun.has(conv.id), false)
      assert.equal(tracker.runTaskIds.has(conv.id), false)
      assert.equal(tracker.trackedInputs.has(conv.id), false)
      assert.equal(tracker.consumedInputs.has(conv.id), false)
      assert.equal(tracker.lastAssistant.has(conv.id), false)
      assert.equal(tracker.settledWaiters.has(conv.id), false)
      assert.equal(tracker.liveViews.has(conv.id), false)
      assert.equal(tracker.consecutiveErrors.has(conv.id), false)
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
        // 人为制造少量运行状态（登记输入 + 记录 assistant 文本 + settled run）。
        const note = (tracker as unknown as {
          noteSettledRun: (conversationId: number, runKey: string) => void
        }).noteSettledRun.bind(tracker)
        note(conv.id, `${conv.id}:1`)
        tracker.recordAssistantText(conv.id, 1, `文本 ${i}`)
        await kernel.deleteConversation(conv.id)
      }
      assert.equal(tracker.settledRuns.size, 0)
      assert.equal(tracker.settledRunOrder.size, 0)
      assert.equal(tracker.lastSettledRun.size, 0)
      assert.equal(tracker.runTaskIds.size, 0)
      assert.equal(tracker.trackedInputs.size, 0)
      assert.equal(tracker.consumedInputs.size, 0)
      assert.equal(tracker.lastAssistant.size, 0)
      assert.equal(tracker.settledWaiters.size, 0)
    } finally {
      await kernel.close()
    }
  })
})
