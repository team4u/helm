/**
 * builtin:token-speed 插件行为测试：
 *
 * 1. 纯算法层（tracker.ts，注入时间）：滑动窗口（正常 / 最小跨度 / burst-stall
 *    延伸 / 跨段不延伸 / 窗口滑空）、累计快照差分与重复帧、attempt / 内容回退
 *    段重置（重试不重复累计）、TTFT 与 decode 分离、工具阶段解码暂停（段间
 *    不拼接间隙）、provider usage 增量优先 + 最终 entry 对账（FIFO、entry 先于
 *    live 帧）、中途接入基线（不制造首帧尖峰、TTFT 省略）、settle/resetChain、
 *    source 口径（provider / estimate / mixed）；
 * 2. 插件装配层（真 PluginHost + 事件替身）：conversation.live / entry /
 *    deleted 事件驱动 sessionDoc 发布（节流、阶段变化立即写、终态写）、
 *    turn_settled working（链延续）与终态（链结算 + 下一 generation 帧重置）、
 *    UI 插槽注册到 COMPOSER_STATUS_SLOT、停用后监听与文档写入停止。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { ConversationSummary, PluginDefinition } from '@helm/protocol'
import { COMPOSER_STATUS_SLOT, HelmError } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createTokenSpeedPlugin } from '../src/token-speed.js'
import {
  DOC_WRITE_INTERVAL_MS,
  TOKEN_SPEED_DOC,
  TOKEN_SPEED_PLUGIN_ID,
  asConversationLiveFrame,
  type TokenSpeedStatus,
} from '../src/token-speed/contracts.js'
import {
  ConversationTokenSpeedTracker,
  SlidingWindow,
  estimateTokensOf,
  generatedCharsOf,
  type CompletionFact,
} from '../src/token-speed/tracker.js'
// 展示模型是零依赖纯模块（客户端资产目录内的 .ts，tsx 直接可测）。
import { tokenSpeedLabelOf } from '../src/token-speed/client/label.js'

// ---------------------------------------------------------------------------
// 1. 纯算法层
// ---------------------------------------------------------------------------

const WINDOW = 1000
const MIN_SPAN = 100

function trackerOf(): ConversationTokenSpeedTracker {
  return new ConversationTokenSpeedTracker({ windowMs: WINDOW, minSpanMs: MIN_SPAN })
}

type Frame = { generation?: { taskId: number; attempt: number; message?: never }; hasTools?: boolean }

/** 完成事实速记：成功 / 失败（entryId 保证不重复消费）。 */
let entrySeq = 0
function success(taskId: number, usageOutput?: number): CompletionFact {
  entrySeq += 1
  return { taskId, entryId: `e${entrySeq}`, usageOutput, stopReason: undefined }
}
function failure(taskId: number, stopReason: 'aborted' | 'error'): CompletionFact {
  entrySeq += 1
  return { taskId, entryId: `e${entrySeq}`, usageOutput: undefined, stopReason }
}

test('SlidingWindow：spread 事件按实际跨度；最小跨度 100ms 防单点尖峰', { timeout: 60_000 }, () => {
  const window = new SlidingWindow(WINDOW, MIN_SPAN)
  // 500 tokens 均匀 spread 在 500ms：tps = 500 / 0.5s = 1000。
  for (let i = 0; i < 5; i += 1) window.record(i * 100, 100, 1)
  assert.ok(Math.abs(window.getTps(500) - 1000) < 1e-6)
  // 单点事件（now 与事件同刻）：跨度钳到 100ms → tps = 100 tokens / 0.1s = 1000。
  const single = new SlidingWindow(WINDOW, MIN_SPAN)
  single.record(1000, 100, 1)
  assert.ok(Math.abs(single.getTps(1000) - 1000) < 1e-6, '单点不产生 tokens/0ms 极端速率')
  // 窗口滑空：事件全部老于窗口 → 0。
  assert.equal(window.getTps(2000), 0)
})

