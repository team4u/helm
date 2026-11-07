/**
 * builtin:superagent 独立 Watchdog 模块单测（PluginHost + 受控注入依赖，不起真实内核）。
 *
 * 覆盖：
 * 1. 自激排除：watchdog 自身 id 与 profileId=watchdog 直聊会话不进探针处置；
 *    watchdog 自身 failed/aborted 仅通知。
 * 2. 去重：(targetKind,nodeId,targetId,stateChangeSeq) 同类动作恰好一次；
 *    阈值前不占坑；阈值后一次；新 seq 可再触发；两个节点同 paneId 独立；
 *    去重文档跨重启（新注册周期）仍生效；脏文档回退。
 * 3. human 红线：human native / human 外部窗格零写操作（无 abort/无 submitInput）。
 * 4. mutation 所有权即时核对：探针报 owned、现查已改 human → 403 watchdog_target_human。
 * 5. 外部目标策略：working 超长只通知不中止不唤醒；连续 unreachable 达阈值唤醒+通知一次。
 * 6. bridge_to_ask：owned+无 pending Ask 创建确认 Ask；Ask 无 CAS 水位；授权 recover
 *    校验后注入；状态已变则放弃；Ask 自身推进 seq 不误杀；同水位不重复创建。
 * 7. 工具/动作：watchdog_inspect/recover/abort 所有权守卫；非 watchdog 会话/同 profile
 *    直聊拒绝；HTTP/CLI 无会话上下文放行；watchdog 会话 before_turn 剥离 bash 等，
 *    tool_call 阻断未知工具；#1 与普通 Bot 不受影响。
 * 8. L2：同 tick 合并一次投递；纯 human 异常不唤醒；模型异常不递归（watchdog
 *    会话的 failed 只通知，不再触发 wake）。
 * 9. 缺权威 seq：只读通知，绝不 abort / bridge。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type AskCreateSpec,
  type AskResult,
  type BeforeTurnHookPayload,
  type ConversationSummary,
  type PluginDefinition,
  type PluginToolSpec,
  type ToolCallHookPayload,
  type TurnSettledPayload,
  type WatchdogProbe,
  type WatchdogTickHookPayload,
} from '@helm/protocol'
import {
  PluginHost,
  type PluginDocStore,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import {
  registerSuperAgentWatchdog,
  WATCHDOG_ALLOWED_TOOLS,
} from '../src/builtin-plugins/superagent/watchdog.js'
import type {
  SuperAgentConfig,
  SuperAgentDependencies,
  SuperAgentWatchdogRuntime,
} from '../src/builtin-plugins/superagent/contracts.js'
import type { ProfileService, SkillService } from '../src/services/index.js'

// ---------------------------------------------------------------------------
// 受控依赖基座
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'builtin:superagent'

interface Recorded {
  notifications: Array<{ level: string; title: string; body: string }>
  submits: Array<{ conversationId: number; text: string; origin?: string; whenBusy?: string }>
  aborts: number[]
  asks: AskCreateSpec[]
  askResults: Map<string, AskResult>
  tracked: string[]
  trackFailures: Array<{ label: string; error: unknown }>
}

/** 内存版 PluginDocStore（带类型化 store 字段供测试直接注入/检查）。 */
class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
}

function makeRecorded(): Recorded {
  return {
    notifications: [],
    submits: [],
    aborts: [],
    asks: [],
    askResults: new Map(),
    tracked: [],
    trackFailures: [],
  }
}

/** 构造真实可执行的工具描述（before_turn 载荷要求 PluginToolSpec 含 execute）。 */
function makeToolSpec(name: string): PluginToolSpec {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object' },
    execute: async () => ({ ok: true }),
  }
}

function makeConversationSummary(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    status: 'idle',
    stateChangeSeq: 10,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

interface HarnessOptions {
  routerId?: number
  watchdogId?: number
  ownership?: (id: number) => 'helm' | 'bot' | 'human'
  isClosing?: () => boolean
  trackImpl?: <T>(label: string, task: () => Promise<T>) => Promise<T>
  /** createAsk 落地后、结算前的回调（模拟「授权期间目标变化」）。 */
  onAskCreated?: (spec: AskCreateSpec) => void
}

/** 组装 PluginHost + 注册 watchdog 模块 + 受控 deps/runtime fake。 */
async function makeHarness(opts: HarnessOptions = {}) {
  const recorded = makeRecorded()
  const routerId = opts.routerId ?? 100
  const watchdogId = opts.watchdogId ?? 200
  const conversations = new Map<number, ConversationSummary>()
  // 预置常驻会话：watchdog/router/#1（scope 校验与自激排除都依赖真实摘要）。
  conversations.set(watchdogId, makeConversationSummary(watchdogId, { profileId: 'watchdog', title: '巡检看门狗' }))
  conversations.set(routerId, makeConversationSummary(routerId, { profileId: 'superagent', title: 'SuperAgent 中枢' }))
  conversations.set(1, makeConversationSummary(1, { title: '个人助理' }))
  const ownership = new Map<number, 'helm' | 'bot' | 'human'>()

  const docs = new MemoryDocStore()

  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async (conversationId, text, o) => {
      recorded.submits.push({ conversationId, text, origin: o?.origin, whenBusy: o?.whenBusy })
    },
    createConversation: async (init) => {
      const id = conversations.size + 1
      const summary = makeConversationSummary(id, { title: init.title ?? 'new', profileId: init.profileId ?? 'assistant' })
      conversations.set(id, summary)
      return summary
    },
    listConversations: () => [...conversations.values()],
    getConversation: (id) => {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    updateConversation: async (id) => conversations.get(id) ?? makeConversationSummary(id),
    manageConversation: () => () => {},
    markConversationOwnership: (id, owner) => ownership.set(id, owner),
    createAsk: async (spec) => {
      recorded.asks.push(spec)
      opts.onAskCreated?.(spec)
      const result = recorded.askResults.get(spec.id ?? 'auto') ?? { id: spec.id ?? 'ask-1', status: 'cancelled', answers: {} }
      return result
    },
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: (type, payload) => {
      if (type === 'notification') {
        const p = payload as { level?: string; title?: string; body?: string }
        recorded.notifications.push({ level: p.level ?? 'info', title: p.title ?? '', body: p.body ?? '' })
      }
    },
  }

  const host = new PluginHost({
    dataDir: mkdtempSync(join(tmpdir(), 'helm-superagent-watchdog-')),
    host: backend,
    docs,
  })

  const config: SuperAgentConfig = {
    routerMode: true,
    mutedSources: '',
    watchdogEnabled: true,
    stalledAfterMs: 60_000,
    abortAfterMs: 600_000,
    errorThreshold: 3,
  }

  const deps: SuperAgentDependencies = {
    dataDir: '/tmp/helm-test-superagent',
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    getConversationDetail: async (id) => ({
      ...makeConversationSummary(id),
      entries: [{ id: 'e1', kind: 'message', createdAt: 1, model: [{ role: 'assistant', content: 'hello' }] }],
    }),
    listArtifacts: async () => [],
    abortConversation: async (id) => {
      recorded.aborts.push(id)
    },
    getConversationOwnership: (id) => opts.ownership?.(id) ?? ownership.get(id) ?? (id === 1 ? 'human' : 'helm'),
    isClosing: () => opts.isClosing?.() ?? false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }

  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => config,
    getRouterConversationId: () => routerId,
    getWatchdogConversationId: () => watchdogId,
    track:
      opts.trackImpl ??
      (async <T>(label: string, task: () => Promise<T>): Promise<T> => {
        recorded.tracked.push(label)
        return task()
      }),
  }

  const definition: PluginDefinition = {
    id: PLUGIN_ID,
    name: 'SuperAgent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps, runtime)
    },
  }
  await host.register(definition)

  return {
    host,
    recorded,
    conversations,
    ownership,
    config,
    docs,
    routerId,
    watchdogId,
    async tick(probes: WatchdogProbe[], summaries?: ConversationSummary[]) {
      // 默认用当前会话表快照（含预置与测试中手动更新的状态）。
      const list = summaries ?? [...conversations.values()]
      for (const s of list) conversations.set(s.id, s)
      const payload: WatchdogTickHookPayload = {
        timestamp: Date.now(),
        conversations: list,
        probes,
      }
      await host.runHook('watchdog_tick', payload)
      // 等 fire-and-forget 任务落地（受控 track 同步执行，一次微任务翻转即可）。
      await new Promise((resolve) => setImmediate(resolve))
    },
    async turnSettled(payload: TurnSettledPayload) {
      await host.runHook('turn_settled', payload)
    },
    async beforeTurn(payload: BeforeTurnHookPayload) {
      return host.runHook('before_turn', payload)
    },
    async toolCall(payload: ToolCallHookPayload) {
      return host.runHook('tool_call', payload)
    },
  }
}

