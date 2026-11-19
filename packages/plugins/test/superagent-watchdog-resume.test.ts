/**
 * builtin:superagent Watchdog §3.2 专属单测：workflow_run 失败探针自动断点续跑
 * （PluginHost + 受控注入依赖，不起真实内核；builtin:workflow 以受控桩插件承载）。
 *
 * 覆盖：
 * 1. 冷却退避：autoResumeCount 0/1/2 → 2/5/15 分钟；未满冷却零动作（不 invoke、
 *    不通知、不唤醒 L2）；期满调用 invokeAction('builtin:workflow','run',
 *    {resumeFromRunId, conversationId}) 并成功通知。
 * 2. 严格仅 helmx 归属：human/bot 探针只通知不续跑。
 * 3. 事实残缺 / 缺权威 stateChangeSeq：notify_only，绝不猜造续跑参数。
 * 4. autoResumeCount 达上限（3）：不再自动续跑，限频告知一次。
 * 5. 每 tick 最多恢复 1 个，failedAt 升序（最旧失败优先）。
 * 6. invoke 失败：错误通知 + 推迟重试（同水位不刷屏重试）。
 * 7. in-flight 防重叠：invoke 未结算期间相邻 tick 不重复调用；防重权威在探针
 *    侧 resumedByRunId/stateChangeSeq 机制（续跑成功后旧 Run 不再上报）。
 */
import { createPluginBuildProvider } from '@helmx/plugin-build'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmxError,
  type ConversationSummary,
  type MaybePromise,
  type PluginDefinition,
} from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../../kernel/src/plugins/index.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import {
  DIAGNOSTICS_COLLECT_EVENT,
  type DiagnosticsCollection,
  type WatchdogProbe,
} from '../src/diagnostics.js'
import { registerSuperAgentWatchdog } from '../src/superagent/watchdog.js'
import type {
  SuperAgentConfig,
  SuperAgentWatchdogRuntime,
} from '../src/superagent/contracts.js'
import {
  MemoryDocStore,
  makeConversationSummary as baseConversationSummary,
} from './helpers/plugin-test-env.js'

const SUPERAGENT_ID = 'builtin:superagent'
const WORKFLOW_ID = 'builtin:workflow'

const makeConversationSummary = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  baseConversationSummary({ id, model: 'faux/faux-1', stateChangeSeq: 10, ...over })

/** workflow run 动作受控实现：可换成抛错 / 挂起闸门。 */
type WorkflowRunImpl = (input: Record<string, unknown>) => Promise<Record<string, unknown>>