test('SlidingWindow：burst/stall——同段同刻冲刷向前延伸跨度；跨段绝不延伸', { timeout: 60_000 }, () => {
  // 窗口 1000ms：20 tokens @0ms → 4s 停滞 → 500 tokens 同刻冲刷。冲刷时窗口内
  // 只剩冲刷簇（同段同刻），跨度延伸到前驱事件：520 tok / 4s = 130 tok/s
  // （不延伸则 500/0.1s = 5000 tok/s 尖峰；停滞期计入有效吞吐，README 语义）。
  const window = new SlidingWindow(WINDOW, MIN_SPAN)
  window.record(0, 20, 1)
  window.record(4_000, 500, 1)
  // 跨出窗口的 20 tokens 不计入分子（窗口内 tokens 只计窗口内事件）。
  assert.ok(Math.abs(window.getTps(4_000) - 125) < 1e-6, '停滞期计入有效吞吐（README 语义）')
  // 跨段（工具轮间隙后新段冲刷）：不延伸到前段（间隙不含工具时间）。
  const cross = new SlidingWindow(WINDOW, MIN_SPAN)
  cross.record(0, 20, 1)
  cross.record(4_000, 500, 2)
  assert.ok(Math.abs(cross.getTps(4_000) - 5000) < 1e-6, '跨段冲刷只用最小跨度，不把间隙拉进分母')
})

test('SlidingWindow：压缩不改变结果；reset 清空', { timeout: 60_000 }, () => {
  const window = new SlidingWindow(WINDOW, MIN_SPAN)
  for (let i = 0; i < 6000; i += 1) window.record(i, 1, 1)
  assert.ok(window.getTps(6000) > 0)
  window.reset()
  assert.equal(window.getTps(6000), 0)
})

test('generatedCharsOf / estimateTokensOf：text+thinking+toolCall 全计；chars/4 向上取整', { timeout: 60_000 }, () => {
  const chars = generatedCharsOf({
    content: [
      { type: 'text', text: 'a'.repeat(100) },
      { type: 'thinking', thinking: 'b'.repeat(40) },
      { type: 'toolCall', name: 'bash', arguments: { command: 'c'.repeat(60) } },
    ],
  })
  assert.equal(chars, 100 + 40 + 'bash'.length + JSON.stringify({ command: 'c'.repeat(60) }).length)
  assert.equal(estimateTokensOf(0), 0)
  assert.equal(estimateTokensOf(1), 1)
  assert.equal(estimateTokensOf(400), 100)
  assert.equal(estimateTokensOf(401), 101)
})

function message(content: never[], usageOutput?: number): never {
  return { content, ...(usageOutput !== undefined ? { usage: { output: usageOutput } } : {}) } as never
}
const text = (t: string): never => ({ type: 'text', text: t }) as never

test('状态机：累计快照差分；重复帧 / 内容不变不重复计数', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(40))]) } })
  // 重复帧（同快照）：无增量。
  tracker.observeFrame(200, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(40))]) } })
  tracker.observeFrame(300, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(80))]) } })
  const status = tracker.liveStatus(300)!
  assert.equal(status.phase, 'decoding')
  assert.equal(status.outputTokens, 20, '40+40 字符 / 4')
  assert.equal(status.decodeMs, 200, '首增长 100ms -> 末增长 300ms')
  assert.equal(status.ttftMs, 100, '空 generation 100ms 后首内容')
  assert.equal(status.source, 'estimate')
  assert.ok(Math.abs((status.tps ?? 0) - (20 / 200) * 1000) < 1e-6, '窗口速率 20 tok / 0.2s')
})

