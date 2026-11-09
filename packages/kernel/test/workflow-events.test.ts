import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { WorkflowRunSummary } from '@helm/protocol'
import { EventHub } from '../src/runtime/events.js'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/builtin-plugins/workflow/engine/service.js'

function makeEnv(
  t: TestContext,
  spawnAgent: WorkflowServiceHost['spawnAgent'],
  overrides?: Partial<WorkflowServiceHost> & { concurrency?: number },
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-workflow-events-'))
  const docs = new Map<string, unknown>()
  const state: WorkflowStateStore = {
    get<T>(key: string, initial: T): T {
      return docs.has(key) ? docs.get(key) as T : initial
    },
    set(key, value) { docs.set(key, value) },
  }
  const events = new EventHub({
    initialSeq: 0,
    snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }),
  })
  const updates: WorkflowRunSummary[] = []
  events.subscribe((frame) => {
    // workflow.updated 现为自定义事件（{ type, payload: { run } } 原样透传）。
    const event = frame.event as { type: string; payload?: { run?: WorkflowRunSummary } }
    if (event.type === 'workflow.updated' && event.payload?.run) updates.push(event.payload.run)
  })
  const host: WorkflowServiceHost = {
    spawnAgent,
    async invokeAction() { throw new Error('此测试不调用动作') },
    listActions: () => [],
    getConversation: (id) => ({
      id, title: '测试父会话', profileId: 'assistant', tags: [], cwd: dataDir,
      model: 'test/model', thinkingLevel: '', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
      unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
    }),
    async abortConversation() {},
    emitEvent: (type, payload) => events.publish(type, payload),
    ...overrides,
  }
  const service = new WorkflowService({
    dataDir,
    state,
    host,
    ...(overrides?.concurrency !== undefined ? { concurrency: overrides.concurrency } : {}),
  })
  t.after(async () => {
    try {
      await service.close()
    } finally {
      events.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
  return { dataDir, state, service, updates }
}

test('重放缓存标记透传到 getRun、listRuns、事件与重启后的公开摘要', { timeout: 60_000 }, async (t) => {
  let spawns = 0
  const env = makeEnv(t, async () => { spawns += 1; return '同一结果' })
  const script = 'export const meta = { name: "cache-summary", description: "public cache metadata" }\nconst a = await agent("first", { label: "a" }); const b = await agent("second", { resume: "a" }); return { a, b }'
  const original = await env.service.run({ script })
  assert.deepEqual(await env.service.wait(original.id), { a: '同一结果', b: '同一结果' })
  assert.equal(spawns, 2)
  const replay = await env.service.run({ script, resumeFromRunId: original.id })
  assert.deepEqual(await env.service.wait(replay.id), { a: '同一结果', b: '同一结果' })
  assert.equal(spawns, 2, '重放不得重新调用执行后端')
  const summaries = [env.service.getRun(replay.id), env.service.listRuns().find((run) => run.id === replay.id)!, env.updates.findLast((run) => run.id === replay.id)!]
  for (const summary of summaries) {
    assert.equal(summary.nodes?.length, 2)
    assert.ok(summary.nodes!.every((node) => node.status === 'done' && node.cached === true))
  }
  const revived = new WorkflowService({ dataDir: env.dataDir, state: env.state, host: {
    spawnAgent: async () => { throw new Error('重启后只读摘要') }, invokeAction: async () => { throw new Error('unused') }, listActions: () => [],
    getConversation: () => { throw new Error('unused') }, abortConversation: async () => {}, emitEvent: () => {},
  } })
  try { assert.ok(revived.getRun(replay.id).nodes!.every((node) => node.cached === true)) }
  finally { await revived.close() }
})

test('节点更新跨过 250ms 窗口时仍发布合法 run 信封，不把成功 agent 变成 null', { timeout: 60_000 }, async (t) => {
  let now = 1_000
  t.mock.method(Date, 'now', () => now)
  const env = makeEnv(t, async () => {
    // 只推进宿主时钟，确定性触发节流分支，不依赖机器负载或固定 sleep。
    now += 300
    return '真实宿主结果'
  })
  const run = await env.service.run({
    script: 'export const meta = { name: "node-events", description: "event contract" }\nreturn await agent("任务")',
  })
  assert.equal(await env.service.wait(run.id), '真实宿主结果')
  assert.equal(env.service.getRun(run.id).status, 'completed')
  assert.ok(env.updates.some((update) =>
    update.status === 'running' && update.nodes?.some((node) => node.kind === 'agent' && node.status === 'done'),
  ), '必须实际经过节点进度发布分支')
  assert.equal(env.updates.at(-1)?.status, 'completed')
})

test('启动恢复中断的 run 时发布合法 workflow.updated 信封', { timeout: 60_000 }, async (t) => {
  const env = makeEnv(t, async () => '未调用')
  const id = 'wf_interrupted'
  env.state.set('workflow/runs', [{ id, conversationId: 1, createdAt: 1 }])
  env.state.set(`workflow/run/${id}`, {
    id, name: 'interrupted', conversationId: 1, status: 'running', createdAt: 1,
    updatedAt: 1, journalPath: join(env.dataDir, 'unused.workflow.jsonl'),
  })
  await env.service.init()
  assert.equal(env.service.getRun(id).status, 'failed')
  assert.equal(env.updates.length, 1)
  assert.equal(env.updates[0]?.id, id)
  assert.equal(env.updates[0]?.status, 'failed')
})

test('run 摘要携带 meta 元数据：kind=workflow、description、phases；后台子代理 kind=subagent', { timeout: 60_000 }, async (t) => {
  const env = makeEnv(t, async () => 'ok')
  const script = [
    'export const meta = {',
    '  name: "meta-carry",',
    '  description: "验证元数据透传",',
    '  phases: [',
    '    { title: "准备", detail: "环境检查", model: "glm-4.7" },',
    '    { title: "执行" },',
    '  ],',
    '}',
    'phase("准备")',
    'await agent("先检查")',
    'return "完成"',
  ].join('\n')
  const run = await env.service.run({ script })
  assert.equal(run.kind, 'workflow')
  assert.equal(run.description, '验证元数据透传')
  assert.deepEqual(JSON.parse(JSON.stringify(run.phases)), [
    { title: '准备', detail: '环境检查', model: 'glm-4.7' },
    { title: '执行' },
  ])
  await env.service.wait(run.id)
  // 终态摘要（getRun / listRuns / 事件）同样携带元数据。
  for (const summary of [env.service.getRun(run.id), env.service.listRuns().find((r) => r.id === run.id)!]) {
    assert.equal(summary.kind, 'workflow')
    assert.equal(summary.description, '验证元数据透传')
    assert.equal(summary.phases?.length, 2)
    assert.equal(summary.phases?.[0]?.model, 'glm-4.7')
  }
  const terminalEvent = env.updates.findLast((update) => update.id === run.id && update.status === 'completed')
  assert.equal(terminalEvent?.kind, 'workflow')
  assert.equal(terminalEvent?.description, '验证元数据透传')

  // 后台单子代理：kind=subagent，不带 workflow 元数据。
  const bg = await env.service.startBackgroundAgent(
    { parentConversationId: 1, prompt: '后台任务', agentType: 'researcher' },
    { notifyParentOnSettle: false },
  )
  assert.equal(bg.run.kind, 'subagent')
  await env.service.wait(bg.run.id)
  assert.equal(env.service.getRun(bg.run.id).kind, 'subagent')
})

test('phase/log 与 onResolved 元数据立即推送：workflow.updated 携带 progress 与节点 conversationId/worktree/gateCommand', { timeout: 60_000 }, async (t) => {
  const env = makeEnv(
    t,
    async (request) => {
      request.onResolved?.({
        conversationId: 4242,
        worktree: { path: '/tmp/wt-iso', branch: 'helm/wf-1' },
      })
      request.onGateResult?.({ ok: true, output: '' })
      return '完成结果'
    },
    {
      // gate 断言由测试宿主内回报（onGateResult）；runGate 是宿主自跑 fallback，
      // 提供一个兜底实现以满足引擎前置能力检查。
      async runGate() { return { ok: true, output: '' } },
    },
  )
  const script = [
    'export const meta = { name: "immediate-push", description: "立即推送" }',
    'phase("阶段甲")',
    'log("开始执行")',
    'return await agent("干活", { gate: "pnpm test" })',
  ].join('\n')
  const run = await env.service.run({ script })
  assert.equal(await env.service.wait(run.id), '完成结果')

  // phase/log 立即推送：running 事件里必须已能看到 progress 时间线。
  const runningEvents = env.updates.filter((u) => u.id === run.id && u.status === 'running')
  assert.ok(
    runningEvents.some((u) => u.progress?.some((p) => p.kind === 'phase' && p.title === '阶段甲')),
    'phase() 必须立即推送并携带 progress',
  )
  assert.ok(
    runningEvents.some((u) => u.progress?.some((p) => p.kind === 'log' && p.message === '开始执行')),
    'log() 必须立即推送并携带 progress',
  )
  // onResolved 回传 conversationId/worktree：0ms 立即推送（不等 250ms 窗口）。
  assert.ok(
    runningEvents.some(
      (u) => u.nodes?.some(
        (n) =>
          n.kind === 'agent' &&
          n.conversationId === 4242 &&
          n.worktree?.path === '/tmp/wt-iso' &&
          n.gateCommand === 'pnpm test',
      ),
    ),
    'onResolved 元数据（conversationId/worktree）与 gateCommand 必须 0ms 推送',
  )
  // 终态事件同样携带完整 progress。
  const terminal = env.updates.findLast((u) => u.id === run.id && u.status === 'completed')
  assert.ok(terminal?.progress?.some((p) => p.kind === 'phase'))
})

test('节点按调用 index 全序输出：action 与 agent 混合并携带 label/phase；未得槽位节点 pending', { timeout: 60_000 }, async (t) => {
  const script = [
    'export const meta = { name: "mixed-order", description: "混合排序" }',
    'phase("阶段一")',
    'const slow = agent("首个慢任务", { label: "slow" })',
    'const flush = action("io.flush")',
    'const quick = agent("第二个任务", { label: "quick" })',
    'const results = await Promise.all([slow, quick])',
    'await flush',
    'return results',
  ].join('\n')
  const env = makeEnv(
    t,
    async (request) => {
      if (request.prompt === '首个慢任务') {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return '慢完成'
      }
      return '快完成'
    },
    {
      concurrency: 1,
      async invokeAction(_pluginId, actionId) {
        assert.equal(actionId, 'io.flush')
        return { flushed: true }
      },
      listActions: () => [{
        pluginId: 'builtin:test', id: 'io.flush', description: '测试动作',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      }],
    },
  )

  const run = await env.service.run({ script })
  assert.deepEqual(await env.service.wait(run.id), ['慢完成', '快完成'])

  // 终态节点：严格按调用位次 agent-0 → action-1 → agent-2；action 携带 label=actionId 与 phaseTitle。
  const final = env.service.getRun(run.id)
  assert.deepEqual(final.nodes?.map((n) => n.id), ['agent-0', 'action-1', 'agent-2'])
  assert.equal(final.nodes?.[1]?.label, 'io.flush')
  assert.equal(final.nodes?.[1]?.phaseTitle, '阶段一')
  assert.equal(final.nodes?.[1]?.phaseIndex, 0)
  assert.ok(final.nodes?.every((n) => n.status === 'done'))

  // 运行期：慢 agent 占槽，quick 排队中必须 pending（非 running）。
  const sawPending = env.updates.some(
    (u) => u.id === run.id && u.nodes?.some((n) => n.kind === 'agent' && n.label === 'quick' && n.status === 'pending'),
  )
  assert.ok(sawPending, '未获得并发槽位的排队 agent 必须展示为 pending')
  assert.ok(
    env.updates.some((u) => u.id === run.id && u.nodes?.some((n) => n.kind === 'action' && n.status === 'pending')),
    'action 与 agent 共用并发槽位，等待中的 action 同样必须展示为 pending',
  )
})
