/**
 * builtin:token-speed 插件行为测试：
 *
 * 1. 纯算法层（tracker.ts，注入时间）：滑动窗口（正常 / 最小跨度 / burst-stall
 *    延伸 / 跨段不延伸 / 窗口滑空）、累计快照差分与重复帧、身份变化段重置
 *    （同任务重试 / 跨任务 handOver 不重复累计）、TTFT 与 decode 分离、
 *    工具阶段解码暂停（段间不拼接间隙）、provider usage 增量优先 + 最终
 *    entry 按 taskId 精确对账（entry 先于 / 晚于段关闭帧）、中途接入基线
 *    （不制造首帧尖峰、TTFT 省略；整条 usage 对账不进终态速率）、
 *    settle/resetChain、source 口径（provider / estimate / mixed）；
 * 2. 插件装配层（真 PluginHost + 事件替身）：conversation.live / entry /
 *    deleted 事件驱动 sessionDoc 发布（节流、阶段变化立即写、终态写）、
 *    上下文失效 marker（pi.reset / pi.compaction / helmx.rewind）清空、
 *    failed / aborted 回合清空（不冒充终态）、turn_settled working（链延续）
 *    与终态（链结算 + 下一 generation 帧重置）、UI 插槽注册到
 *    COMPOSER_STATUS_SLOT、生命周期（prepare 清上周期文档 / stop 清内存态）、
 *    停用后监听与文档写入停止。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { ConversationSummary, PluginDefinition } from '@helmx/protocol'
import { COMPOSER_STATUS_SLOT, HelmxError } from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createTokenSpeedPlugin } from '../src/token-speed.js'
import { MemoryDocStore } from './helpers/plugin-test-env.js'
import {
  DOC_WRITE_INTERVAL_MS,
  TOKEN_SPEED_DOC,
  TOKEN_SPEED_PLUGIN_ID,
  asAssistantCompletion,
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

test('状态机：工具阶段暂停解码时钟但保留最近速率——段间间隙绝不计入 decodeMs', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 段一：0-400ms 生成 200 tokens。
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) } })
  tracker.observeFrame(400, { generation: { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))]) } })
  const decodingTps = tracker.liveStatus(400)!.tps!
  assert.ok(Math.abs(decodingTps - (200 / 0.3)) < 1e-6)
  // 工具阶段：generation 缺席（5s 工具执行）。
  tracker.observeFrame(500, { hasTools: true })
  tracker.observeFrame(5_000, { hasTools: true })
  let status = tracker.liveStatus(5_000)!
  assert.equal(status.phase, 'tools')
  assert.equal(status.decodeMs, 300, '只有段一的 100->400ms')
  assert.ok(Math.abs((status.tps ?? 0) - decodingTps) < 1e-6, '工具阶段保留最近有效速率不清空')
  // 段二（工具轮 handOver：新任务 taskId，空 generation 首字等待期）：保持最近速率不断流。
  tracker.observeFrame(5_100, { generation: { taskId: 2, attempt: 1 } })
  status = tracker.liveStatus(5_100)!
  assert.equal(status.phase, 'decoding')
  assert.ok(Math.abs((status.tps ?? 0) - decodingTps) < 1e-6, '轮间首字等待期保持最近有效速率')
  // 段二首增长帧到达：平滑切入新段窗口。
  tracker.observeFrame(5_200, { generation: { taskId: 2, attempt: 1, message: message([text('b'.repeat(400))]) } })
  status = tracker.liveStatus(5_200)!
  assert.ok(Math.abs((status.tps ?? 0) - 1000) < 1e-6, '新增长帧到达后切入新请求窗口（100 tok / 100ms）')
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

test('展示模型：实时/工具暂停/终态口径区分与诚实标注；无可靠速率返回 null（不以 0.0 冒充）', { timeout: 60_000 }, () => {
  const base = { outputTokens: 500, decodeMs: 4_000, source: 'mixed', windowMs: 1000 }
  // 无速率（首字前 / 无测量）：不渲染。
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'tools' }), null)
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 0 }), null)
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'settled', tps: Number.NaN }), null)
  // 正的低速率四舍五入后钳到 1，绝不渲染 "0 tok/s"（0 = 无可测量速率，应返回 null）。
  assert.equal(tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 0.3 })!.text, '1 tok/s')
  // 工具暂停期保留最近有效速率，并在 tooltip 如实标注暂停计时。
  const tools = tokenSpeedLabelOf({ ...base, phase: 'tools', tps: 52.35, ttftMs: 640 })!
  assert.equal(tools.text, '52 tok/s')
  assert.match(tools.title, /Timer paused during tools · latest decode 52 tok\/s/)
  assert.match(tools.title, /tool execution time is not counted as decode time/)
  assert.match(tools.title, /provider usage \+ char estimate mixed/)
  assert.match(tools.title, /TTFT 640ms/)
  // 实时：滑动窗口口径 + 口径标注 + TTFT 首次观测声明；徽标为四舍五入整数（无 ≈/小数），
  // 近似性披露由 tooltip 文本承担。
  const live = tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 52.35, ttftMs: 640 })!
  assert.equal(live.text, '52 tok/s')
  assert.match(live.title, /Live decode 52 tok\/s/)
  assert.match(live.title, /1\.0s sliding-window streaming rate/)
  assert.match(live.title, /provider usage \+ char estimate mixed/)
  assert.match(live.title, /time is a throttled-frame approximation, not exact server decode time/)
  assert.match(live.title, /excludes TTFT and tool execution/)
  assert.match(live.title, /TTFT 640ms \(first observed by the plugin, not the exact request start\)/)
  // 终态：对账口径（不再提滑动窗口）；时间仍为帧观测近似。
  const settled = tokenSpeedLabelOf({ ...base, phase: 'settled', tps: 125 })!
  assert.equal(settled.text, '125 tok/s')
  assert.match(settled.title, /Last turn decode 125 tok\/s \(settled/)
  assert.match(settled.title, /observed net decode time/)
  assert.doesNotMatch(settled.title, /sliding-window/)
  // 无 TTFT（中途接入）：tooltip 不编造首字延迟测量值。
  assert.doesNotMatch(tokenSpeedLabelOf({ ...base, phase: 'settled', tps: 10 })!.title, /TTFT \d+ms/)
})

test('展示模型：文案随显式 locale 切换（zh-CN 走中文口径，默认 en）', { timeout: 60_000 }, () => {
  const base = { outputTokens: 500, decodeMs: 4_000, source: 'provider', windowMs: 1000 }
  const zh = tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 52.35 }, 'zh-CN')!
  assert.match(zh.title, /实时解码 52 tok\/s（1\.0s 滑动窗口流式观测速率，口径 供应商 usage；/)
  assert.match(zh.title, /时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行；已生成 500 tok \/ 观测解码 4\.0s）$/)
  const en = tokenSpeedLabelOf({ ...base, phase: 'decoding', tps: 52.35 })!
  assert.match(en.title, /\(1\.0s sliding-window streaming rate, basis provider usage; time is a throttled-frame approximation, not exact server decode time; excludes TTFT and tool execution; 500 tok generated \/ 4\.0s observed decode\)$/)
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
  assert.equal(
    asConversationLiveFrame({ type: 'conversation.live', live: { conversationId: 1, text: '', tools: [], updatedAt: 1, generation: { taskId: 'task-9', attempt: 1 } } }),
    undefined,
    'taskId 非正整数（如字符串）整体拒绝（请求身份事实存在即必须合法）',
  )
  const frame = asConversationLiveFrame({
    type: 'conversation.live',
    live: { conversationId: 2, text: '', tools: [], updatedAt: 42, generation: { taskId: 9, attempt: 3 } },
  })
  assert.deepEqual(frame, { conversationId: 2, generation: { taskId: 9, attempt: 3 }, hasTools: false, updatedAt: 42 })
})

test('事件守卫：asAssistantCompletion 抽取通用完成事实（role/stopReason 校验，不过滤成败）', { timeout: 60_000 }, () => {
  const base = { type: 'conversation.entry', conversationId: 3 }
  // 信封 / kind / model 形状 / role / stopReason 逐层校验。
  assert.equal(asAssistantCompletion({ ...base, entry: { id: '1', kind: 'pi.user', model: [{ role: 'user' }] } }), undefined, '非 pi.assistant 不消费')
  assert.equal(
    asAssistantCompletion({ ...base, entry: { id: '1', kind: 'pi.assistant', model: [{ role: 'user', stopReason: 'stop' }] } }),
    undefined,
    'model[0].role 非 assistant 拒绝',
  )
  assert.equal(
    asAssistantCompletion({ ...base, entry: { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant' }] } }),
    undefined,
    '缺 stopReason 的载荷不完整，拒绝',
  )
  // 成功终态：taskId（正整数）+ entryId + usage + stopReason 全量事实。
  assert.deepEqual(
    asAssistantCompletion({ ...base, entry: { id: '1', kind: 'pi.assistant', taskId: 9, model: [{ role: 'assistant', stopReason: 'stop', usage: { output: 120 } }] } }),
    { conversationId: 3, taskId: 9, entryId: '1', usageOutput: 120, stopReason: 'stop' },
  )
  // 失败 / 中止同样是终结事实（策略层需知道该请求已结束），照实携带不过滤。
  assert.deepEqual(
    asAssistantCompletion({ ...base, entry: { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'aborted', usage: { output: 40 } }] } }),
    { conversationId: 3, taskId: undefined, entryId: '2', usageOutput: 40, stopReason: 'aborted' },
  )
  // usage 缺失 / 零值不携带（绝不以 0 对账）；taskId 非法形状视为缺省（身份不明）。
  const noUsage = asAssistantCompletion({ ...base, entry: { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'error' }] } })
  assert.deepEqual(noUsage, { conversationId: 3, taskId: undefined, entryId: '3', usageOutput: undefined, stopReason: 'error' })
  const zeroUsage = asAssistantCompletion({ ...base, entry: { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'stop', usage: { output: 0 } }] } })
  assert.equal(zeroUsage!.usageOutput, undefined)
  const badTaskId = asAssistantCompletion({ ...base, entry: { id: '5', kind: 'pi.assistant', taskId: 'task-9', model: [{ role: 'assistant', stopReason: 'stop' }] } })
  assert.equal(badTaskId!.taskId, undefined)
  // 含 content 数组时提取 text + thinking + toolCall 的字符总量。
  const withContent = asAssistantCompletion({
    ...base,
    entry: {
      id: '6',
      kind: 'pi.assistant',
      taskId: 10,
      model: [
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'thinking', thinking: 'think' },
            { type: 'text', text: 'hello' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
          ],
          usage: { output: 25 },
        },
      ],
    },
  })
  assert.equal(withContent?.contentChars, 5 + 5 + 4 + JSON.stringify({ command: 'ls' }).length)
})

// ---------------------------------------------------------------------------
// 2. 插件装配层（真 PluginHost + 事件替身）
// ---------------------------------------------------------------------------

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
  listConversationIds(pluginId: string, name: string): number[] {
    const prefix = `${pluginId}\0${name}\0`
    const out: number[] = []
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue
      const id = Number(key.slice(prefix.length))
      if (Number.isInteger(id) && id > 0) out.push(id)
    }
    return out
  }
  async flush(): Promise<void> {}
}

/** 事件替身后端：捕获 ctx.host.onEvent 监听器；getConversation 按删除集模拟存在性。 */
class EventBackend {
  readonly listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  readonly deletedConversations = new Set<number>()
  readonly sessionDocEvents: string[] = []
  readonly base: PluginHostBackend
  constructor() {
    const listeners = this.listeners
    const deleted = this.deletedConversations
    const sessionDocEvents = this.sessionDocEvents
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
      emitEvent(type: string, payload: unknown): void {
        if (type === 'plugin.session_doc.updated' && payload !== null && typeof payload === 'object') {
          const wrapper = payload as {
            doc?: { pluginId?: unknown; name?: unknown; conversationId?: unknown; deleted?: unknown }
          }
          const event = wrapper.doc
          if (
            event !== undefined &&
            event.deleted !== true &&
            typeof event.pluginId === 'string' &&
            typeof event.name === 'string' &&
            typeof event.conversationId === 'number'
          ) {
            sessionDocEvents.push(`${event.pluginId}:${event.name}:${event.conversationId}`)
          }
        }
      },
      getConversation(id: number): ConversationSummary {
        if (deleted.has(id)) throw new HelmxError('not_found', `会话不存在：${id}`, 404)
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

function entryEvent(conversationId: number, taskId: number | undefined, output: number, options?: { stopReason?: string; entryId?: string }): unknown {
  return {
    type: 'conversation.entry',
    conversationId,
    entry: {
      id: options?.entryId ?? `entry-${conversationId}-${taskId ?? 'anon'}`,
      kind: 'pi.assistant',
      ...(taskId !== undefined ? { taskId } : {}),
      model: [{ role: 'assistant', stopReason: options?.stopReason ?? 'stop', usage: { output } }],
    },
  }
}

/** 上下文失效 marker 条目事件（pi.reset / pi.compaction / helmx.rewind）。 */
function markerEvent(conversationId: number, kind: 'pi.reset' | 'pi.compaction' | 'helmx.rewind'): unknown {
  return { type: 'conversation.entry', conversationId, entry: { id: '10', kind } }
}

interface Harness {
  host: PluginHost
  backend: EventBackend
  sessionDocs: MemorySessionDocStore
  docOf: (conversationId: number) => TokenSpeedStatus | null
  writesOf: (conversationId: number) => number
  close: () => Promise<void>
}

async function openPlugin(options?: { now?: () => number }): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-token-speed-'))
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
  await host.register(createTokenSpeedPlugin(options), { enabled: true })
  return {
    host,
    backend,
    sessionDocs,
    docOf: (conversationId) =>
      (host.getPublicSessionDoc(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, conversationId)?.value as TokenSpeedStatus | null | undefined) ?? null,
    writesOf: (conversationId) =>
      backend.sessionDocEvents.filter((key) => key === `${TOKEN_SPEED_PLUGIN_ID}:${TOKEN_SPEED_DOC}:${conversationId}`).length,
    close: async () => {
      try {
        assert.equal(sessionDocs.writes.length, 0, 'durable: false 绝不写持久化会话文档存储')
      } finally {
        await host.dispose()
        rmSync(dataDir, { recursive: true, force: true })
      }
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
    // 同阶段密集帧：120ms 节流内不立即写（进入尾帧延迟补写）。
    await backend.dispatch('conversation.live', liveEvent(CONV, 120, { taskId: 1, attempt: 1, message: message([text('a'.repeat(440))]) }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 140, { taskId: 1, attempt: 1, message: message([text('a'.repeat(480))]) }))
    assert.equal(writesOf(CONV), writesAfterFirst, '同阶段节流窗口内不写')
    // 阶段变化（工具）：立即写（取消待写定时器并保留最近有效速率）。
    await backend.dispatch('conversation.live', liveEvent(CONV, 160, undefined, [{ callId: 'c1', toolName: 'bash', status: 'running' }]))
    const tools = docOf(CONV)!
    assert.equal(tools.phase, 'tools')
    assert.ok(typeof tools.tps === 'number' && tools.tps > 0, '工具阶段保留最近有效速率')
    assert.equal(writesOf(CONV), writesAfterFirst + 1)
  } finally {
    await close()
  }
})

test('插件装配：节流尾帧延迟补写；reset/turn_settled 取消待写定时器不回写幽灵文档', { timeout: 60_000 }, async () => {
  let fakeClock = 100
  const { backend, host, docOf, writesOf, close } = await openPlugin({ now: () => fakeClock })
  try {
    const CONV = 11
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 120, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    const writesAfterFirst = writesOf(CONV)
    // 节流窗口内再发一帧：不立即写，由尾定时器在 120ms 到期补写。
    fakeClock = 140
    await backend.dispatch('conversation.live', liveEvent(CONV, 140, { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))]) }))
    assert.equal(writesOf(CONV), writesAfterFirst)
    assert.equal(docOf(CONV)!.outputTokens, 100)
    fakeClock = 260
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(writesOf(CONV), writesAfterFirst + 1, '窗口尾部自动补写最后一跳')
    assert.equal(docOf(CONV)!.outputTokens, 200)

