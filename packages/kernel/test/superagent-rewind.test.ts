/**
 * builtin:superagent 编辑重发（helm.rewind）× RecallGraph 联动验收。
 *
 * 背景：内核 submitInput replaceFromEntryId 原生路径写入 helm.rewind 截断标记
 * （kind:'helm.rewind'，data.omittedInputIds 携带被覆盖输入 ID），并作为
 * conversation.entry 事件广播。superagent 经组合层注入的订阅端口监听该标记，
 * 删除对应会话中 inputIds 相交的 RecallGraph 节点，并用 per-worker rewind
 * 纪元防止在途结算把被覆盖的旧回合写回图谱。
 *
 * 组合纪律：真实 PluginHost + 受控 backend（真实插件代码路径，与
 * plugins-fixes 同基座）+ 真实 EventHub（订阅端口转交链路）。事件回归依赖的
 * rewind 写入由受控 fixture 模拟（本 worktree 无 runtime 编辑重发实现——主代理
 * 合入 runtime 后 conversation.entry 由真实 tracker 发出，此处标注：FIXTURE）。
 *
 * 诚实性纪律：所有断言针对真实 doc 句柄与通知/提交记录；不 skip、不吞错。
 * runner: tsx --test；显式 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  HelmError,
  type ConversationSummary,
  type TurnSettledPayload,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { EventHub } from '../src/runtime/events.js'
import { ProfileService, SkillService } from '../src/services/index.js'
import { createSuperAgentPlugin, REWIND_REPLAY_PAGE_SIZE } from '../src/builtin-plugins/superagent.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import {
  rewindOmittedInputIds,
  removeRecallNodesByInputs,
  assertRecallDoc,
} from '../src/builtin-plugins/superagent.js'
import type { ConversationEntry } from '@helm/protocol'

// ---------------------------------------------------------------------------
// 受控基座（真实 PluginHost + 真实插件 + 受控 backend + 真实 EventHub）
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

interface DetailPage {
  entries: ConversationEntry[]
  nextCursor?: string
}

interface HarnessOptions {
  /** 详情分页fixture：conversationId -> 页序列（按 nextCursor 逐页取）。 */
  detailPages?: Map<number, DetailPage[]>
  /** 详情 API 失败注入。 */
  detailError?: (id: number) => Error | undefined
}

interface TestHarness {
  host: PluginHost
  backend: {
    conversations: Map<number, ConversationSummary>
    notifications: Array<{ title: string; body: string }>
    submits: Array<{ conversationId: number; origin?: string; text?: string }>
  }
  docs: MemoryDocStore
  hub: EventHub
  /** 发布 conversation.entry（真实 EventHub.buildEvent 校验 + 脱敏 + 订阅转交）。 */
  publishEntry(conversationId: number, entry: ConversationEntry): void
  readRecall(): { nodes: Array<{ id: string; conversationId: number; inputIds: string[] }> }
  /** 写入 recall doc 原始值（模拟停用前已结算的历史节点；完整节点契约）。 */
  seedRecallNode(node: { id: string; conversationId: number; inputIds: string[] }): void
  detailCalls: number[]
  routerId(): number
  workerReportSubmits(): number
  turnSettled(payload: TurnSettledPayload): Promise<void>
  close(): Promise<void>
}

