/**
 * 会话上下文用量（contextUsage）端到端契约：
 *
 * 1. 纯函数 estimateContextUsage 与 pi-durable `estimateContext(view, [])` 语义
 *    对齐：实测锚点（head 之后最近一条 usage>0 的 assistant）+ 尾段估算；锚点
 *    失效（无 usage / 越过 head / 被 omit 覆盖）退化为当前有效消息全量估算；
 * 2. 组装与透传：compacting / compactionError 按真实 pi.live 结构子集透传，
 *    未知 trigger 不伪造；错误经注入 redact 脱敏并截断；
 * 3. 集成（真实 KernelRuntime + faux provider + SQLite）：回合结算后摘要携带
 *    contextUsage（tokens === measuredTokens：单回合锚点后无尾段）；usage-only
 *    变化发布 conversation.upsert 但不推进 stateChangeSeq；reset 后归零；
 *    手动压缩（空闲会话）期间 compacting 透传可达（不经会被 queuedEmpty 短路
 *    的 live 帧），压缩完成后 tokens 下降且 pi.compaction 条目落地。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextView } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ProviderConfig } from '@helm/protocol'
import {
  assembleContextUsage,
  compactionErrorOf,
  compactingOf,
  contextUsageKeyOf,
  estimateContextUsage,
} from '../src/runtime/context-usage.js'
import { buildModels } from '../src/runtime/models.js'
import { EventHub } from '../src/runtime/events.js'
import { KernelRuntime } from '../src/runtime/index.js'

// ---------------------------------------------------------------------------
// 构造工具：纯函数测试的 ContextView / Message 形状
// ---------------------------------------------------------------------------

function userMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1 }
}

function assistantMessage(usage: { input: number; output: number }, text = '回答'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'faux-1',
    usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 2,
  }
}

interface ViewSpec {
  headId?: number
  /** [entryId, contribution messages]（omit 用空数组表示）。 */
  entries: Array<[number, Message[]]>
}

function viewOf(spec: ViewSpec): ContextView {
  const head = spec.headId !== undefined ? ({ id: spec.headId, kind: 'pi.compaction' } as never) : undefined
  // 真实 ContextView 语义：entries = [head 标记] + head.head 之后的非 head 条目；
  // messages 只由这些条目的 contributions 组成（head 之前的旧条目不在内）。
  const active = spec.headId === undefined ? spec.entries : spec.entries.filter(([id]) => id > spec.headId!)
  const entries = spec.entries.map(([id]) => ({ id, kind: 'pi.assistant' } as never))
  const contributions = spec.entries.map(([, messages]) => messages)
  const messages = active.flatMap(([, msgs]) => msgs)
  return { head, entries, contributions, messages } as unknown as ContextView
}

describe('estimateContextUsage：与 pi-durable estimateContext 语义对齐', { timeout: 60_000 }, () => {
  it('实测锚点：head 之后最近一条 usage>0 assistant 的 usage + 其后消息估算', { timeout: 60_000 }, () => {
    const anchor = assistantMessage({ input: 1_000, output: 50 })
    const trailingUser = userMessage('尾段问题')
    const view = viewOf({
      headId: 10,
      entries: [
        [11, [anchor]],
        [12, [trailingUser]],
      ],
    })
    const result = estimateContextUsage(view)
    assert.equal(result.measuredTokens, calculateContextTokens(anchor.usage))
    assert.equal(result.tokens, calculateContextTokens(anchor.usage) + estimateMessageTokens(trailingUser))
  })

  it('无实测锚点：全量估算，measuredTokens 省略', { timeout: 60_000 }, () => {
    const user = userMessage('只有用户消息的问题')
    const anchorless = { ...assistantMessage({ input: 0, output: 0 }) }
    const view = viewOf({ entries: [[11, [user]], [12, [anchorless]]] })
    const result = estimateContextUsage(view)
    assert.equal(result.measuredTokens, undefined)
    assert.equal(result.tokens, estimateMessageTokens(user) + estimateMessageTokens(anchorless))
  })

  it('越过 head 的旧 assistant 不作锚点（compaction/reset 后失效）', { timeout: 60_000 }, () => {
    const stale = assistantMessage({ input: 9_000, output: 10 })
    const freshUser = userMessage('新上下文的输入')
    const view = viewOf({
      headId: 10,
      entries: [
        [9, [stale]],
        [11, [freshUser]],
      ],
    })
    const result = estimateContextUsage(view)
    assert.equal(result.measuredTokens, undefined)
    assert.equal(result.tokens, estimateMessageTokens(freshUser))
  })

  it('helm.rewind omit（空 contribution）条目被跳过，不阻断也不复活旧锚点', { timeout: 60_000 }, () => {
    const beforeRewind = assistantMessage({ input: 5_000, output: 10 })
    const newUser = userMessage('重发后的新输入')
    const view = viewOf({
      entries: [
        [8, [beforeRewind]],
        [9, []], // rewind 覆盖区间内的旧条目（omit）
        [10, []],
        [11, [newUser]],
      ],
    })
    // omit 之前（id 更小）的 anchor 描述的前缀未被动过，仍然有效。
    const result = estimateContextUsage(view)
    assert.equal(result.measuredTokens, calculateContextTokens(beforeRewind.usage))
    assert.equal(
      result.tokens,
      calculateContextTokens(beforeRewind.usage) + estimateMessageTokens(newUser),
    )
  })

  it('多条实测 assistant：取最新一条（尾向扫描第一个命中）', { timeout: 60_000 }, () => {
    const older = assistantMessage({ input: 2_000, output: 10 })
    const newer = assistantMessage({ input: 3_000, output: 20 })
    const view = viewOf({
      entries: [
        [11, [older]],
        [12, [newer]],
      ],
    })
    const result = estimateContextUsage(view)
    assert.equal(result.measuredTokens, calculateContextTokens(newer.usage))
    assert.equal(result.tokens, calculateContextTokens(newer.usage))
  })
})