    // 再入节流窗口后立刻 reset：待写定时器必须被取消，绝不回写幽灵数据。
    fakeClock = 280
    await backend.dispatch('conversation.live', liveEvent(CONV, 280, { taskId: 1, attempt: 1, message: message([text('a'.repeat(1200))]) }))
    assert.equal(writesOf(CONV), writesAfterFirst + 1)
    await backend.dispatch('conversation.entry', markerEvent(CONV, 'pi.reset'))
    assert.equal(docOf(CONV), null)
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(docOf(CONV), null, 'reset 后已取消待写定时器，绝不复活旧数据')

    // 再入节流窗口后 failed turn_settled：同样取消定时器且不回写。
    fakeClock = 500
    await backend.dispatch('conversation.live', liveEvent(CONV, 500, { taskId: 2, attempt: 1 }))
    fakeClock = 520
    await backend.dispatch('conversation.live', liveEvent(CONV, 520, { taskId: 2, attempt: 1, message: message([text('b'.repeat(400))]) }))
    const writesBeforeThrottle = writesOf(CONV)
    fakeClock = 540
    await backend.dispatch('conversation.live', liveEvent(CONV, 540, { taskId: 2, attempt: 1, message: message([text('b'.repeat(800))]) }))
    assert.equal(writesOf(CONV), writesBeforeThrottle)
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'error'), inputs: [], outcome: 'failed', error: 'err', settledAt: 550 })
    assert.equal(docOf(CONV), null)
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(docOf(CONV), null, 'failed 后待写定时器已取消，不复活测量')
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

