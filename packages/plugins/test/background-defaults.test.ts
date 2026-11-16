/**
 * subagent / SubagentWorkflow 工具 background 缺省策略端到端测试
 * （真实 createHelm + faux provider + 真内核 + 真引擎）。
 *
 * 缺省语义（以内核权威归属 getConversationOwnership 判定，不按 profileId/
 * runtime 角色枚举）：
 * - 人类交互会话（未标记归属 = human）缺省 background=true：工具在执行环境
 *   就绪 / durable running 快照落盘后立即返回（runId + running），后台完成后
 *   向父会话幂等 followUp 汇报（origin=agent、meta.backgroundRunId、
 *   requestId helm:<kind>-report:<runId>）；父回合结束不误杀后台任务；
 * - 自动化会话（归属 helm/bot，如受管子代理、驻留 Worker）缺省同步等待最终
 *   结果；显式 background=true 被显式拒绝（subagent_failed / workflow_failed
 *   + 归属事实），不派生、不建 run，绝不静默改写为同步；
 * - 显式 background:false 在人类交互会话保留同步路径。
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../../hub/src/app.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { makeFauxModels } from './helpers/plugin-test-env.js'

type App = Awaited<ReturnType<typeof createHelm>>

/** 工具结果 entry 文本（pi.tool-result 的 model[0].content 文本块拼接）。 */
function toolResultText(detail: { entries: Array<{ kind: string; model?: unknown[] }> }, toolName: string): string {
  const entry = [...detail.entries]
    .reverse()
    .find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === toolName)
  assert.ok(entry, `应存在 ${toolName} 的 pi.tool-result entry`)
  const message = entry.model?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined
  return (message?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function toolNameOf(model: unknown[] | undefined): string | undefined {
  const message = model?.[0] as { toolName?: string } | undefined
  return message?.toolName
}

/** 会话的后台汇报 helm.input（origin=agent 且带 meta.backgroundRunId）。 */
async function backgroundReports(
  app: App,
  conversationId: number,
): Promise<Array<{ id: unknown; origin: unknown; kind: unknown; backgroundRunId?: string; renderer?: unknown }>> {
  const detail = await app.kernel.getConversationDetail(conversationId, { limit: 500 })
  const out: Array<{ id: unknown; origin: unknown; kind: unknown; backgroundRunId?: string; renderer?: unknown }> = []
  for (const entry of detail.entries) {
    if (entry.kind !== 'helm.input') continue
    const data = entry.data as
      | { id?: unknown; origin?: unknown; meta?: { backgroundRunId?: unknown; kind?: unknown; renderer?: unknown } }
      | undefined
    if (data?.meta?.backgroundRunId === undefined) continue
    out.push({
      id: data.id,
      origin: data.origin,
      kind: data.meta.kind,
      backgroundRunId: String(data.meta.backgroundRunId),
      renderer: data.meta.renderer,
    })
  }
  return out
}

async function runsOf(app: App, conversationId: number): Promise<Array<{ id: string; kind?: string; status: string }>> {
  const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {
    conversationId,
  })) as { runs: Array<{ id: string; kind?: string; status: string }> }
  return runs
}