function nativeProbe(conversationId: number, over: Partial<WatchdogProbe> = {}): WatchdogProbe {
  return {
    targetId: String(conversationId),
    targetKind: 'conversation',
    conversationId,
    ownedBy: 'helm',
    status: 'working',
    stateChangeSeq: 10,
    facts: { pendingAskCount: 0 },
    ...over,
  }
}

function externalProbe(nodeId: string, paneId: string, over: Partial<WatchdogProbe> = {}): WatchdogProbe {
  return {
    targetId: paneId,
    targetKind: 'external',
    nodeId,
    ownedBy: 'helm',
    stateChangeSeq: 10,
    status: 'working',
    facts: { kind: 'herdr', parentConversationId: 300, pendingAskCount: 0, stalledBasis: 'since-last-state-change' },
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 1. 自激排除
// ---------------------------------------------------------------------------

test('自激排除：watchdog 自身 id 与 profileId=watchdog 直聊会话零处置；自身 failed 仅通知', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  const watchdogChat = makeConversationSummary(777, { profileId: 'watchdog' })
  await h.tick(
    [
      nativeProbe(h.watchdogId, { status: 'error', stalledMs: 10_000_000 }),
      nativeProbe(777, { status: 'error', stalledMs: 10_000_000, ownedBy: 'helm' }),
      nativeProbe(55, { status: 'error' }), // 对照组：普通 owned error 会被唤醒
    ],
    [watchdogChat, makeConversationSummary(55)],
  )
  // watchdogId 与 777 无 abort、无 L2 针对它们的唤醒文本；仅对照组 55 产生一次 wake。
  assert.equal(h.recorded.aborts.length, 0)
  const wakeSubmits = h.recorded.submits.filter((s) => s.conversationId === h.watchdogId)
  assert.equal(wakeSubmits.length, 1)
  assert.ok(!wakeSubmits[0]!.text.includes('"conversation:777"'), 'profileId=watchdog 直聊不得进入事实')
  assert.ok(wakeSubmits[0]!.text.includes('conversation:55'))

  // watchdog 自身回合 failed：仅通知，不触发任何自动处置。
  const before = h.recorded.submits.length
  await h.turnSettled({
    conversation: makeConversationSummary(h.watchdogId, { profileId: 'watchdog', status: 'error' }),
    inputs: [],
    outcome: 'failed',
    error: 'boom',
    settledAt: Date.now(),
  })
  assert.equal(h.recorded.submits.length, before, '自身失败不得唤醒自己')
  assert.ok(h.recorded.notifications.some((n) => n.title.includes('巡检看门狗回合异常')))
})

// ---------------------------------------------------------------------------
// 2. 去重语义
// ---------------------------------------------------------------------------

test('native 停滞：阈值前不消费；阈值后 abort+wake 恰好一次；同 seq 不再触发；新 seq 可再触发', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  h.config.abortAfterMs = 600_000
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 10 }))
  // 未达阈值（stalledMs < stalledAfterMs）：零动作、零去重标记（不预先占坑）。
  await h.tick([nativeProbe(55, { stalledMs: 59_999, status: 'working' })])
  assert.equal(h.recorded.aborts.length, 0)
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 0)

  // 达 abort 阈值（同 seq=10，stalledMs > abortAfterMs）：abort 一次 + wake 一次。
  await h.tick([nativeProbe(55, { stalledMs: 600_001, status: 'working' })])
  assert.deepEqual(h.recorded.aborts, [55])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)

  // 同 seq 重复 tick：不再 abort、不再 wake（跨重启语义由持久 doc 保证，见下一用例）。
  await h.tick([nativeProbe(55, { stalledMs: 700_000, status: 'working' })])
  assert.deepEqual(h.recorded.aborts, [55])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)

  // 新权威 seq：新事件，可再次触发（目标会话状态同步推进到 seq=11）。
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 11 }))
  await h.tick([nativeProbe(55, { stalledMs: 700_000, status: 'working', stateChangeSeq: 11 })])
  assert.deepEqual(h.recorded.aborts, [55, 55])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 2)
})

