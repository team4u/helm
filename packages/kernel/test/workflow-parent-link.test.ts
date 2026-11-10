/**
 * SubagentWorkflow 工具调用 -> run 精确关联（parentToolCallId）端到端验收。
 *
 * 覆盖设计修复「运行期按同父会话第一个 running 或最新 run 匹配会把两个并行
 * 调用挂同一 run、把新调用挂旧 run」：
 * - 真实工具链（faux 指定工具 callId）-> createWorkflowTool -> kernel.runWorkflow
 *   -> app.setWorkflowRunner 受信 context -> WorkflowService.run -> RunRecord
 *   持久化 -> toSummary 透传；
 * - 双并行 run 各自 parentToolCallId 互不串扰；
 * - run 未创建前（不等工具返回）即能按 callId 精确取到对应 run；
 * - 重启（同 dataDir 重建 WorkflowService）后历史 run 的 parentToolCallId 保留；
 * - HTTP body 无法注入（rejectUnknownKeys），CLI 无新输入；run() 直接调用不传
 *   context 时无关联（HTTP/CLI 路径事实）。
 *
 * 诚实性纪律：run 由真实 WorkflowService 执行（真 worker 线程）；慢速脚本经
 * deferred faux 响应阻塞工具返回，确保在「工具仍在执行」时检查运行期关联。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import { EventHub } from '../src/runtime/events.js'

interface FauxHandle {
  setResponses(messages: unknown[]): void
}

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: unknown } {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider((faux as unknown as { provider: never }).provider)
  return { models, faux }
}

/** 慢速脚本：每个 agent 调用真实 spawn 子会话（faux 子会话脚本慢速流式输出）。 */
const SLOW_SCRIPT =
  'export const meta = { name: "slow-link", description: "t" }\n' +
  'const a = await agent("s1", { prompt: "慢任务" }); return a'

const FAST_SCRIPT =
  'export const meta = { name: "fast-link", description: "t" }\nreturn 7'

