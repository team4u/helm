/**
 * builtin:token-speed 显式请求身份对账回归测试（fix/token-speed-metering）。
 *
 * 锁定此前 FIFO 猜测对账的两个可复现缺陷及身份关联的边界：
 * 1. 无 streaming usage 供应商 + 中断重试：aborted entry（无 usage）不消费
 *    FIFO 槽位导致 attempt 2 的 usage 错配废弃段（双计 240/权威 120）；
 * 2. 短工具轮 tools 帧被 75ms 节流合并丢失：内容减半启发式无法分段，工具
 *    间隙计入 decodeMs、usage 反向错配（20/权威 120）；
 * 3. 身份边界：无 taskId entry 不关联、重复 entry 不重复计量、迟到空帧 /
 *    过期快照不复活已消费段、同任务重试与跨任务 handOver（attempt 重置 1）
 *    两种观察顺序（entry 先于 / 晚于段关闭帧）均正确；
 * 4. 速率配对诚实性：中途接入被整条 usage 对账的段不进终态速率（suffix
 *    时间 × 整条计数不可配对）；单增长帧段（跨度 0）不伪造分母。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationTokenSpeedTracker, type CompletionFact } from '../src/token-speed/tracker.js'

const WINDOW = 1000
const MIN_SPAN = 100

function trackerOf(): ConversationTokenSpeedTracker {
  return new ConversationTokenSpeedTracker({ windowMs: WINDOW, minSpanMs: MIN_SPAN })
}

interface Msg {
  text?: string
  usageOutput?: number
}

function message({ text, usageOutput }: Msg): never {
  return {
    content: text !== undefined ? [{ type: 'text', text }] : [],
    ...(usageOutput !== undefined ? { usage: { output: usageOutput } } : {}),
  } as never
}

let entrySeq = 0
function success(taskId: number, usageOutput?: number): CompletionFact {
  entrySeq += 1
  return { taskId, entryId: `m${entrySeq}`, usageOutput, stopReason: undefined }
}
function failure(taskId: number, stopReason: 'aborted' | 'error', usageOutput?: number): CompletionFact {
  entrySeq += 1
  return { taskId, entryId: `m${entrySeq}`, usageOutput, stopReason }
}

test('回归 1：中断重试的 aborted entry（无 usage）不错配——最终成功总量 120 非 240', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // attempt 1 流式 400 chars（OpenAI 兼容网关：无 streaming usage）→ 估算 100。
  tracker.observeFrame(0, { generation: { taskId: 7, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 7, attempt: 1, message: message({ text: 'x'.repeat(400) }) } })
  // 宿主中断重试：convertPartial 提交 aborted entry（无 usage），先于同提交 live 帧。
  tracker.noteCompletion(failure(7, 'aborted'))
  // 同 commit live 帧：generation={attempt:1}（retry 标记被投影丢弃）→ 空帧。
  tracker.observeFrame(200, { generation: { taskId: 7, attempt: 1 } })
  // 退避唤醒：attempt 2 重流 480 chars；成功 entry usage=120 先于关闭帧到达。
  tracker.observeFrame(1000, { generation: { taskId: 7, attempt: 2 } })
  tracker.observeFrame(1100, { generation: { taskId: 7, attempt: 2, message: message({ text: 'y'.repeat(480) }) } })
  tracker.noteCompletion(success(7, 120))
  tracker.observeFrame(1200, { hasTools: true })

  const status = tracker.liveStatus(1200)!
  assert.equal(status.outputTokens, 120, '废弃 attempt 1 计数剔除，只计成功 attempt 2 的权威 120')
  assert.equal(status.source, 'provider')
  // 旧 retry 空帧 / 迟到快照不复活废弃段（身份已消费，重复完成事实无效果）。
  tracker.observeFrame(1300, { generation: { taskId: 7, attempt: 1 } })
  tracker.noteCompletion(failure(7, 'aborted'))
  tracker.noteCompletion(success(7, 999))
  assert.equal(tracker.liveStatus(1300)!.outputTokens, 120)
})

test('回归 2：tools 帧被节流合并丢失——taskId 边界仍精确分段，间隙不入 decodeMs', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 轮 1（taskId 1）：短 tool-call 消息 50 chars（两个增长帧，span 30ms）；
  // entry U1=20 到达时段仍 open（无任何 tools 帧）；工具执行 <75ms，tools 帧
  // 被合并丢弃。
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(30, { generation: { taskId: 1, attempt: 1, message: message({ text: 'x'.repeat(25) }) } })
  tracker.observeFrame(60, { generation: { taskId: 1, attempt: 1, message: message({ text: 'x'.repeat(50) }) } })
  tracker.noteCompletion(success(1, 20))
  // 轮 2（taskId 2，attempt 重置 1）首帧已带 80 chars（≥ 轮 1 字符一半——
  // 旧内容减半启发式在此失手；taskId 边界不受影响）。
  tracker.observeFrame(1000, { generation: { taskId: 2, attempt: 1, message: message({ text: 'y'.repeat(80) }) } })
  const mid = tracker.liveStatus(1000)!
  assert.equal(mid.decodeMs, 30, '轮 1 span 30->60ms；940ms 工具/请求间隙绝不计入')
  tracker.observeFrame(1300, { generation: { taskId: 2, attempt: 1, message: message({ text: 'y'.repeat(480) }) } })
  tracker.noteCompletion(success(2, 100))
  tracker.observeFrame(1400, { hasTools: true })
  let status = tracker.liveStatus(1400)!
  assert.equal(status.outputTokens, 120, 'U1 + U2 = 120（不错配、不反向错配）')
  assert.equal(status.decodeMs, 30 + 300, '两段解码拼接，间隙剔除')
  // 轮 3（taskId 3）：usage U3=90 —— 后续无持续错位。
  tracker.observeFrame(1500, { generation: { taskId: 3, attempt: 1 } })
  tracker.observeFrame(1600, { generation: { taskId: 3, attempt: 1, message: message({ text: 'z'.repeat(400) }) } })
  tracker.noteCompletion(success(3, 90))
  tracker.observeFrame(1700, { hasTools: true })
  status = tracker.liveStatus(1700)!
  assert.equal(status.outputTokens, 210, '120 + 90，无跨轮错位残留')
})

test('边界：无 taskId entry 不关联不猜测；重复 entry 不重复计量', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(400) }) } })
  // scheduler 上下文 salvaged entry（无 byTaskId）：身份不明，不关联。
  tracker.noteCompletion({ taskId: undefined, entryId: 'anon-1', usageOutput: 999, stopReason: undefined })
  tracker.noteCompletion({ taskId: undefined, entryId: 'anon-2', usageOutput: 999, stopReason: undefined })
  assert.equal(tracker.liveStatus(100)!.outputTokens, 100, '流式估算不被无名 entry 污染')
  // 未知 taskId（从未观测其流）：不乱配给当前段。
  tracker.noteCompletion(success(42, 999))
  assert.equal(tracker.liveStatus(100)!.outputTokens, 100)
  // 正常对账后：同 entryId 重复投递不重复计量。
  tracker.noteCompletion(success(1, 120))
  tracker.noteCompletion(success(1, 120))
  assert.equal(tracker.liveStatus(100)!.outputTokens, 120)
})

test('边界：error 尝试（含 usage）计数同样剔除；无 usage 成功完成也消费段', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 5, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 5, attempt: 1, message: message({ text: 'x'.repeat(400) }) } })
  // 供应商在 error entry 上也上报了 usage：仍是失败尝试，不进回合总量。
  tracker.noteCompletion(failure(5, 'error', 80))
  tracker.observeFrame(200, { generation: { taskId: 5, attempt: 1 } })
  tracker.observeFrame(1000, { generation: { taskId: 5, attempt: 2 } })
  tracker.observeFrame(1100, { generation: { taskId: 5, attempt: 2, message: message({ text: 'y'.repeat(40) }) } })
  // 成功但无 usage（网关不上报）：消费关闭段，保留流式估算口径。
  tracker.noteCompletion(success(5))
  tracker.observeFrame(1200, { hasTools: true })
  const status = tracker.liveStatus(1200)!
  assert.equal(status.outputTokens, 10, 'error 段剔除；成功段保留估算 10')
  assert.equal(status.source, 'estimate')
})

test('边界：完成事实晚于段关闭帧到达（entry 在 tools 帧之后）同样精确关联', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 观察顺序 B：段先被 tools 帧关闭，entry 随后才到。
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(400) }) } })
  tracker.observeFrame(200, { hasTools: true })
  tracker.noteCompletion(success(1, 120))
  tracker.observeFrame(300, { generation: { taskId: 2, attempt: 1 } })
  tracker.observeFrame(400, { generation: { taskId: 2, attempt: 1, message: message({ text: 'b'.repeat(400), usageOutput: 60 }) } })
  tracker.noteCompletion(success(2, 60))
  const status = tracker.liveStatus(400)!
  assert.equal(status.outputTokens, 180, '两种观察顺序（先关后关）均按 taskId 正确对账')
})

test('精度：中途接入段被整条 usage 对账——计数入总量、不进终态速率分子分母', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 插件启用时请求已流过大半（首帧即带 8000 chars 历史内容，无空 generation 基线）。
  tracker.observeFrame(0, { generation: { taskId: 9, attempt: 1, message: message({ text: 'h'.repeat(8000), usageOutput: 2000 }) } })
  // 只测得 suffix：100ms 内新增 80 chars（20 tok 估算）。
  tracker.observeFrame(100, { generation: { taskId: 9, attempt: 1, message: message({ text: 'h'.repeat(8080), usageOutput: 2020 }) } })
  tracker.noteCompletion(success(9, 2000))
  const settled = tracker.settle(200)!
  assert.equal(settled.outputTokens, 2000, '权威整条总量如实计入 token 总量')
  assert.equal(settled.tps, undefined, '2000 tok / 100ms suffix ≠ 真实速率——不伪造分母，不产终态速率')
})

test('精度：单增长帧段（跨度 0）不进速率对——终态无速率而非假速率', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  // 极短回复：整个响应在一个观测帧内到达（节流合并）。
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(400), usageOutput: 100 }) } })
  tracker.noteCompletion(success(1, 100))
  const settled = tracker.settle(200)!
  assert.equal(settled.outputTokens, 100)
  assert.equal(settled.tps, undefined, '跨度 0 无可靠时间测量，不以最小跨度伪造终态速率')
})

test('完成后的迟到内容帧与旧任务帧均不能复活已消费的请求', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(40) }) } })
  tracker.noteCompletion(success(1, 20))
  tracker.observeFrame(150, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(80) }) } })
  assert.equal(tracker.liveStatus(150)!.outputTokens, 20)
  tracker.observeFrame(200, { generation: { taskId: 2, attempt: 1 } })
  tracker.observeFrame(250, { generation: { taskId: 2, attempt: 1, message: message({ text: 'b'.repeat(40) }) } })
  tracker.observeFrame(300, { generation: { taskId: 1, attempt: 2, message: message({ text: 'a'.repeat(400) }) } })
  tracker.noteCompletion(success(2, 30))
  assert.equal(tracker.settle(400)!.outputTokens, 50, '旧任务不挤掉当前请求，不额外累计')
})

test('跨请求的实时窗口清空，短工具间隙也不混入上一请求的速率', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  tracker.observeFrame(100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(400) }) } })
  tracker.observeFrame(200, { generation: { taskId: 1, attempt: 1, message: message({ text: 'a'.repeat(800) }) } })
  tracker.noteCompletion(success(1, 200))
  tracker.observeFrame(250, { generation: { taskId: 2, attempt: 1, message: message({ text: 'b'.repeat(4) }) } })
  assert.equal(tracker.liveStatus(250)!.tps, 10, '只计本次生成的1 token / 最小100ms窗口')
})

test('长回合超过段缓存上限仍保留全部成功响应的计数与解码时间', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  for (let taskId = 1; taskId <= 100; taskId += 1) {
    const start = taskId * 1000
    tracker.observeFrame(start, { generation: { taskId, attempt: 1 } })
    tracker.observeFrame(start + 100, { generation: { taskId, attempt: 1, message: message({ text: 'a'.repeat(20) }) } })
    tracker.observeFrame(start + 200, { generation: { taskId, attempt: 1, message: message({ text: 'a'.repeat(40) }) } })
    tracker.noteCompletion(success(taskId, 10))
  }
  const settled = tracker.settle(101_000)!
  assert.equal(settled.outputTokens, 1000)
  assert.equal(settled.decodeMs, 10_000)
  assert.equal(settled.tps, 100)
})

test('字符估算按累计量取整，不因逐字小帧而成倍计量', { timeout: 60_000 }, () => {
  const tracker = trackerOf()
  tracker.observeFrame(0, { generation: { taskId: 1, attempt: 1 } })
  for (let chars = 1; chars <= 8; chars += 1) {
    tracker.observeFrame(chars * 100, { generation: { taskId: 1, attempt: 1, message: message({ text: 'x'.repeat(chars) }) } })
  }
  assert.equal(tracker.liveStatus(800)!.outputTokens, 2, '8字符约2 tokens，不是每帧1 token累计8次')
  assert.equal(tracker.liveStatus(800)!.decodeMs, 700, '不增加取整后token数的内容增长仍推进观测时间')
})
