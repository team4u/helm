/**
 * 工作流级联取消端到端集成验收（真实 createHelm + faux provider + 真内核）。
 *
 * 覆盖（全部真实链路，绝不 mock WorkflowService / spawnAgent）：
 * - 父会话 abort（turn aborted）→ builtin:workflow turn_settled 钩子级联取消
 *   该会话子树内属于它的后台 run；受管（helm-owned）子会话经内核
 *   abortConversationGuarded 原子复核被中止；
 * - human 红线（真实内核）：ownership 翻转 human 的后代在「后台 run 取消」
 *   与「同步 spawn 信号桥」两条真实路径上均不被中止；
 * - 取消后不复活：级联边界内的下级父会话不再被 submitInput 汇报唤醒
 *   （无新 helm.input 回合）；边界外拥有者照常收到单次结算汇报；
 * - 深层投影：多级子树的 run 聚合进祖先分片（原始归属保留）、角标聚合。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary, WorkflowRunSummary } from '@helm/protocol'
import { createHelm } from '../src/app.js'

const ROOT = 1

interface TurnSettledRecord {
  conversationId: number
  outcome: string
}

interface Env {
  app: Awaited<ReturnType<typeof createHelm>>
  dataDir: string
  settled: TurnSettledRecord[]
  /** 父会话响应队列（router 动态 shift）。 */
  parentQueue: AssistantMessage[]
  onEmpty: 'hang' | 'end'
  /** 挂起中的模型调用故里（close 前释放，避免 faux 流悬挂阻塞关停）。 */
  hangs: Array<() => void>
  close(): Promise<void>
}

async function makeEnv(onEmpty: 'hang' | 'end' = 'hang'): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-cascade-e2e-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const settled: TurnSettledRecord[] = []
  // turn.settled 发布在内核事件总线（非宿主内部事件）：经 events.subscribe 观察。
  app.kernel.events.subscribe((frame) => {
    const event = frame.event as { type?: string; payload?: { conversation?: { id: number }; outcome?: string } }
    if (event.type === 'turn.settled' && event.payload?.conversation !== undefined) {
      settled.push({ conversationId: event.payload.conversation.id, outcome: event.payload.outcome ?? '' })
    }
  })
  const parentQueue: AssistantMessage[] = []
  const hangs: Array<() => void> = []
  const env: Env = {
    app,
    dataDir,
    settled,
    parentQueue,
    onEmpty,
    hangs,
    async close() {
      // 先释放全部挂起的模型调用（否则 faux 流的未决 promise 会阻塞关停）。
      for (const release of hangs.splice(0)) release()
      await new Promise((r) => setTimeout(r, 100))
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  // 按会话分流：子会话（prompt 含 HANG-CHILD 标记）永远挂起；父会话按队列
  // 出队，空队列按 onEmpty 挂起（保持回合在途）或回 'end'（让回合完成）。
  // faux 每次模型调用弹一个 step：路由器复制多份填满队列，全部走同一分流。
  const router = (
    context: { messages: Array<{ role: string; content: unknown }> },
    options?: { signal?: AbortSignal },
  ) => {
    const users = context.messages.filter((m) => m.role === 'user')
    const last = users[users.length - 1]
    const text = JSON.stringify(last?.content ?? '')
    const hang = (): Promise<AssistantMessage> =>
      new Promise<AssistantMessage>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('faux hang aborted by signal'))
        if (options?.signal?.aborted) {
          onAbort()
          return
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })
        hangs.push(() => {
          options?.signal?.removeEventListener('abort', onAbort)
          resolve(fauxAssistantMessage('hang-released'))
        })
      })
    if (text.includes('HANG-CHILD')) {
      return hang()
    }
    const next = parentQueue.shift()
    if (next !== undefined) return next
    if (env.onEmpty === 'end') return fauxAssistantMessage('end')
    return hang()
  }
  faux.setResponses(Array.from({ length: 200 }, () => router))
  return env
}