test('两个节点同 paneId 独立去重，跨注册周期持久恢复，损坏文档显式拒绝', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-wd-dedup-'))
  const sharedDocs = new MemoryDocStore()
  const recorded = makeRecorded()
  const opts: HarnessOptions = {
    ownership: () => 'helm',
    trackImpl: async (label, task) => {
      recorded.tracked.push(label)
      return task()
    },
  }

  // 用共享 docs 的 harness（makeHarness 不暴露 docs 注入，这里手动组装一次）。
  const h = await makeHarnessWithDocs(sharedDocs, recorded, opts)

  // local 与 nodeId-b 同 paneId 'p1'，各自触发一次 wake。
  await h.tick([
    externalProbe('local', 'p1', { status: 'error', consecutiveErrors: 5 }),
    externalProbe('nodeId-b', 'p1', { status: 'error', consecutiveErrors: 5 }),
  ])
  const wake1 = h.recorded.submits.filter((s) => s.conversationId === h.watchdogId)
  assert.equal(wake1.length, 1, '同 tick 合并一次投递')
  assert.ok(wake1[0]!.text.includes('local/p1'))
  assert.ok(wake1[0]!.text.includes('nodeId-b/p1'))

  // 再 tick：两目标的同一权威水位已经投递，不再唤醒。
  await h.tick([
    externalProbe('local', 'p1', { status: 'unreachable', consecutiveErrors: 6 }),
    externalProbe('nodeId-b', 'p1', { status: 'unreachable', consecutiveErrors: 6 }),
  ])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)

  // 模拟重启：同一持久 docs 上重建 harness（全新内存状态），去重仍生效。
  const h2 = await makeHarnessWithDocs(sharedDocs, makeRecorded(), opts)
  await h2.tick([externalProbe('local', 'p1', { status: 'unreachable', consecutiveErrors: 7 })])
  assert.equal(
    h2.recorded.submits.filter((s) => s.conversationId === h2.watchdogId).length,
    0,
    '跨重启不得重复同类动作',
  )

  // 脏文档：结构破坏 → 显式 superagent_doc_corrupt 拒绝巡检（不再静默回空重放旧危险动作）。
  sharedDocs.store.set(`${PLUGIN_ID}:watchdog-dedup`, { version: 1, fired: { garbage: 42 } })
  const h3 = await makeHarnessWithDocs(sharedDocs, makeRecorded(), opts)
  await assert.rejects(
    h3.tick([externalProbe('local', 'p1', { status: 'unreachable', consecutiveErrors: 8 })]),
    (err: unknown) => err instanceof HelmError && err.code === 'superagent_doc_corrupt',
  )

  rmSync(dir, { recursive: true, force: true })
})

/** 共享 docs 版 harness（验证跨周期持久去重）。 */
async function makeHarnessWithDocs(docs: PluginDocStore, recorded: Recorded, opts: HarnessOptions) {
  const routerId = 100
  const watchdogId = 'watchdogId' in opts ? opts.watchdogId : 200
  const conversations = new Map<number, ConversationSummary>()
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async (conversationId, text, o) => {
      recorded.submits.push({ conversationId, text, origin: o?.origin, whenBusy: o?.whenBusy })
    },
    createConversation: async () => makeConversationSummary(1),
    listConversations: () => [...conversations.values()],
    getConversation: (id) => {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      return found
    },
    updateConversation: async (id) => conversations.get(id) ?? makeConversationSummary(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async (spec) => {
      recorded.asks.push(spec)
      return recorded.askResults.get(spec.id ?? 'auto') ?? { id: spec.id ?? 'ask-1', status: 'cancelled', answers: {} }
    },
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: (type, payload) => {
      if (type === 'notification') {
        const p = payload as { level?: string; title?: string; body?: string }
        recorded.notifications.push({ level: p.level ?? 'info', title: p.title ?? '', body: p.body ?? '' })
      }
    },
  }
  const host = new PluginHost({ dataDir: mkdtempSync(join(tmpdir(), 'helm-saw-')), host: backend, docs })
  const config: SuperAgentConfig = {
    routerMode: true,
    mutedSources: '',
    watchdogEnabled: true,
    stalledAfterMs: 60_000,
    abortAfterMs: 600_000,
    errorThreshold: 3,
  }
  const deps: SuperAgentDependencies = {
    dataDir: '/tmp/x',
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    getConversationDetail: async (id) => ({ ...makeConversationSummary(id), entries: [] }),
    listArtifacts: async () => [],
    abortConversation: async (id) => {
      recorded.aborts.push(id)
    },
    getConversationOwnership: (id) => opts.ownership?.(id) ?? 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }
  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => config,
    getRouterConversationId: () => routerId,
    getWatchdogConversationId: () => watchdogId,
    track: (opts.trackImpl ?? (async (label, task) => task())) as <T>(label: string, task: () => Promise<T>) => Promise<T>,
  }
  await host.register({
    id: PLUGIN_ID,
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps, runtime)
    },
  })
  return {
    host,
    recorded,
    watchdogId,
    async tick(probes: WatchdogProbe[]) {
      for (const probe of probes) {
        if (probe.targetKind === 'conversation' && probe.conversationId !== undefined) {
          conversations.set(probe.conversationId, makeConversationSummary(probe.conversationId, {
            status: probe.status as ConversationSummary['status'],
            stateChangeSeq: probe.stateChangeSeq ?? 10,
          }))
        }
      }
      const payload: WatchdogTickHookPayload = { timestamp: Date.now(), conversations: [...conversations.values()], probes }
      await host.runHook('watchdog_tick', payload)
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// 3. human 红线
// ---------------------------------------------------------------------------

test('human native 与 human 外部窗格：完全零写操作（无 abort/无注入），仅通知', { timeout: 60_000 }, async () => {
  const h = await makeHarness({ ownership: (id) => (id === 88 ? 'human' : 'helm') })
  await h.tick([
    nativeProbe(88, { ownedBy: 'human', status: 'error', stalledMs: 10_000_000, consecutiveErrors: 9 }),
    externalProbe('local', 'px', { ownedBy: 'human', status: 'unreachable', consecutiveErrors: 9 }),
  ])
  assert.equal(h.recorded.aborts.length, 0)
  assert.equal(h.recorded.submits.filter((s) => s.conversationId !== h.watchdogId).length, 0, '不得向 human 目标注入')
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 0, '纯 human 异常不唤醒执行模型')
  assert.ok(h.recorded.notifications.length >= 2, '两类异常均应有只读通知')
})

// ---------------------------------------------------------------------------
// 4. mutation 即时归属核对
// ---------------------------------------------------------------------------

test('abort/recover 执行前现查归属：探针报 owned 但现查已 human → 放弃并通知，不 abort', { timeout: 60_000 }, async () => {
  let flipToHuman = false
  const h = await makeHarness({ ownership: (id) => (flipToHuman && id === 66 ? 'human' : 'helm') })
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 10 }))
  h.conversations.set(66, makeConversationSummary(66, { status: 'working', stateChangeSeq: 10 }))
  await h.tick([nativeProbe(55, { stalledMs: 600_001 })])
  assert.equal(h.recorded.aborts.length, 1) // 归属未变时正常中止

  flipToHuman = true
  await h.tick([nativeProbe(66, { stalledMs: 600_001 })])
  await h.tick([nativeProbe(66, { stalledMs: 600_001, stateChangeSeq: 11 })])
  assert.equal(h.recorded.aborts.filter((a) => a === 66).length, 0, '现查 human 必须放弃')
  assert.ok(h.recorded.notifications.some((n) => n.title.includes('放弃自动中止')))
})

// ---------------------------------------------------------------------------
// 5. 外部目标策略（stalledBasis 事实）
// ---------------------------------------------------------------------------

