/**
 * ConversationTracker 上下文用量刷新的确定性单测（fake harness，真实 tracker）：
 *
 * 1. 边界水位线：初始快照内的历史标记（pi.compaction 等）与连续普通观察更新
 *    不重调度刷新（无写放大）；仅超过旧水位线的新标记条目恰触发一次；
 * 2. ensureContextUsage：多调用方合并同一次在途刷新；已缓存零刷新；
 * 3. 代数守护（含 undefined 捕获）：未观察会话的刷新在并发 observe 换代后
 *    迟到结果丢弃，不回写旧值；
 * 4. stopObserving / 元数据删除后的迟到刷新不复活缓存、不发幽灵事件；
 * 5. 首次填充携带 compacting 时必须发布 upsert（否则订阅方永远看不到）；
 *    无压缩状态的首次填充保持静默；
 * 6. 窗口来源诚实性：helmContextWindowKnown === false 的静态缺省窗口不得
 *    作为已知窗口携带（contextWindow 省略）；
 * 7. 压缩失败通知：新的 compactionFailure 恰发一次脱敏 error notification，
 *    同一 taskId 重复快照不重复通知，新 taskId 再报。
 *
 * 确定性：刷新的调度与 harness.conversation 调用都在同步段发生（断言即时可
 * 见）；异步推进全部经手动释放的 deferred / ensureContextUsage settle 事件，
 * 不依赖 sleep 或计时。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ContextView, ConversationView, Harness, Observation, Observer } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import type { Models, Provider } from '@earendil-works/pi-ai'
import type { UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import type { ConvMeta, HelmStore } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

interface EntrySpec {
  id: number
  kind: string
}

function viewOf(spec: { entries?: EntrySpec[]; live?: Record<string, unknown> }): ConversationView {
  return {
    entries: (spec.entries ?? []) as never,
    docs: spec.live !== undefined ? { 'pi.live': spec.live } : {},
  } as never as ConversationView
}

function userContent(chars: number): UserMessage {
  return { role: 'user', content: 'a'.repeat(chars), timestamp: 1 }
}

/** 刷新读到的 ContextView（tokens 由消息估算长度区分）。 */
function usageView(chars: number): ContextView {
  return {
    head: undefined,
    entries: [],
    contributions: [],
    messages: [userContent(chars)],
  } as unknown as ContextView
}

function tokensOf(chars: number): number {
  // 固定期望（pi agent chars/4）：usageView 的用户消息为 'a'.repeat(chars)，
  // 不镜像被测实现。
  return Math.ceil(chars / 4)
}

/** 刷新结果队列项：即时视图或手动释放的 deferred。 */
type ContextResult = { view: ContextView } | { deferred: Promise<ContextView> }

class FakeHarness {
  /** refreshContextUsageOnce 启动次数（同步段递增；断言即时可见）。 */
  contextCalls = 0
  private readonly queue: ContextResult[] = []
  private observer: Observer<ConversationView> | undefined

  constructor(private readonly initial: ConversationView) {}

  pushView(view: ContextView): void {
    this.queue.push({ view })
  }

  pushDeferred(): { resolve: (view: ContextView) => void } {
    let resolve!: (view: ContextView) => void
    const deferred = new Promise<ContextView>((r) => {
      resolve = r
    })
    this.queue.push({ deferred })
    return { resolve }
  }

  /** 模拟 SDK 快照推进（同步调用 tracker adopt 路径）。 */
  advance(view: ConversationView): void {
    this.observer?.advance({ kind: 'value', value: view } as never, undefined as never)
  }

  readonly observeConversation = async (
    _id: never,
    observer: Observer<ConversationView>,
  ): Promise<Observation<ConversationView>> => {
    this.observer = observer
    return { value: this.initial, detach: () => {} } as never
  }

