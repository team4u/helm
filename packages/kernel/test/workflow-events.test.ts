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
} from '../src/workflow/service.js'

function makeEnv(t: TestContext, spawnAgent: WorkflowServiceHost['spawnAgent']) {
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
    snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], workflowRuns: [] }),
  })
  const updates: WorkflowRunSummary[] = []
  events.subscribe((frame) => {
    const event = frame.event as { type: string; run?: WorkflowRunSummary }
    if (event.type === 'workflow.updated' && event.run) updates.push(event.run)
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
  }
  const service = new WorkflowService({ dataDir, state, host })
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