test('状态机：身份变化构成段重置（重试 / 新任务不重复累计）；同身份回退只钳不重置', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(50, { generation: { taskId: 1, attempt: 1, message: message([text('x'.repeat(400))]) } })
  // 同任务重试（attempt 递增）：message 清空 -> 新段，重放的 x 不重复计。
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 2 } })
  tracker.observeFrame(200, { generation: { taskId: 1, attempt: 2, message: message([text('y'.repeat(40))]) } })
  let status = tracker.liveStatus(200)!
  assert.equal(status.outputTokens, 100 + 10, '旧段估算 100 + 重试段 10')
  // 跨任务（工具轮 handOver，attempt 重置 1）：身份变化 -> 新段。
  tracker.observeFrame(300, { generation: { taskId: 2, attempt: 1 } })
  tracker.observeFrame(400, { generation: { taskId: 2, attempt: 1, message: message([text('z'.repeat(80))]) } })
  status = tracker.liveStatus(400)!
  assert.equal(status.outputTokens, 100 + 10 + 20, '跨任务段重置，各段分别累计')
  // 同身份小幅回退（provider *_end 重发整块文本）：不重置，钳位后续继续差分。
  tracker.observeFrame(500, { generation: { taskId: 2, attempt: 1, message: message([text('z'.repeat(70))]) } })
  tracker.observeFrame(600, { generation: { taskId: 2, attempt: 1, message: message([text('z'.repeat(160))]) } })
  status = tracker.liveStatus(600)!
  assert.equal(status.outputTokens, 100 + 10 + 20 + 20, '回退帧 0 增量，随后 160-80 字符继续同段差分')
})

test('状态机：工具阶段暂停解码时钟——段间间隙绝不计入 decodeMs', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 段一：0-400ms 生成 40 tokens。
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) } })
  tracker.observeFrame(400, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))]) } })
  // 工具阶段：generation 缺席（5s 工具执行）。
  tracker.observeFrame(500, { hasTools: true })
  tracker.observeFrame(5_000, { hasTools: true })
  let status = tracker.liveStatus(5_000)!
  assert.equal(status.phase, 'tools')
  assert.equal(status.decodeMs, 300, '只有段一的 100->400ms')
  assert.equal(status.tps, undefined, '工具阶段不给速率（不以 0 冒充）')
  // 段二（工具轮 handOver：新任务 taskId，attempt 重置 1、内容从零）。
  tracker.observeFrame(5_100, { generation: { taskId: 2, attempt: 1 } })
  tracker.observeFrame(5_200, { generation: { taskId: 2, attempt: 1, message: message([text('b'.repeat(400))]) } })
  tracker.observeFrame(5_500, { generation: { taskId: 2, attempt: 1, message: message([text('b'.repeat(800))]) } })
  status = tracker.liveStatus(5_500)!
  assert.equal(status.decodeMs, 300 + 300, '两段解码拼接，5s 工具时间被剔除')
  assert.equal(status.outputTokens, 400, '两段各 200 tokens')
})

test('状态机：provider usage 增量优先；无上报退回估算（mixed 口径如实标注）', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))], 50) } })
  let status = tracker.liveStatus(100)!
  assert.equal(status.outputTokens, 50)
  assert.equal(status.source, 'provider')
  // usage 停滞（OpenAI 兼容网关只在终值上报）：本帧退回估算。
  tracker.observeFrame(200, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))], 50) } })
  status = tracker.liveStatus(200)!
  assert.equal(status.outputTokens, 150, '50 provider + 100 字符估算')
  assert.equal(status.source, 'mixed')
})

test('状态机：最终 usage 对账覆盖估算（entry 先于同提交 live 帧，按 taskId 关联）', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) } })
  // 折叠提交：assistant entry（权威 usage 120）先到，段随后关闭。
  tracker.noteCompletion(success(1, 120))
  tracker.observeFrame(200, {})
  // 对账后：估算 100 被权威 120 覆盖；source 回到 provider。
  const status = tracker.liveStatus(200)!
  assert.equal(status.outputTokens, 120)
  assert.equal(status.source, 'provider')
  // 重复 entry（同 entryId）与未知 taskId 的 usage 不重复消费（防御）。
  tracker.noteCompletion(success(1, 999))
  tracker.noteCompletion(success(99, 999))
  assert.equal(tracker.liveStatus(200)!.outputTokens, 120)
})