/** 轮询直到异步谓词为真（确定性等待，不 sleep 固定时长）。 */
async function until(predicate: () => Promise<boolean> | boolean, what: string, maxMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 轮询直到谓词返回非 undefined 值（确定性等待，返回命中值）。 */
async function untilValue<T>(resolve: () => Promise<T | undefined> | T | undefined, what: string, maxMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await resolve()
    if (value !== undefined) return value
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-bg-defaults-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('subagent 工具 background 缺省（权威 ownership 判定）', { timeout: 60_000 }, () => {
  it('人类交互会话缺省后台：立即返回 runId/running；后台完成后父会话恰收一次 subagent_report 汇报', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bg1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // faux 全共享 FIFO 队列：首个必须 toolCall；其后消费点（父工具结果回合 /
      // 后台子代理回合 / 汇报触发的父回合）次序不确定——一律供给良性文本。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '人类后台任务' })], { stopReason: 'toolUse' }),
        ...Array.from({ length: 5 }, () => fauxAssistantMessage('良性回答')),
      ])
      await app.kernel.submitInput(1, '派一个后台子代理')
      await app.kernel.waitForIdle(1)

      // 工具输出：后台句柄（background:true + runId + running 快照），不含业务结果。
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      const runId = /"runId":"(wf_[0-9a-zA-Z_-]+)"/.exec(text)?.[1]
      assert.ok(runId, `工具输出应含 runId：${text.slice(0, 300)}`)
      assert.ok(text.includes('"background":true'), `缺省后台应回报 background:true：${text.slice(0, 300)}`)
      assert.ok(text.includes('"status":"running"'), `返回时应为 running 快照：${text.slice(0, 300)}`)

      // 父回合已结束（waitForIdle 通过）而 run 仍自行推进至终态：后台不被父回合
      // 结束误杀的证据即汇报随后到达。
      await until(async () => (await runsOf(app, 1)).find((r) => r.id === runId)?.status !== 'running', '后台 run 到达终态')
      const final = (await runsOf(app, 1)).find((r) => r.id === runId)!
      assert.equal(final.kind, 'subagent')
      assert.equal(final.status, 'completed')

      // 父会话恰收一次结算汇报：requestId（entry data.id）+ meta 幂等标识。
      await until(async () => (await backgroundReports(app, 1)).some((r) => r.backgroundRunId === runId), 'subagent_report 汇报到达')
      const reports = (await backgroundReports(app, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, '后台子代理结算汇报恰一次')
      assert.equal(reports[0]!.id, `helm:subagent-report:${runId}`)
      assert.equal(reports[0]!.origin, 'agent')
      assert.equal(reports[0]!.kind, 'subagent_report')
      // 轻量渲染标记（timeline.renderer 精确接管）；payload 契约仍是引导语+换行+JSON。
      assert.equal(reports[0]!.renderer, 'workflow:background-report')
      // 宿主侧注册同步锁定：kinds 限定 helm.input + matchMeta 精确匹配 + client 导出名。
      const rendererSpec = app.kernel.plugins
        .listUi()
        .find((u) => u.pluginId === 'builtin:workflow' && u.surface === 'timeline.renderer')?.spec as
        | { kinds?: string[]; matchMeta?: { renderer?: string }; client?: { module: string; export: string } }
        | undefined
      assert.ok(rendererSpec, 'builtin:workflow 应注册 timeline.renderer')
      assert.deepEqual(rendererSpec!.kinds, ['helm.input'])
      assert.equal(rendererSpec!.matchMeta?.renderer, 'workflow:background-report')
      assert.equal(rendererSpec!.client?.export, 'BackgroundReportCard')
      await app.kernel.waitForIdle(1).catch(() => {})
    } finally {
      await app.close()
    }
  })

  it('人类交互会话显式 background:false：同步路径携带业务结果（durable 前台 run，可 detach）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bg2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '同步任务', background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('同步子代理回答'),
        fauxAssistantMessage('主回合完成'),
      ])
      await app.kernel.submitInput(1, '派一个同步子代理')
      await app.kernel.waitForIdle(1)

      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(text.includes('同步子代理回答'), `同步路径应直接携带业务结果：${text.slice(0, 300)}`)
      assert.ok(!text.includes('"background":true'), '同步路径不得回报后台句柄')
      // 同步路径统一走受管启动：durable 前台 run（kind=subagent + syncForeground），
      // 自然完成后不通知父会话（notifyParentOnSettle 仅在 detach 置位）。
      const runs = await runsOf(app, 1)
      assert.equal(runs.length, 1, '同步路径应创建 durable run 记录（受管启动）')
      assert.equal(runs[0]!.kind, 'subagent')
      assert.equal(runs[0]!.status, 'completed')
      assert.equal((runs[0] as { syncForeground?: boolean }).syncForeground, true, '同步 run 应标记 syncForeground（可 detach）')
      assert.equal((await backgroundReports(app, 1)).length, 0, '自然完成的同步 run 不得投递结算汇报')
      assert.ok(app.kernel.listConversations().some((c) => c.parentConversationId === 1), '同步派生应创建子会话')
    } finally {
      await app.close()
    }
  })

  it('helm-owned 会话缺省同步；显式 background:true 显式拒绝（不派生、不建 run、不静默改写）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bg3')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 自动化会话：受管子代理/驻留 Worker 派生登记即标 helm——直接以内核权威
      // 归属标记构造（与真实派生同权：ownership doc 是唯一判定源）。
      app.kernel.markConversationOwnership(1, 'helm')

      // 缺省（省略 background）：同步等待业务结果。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '自动化同步任务' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('自动化子代理回答'),
        fauxAssistantMessage('自动化回合完成'),
      ])
      await app.kernel.submitInput(1, '派一个同步子代理')
      await app.kernel.waitForIdle(1)
      let detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      let text = toolResultText(detail, 'subagent')
      assert.ok(text.includes('自动化子代理回答'), `自动化会话缺省应同步等待：${text.slice(0, 300)}`)
      assert.ok(!text.includes('"background":true'))
      // 同步缺省同样走受管启动：恰好一个 durable 前台 run（syncForeground）。
      const syncRuns = await runsOf(app, 1)
      assert.equal(syncRuns.length, 1, '同步路径应创建 durable run 记录（受管启动）')
      assert.equal((syncRuns[0] as { syncForeground?: boolean }).syncForeground, true)
      const syncChild = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(syncChild, '同步派生应创建子会话')

      // 显式 background:true：显式拒绝（防自动化调用方早结算），绝不静默改写。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '被拒的后台任务', background: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('被拒后续答'),
      ])
      await app.kernel.submitInput(1, '再派一个后台子代理')
      await app.kernel.waitForIdle(1)
      detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      text = toolResultText(detail, 'subagent')
      assert.ok(
        text.includes('subagent_failed') && text.includes('background') && text.includes('helm'),
        `拒绝信息应显式指出 background=true 不被允许并携带归属事实：${text.slice(0, 300)}`,
      )
      assert.equal((await runsOf(app, 1)).length, 1, '被拒调用不得新增 run 记录（仅剩同步那一个）')
      assert.equal(
        app.kernel.listConversations().filter((c) => c.parentConversationId === 1).length,
        1,
        '被拒调用不得再派生子会话（仅剩同步路径那一个）',
      )
      assert.equal((await backgroundReports(app, 1)).length, 0, '被拒调用不产生任何汇报')
    } finally {
      await app.close()
    }
  })
})