test('插件装配：会话删除彻底清理（瞬态内存态清理；会话行已删时文档删除按 not_found 容忍）', { timeout: 60_000 }, async () => {
  const { backend, docOf, writesOf, sessionDocs, close } = await openPlugin()
  try {
    const CONV = 3
    await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    assert.ok(docOf(CONV) !== null)
    assert.equal(sessionDocs.writes.length, 0)
    // 会话行先于事件消失（真实时序）：sessionDoc.delete 容忍 not_found，同时 PluginHost 释放内存条目。
    backend.deletedConversations.add(CONV)
    await backend.dispatch('conversation.deleted', { type: 'conversation.deleted', conversationId: CONV })
    assert.throws(
      () => docOf(CONV),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      '已删会话读取公共会话文档显式 404',
    )
    // 删除后事件不再驱动任何写入（状态机已清理；会话也不存在了）。
    const writesBefore = writesOf(CONV)
    await backend.dispatch('conversation.live', liveEvent(CONV, 200, { taskId: 1, attempt: 1, message: message([text('b'.repeat(400))]) }))
    assert.equal(writesOf(CONV), writesBefore, '删除后无残留写入')
  } finally {
    await close()
  }
})

test('插件装配：UI 插槽注册到 COMPOSER_STATUS_SLOT；停用后监听与写入停止', { timeout: 60_000 }, async () => {
  const { host, backend, docOf, writesOf, close } = await openPlugin()
  try {
    // 插槽注册：UI registry 的插件贡献包含目标槽位。
    const registry = (host as unknown as { uiRegistry: { getUiByPlugin(id: string): Array<{ spec: { target?: string; id?: string } }> } }).uiRegistry
    const ui = registry.getUiByPlugin(TOKEN_SPEED_PLUGIN_ID)
    const slot = ui.find((item) => item.spec.target === COMPOSER_STATUS_SLOT)
    assert.ok(slot, '必须向 COMPOSER_STATUS_SLOT 注册贡献')
    // 停用：监听解除，事件不再产生文档写入，公开读取 404。
    await host.disable(TOKEN_SPEED_PLUGIN_ID)
    await backend.dispatch('conversation.live', liveEvent(4, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(4, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    assert.equal(writesOf(4), 0, '停用后事件监听解除，无任何写入')
    assert.throws(
      () => docOf(4),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_doc_not_found',
      '停用后公共会话文档读取 404',
    )
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

test('插件装配：空闲时上下文失效 marker（reset/compaction/rewind）清空上一回合 settled 文档与状态机', { timeout: 60_000 }, async () => {
  const { backend, host, sessionDocs, docOf, close } = await openPlugin()
  try {
    const CONV = 6
    // 先积累一个已结算终态（两次增长帧保证 decodeMs > 0；空闲时徽标显示 settled 值）。
    await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 400, { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))]) }))
    await backend.dispatch('conversation.entry', entryEvent(CONV, 1, 200))
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'done'), inputs: [], outcome: 'completed', settledAt: 500 })
    assert.equal(docOf(CONV)!.phase, 'settled')
    // 三种边界 marker 逐个验证：任一到达即彻底清空，不残留旧回合值。
    for (const kind of ['pi.compaction', 'helmx.rewind', 'pi.reset'] as const) {
      await backend.dispatch('conversation.live', liveEvent(CONV, 600, { taskId: 2, attempt: 1 }))
      await backend.dispatch('conversation.live', liveEvent(CONV, 700, { taskId: 2, attempt: 1, message: message([text('b'.repeat(400))]) }))
      await backend.dispatch('conversation.live', liveEvent(CONV, 900, { taskId: 2, attempt: 1, message: message([text('b'.repeat(800))]) }))
      await backend.dispatch('conversation.entry', entryEvent(CONV, 2, 200))
      await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'done'), inputs: [], outcome: 'completed', settledAt: 1_000 })
      assert.equal(docOf(CONV)!.phase, 'settled', `重建终态后验证 ${kind} 清空`)
      await backend.dispatch('conversation.entry', markerEvent(CONV, kind))
      assert.equal(docOf(CONV), null, `${kind} 到达后文档清空`)
      assert.equal(sessionDocs.get(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, CONV), undefined, `${kind} 后持久行删除`)
    }
    // marker 后新回合计数从零开始（旧上下文速率事实不可归属，不回退旧 TPS）。
    await backend.dispatch('conversation.live', liveEvent(CONV, 1_100, { taskId: 3, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(CONV, 1_200, { taskId: 3, attempt: 1, message: message([text('c'.repeat(40))]) }))
    assert.equal(docOf(CONV)!.outputTokens, 10, '新回合从零累计，不携带 marker 前测量')
  } finally {
    await close()
  }
})