async function makeHarness(opts: HarnessOptions = {}): Promise<TestHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-rewind-'))
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1, { tags: ['root'] }))
  const notifications: Array<{ title: string; body: string }> = []
  const submits: Array<{ conversationId: number; origin?: string; text?: string }> = []
  const detailCalls: number[] = []
  const profilesSvc = new ProfileService(dataDir)
  const skillsSvc = new SkillService(dataDir)
  await profilesSvc.ensureDefault()
  const profiles = {
    list: () => profilesSvc.list(),
    get: (id: string) => profilesSvc.get(id),
    getSystem: (id: string) => profilesSvc.getSystem(id),
    save: (p: Parameters<typeof profilesSvc.save>[0]) => profilesSvc.save(p),
    directory: async (id: string) => join(dataDir, 'profiles', id),
  }
  const skills = {
    list: () => skillsSvc.list(),
    readFile: (skillId: string, path?: string) => skillsSvc.readFile(skillId, path),
    directory: async (id: string) => join(dataDir, 'skills', id),
    ensureSkill: (asset: Parameters<typeof skillsSvc.ensureSkill>[0]) => skillsSvc.ensureSkill(asset),
  }
  const secrets = {
    get: async () => undefined,
    set: async () => { throw new HelmError('unsupported', 'fixture 只读 secrets', 501) },
    delete: async () => { throw new HelmError('unsupported', 'fixture 只读 secrets', 501) },
    addRedaction: () => () => {},
  }
  const backend: PluginHostBackend = {
    async dispatchTrigger() {},
    async submitInput(conversationId, text, options) {
      submits.push({ conversationId, origin: options?.origin, text })
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const summary = makeConversation(id, {
        title: init.title ?? 'new',
        profileId: init.profileId ?? 'assistant',
        ...(init.tags !== undefined ? { tags: init.tags } : {}),
        ...(init.parentConversationId !== undefined ? { parentConversationId: init.parentConversationId } : {}),
      })
      conversations.set(id, summary)
      return summary
    },
    listConversations() { return [...conversations.values()] },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() { return () => {} },
    markConversationOwnership() {},
    async createAsk() { throw new HelmError('unsupported', 'test', 400) },
    async cancelAsk() {},
    registerAskSeqResolver() { return () => {} },
    onEvent() { return () => {} },
    abortConversation: async () => {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    isClosing: () => false,
    profiles,
    skills,
    secrets,
    setPluginConfig: async () => {},
    nodeIpc: undefined,
    redact: (t: string) => t,
    redactText: (t: string) => t,
    buildSpawnEnv: () => ({}),
    async getConversationDetail(id: number, options?: { cursor?: string }) {
      detailCalls.push(id)
      const failure = opts.detailError?.(id)
      if (failure !== undefined) throw failure
      const pages = opts.detailPages?.get(id) ?? [{ entries: [] }]
      // fixture cursor 直接用页下标数字（编码差异由实现层负责，此处验证翻页链路）。
      const index = options?.cursor !== undefined ? Number(options.cursor) : 0
      const page = pages[Number.isInteger(index) ? Math.min(index, pages.length - 1) : 0]!
      const summary = conversations.get(id) ?? makeConversation(id)
      return {
        ...summary,
        entries: page.entries,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }
    },
    async listArtifacts() { return [] },
    async getArtifact() { throw new HelmError('not_found', '无产物', 404) },
    async completeText() { throw new HelmError('unsupported', '本 fixture 无模型', 501) },
    executionEnv: () => { throw new HelmError('unsupported', '本 fixture 无执行环境', 501) },
    withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() },
    async atomicWriteFile() { throw new HelmError('unsupported', '本 fixture 无原子写', 501) },
    async refreshModels() { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) },
    async resolveSpawnTarget() { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) },
    listActiveSpawnExecutions: () => [],
    async probeNodeFs() { throw new HelmError('unsupported', '本 fixture 不探测节点 fs', 501) },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
    emitEvent(type, payload) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string })
    },
  }
  const docs = new MemoryDocStore()
  const host = new PluginHost({ dataDir, host: backend, docs })

  const hub = new EventHub({ initialSeq: 0, snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [] }) })

  // 与 app.ts 组合层同构：conversation.entry 经通用事件端口转交（真实 EventHub 帧）。
  backend.onEvent = (type: string, listener: (payload: unknown) => void | Promise<void>) => {
    if (type !== 'conversation.entry') return () => {}
    return hub.subscribe((frame) => {
      const event = frame.event
      if (event.type !== 'conversation.entry' || !('entry' in event)) return
      void listener(event)
    })
  }
  await host.register(createSuperAgentPlugin(), { enabled: true })
  const routerId = ((docs.store.get('builtin:superagent:index') as { routerConversationId?: number } | undefined)?.routerConversationId)
  return {
    host,
    backend: { conversations, notifications, submits },
    docs,
    hub,
    detailCalls,
    routerId: () => {
      assert.ok(routerId !== undefined, 'router 会话应已自举')
      return routerId
    },
    workerReportSubmits: () => submits.filter((s) => s.conversationId === routerId && s.origin === 'agent').length,
    publishEntry: (conversationId, entry) => {
      hub.publish('conversation.entry', { conversationId, entry })
    },
    readRecall() {
      const doc = docs.store.get('builtin:superagent:recall-graph') as { nodes: unknown[] } | undefined
      return (doc ?? { nodes: [] }) as { nodes: Array<{ id: string; conversationId: number; inputIds: string[] }> }
    },
    seedRecallNode(node) {
      const current = (docs.store.get('builtin:superagent:recall-graph') as { nodes: unknown[] } | undefined) ?? { nodes: [] }
      const next = {
        version: 1,
        nodes: [
          ...current.nodes,
          {
            id: node.id,
            conversationId: node.conversationId,
            profileId: 'assistant',
            completionSeq: Number(node.id.split(':')[1]),
            inputIds: node.inputIds,
            outcome: 'completed',
            summary: `节点 ${node.id}`,
            artifacts: [],
            keywords: [],
            createdAt: 1,
          },
        ],
      }
      docs.set('builtin:superagent:recall-graph', next)
    },
    async turnSettled(payload) {
      await host.runHook('turn_settled', payload)
    },
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 载荷工厂
// ---------------------------------------------------------------------------

function settledPayload(over: {
  conversationId: number
  completionSeq: number
  inputs: Array<{ id: string; origin: 'human' | 'agent' | 'trigger' }>
}): TurnSettledPayload {
  const now = Date.now()
  return {
    conversation: makeConversation(over.conversationId, {
      tags: ['worker'],
      completionSeq: over.completionSeq,
      status: 'done',
      updatedAt: now,
    }),
    inputs: over.inputs.map((i) => ({ id: i.id, text: `输入 ${i.id}`, origin: i.origin, createdAt: now })),
    outcome: 'completed',
    settledAt: now,
  }
}

/** FIXTURE：模拟内核原生编辑重发写入的 helm.rewind 截断标记（主代理合入
 * runtime 后由真实 tracker 经 conversation.entry 广播同一形状）。 */
function rewindMarker(entryId: number, omittedInputIds: string[], fromEntryId = 1, throughEntryId = entryId - 1): ConversationEntry {
  return {
    id: String(entryId),
    kind: 'helm.rewind',
    data: { fromEntryId, throughEntryId, omittedEntryIds: [], omittedInputIds, createdAt: Date.now() },
  }
}

/** 登记一个 Worker（真实 invokeAction dispatch_worker 路径）。 */
async function dispatchWorker(h: TestHarness, prompt: string): Promise<number> {
  const result = (await h.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt }, undefined)) as {
    workerConversationId: number
  }
  return result.workerConversationId
}

