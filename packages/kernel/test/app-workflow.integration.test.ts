/**
 * helm 工作流端到端集成验收（app-workflow 组合链路，不修改实现）。
 *
 * 与 core.integration.test.ts 的分工：本文件专注 WorkflowService 经
 * builtin:workflow 插件（createHelm 组合）后的两条真链路：
 * 1. workflow.run(script agent(...,{schema,gate})) -> agent_spawn 管道 -> 原生
 *    subagent（真子会话 + faux register_structured_output 工具自愈）-> gate
 *    真实 shell 只执行一次（sentinel 文件计数）-> wait 返回 Schema 校验对象；
 *    resumeFromRunId 相同 script 默认 args 命中账本前缀：不再 faux 调用、
 *    不重跑 gate（副作用不重复）。
 * 2. ctx.action 经 WorkflowService.action()（'test:probe.echo' 全限定 ID）->
 *    与 HTTP / CLI / executeTool 共享同一 Schema 校验器；action 完成后 resume
 *    不重复执行 handler。
 *
 * 诚实性纪律：模型输出全部来自 faux 脚本；引擎行为为真实执行（真 worker 线程、
 * 真 journal fsync、真 shell gate）。绝不 mock WorkflowService / spawnAgent。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type PluginDefinition } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

import assert from 'node:assert/strict'

/** 初始会话 id（SDK 保留 #1 承载；普通会话语义，无产品级特权）。 */
const ROOT_CONVERSATION_ID = 1 as const

const testDir = dirnameOf(import.meta.url)
function dirnameOf(u: string): string {
  return fileURLToPath(new URL('.', u))
}

// ---------------------------------------------------------------------------
// 环境：真 createHelm + 探针插件（echo action 供 workflow action() 调用）
// ---------------------------------------------------------------------------

interface WfEnv {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  /** echo action handler 执行计数（副作用哨兵）。 */
  echoCalls: string[]
  /** 引擎经 builtin:workflow 插件动作总线驱动（与 HTTP/CLI/模型工具同链路）。 */
  runWorkflow(request: Record<string, unknown>): Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>
  inspectRun(runId: string): Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>
  close(): Promise<void>
}