test('状态机：中途接入（首帧即带内容）只建基线——无首帧尖峰、无 TTFT', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1, message: message([text('历史内容'.repeat(200))], 10_000) } })
  let status = tracker.liveStatus(0)
  assert.equal(status, undefined, '首帧历史内容不产生测量')
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('历史内容'.repeat(200) + '新增'), ], 10_040) } })
  status = tracker.liveStatus(100)!
  assert.equal(status.outputTokens, 40, '只计接入后的增量（provider 增量 40）')
  assert.equal(status.ttftMs, undefined, '拿不到可靠起点，不伪造 TTFT')
})

test('状态机：中途接入被整条 usage 对账——计数入总量但不进终态速率（不伪造分母）', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 7, attempt: 1, message: message([text('历史'.repeat(2000))], 5_000) } })
  tracker.observeFrame(100, { generation: { taskId: 7, attempt: 1, message: message([text('历史'.repeat(2000) + '尾部'), ], 5_020) } })
  tracker.noteCompletion(success(7, 5_000))
  const settled = tracker.settle(200)!
  assert.equal(settled.outputTokens, 5_000, '权威整条总量计入')
  assert.equal(settled.tps, undefined, 'suffix 时间 × 整条计数不可配对，不产终态速率')
})

test('状态机：settle 产出终态（对账速率）；resetChain 彻底清零', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))], 100) } })
  tracker.observeFrame(500, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(2000))], 500) } })
  tracker.noteCompletion(success(1, 500))
  const settled = tracker.settle(600)!
  assert.equal(settled.phase, 'settled')
  assert.equal(settled.outputTokens, 500)
  assert.equal(settled.decodeMs, 400)
  assert.ok(Math.abs(settled.tps! - 1250) < 1e-6, '500 tok / 0.4s')
  tracker.resetChain()
  assert.equal(tracker.liveStatus(600), undefined)
  assert.equal(tracker.settle(600), undefined)
})

test('展示模型：实时/终态口径区分与诚实标注；无可靠速率返回 null（不以 0.0 冒充）', { timeout: 60_000 }, () => {
  const base = { outputTokens: 500, decodeMs: 4_000, source: 'mixed', windowMs: 1000 }
  // 无速率（工具暂停 / 窗口滑空 / 首字前）：不渲染。
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'tools' }), null)
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 0 }), null)
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'settled', tps: Number.NaN }), null)
  // 实时：滑动窗口口径 + 口径标注 + TTFT 首次观测声明。
  const live = tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 52.35, ttftMs: 640 })!
  assert.equal(live.text, '52.4 tok/s')
  assert.match(live.title, /实时解码 52\.4 tok\/s/)
  assert.match(live.title, /1\.0s 滑动窗口/)
  assert.match(live.title, /供应商 usage \+ 字符估算混合/)
  assert.match(live.title, /不含首字延迟与工具执行/)
  assert.match(live.title, /首字延迟 640ms（起点为插件首次观测，非请求精确起点）/) 
  // 终态：对账口径（不再提滑动窗口）。
  const settled = tokenSpeedLabelOf({ ...base, phase: 'settled', tps: 125 })!
  assert.equal(settled.text, '125.0 tok/s')
  assert.match(settled.title, /最近回合解码 125\.0 tok\/s（对账/)
  assert.doesNotMatch(settled.title, /滑动窗口/)
  // 无 TTFT（中途接入）：tooltip 不编造首字延迟测量值。
  assert.doesNotMatch(tokenSpeedLabelOf({ ...base, phase: 'settled', tps: 10 })!.title, /首字延迟 \\d+ms/)
})

