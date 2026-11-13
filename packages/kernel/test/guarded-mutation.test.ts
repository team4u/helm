/**
 * 内核 guarded mutation（自动化 human 红线）确定性竞态测试。
 *
 * 背景：watchdog 插件层检查归属后，旧链路调用普通 abortConversation /
 * submitInput——内核内部先 `await harness.conversation(...)` 才产生副作用，
 * 该 await 让出期间 markOwnership 翻转为 human 仍会执行动作（TOCTOU）。
 *
 * 验证方式（deferred barrier，确定性而非轮询）：
 * - 用 barrier 精确挂在 harness.conversation 的 await 窗口上，在窗口内把
 *   ownership 翻转为 human，再放行；
 * - 对照组证明同一 barrier 落在旧实现（普通 abortConversation）的窗口内且
 *   旧语义确实仍会中止（测试不是空转）；
 * - guarded API（abortConversationGuarded / submitInputGuarded）在完全相同
 *   的时序下必须拒绝（409 ownership_conflict）且底层 SDK 动作未被发起；
 * - 同时覆盖成功路径、stateSeq 过期 409、归属不匹配 409、目标缺失 404、
 *   非法 guard 400，以及普通人类 API（submitInput / abortConversation）
 *   在 human 归属下行为不变。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { waitFor } from './helpers.js'
import { KernelRuntime } from '../src/runtime/index.js'

type RuntimeWithFaux = KernelRuntime & { __faux: ReturnType<typeof fauxProvider> }

async function openRuntime(dir: string): Promise<RuntimeWithFaux> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(kernel, { __faux: faux })
}

type ConversationFn = (id: never, ctx: unknown) => Promise<unknown>

/**
 * 在 harness.conversation 的 await 点挂确定性 barrier：安装后下一次（及后续）
 * conversation() 调用都停在 gate 上，直到 release；释放后透传真实句柄。
 * 旧实现（普通 abort/submit）在该 await 之后无条件执行动作——barrier 期间
 * 翻转 ownership 即命中旧竞态窗口。
 */
function barrierConversationHandle(kernel: KernelRuntime): { release: () => void } {
  const harness = (kernel as unknown as { harness: { conversation: ConversationFn } }).harness
  const real = harness.conversation.bind(harness) as ConversationFn
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  harness.conversation = ((id: never, ctx: unknown) =>
    new Promise((resolve, reject) => {
      void gate.then(
        () => {
          void real(id, ctx).then(resolve, reject)
        },
        reject,
      )
    })) as ConversationFn
  return { release }
}

/** 微任务冲刷：让被测 Promise 前进到 harness.conversation 的挂起点。 */
async function flushToBarrier(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function isHelmError(code: string, status: number) {
  return (err: unknown): boolean => err instanceof HelmError && err.code === code && err.status === status
}

let root: string

test.before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-guarded-'))
})

test.after(async () => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 竞态核心：await 窗口内归属翻转
// ---------------------------------------------------------------------------

test('guarded abort：await 窗口内翻转 human → 409 ownership_conflict，SDK abort 未发起', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('不该需要第二答'),
    ])
    void kernel.submitInput(1, '会被守卫拒绝中止的问题').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await flushToBarrier()
    // 旧实现的 await 窗口内：人类接管。
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmError('ownership_conflict', 409))

    // SDK abort 未被发起：在途回合继续存活（若被中止则立即结算为 idle）。
    assert.equal(kernel.getConversation(1).status, 'working', 'guarded 拒绝后回合不得被中止')

    // 普通人类 API 不回归：human 归属下人工 abort 照常生效。
    await kernel.abortConversation(1)
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
    assert.equal(kernel.getConversation(1).completionSeq, 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('对照组：同一 barrier 命中旧窗口，普通 abortConversation 在 human 翻转后仍会中止（旧语义保留）', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-abort-window')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('不该需要第二答'),
    ])
    void kernel.submitInput(1, '证明 barrier 落在旧窗口内').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversation(1)
    await flushToBarrier()
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    // 普通 API 无守卫：翻转后照常中止（这正是 guarded API 要关闭的窗口）。
    await attempt
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded submit：准备工作窗口内翻转 human → 409，零提交副作用（无标题派生/无输入条目）', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('不该出现')])

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.submitInputGuarded(conv.id, '自动化输入', { origin: 'agent' }, { expectedOwnership: 'bot' })
    await flushToBarrier()
    kernel.markConversationOwnership(conv.id, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmError('ownership_conflict', 409))

    // 零提交副作用：标题未派生、无 helm.input 条目、会话仍空闲。
    const after = kernel.getConversation(conv.id)
    assert.equal(after.status, 'idle')
    assert.equal(after.title, '')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    assert.equal(detail.entries.filter((e) => e.kind === 'helm.input').length, 0, '不得产生输入条目')
    // faux 响应未被消费（模型从未被调用）。
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 2. 成功路径与确定性拒绝
// ---------------------------------------------------------------------------