// ---------------------------------------------------------------------------
// 1. 纯函数：rewindOmittedInputIds / removeRecallNodesByInputs / assertRecallDoc
// ---------------------------------------------------------------------------

test('rewindOmittedInputIds：合法标记解析出 omittedInputIds；非 rewind/载荷非法返回 undefined', { timeout: 60_000 }, () => {
  assert.deepEqual(rewindOmittedInputIds(rewindMarker(9, ['a', 'b'])), ['a', 'b'])
  assert.deepEqual(rewindOmittedInputIds({ id: '9', kind: 'helm.rewind', data: { fromEntryId: 1, omittedInputIds: [] } }), [])
  assert.equal(rewindOmittedInputIds({ id: '5', kind: 'helm.input', data: { omittedInputIds: ['a'] } }), undefined)
  // FIXTURE 对齐的旧形状（无 omittedInputIds）：显式 undefined，不静默当空集。
  assert.equal(rewindOmittedInputIds({ id: '9', kind: 'helm.rewind', data: { fromEntryId: 1 } }), undefined)
  assert.equal(rewindOmittedInputIds({ id: '9', kind: 'helm.rewind', data: { omittedInputIds: ['a', 3] } }), undefined)
})

test('removeRecallNodesByInputs：只删 inputIds 相交节点；其他会话与不相交节点保留；空集零写回', { timeout: 60_000 }, () => {
  const node = (id: string, conversationId: number, inputIds: string[]) => ({
    id,
    conversationId,
    profileId: 'assistant',
    completionSeq: Number(id.split(':')[1]),
    inputIds,
    outcome: 'completed' as const,
    summary: `任务 ${id}`,
    artifacts: [],
    keywords: [],
    createdAt: 1,
  })
  const store = {
    value: {
      version: 1 as const,
      nodes: [node('5:1', 5, ['in-1']), node('5:2', 5, ['in-2', 'in-3']), node('6:1', 6, ['in-2'])],
    },
    writes: 0,
    get() { return this.value },
    set(v: unknown) { this.writes += 1; this.value = v as typeof this.value },
  }
  // 会话 5 rewind in-2：只删 5:2（in-2 相交）；5:1 与会话 6 的 6:1 保留。
  const removed = removeRecallNodesByInputs(store, 5, new Set(['in-2']))
  assert.deepEqual(removed, ['5:2'])
  assert.deepEqual(store.value.nodes.map((n) => n.id), ['5:1', '6:1'])
  assert.equal(store.writes, 1)
  // 无相交：零写回。
  assert.deepEqual(removeRecallNodesByInputs(store, 5, new Set(['nope'])), [])
  assert.equal(store.writes, 1)
  // 空 omitted 集合：直接零写回。
  assert.deepEqual(removeRecallNodesByInputs(store, 5, new Set()), [])
  assert.equal(store.writes, 1)
})