test('事件守卫：非法载荷丢弃（asConversationLiveFrame），合法最小帧通过', { timeout: 60_000 }, () => {
  assert.equal(asConversationLiveFrame({ type: 'conversation.live', live: null }), undefined)
  assert.equal(asConversationLiveFrame({ type: 'other' }), undefined)
  assert.equal(
    asConversationLiveFrame({ type: 'conversation.live', live: { conversationId: 1, text: '', tools: [], updatedAt: 1, generation: { taskId: 1, attempt: 0 } } }),
    undefined,
    'attempt 非正整数拒绝',
  )
  assert.equal(
    asConversationLiveFrame({ type: 'conversation.live', live: { conversationId: 1, text: '', tools: [], updatedAt: 1, generation: { attempt: 1 } } }),
    undefined,
    'generation 缺 taskId（身份不明）拒绝',
  )
  assert.equal(
    asConversationLiveFrame({ type: 'conversation.live', live: { conversationId: 1, text: '', tools: [], updatedAt: 1, generation: { taskId: 1, attempt: 1, message: { content: 'bad' } } } }),
    undefined,
    'message 形状非法拒绝',
  )
  const frame = asConversationLiveFrame({
    type: 'conversation.live',
    live: { conversationId: 2, text: '', tools: [], updatedAt: 42, generation: { taskId: 9, attempt: 3 } },
  })
  assert.deepEqual(frame, { conversationId: 2, generation: { taskId: 9, attempt: 3 }, hasTools: false, updatedAt: 42 })
})

// ---------------------------------------------------------------------------
// 2. 插件装配层（真 PluginHost + 事件替身）
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : structuredClone(initial)
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