/** 轮询直到异步谓词为真（确定性等待，不 sleep 固定时长）。 */
async function until(predicate: () => Promise<boolean> | boolean, what: string, maxMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function listRuns(env: Env): Promise<WorkflowRunSummary[]> {
  return ((await env.app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: WorkflowRunSummary[] }).runs
}

/** 读 runs 会话分片（公共 sessionDoc）。 */
function readShard(env: Env, conversationId: number): WorkflowRunSummary[] {
  const doc = env.app.kernel.plugins.getPublicSessionDoc('builtin:workflow', 'runs', conversationId)
  return ((doc.value as { runs?: WorkflowRunSummary[] }).runs ?? [])
}

/** 读全局角标文档（紧凑导航元数据）。 */
function readBadges(env: Env): Record<string, { count: number }> {
  const doc = env.app.kernel.plugins.getPublicDoc('builtin:workflow', 'run-badges')
  return ((doc.value as { byConversation?: Record<string, { count: number }> }).byConversation ?? {})
}

async function inputEntries(env: Env, conversationId: number): Promise<Array<{ kind: string; text?: string }>> {
  const detail = await env.app.kernel.getConversationDetail(conversationId, { limit: 200 })
  return detail.entries.map((e) => ({ kind: e.kind, ...(e.data !== undefined ? { text: String((e.data as { text?: string }).text ?? '') } : {}) }))
}

function childConversations(conversations: ConversationSummary[], parent: number): ConversationSummary[] {
  return conversations.filter((c) => c.parentConversationId === parent)
}

test('父会话 abort 级联：子树后台 run 取消、受管子会话被中止、取消后不复活、投影聚合', { timeout: 60_000 }, async () => {
  const env = await makeEnv('hang')
  try {
    env.parentQueue.push(
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'HANG-CHILD 后台任务', background: true }, { id: 'call-bg-cascade' })],
        { stopReason: 'toolUse' },
      ),
    )
    await env.app.kernel.submitInput(ROOT, '派一个后台子代理')

    let bgRun: WorkflowRunSummary | undefined
    let child: ConversationSummary | undefined
    await until(async () => {
      bgRun = (await listRuns(env)).find((r) => r.kind === 'subagent')
      child = childConversations(env.app.kernel.listConversations(), ROOT)[0]
      return bgRun !== undefined && child !== undefined
    }, '后台 run 与子会话出现')
    const childId = child!.id
    const runId = bgRun!.id

    // 父回合仍在途（下一轮模型调用挂起）：中止父会话 → turn aborted → 级联。
    await env.app.kernel.abortConversation(ROOT)
    await until(async () => {
      const run = (await listRuns(env)).find((r) => r.id === runId)
      return run !== undefined && run.status === 'aborted'
    }, '后台 run 级联取消至 aborted')
    await until(
      () => env.settled.some((s) => s.conversationId === childId && s.outcome === 'aborted'),
      '受管（helm-owned）子会话经守卫中止后回合 aborted',
    )
    await env.app.kernel.waitForIdle(ROOT).catch(() => {})

    // 不复活：无 agent report 重新唤醒父会话（无新 helm.input、水位稳定）。
    const inputsBefore = (await inputEntries(env, ROOT)).filter((e) => e.kind === 'helm.input').length
    const seqBefore = env.app.kernel.getConversation(ROOT).completionSeq
    await new Promise((r) => setTimeout(r, 400))
    const inputsAfter = (await inputEntries(env, ROOT)).filter((e) => e.kind === 'helm.input').length
    assert.equal(inputsAfter, inputsBefore, '取消边界内的结算汇报不得重新投递输入（防复活）')
    assert.equal(inputsBefore, 1, '父会话只有最初一条输入（后台 run 的 aborted 汇报被跳过）')
    assert.equal(env.app.kernel.getConversation(ROOT).completionSeq, seqBefore, '取消后无新回合')
    assert.equal(
      env.settled.some((s) => s.conversationId === ROOT && s.outcome === 'aborted'),
      true,
      '父会话回合 aborted（级联由 turn_settled 触发）',
    )

    // 投影：aborted run 仍在根会话分片（结果可查）。
    assert.equal(readShard(env, ROOT).some((r) => r.id === runId && r.status === 'aborted'), true, '根分片含 aborted run（供 UI 查询）')
    assert.equal(readBadges(env)[String(ROOT)]?.count, 1, '角标聚合根会话子树 run')
  } finally {
    await env.close()
  }
})