test('外部 working 超长停滞：只读通知，绝不自动中止、不唤醒（stalledBasis 非 activity 证据）', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.tick([
    externalProbe('local', 'pw', { status: 'working', stalledMs: 100_000_000, stateChangeSeq: 4 }),
  ])
  assert.equal(h.recorded.aborts.length, 0)
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 0)
  assert.ok(h.recorded.notifications.some((n) => n.body.includes('since-last-state-change')))
  // 同 seq 不重复通知。
  await h.tick([externalProbe('local', 'pw', { status: 'working', stalledMs: 100_000_000, stateChangeSeq: 4 })])
  assert.equal(h.recorded.notifications.filter((n) => n.body.includes('since-last-state-change')).length, 1)
})

test('外部连续 unreachable 达阈值：唤醒+通知各一次；低于阈值零动作', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.tick([externalProbe('local', 'pu', { status: 'unreachable', consecutiveErrors: 2 })])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 0)
  await h.tick([externalProbe('local', 'pu', { status: 'unreachable', consecutiveErrors: 3 })])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)
  assert.ok(h.recorded.notifications.some((n) => n.body.includes('pu@local')))
  // 同目标再次达阈值：1 小时不应期内不再重复。
  await h.tick([externalProbe('local', 'pu', { status: 'unreachable', consecutiveErrors: 4 })])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)
})

test('外部 blocked 且已有 Herdr 待答审批：沿用审批桥，不新建 Ask 不注入按键', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.tick([
    externalProbe('local', 'pb', { status: 'blocked', facts: { kind: 'herdr', parentConversationId: 300, pendingAskCount: 1, stalledBasis: 'since-last-state-change' } }),
  ])
  assert.equal(h.recorded.asks.length, 0, '已有 pending Ask 绝不复制审批')
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === 300).length, 0, '不得向终端窗格发送任何按键')
  assert.ok(h.recorded.notifications.some((n) => n.body.includes('沿用')))
})

// ---------------------------------------------------------------------------
// 6. bridge_to_ask（原生 owned 阻塞且无 pending Ask）
// ---------------------------------------------------------------------------

test('bridge_to_ask：创建无 CAS 水位的确认 Ask；授权 recover 且状态未变时注入；Ask 推进 seq 不误杀', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  const target = makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 10, completionSeq: 7 })
  h.conversations.set(55, target)
  // createAsk 返回 answered recover。
  h.recorded.askResults.set('superagent-watchdog-bridge-55-10', {
    id: 'superagent-watchdog-bridge-55-10',
    status: 'answered',
    answers: { decision: 'recover' },
  })
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h.recorded.asks.length, 1)
  const ask = h.recorded.asks[0]!
  assert.equal(ask.conversationId, 55)
  assert.equal(ask.expectedStateSeq, undefined, '原生干预 Ask 不得填外部终端 CAS 水位')
  assert.equal(ask.fields[0]!.name, 'decision')
  // 授权后注入恢复提示（Ask 创建/回答会推进 stateChangeSeq，但 completionSeq 不变 → 注入执行）。
  const recover = h.recorded.submits.find((s) => s.conversationId === 55)
  assert.ok(recover, '应注入恢复提示')
  assert.equal(recover!.origin, 'agent')
  assert.ok(h.recorded.notifications.some((n) => n.title.includes('恢复提示')))
})

test('bridge_to_ask：授权 abort 且现查仍 blocked 时中止；授权期间目标已完成则放弃', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  h.conversations.set(55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 10, completionSeq: 7 }))
  h.recorded.askResults.set('superagent-watchdog-bridge-55-10', {
    id: 'superagent-watchdog-bridge-55-10',
    status: 'answered',
    answers: { decision: 'abort' },
  })
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.deepEqual(h.recorded.aborts, [55])

  // 授权期间目标已 done（completionSeq 推进）：放弃执行。
  const h2 = await makeHarness({
    onAskCreated: () => {
      // Ask 创建后、结算前目标已完成新回合（状态与水位均已推进）。
      h2.conversations.set(66, makeConversationSummary(66, { status: 'done', stateChangeSeq: 12, completionSeq: 9 }))
    },
  })
  h2.conversations.set(66, makeConversationSummary(66, { status: 'blocked', stateChangeSeq: 10, completionSeq: 7 }))
  h2.recorded.askResults.set('superagent-watchdog-bridge-66-10', {
    id: 'superagent-watchdog-bridge-66-10',
    status: 'answered',
    answers: { decision: 'abort' },
  })
  await h2.tick([nativeProbe(66, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h2.recorded.aborts.filter((a) => a === 66).length, 0)
  assert.ok(h2.recorded.notifications.some((n) => n.title.includes('放弃执行授权')))
})

test('bridge_to_ask：已有人类接管（现查 human）不创建；探针水位过期不创建；同水位不重复创建', { timeout: 60_000 }, async () => {
  let owned = true
  const h = await makeHarness({ ownership: (id) => (id === 55 ? (owned ? 'helm' : 'human') : 'helm') })
  h.conversations.set(55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 10 }))
  owned = false
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h.recorded.asks.length, 0, '现查 human 不得创建 Ask')

  owned = true
  // 首次守卫失败仅限频通知（消耗 notify 不消耗 bridge）：第二次创建成功。
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h.recorded.asks.length, 1, '同一水位下守卫通过后应创建（失败守卫不永久占坑）')
  // 同水位第二次 tick：inFlight/去重保证不重复创建。
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h.recorded.asks.length, 1)

  // 水位过期（会话 seq 已推进）：跳过创建并通知。
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 12 }))
  await h.tick([nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })])
  assert.equal(h.recorded.asks.filter((a) => a.conversationId === 55 && a.id !== 'superagent-watchdog-bridge-55-12').length, 1)
})

// ---------------------------------------------------------------------------
// 7. 工具 / 动作守卫
// ---------------------------------------------------------------------------

test('watchdog_inspect：原生会话现查归属与时间线；外部 probe 只读；未知外部目标 404', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 3 }))
  const native = (await h.host.executeTool(
    'watchdog_inspect',
    { conversationId: 55 },
    { conversationId: h.watchdogId },
  )) as { kind: string; conversation: { ownedBy: string; stateChangeSeq: number } }
  assert.equal(native.kind, 'conversation')
  assert.equal(native.conversation.ownedBy, 'helm')
  assert.equal(native.conversation.stateChangeSeq, 3)
  // 外部 probe：先 tick 产生事实。
  await h.tick([externalProbe('local', 'p1', { status: 'working', stateChangeSeq: 3 })])
  const ext = (await h.host.executeTool(
    'watchdog_inspect',
    { probe: { targetKind: 'external', nodeId: 'local', targetId: 'p1' } },
    { conversationId: h.watchdogId },
  )) as { kind: string; probe: { status: string } }
  assert.equal(ext.kind, 'external')
  assert.equal(ext.probe.status, 'working')

  await assert.rejects(
    h.host.executeTool(
      'watchdog_inspect',
      { probe: { targetKind: 'external', nodeId: 'local', targetId: 'ghost' } },
      { conversationId: h.watchdogId },
    ),
    (err: unknown) => err instanceof HelmError && err.status === 404,
  )
})