describe('contextUsage 组装与透传（真实 pi.live 结构子集）', { timeout: 60_000 }, () => {
  it('compactingOf：多项取最新；未知 trigger 省略不伪造', { timeout: 60_000 }, () => {
    assert.deepEqual(compactingOf(undefined), undefined)
    assert.deepEqual(compactingOf([]), undefined)
    assert.deepEqual(
      compactingOf([
        { taskId: 1, trigger: 'threshold', blocking: true },
        { taskId: 2, trigger: 'manual', blocking: false },
      ]),
      { trigger: 'manual', blocking: false },
    )
    assert.deepEqual(compactingOf([{ taskId: 3, trigger: 'unknown-future', blocking: false }]), undefined)
  })

  it('compactionErrorOf：redact 注入 + 400 字符截断 + 空串省略', { timeout: 60_000 }, () => {
    assert.equal(compactionErrorOf(undefined, (t) => t), undefined)
    assert.equal(compactionErrorOf({ taskId: 1, trigger: 'manual', error: '' }, (t) => t), undefined)
    assert.equal(
      compactionErrorOf({ taskId: 1, trigger: 'manual', error: 'sk-abc 泄漏' }, (t) => t.replace('sk-abc', '***')),
      '*** 泄漏',
    )
    const long = 'x'.repeat(500)
    assert.equal(compactionErrorOf({ taskId: 1, trigger: 'manual', error: long }, (t) => t)?.length, 400)
  })

  it('assembleContextUsage：可缺字段省略；指纹区分全部承载字段', { timeout: 60_000 }, () => {
    const base = assembleContextUsage({ estimate: { tokens: 100 } })
    assert.deepEqual(base, { tokens: 100 })
    const full = assembleContextUsage({
      estimate: { tokens: 100, measuredTokens: 90 },
      contextWindow: 1_000,
      thresholds: { blockingTokens: 900, backgroundTokens: 800 },
      compacting: { trigger: 'manual', blocking: false },
      compactionError: 'boom',
    })
    assert.deepEqual(full, {
      tokens: 100,
      measuredTokens: 90,
      contextWindow: 1_000,
      thresholds: { blockingTokens: 900, backgroundTokens: 800 },
      compacting: { trigger: 'manual', blocking: false },
      compactionError: 'boom',
    })
    const variants = [
      full,
      { ...full, tokens: 101 },
      { ...full, measuredTokens: undefined },
      { ...full, contextWindow: undefined },
      { ...full, compacting: { trigger: 'overflow' as const, blocking: false } },
      { ...full, compactionError: undefined },
    ]
    const keys = new Set(variants.map((v) => contextUsageKeyOf(v)))
    assert.equal(keys.size, variants.length, '任一承载字段变化必须产生新指纹')
    assert.equal(contextUsageKeyOf(undefined), '')
  })
})