async function makeWfEnv(): Promise<WfEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-e2e-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })

  const echoCalls: string[] = []
  await app.kernel.plugins!.register({
    id: 'test:probe',
    name: '工作流探针',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { echoed: string }>({
        id: 'echo',
        description: '回显',
        cli: { command: ['probe', 'echo'] },
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { echoed: { type: 'string' } },
          required: ['echoed'],
          additionalProperties: false,
        },
        handler: (input) => {
          echoCalls.push(input.text)
          return { echoed: input.text }
        },
      })
    },
  } satisfies PluginDefinition)

  const plugins = app.kernel.plugins
  return {
    dataDir,
    faux,
    app,
    echoCalls,
    runWorkflow: (request) =>
      plugins.invokeAction('builtin:workflow', 'run', request) as Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>,
    inspectRun: (runId) =>
      plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 1. agent(schema,gate) 真链路 + resume 前缀命中不重跑副作用
// ---------------------------------------------------------------------------

test('工作流1: agent schema/gate 真链路——原生 spawn + StructuredOutput 自愈 + gate shell 只跑一次 + resume 前缀命中不重跑', { timeout: 60_000 }, async () => {
  const env = await makeWfEnv()
  try {
    const gateSentinel = join(env.dataDir, 'gate-count')
    writeFileSync(gateSentinel, '0', { flag: 'w' })
    const gateCmd = `printf x >> "${join(env.dataDir, 'gate-runs')}" && [ "$(cat ${join(env.dataDir, 'gate-runs')} | wc -c)" -ge 1 ]`

    const script =
      'export const meta = { name: "e2e-agent", description: "schema+gate" }\n' +
      'const v = await agent("提取数字", { schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false }, gate: ' +
      JSON.stringify(gateCmd) +
      ' })\n' +
      'return v'

    // faux 脚本：子会话首轮发起 register_structured_output 工具调用（真结构化输出路径）
    const STRUCTURED = { answer: 42 }
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('register_structured_output', { output: STRUCTURED })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('已提交结构化结果'),
    ])

    const { run: started } = await env.runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    assert.ok(started.id.startsWith('wf_'), 'runId 应为 wf_ 前缀')
    const result = started.result as { answer: number }
    const summary = started
    assert.deepEqual(result, STRUCTURED, `wait 应返回 Schema 校验通过的结构化对象，节点诊断：${JSON.stringify(summary.nodes)}`)
    assert.equal(summary.status, 'completed', `run 应完成：${summary.error ?? ''}`)

    // gate 真实 shell 只执行一次（sentinel 文件追加计数）
    assert.equal(readFileSync(join(env.dataDir, 'gate-runs'), 'utf8'), 'x', 'gate 恰好执行一次')

    // 子会话按派生关系识别；业务 Worker 标签由插件决定。
    const workers = env.app.kernel.listConversations().filter((c) => c.parentConversationId === ROOT_CONVERSATION_ID)
    assert.equal(workers.length, 1, '应派生恰好 1 个原生子会话')
    assert.equal(workers[0]!.tags.includes('worker'), false)

    // --- resume：相同 script、缺省 args 命中账本前缀 —— agent 槽位重放，
    //     不再发起模型调用、不重跑 gate（副作用绝不重复）。
    const modelCallsBefore = env.faux.state.callCount
    const gateRunsBefore = readFileSync(join(env.dataDir, 'gate-runs'), 'utf8')
    const { run: resumed } = await env.runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const resumedResult = resumed.result as { answer: number }
    assert.deepEqual(resumedResult, STRUCTURED, '重放结果与原 run 一致（账本前缀命中）')
    assert.equal(env.faux.state.callCount, modelCallsBefore, 'resume 不得再发起模型调用')
    assert.equal(readFileSync(join(env.dataDir, 'gate-runs'), 'utf8'), gateRunsBefore, 'resume 不得重跑 gate')
    assert.equal((await env.inspectRun(resumed.id)).run.replayedFrom, started.id, '公开摘要应保留重放来源')

    // 不新增子会话（重放不 live spawn）。
    assert.equal(env.app.kernel.listConversations().filter((c) => c.parentConversationId === ROOT_CONVERSATION_ID).length, 1)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. workflow action() -> ctx.action 共享校验器；resume 不重复 handler
// ---------------------------------------------------------------------------

test('工作流2: action() 经 PluginHost 动作总线共享 Schema 校验——合法执行/非法显式失败/重放不重复 handler', { timeout: 60_000 }, async () => {
  const env = await makeWfEnv()
  try {
    const script =
      'export const meta = { name: "e2e-action", description: "action bus" }\n' +
      'const a = await action("test:probe.echo", { text: "wf-hello" })\n' +
      'return a'

    const { run: started } = await env.runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const result = started.result as { echoed: string }
    assert.deepEqual(result, { echoed: 'wf-hello' }, 'action 结果应回传脚本')
    assert.deepEqual(env.echoCalls, ['wf-hello'], 'handler 恰好执行一次')

    // 非法入参：workflow 面与 HTTP/CLI 同一校验器 —— action 节点显式 error（引擎契约：
    // 动作失败折叠为 null 回传脚本，但节点进度与 handler 计数如实反映失败）
    const badScript =
      'export const meta = { name: "e2e-action-bad", description: "bad input" }\n' +
      'const a = await action("test:probe.echo", { text: "" })\n' +
      'return a'
    // wait:true 下引擎最终态为 completed（动作失败折叠 null 回传脚本，节点如实 failed）
    const { run: bad } = await env.runWorkflow({ script: badScript, conversationId: ROOT_CONVERSATION_ID, wait: true })
    assert.equal(bad.result, null, '引擎契约：动作失败折叠为 null 回传脚本（不伪造结果）')
    const badSummary = (await env.inspectRun(bad.id)).run
    const badNode = badSummary.nodes?.find((n) => n.kind === 'action')
    assert.ok(badNode, '应含 action 节点')
    assert.equal(badNode!.status, 'failed', '非法入参动作节点应显式 failed')
    assert.ok(/校验失败|minLength/.test(badNode!.error ?? ''), `节点错误应指向 Schema 校验：${badNode!.error}`)
    assert.deepEqual(env.echoCalls, ['wf-hello'], '非法输入不执行 handler（计数不增）')

    // 未知动作全限定 ID 同样折叠 null + 节点 failed
    const unknownScript =
      'export const meta = { name: "e2e-action-unknown", description: "unknown" }\n' +
      'const a = await action("test:probe.nope", {})\n' +
      'return a'
    const { run: unknown } = await env.runWorkflow({ script: unknownScript, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const unknownNode = (await env.inspectRun(unknown.id)).run.nodes?.find((n) => n.kind === 'action')
    assert.ok(unknownNode, '应含 action 节点')
    assert.equal(unknownNode!.status, 'failed')
    assert.ok(/未注册的动作|unknown/.test(unknownNode!.error ?? ''), `应报未知动作：${unknownNode!.error}`)

    // --- resume：action 终态行重放直接复用，绝不重执行 handler（副作用语义）
    const { run: resumed } = await env.runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const resumedResult = resumed.result as { echoed: string }
    assert.deepEqual(resumedResult, { echoed: 'wf-hello' })
    assert.deepEqual(env.echoCalls, ['wf-hello'], 'resume 重放不得重复执行 action handler')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. turn_settled 三态 + origins 精确断言（真实钩子载荷，非模糊 idle/error）
// ---------------------------------------------------------------------------

test('工作流3: turn_settled 钩子收集 completed/failed/aborted 三态各一次，inputs origin 精确记录', { timeout: 60_000 }, async () => {
  // aborted 场景需要真实在途流：慢速 token 流（1 tok/s）确保 abort 时回合仍在流式中。
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-e2e-'))
  const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const settled: Array<{ outcome: string; origins: string[]; conversationId: number; error?: string }> = []
    await app.kernel.plugins!.register({
      id: 'test:settled-probe',
      name: '结算探针',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settled.push({
            outcome: payload.outcome,
            origins: payload.inputs.map((i) => i.origin),
            conversationId: payload.conversation.id,
            ...(payload.error !== undefined ? { error: payload.error } : {}),
          })
        })
      },
    } satisfies PluginDefinition)

    const kernel = app.kernel

    // --- completed：正常回合（faux 纯文本响应）
    faux.setResponses([fauxAssistantMessage('好的')])
    await kernel.submitInput(ROOT_CONVERSATION_ID, '第一问')
    await kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.deepEqual(
      settled.filter((s) => s.conversationId === ROOT_CONVERSATION_ID).map((s) => s.outcome),
      ['completed'],
      '人类回合应恰好结算一次 completed',
    )
    assert.deepEqual(
      settled[0]!.origins,
      ['human'],
      '人类输入 origin 精确为 human',
    )

    // --- failed：模型流错误（faux stopReason=error 注入 provider 错误）
    const child = await kernel.createConversation({ title: '失败会话' })
    faux.setResponses([fauxAssistantMessage('boom', { stopReason: 'error' })])
    await kernel.submitInput(child.id, '会失败的问题')
    await kernel.waitForIdle(child.id)
    const childSettled = settled.filter((s) => s.conversationId === child.id)
    assert.equal(childSettled.length, 1, '失败回合恰好结算一次')
    assert.equal(childSettled[0]!.outcome, 'failed', '模型错误应结算 failed（不伪装 completed）')
    assert.ok(childSettled[0]!.error !== undefined, 'failed 结算应携带错误摘要')
    assert.deepEqual(childSettled[0]!.origins, ['human'])

    // --- aborted：慢速流式（1 tok/s）中提交后立即 abort，回合在途被取消
    const child2 = await kernel.createConversation({ title: '中止会话' })
    faux.setResponses([fauxAssistantMessage('这是一段被慢速流式输出的长文本确保 abort 时仍在流式中')])
    await kernel.submitInput(child2.id, '会被中止的问题')
    await kernel.abortConversation(child2.id)
    await kernel.waitForIdle(child2.id)
    const child2Settled = settled.filter((s) => s.conversationId === child2.id)
    assert.equal(child2Settled.length, 1, '中止回合恰好结算一次（不双报）')
    assert.equal(child2Settled[0]!.outcome, 'aborted', '在途 abort 应结算 aborted')

    // --- busy followUp：会话正忙时第二条输入 followUp 排队，两输入都被消费
    const busy = await kernel.createConversation({ title: '忙碌会话' })
    faux.setResponses([
      fauxAssistantMessage('第一答'),
      fauxAssistantMessage('第二答'),
    ])
    await kernel.submitInput(busy.id, '忙碌问题一')
    const second = kernel.submitInput(busy.id, '忙碌问题二', { whenBusy: 'followUp' })
    await second
    await kernel.waitForIdle(busy.id)
    const busySettled = settled.filter((s) => s.conversationId === busy.id)
    // followUpMode 'all'：两条输入合并进后续 run；结算次数 >= 1 且 origins 全记录
    assert.ok(busySettled.length >= 1, '忙碌会话至少结算一次')
    assert.ok(busySettled.every((s) => s.outcome === 'completed'), '两回合全部完成')
    const allOrigins = busySettled.flatMap((s) => s.origins)
    assert.equal(allOrigins.filter((o) => o === 'human').length, 2, '两条 human 输入都被消费')

    // --- agent origin：runtime.submitInput(origin:'agent')（子代理回报路径）
    const agentConv = await kernel.createConversation({ title: 'agent 汇报' })
    faux.setResponses([fauxAssistantMessage('代理收到')])
    await kernel.submitInput(agentConv.id, '后台代理汇报', { origin: 'agent' })
    await kernel.waitForIdle(agentConv.id)
    const agentSettled = settled.filter((s) => s.conversationId === agentConv.id)
    assert.equal(agentSettled.length, 1)
    assert.equal(agentSettled[0]!.outcome, 'completed')
    assert.deepEqual(agentSettled[0]!.origins, ['agent'], 'agent 来源输入精确记录')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. SubagentWorkflow 模型工具 -> kernel.runWorkflow 真实挂接（HTTP 触发全链路）
// ---------------------------------------------------------------------------

test('工作流4: HTTP workflows run/inspect/abort 与 SubagentWorkflow 工具共享同一真实引擎', { timeout: 60_000 }, async () => {
  const env = await makeWfEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url

    // setup 鉴权
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '工作流集成密码八位' }),
    })
    assert.equal(setup.status, 200)
    const token = (JSON.parse(await setup.text()) as { token: string }).token
    const auth = { authorization: `Bearer ${token}` }

    // 纯脚本 run（无 agent）：args 透传 + 真实 worker 执行 + 状态可查询
    //（编排已剥离为 builtin:workflow 插件动作，HTTP 经 /api/actions 同链路）
    const run = await fetch(`${base}/api/actions/builtin:workflow/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: {
          conversationId: env.app.kernel.listConversations()[0]!.id,
          script: 'export const meta = { name: "http-pure", description: "t" }\nreturn args.x + 1',
          args: { x: 41 },
          wait: true,
        },
      }),
    })
    assert.equal(run.status, 200)
    const final = ((JSON.parse(await run.text()) as { run: { id: string; status: string; result?: unknown } }).run)
    assert.equal(final.status, 'completed', `HTTP run 应完成：${JSON.stringify(final)}`)
    assert.equal(final.result, 42, 'args.x + 1 经真实 worker 计算为 42')

    // abort 已完成 run：幂等成功（不误报）
    const abort = await fetch(`${base}/api/actions/builtin:workflow/abort`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { runId: final.id } }),
    })
    assert.equal(abort.status, 200)

    // 未知 runId inspect：显式 404
    const missing = await fetch(`${base}/api/actions/builtin:workflow/inspect`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { runId: 'wf_nosuchrun' } }),
    })
    assert.equal(missing.status, 404)

    // 非法请求（无 script/name）：显式 400 validation_error，不伪造运行
    const bad = await fetch(`${base}/api/actions/builtin:workflow/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { args: { x: 1 }, conversationId: env.app.kernel.listConversations()[0]!.id } }),
    })
    assert.equal(bad.status, 400)
    assert.equal((JSON.parse(await bad.text()) as { error: { code: string } }).error.code, 'validation_error')
  } finally {
    await hub?.close()
    await env.close()
  }
})
