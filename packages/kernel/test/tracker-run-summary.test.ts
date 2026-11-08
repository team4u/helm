/**
 * ConversationTracker run 活跃期间实时摘要推送回归。
 *
 * 缺陷背景（本文件锁定修复）：
 * - 旧实现 adopt() 更新 liveViews 后不推 onSummaryChanged；只有 emitSettled 与
 *   setPendingAskCount 推 summary。首字前（run 已启动、尚无任何 token/工具）
 *   状态机长时间停留旧值，发送后长期空闲且无提示。
 *
 * 现契约（emitRunSummary）：
 * 1. run 启动（快照首次出现 live.run）：推送 working 摘要（doing='thinking…'）；
 * 2. doing 语义变化（工具开始/结束）推送新摘要；纯流式 token 推进（doing 不变）
 *    不推送——按语义指纹（status|doing|pendingAsk）去重，不逐 token 发帧；
 * 3. 终态（completed/failed/aborted）仍由 emitSettled 恰一次负责；adopt 不重复
 *    结算、不回退终态；同快照 run1 结束 + run2 开始折叠时顺序正确；
 * 4. blocked（pendingAsk>0 覆盖 working）不被 emitRunSummary 回退为 working；
 * 5. stateChangeSeq 随真实状态变化单调推进（协议契约），空闲快照不推进。
 *
 * 经真实 KernelRuntime（faux provider + 真实 SQLite + 真实观察者链路）驱动，
 * 事件经 kernel.events 订阅收集（与 SSE 同一出口）。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface RecordedUpsert {
  status: ConversationSummary['status']
  doing: string | undefined
  seq: number
  at: number
}

let root = ''

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-run-summary-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

async function openRuntime(name: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const runtime = await KernelRuntime.open({
    dataDir: join(root, name),
    cwd: join(root, name),
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** 订阅 kernel.events（SSE 同源出口），收集指定会话的 upsert 摘要时间线。 */
function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: RecordedUpsert[]
  stop: () => void
} {
  const frames: RecordedUpsert[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id !== conversationId) return
    frames.push({
      status: conversation.status,
      doing: conversation.doing,
      seq: conversation.stateChangeSeq,
      at: frame.seq,
    })
  })
  return { frames, stop: unsubscribe }
}

