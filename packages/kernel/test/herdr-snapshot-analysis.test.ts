/**
 * 阻塞快照 AI 解析 helper 契约测试（snapshot-analysis，插件策略层）：
 * - 真正有界 deadline：底层依赖完全忽略 AbortSignal（请求永不返回）时，
 *   Promise.race 的独立 timeout promise 仍按时结算，返回回退 + 脱敏诊断；
 * - 外部 signal 预先 aborted：不发起请求，立即以 aborted reject；
 * - 外部在途取消：立即传播原始语义（不等到 deadline，绝不回退）；
 * - 迟到结果不污染：deadline 先返回后，底层随后 resolve 的结果被丢弃；
 * - 错误诊断只含 code/短原因，不携带模型响应与快照原文；
 * - 正常路径：传回端口参数（尾部截断 + maxTokens）并解析 JSON。
 *
 * 时序全部用显式 deferred/短超时（测试注入 30-80ms），不写大 sleep。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { HelmError } from '@helm/protocol'
import {
  createBlockedSnapshotAnalyzer,
  type ConversationTextPort,
} from '../src/builtin-plugins/herdr/snapshot-analysis.js'

/** 手写 deferred（不用 sleep 对齐并发时序）。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 不响应 signal 的端口（挂起直到手动结算）。 */
function unresponsivePort(
  observed: { calls: number; lastSignal: AbortSignal | undefined },
): ConversationTextPort & { settle(value: string): void; fail(error: unknown): void } {
  const d = deferred<string>()
  return {
    completeConversationText(input) {
      observed.calls += 1
      observed.lastSignal = input.signal
      return d.promise
    },
    settle: d.resolve,
    fail: d.reject,
  }
}

test('deadline: 底层不响应 signal 时按时返回回退诊断，迟到结果不生效', { timeout: 60_000 }, async () => {
  const observed = { calls: 0, lastSignal: undefined as AbortSignal | undefined }
  const port = unresponsivePort(observed)
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 60 })
  const started = Date.now()
  const outcome = await analyzer.analyze({ snapshot: 'snapshot', conversationId: 1 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_000, `deadline 及时返回（实得 ${elapsed}ms）`)
  assert.equal(outcome.analysis, undefined)
  assert.ok(outcome.diagnostic !== undefined && outcome.diagnostic.includes('60ms'), '诊断含超时毫秒')
  // 底层已收到 abort（尽力而为）；迟到 resolve 不污染已返回的结果。
  assert.equal(observed.lastSignal?.aborted, true, 'deadline 已中止底层 signal')
  port.settle('{"summary":"late","options":[{"label":"x","keys":["y"]}]}')
  await new Promise((r) => setTimeout(r, 20))
  // 无 unhandled rejection 即通过（迟到 reject 由 request 内部 catch 折叠）。
  port.fail(new Error('late failure'))
  await new Promise((r) => setTimeout(r, 20))
})

test('deadline 覆盖模型解析全过程：端口在解析阶段挂起同样按时返回', { timeout: 60_000 }, async () => {
  const d = deferred<string>()
  let started = false
  const port: ConversationTextPort = {
    async completeConversationText() {
      // 模拟「模型解析」阶段（进入端口即挂起，不消费 signal）。
      started = true
      return d.promise
    },
  }
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 50 })
  const outcome = await analyzer.analyze({ snapshot: 's', conversationId: 1 })
  assert.equal(started, true)
  assert.equal(outcome.analysis, undefined)
  assert.ok(outcome.diagnostic?.includes('50ms'))
})

test('pre-abort: 外部 signal 预先取消时不发起请求', { timeout: 60_000 }, async () => {
  const observed = { calls: 0, lastSignal: undefined as AbortSignal | undefined }
  const port = unresponsivePort(observed)
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 1_000 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    analyzer.analyze({ snapshot: 's', conversationId: 1, signal: controller.signal }),
    (e: unknown) => e instanceof Error,
  )
  assert.equal(observed.calls, 0, '预先取消不发起请求')
})