test('human 红线（后台路径）：归属翻转 human 的子会话在 run 取消后不被中止', { timeout: 60_000 }, async () => {
  const env = await makeEnv('end')
  try {
    env.parentQueue.push(
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'HANG-CHILD 受保护任务', background: true }, { id: 'call-bg-human' })],
        { stopReason: 'toolUse' },
      ),
    )
    await env.app.kernel.submitInput(ROOT, '派一个后台子代理')
    await env.app.kernel.waitForIdle(ROOT)

    let runId: string | undefined
    let childId: number | undefined
    await until(async () => {
      const run = (await listRuns(env)).find((r) => r.kind === 'subagent')
      const child = childConversations(env.app.kernel.listConversations(), ROOT)[0]
      runId = run?.id
      childId = child?.id
      return runId !== undefined && childId !== undefined
    }, '后台 run 与子会话出现')

    // 人类接管子会话：后续一切自动化取消不得触碰（内核红线）。
    env.app.kernel.markConversationOwnership(childId!, 'human')
    const result = (await env.app.kernel.plugins.invokeAction('builtin:workflow', 'abort', { runId: runId! })) as { run: WorkflowRunSummary }
    assert.equal(result.run.status, 'aborted', 'run 确定结算 aborted（不等待被保护子会话）')

    await new Promise((r) => setTimeout(r, 400))
    const childNow = env.app.kernel.getConversation(childId!)
    assert.equal(childNow.status, 'working', `human 子会话仍在运行（实际 ${childNow.status}；守卫端口与信号桥两条路径都必须拒绝）`)
    assert.equal(
      env.settled.some((s) => s.conversationId === childId!),
      false,
      'human 子会话没有任何回合被自动化中止',
    )
    // 收尾：人类路径显式中止挂起的子会话，避免 close 等待。
    await env.app.kernel.abortConversation(childId!)
    await env.app.kernel.waitForIdle(childId!).catch(() => {})
  } finally {
    await env.close()
  }
})

test('human 红线（同步信号桥）：父会话 abort 不杀 human 子会话，helm 子会话照常中止', { timeout: 60_000 }, async () => {
  const env = await makeEnv('hang')
  try {
    // 第一轮：同步 subagent（工具阻塞等子会话）；子会话转 human 后中止父会话。
    env.parentQueue.push(
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'HANG-CHILD 同步任务一', background: false }, { id: 'call-sync-human' })],
        { stopReason: 'toolUse' },
      ),
    )
    await env.app.kernel.submitInput(ROOT, '第一轮同步任务')
    let childA: number | undefined
    await until(() => {
      childA = childConversations(env.app.kernel.listConversations(), ROOT)[0]?.id
      return childA !== undefined
    }, '同步子会话 A 出现')
    env.app.kernel.markConversationOwnership(childA!, 'human')
    await env.app.kernel.abortConversation(ROOT)
    await env.app.kernel.waitForIdle(ROOT).catch(() => {})
    await until(
      () => env.settled.some((s) => s.conversationId === ROOT && s.outcome === 'aborted'),
      '父会话回合 aborted',
    )
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(env.app.kernel.getConversation(childA!).status, 'working', 'human 子会话不被信号桥中止（真实内核守卫）')

    // 第二轮（对照）：helm-owned 同步子会话 → 父 abort 后子会话被守卫中止。
    env.parentQueue.push(
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'HANG-CHILD 同步任务二', background: false }, { id: 'call-sync-helm' })],
        { stopReason: 'toolUse' },
      ),
    )
    await env.app.kernel.submitInput(ROOT, '第二轮同步任务')
    let childB: number | undefined
    await until(() => {
      childB = childConversations(env.app.kernel.listConversations(), ROOT).map((c) => c.id).find((id) => id !== childA)
      return childB !== undefined
    }, '同步子会话 B 出现')
    await env.app.kernel.abortConversation(ROOT)
    await until(
      () => env.settled.some((s) => s.conversationId === childB! && s.outcome === 'aborted'),
      'helm-owned 子会话经守卫中止',
    )
    assert.equal(env.app.kernel.getConversation(childB!).status !== 'working', true, 'helm 子会话已停止')

    // 收尾挂起的 human 子会话。
    await env.app.kernel.abortConversation(childA!)
    await env.app.kernel.waitForIdle(childA!).catch(() => {})
  } finally {
    await env.close()
  }
})

