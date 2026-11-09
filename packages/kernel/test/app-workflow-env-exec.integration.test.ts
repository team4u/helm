/**
 * builtin:workflow env.exec + prepareAction 插件接线集成验收（真实 createHelm 组合）。
 *
 * 与 app-workflow.integration.test.ts 的分工：本文件专注 3b70fd1e 主线能力经
 * **插件边界**（ctx.host.execEnv / ctx.host.prepareAction）接入后的真实行为：
 * 1. env.exec 经 builtin:workflow run 动作执行真实 shell 命令：当前会话
 *    (nodeId, cwd) 传递（在会话 cwd 内写哨兵文件证明）、result 真实；
 * 2. 失败命令默认抛 env_exec_failed（节点 failed）；allowFailure: true 显式放行；
 * 3. 普通插件动作 preflight invalid input 写幂等失败行（无 action_started），
 *    不留下 non-idempotent uncertain 使 resumeFromRunId 锁死；
 * 4. 插件声明 idempotent: true 的动作在账本幂等标记生效（resume 断链可安全重跑）。
 *
 * 诚实性纪律：不请求模型（纯 action 脚本，faux provider 仅满足启动依赖）；
 * 引擎行为为真实执行（真 worker 线程、真 journal fsync、真 shell）。绝不 mock
 * WorkflowService / execEnv。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { ROOT_CONVERSATION_ID, HelmError, type PluginDefinition, type WorkflowRunSummary } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { readJournal, type WorkflowJournalEntry } from '../src/builtin-plugins/workflow/engine/journal.js'

function dirnameOf(u: string): string {
  return fileURLToPath(new URL('.', u))
}
const testDir = dirnameOf(import.meta.url)

interface Env {
  dataDir: string
  convCwd: string
  /** 绑定 (local, convCwd) 的靶点会话：env.exec 缺省靶点继承自它。 */
  convId: number
  app: Awaited<ReturnType<typeof createHelm>>
  /** echo action handler 执行计数（副作用哨兵）。 */
  echoCalls: string[]
  runWorkflow(request: Record<string, unknown>): Promise<{ run: WorkflowRunSummary }>
  inspectRun(runId: string): Promise<{ run: WorkflowRunSummary }>
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-env-act-'))
  const convCwd = join(dataDir, 'conv-cwd')
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })

  // 会话绑定 (nodeId='local', cwd=convCwd)：env.exec 缺省靶点必须继承它。
  const { mkdirSync } = await import('node:fs')
  mkdirSync(convCwd, { recursive: true })
  const conv = await app.kernel.createConversation({ title: 'env.exec 靶点会话', cwd: convCwd })

  const echoCalls: string[] = []
  await app.kernel.plugins!.register({
    id: 'test:probe',
    name: '探针',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { echoed: string }>({
        id: 'echo',
        description: '回显',
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

  const plugins = app.kernel.plugins!
  return {
    dataDir,
    convCwd,
    convId: conv.id,
    app,
    echoCalls,
    runWorkflow: (request) =>
      plugins.invokeAction('builtin:workflow', 'run', request) as Promise<{ run: WorkflowRunSummary }>,
    inspectRun: (runId) =>
      plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{ run: WorkflowRunSummary }>,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

const META = (name: string) => `export const meta = { name: "${name}", description: "d" }\n`

test('env.exec1: 插件边界真实 shell——会话 (nodeId,cwd) 传递、失败默认拒绝、allowFailure 放行', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const sentinel = join(env.convCwd, 'cwd-proof.txt')

    // 1) pwd 写哨兵：证明命令在会话绑定 cwd 内执行（(nodeId,cwd) 传递），result 真实。
    // command 数组在宿主侧序列化一次，脚本内 JSON.parse 还原（避免多层引号嵌套）。
    const writeCmd = JSON.stringify([
      'node',
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, process.cwd())`,
    ])
    const { run: ok } = await env.runWorkflow({
      script:
        META('env-act-ok') +
        `const res = await action("env.exec", { command: JSON.parse(${JSON.stringify(writeCmd)}) }, { idempotent: true, label: "write-cwd" })\n` +
        'return res',
      conversationId: env.convId,
      wait: true,
    })
    const result = ok.result as { ok: boolean; exitCode: number; output: string; timedOut: boolean }
    assert.equal(ok.status, 'completed', ok.error)
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.ok(existsSync(sentinel), '哨兵文件必须写入（命令真实执行）')
    assert.equal(readFileSync(sentinel, 'utf-8'), env.convCwd, '命令必须在会话绑定 cwd 内执行')

    // 2) 失败命令默认 env_exec_failed：节点 failed、result 折叠 null（不伪造成功）。
    const failCmd = JSON.stringify(['node', '-e', "process.stderr.write('boom'); process.exit(3)"])
    const { run: bad } = await env.runWorkflow({
      script:
        META('env-act-fail') +
        `const res = await action("env.exec", { command: JSON.parse(${JSON.stringify(failCmd)}) })\n` +
        'return res',
      conversationId: env.convId,
      wait: true,
    })
    assert.equal(bad.status, 'completed', '引擎契约：动作失败折叠 null 回传脚本，run 终态仍 completed')
    assert.equal(bad.result, null)
    const badNode = bad.nodes?.find((n) => n.kind === 'action')
    assert.ok(badNode, '应含 action 节点')
    assert.equal(badNode!.status, 'failed')
    assert.match(badNode!.error ?? '', /命令执行失败.*exitCode=3/)
    assert.match(badNode!.error ?? '', /boom/)

    // 3) allowFailure: true 显式放行：拿到真实失败结果对象。
    const exitCmd = JSON.stringify(['node', '-e', 'process.exit(7)'])
    const { run: tolerated } = await env.runWorkflow({
      script:
        META('env-act-tolerate') +
        `const res = await action("env.exec", { command: JSON.parse(${JSON.stringify(exitCmd)}), allowFailure: true })\n` +
        'return res',
      conversationId: env.convId,
      wait: true,
    })
    const toleratedResult = tolerated.result as { ok: boolean; exitCode: number | null }
    assert.equal(tolerated.status, 'completed', tolerated.error)
    assert.equal(toleratedResult.ok, false)
    assert.equal(toleratedResult.exitCode, 7)
  } finally {
    await env.close()
  }
})

test('env.exec2: 普通插件动作 preflight invalid input 不锁死 resume；声明 idempotent 生效', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 1) 非法入参（test:probe.echo text 为空串）经 ctx.host.prepareAction 在
    //    action_started 落盘前拒绝：写幂等失败行，账本无悬挂 started。
    // wait:true 等待结算链完成；仅 inspect 看到终态时，旧 run 仍可能在收尾。
    let failedRunId: string | undefined
    await assert.rejects(env.runWorkflow({
      script:
        META('preflight-invalid') +
        'const a = await action("test:probe.echo", { text: "" })\n' +
        'if (!a) throw new Error("step failed")\n' +
        'return a',
      conversationId: env.convId,
      wait: true,
    }), (error: unknown) => {
      if (!(error instanceof HelmError) || error.code !== 'workflow_failed') return false
      const details = error.details as { runId?: unknown } | undefined
      if (typeof details?.runId !== 'string') return false
      failedRunId = details.runId
      return true
    })
    assert.ok(failedRunId)
    const started = { id: failedRunId }
    const badRun = (await env.inspectRun(started.id)).run
    assert.equal(badRun.status, 'failed', `参数错误应显式失败：${badRun.error}`)
    const badNode = badRun.nodes?.find((n) => n.kind === 'action')
    assert.ok(badNode)
    assert.equal(badNode!.status, 'failed')
    assert.match(badNode!.error ?? '', /校验失败|minLength/)
    assert.deepEqual(env.echoCalls, [], '非法输入不执行 handler')

    // 账本（引擎私有 journal）不得含 action_started，且无 non-idempotent uncertain。
    const journalPath = join(env.dataDir, 'plugins', 'builtin:workflow', 'artifacts', String(env.convId), `workflow-${started.id}.jsonl`)
    assert.ok(existsSync(journalPath), `journal 应存在：${journalPath}`)
    const journal = readJournal(journalPath)
    assert.equal(journal.actionUncertain, false, 'preflight 失败不得留下 uncertain')
    assert.equal(journal.entries.some((e) => e.type === 'action_started'), false, 'preflight 失败不落 started 行')
    const failedLine = journal.entries.find((e): e is Extract<WorkflowJournalEntry, { type: 'action' }> => e.type === 'action')
    assert.ok(failedLine, '应含幂等失败终态行')
    assert.equal(failedLine.idempotent, true, 'preflight 失败行幂等标记（安全重跑）')

    // 2) 同名脚本改正后 resumeFromRunId 不被锁死：合法输入正常执行。
    const { run: resumed } = await env.runWorkflow({
      script:
        META('preflight-invalid') +
        'const a = await action("test:probe.echo", { text: "after-fix" })\n' +
        'return a',
      resumeFromRunId: started.id,
      conversationId: env.convId,
      wait: true,
    })
    assert.equal(resumed.status, 'completed', `resume 不得被 uncertain 锁死：${resumed.error}`)
    assert.deepEqual(resumed.result, { echoed: 'after-fix' })
    assert.deepEqual(env.echoCalls, ['after-fix'], '合法输入 handler 恰好执行一次')
  } finally {
    await env.close()
  }
})

test('env.exec3: 插件声明 idempotent: true 的动作在账本生效（resume 失败步安全重跑）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-idem-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    let handlerRuns = 0
    let shouldFail = true
    await app.kernel.plugins!.register({
      id: 'test:idem',
      name: '幂等探针',
      definePlugin(ctx) {
        ctx.action<Record<string, never>, { n: number }>({
          id: 'probe',
          description: '幂等探针动作',
          idempotent: true,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
            additionalProperties: false,
          },
          handler: () => {
            handlerRuns++
            if (shouldFail) throw new HelmError('probe_failed', '第一次执行失败', 500)
            return { n: handlerRuns }
          },
        })
      },
    } satisfies PluginDefinition)

    const runWorkflow = (request: Record<string, unknown>) =>
      app.kernel.plugins!.invokeAction('builtin:workflow', 'run', request) as Promise<{ run: WorkflowRunSummary }>

    // 第一次：handler 失败（副作用语义如实记录；动作失败折叠 null，脚本显式失败）。
    let failedRunId: string | undefined
    await assert.rejects(runWorkflow({
      script:
        META('idem-probe') +
        'const a = await action("test:idem.probe", {})\n' +
        'if (!a) throw new Error("probe failed")\n' +
        'return a',
      conversationId: ROOT_CONVERSATION_ID,
      wait: true,
    }), (error: unknown) => {
      if (!(error instanceof HelmError) || error.code !== 'workflow_failed') return false
      const details = error.details as { runId?: unknown } | undefined
      if (typeof details?.runId !== 'string') return false
      failedRunId = details.runId
      return true
    })
    assert.ok(failedRunId)
    const first = { id: failedRunId }
    const firstRun = (await app.kernel.plugins!.invokeAction('builtin:workflow', 'inspect', { runId: first.id })) as { run: WorkflowRunSummary }
    assert.equal(firstRun.run.status, 'failed')
    assert.equal(handlerRuns, 1)

    // 账本失败终态行必须带 idempotent: true（定义端声明经 prepareAction 传递）。
    const journalPath = join(dataDir, 'plugins', 'builtin:workflow', 'artifacts', String(ROOT_CONVERSATION_ID), `workflow-${first.id}.jsonl`)
    const journal = readJournal(journalPath)
    const failedAction = journal.entries.find((e): e is Extract<WorkflowJournalEntry, { type: 'action' }> => e.type === 'action' && !e.ok)
    assert.ok(failedAction, '失败终态行存在')
    assert.equal(failedAction.idempotent, true, '声明 idempotent 的动作失败行必须幂等标记')
    // 失败幂等动作不计入 uncertain（readJournal 契约：failedActions 仅统计非幂等）。
    assert.equal(journal.failedActions, 0)

    // 修复后 resume：幂等失败允许断链重跑，handler 再次执行并成功。
    shouldFail = false
    const { run: resumed } = await runWorkflow({
      script:
        META('idem-probe') +
        'const a = await action("test:idem.probe", {})\n' +
        'if (!a) throw new Error("probe failed")\n' +
        'return a',
      resumeFromRunId: first.id,
      conversationId: ROOT_CONVERSATION_ID,
      wait: true,
    })
    assert.equal(resumed.status, 'completed', `幂等失败 resume 必须可重跑：${resumed.error}`)
    assert.deepEqual(resumed.result, { n: 2 })
    assert.equal(handlerRuns, 2, '幂等失败步 live 重跑（副作用已声明安全）')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