test('插件装配：失败 / 中止回合直接清空测量，不冒充正常终态', { timeout: 60_000 }, async () => {
  const { backend, host, docOf, close } = await openPlugin()
  try {
    const CONV = 7
    const buildMeasurement = async () => {
      await backend.dispatch('conversation.live', liveEvent(CONV, 0, { taskId: 1, attempt: 1 }))
      await backend.dispatch('conversation.live', liveEvent(CONV, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
      await backend.dispatch('conversation.live', liveEvent(CONV, 300, { taskId: 1, attempt: 1, message: message([text('a'.repeat(800))]) }))
    }
    // failed：清空，不产出 settled。
    await buildMeasurement()
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'error'), inputs: [], outcome: 'failed', error: 'provider 503', settledAt: 400 })
    assert.equal(docOf(CONV), null, 'failed 回合不把未完成回答装成终态')
    // aborted：同样清空。
    await buildMeasurement()
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'error'), inputs: [], outcome: 'aborted', settledAt: 500 })
    assert.equal(docOf(CONV), null, 'aborted 回合不产出终态')
    // 失败请求的 entry 完成事实（stopReason: aborted）到达也不对账冒充成功。
    await buildMeasurement()
    await backend.dispatch('conversation.entry', entryEvent(CONV, 1, 999, { stopReason: 'aborted' }))
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'error'), inputs: [], outcome: 'failed', settledAt: 600 })
    assert.equal(docOf(CONV), null)
    // completed 链中点（working）不受影响：失败清理不涉及链延续路径。
    await buildMeasurement()
    await host.runHook('turn_settled', { conversation: conversationOf(CONV, 'working'), inputs: [], outcome: 'completed', settledAt: 700 })
    assert.equal(docOf(CONV)?.phase ?? 'decoding', 'decoding', 'working 中间结算仍不产生终态')
  } finally {
    await close()
  }
})