test('watchdog_recover/abort：owned 会话实际调用注入依赖；human/root/中枢/自身拒绝 403', { timeout: 60_000 }, async () => {
  const h = await makeHarness({ ownership: (id) => (id === 99 ? 'human' : id === 1 ? 'human' : 'helm') })
  await h.host.executeTool('watchdog_recover', { conversationId: 55, hint: '请重试' }, { conversationId: h.watchdogId })
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === 55).length, 1)

  await h.host.executeTool('watchdog_abort', { conversationId: 56 }, { conversationId: h.watchdogId })
  assert.deepEqual(h.recorded.aborts, [56])

  for (const bad of [99, 1, h.routerId, h.watchdogId]) {
    await assert.rejects(
      h.host.executeTool('watchdog_abort', { conversationId: bad }, { conversationId: h.watchdogId }),
      (err: unknown) =>
        err instanceof HelmError &&
        err.status === 403 &&
        (err.code === 'watchdog_target_human' || err.code === 'watchdog_target_protected'),
    )
  }
})

test('专属工具仅实际 watchdog 会话可用：同 profile 直聊与非 watchdog 会话拒绝；HTTP/CLI 无上下文放行但目标守卫仍生效', { timeout: 60_000 }, async () => {
  const h = await makeHarness({ ownership: () => 'helm' })
  // 调用方会话 321：同 profile 直聊（profileId=watchdog 但非实际巡检会话）。
  // scope 命中（profile 匹配）后由模块自身守卫拒绝——验证直聊拿不到专属控制能力。
  h.conversations.set(321, makeConversationSummary(321, { profileId: 'watchdog' }))
  // 非 watchdog 会话（普通 finance 会话）调用工具：scope 先拦（工具不可见）。
  h.conversations.set(322, makeConversationSummary(322, { profileId: 'finance' }))
  await assert.rejects(
    h.host.executeTool('watchdog_abort', { conversationId: 55 }, { conversationId: 322 }),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_scope_violation',
  )
  // 同 profile 直聊：scope 命中但非实际巡检会话，模块守卫拒绝。
  await assert.rejects(
    h.host.executeTool('watchdog_abort', { conversationId: 55 }, { conversationId: 321 }),
    (err: unknown) => err instanceof HelmError && err.code === 'watchdog_not_watchdog_session',
  )
  // 带 conversationId 的 action 调用（模拟 run_action / workflow 路径）同守卫。
  await assert.rejects(
    h.host.invokeAction(PLUGIN_ID, 'watchdog_abort', { conversationId: 55 }, { conversationId: 321 }),
    (err: unknown) => err instanceof HelmError && err.code === 'watchdog_not_watchdog_session',
  )
  // 人工 HTTP/CLI（无 conversationId）：放行执行，但目标所有权守卫照样生效。
  const h88 = await makeHarness({ ownership: (id) => (id === 88 ? 'human' : 'helm') })
  await assert.rejects(
    h88.host.invokeAction(PLUGIN_ID, 'watchdog_abort', { conversationId: 88 }, {}),
    (err: unknown) => err instanceof HelmError && err.code === 'watchdog_target_human',
  )
  await h.host.invokeAction(PLUGIN_ID, 'watchdog_recover', { conversationId: 55, hint: 'manual' }, {})
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === 55 && s.text === 'manual').length, 1)
})

test('before_turn：watchdog 会话剥离 bash/edit/write/subagent/SubagentWorkflow/run_action 与未知工具；#1 与普通 Bot 不受影响', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  const mkTools = () =>
    [
      'bash',
      'edit',
      'write',
      'subagent',
      'SubagentWorkflow',
      'run_action',
      'read',
      'read_artifact',
      'load_skill',
      'update_memory',
      'watchdog_inspect',
      'watchdog_recover',
      'watchdog_abort',
      'third_party_custom',
    ].map(makeToolSpec)
  const turnOf = (conversation: ConversationSummary, tools: ReturnType<typeof mkTools>) => ({
    conversation,
    inputs: [],
    tools,
    sections: [],
    messages: [],
  })

  // 实际 watchdog 会话：完整白名单集合。
  const wd = await h.beforeTurn(turnOf(makeConversationSummary(h.watchdogId, { profileId: 'watchdog' }), mkTools()))
  assert.equal(wd.action, 'transform')
  const wdTools = (wd as { value: BeforeTurnHookPayload }).value.tools.map((t) => t.name)
  assert.deepEqual(
    [...wdTools].sort(),
    [...WATCHDOG_ALLOWED_TOOLS].sort(),
    '实际 watchdog 会话保留恰好白名单工具',
  )

  // 同 profile 直聊：专属工具也被剥离，只留通用只读。
  const peer = await h.beforeTurn(turnOf(makeConversationSummary(777, { profileId: 'watchdog' }), mkTools()))
  const peerTools = ((peer as { value: BeforeTurnHookPayload }).value.tools ?? []).map((t) => t.name)
  assert.deepEqual(peerTools.sort(), ['load_skill', 'read', 'read_artifact', 'update_memory'])

  // #1 与普通 Bot：原样。
  for (const conv of [makeConversationSummary(1), makeConversationSummary(42, { profileId: 'finance' })]) {
    const r = await h.beforeTurn(turnOf(conv, mkTools()))
    if (r.action === 'transform') {
      assert.equal((r as { value: BeforeTurnHookPayload }).value.tools.length, mkTools().length)
    } else {
      assert.equal(r.action, 'continue')
    }
  }
})

test('tool_call：watchdog 会话内 bash/run_action/未知工具被 block；白名单工具放行；同 profile 直聊专属工具被 block；#1 放行', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  h.conversations.set(h.watchdogId, makeConversationSummary(h.watchdogId, { profileId: 'watchdog' }))
  h.conversations.set(777, makeConversationSummary(777, { profileId: 'watchdog' }))
  h.conversations.set(1, makeConversationSummary(1))

  for (const bad of ['bash', 'edit', 'write', 'subagent', 'SubagentWorkflow', 'run_action', 'evil_unknown']) {
    const r = await h.toolCall({ conversationId: h.watchdogId, callId: 'c', toolName: bad, input: {} })
    assert.equal(r.action, 'block', `${bad} 必须被阻断`)
  }
  const ok = await h.toolCall({ conversationId: h.watchdogId, callId: 'c', toolName: 'read', input: {} })
  assert.ok(ok.action === 'continue' || ok.action === 'transform')

  const peer = await h.toolCall({ conversationId: 777, callId: 'c', toolName: 'watchdog_abort', input: { conversationId: 55 } })
  assert.equal(peer.action, 'block', '同 profile 直聊不得使用专属工具')

  const root = await h.toolCall({ conversationId: 1, callId: 'c', toolName: 'bash', input: {} })
  assert.ok(root.action === 'continue' || root.action === 'transform', '#1 不受影响')
})