describe('SubagentWorkflow 工具 background 缺省', { timeout: 60_000 }, () => {
  const AGENT_SCRIPT =
    'export const meta = { name: "bg-default-wf", description: "t" }\nconst a = await agent("工作流子任务"); return { done: a }'

  it('人类交互会话缺省后台：立即返回 background:true + running summary；结算后父会话恰收一次 workflow_report', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wfbg1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { script: AGENT_SCRIPT })],
          { stopReason: 'toolUse' },
        ),
        ...Array.from({ length: 5 }, () => fauxAssistantMessage('良性回答')),
      ])
      await app.kernel.submitInput(1, '跑一个后台工作流')
      await app.kernel.waitForIdle(1)

      // 工具输出：后台句柄（background:true + running 快照 summary）。
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      const runId = /"id":"(wf_[0-9a-zA-Z_-]+)"/.exec(text)?.[1]
      assert.ok(runId, `工具输出应含运行 id：${text.slice(0, 300)}`)
      assert.ok(text.includes('"background":true'), `缺省后台应回报 background:true：${text.slice(0, 300)}`)
      assert.ok(text.includes('"status":"running"'), `返回时应为 running 快照：${text.slice(0, 300)}`)

      // 父回合已结束，run 不被误杀：自行推进至 completed。
      await until(async () => (await runsOf(app, 1)).find((r) => r.id === runId)?.status !== 'running', '后台工作流到达终态')
      const final = (await runsOf(app, 1)).find((r) => r.id === runId)!
      assert.equal(final.kind, 'workflow')
      assert.equal(final.status, 'completed')

      // 父会话恰收一次 workflow_report 汇报（requestId 幂等标识）。
      await until(async () => (await backgroundReports(app, 1)).some((r) => r.backgroundRunId === runId), 'workflow_report 汇报到达')
      const reports = (await backgroundReports(app, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, '后台工作流结算汇报恰一次')
      assert.equal(reports[0]!.id, `helm:workflow-report:${runId}`)
      assert.equal(reports[0]!.origin, 'agent')
      assert.equal(reports[0]!.kind, 'workflow_report')
      assert.equal(reports[0]!.renderer, 'workflow:background-report')
      await app.kernel.waitForIdle(1).catch(() => {})
    } finally {
      await app.close()
    }
  })

  it('helm-owned 会话缺省同步：等待终态返回 summary（status completed + result）；显式 background:true 显式拒绝', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wfbg2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      app.kernel.markConversationOwnership(1, 'helm')
      const fastScript = 'export const meta = { name: "sync-default-wf", description: "t" }\nreturn 7'

      // 缺省：同步等待终态。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('SubagentWorkflow', { script: fastScript })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('自动化工作流回合完成'),
      ])
      await app.kernel.submitInput(1, '跑一个同步工作流')
      await app.kernel.waitForIdle(1)
      let detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      let text = toolResultText(detail, 'SubagentWorkflow')
      assert.ok(text.includes('"status":"completed"'), `自动化会话缺省应同步等待终态：${text.slice(0, 300)}`)
      assert.ok(text.includes('"result":7'), '同步路径应携带终态 result')
      assert.ok(!text.includes('"background":true'), '同步路径不得回报后台句柄')
      assert.equal((await runsOf(app, 1)).length, 1)

      // 显式 background:true：显式拒绝，不建 run。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { script: fastScript, background: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('被拒续答'),
      ])
      await app.kernel.submitInput(1, '再跑一个后台工作流')
      await app.kernel.waitForIdle(1)
      detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      text = toolResultText(detail, 'SubagentWorkflow')
      assert.ok(
        text.includes('workflow_failed') && text.includes('background') && text.includes('helm'),
        `拒绝信息应显式指出 background=true 不被允许并携带归属事实：${text.slice(0, 300)}`,
      )
      assert.equal((await runsOf(app, 1)).length, 1, '被拒调用不得创建新 run（仅剩同步那次）')
      assert.equal((await backgroundReports(app, 1)).length, 0, '被拒调用不产生任何汇报')
    } finally {
      await app.close()
    }
  })
})