describe('事件边界：conversation.upsert 携带 contextUsage 的形状校验', { timeout: 60_000 }, () => {
  function hubOf(): EventHub {
    return new EventHub({
      initialSeq: 0,
      snapshot: () => ({
        seq: 0,
        conversations: [],
        pendingAsks: [],
        plugins: [],
        ui: [],
        pluginDocs: [],
        conversationLives: [],
        nodes: [],
      }),
    })
  }

  const baseSummary = {
    id: 1,
    title: '会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  it('合法 contextUsage 通过；非法形状（tokens 非数字/trigger 未知）拒绝', { timeout: 60_000 }, () => {
    const hub = hubOf()
    hub.publish('conversation.upsert', {
      conversation: {
        ...baseSummary,
        contextUsage: assembleContextUsage({
          estimate: { tokens: 12_345, measuredTokens: 10_000 },
          contextWindow: 128_000,
          thresholds: { blockingTokens: 111_616, backgroundTokens: 78_848 },
          compacting: { trigger: 'manual', blocking: false },
          compactionError: '上次失败',
        }),
      },
    })
    assert.equal(hub.seq, 1)
    assert.throws(
      () =>
        hub.publish('conversation.upsert', {
          conversation: { ...baseSummary, contextUsage: { tokens: '12345' } },
        }),
      (error: unknown) => error instanceof HelmError,
    )
    assert.throws(
      () =>
        hub.publish('conversation.upsert', {
          conversation: {
            ...baseSummary,
            contextUsage: { tokens: 1, compacting: { trigger: 'unknown', blocking: false } },
          },
        }),
      (error: unknown) => error instanceof HelmError,
    )
    // 拒绝不推进 seq（水位线无裸缺口）。
    assert.equal(hub.seq, 1)
  })
})

// ---------------------------------------------------------------------------
// 集成：真实 KernelRuntime（faux provider + SQLite + 观察者链路）
// ---------------------------------------------------------------------------

type FauxHandle = ReturnType<typeof fauxProvider>

let root = ''

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-context-usage-'))
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

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: ConversationSummary[]
  stop: () => void
} {
  const frames: ConversationSummary[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id === conversationId) frames.push(conversation)
  })
  return { frames, stop: unsubscribe }
}