test('多级后台：中段会话 abort 级联取消其子树 run，深层 runs/badges 投影，下级父会话不复活', { timeout: 60_000 }, async () => {
  const env = await makeEnv('end')
  try {
    // 一级：ROOT 派后台子代理（子会话 D 的模型调用挂起，保持后台 run 在途）。
    env.parentQueue.push(
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'HANG-CHILD 一级后台', background: true }, { id: 'call-bg-l1' })],
        { stopReason: 'toolUse' },
      ),
    )
    await env.app.kernel.submitInput(ROOT, '派一级后台')
    let level1Run: WorkflowRunSummary | undefined
    let childD: number | undefined
    await until(async () => {
      level1Run = (await listRuns(env)).find((r) => r.kind === 'subagent')
      childD = childConversations(env.app.kernel.listConversations(), ROOT)[0]?.id
      return level1Run !== undefined && childD !== undefined
    }, '一级后台 run 与子会话 D 出现')
    await env.app.kernel.waitForIdle(ROOT)

    // 二级：在 D 下启动真实工作流 run（其 agent 子会话挂起，保持 running）。
    const script = 'export const meta = { name: "level2", description: "t" }\nconst a = await agent("HANG-CHILD 二级代理", { label: "a" }); return a'
    const level2 = (await env.app.kernel.plugins.invokeAction('builtin:workflow', 'run', { conversationId: childD!, script })) as { run: WorkflowRunSummary }
    let childD2: number | undefined
    await until(async () => {
      childD2 = childConversations(env.app.kernel.listConversations(), childD!).map((c) => c.id)[0]
      return childD2 !== undefined && (await listRuns(env)).some((r) => r.id === level2.run.id && r.status === 'running')
    }, '二级 run 与孙会话 D2 出现')

    // 深层投影（取消前）：根分片聚合两级 run（原始归属保留），角标聚合。
    const shardRootBefore = readShard(env, ROOT)
    assert.equal(shardRootBefore.some((r) => r.id === level1Run!.id), true, '根分片含一级 run')
    const projectedL2 = shardRootBefore.find((r) => r.id === level2.run.id)
    assert.ok(projectedL2, '根分片聚合二级 run（深层投影）')
    assert.equal(projectedL2!.conversationId, childD!, '二级 run 保留原始归属（D，不改写为根）')
    const badgesBefore = readBadges(env)
    assert.equal(badgesBefore[String(ROOT)]?.count, 2, '根角标聚合两级 run')
    assert.equal(badgesBefore[String(childD!)]?.count, 1, 'D 角标只计自己发起的 run')

    // 中止 D（其回合在途挂起）→ turn aborted → 级联取消 D 子树内的二级 run；
    // 一级 run（发起者是 ROOT，不在 D 子树内）不被该边界取消。
    const inputsDBefore = (await inputEntries(env, childD!)).filter((e) => e.kind === 'helm.input').length
    await env.app.kernel.abortConversation(childD!)
    await until(async () => {
      const run = (await listRuns(env)).find((r) => r.id === level2.run.id)
      return run !== undefined && run.status === 'aborted'
    }, '二级 run 级联取消至 aborted')
    await until(
      () => env.settled.some((s) => s.conversationId === childD2! && s.outcome === 'aborted'),
      '孙会话 D2（helm-owned）经守卫中止',
    )

    // 下级父会话不复活：D 不因二级 run 的取消被重新投递汇报输入。
    await new Promise((r) => setTimeout(r, 400))
    const inputsDAfter = (await inputEntries(env, childD!)).filter((e) => e.kind === 'helm.input').length
    assert.equal(inputsDAfter, inputsDBefore, '取消边界内的下级父会话无新汇报输入（防复活）')

    // 投影（取消后）：两级 run 终态仍在根分片；D 分片含自己的 run。
    assert.equal(readShard(env, ROOT).find((r) => r.id === level2.run.id)?.status, 'aborted', '根分片仍聚合二级 run 终态')
    assert.equal(readShard(env, childD!).some((r) => r.id === level2.run.id), true, 'D 分片含自己发起的 run')
  } finally {
    await env.close()
  }
})