// ---------------------------------------------------------------------------
// 8. L2 语义
// ---------------------------------------------------------------------------

test('L2：同 tick 多异常合并一次投递（origin agent / followUp）；纯 human 异常零投递；模型异常不递归', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.tick([
    nativeProbe(55, { status: 'error' }),
    nativeProbe(56, { status: 'error' }),
    externalProbe('local', 'p1', { status: 'error' }),
  ])
  const wakes = h.recorded.submits.filter((s) => s.conversationId === h.watchdogId)
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0]!.origin, 'agent')
  assert.equal(wakes[0]!.whenBusy, 'followUp')
  assert.ok(wakes[0]!.text.includes('watchdog-playbooks'))
  assert.ok(wakes[0]!.text.includes('<findings>'), '事实须包裹防逃逸')

  // 模型异常不递归：watchdog 会话自身 failed 只通知（见用例 1），这里再验证
  // error 探针目标包含 watchdog 派生窗格时也不唤醒。
  await h.tick([
    externalProbe('local', 'pw-self', {
      status: 'error',
      facts: { kind: 'herdr', parentConversationId: h.watchdogId, pendingAskCount: 0 },
    }),
  ])
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 1)
})

// ---------------------------------------------------------------------------
// 9. 缺权威 seq
// ---------------------------------------------------------------------------

test('缺权威 seq：原生与外部目标都仅通知，不唤醒或变更', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  await h.tick([
    nativeProbe(55, { stateChangeSeq: undefined, status: 'working', stalledMs: 999_999_999 }),
    nativeProbe(66, { stateChangeSeq: undefined, status: 'blocked' }),
    externalProbe('local', 'p9', { stateChangeSeq: undefined, status: 'unreachable', consecutiveErrors: 9 }),
  ])
  assert.equal(h.recorded.aborts.length, 0)
  assert.equal(h.recorded.asks.length, 0, '缺 seq 的 blocked 不得 bridge')
  const wakes = h.recorded.submits.filter((s) => s.conversationId === h.watchdogId)
  assert.equal(wakes.length, 0, '缺权威水位的异常只能通知，不注入可执行模型')
  assert.ok(h.recorded.notifications.length >= 2)
  // 同 tick 内 native 缺 seq 事实不产生任何变更类动作：无 abort、无 Ask、无对目标注入。
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === 55 || s.conversationId === 66).length, 0)
})

// ---------------------------------------------------------------------------
// 10. track 失败显式通知（不静默吞错）
// ---------------------------------------------------------------------------

test('fire-and-forget 底层失败：显式通知，不静默降级', { timeout: 60_000 }, async () => {
  const boom = new Error('track exploded')
  const h = await makeHarness({
    ownership: () => 'helm',
    trackImpl: async (label, task) => {
      if (label.startsWith('watchdog:auto-abort')) throw boom
      return task()
    },
  })
  await h.tick([nativeProbe(55, { stalledMs: 600_000 })])
  assert.ok(
    h.recorded.notifications.some((n) => n.title.includes('后台任务失败') && n.body.includes('track exploded')),
    'track 失败必须显式通知',
  )
})

// ---------------------------------------------------------------------------
// 11. watchdogEnabled=false：tick 直接跳过
// ---------------------------------------------------------------------------

test('watchdogEnabled=false：探针不产生任何处置', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  h.config.watchdogEnabled = false
  await h.tick([nativeProbe(55, { stalledMs: 600_000 }), externalProbe('local', 'p1', { status: 'error' })])
  assert.equal(h.recorded.aborts.length, 0)
  assert.equal(h.recorded.submits.length, 0)
  assert.equal(h.recorded.notifications.length, 0)
})

// ---------------------------------------------------------------------------
// 12. service stop：挂起 bridge Ask 计入 liveTasks 并在 stop 时取消
// ---------------------------------------------------------------------------