test('assertRecallDoc：RecallNode 缺 inputIds / 空数组 / 重复项显式 corrupt', { timeout: 60_000 }, () => {
  const base = { id: '5:1', conversationId: 5, profileId: 'assistant', completionSeq: 1, outcome: 'completed', summary: 's', artifacts: [], keywords: [], createdAt: 1 }
  assertRecallDoc({ version: 1, nodes: [{ ...base, inputIds: ['in-1'] }] })
  assert.throws(() => assertRecallDoc({ version: 1, nodes: [base] }), /含非法节点/)
  assert.throws(() => assertRecallDoc({ version: 1, nodes: [{ ...base, inputIds: [] }] }), /含非法节点/)
  assert.throws(() => assertRecallDoc({ version: 1, nodes: [{ ...base, inputIds: ['a', 'a'] }] }), /含非法节点/)
  assert.throws(() => assertRecallDoc({ version: 1, nodes: [{ ...base, inputIds: ['a', ''] }] }), /含非法节点/)
})

// ---------------------------------------------------------------------------
// 2. 实时订阅：编辑第二轮只删相应节点
// ---------------------------------------------------------------------------

test('helm.rewind 事件：删除该会话 inputIds 相交节点；前轮与其它会话 Worker 节点保留；新回合照常写新节点', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  try {
    const workerA = await dispatchWorker(h, 'Worker A 任务')
    const workerB = await dispatchWorker(h, 'Worker B 任务')

    // A 第一轮（human，in-a1）+ 第二轮（agent，in-a2）；B 一轮（agent，in-b1）。
    await h.turnSettled(settledPayload({ conversationId: workerA, completionSeq: 1, inputs: [{ id: 'in-a1', origin: 'human' }] }))
    await h.turnSettled(settledPayload({ conversationId: workerA, completionSeq: 2, inputs: [{ id: 'in-a2', origin: 'agent' }] }))
    await h.turnSettled(settledPayload({ conversationId: workerB, completionSeq: 1, inputs: [{ id: 'in-b1', origin: 'agent' }] }))
    assert.deepEqual(
      h.readRecall().nodes.map((n) => n.id).sort(),
      [`${workerA}:1`, `${workerA}:2`, `${workerB}:1`].sort(),
    )
    // 汇报卡：agent 轮各投一张（A:2 与 B:1）。
    assert.equal(h.workerReportSubmits(), 2)

    // 编辑重发第二轮（FIXTURE：真实 EventHub 发布 conversation.entry）。
    h.publishEntry(workerA, rewindMarker(40, ['in-a2']))

    const after = h.readRecall().nodes.map((n) => n.id).sort()
    assert.deepEqual(after, [`${workerA}:1`, `${workerB}:1`].sort(), '只删被覆盖回合节点；前轮与其它 Worker 保留')

    // 已发出的历史汇报不回滚（无撤销类提交；汇报卡记录原样保留）。
    assert.equal(h.workerReportSubmits(), 2)

    // 编辑后的新回合照常写新节点（新输入 in-a3）。
    await h.turnSettled(settledPayload({ conversationId: workerA, completionSeq: 3, inputs: [{ id: 'in-a3', origin: 'agent' }] }))
    const finalNodes = h.readRecall().nodes.map((n) => n.id).sort()
    assert.deepEqual(finalNodes, [`${workerA}:1`, `${workerA}:3`, `${workerB}:1`].sort())
    assert.equal(h.workerReportSubmits(), 3, '新回合照常投递汇报')
  } finally {
    await h.close()
  }
})