test('工具链精确关联：parentToolCallId 经受信 context 注入 run，双并行不串扰，重启保留', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-wf-calllink-'))
  const { models, faux } = makeFauxModels()
  const app = await createHelm({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
  })
  try {
    // --- 1. 快速 run：完成后 summary.parentToolCallId 即真实工具 callId ---
    ;(faux as FauxHandle).setResponses([
      fauxAssistantMessage(
        [fauxToolCall('SubagentWorkflow', { script: FAST_SCRIPT }, { id: 'call-fast-1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('快完成'),
    ])
    await app.kernel.submitInput(1, '跑快工作流')
    await app.kernel.waitForIdle(1)
    const listRuns = () =>
      (app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {}) as Promise<{ runs: Array<{ id: string; name: string; parentToolCallId?: string; status: string }> }>).then((r) => r.runs)
    const runsAfterFast = await listRuns()
    const fastRun = runsAfterFast.find((r) => r.name === 'fast-link')
    assert.ok(fastRun, '快 run 应存在')
    assert.equal(fastRun.parentToolCallId, 'call-fast-1', 'summary 应携带真实工具 callId')

    // --- 2. 慢速 run：工具执行期间（run 已创建、工具未返回）按 callId 精确取 ---
    // 子代理（faux 子会话）不设响应 -> subagent 工具等待，父回合工具在途。
    ;(faux as FauxHandle).setResponses([
      fauxAssistantMessage(
        [fauxToolCall('SubagentWorkflow', { script: SLOW_SCRIPT }, { id: 'call-slow-2' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('慢完成'),
    ])
    const slowTurn = app.kernel.submitInput(1, '跑慢工作流')
    // 轮询等待 run 出现（真实引擎异步启动），此时工具必然尚未返回。
    let slowRun: { id: string; parentToolCallId?: string; status: string } | undefined
    for (let i = 0; i < 200; i++) {
      slowRun = (await listRuns()).find((r) => r.name === 'slow-link')
      if (slowRun !== undefined) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(slowRun, '慢 run 应在工具返回前创建')
    assert.equal(slowRun.status, 'running')
    assert.equal(slowRun.parentToolCallId, 'call-slow-2', '运行期关联不等工具返回')

    // 双 run 并存（一完成一运行）：按各自 callId 取互不串扰（不猜 running/最新）。
    const runsNow = await listRuns()
    assert.equal(
      runsNow.find((r) => r.parentToolCallId === 'call-fast-1')?.id,
      fastRun.id,
      '快 run 仍按 callId 精确命中',
    )
    assert.equal(
      runsNow.find((r) => r.parentToolCallId === 'call-slow-2')?.id,
      slowRun.id,
      '慢 run 不被快 run 抢占',
    )

    // 中止慢 run 收尾（子会话无响应会阻塞），并等待工具回合结束。
    await app.kernel.plugins.invokeAction('builtin:workflow', 'abort', { runId: slowRun.id })
    await slowTurn.catch(() => {})
    await app.kernel.waitForIdle(1).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }

  // --- 3. 重启（同 dataDir）：历史 run 的 parentToolCallId 持久保留 ---
  const reopened = await createHelm({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
  })
  const listRunsReopened = () =>
    (reopened.kernel.plugins.invokeAction('builtin:workflow', 'runs', {}) as Promise<{ runs: Array<{ id: string; name: string; parentToolCallId?: string; status: string }> }>).then((r) => r.runs)
  try {
    const fast = (await listRunsReopened()).find((r) => r.name === 'fast-link')
    assert.ok(fast)
    assert.equal(fast.parentToolCallId, 'call-fast-1', '重启后 parentToolCallId 保留')
    const slow = (await listRunsReopened()).find((r) => r.name === 'slow-link')
    assert.ok(slow)
    assert.equal(slow.parentToolCallId, 'call-slow-2')
    assert.equal(slow.status, 'aborted', '重启前已中止的 run 保持 aborted')
  } finally {
    await reopened.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run() 无受信 context（HTTP/CLI 路径事实）：run 无 parentToolCallId；HTTP body 字段被拒', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-nolink-'))
  const database = await openHelmDatabase(dataDir)
  const store = new HelmStore(database)
  await store.load()
  const state: WorkflowStateStore = (() => {
    const docs = new Map<string, unknown>()
    return {
      get<T>(key: string, initial: T): T {
        return docs.has(key) ? (docs.get(key) as T) : initial
      },
      set<T>(key: string, value: T) {
        docs.set(key, value)
      },
    }
  })()
  const events = new EventHub({
    initialSeq: 0,
    snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }),
  })
  const host: WorkflowServiceHost = {
    async spawnAgent() {
      return '结果'
    },
    async invokeAction() {
      throw new Error('此测试不调用动作')
    },
    listActions: () => [],
    getConversation: (id) => ({
      id,
      title: 't',
      profileId: 'assistant',
      tags: [],
      cwd: dataDir,
      model: 'm',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 0,
      updatedAt: 0,
    }),
    async abortConversation() {},
    emitEvent: (type, payload) => events.publish(type, payload),
  }
  const service = new WorkflowService({ dataDir, state, host })
  try {
    // 直接调用（HTTP/CLI 相同路径）：不传 context -> 无 parentToolCallId。
    const summary = await service.run({ conversationId: 1, script: FAST_SCRIPT })
    assert.equal(summary.parentToolCallId, undefined, '无受信 context 时绝不虚构关联')
    // 受信 context 注入（仅内部通道可及）。
    const linked = await service.run({ conversationId: 1, script: FAST_SCRIPT }, { parentToolCallId: 'call-internal-9' })
    assert.equal(linked.parentToolCallId, 'call-internal-9')
    await service.wait(linked.id)
  } finally {
    await service.close().catch(() => {})
    events.close()
    await store.close().catch(() => {})
    await database.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('run 动作 inputSchema 不得注入 parentToolCallId（additionalProperties:false 拒绝未知字段）', { timeout: 60_000 }, async () => {
  // 编排已剥离为插件动作：run 的 inputSchema 不含 parentToolCallId 且
  // additionalProperties:false——语义冒充在动作边界被拒绝，内部元数据仅
  // 受信工具上下文（PluginToolContext.callId）可注入。
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-schema-'))
  const { models } = makeFauxModels()
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: models as never })
  try {
    const manifests = app.kernel.plugins.listActions()
    const runManifest = manifests.find((m) => m.pluginId === 'builtin:workflow' && m.id === 'run')
    assert.ok(runManifest, 'builtin:workflow run 动作应存在')
    assert.equal(runManifest.inputSchema.additionalProperties, false)
    assert.equal(Object.prototype.hasOwnProperty.call(runManifest.inputSchema.properties ?? {}, 'parentToolCallId'), false)
    // 语义冒充（同名写入 input）被动作输入校验拒绝。
    await assert.rejects(
      () => app.kernel.plugins.invokeAction('builtin:workflow', 'run', { script: FAST_SCRIPT, parentToolCallId: 'call-forged' } as never),
      (e: unknown) => e instanceof Error && e.message.includes('校验失败'),
    )
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