test('插件装配：生命周期——durable: false 不读写持久化存储，停用立即清空内存态，重启用无过期实时状态', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-token-speed-'))
  const backend = new EventBackend()
  const docs = new MemoryDocStore()
  const sessionDocs = new MemorySessionDocStore()
  // 预置旧周期持久表遗留行：durable: false 不读写 sessionDocs，绝不读取也不误展示，且零写入持久化存储。
  const stale: TokenSpeedStatus = {
    phase: 'decoding',
    tps: 88.8,
    outputTokens: 999,
    decodeMs: 4_000,
    source: 'provider',
    windowMs: 1_000,
    updatedAt: 1,
  }
  sessionDocs.put(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, 8, JSON.stringify(stale))
  const staleWrites = sessionDocs.writes.length
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend.base,
    docs,
    sessionDocs: sessionDocs as never,
  })
  const readTransient = (conversationId: number) =>
    (host.getPublicSessionDoc(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, conversationId)?.value as TokenSpeedStatus | null | undefined) ?? null
  try {
    await host.register(createTokenSpeedPlugin(), { enabled: true })
    assert.equal(readTransient(8), null, 'durable: false 启动不读取历史持久遗留行')
    assert.equal(sessionDocs.writes.length, staleWrites, '注册与启用零持久化写入')
    // 本周期新流量写入内存瞬态文档。
    await backend.dispatch('conversation.live', liveEvent(8, 0, { taskId: 1, attempt: 1 }))
    await backend.dispatch('conversation.live', liveEvent(8, 100, { taskId: 1, attempt: 1, message: message([text('a'.repeat(400))]) }))
    assert.notEqual(readTransient(8), null, '本周期实时测量已写入瞬态内存文档')
    assert.equal(sessionDocs.writes.length, staleWrites, '实时写入全程零持久化存储写操作')
    // 停用：stop 清内存态；瞬态 sessionDoc 同步从内存清理，UI 与公开文档均消失。
    await host.disable(TOKEN_SPEED_PLUGIN_ID)
    assert.throws(
      () => readTransient(8),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_doc_not_found',
      '停用后瞬态会话文档立即下线（404）',
    )
    assert.equal(sessionDocs.writes.length, staleWrites)
    // 重新启用：全新空白瞬态文档，无任何上周期残留。
    await host.enable(TOKEN_SPEED_PLUGIN_ID)
    assert.equal(readTransient(8), null, '重启用后无上周期残留态')
    const registry = (host as unknown as { uiRegistry: { getUiByPlugin(id: string): Array<{ spec: { target?: string; id?: string } }> } }).uiRegistry
    assert.ok(
      registry.getUiByPlugin(TOKEN_SPEED_PLUGIN_ID).some((item) => item.spec.target === COMPOSER_STATUS_SLOT),
      '重启用后 UI 插槽贡献恢复',
    )
  } finally {
    await host.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('文档写入节流常量与窗口配置存在性', { timeout: 60_000 }, () => {
  assert.equal(DOC_WRITE_INTERVAL_MS, 120)
  const definition: PluginDefinition = createTokenSpeedPlugin()
  assert.equal(definition.id, TOKEN_SPEED_PLUGIN_ID)
  assert.equal(typeof definition.clientRoot, 'string')
})