describe('集成：摘要携带 contextUsage 与事件发布', { timeout: 60_000 }, () => {
  it('重启后 idle 历史会话：首个详情即携带 contextUsage（实测锚点可恢复）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('idle-detail')
    kernel.__faux.setResponses([fauxAssistantMessage('历史回答')])
    await kernel.submitInput(1, '历史问题')
    await kernel.waitForIdle(1)
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
    await kernel.close()

    // 重启：恢复链 observe idle 会话；首个详情（不经任何列表读/等待）必须
    // 已携带 usage（getConversationDetail 在缓存缺失时等初始刷新完成）。
    const reopened = await openRuntime('idle-detail')
    try {
      const detail = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.contextUsage, '重启后首个详情必须携带 contextUsage')
      assert.ok(
        detail.contextUsage.measuredTokens !== undefined && detail.contextUsage.measuredTokens > 0,
        '历史实测锚点（faux 真实 usage）恢复后仍可用',
      )
      assert.ok(detail.contextUsage.tokens > 0)
      // 后续分页不重复刷新（缓存直通）：仍携带且值稳定。
      const page2 = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(page2.contextUsage)
      assert.equal(page2.contextUsage.tokens, detail.contextUsage.tokens)
    } finally {
      await reopened.close()
    }
  })

  it('compat 网关静态模型：tokens 携带但 contextWindow/thresholds 省略（不伪造）', { timeout: 60_000 }, async () => {
    const compatConfig: ProviderConfig = {
      id: 'gw-static',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9',
      models: ['static-model'],
      label: '静态网关',
      enabled: true,
    }
    const kernel = await KernelRuntime.open({
      dataDir: join(root, 'compat-window'),
      cwd: join(root, 'compat-window'),
      model: 'gw-static/static-model',
      models: buildModels({ providers: [compatConfig], apiKeys: () => ({}) }),
    })
    try {
      const detail = await kernel.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.contextUsage, '用量估算（tokens）仍提供')
      assert.equal(detail.contextUsage.contextWindow, undefined, '静态缺省窗口不得显示为已知窗口')
      assert.equal(detail.contextUsage.thresholds, undefined, '窗口未知时不推导阈值')
      assert.equal(detail.model, 'gw-static/static-model')
    } finally {
      await kernel.close()
    }
  })

  it('回合结算后 tokens=measuredTokens；usage-only 变化不推进 stateChangeSeq', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('settle-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('回答一')])
      const recorded = recordUpserts(kernel, 1)
      await kernel.submitInput(1, '第一个问题')
      await kernel.waitForIdle(1)
      // 刷新是结算后的异步动作：等待实测值（初始缓存可能先以空上下文填充）。
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && (usage.measuredTokens ?? 0) > 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, '回合结算后摘要必须携带 contextUsage')
      // 单回合：锚点（最终 assistant usage）之后无尾段消息，tokens 全为实测。
      assert.ok(usage.measuredTokens !== undefined && usage.measuredTokens > 0, 'faux 注入真实 usage，实测锚点必须存在')
      assert.equal(usage.tokens, usage.measuredTokens)
      // faux 模型窗口 128k 已知：窗口与阈值按 SDK 默认策略给出，不伪造。
      assert.equal(usage.contextWindow, 128_000)
      assert.equal(usage.thresholds?.blockingTokens, 128_000 - 16_384)
      assert.equal(usage.thresholds?.backgroundTokens, 128_000 - 16_384 - 32_768)
      assert.equal(usage.compacting, undefined)
      assert.equal(usage.compactionError, undefined)
      // usage-only 帧：stateChangeSeq 与结算帧一致（不污染 CAS 水位线）。
      const withUsage = recorded.frames.filter((f) => f.contextUsage !== undefined)
      assert.ok(withUsage.length >= 1, '必须发布携带 contextUsage 的 conversation.upsert')
      const settled = recorded.frames.find((f) => f.status === 'done' || f.status === 'idle')
      assert.ok(settled, '必须先有终态摘要帧')
      assert.equal(withUsage[withUsage.length - 1]!.stateChangeSeq, settled.stateChangeSeq)
      recorded.stop()
    } finally {
      await kernel.close()
    }
  })

  it('reset 后上下文归零（tokens=0，无实测锚点）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('reset-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('回答')])
      await kernel.submitInput(1, '问题')
      await kernel.waitForIdle(1)
      await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
      await kernel.resetConversation(1)
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.tokens === 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, '归零后的 contextUsage 必须可读')
      assert.equal(usage.measuredTokens, undefined, '空上下文无实测锚点，不得残留旧值')
    } finally {
      await kernel.close()
    }
  })

  it('空闲会话手动压缩：compacting 透传可达（不被空闲 live 短路），完成后 tokens 下降', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('manual-compact')
    // 构造超过 keepRecentTokens(20000) 的上下文，使 selectCut 有可压缩前缀。
    const bigInput = '大规模上下文素材。'.repeat(5_000) // 10 chars × 5000 = 50000 字符/条
    kernel.__faux.setResponses([
      fauxAssistantMessage('答一'),
      fauxAssistantMessage('答二'),
      fauxAssistantMessage('答三'),
    ])
    for (const text of [`${bigInput}一`, `${bigInput}二`, `${bigInput}三`]) {
      await kernel.submitInput(1, text)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
    const beforeCompact = kernel.getConversation(1).contextUsage!.tokens
    assert.ok(beforeCompact > 30_000, '压缩前上下文必须足够大（实际不够时应加大素材）')

    // 压缩摘要请求用门闩挂住：稳定观测 compacting 透传（空闲会话无 live 帧）。
    let releaseSummary = () => {}
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
    kernel.__faux.setResponses([async () => {
      await summaryGate
      return fauxAssistantMessage('历史已精简为该摘要')
    }])
    const recorded = recordUpserts(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => {
        const compacting = kernel.getConversation(1).contextUsage?.compacting
        return compacting !== undefined && compacting.trigger === 'manual' && compacting.blocking === false
      }, 20_000)
      // 透传同样到达事件流（conversation.upsert 携带 compacting）。
      await waitFor(() => recorded.frames.some((f) => f.contextUsage?.compacting !== undefined))
      releaseSummary()
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.compacting === undefined && usage.tokens < beforeCompact
      }, 20_000)
      const after = kernel.getConversation(1).contextUsage!
      assert.ok(after.tokens < beforeCompact, `压缩后 tokens 必须下降（${after.tokens} < ${beforeCompact}）`)
      assert.equal(after.compactionError, undefined, '成功压缩不得残留失败摘要')
      // pi.compaction 条目真实落地（时间线分割线数据源）。
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(detail.entries.some((entry) => entry.kind === 'pi.compaction'), '必须产生 pi.compaction 条目')
      recorded.stop()
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })
})