test('guarded steer whenIdle=reject：空闲会话原子拒绝，不启动新回合或落入输入条目', { timeout: 60_000 }, async () => {
  const kernel = await openRuntime(join(root, 't-guarded-steer-idle'))
  try {
    const conversation = await kernel.createConversation({ title: '空闲自动化会话' })
    kernel.markConversationOwnership(conversation.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('不应执行')])
    await assert.rejects(
      kernel.submitInputGuarded(conversation.id, '仅纠偏在途任务', {
        origin: 'agent', whenBusy: 'steer', whenIdle: 'reject',
      }, { expectedOwnership: 'bot', expectedStateSeq: kernel.getConversation(conversation.id).stateChangeSeq }),
      isHelmError('conversation_idle', 409),
    )
    const detail = await kernel.getConversationDetail(conversation.id)
    assert.equal(detail.entries.filter((entry) => entry.kind === 'helm.input').length, 0)
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
    assert.equal(kernel.getConversation(conversation.id).status, 'idle')
  } finally {
    await kernel.close()
  }
})

test('guarded abort 成功路径：bot 会话在途回合按授权中止', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-ok')
  const kernel = await openRuntime(dir)
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
    ])
    void kernel.submitInput(1, '会被授权中止的问题').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    await kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await kernel.waitForIdle(1).catch(() => {})
    const conv = kernel.getConversation(1)
    assert.equal(conv.status, 'idle')
    assert.equal(conv.completionSeq, 1, 'aborted 恰结算一次')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit 成功路径：bot 会话 agent 来源提交真实入列并完成回合', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-ok')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('恢复完成')])
    const { submissionId } = await kernel.submitInputGuarded(conv.id, '恢复提示', { origin: 'agent', whenBusy: 'steer' }, { expectedOwnership: 'bot' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(kernel.getConversation(conv.id).status, 'done')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 10 })
    const input = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(input, 'helm.input 条目应存在')
    assert.equal(kernel.__faux.getPendingResponseCount(), 0)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded 拒绝矩阵：human 归属 / 归属不匹配 / 水位过期 / 目标缺失 / 非法 guard', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reject-matrix')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'human')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, {}),
      isHelmError('ownership_conflict', 409),
      'human 硬红线',
    )
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, {}),
      isHelmError('ownership_conflict', 409),
      'human 硬红线（提交）',
    )

    kernel.markConversationOwnership(conv.id, 'helm')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'bot' }),
      isHelmError('ownership_conflict', 409),
      '归属精确不匹配',
    )

    const seq = kernel.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: seq + 100 }),
      isHelmError('state_seq_conflict', 409),
      '水位过期 CAS',
    )

    await assert.rejects(
      kernel.abortConversationGuarded(999_999, {}),
      isHelmError('not_found', 404),
      '显式目标缺失不被默认路由掩盖',
    )
    await assert.rejects(
      kernel.submitInputGuarded(999_999, 'x', { origin: 'agent' }, {}),
      isHelmError('not_found', 404),
    )

    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'human' as never }),
      isHelmError('validation_error', 400),
      'expectedOwnership 严禁 human',
    )
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: -1 }),
      isHelmError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit 不支持 replaceFromEntryId（自动化不重写历史）', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-no-rewrite')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent', replaceFromEntryId: 1 }, {}),
      isHelmError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 3. 普通人类 API 不回归
// ---------------------------------------------------------------------------

test('普通 API 语义不变：human 归属下 submitInput / abortConversation 照常可用', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-api-regression')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    // 未标记归属（默认 human）。
kernel.__faux.setResponses([fauxAssistantMessage('人类回答')])
    const { submissionId } = await kernel.submitInput(conv.id, '人类问题', { origin: 'human' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(await kernel.getLastAssistantText(conv.id), '人类回答')
    // 空闲会话人工 abort：no-op 不伪造终态，也不抛守卫错误。
    await kernel.abortConversation(conv.id)
    assert.equal(kernel.getConversation(conv.id).completionSeq, 1)
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. per-conversation 串行门：同会话 guarded 变更有序、不同会话互不阻塞
// ---------------------------------------------------------------------------

test('guarded 变更串行门：同会话排队有序执行；前序失败不阻断后续', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-gate')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('第一答'), fauxAssistantMessage('第二答')])

    // 前序 guarded 提交失败（水位过期 400/409）不得毒化串行门。
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, { expectedStateSeq: 1_000_000 }),
      isHelmError('state_seq_conflict', 409),
    )
    const first = await kernel.submitInputGuarded(conv.id, '第一条', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    const second = await kernel.submitInputGuarded(conv.id, '第二条', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    assert.ok(first.submissionId)
    assert.ok(second.submissionId)
    await kernel.waitForIdle(conv.id)
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    const inputs = detail.entries.filter((e) => e.kind === 'helm.input')
    assert.equal(inputs.length, 2, '两条 guarded 输入都应入列')
  } finally {
    await kernel.close().catch(() => {})
  }
})