async function makeResumeHarness() {
  const notifications: Array<{ level: string; title: string; body: string }> = []
  const workflowRuns: Array<Record<string, unknown>> = []
  let workflowRunImpl: WorkflowRunImpl = async () => ({ run: { id: 'new-run' } })

  const conversations = new Map<number, ConversationSummary>()
  conversations.set(200, makeConversationSummary(200, { profileId: 'watchdog', title: '巡检看门狗' }))
  conversations.set(100, makeConversationSummary(100, { profileId: 'superagent', title: 'SuperAgent 中枢' }))
  conversations.set(1, makeConversationSummary(1, { title: 'Personal Assistant' }))
  conversations.set(55, makeConversationSummary(55, { title: '工作流宿主会话' }))

  const eventListeners = new Map<string, Array<(payload: unknown) => MaybePromise<void>>>()
  const backend: PluginHostBackend = {
    ...hostBackendStub(),
    submitInput: async () => {},
    listConversations: () => [...conversations.values()],
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    getConversationDetail: async (id: number) => ({ ...(conversations.get(id) ?? makeConversationSummary(id)), entries: [] }),
    getConversationOwnership: (id: number) => (id === 1 ? 'human' : 'helmx'),
    onEvent: (type: string, listener: (payload: unknown) => MaybePromise<void>) => {
      const list = eventListeners.get(type) ?? []
      list.push(listener)
      eventListeners.set(type, list)
      return () => {
        const cur = eventListeners.get(type)
        if (cur === undefined) return
        const idx = cur.indexOf(listener)
        if (idx >= 0) cur.splice(idx, 1)
      }
    },
    emitEvent: async (type: string, payload: unknown) => {
      if (type === 'notification') {
        const p = payload as { level?: string; title?: string; body?: string }
        notifications.push({ level: p.level ?? 'info', title: p.title ?? '', body: p.body ?? '' })
      }
      if (type !== DIAGNOSTICS_COLLECT_EVENT) return
      for (const listener of [...(eventListeners.get(type) ?? [])]) {
        await listener(payload)
      }
    },
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-superagent-watchdog-resume-'))
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
  })

  const config: SuperAgentConfig = {
    routerMode: true,
    mutedSources: '',
    watchdogEnabled: true,
    stalledAfterMs: 60_000,
    abortAfterMs: 600_000,
    errorThreshold: 3,
  }
  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => config,
    getRouterConversationId: () => 100,
    getWatchdogConversationId: () => 200,
    track: <T,>(label: string, task: () => MaybePromise<T>): Promise<T> => {
      void label
      return Promise.resolve(task())
    },
  }

  await host.register({
    id: SUPERAGENT_ID,
    name: 'SuperAgent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, runtime)
    },
  } satisfies PluginDefinition)

  await host.register({
    id: WORKFLOW_ID,
    name: 'Workflow (test stub)',
    definePlugin(ctx) {
      ctx.action({
        id: 'run',
        description: '受控工作流运行桩（记录入参；行为由测试替换）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        outputSchema: {
          type: 'object',
          properties: { run: { type: 'object' } },
          required: ['run'],
          additionalProperties: false,
        },
        async handler(input) {
          workflowRuns.push(structuredClone(input as Record<string, unknown>))
          return workflowRunImpl(input as Record<string, unknown>)
        },
      })
    },
  } satisfies PluginDefinition)

  async function tick(externalProbes: WatchdogProbe[] = []): Promise<void> {
    let release: (() => void) | undefined
    if (externalProbes.length > 0) {
      const listener = (raw: unknown) => {
        const collection = raw as DiagnosticsCollection
        collection.probes.push(...structuredClone(externalProbes))
      }
      const list = eventListeners.get(DIAGNOSTICS_COLLECT_EVENT) ?? []
      list.push(listener)
      eventListeners.set(DIAGNOSTICS_COLLECT_EVENT, list)
      release = () => {
        const cur = eventListeners.get(DIAGNOSTICS_COLLECT_EVENT) ?? []
        const idx = cur.indexOf(listener)
        if (idx >= 0) cur.splice(idx, 1)
      }
    }
    try {
      await host.invokeAction(SUPERAGENT_ID, 'watchdog_tick', {})
    } finally {
      release?.()
    }
    await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    host,
    notifications,
    workflowRuns,
    setWorkflowRunImpl(impl: WorkflowRunImpl) {
      workflowRunImpl = impl
    },
    tick,
    async dispose() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 构造 workflow_run 失败探针（stateChangeSeq 契约 = autoResumeCount）。 */
function workflowRunProbe(
  runId: string,
  over: {
    conversationId?: number
    failedAgoMs?: number
    autoResumeCount?: number
    ownedBy?: WatchdogProbe['ownedBy']
    stateChangeSeq?: number | null
    factsOverride?: Record<string, unknown>
  } = {},
): WatchdogProbe {
  const autoResumeCount = over.autoResumeCount ?? 0
  const conversationId = over.conversationId ?? 55
  const facts: Record<string, unknown> = {
    kind: 'workflow_run',
    runId,
    conversationId,
    failedAt: Date.now() - (over.failedAgoMs ?? 3 * 60_000),
    autoResumeCount,
    ...(over.factsOverride ?? {}),
  }
  return {
    targetId: `workflow:${runId}`,
    targetKind: 'external',
    nodeId: 'local',
    ownedBy: over.ownedBy ?? 'helmx',
    status: 'error',
    ...(over.stateChangeSeq === null ? {} : { stateChangeSeq: over.stateChangeSeq ?? autoResumeCount }),
    facts,
  }
}

test('冷却未满：零动作（不 invoke、不通知、不唤醒 L2）', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  await h.tick([workflowRunProbe('run-young', { failedAgoMs: 30_000, autoResumeCount: 0 })])
  assert.equal(h.workflowRuns.length, 0)
  assert.equal(h.notifications.length, 0)
  await h.dispose()
})

test('冷却期满：按 2/5/15 分钟梯度恰好触发一次 invokeAction({resumeFromRunId, conversationId})', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  // count=1 冷却 5 分钟：3 分钟前失败 → 未满。
  await h.tick([workflowRunProbe('run-b1', { failedAgoMs: 3 * 60_000, autoResumeCount: 1 })])
  assert.equal(h.workflowRuns.length, 0)
  // count=1：6 分钟前失败 → 已满 5 分钟。
  await h.tick([workflowRunProbe('run-b2', { failedAgoMs: 6 * 60_000, autoResumeCount: 1 })])
  assert.deepEqual(h.workflowRuns, [{ resumeFromRunId: 'run-b2', conversationId: 55 }])
  // count=2 冷却 15 分钟：16 分钟前失败 → 已满。
  await h.tick([workflowRunProbe('run-b3', { failedAgoMs: 16 * 60_000, autoResumeCount: 2 })])
  assert.deepEqual(h.workflowRuns[h.workflowRuns.length - 1], { resumeFromRunId: 'run-b3', conversationId: 55 })
  assert.ok(h.notifications.some((n) => n.title === 'Watchdog 已自动续跑失败工作流' && n.body.includes('run-b2')))
  assert.ok(h.notifications.some((n) => n.title === 'Watchdog 已自动续跑失败工作流' && n.body.includes('run-b3')))
  // 续跑成功后旧 Run 不再上报（resumedByRunId 契约）：无新增调用（全程恰好 2 次）。
  await h.tick([])
  assert.equal(h.workflowRuns.length, 2)
  await h.dispose()
})