/** 轮询等待条件成立（防挂死，总超时显式）。 */
async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('emitRunSummary：run 启动与 doing 语义变化的实时摘要', { timeout: 60_000 }, () => {
  it('首字前 run 启动即推送 working（doing=thinking…）；终态 completed 恰一次', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-start')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    try {
      // 保持首字未返回，避免用固定延时猜测模型与观察者的调度顺序。
      kernel.__faux.setResponses([
        async () => {
          await responseGate
          return fauxAssistantMessage('回答一')
        },
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        const before = kernel.getConversation(1).stateChangeSeq
        const submitP = kernel.submitInput(1, '首字前的问题')
        await waitFor(() => recorded.frames.some((f) => f.status === 'working'))
        assert.equal(kernel.getConversation(1).status, 'working', 'run 启动后状态机应已 working')
        const workingBeforeFirstToken = recorded.frames.filter((f) => f.status === 'working')
        assert.ok(
          workingBeforeFirstToken.length >= 1,
          `首字前应至少推送一次 working 摘要，实际：${JSON.stringify(recorded.frames)}`,
        )
        assert.equal(workingBeforeFirstToken[0]!.doing, 'thinking…')
        releaseResponse()
        await submitP
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        // completed 终态恰一次：done 帧不因后续空闲快照重复。
        const doneFrames = recorded.frames.filter((f) => f.status === 'done')
        assert.equal(doneFrames.length, 1, `completed 终态恰一次，实际：${JSON.stringify(recorded.frames)}`)
        // stateChangeSeq 全程单调推进。
        const seqs = recorded.frames.map((f) => f.seq)
        for (let i = 1; i < seqs.length; i += 1) {
          assert.ok(seqs[i]! > seqs[i - 1]!, `stateChangeSeq 单调：${JSON.stringify(seqs)}`)
        }
        assert.ok(seqs[0]! > before, 'run 启动摘要推进 stateChangeSeq')
      } finally {
        recorded.stop()
      }
    } finally {
      releaseResponse()
      await kernel.close()
    }
  })

  it('doing 变化去重：thinking -> 工具 running -> 工具 done 各恰一次，流式 token 不额外发帧', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('doing-dedup')
    try {
      // 长文本流式回答：faux tokensPerSecond 默认拆分多 token，doing 始终 thinking…。
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('一二三四五六七八九十一二三四五六七八九十'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, '触发工具轮')
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        const workings = recorded.frames.filter((f) => f.status === 'working')
        const doings = workings.map((f) => f.doing ?? '')
        // 同一 doing 语义绝不连续重复推送（流式 token 推进、同状态快照重复都不重发）。
        for (let i = 1; i < doings.length; i += 1) {
          assert.ok(
            doings[i] !== doings[i - 1],
            `同一 doing 语义连续重复推送：${JSON.stringify(workings)}`,
          )
        }
        assert.ok(doings.includes('thinking…'), `run 启动 doing 应含 thinking…：${JSON.stringify(doings)}`)
        assert.ok(
          doings.some((d) => d.startsWith('bash:')),
          `工具轮 doing 应含 bash:…：${JSON.stringify(doings)}`,
        )
        // 流式 token 不额外发帧：thinking… 帧数恰为 run 启动次数（两 run 各一）。
        // 第二个 run 的长文本流式（20 字逐 token）期间 doing 恒 thinking…，
        // 不得因 token 推进重复推送。
        const thinkingCount = doings.filter((d) => d === 'thinking…').length
        assert.equal(thinkingCount, 2, `thinking… 恰两帧（两 run 启动各一）：${JSON.stringify(workings)}`)
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('followUp 连续回合的 working 与 completed 更新最终收敛，不残留运行态', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-switch')
    try {
      // followUp 排队：run1（工具轮）在途时提交第二条，SDK 在 run1 结束后立即
      // 消费 run2（观察者可能以同快照看到 run1 消失 + run2 出现的折叠形态）。
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('run1 回答'),
        fauxAssistantMessage('run2 回答'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'run1 问题')
        await new Promise((r) => setTimeout(r, 200))
        assert.equal(kernel.getConversation(1).status, 'working')
        void kernel.submitInput(1, 'run2 排队问题', { whenBusy: 'followUp' }).catch(() => {})
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.filter((f) => f.status === 'done').length >= 1)
        // 事件顺序合法：任何 working 帧之后允许 done；done 之后新一轮 working
        // 属于 run2（followUp 消费）——但最终态必须收敛为 done（run2 也完成）。
        await new Promise((r) => setTimeout(r, 400))
        const last = recorded.frames[recorded.frames.length - 1]!
        assert.equal(
          kernel.getConversation(1).status,
          'done',
          `两 run 全部结束后终态 done，实际 ${kernel.getConversation(1).status}`,
        )
        assert.ok(
          ['done', 'idle'].includes(last.status),
          `最终帧应为终态，实际：${JSON.stringify(last)}`,
        )
        // 不存在「终态后回退 working 且再无终态」的悬挂：working 帧之后的最终帧必为终态。
        const lastWorking = recorded.frames.map((f) => f.status).lastIndexOf('working')
        assert.ok(
          recorded.frames.slice(lastWorking + 1).some((f) => f.status === 'done' || f.status === 'idle'),
          `最后一次 working 后必须再次到达终态：${JSON.stringify(recorded.frames)}`,
        )
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('failed / aborted 终态：emitSettled 恰一次，adopt 不重复结算', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('failed-aborted')
    try {
      // failed：faux 报 model error。
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, '会失败的问题').catch(() => {})
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded.frames.some((f) => f.status === 'error'))
        const errorFrames = recorded.frames.filter((f) => f.status === 'error')
        assert.equal(errorFrames.length, 1, `failed 终态恰一次：${JSON.stringify(recorded.frames)}`)
        // 空闲快照不再推送（无复活）。
        const frozen = recorded.frames.length
        await new Promise((r) => setTimeout(r, 250))
        assert.equal(recorded.frames.length, frozen, '失败终态后空闲快照不重复推送')
      } finally {
        recorded.stop()
      }

      // aborted：工具长回合在途显式 abort。
      const recorded2 = recordUpserts(kernel, 1)
      try {
        kernel.__faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
            stopReason: 'toolUse',
          }),
        ])
        void kernel.submitInput(1, '会被中止的问题').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        await kernel.abortConversation(1)
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded2.frames.some((f) => f.status === 'idle'))
        // aborted 终态为 idle；working 帧存在（run 启动推送）且恰收敛一次 idle。
        assert.ok(
          recorded2.frames.some((f) => f.status === 'working'),
          `abort 前应有 working 摘要：${JSON.stringify(recorded2.frames)}`,
        )
        const idleAfterAbort = recorded2.frames.filter((f) => f.status === 'idle')
        assert.equal(idleAfterAbort.length, 1, `aborted 终态恰一次：${JSON.stringify(recorded2.frames)}`)
      } finally {
        recorded2.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('blocked 覆盖 working：pendingAsk 摘要不被 emitRunSummary 回退', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('blocked-no-regress')
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 3' })], { stopReason: 'toolUse' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        void kernel.submitInput(1, '触发审批的问题').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        // 工具在途时创建 pending Ask：setPendingAskCount 推 blocked。
        const askPromise = kernel.createAsk({
          conversationId: 1,
          title: '测试审批',
          fields: [{ name: 'confirm', label: '确认', type: 'confirm' }],
        })
        void askPromise.catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'blocked')
        // 工具继续在途（sleep 3s）：期间快照推进多次，blocked 不得被回退 working。
        await new Promise((r) => setTimeout(r, 800))
        assert.equal(
          kernel.getConversation(1).status,
          'blocked',
          'pendingAsk 存在时后续快照不得回退为 working',
        )
        const blockedFrames = recorded.frames.filter((f) => f.status === 'blocked')
        assert.ok(blockedFrames.length >= 1, 'blocked 摘要已推送')
        // blocked 之后的帧不允许再出现 working（run 仍在途也不回退）。
        const afterBlocked = recorded.frames.slice(recorded.frames.findIndex((f) => f.status === 'blocked'))
        assert.ok(
          !afterBlocked.some((f) => f.status === 'working'),
          `blocked 之后不得回退 working：${JSON.stringify(recorded.frames)}`,
        )
        // 清理：回答 Ask 并中止在途 run。
        const pending = kernel.listAsks('pending')
        if (pending.length > 0) await kernel.answerAsk(pending[0]!.id, { confirm: 'true' }).catch(() => {})
        await kernel.abortConversation(1).catch(() => {})
        await kernel.waitForIdle(1).catch(() => {})
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })
})