test('rewind 载荷非法：显式通知诊断，不静默、不清节点', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  try {
    const worker = await dispatchWorker(h, '任务')
    await h.turnSettled(settledPayload({ conversationId: worker, completionSeq: 1, inputs: [{ id: 'in-1', origin: 'human' }] }))
    h.publishEntry(worker, { id: '9', kind: 'helm.rewind', data: { fromEntryId: 1 } })
    assert.equal(h.readRecall().nodes.length, 1, '载荷非法不得误删节点')
    assert.ok(
      h.backend.notifications.some((n) => n.title.includes('rewind 联动失败')),
      '载荷非法应显式通知',
    )
  } finally {
    await h.close()
  }
})

// ---------------------------------------------------------------------------
// 3. 延迟结算与 rewind 竞态：旧节点不复活、旧汇报不再投递
// ---------------------------------------------------------------------------

test('竞态：collectWorkerSettlement await 期间发生 rewind——旧节点不写回、旧汇报不再投递', { timeout: 60_000 }, async () => {
  // 用受控 gate：turn_settled 处理器在 getConversationDetail await 期间插入 rewind。
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-rewind-race-'))
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1))
  const notifications: Array<{ title: string; body: string }> = []
  const submits: Array<{ conversationId: number; origin?: string }> = []
  let releaseDetail!: () => void
  const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve })
  let rewound = false
  const docs = new MemoryDocStore()
  const profilesSvc = new ProfileService(dataDir)
  const skillsSvc = new SkillService(dataDir)
  await profilesSvc.ensureDefault()
  const entryListeners = new Set<(conversationId: number, entry: ConversationEntry) => void>()
  const backend: PluginHostBackend = {
    ...hostBackendStub(),
    async dispatchTrigger() {},
    async submitInput(conversationId, _text, options) { submits.push({ conversationId, origin: options?.origin }) },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const summary = makeConversation(id, { title: init.title ?? 'new', profileId: init.profileId ?? 'assistant', ...(init.tags ? { tags: init.tags } : {}) })
      conversations.set(id, summary)
      return summary
    },
    listConversations: () => [...conversations.values()],
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', 'no', 404)
      return found
    },
    async updateConversation(id, patch) { const found = conversations.get(id)!; const next = { ...found, ...patch }; conversations.set(id, next); return next },
    profiles: {
      list: () => profilesSvc.list(),
      get: (id: string) => profilesSvc.get(id),
      getSystem: (id: string) => profilesSvc.getSystem(id),
      save: (p: Parameters<typeof profilesSvc.save>[0]) => profilesSvc.save(p),
      directory: async (id: string) => join(dataDir, 'profiles', id),
    },
    skills: {
      list: () => skillsSvc.list(),
      readFile: (skillId: string, path?: string) => skillsSvc.readFile(skillId, path),
      directory: async (id: string) => join(dataDir, 'skills', id),
      ensureSkill: (asset: Parameters<typeof skillsSvc.ensureSkill>[0]) => skillsSvc.ensureSkill(asset),
    },
    isClosing: () => false,
    getConversationOwnership: () => 'helm' as const,
    onEvent: (type, listener) => {
      if (type !== 'conversation.entry') return () => {}
      const l = (payload: unknown) => {
        const event = payload as { conversationId: number; entry: ConversationEntry }
        listener({ conversationId: event.conversationId, entry: event.entry })
      }
      entryListeners.add(l as never)
      return () => entryListeners.delete(l as never)
    },
    async getConversationDetail(id) {
      if (!rewound) {
        // 首次调用（结算收集）挂起：等 rewind 先发生再放行，制造确定性竞态。
        await detailGate
      }
      return { ...(conversations.get(id) ?? makeConversation(id)), entries: [{ id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '旧回答' }] }] }] }
    },
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
    emitEvent: (type: string, payload: unknown) => { if (type === 'notification') notifications.push(payload as { title: string; body: string }) },
  }
  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register(createSuperAgentPlugin(), { enabled: true })
  const routerId = (docs.store.get('builtin:superagent:index') as { routerConversationId?: number }).routerConversationId
  const reportCount = () => submits.filter((s) => s.conversationId === routerId && s.origin === 'agent').length
  try {
    const worker = (await host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '竞态任务' }, undefined)) as { workerConversationId: number }
    // 结算进入 collectWorkerSettlement（在 detail await 挂起）。
    const settling = host.runHook('turn_settled', settledPayload({ conversationId: worker.workerConversationId, completionSeq: 1, inputs: [{ id: 'in-race', origin: 'agent' }] }))
    await delay(25) // 确认已进入 detail await
    // rewind 先到达：节点（尚不存在）无影响，但纪元推进。
    for (const listener of entryListeners) {
      listener(worker.workerConversationId, rewindMarker(30, ['in-race']))
    }
    rewound = true
    releaseDetail()
    await settling

    const nodes = (docs.store.get('builtin:superagent:recall-graph') as { nodes: unknown[] } | undefined)?.nodes ?? []
    assert.equal(nodes.length, 0, '被覆盖回合的旧节点不得在 rewind 后写回')
    assert.equal(reportCount(), 0, '被覆盖回合的旧汇报不得投递中枢')

    // rewind 之后的新回合正常写节点 + 投汇报。
    rewound = true // 后续 detail 不再挂起
    await host.runHook('turn_settled', settledPayload({ conversationId: worker.workerConversationId, completionSeq: 2, inputs: [{ id: 'in-next', origin: 'agent' }] }))
    const after = (docs.store.get('builtin:superagent:recall-graph') as { nodes: Array<{ id: string; inputIds: string[] }> }).nodes
    assert.equal(after.length, 1)
    assert.deepEqual(after[0]!.inputIds, ['in-next'])
    assert.equal(reportCount(), 1)
  } finally {
    releaseDetail()
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 订阅生命周期：stop 退订；enable 重建
// ---------------------------------------------------------------------------

test('订阅生命周期：stop 后事件不再处理；重新 enable 重建订阅且继续联动', { timeout: 60_000 }, async () => {
  const h = await makeHarness()
  try {
    const worker = await dispatchWorker(h, '生命周期任务')
    await h.turnSettled(settledPayload({ conversationId: worker, completionSeq: 1, inputs: [{ id: 'in-l1', origin: 'human' }] }))
    await h.host.disable('builtin:superagent')
    // 停用后 rewind 事件到达：无订阅者处理（节点原样，等启用补偿）。
    h.publishEntry(worker, rewindMarker(20, ['in-l1']))
    assert.equal(h.readRecall().nodes.length, 1, '停用期间事件不处理（由启用补偿负责）')

    // 重新启用：补偿分页读详情（FIXTURE 页面无 rewind 标记时保留节点；此处
    // 补偿页面也提供同一标记验证清理路径）。为此使用带详情页的独立 harness。
  } finally {
    await h.close()
  }

  const h2 = await makeHarness({
    detailPages: new Map([[42, [{ entries: [rewindMarker(20, ['in-l1'])], nextCursor: '1' }, { entries: [] }]]]),
  })
  try {
    const worker = await dispatchWorker(h2, '补偿任务')
    // 手工写入节点（模拟停用前已结算的历史节点；会话 42 是独立会话坐标）。
    h2.seedRecallNode({ id: '42:1', conversationId: 42, inputIds: ['in-l1'] })
    await h2.host.disable('builtin:superagent')
    // 重新启用：start 内补偿分页读详情（第一页 nextCursor 'page-2' -> 第二页），
    // 依据 rewind 标记清理历史节点。
    await h2.host.enable('builtin:superagent')
    assert.deepEqual(h2.readRecall().nodes.map((n) => n.id), [], '启用补偿应清理停用期间错过的 rewind 节点')
    // 补偿确实完成分页（跟 nextCursor 到头）。
    assert.ok(h2.detailCalls.filter((id) => id === 42).length >= 2, '补偿分页应跟随 nextCursor 翻页')
  } finally {
    await h2.close()
  }
})

// ---------------------------------------------------------------------------
// 5. 启用补偿：API 不可读显式失败；多会话逐一处理
// ---------------------------------------------------------------------------

test('启用补偿：详情 API 失败时 enable 显式失败（不伪成功）；有效早期节点不误删', { timeout: 60_000 }, async () => {
  const h = await makeHarness({
    detailError: (id) =>
      new HelmError('document_store_failed', `测试注入：会话 ${id} 详情读取失败`, 500),
  })
  try {
    const worker = await dispatchWorker(h, '补偿失败任务')
    h.seedRecallNode({ id: `${worker}:1`, conversationId: worker, inputIds: ['in-x'] })
    await h.host.disable('builtin:superagent')
    await assert.rejects(
      () => h.host.enable('builtin:superagent'),
      (err: unknown) => err instanceof HelmError && err.message.includes('详情读取失败'),
      'API 不可读必须显式启动失败',
    )
  } finally {
    await h.close()
  }

  // 会话已删（not_found）：事实性不可得，节点保留、启动不失败。
  const h4 = await makeHarness({
    detailError: (id) => new HelmError('not_found', `会话不存在：${id}`, 404),
  })
  try {
    h4.seedRecallNode({ id: '99:1', conversationId: 99, inputIds: ['in-gone'] })
    await h4.host.disable('builtin:superagent')
    await h4.host.enable('builtin:superagent')
    assert.deepEqual(h4.readRecall().nodes.map((n) => n.id), ['99:1'], '已删会话节点保留，不算 API 故障')
  } finally {
    await h4.close()
  }

  // 有效早期节点（无 rewind 覆盖其输入）不得误删。
  const pages = new Map<number, DetailPage[]>([
    [7, [{ entries: [{ id: '3', kind: 'helm.input', data: { id: 'in-early', origin: 'human' } }], nextCursor: '1' }, { entries: [] }]],
  ])
  const h3 = await makeHarness({ detailPages: pages })
  try {
    h3.seedRecallNode({ id: '7:1', conversationId: 7, inputIds: ['in-early'] })
    await h3.host.disable('builtin:superagent')
    await h3.host.enable('builtin:superagent')
    assert.deepEqual(h3.readRecall().nodes.map((n) => n.id), ['7:1'], '未被 rewind 覆盖的早期节点保留')
  } finally {
    await h3.close()
  }
})

test('REWIND_REPLAY_PAGE_SIZE 为 500（详情 API 上限，完整分页）', { timeout: 60_000 }, () => {
  assert.equal(REWIND_REPLAY_PAGE_SIZE, 500)
})