  readonly conversation = async (): Promise<unknown> => {
    this.contextCalls += 1
    const queue = this.queue
    return {
      context: async (): Promise<ContextView> => {
        const item = queue.shift()
        if (item === undefined) return usageView(40)
        return 'deferred' in item ? await item.deferred : item.view
      },
    }
  }
}

class FakeStore {
  readonly convs = new Map<number, ConvMeta>()
  getConv(id: number): ConvMeta | undefined {
    return this.convs.get(id)
  }
  upsertConv(meta: ConvMeta): void {
    this.convs.set(meta.id, meta)
  }
}

function metaOf(model: string): ConvMeta {
  return {
    id: 1,
    title: '会话一',
    profileId: 'assistant',
    tags: [],
    nodeId: 'local',
    cwd: '/tmp',
    model,
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function eventsOf(): TrackerEvents & {
  summaries: ConversationSummary[]
  notifications: Array<{ level: string; title: string; body?: string; conversationId: number }>
} {
  const summaries: ConversationSummary[] = []
  const notifications: Array<{ level: string; title: string; body?: string; conversationId: number }> = []
  return {
    summaries,
    notifications,
    onSummaryChanged: (summary) => {
      summaries.push(summary)
    },
    onInputCommitted: () => {},
    onTurnSettled: async () => {},
    onAssistantText: () => {},
    onNotification: (payload) => {
      notifications.push(payload)
    },
  }
}

/** 已知/未知窗口双模型的最小 Models 集合（窗口来源诚实性用）。 */
function modelsWithFaux(): Models {
  const models = createModels()
  const known = {
    id: 'm-known',
    name: 'm-known',
    provider: 'faux',
    api: 'openai-completions',
    baseUrl: 'http://faux.local',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 4_096,
  }
  const unknown = { ...known, id: 'm-unknown', contextWindow: 128_000, helmContextWindowKnown: false }
  const provider = {
    id: 'faux',
    name: 'faux',
    baseUrl: 'http://faux.local',
    auth: {},
    getModels: () => [known, unknown],
    getAllModels: () => [known, unknown],
  } as unknown as Provider
  models.setProvider(provider)
  return models
}

function trackerEnv(options?: {
  model?: string
  initialEntries?: EntrySpec[]
  initialLive?: Record<string, unknown>
  redactError?: (text: string) => string
}): {
  harness: FakeHarness
  store: FakeStore
  events: ReturnType<typeof eventsOf>
  tracker: ConversationTracker
} {
  const harness = new FakeHarness(
    viewOf({ entries: options?.initialEntries, live: options?.initialLive ?? {} }),
  )
  const store = new FakeStore()
  store.convs.set(1, metaOf(options?.model ?? 'faux/m-known'))
  const events = eventsOf()
  const models = modelsWithFaux()
  const tracker = new ConversationTracker({
    harness: harness as unknown as Harness,
    store: store as unknown as HelmStore,
    events,
    models: () => models,
    ...(options?.redactError !== undefined ? { redactError: options.redactError } : {}),
  })
  return { harness, store, events, tracker }
}

/** 排空微任务链（手动释放 deferred 后等待刷新链收敛）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// 1. 边界水位线（观察刷新写放大）
// ---------------------------------------------------------------------------

describe('上下文用量刷新：边界水位线', { timeout: 60_000 }, () => {
  it('历史标记不触发；普通更新不重调度；新标记恰触发一次', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialEntries: [
        { id: 5, kind: 'pi.user' },
        { id: 6, kind: 'pi.compaction' },
      ],
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, '初始挂接（idle 会话）恰一次刷新')

    // 连续普通观察更新：历史含 pi.compaction 但低于水位线，不得重调度。
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, '普通新条目不得触发刷新')
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
          { id: 8, kind: 'pi.user' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 1, '重复快照（含历史标记）不得触发刷新')

    // 新 boundary 条目（id 超过旧水位线）：恰触发一次。
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 7, kind: 'pi.assistant' },
          { id: 8, kind: 'pi.user' },
          { id: 9, kind: 'helm.rewind' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 2, '新标记条目恰触发一次刷新')

    // 水位线已推进：同一标记重复出现不再触发。
    env.harness.advance(
      viewOf({
        entries: [
          { id: 5, kind: 'pi.user' },
          { id: 6, kind: 'pi.compaction' },
          { id: 9, kind: 'helm.rewind' },
        ],
      }),
    )
    assert.equal(env.harness.contextCalls, 2, '已扫过的标记不得重复触发')
  })
})

// ---------------------------------------------------------------------------
// 2. ensureContextUsage：合并与零刷新
// ---------------------------------------------------------------------------

describe('上下文用量刷新：ensureContextUsage', { timeout: 60_000 }, () => {
  it('并发调用合并同一次刷新；已缓存直通零刷新', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    const first = env.tracker.ensureContextUsage(1)
    const second = env.tracker.ensureContextUsage(1)
    await first
    await second
    assert.equal(env.harness.contextCalls, 1, '并发 ensure 合并为一次刷新')
    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage, '等待后缓存已填充')

    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1, '已缓存时 ensure 不再刷新')
  })
})

// ---------------------------------------------------------------------------
// 3. 代数守护（undefined 捕获同样参与比较）
// ---------------------------------------------------------------------------

describe('上下文用量刷新：代数守护', { timeout: 60_000 }, () => {
  it('未观察会话的刷新遇并发 observe：迟到旧值丢弃，仅新刷新生效', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    // R1：未观察（generation === undefined）时由 summaryOf 缓存缺失路径触发。
    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(800))
    env.tracker.summaryOf(1)
    assert.equal(env.harness.contextCalls, 1, '缓存缺失读取触发一次刷新')

    // 并发 observe：换代 + adoptInitial 调度（R1 在途 → dirty，不立即启动）。
    const observed = env.tracker.observe(1)
    assert.equal(env.harness.contextCalls, 1, '在途刷新期间新触发只置 dirty')
    await observed

    gate.resolve(usageView(120)) // R1 的迟到旧值
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, 'R1 被丢弃后仅重跑一次')

    const usage = env.tracker.summaryOf(1).contextUsage
    assert.ok(usage)
    assert.equal(usage.tokens, tokensOf(800), '迟到旧值不得回写缓存')
  })
})

// ---------------------------------------------------------------------------
// 4. 停观 / 删除后的迟到刷新
// ---------------------------------------------------------------------------

describe('上下文用量刷新：停观与删除守护', { timeout: 60_000 }, () => {
  it('stopObserving 后迟到刷新不复活缓存、不发事件', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 1)

    const gate = env.harness.pushDeferred()
    env.harness.pushView(usageView(200))
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2, '新刷新已启动（gated）')

    env.tracker.stopObserving(1)
    gate.resolve(usageView(60))
    await flush()

    // 若迟到刷新复活了缓存，ensure 将直通零刷新；正确行为是需要全新刷新。
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 3, '迟到结果被丢弃，ensure 需全新刷新')
    assert.equal(env.events.summaries.length, 0, '停观后不得发布任何幽灵事件')
  })

  it('刷新期间元数据被删除：迟到结果不回写缓存', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)

    const gate = env.harness.pushDeferred()
    env.tracker.scheduleContextUsageRefresh(1)
    assert.equal(env.harness.contextCalls, 2)
    env.store.convs.delete(1)
    gate.resolve(usageView(90))
    await flush()

    // 已删除：ensure 立即返回且不再调度。
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.harness.contextCalls, 2, '删除后不得再启动刷新')
    assert.equal(env.events.summaries.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 5. 首次填充的事件纪律
// ---------------------------------------------------------------------------

describe('上下文用量刷新：首次填充发布规则', { timeout: 60_000 }, () => {
  it('首次填充携带 compacting 时必须发布 upsert（订阅方无后续语义帧可见）', { timeout: 60_000 }, async () => {
    const env = trackerEnv({
      initialLive: { compactions: [{ taskId: 9, trigger: 'manual', blocking: false }] },
    })
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 1, '首次填充携带压缩状态必须发布')
    const usage = env.events.summaries[0]!.contextUsage
    assert.equal(usage?.compacting, true, '发布帧必须携带 compacting 布尔')
  })

  it('无压缩状态的首次填充保持静默（帧纪律不变）', { timeout: 60_000 }, async () => {
    const env = trackerEnv({})
    await env.tracker.observe(1)
    await env.tracker.ensureContextUsage(1)
    assert.equal(env.events.summaries.length, 0)
    assert.ok(env.tracker.summaryOf(1).contextUsage, '静默填充经读路径仍可见')
  })
})

// ---------------------------------------------------------------------------
// 6. 窗口来源诚实性（helmContextWindowKnown）
// ---------------------------------------------------------------------------

describe('上下文用量刷新：窗口来源诚实性', { timeout: 60_000 }, () => {
  it('已知窗口模型携带 contextWindow；静态缺省标记模型省略', { timeout: 60_000 }, async () => {
    const known = trackerEnv({ model: 'faux/m-known' })
    await known.tracker.observe(1)
    await known.tracker.ensureContextUsage(1)
    const knownUsage = known.tracker.summaryOf(1).contextUsage!
    assert.ok(knownUsage)
    assert.equal(knownUsage.contextWindow, 200_000, '策展窗口如实携带')

    const unknown = trackerEnv({ model: 'faux/m-unknown' })
    await unknown.tracker.observe(1)
    await unknown.tracker.ensureContextUsage(1)
    const unknownUsage = unknown.tracker.summaryOf(1).contextUsage!
    assert.ok(unknownUsage)
    assert.ok(unknownUsage.tokens !== null && unknownUsage.tokens > 0, '用量估算仍然提供')
    assert.equal(unknownUsage.contextWindow, undefined, '静态缺省窗口不得显示为已知')
  })
})

// ---------------------------------------------------------------------------
// 7. 压缩失败通知（脱敏 + 去重）
// ---------------------------------------------------------------------------

describe('上下文用量刷新：压缩失败通知', { timeout: 60_000 }, () => {
  it('新的 compactionFailure 恰发一次脱敏 error notification；同一 taskId 重复快照不重复；新 taskId 再报', { timeout: 60_000 }, async () => {
    const failure = { taskId: 5, trigger: 'manual', error: 'sk-abc 网关 500' }
    const env = trackerEnv({
      initialLive: { compactionFailure: failure },
      redactError: (t) => t.replace('sk-abc', '***'),
    })
    await env.tracker.observe(1)
    assert.equal(env.events.notifications.length, 1, '初始快照的失败必须上报（不静默）')
    const notice = env.events.notifications[0]!
    assert.equal(notice.level, 'error')
    assert.equal(notice.title, '上下文精简失败')
    assert.equal(notice.conversationId, 1)
    assert.match(notice.body ?? '', /\*\*\* 网关 500/, '错误摘要必须经注入 redact 脱敏')
    assert.ok(!(notice.body ?? '').includes('sk-abc'), '机密不得回显')

    // 同一失败重复出现在后续快照：不得重复通知。
    env.harness.advance(viewOf({ live: { compactionFailure: failure } }))
    env.harness.advance(viewOf({ live: { compactionFailure: failure, run: { taskId: 3, inputs: [] } } }))
    assert.equal(env.events.notifications.length, 1, '同一 taskId 不得重复通知')

    // 新的失败（新 taskId）：再报一次。
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
    assert.match(env.events.notifications[1]!.body ?? '', /阈值/)

    // 无失败的快照：不发；失败清除后再次出现同一 taskId 也不重报（同 runtime 去重）。
    env.harness.advance(viewOf({ live: {} }))
    env.harness.advance(viewOf({ live: { compactionFailure: { taskId: 6, trigger: 'threshold', error: 'again' } } }))
    assert.equal(env.events.notifications.length, 2)
  })
})