class MemorySessionDocStore {
  store = new Map<string, string>()
  writes: string[] = []
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
    this.writes.push(`${pluginId}:${name}:${conversationId}`)
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    this.store.delete(`${pluginId}\0${name}\0${conversationId}`)
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`
    for (const key of [...this.store.keys()]) if (key.startsWith(prefix)) this.store.delete(key)
  }
  listConversationIds(): number[] {
    return []
  }
  async flush(): Promise<void> {}
}

/** 事件替身后端：捕获 ctx.host.onEvent 监听器；getConversation 按删除集模拟存在性。 */
class EventBackend {
  readonly listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  readonly deletedConversations = new Set<number>()
  readonly base: PluginHostBackend
  constructor() {
    const listeners = this.listeners
    const deleted = this.deletedConversations
    this.base = {
      ...createPluginHostBackendFixture(),
      onEvent(type: string, listener: (payload: unknown) => unknown): () => void {
        let set = listeners.get(type)
        if (set === undefined) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(listener)
        return () => set!.delete(listener)
      },
      emitEvent(): void {
        // plugin.changed / 会话文档事件广播与测试无关：空实现（不进任何事件流）。
      },
      getConversation(id: number): ConversationSummary {
        if (deleted.has(id)) throw new HelmError('not_found', `会话不存在：${id}`, 404)
        return conversationOf(id, 'working')
      },
    }
    void deleted
  }
  async dispatch(type: string, payload: unknown): Promise<void> {
    for (const listener of [...(this.listeners.get(type) ?? [])]) await listener(payload)
  }
}

function conversationOf(id: number, status: ConversationSummary['status']): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function liveEvent(conversationId: number, updatedAt: number, generation?: { taskId: number; attempt: number; message?: never }, tools: unknown[] = []): unknown {
  return {
    type: 'conversation.live',
    live: {
      conversationId,
      text: '',
      thinking: undefined,
      tools,
      ...(generation !== undefined
        ? {
            generation: {
              taskId: generation.taskId,
              attempt: generation.attempt,
              ...(generation.message !== undefined
                ? { message: JSON.parse(JSON.stringify(generation.message)) }
                : {}),
            },
          }
        : {}),
      updatedAt,
    },
  }
}

function entryEvent(conversationId: number, taskId: number, output: number, options?: { stopReason?: string; entryId?: string }): unknown {
  return {
    type: 'conversation.entry',
    conversationId,
    entry: {
      id: options?.entryId ?? `entry-${conversationId}-${taskId}`,
      kind: 'pi.assistant',
      ...(taskId !== undefined ? { taskId } : {}),
      model: [{ role: 'assistant', usage: { output }, ...(options?.stopReason !== undefined ? { stopReason: options.stopReason } : {}) }],
    },
  }
}

interface Harness {
  host: PluginHost
  backend: EventBackend
  sessionDocs: MemorySessionDocStore
  docOf: (conversationId: number) => TokenSpeedStatus | null
  writesOf: (conversationId: number) => number
  close: () => Promise<void>
}

async function openPlugin(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-token-speed-'))
  const backend = new EventBackend()
  const docs = new MemoryDocStore()
  const sessionDocs = new MemorySessionDocStore()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend.base,
    docs,
    sessionDocs: sessionDocs as never,
  })
  await host.register(createTokenSpeedPlugin(), { enabled: true })
  return {
    host,
    backend,
    sessionDocs,
    docOf: (conversationId) => {
      const raw = sessionDocs.get(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, conversationId)
      return raw === undefined ? null : (JSON.parse(raw) as TokenSpeedStatus)
    },
    writesOf: (conversationId) =>
      sessionDocs.writes.filter((key) => key === `${TOKEN_SPEED_PLUGIN_ID}:${TOKEN_SPEED_DOC}:${conversationId}`).length,
    close: async () => {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('插件装配：流式帧驱动 sessionDoc（首测立即写 + 节流 + 阶段变化立即写）', { timeout: 60_000 }, async () => {
  const { backend, docOf, writesOf, close } = await openPlugin()
  try {
    const CONV = 1
    // 空 generation 帧：尚无测量，不写文档。
    await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
    assert.equal(docOf(CONV), null)
    // 首测：立即写。
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    const first = docOf(CONV)!
    assert.equal(first.phase, 'decoding')
    assert.equal(first.outputTokens, 100)
    assert.ok(first.tps! > 0)
    assert.equal(first.windowMs, 1000)
    const writesAfterFirst = writesOf(CONV)
    // 同阶段密集帧：250ms 节流内不重复写。
    await backend.dispatch('conversation.live', liveEvent(CONV, 120, { taskId: 1, attempt: 1, message: message([text('a'.repeat(440))]) }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 140, { taskId: 1, attempt: 1, message: message([text('a'.repeat(480))]) }))
    assert.equal(writesOf(CONV), writesAfterFirst, '同阶段节流窗口内不写')
    // 阶段变化（工具）：立即写。
    await backend.dispatch('conversation.live', liveEvent(CONV, 160, undefined, [{ callId: 'c1', toolName: 'bash', status: 'running' }]))
    const tools = docOf(CONV)!
    assert.equal(tools.phase, 'tools')
    assert.equal(tools.tps, undefined, '工具阶段无速率')
    assert.equal(writesOf(CONV), writesAfterFirst + 1)
  } finally {
    await close()
  }
})

test('插件装配：终态对账——entry usage 到达 + turn_settled 结算写 settled', { timeout: 60_000 }, async () => {
  const { backend, host, docOf, close } = await openPlugin()
  try {
    const CONV = 2
    await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 500, { taskId: 1, attempt: 1, message: message([text('a'.repeat(2000))]) }))
    // 工具轮中间结算（conversation.status 仍 working）：链延续，不写终态。
    await host.runHook('turn_settled', {
      conversation: conversationOf(CONV, 'working'),
      inputs: [],
      outcome: 'completed',
      settledAt: 600,
    })
    assert.equal(docOf(CONV)?.phase ?? 'decoding', 'decoding', 'working 中间结算不产生终态')
    // 最终权威 usage + 终态结算。
    await backend.dispatch('conversation.entry', entryEvent(CONV, 1, 600))
    await host.runHook('turn_settled', {
      conversation: conversationOf(CONV, 'done'),
      inputs: [],
      outcome: 'completed',
      settledAt: 700,
    })
    const settled = docOf(CONV)!
    assert.equal(settled.phase, 'settled')
    assert.equal(settled.outputTokens, 600, '估算被最终 usage 对账覆盖')
    assert.equal(settled.source, 'provider')
    assert.ok(Math.abs(settled.tps! - (600 / 400) * 1000) < 1e-6, '600 tok / 0.4s 解码净耗时')
    // 下一回合首帧：链重置（累计从零，终态值保留到新首测覆盖）。
    await backend.dispatch('conversation.live', liveEvent(CONV, 800, { taskId: 2, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 900, { taskId: 2, attempt: 1, message: message([text('b'.repeat(40))]) }))
    const next = docOf(CONV)!
    assert.equal(next.phase, 'decoding')
    assert.equal(next.outputTokens, 10, '新回合计数从零开始')
  } finally {
    await close()
  }
})

test('插件装配：会话删除彻底清理（内存态清理；会话行已删时文档删除按 not_found 容忍）', { timeout: 60_000 }, async () => {
  const { backend, sessionDocs, close } = await openPlugin()
  try {
    const CONV = 3
    await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    assert.ok(sessionDocs.get('builtin:token-speed', TOKEN_SPEED_DOC, CONV) !== undefined)
    // 会话行先于事件消失（真实时序）：sessionDoc.delete 被 404 拒绝但不抛出。
    backend.deletedConversations.add(CONV)
    await backend.dispatch('conversation.deleted', { type: 'conversation.deleted', conversationId: CONV })
    // 删除后事件不再驱动任何写入（状态机已清理；会话也不存在了）。
    const writesBefore = sessionDocs.writes.length
    await backend.dispatch('conversation.live', liveEvent(CONV, 200, { taskId: 1, attempt: 1, message: message([text('b'.repeat(400))]) }))
    assert.equal(sessionDocs.writes.length, writesBefore, '删除后无残留写入')
  } finally {
    await close()
  }
})

test('插件装配：UI 插槽注册到 COMPOSER_STATUS_SLOT；停用后监听与写入停止', { timeout: 60_000 }, async () => {
  const { host, backend, docOf, close } = await openPlugin()
  try {
    // 插槽注册：UI registry 的插件贡献包含目标槽位。
    const registry = (host as unknown as { uiRegistry: { getUiByPlugin(id: string): Array<{ spec: { target?: string; id?: string } }> } }).uiRegistry
    const ui = registry.getUiByPlugin(TOKEN_SPEED_PLUGIN_ID)
    const slot = ui.find((item) => item.spec.target === COMPOSER_STATUS_SLOT)
    assert.ok(slot, '必须向 COMPOSER_STATUS_SLOT 注册贡献')
    // 停用：监听解除，事件不再产生文档写入。
    await host.disable(TOKEN_SPEED_PLUGIN_ID)
    await backend.dispatch('conversation.live', liveEvent(4, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(4, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    assert.equal(docOf(4), null, '停用后事件监听解除，无任何写入')
  } finally {
    await close()
  }
})

test('插件装配：非法事件载荷丢弃，不抛错不写入', { timeout: 60_000 }, async () => {
  const { backend, docOf, close } = await openPlugin()
  try {
    await backend.dispatch('conversation.live', { type: 'conversation.live', live: { conversationId: 5, text: '', tools: [], updatedAt: 1, generation: { taskId: 1, attempt: -1 } } })
    await backend.dispatch('conversation.entry', { type: 'conversation.entry', conversationId: 5, entry: { id: '1', kind: 'pi.user' } })
    assert.equal(docOf(5), null)
  } finally {
    await close()
  }
})

test('文档写入节流常量与窗口配置存在性', { timeout: 60_000 }, () => {
  assert.equal(DOC_WRITE_INTERVAL_MS, 250)
  const definition: PluginDefinition = createTokenSpeedPlugin()
  assert.equal(definition.id, TOKEN_SPEED_PLUGIN_ID)
  assert.equal(typeof definition.clientRoot, 'string')
})