describe('同步运行 detach 转后台（subagent / SubagentWorkflow 工具链）', { timeout: 60_000 }, () => {
  /**
   * 确定性 faux 响应步骤：子会话首回合（无 tool 结果消息）挂起等待手动放行；
   * 父会话续答 / 汇报回合（上下文含 tool 结果）立即良性回答。消费次序在
   * 父续答与子首答之间存在竞争，按调用方上下文分流使 FIFO 次序无关。
   */
  type GateResult = ReturnType<typeof fauxAssistantMessage>
  function gatedSteps(gate: { promise: Promise<GateResult>; release: (message: GateResult) => void }, count: number): FauxResponseStep[] {
    const step: FauxResponseStep = async (context) => {
      // 子会话首回合上下文只有 system + user；父会话续答/汇报回合含 toolResult。
      const isChildFirstTurn = !context.messages.some((m) => m.role === 'toolResult')
      if (isChildFirstTurn) return await gate.promise
      return fauxAssistantMessage('良性回答')
    }
    return Array.from({ length: count }, () => step)
  }

  function makeGate(): { promise: Promise<GateResult>; release: (message: GateResult) => void } {
    let release!: (message: GateResult) => void
    const promise = new Promise<GateResult>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  it('同步 subagent 阻塞等待中 detach：工具立即返回后台句柄，run 继续并恰收一次汇报', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fgdetach1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      const gate = makeGate()
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '慢同步任务', background: false })],
          { stopReason: 'toolUse' },
        ),
        ...gatedSteps(gate, 5),
      ])
      const submitted = app.kernel.submitInput(1, '派一个同步子代理')
      // run 就绪（受管启动：durable 前台 run + syncForeground）。
      const run = await untilValue(async () => {
        const runs = (await runsOf(app, 1)) as Array<{ id: string; status: string; syncForeground?: boolean }>
        return runs.find((r) => r.syncForeground === true && r.status === 'running')
      }, '前台同步 run 就绪')
      // 会话内 detach（human-owned 父会话自身）：等待中的工具调用被唤醒。
      const detached = (await app.kernel.plugins.invokeAction('builtin:workflow', 'detach', { runId: run.id }, { conversationId: 1 })) as {
        detached: boolean
        runId: string
        run: { detachedAt?: number }
      }
      assert.equal(detached.detached, true)
      assert.equal(detached.runId, run.id)
      assert.ok(typeof detached.run.detachedAt === 'number')
      await submitted
      await app.kernel.waitForIdle(1)

      // 工具输出：后台句柄（与 background:true 形状兼容），不含业务结果。
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(text.includes('"background":true'), `detach 后工具应返回后台句柄：${text.slice(0, 300)}`)
      assert.ok(text.includes(`"runId":"${run.id}"`), '后台句柄应携带原 runId')
      assert.ok(!text.includes('慢同步任务回答'), 'detach 后同步调用不再携带业务结果')

      // 重复 detach 显式拒绝（已转后台）。
      await assert.rejects(
        () => app.kernel.plugins.invokeAction('builtin:workflow', 'detach', { runId: run.id }, { conversationId: 1 }),
        (err: unknown) => err instanceof Error && /已在后台/.test(err.message),
      )

      // 放行子会话：run 推进到终态，父会话恰收一次结算汇报。
      gate.release(fauxAssistantMessage('慢同步任务回答'))
      await until(async () => (await runsOf(app, 1)).find((r) => r.id === run.id)?.status !== 'running', 'detached run 到达终态')
      await until(async () => (await backgroundReports(app, 1)).some((r) => r.backgroundRunId === run.id), '结算汇报到达')
      const reports = (await backgroundReports(app, 1)).filter((r) => r.backgroundRunId === run.id)
      assert.equal(reports.length, 1, 'detached run 结算汇报恰一次')
      await app.kernel.waitForIdle(1).catch(() => {})
    } finally {
      await app.close()
    }
  })

  it('helm 归属会话的前台 run 拒绝 detach（automation 同步等待防早结算）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fgdetach2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      app.kernel.markConversationOwnership(1, 'helm')
      const gate = makeGate()
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '自动化同步任务' })], { stopReason: 'toolUse' }),
        ...gatedSteps(gate, 5),
      ])
      const submitted = app.kernel.submitInput(1, '派一个同步子代理')
      const run = await untilValue(async () => {
        const runs = (await runsOf(app, 1)) as Array<{ id: string; status: string; syncForeground?: boolean }>
        return runs.find((r) => r.syncForeground === true && r.status === 'running')
      }, '前台同步 run 就绪')
      await assert.rejects(
        () => app.kernel.plugins.invokeAction('builtin:workflow', 'detach', { runId: run.id }, { conversationId: 1 }),
        (err: unknown) => err instanceof Error && /归属 helm/.test(err.message),
      )
      // 拒绝不影响同步等待：放行后正常携带业务结果返回。
      gate.release(fauxAssistantMessage('自动化子代理回答'))
      await submitted
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(text.includes('自动化子代理回答'), `拒绝 detach 不影响同步语义：${text.slice(0, 300)}`)
      assert.ok(!text.includes('"background":true'))
      assert.equal((await backgroundReports(app, 1)).length, 0, '自然完成的前台 run 不汇报')
    } finally {
      await app.close()
    }
  })

  it('同步 SubagentWorkflow 阻塞等待中 detach：返回后台句柄形状，终态 followUp 汇报', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fgdetach3')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 人类交互会话显式同步工作流（automation 拒绝已由上一用例覆盖）：脚本带
      // agent 节点（子会话经 gate 挂起），run 停留在 running 供 detach。
      const script =
        'export const meta = { name: "fg-detach-tool", description: "t" }\n' +
        'const a = await agent("工作流挂起节点")\nreturn { done: a }'
      const gate = makeGate()
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('SubagentWorkflow', { script, background: false })], { stopReason: 'toolUse' }),
        ...gatedSteps(gate, 5),
      ])
      const submitted = app.kernel.submitInput(1, '跑一个同步工作流')
      const run = await untilValue(async () => {
        const runs = (await runsOf(app, 1)) as Array<{ id: string; status: string; kind?: string; syncForeground?: boolean }>
        return runs.find((r) => r.syncForeground === true && r.status === 'running' && r.kind !== 'subagent')
      }, '前台同步工作流 run 就绪')
      const detached = (await app.kernel.plugins.invokeAction('builtin:workflow', 'detach', { runId: run.id }, { conversationId: 1 })) as {
        detached: boolean
      }
      assert.equal(detached.detached, true)
      await submitted
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      assert.ok(text.includes('"background":true'), `detach 后同步工作流应返回后台句柄：${text.slice(0, 300)}`)
      assert.ok(text.includes(`"id":"${run.id}"`), '后台句柄 summary 应携带原 runId')

      // 放行挂起的 agent 节点：run 推进到终态，父会话恰收一次 workflow_report。
      gate.release(fauxAssistantMessage('工作流节点回答'))
      await until(async () => (await runsOf(app, 1)).find((r) => r.id === run.id)?.status !== 'running', 'detached 工作流到达终态')
      await until(async () => (await backgroundReports(app, 1)).some((r) => r.backgroundRunId === run.id), 'workflow_report 汇报到达')
      const reports = (await backgroundReports(app, 1)).filter((r) => r.backgroundRunId === run.id)
      assert.equal(reports.length, 1)
      assert.equal(reports[0]!.kind, 'workflow_report')
      await app.kernel.waitForIdle(1).catch(() => {})
    } finally {
      await app.close()
    }
  })
})