test('严格仅 helmx 归属：human/bot 探针只通知不续跑', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  await h.tick([
    workflowRunProbe('run-human', { ownedBy: 'human' }),
    workflowRunProbe('run-bot', { ownedBy: 'bot' }),
  ])
  assert.equal(h.workflowRuns.length, 0)
  assert.equal(h.notifications.filter((n) => n.title === 'Watchdog 巡检告警').length, 2)
  assert.ok(h.notifications.every((n) => !n.body.includes('resumeFromRunId')))
  await h.dispose()
})

test('事实残缺或缺权威 seq：notify_only，不猜造续跑参数', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  await h.tick([
    workflowRunProbe('run-no-runid', { factsOverride: { runId: undefined } }),
    workflowRunProbe('run-no-conv', { factsOverride: { conversationId: 0 } }),
    workflowRunProbe('run-no-failedat', { factsOverride: { failedAt: undefined } }),
    workflowRunProbe('run-no-count', { factsOverride: { autoResumeCount: undefined } }),
    workflowRunProbe('run-no-seq', { stateChangeSeq: null }),
  ])
  assert.equal(h.workflowRuns.length, 0)
  assert.equal(h.notifications.filter((n) => n.title === 'Watchdog 巡检告警').length, 5)
  await h.dispose()
})

test('autoResumeCount 达上限：不再自动续跑，限频告知恰一次', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  const probe = workflowRunProbe('run-exhausted', { failedAgoMs: 60 * 60_000, autoResumeCount: 3 })
  await h.tick([probe])
  await h.tick([probe])
  assert.equal(h.workflowRuns.length, 0)
  const alerts = h.notifications.filter((n) => n.title === 'Watchdog 巡检告警')
  assert.equal(alerts.length, 1)
  assert.ok(alerts[0]!.body.includes('次数用尽'))
  await h.dispose()
})

test('每 tick 最多恢复 1 个：failedAt 升序（最旧失败优先），其余等下一轮', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  const older = workflowRunProbe('run-old', { failedAgoMs: 10 * 60_000 })
  const newer = workflowRunProbe('run-new', { failedAgoMs: 4 * 60_000 })
  await h.tick([newer, older])
  assert.deepEqual(h.workflowRuns, [{ resumeFromRunId: 'run-old', conversationId: 55 }])
  // 旧 Run 续跑成功后不再上报；新 Run 下一 tick 接续恢复。
  await h.tick([newer])
  assert.deepEqual(h.workflowRuns[1], { resumeFromRunId: 'run-new', conversationId: 55 })
  await h.dispose()
})

test('invoke 失败：错误通知 + 推迟重试（相邻 tick 不刷屏重试）', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  h.setWorkflowRunImpl(async () => {
    throw new HelmxError('workflow_not_resumable', '账本缺失，无法断点恢复', 409, { runId: 'x' })
  })
  const probe = workflowRunProbe('run-fail', { failedAgoMs: 3 * 60_000 })
  await h.tick([probe])
  assert.equal(h.workflowRuns.length, 1)
  const errors = h.notifications.filter((n) => n.title === 'Watchdog 工作流自动续跑失败')
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.body.includes('workflow_not_resumable'))
  // 推迟窗口内（10 分钟）同探针不重试。
  await h.tick([probe])
  assert.equal(h.workflowRuns.length, 1)
  await h.dispose()
})

test('in-flight 防重叠：invoke 未结算期间相邻 tick 不重复调用', { timeout: 60_000 }, async () => {
  const h = await makeResumeHarness()
  let releaseGate: (() => void) | undefined
  h.setWorkflowRunImpl(
    () =>
      new Promise((resolve) => {
        releaseGate = () => resolve({ run: { id: 'gated-run' } })
      }),
  )
  const probe = workflowRunProbe('run-gate', { failedAgoMs: 3 * 60_000 })
  await h.tick([probe])
  assert.equal(h.workflowRuns.length, 1)
  // invoke 仍挂起：同探针再 tick 不得重复调用。
  await h.tick([probe])
  assert.equal(h.workflowRuns.length, 1)
  releaseGate?.()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  // 结算成功后旧 Run 不再上报（resumedByRunId 契约）：无新增调用。
  await h.tick([])
  assert.equal(h.workflowRuns.length, 1)
  await h.dispose()
})