test('service：bridge 挂起计入 liveTasks；stop 取消 pending Ask', { timeout: 60_000 }, async () => {
  const cancelled: string[] = []
  const recorded = makeRecorded()
  const conversations = new Map<number, ConversationSummary>([
    [55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 10 })],
  ])
  const docs = new MemoryDocStore()
  let releaseAsk: ((r: AskResult) => void) | undefined
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async (conversationId, text, o) => {
      recorded.submits.push({ conversationId, text, origin: o?.origin })
    },
    createConversation: async () => makeConversationSummary(1),
    listConversations: () => [...conversations.values()],
    getConversation: (id) => conversations.get(id)!,
    updateConversation: async (id) => conversations.get(id)!,
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: (spec) =>
      new Promise<AskResult>((resolve, reject) => {
        recorded.asks.push(spec)
        releaseAsk = (r) => resolve(r)
        setTimeout(() => reject(new HelmError('ask_wait_timeout', 'test timeout', 500)), 5_000)
      }),
    cancelAsk: async (askId) => {
      cancelled.push(askId)
    },
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: () => {},
  }
  const host = new PluginHost({ dataDir: mkdtempSync(join(tmpdir(), 'helm-saw-svc-')), host: backend, docs })
  const deps: SuperAgentDependencies = {
    dataDir: '/tmp/x',
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    getConversationDetail: async (id) => ({ ...makeConversationSummary(id), entries: [] }),
    listArtifacts: async () => [],
    abortConversation: async (id) => {
      recorded.aborts.push(id)
    },
    getConversationOwnership: () => 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }
  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => ({
      routerMode: true,
      mutedSources: '',
      watchdogEnabled: true,
      stalledAfterMs: 60_000,
      abortAfterMs: 600_000,
      errorThreshold: 3,
    }),
    getRouterConversationId: () => 100,
    getWatchdogConversationId: () => 200,
    track: async <T>(_label: string, task: () => Promise<T>) => task(),
  }
  await host.register({
    id: PLUGIN_ID,
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps, runtime)
    },
  })

  // 制造挂起 bridge：tick 后 Ask 未结算。
  await host.runHook('watchdog_tick', {
    timestamp: Date.now(),
    conversations: [...conversations.values()],
    probes: [nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(recorded.asks.length, 1)
  // liveTasks 应包含挂起 bridge → disable 被 409 拒绝。
  await assert.rejects(host.disable(PLUGIN_ID), (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks')
  // 结算 Ask 后可停用；stop 路径的取消在另一断言验证。
  releaseAsk?.({ id: recorded.asks[0]!.id ?? 'a', status: 'cancelled', answers: {} })
  await new Promise((resolve) => setImmediate(resolve))
  await host.disable(PLUGIN_ID)

  // 重建并验证 stop 主动取消 pending Ask（close 路径：dispose 不检查 liveTasks，直接 stop 服务）。
  releaseAsk = undefined
  recorded.asks.length = 0
  cancelled.length = 0
  // 新水位 seq=20：目标会话同步推进（与探针一致）。
  conversations.set(55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 20 }))
  const host2 = new PluginHost({ dataDir: mkdtempSync(join(tmpdir(), 'helm-saw-svc2-')), host: backend, docs })
  await host2.register({
    id: PLUGIN_ID,
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps, runtime)
    },
  })
  await host2.runHook('watchdog_tick', {
    timestamp: Date.now(),
    conversations: [...conversations.values()],
    probes: [nativeProbe(55, { status: 'blocked', stateChangeSeq: 20 })],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(recorded.asks.length, 1)
  // dispose（close 语义）：service stop 必须主动取消挂起的自有 Ask。
  await host2.dispose()
  assert.ok(cancelled.some((id) => id.startsWith('superagent-watchdog-bridge-')), 'stop 必须取消自有 pending Ask')
})

// ---------------------------------------------------------------------------
// 13. 针对性负向回归（本轮修复配套）
// ---------------------------------------------------------------------------

test('回归：去重文档损坏（未知动作/非法 seq/非法结构）显式 superagent_doc_corrupt 拒绝，不静默回空重放', { timeout: 60_000 }, async () => {
  const corruptBodies: unknown[] = [
    { version: 1, fired: { garbage: 42 } }, // 键下不是动作表
    { version: 1, fired: { 'k': { hack: { seq: 1, at: 1 } } } }, // 未知动作名
    { version: 1, fired: { 'k': { notify: { seq: -2, at: 1 } } } }, // seq 非法（非 -1 哨兵）
    { version: 1, fired: { 'k': { notify: { seq: 1.5, at: 1 } } } }, // seq 非整数
    { version: 1, fired: { 'k': { notify: { seq: 1, at: -1 } } } }, // at 负数
    { version: 2, fired: {} }, // 版本非法
    null, // 非对象
  ]
  for (const body of corruptBodies) {
    const h = await makeHarness()
    h.docs.store.set(`${PLUGIN_ID}:watchdog-dedup`, body)
    await assert.rejects(
      h.tick([nativeProbe(55, { status: 'error' })]),
      (err: unknown) => err instanceof HelmError && err.code === 'superagent_doc_corrupt',
      `损坏文档 ${JSON.stringify(body)} 必须显式拒绝`,
    )
    assert.equal(h.recorded.aborts.length, 0, '拒绝后零处置')
  }
  // 合法文档（seq=-1 哨兵）不拒绝。
  const hOk = await makeHarness()
  hOk.docs.store.set(`${PLUGIN_ID}:watchdog-dedup`, {
    version: 1,
    fired: { 'k': { notify: { seq: -1, at: 1 } } },
  })
  await hOk.tick([nativeProbe(55, { status: 'working', stalledMs: 100 })])
})

test('回归：未标 targetKind 的数字 pane / 数字 targetId 不猜类别：零自动控制零唤醒，仅只读告知', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  // 未标 targetKind、targetId 是纯数字（旧代码会猜成会话 55 并自动干预）。
  await h.tick([
    { ...nativeProbe(55, { stalledMs: 999_999_999, status: 'error' }), targetKind: undefined, conversationId: undefined },
  ])
  assert.equal(h.recorded.aborts.length, 0, '不得猜会话中止')
  assert.equal(h.recorded.asks.length, 0)
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === h.watchdogId).length, 0, '不得唤醒执行模型')
  assert.equal(h.recorded.submits.filter((s) => s.conversationId === 55).length, 0, '不得向目标注入')
  assert.ok(h.recorded.notifications.some((n) => n.body.includes('未声明 targetKind')), '应只读告知')

  // 标了 conversation 但无显式 conversationId：同样只读告知。
  const h2 = await makeHarness()
  await h2.tick([
    { ...nativeProbe(55, { stalledMs: 999_999_999 }), conversationId: undefined },
  ])
  assert.equal(h2.recorded.aborts.length, 0)
  assert.equal(h2.recorded.submits.filter((s) => s.conversationId === h2.watchdogId).length, 0)
  assert.ok(h2.recorded.notifications.some((n) => n.body.includes('缺少显式 conversationId')))
})

test('回归：过期 native seq（探针 10、现查 11）不中止新回合，仅放弃通知', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  // 现查会话已推进到 seq=11，探针仍报 10：旧授权不得中止新回合。
  h.conversations.set(55, makeConversationSummary(55, { status: 'working', stateChangeSeq: 11 }))
  await h.tick([nativeProbe(55, { stalledMs: 600_001, status: 'working', stateChangeSeq: 10 })])
  assert.equal(h.recorded.aborts.length, 0, '过期水位不得中止新回合')
  assert.ok(h.recorded.notifications.some((n) => n.title.includes('跳过自动中止') && n.body.includes('已过期')))
})

test('回归：wake 提交失败/未就绪不消耗水位，下一 tick 补投后恰占一次坑', { timeout: 60_000 }, async () => {
  const sharedDocs = new MemoryDocStore()
  const recorded = makeRecorded()
  // 第一阶段：watchdog 会话未就绪（id undefined）→ 显式告知、不投递、不写水位。
  const hNotReady = await makeHarnessWithDocs(sharedDocs, recorded, {
    ownership: () => 'helm',
    watchdogId: undefined,
  })
  await hNotReady.tick([nativeProbe(55, { status: 'error', stateChangeSeq: 5 })])
  assert.equal(recorded.submits.filter((s) => s.conversationId === 200).length, 0, '未就绪不投递')
  const doc1 = sharedDocs.store.get(`${PLUGIN_ID}:watchdog-dedup`) as
    | { fired: Record<string, Record<string, unknown>> }
    | undefined
  const wakeMarks1 = Object.values(doc1?.fired ?? {}).filter((a) => 'wake' in a)
  assert.equal(wakeMarks1.length, 0, '未就绪不消耗 wake 水位')

  // 第二阶段：就绪后（同一持久 docs），同水位补投一次并占坑；再 tick 不重复。
  const h2 = await makeHarnessWithDocs(sharedDocs, makeRecorded(), { ownership: () => 'helm' })
  await h2.tick([nativeProbe(55, { status: 'error', stateChangeSeq: 5 })])
  assert.equal(h2.recorded.submits.filter((s) => s.conversationId === 200).length, 1, '水位未被消耗 → 恰好补投一次')
  await h2.tick([nativeProbe(55, { status: 'error', stateChangeSeq: 5 })])
  assert.equal(h2.recorded.submits.filter((s) => s.conversationId === 200).length, 1, '占坑后不重复')
})