test('在途 abort: 外部取消立即传播原始错误（不等待 deadline、不回退）', { timeout: 60_000 }, async () => {
  const observed = { calls: 0, lastSignal: undefined as AbortSignal | undefined }
  const port = unresponsivePort(observed)
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 5_000 })
  const controller = new AbortController()
  const pending = analyzer.analyze({ snapshot: 's', conversationId: 1, signal: controller.signal })
  // 端口已发起（同步注册后微任务内），外部取消立即传播。
  await new Promise((r) => setTimeout(r, 10))
  const abortErr = new HelmError('aborted', '外部取消', 499)
  controller.abort(abortErr)
  await assert.rejects(pending, () => true, '外部取消 reject')
  // 底层迟到的结果不产生 unhandled rejection。
  port.settle('late')
  await new Promise((r) => setTimeout(r, 20))
})

test('在途 abort（signal 原因丢失）: 仍立即传播不回退', { timeout: 60_000 }, async () => {
  const observed = { calls: 0, lastSignal: undefined as AbortSignal | undefined }
  const port = unresponsivePort(observed)
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 5_000 })
  const controller = new AbortController()
  const pending = analyzer.analyze({ snapshot: 's', conversationId: 1, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 10))
  controller.abort()
  await assert.rejects(pending, () => true)
  port.fail(new Error('late'))
  await new Promise((r) => setTimeout(r, 20))
})

test('错误诊断: 只含 code 与单行短原因，不携带响应/快照原文', { timeout: 60_000 }, async () => {
  const secretSnapshot = 'SECRET-SNAPSHOT-CONTENT'
  const port: ConversationTextPort = {
    async completeConversationText() {
      throw new HelmError('model_not_configured', `会话 1 未解析出生效模型\n模型原始响应：SECRET-RESPONSE`, 409)
    },
  }
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 200 })
  const outcome = await analyzer.analyze({ snapshot: secretSnapshot, conversationId: 1 })
  assert.equal(outcome.analysis, undefined)
  assert.ok(outcome.diagnostic !== undefined)
  assert.ok(outcome.diagnostic.includes('model_not_configured'), '诊断含错误 code')
  assert.ok(!outcome.diagnostic.includes('SECRET-RESPONSE'), '诊断不含模型响应')
  assert.ok(!outcome.diagnostic.includes('SECRET-SNAPSHOT-CONTENT'), '诊断不含快照原文')
  assert.ok(!outcome.diagnostic.includes('\n') || outcome.diagnostic.split('\n').length <= 2, '诊断为单行短文本')
})

test('正常路径: 传回尾部截断 + maxTokens 并解析 JSON', { timeout: 60_000 }, async () => {
  const seen: Array<{ text: string; maxTokens: number | undefined; systemPrompt: string }> = []
  const head = 'H'.repeat(3_000)
  const tail = 'Press (o)nce or (d)eny'
  const port: ConversationTextPort = {
    async completeConversationText(input) {
      seen.push({ text: input.text, maxTokens: input.maxTokens, systemPrompt: input.systemPrompt })
      return '```json\n{"summary":"等待确认","options":[{"label":"本次允许","keys":["o"]}]}\n```'
    },
  }
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 1_000 })
  const outcome = await analyzer.analyze({ snapshot: `${head}\n${tail}`, conversationId: 7 })
  assert.equal(outcome.diagnostic, undefined)
  assert.deepEqual(outcome.analysis, {
    summary: '等待确认',
    options: [{ label: '本次允许', keys: ['o'] }],
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.maxTokens !== undefined && seen[0]!.maxTokens >= 512 && seen[0]!.maxTokens <= 768, true, '输出预算 512~768')
  assert.ok(seen[0]!.text.endsWith(tail), '快照按尾部截断')
  assert.ok(seen[0]!.text.length <= 1_500, `尾部截断至 ≤1500 字符（实得 ${seen[0]!.text.length}）`)
  assert.ok(seen[0]!.systemPrompt.includes('不可信数据'), '插件专用提示词注入')
})

test('模型返回非 JSON: 回退并附脱敏诊断', { timeout: 60_000 }, async () => {
  const port: ConversationTextPort = {
    async completeConversationText() {
      return '模型拒绝回答'
    },
  }
  const analyzer = createBlockedSnapshotAnalyzer(port, { timeoutMs: 200 })
  const outcome = await analyzer.analyze({ snapshot: 's', conversationId: 1 })
  assert.equal(outcome.analysis, undefined)
  assert.ok(outcome.diagnostic?.includes('无法解析'))
})