test('回归：真实异常在大量正常 probe 之后仍被投递（无截断 cap、只传 due 异常）', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  // 60 条正常 working 事实 + 1 条真异常：旧代码把全部 findings 截断到 30，真异常可能被吞。
  const probes: WatchdogProbe[] = []
  for (let i = 1; i <= 60; i++) {
    probes.push(nativeProbe(i + 1000, { status: 'working', stalledMs: 1000 }))
  }
  probes.push(nativeProbe(55, { status: 'error', stalledMs: 1000 })) // 真异常
  h.conversations.set(55, makeConversationSummary(55, { status: 'error' }))
  await h.tick(probes)
  const wakes = h.recorded.submits.filter((s) => s.conversationId === h.watchdogId)
  assert.equal(wakes.length, 1)
  assert.ok(wakes[0]!.text.includes('conversation:55'), '真异常必须在投递内容中')
  // 只传 due 异常：正常 working 事实不得挤占（60 条正常不进入 findings 列表）。
  assert.ok(!wakes[0]!.text.includes('conversation:1001'), '正常事实不应随投递')
})

test('回归：stop 取消挂起 Ask 失败时显式错误（不吞），已结算/404 可忽略', { timeout: 60_000 }, async () => {
  const cancelled: string[] = []
  let failMode: 'hard' | 'settled' | 'missing' | undefined
  const recorded = makeRecorded()
  const conversations = new Map<number, ConversationSummary>([
    [55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: 10 })],
  ])
  const docs = new MemoryDocStore()
  let releaseAsk: ((r: AskResult) => void) | undefined
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => makeConversationSummary(1),
    listConversations: () => [...conversations.values()],
    getConversation: (id) => conversations.get(id)!,
    updateConversation: async (id) => conversations.get(id)!,
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: (spec) =>
      new Promise<AskResult>((resolve, reject) => {
        recorded.asks.push(spec)
        releaseAsk = (r) => resolve(r)
        setTimeout(() => reject(new HelmError('ask_wait_timeout', 'test timeout', 500)), 5_000)
      }),
    cancelAsk: async (askId) => {
      cancelled.push(askId)
      if (failMode === 'hard') throw new HelmError('store_io_error', 'disk exploded', 500)
      if (failMode === 'settled') throw new HelmError('ask_already_settled', '已结算', 409)
      if (failMode === 'missing') throw new HelmError('not_found', '不存在', 404)
    },
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: () => {},
  }
  const mkHost = async () => {
    const host = new PluginHost({ dataDir: mkdtempSync(join(tmpdir(), 'helm-saw-cancel-')), host: backend, docs })
    await host.register({
      id: PLUGIN_ID,
      definePlugin(ctx) {
        registerSuperAgentWatchdog(ctx, deps, runtime)
      },
    })
    return host
  }
  const deps: SuperAgentDependencies = {
    dataDir: '/tmp/x',
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    getConversationDetail: async (id) => ({ ...makeConversationSummary(id), entries: [] }),
    listArtifacts: async () => [],
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }
  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => ({
      routerMode: true,
      mutedSources: '',
      watchdogEnabled: true,
      stalledAfterMs: 60_000,
      abortAfterMs: 600_000,
      errorThreshold: 3,
    }),
    getRouterConversationId: () => 100,
    getWatchdogConversationId: () => 200,
    track: async <T>(_label: string, task: () => Promise<T>) => task(),
  }

  // 硬失败：stop 聚合显式错误（plugin_service_stop_failed 包含 watchdog_ask_cancel_failed）。
  failMode = 'hard'
  const hostHard = await mkHost()
  await hostHard.runHook('watchdog_tick', {
    timestamp: Date.now(),
    conversations: [...conversations.values()],
    probes: [nativeProbe(55, { status: 'blocked', stateChangeSeq: 10 })],
  })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    hostHard.dispose(),
    (err: unknown) =>
      err instanceof HelmError &&
      (err.code === 'plugin_dispose_failed' || err.code === 'plugin_service_stop_failed'),
    '取消硬失败必须显式上抛',
  )

  // 事实性终态（已结算/404）：可忽略不报错（同一 host 两轮挂起逐一验证）。
  for (const mode of ['settled', 'missing'] as const) {
    failMode = mode
    cancelled.length = 0
    // 每轮新 host + 新 docs + 新水位，避免 ask_id_conflict 干扰。
    const seq = mode === 'settled' ? 11 : 12
    conversations.set(55, makeConversationSummary(55, { status: 'blocked', stateChangeSeq: seq }))
    const host2 = new PluginHost({
      dataDir: mkdtempSync(join(tmpdir(), 'helm-saw-cancel2-')),
      host: backend,
      docs: new MemoryDocStore(),
    })
    await host2.register({
      id: PLUGIN_ID,
      definePlugin(ctx) {
        registerSuperAgentWatchdog(ctx, deps, runtime)
      },
    })
    await host2.runHook('watchdog_tick', {
      timestamp: Date.now(),
      conversations: [...conversations.values()],
      probes: [nativeProbe(55, { status: 'blocked', stateChangeSeq: seq })],
    })
    await new Promise((resolve) => setImmediate(resolve))
    await host2.dispose() // 事实性终态不抛错
    releaseAsk = undefined
  }
})



test('唤醒前重新核对归属和水位，人类接管或过期事实不投递模型', { timeout: 60_000 }, async () => {
  const h = await makeHarness({ ownership: (id) => id === 55 ? 'human' : 'helm' })
  h.conversations.set(55, makeConversationSummary(55, { status: 'error' }))
  h.conversations.set(66, makeConversationSummary(66, { status: 'error', stateChangeSeq: 11 }))
  await h.tick([
    nativeProbe(55, { status: 'error', stateChangeSeq: 10 }),
    nativeProbe(66, { status: 'error', stateChangeSeq: 10 }),
  ])
  assert.deepEqual(h.recorded.submits, [])
  assert.deepEqual(h.recorded.aborts, [])
})

test('不同 tick 在同一权威水位提交尚未完成时也只投递一次', { timeout: 60_000 }, async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending: Promise<unknown>[] = []
  const h = await makeHarness({
    trackImpl: async (label, task) => {
      const run = (async () => { await gate; return task() })()
      pending.push(run)
      return run
    },
  })
  h.conversations.set(55, makeConversationSummary(55, { status: 'error' }))
  try {
    await h.tick([nativeProbe(55, { status: 'error' })])
    await h.tick([nativeProbe(55, { status: 'error' })])
    assert.equal(pending.length, 1)
    release()
    await Promise.all(pending)
    assert.equal(h.recorded.submits.length, 1)
  } finally {
    release()
    await Promise.all(pending)
  }
})

test('授权桥不能为中枢等受保护入口创建自动干预问询', { timeout: 60_000 }, async () => {
  const h = await makeHarness({ ownership: () => 'helm' })
  h.conversations.set(h.routerId, makeConversationSummary(h.routerId, { profileId: 'superagent', status: 'blocked' }))
  await h.tick([nativeProbe(h.routerId, { status: 'blocked' })])
  assert.deepEqual(h.recorded.asks, [])
  assert.deepEqual(h.recorded.aborts, [])
  assert.deepEqual(h.recorded.submits, [])
})
