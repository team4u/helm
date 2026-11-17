/**
 * Hub 重启任务无感恢复与批量续跑全链路集成测试（覆盖设计文档 T1 / T2 / T3 / T5 与安全红线）。
 *
 * - T1：原生后台单子代理（含 isolation: 'worktree' + schema + gate）在 close() 优雅挂起与
 *   真实子进程 SIGKILL 下的原位重挂恢复、单消息幂等、租约保留与释放、父会话汇报；
 * - T2：多阶段混合并发 DSL 工作流在 close() 与真实 SIGKILL 下的同 runId 原位续跑、
 *   非幂等 action 零重复执行、原账本文件 seq 严格递增且零重复终态行、agent_started 截断尾行容错与悬挂 action_started 阻断；
 * - T3：同步 subagent 与同步 SubagentWorkflow 工具（replay: 'safe'）在父回合 ToolTask 中途
 *   close() 重启后的 (conversationId, callId) 幂等重放，零重复派生；
 * - T5：单子代理 resumeFromRunId、resume_failed 动作与真实 CLI `helm workflows resume-failed`
 *   （5 个失败任务拉起 4 跳过 1、二次调用幂等 0 新拉起、参数互斥校验）；
 * - 安全红线：crashRecoveries > 3 熔断（[crash_recovery_limit]）、secretNames 未就绪重启失效
 *   （[secret_grant_expired_on_restart]，落盘绝不含 secretNames）、配置类型校验与 HELM_AUTO_RECOVER=0 逃生阀。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { HelmError, type AgentSpawnRequest, type HelmEventFrame } from '@helm/protocol'
import { createHelm } from '../../hub/src/app.js'
import { startHub } from '../../kernel/src/http/index.js'
import { KernelRuntime } from '../../kernel/src/runtime/index.js'
import type { WorkflowRunSummary } from '../src/contracts.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { readJournal } from '../src/workflow/engine/journal.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/engine/service.js'
import {
  createGitTemplate,
  deferred,
  makeFauxProvider,
  sanitizedHostEnv,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'

const require = createRequire(import.meta.url)
const KERNEL_DIR = new URL('../../kernel/', import.meta.url).pathname
const PI_AI_DIR = join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai')
const KERNEL_SRC = pathToFileURL(join(KERNEL_DIR, 'src/runtime/index.ts')).href
const PI_AI_FAUX_URL = pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href
const WORKFLOW_SRC = pathToFileURL(new URL('../src/workflow.ts', import.meta.url).pathname).href
const PLUGIN_BUILD_URL = import.meta.resolve('@helm/plugin-build')
const CLI_ENTRY = new URL('../../cli/src/index.ts', import.meta.url).pathname
const TSX_CLI = require.resolve('tsx/cli')

const gitTemplate = createGitTemplate()

function recordPathOf(dataDir: string, convId: number, runId: string): string {
  return join(
    dataDir,
    'plugins',
    'builtin%3Aworkflow',
    'artifacts',
    String(convId),
    `workflow-${runId}.record.json`,
  )
}

function readPersistedRecord(dataDir: string, convId: number, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(recordPathOf(dataDir, convId, runId), 'utf8')) as Record<string, unknown>
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      env: sanitizedHostEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

async function spawnSigkillSeeder(
  seedDir: string,
  scriptBody: string,
  extraEnv: Record<string, string>,
): Promise<string> {
  const scriptPath = join(seedDir, 'seeder.mts')
  writeFileSync(scriptPath, scriptBody, 'utf8')
  const child = spawn(process.execPath, [TSX_CLI, scriptPath], {
    cwd: KERNEL_DIR,
    env: sanitizedHostEnv({
      HOME: seedDir,
      HELM_WATCHDOG_INTERVAL_MS: '0',
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return await Promise.race([
    new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8')
      })
      child.on('exit', (code, signal) => {
        if (signal === 'SIGKILL' || code === 137) resolve(out)
        else reject(new Error(`seeder 未以 SIGKILL 结束（code=${code} signal=${signal}）:\n${out}\n${err}`))
      })
      child.on('error', reject)
    }),
    delay(30_000, undefined, { ref: false }).then(() => {
      child.kill('SIGKILL')
      throw new Error('SIGKILL seeder 30s 超时')
    }),
  ])
}

// ---------------------------------------------------------------------------
// T1：原生后台单子代理（Worktree + Schema + Gate）close() 与 SIGKILL 无感恢复
// ---------------------------------------------------------------------------

test('T1-A: 原生后台单子代理（isolation:worktree + schema + gate）经 close() 优雅挂起后重启原位重挂完成且零重复消息/零重复树', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-t1-graceful-')
  const repoDir = gitTemplate.cloneTo(join(root, 'repo'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })

  // 进程 1：阻塞工具卡住子会话回合（监听 context.signal 在 close 时立即随 Harness 中断退回 replay:safe）
  const f1 = makeFauxProvider()
  const enteredHold1 = deferred<void>()
  f1.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_step', {}, { id: 'tc-hold-1' })], { stopReason: 'toolUse' }),
  ])

  let k1: KernelRuntime | undefined
  let k2: KernelRuntime | undefined
  try {
    k1 = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/faux-1',
      providers: [f1.provider],
      autoResume: false,
    })
    await k1.plugins.register(createWorkflowPlugin())
    await k1.plugins.register({
      id: 'test:t1-hold',
      name: 'T1 Hold Tool',
      definePlugin(ctx) {
        ctx.tool({
          name: 'hold_step',
          description: '阻塞测试工具',
          replay: 'safe',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_input, toolCtx) => {
            enteredHold1.resolve()
            await new Promise<void>((_, reject) => {
              if (toolCtx.signal?.aborted) {
                reject(new Error('aborted'))
                return
              }
              toolCtx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
            return 'hold-ok'
          },
        })
      },
    })
    await k1.start()

    const toolOut = (await k1.plugins.executeTool(
      'subagent',
      {
        prompt: '在独立工作树输出结构化验收结果',
        isolation: 'worktree',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, tag: { type: 'string' } },
          required: ['ok', 'tag'],
          additionalProperties: false,
        },
        gate: 'git rev-parse --is-inside-work-tree',
      },
      { conversationId: 1, callId: 'call-t1-bg' },
    )) as { structuredOutput: { ok: boolean; background: boolean; runId: string; execution?: { conversationId?: number; worktree?: { path: string; branch: string } } } }

    assert.equal(toolOut.structuredOutput.ok, true)
    assert.equal(toolOut.structuredOutput.background, true)
    const runId = toolOut.structuredOutput.runId
    const childId = toolOut.structuredOutput.execution?.conversationId
    const worktreePath = toolOut.structuredOutput.execution?.worktree?.path
    assert.ok(childId && childId > 1)
    assert.ok(worktreePath)

    await enteredHold1.promise
    await k1.close()
    k1 = undefined

    // 验证优雅挂起后的磁盘快照与 Worktree 租约保留
    const suspendedRecord = readPersistedRecord(dataDir, 1, runId)
    assert.equal(suspendedRecord['status'], 'running', '优雅 close 必须保持 running')
    assert.equal(suspendedRecord['suspendedCleanly'], true, '优雅 close 必须置位 suspendedCleanly=true')
    assert.equal(suspendedRecord['crashRecoveries'], undefined, '优雅挂起不得累加 crashRecoveries')
    const specOnDisk = suspendedRecord['subagentSpec'] as Record<string, unknown>
    assert.ok(specOnDisk && specOnDisk['requestId'] === `helm:spawn:${runId}`)
    assert.equal('secretNames' in specOnDisk, false, 'subagentSpec 绝不得落盘 secretNames')

    // 进程 2：重开恢复，hold_step 重放通过，子会话调 register_structured_output 并通过 gate，向父会话汇报
    const f2 = makeFauxProvider()
    f2.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('register_structured_output', { output: { ok: true, tag: 't1-recovered' } }, { id: 'tc-so-1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('已完成结构化输出'),
      fauxAssistantMessage('主会话已收到后台汇报'),
    ])

    k2 = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/faux-1',
      providers: [f2.provider],
      autoResume: false,
    })
    const parentReports: string[] = []
    k2.events.subscribe((frame: HelmEventFrame) => {
      const ev = frame.event as { type?: string; conversationId?: number; entry?: { kind?: string; data?: { meta?: { kind?: string } } } }
      if (ev.type === 'conversation.entry' && ev.conversationId === 1 && ev.entry?.kind === 'helm.input') {
        parentReports.push(String(ev.entry.data?.meta?.kind ?? ''))
      }
    })

    await k2.plugins.register(createWorkflowPlugin())
    await k2.plugins.register({
      id: 'test:t1-hold',
      name: 'T1 Hold Tool',
      definePlugin(ctx) {
        ctx.tool({
          name: 'hold_step',
          description: '阻塞测试工具',
          replay: 'safe',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => 'hold-replayed-ok',
        })
      },
    })
    await k2.start()

    await waitFor(async () => {
      const inspected = (await k2!.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }
      return inspected.run.status === 'completed'
    }, { timeoutMs: 20_000 })

    const finalRun = ((await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }).run
    assert.equal(finalRun.id, runId, '必须原 runId 收敛')
    assert.deepEqual(finalRun.result, { ok: true, tag: 't1-recovered' })

    const finalRecord = readPersistedRecord(dataDir, 1, runId)
    assert.equal(finalRecord['suspendedCleanly'], undefined, '恢复后必须清除 suspendedCleanly')
    assert.equal(finalRecord['crashRecoveries'], undefined, '优雅恢复不计异常崩溃')

    const childDetail = await k2.getConversationDetail(childId, { limit: 100 })
    const childUsers = childDetail.entries.filter((e) => e.kind === 'pi.user')
    assert.equal(childUsers.length, 1, 'requestId 幂等保证子会话绝无重复用户消息或重复 worktreeContextPrompt')

    const worktrees = (await k2.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as { worktrees: Array<{ path: string }> }
    assert.equal(worktrees.worktrees.length, 1, '绝不重复分配第二个 Worktree')
    assert.equal(worktrees.worktrees[0]!.path, worktreePath)

    const postWtState = k2.documentStore.get<Record<string, unknown>>('builtin:workflow:worktree-state', {})
    assert.deepEqual(postWtState['worktree-leases'] ?? {}, {}, '任务完成后 Worktree running 租约应正常释放')

    await waitFor(() => parentReports.includes('subagent_report'), { timeoutMs: 10_000 })
  } finally {
    await k1?.close().catch(() => {})
    await k2?.close().catch(() => {})
  }
})

test('T1-B: 原生后台单子代理经真实子进程 SIGKILL 强杀后重启原位恢复完成（crashRecoveries=1）', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-t1-sigkill-')
  const repoDir = gitTemplate.cloneTo(join(root, 'repo'))
  const dataDir = join(root, 'data')
  const seedDir = join(root, 'seed')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(seedDir, { recursive: true })

  const out = await spawnSigkillSeeder(
    seedDir,
    `import { setTimeout as delay } from 'node:timers/promises'
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(PI_AI_FAUX_URL)}
import { KernelRuntime } from ${JSON.stringify(KERNEL_SRC)}
import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
import { createWorkflowPlugin } from ${JSON.stringify(WORKFLOW_SRC)}

const dataDir = process.env.HELM_DATA_DIR!
const repoDir = process.env.HELM_REPO_DIR!
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
faux.setResponses([fauxAssistantMessage('这是一段极慢速流式回复用于在流式中途触发真实SIGKILL强杀现场验证后台子代理原位重挂恢复')])
const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: repoDir, model: 'faux/faux-1', providers: [faux.provider], autoResume: false })
await kernel.plugins.register(createWorkflowPlugin())
await kernel.start()
const res = await kernel.plugins.executeTool('subagent', { prompt: '慢任务', isolation: 'worktree' }, { conversationId: 1, callId: 'call-sigkill-t1' })
const runId = res.structuredOutput.runId
const childId = res.structuredOutput.execution.conversationId
for (let i = 0; i < 400; i++) {
  await delay(10)
  if (faux.state.callCount >= 1 && kernel.getConversation(childId).status === 'working') break
}
await kernel.documentStore.flush()
await new Promise((r) => process.stdout.write('RUN=' + runId + ',CHILD=' + childId + '\\n', r))
process.kill(process.pid, 'SIGKILL')
`,
    { HELM_DATA_DIR: dataDir, HELM_REPO_DIR: repoDir },
  )

  const match = /RUN=([^\s,]+),CHILD=(\d+)/.exec(out)
  assert.ok(match, `seeder 输出异常: ${out}`)
  const [, runId, childIdRaw] = match
  const childId = Number(childIdRaw)

  const f2 = makeFauxProvider()
  f2.setResponses([
    fauxAssistantMessage('SIGKILL恢复后完成的最终子代理输出'),
    fauxAssistantMessage('主会话收到汇报'),
  ])
  const k2 = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    providers: [f2.provider],
    autoResume: false,
  })
  try {
    await k2.plugins.register(createWorkflowPlugin())
    await k2.start()

    await waitFor(async () => {
      const inspected = (await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }
      return inspected.run.status === 'completed'
    }, { timeoutMs: 20_000 })

    const finalRun = ((await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }).run
    assert.equal(finalRun.result, 'SIGKILL恢复后完成的最终子代理输出')
    const record = readPersistedRecord(dataDir, 1, runId!)
    assert.equal(record['crashRecoveries'], 1, 'SIGKILL 非优雅恢复必须记录 crashRecoveries=1')
    const childDetail = await k2.getConversationDetail(childId, { limit: 100 })
    assert.equal(childDetail.entries.filter((e) => e.kind === 'pi.user').length, 1, 'SIGKILL 重挂不重复追加用户消息')
    // 等待主会话处理完后台汇报（回合完成后 unread=true 置为 done），避免 close 时报 PluginHost 已 dispose
    await waitFor(
      () => {
        const rootConv = k2.getConversation(1)
        return rootConv.completionSeq >= 1 && rootConv.status !== 'working'
      },
      { timeoutMs: 10_000 },
    )
  } finally {
    await k2.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// T2：DSL 工作流多阶段混合并发原位续跑、账本零重复追加、截断尾行与 uncertain 阻断
// ---------------------------------------------------------------------------

test('T2-A: DSL 多阶段混合并发工作流经 close() 后按原 runId 原位续跑（已完成 agent/action 零重跑且账本零重复行）', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-t2-graceful-')
  let sideEffectCount = 0
  const enteredHoldB = deferred<void>()

  const f1 = makeFauxProvider()
  // 按提示词确定性路由响应（消除 parallel-a 与 parallel-b 并发到达模型的顺序竞争）
  const routePrompt = (ctx: { messages: unknown[] }) => {
    const text = JSON.stringify(ctx.messages)
    if (text.includes('parallel-a')) return fauxAssistantMessage('PA_DONE')
    if (text.includes('parallel-b')) {
      return fauxAssistantMessage([fauxToolCall('hold_b', {}, { id: 'tc-b' })], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage('S1_DONE')
  }
  f1.setResponses([routePrompt, routePrompt, routePrompt])

  const registerTestPlugin = (kernel: KernelRuntime, replayPhase: boolean) =>
    kernel.plugins.register({
      id: 'test:t2-helper',
      name: 'T2 Helper',
      definePlugin(ctx) {
        ctx.action({
          id: 'side_effect',
          description: '非幂等外部副作用动作',
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false },
          outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
          handler: async () => {
            sideEffectCount += 1
            return { count: sideEffectCount }
          },
        })
        ctx.tool({
          name: 'hold_b',
          description: '阻塞并行分支 B',
          replay: 'safe',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_input, toolCtx) => {
            if (!replayPhase) {
              enteredHoldB.resolve()
              await new Promise<void>((_, reject) => {
                if (toolCtx.signal?.aborted) {
                  reject(new Error('aborted'))
                  return
                }
                toolCtx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              })
            }
            return 'hold-b-ok'
          },
        })
      },
    })

  let k1: KernelRuntime | undefined
  let k2: KernelRuntime | undefined
  try {
    k1 = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [f1.provider],
      autoResume: false,
    })
    await k1.plugins.register(createWorkflowPlugin())
    await registerTestPlugin(k1, false)
    await k1.start()

    const script = `
export const meta = { name: "t2-mixed", description: "多阶段混合并发恢复验证" }
const s1 = await agent("stage-1")
const act = await action("test:t2-helper.side_effect", { tag: s1 })
const [pa, pb] = await parallel([
  () => agent("parallel-a"),
  () => agent("parallel-b"),
])
const s3 = await agent("stage-3:" + s1 + ":" + act.count + ":" + pa + ":" + pb)
return { s1, count: act.count, pa, pb, s3 }
`
    const { run } = (await k1.plugins.invokeAction('builtin:workflow', 'run', {
      conversationId: 1,
      script,
    })) as { run: WorkflowRunSummary }

    await enteredHoldB.promise
    // 确保 parallel-a 的终态行也已在 close 前落入账本
    const journalPath = String(readPersistedRecord(dataDir, 1, run.id)['journalPath'])
    await waitFor(() => {
      const j = readJournal(journalPath)
      const doneAgents = j.entries.filter((e) => e.type === 'agent' && e.ok)
      const startedAgents = j.entries.filter((e) => e.type === 'agent_started')
      return doneAgents.length === 2 && startedAgents.length === 3
    }, { timeoutMs: 10_000 })

    assert.equal(sideEffectCount, 1, '关停前非幂等 action 恰执行 1 次')
    await k1.close()
    k1 = undefined

    // 进程 2：重开，parallel-b 重挂完成 -> stage-3 执行完成 -> 同一 run.id completed
    const f2 = makeFauxProvider()
    f2.setResponses([
      fauxAssistantMessage('PB_RECOVERED'),
      fauxAssistantMessage('S3_FINAL'),
    ])

    k2 = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [f2.provider],
      autoResume: false,
    })
    await k2.plugins.register(createWorkflowPlugin())
    await registerTestPlugin(k2, true)
    await k2.start()

    await waitFor(async () => {
      const inspected = (await k2!.plugins.invokeAction('builtin:workflow', 'inspect', { runId: run.id })) as { run: WorkflowRunSummary }
      return inspected.run.status === 'completed'
    }, { timeoutMs: 20_000 })

    const finalRun = ((await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId: run.id })) as { run: WorkflowRunSummary }).run
    assert.equal(sideEffectCount, 1, '重放期间非幂等 action 严禁二次执行')
    assert.equal(f2.state.callCount, 2, '恢复后仅对未完的 parallel-b 与后续 stage-3 发起模型调用（stage-1 与 parallel-a 零 Token 重放）')
    assert.deepEqual(finalRun.result, {
      s1: 'S1_DONE',
      count: 1,
      pa: 'PA_DONE',
      pb: 'PB_RECOVERED',
      s3: 'S3_FINAL',
    })

    // 核验原账本文件：seq 严格单调递增、无重复终态行（恰 4 条 agent 终态 + 1 条 action 终态）
    const rawLines = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; type: string; scopePath: string; scopeCallIndex: number })
    for (let i = 0; i < rawLines.length; i++) {
      assert.equal(rawLines[i]!.seq, i, `原位续跑账本 seq 必须连续无冲突（第 ${i} 行实得 ${rawLines[i]!.seq}）`)
    }
    assert.equal(rawLines.filter((l) => l.type === 'action').length, 1, '已命中缓存的 action 终态行不得重复追加到原账本')
    assert.equal(rawLines.filter((l) => l.type === 'agent').length, 4, '4 个 agent 节点恰各写 1 条终态行（无重复追加）')
  } finally {
    await k1?.close().catch(() => {})
    await k2?.close().catch(() => {})
  }
})

test('T2-B: DSL 工作流经真实 SIGKILL 强杀恢复 + 截断 agent_started 尾行容错 + 悬挂非幂等 action_started 诚实阻断', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-t2-sigkill-')
  const dataDir = join(root, 'data')
  const seedDir = join(root, 'seed')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(seedDir, { recursive: true })

  const out = await spawnSigkillSeeder(
    seedDir,
    `import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(PI_AI_FAUX_URL)}
import { KernelRuntime } from ${JSON.stringify(KERNEL_SRC)}
import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
import { createWorkflowPlugin } from ${JSON.stringify(WORKFLOW_SRC)}

const dataDir = process.env.HELM_DATA_DIR!
const faux = fauxProvider({ tokensPerSecond: 2, tokenSize: { min: 2, max: 2 } })
let callIdx = 0
faux.setResponses([
  fauxAssistantMessage('FAST_STAGE_1'),
  async () => {
    callIdx++
    await delay(60_000)
    return fauxAssistantMessage('NEVER')
  },
])
const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', providers: [faux.provider], autoResume: false })
await kernel.plugins.register(createWorkflowPlugin())
await kernel.start()
const script = 'export const meta = { name: "t2-kill", description: "sigkill" }\\nconst a = await agent("s1")\\nconst b = await agent("s2:" + a)\\nreturn a + "|" + b'
const { run } = await kernel.plugins.invokeAction('builtin:workflow', 'run', { conversationId: 1, script })
const recPath = join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1', 'workflow-' + run.id + '.record.json')
for (let i = 0; i < 400; i++) {
  await delay(15)
  if (callIdx >= 1) {
    const rec = JSON.parse(readFileSync(recPath, 'utf8'))
    const jContent = readFileSync(rec.journalPath, 'utf8')
    if (jContent.split('\\n').filter(Boolean).length >= 3) break
  }
}
await kernel.documentStore.flush()
await new Promise((r) => process.stdout.write('RUN=' + run.id + '\\n', r))
process.kill(process.pid, 'SIGKILL')
`,
    { HELM_DATA_DIR: dataDir },
  )

  const runId = /RUN=([^\s]+)/.exec(out)?.[1]
  assert.ok(runId, `未拿到 runId: ${out}`)

  // 模拟进程强杀导致尾行额外残留半截 agent_started 行：应计 ioError 而不触发 actionUncertain
  const recBefore = readPersistedRecord(dataDir, 1, runId)
  const journalPath = String(recBefore['journalPath'])
  appendFileSync(journalPath, '{"type":"agent_started","scopePath":"root","trunc', 'utf8')
  const checkTruncated = readJournal(journalPath)
  assert.equal(checkTruncated.actionUncertain, false, '截断的 agent_started 尾行不得误判为 actionUncertain')
  assert.equal(checkTruncated.ioErrors, 1, '截断尾行须如实计入 ioErrors')

  const f2 = makeFauxProvider()
  f2.setResponses([fauxAssistantMessage('RECOVERED_STAGE_2')])
  const k2 = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    providers: [f2.provider],
    autoResume: false,
  })
  try {
    await k2.plugins.register(createWorkflowPlugin())
    await k2.start()

    await waitFor(async () => {
      const inspected = (await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }
      return inspected.run.status !== 'running'
    }, { timeoutMs: 20_000 })

    const settled = ((await k2.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: WorkflowRunSummary }).run
    assert.equal(settled.status, 'completed', `T2-B 恢复后应 completed，实得 error=${settled.error}`)
    assert.equal(settled.result, 'FAST_STAGE_1|RECOVERED_STAGE_2')
    assert.ok(settled.journalIoErrors && settled.journalIoErrors.length >= 1, '存量截断尾行诊断须保留在 journalIoErrors')
  } finally {
    await k2.close().catch(() => {})
  }

  // 悬挂非幂等 action_started 阻断验证：启动恢复必须守卫中止关联子会话并标 failed([workflow_action_uncertain])
  const uncertainDir = useTempDir(t, 'helm-t2-uncertain-')
  const abortedChildren: number[] = []
  const stateMap = new Map<string, unknown>()
  const memState: WorkflowStateStore = {
    get: <T>(k: string, init: T) => (stateMap.has(k) ? structuredClone(stateMap.get(k) as T) : init),
    set: (k, v) => { stateMap.set(k, structuredClone(v)) },
  }
  const uJournalPath = join(uncertainDir, 'artifacts', '1', 'workflow-wf_uncertain01.jsonl')
  mkdirSync(join(uncertainDir, 'artifacts', '1'), { recursive: true })
  writeFileSync(
    uJournalPath,
    `${JSON.stringify({ type: 'action_started', scopePath: 'root', scopeCallIndex: 0, index: 0, key: 'k1', v: 1, seq: 0 })}\n`,
    'utf8',
  )
  writeFileSync(
    join(uncertainDir, 'artifacts', '1', 'workflow-wf_uncertain01.record.json'),
    JSON.stringify({
      id: 'wf_uncertain01',
      name: 'uncertain-wf',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      script: 'export const meta = { name: "u", description: "u" }\nreturn 1',
      journalPath: uJournalPath,
      childConversationIds: [91],
    }),
    'utf8',
  )
  memState.set('workflow/runs', [{ id: 'wf_uncertain01', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
  const mockHost: WorkflowServiceHost = {
    spawnAgent: async () => 'unused',
    invokeAction: async () => ({}),
    listActions: () => [],
    getConversation: (id) => ({ id, title: 't', profileId: 'assistant', tags: [], cwd: uncertainDir, model: 'f/1', thinkingLevel: '', status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }),
    abortConversationGuarded: async (id) => { abortedChildren.push(id) },
    emitEvent: () => {},
  }
  const uSvc = new WorkflowService({ dataDir: uncertainDir, state: memState, host: mockHost })
  await uSvc.init()
  const uSummary = uSvc.getRun('wf_uncertain01')
  assert.equal(uSummary.status, 'failed')
  assert.match(uSummary.error ?? '', /workflow_action_uncertain/)
  assert.ok(abortedChildren.includes(91), 'actionUncertain 拒绝恢复时必须守卫中止遗留子会话')
  await uSvc.close()
})

// ---------------------------------------------------------------------------
// T3：同步 subagent 与同步 SubagentWorkflow 工具跨重启幂等重放（replay: 'safe'）
// ---------------------------------------------------------------------------

test('T3: 同步 subagent 与同步 SubagentWorkflow 在父回合 ToolTask 执行中遇 close() 重启后按 (conversationId, callId) 幂等重放，零重复派生', { timeout: 60_000 }, async (t) => {
  for (const mode of ['subagent', 'SubagentWorkflow'] as const) {
    const dataDir = useTempDir(t, `helm-t3-${mode}-`)
    const enteredChildHold = deferred<void>()

    const f1 = makeFauxProvider()
    if (mode === 'subagent') {
      f1.setResponses([
        // 父会话（helm-owned，默认同步）发起 subagent 工具调用
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '执行同步子任务' }, { id: 'call-sync-sub-1' })],
          { stopReason: 'toolUse' },
        ),
        // 子会话进入 hold_t3 阻塞
        fauxAssistantMessage([fauxToolCall('hold_t3', {}, { id: 'tc-child-hold' })], { stopReason: 'toolUse' }),
      ])
    } else {
      f1.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              'SubagentWorkflow',
              { script: 'export const meta = { name: "t3-sync-wf", description: "t3" }\nreturn await agent("同步编排步骤")' },
              { id: 'call-sync-wf-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('hold_t3', {}, { id: 'tc-wf-child-hold' })], { stopReason: 'toolUse' }),
      ])
    }

    let k1: KernelRuntime | undefined
    let k2: KernelRuntime | undefined
    try {
      k1 = await KernelRuntime.open({
        buildProvider: createPluginBuildProvider(),
        dataDir,
        cwd: dataDir,
        model: 'faux/faux-1',
        providers: [f1.provider],
        autoResume: false,
      })
      await k1.plugins.register(createWorkflowPlugin())
      await k1.plugins.register({
        id: 'test:t3-hold',
        name: 'T3 Hold',
        definePlugin(ctx) {
          ctx.tool({
            name: 'hold_t3',
            description: '阻塞子会话工具',
            replay: 'safe',
            inputSchema: { type: 'object', properties: {} },
            execute: async (_input, toolCtx) => {
              enteredChildHold.resolve()
              await new Promise<void>((_, reject) => {
                if (toolCtx.signal?.aborted) {
                  reject(new Error('aborted'))
                  return
                }
                toolCtx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              })
              return 'child-tool-done'
            },
          })
        },
      })
      await k1.start()

      // 创建 helm-owned 自动化父会话（同步执行 subagent / SubagentWorkflow）
      const parentConv = await k1.createConversation({ title: `t3-${mode}` })
      k1.markConversationOwnership(parentConv.id, 'helm')
      await k1.submitInput(parentConv.id, `请执行 ${mode}`, { origin: 'agent' })

      await enteredChildHold.promise
      const runsBeforeClose = ((await k1.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: WorkflowRunSummary[] }).runs
      assert.equal(runsBeforeClose.length, 1)
      const originalRunId = runsBeforeClose[0]!.id
      const convCountBeforeClose = k1.listConversations().length

      await k1.close()
      k1 = undefined

      // 进程 2：重开恢复，子会话先完成，父会话 ToolTask 重放命中原 originalRunId 并顺利结束整个父回合
      const f2 = makeFauxProvider()
      f2.setResponses([
        fauxAssistantMessage(`CHILD_DONE_${mode}`),
        fauxAssistantMessage(`PARENT_FINAL_${mode}`),
      ])

      k2 = await KernelRuntime.open({
        buildProvider: createPluginBuildProvider(),
        dataDir,
        cwd: dataDir,
        model: 'faux/faux-1',
        providers: [f2.provider],
        autoResume: false,
      })
      await k2.plugins.register(createWorkflowPlugin())
      await k2.plugins.register({
        id: 'test:t3-hold',
        name: 'T3 Hold',
        definePlugin(ctx) {
          ctx.tool({
            name: 'hold_t3',
            description: '阻塞子会话工具',
            replay: 'safe',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => 'child-tool-replayed',
          })
        },
      })
      await k2.start()

      await waitFor(
        () => {
          const conv = k2!.getConversation(parentConv.id)
          return conv.completionSeq >= 1 && conv.status !== 'working'
        },
        { timeoutMs: 20_000 },
      )
      assert.equal(k2.getConversation(parentConv.id).status, 'done')

      const runsAfter = ((await k2.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: WorkflowRunSummary[] }).runs
      assert.equal(runsAfter.length, 1, `${mode} 同步重放绝不得新建第二个 Run`)
      assert.equal(runsAfter[0]!.id, originalRunId)
      assert.equal(runsAfter[0]!.status, 'completed')
      assert.equal(k2.listConversations().length, convCountBeforeClose, `${mode} 同步重放绝不得派生第二个子会话`)

      assert.equal(
        await k2.getLastAssistantText(parentConv.id),
        `PARENT_FINAL_${mode}`,
        '父回合应在原 Run 收敛后拿到结果并完成总结',
      )
    } finally {
      await k1?.close().catch(() => {})
      await k2?.close().catch(() => {})
    }
  }
})

// ---------------------------------------------------------------------------
// T5：单子代理续接、resume_failed 批量恢复（动作 + 真 CLI）与熔断/机密/配置红线
// ---------------------------------------------------------------------------

test('T5: resume_failed 批量恢复（5 失败任务拉起 4 跳过 1、二次调用幂等 0 新拉起）与真 CLI helm workflows resume-failed 端到端', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-t5-batch-')
  const externalResumes: AgentSpawnRequest[] = []
  const faux = makeFauxProvider()
  faux.setResponses(Array.from({ length: 20 }, (_, idx) => fauxAssistantMessage(`RESUMED_OK_${idx + 1}`)))

  const app = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    // 注册一个模拟外部运行时插件（承接 agentType='ext:cli' 或 resume='pane-ext-4'）
    await app.kernel.plugins.register({
      id: 'test:ext-runtime',
      name: 'External Runtime Stub',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn(async (req) => {
          if (req.agentType === 'ext:cli' || req.resume === 'pane-ext-4') {
            externalResumes.push(req)
            req.onResolved?.({ nodeId: 'local', executionId: 'pane-ext-4', effectiveCwd: dataDir })
            if (req.resume === undefined) {
              throw new HelmError('subagent_failed', '首次外部执行模拟失败', 502)
            }
            return { action: 'handled', result: 'EXT_RESUMED_DONE' }
          }
          return { action: 'continue' }
        }, { priority: 100 })
      },
    })

  const conv1 = 1
  const conv2 = (await app.kernel.createConversation({ title: 'second-conv' })).id
  const wfDir = join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', String(conv1))
  mkdirSync(wfDir, { recursive: true })

  // 种子 5 条 conv1 下的 failed 任务（createdAt 严格递增 100..500）：
  // 1) 可恢复失败 DSL workflow #1
  // 2) 可恢复失败 DSL workflow #2
  // 3) 可恢复失败原生后台 subagent #3（先创建真实空闲子会话）
  // 4) 可恢复失败外部后台 subagent #4（executionId='pane-ext-4'）
  // 5) 不可恢复失败 DSL workflow #5（workflow_action_uncertain）
  const realChild = await app.kernel.createConversation({
    title: 'subagent-child',
    parentConversationId: conv1,
  })
  app.kernel.markConversationOwnership(realChild.id, 'helm')

  const seedFailedRecord = (convId: number, rec: Record<string, unknown>) => {
    const dir = join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', String(convId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `workflow-${String(rec['id'])}.record.json`), JSON.stringify(rec), 'utf8')
    const store = app.kernel.documentStore
    const current = store.get<{ 'workflow/runs'?: Array<Record<string, unknown>> }>('builtin:workflow:records', {})
    const list = [...(current['workflow/runs'] ?? [])]
    list.push({
      id: rec['id'],
      conversationId: convId,
      status: rec['status'],
      createdAt: rec['createdAt'],
      updatedAt: rec['updatedAt'],
    })
    store.set('builtin:workflow:records', { ...current, 'workflow/runs': list })
  }

  for (const [idx, id, createdAt] of [
    [1, 'wf_fail_dsl_01', 100],
    [2, 'wf_fail_dsl_02', 200],
  ] as const) {
    const jPath = join(wfDir, `workflow-${id}.jsonl`)
    writeFileSync(jPath, '', 'utf8')
    seedFailedRecord(conv1, {
      id,
      name: `dsl-${idx}`,
      conversationId: conv1,
      status: 'failed',
      error: 'upstream rate limit',
      createdAt,
      updatedAt: createdAt,
      kind: 'workflow',
      notifyParentOnSettle: true,
      script: `export const meta = { name: "dsl-${idx}", description: "d" }\nreturn await agent("step-${idx}")`,
      journalPath: jPath,
    })
  }

  seedFailedRecord(conv1, {
    id: 'wf_fail_sub_native_03',
    name: 'subagent:assistant',
    conversationId: conv1,
    status: 'failed',
    error: '[gate_failed] test failed',
    createdAt: 300,
    updatedAt: 300,
    kind: 'subagent',
    notifyParentOnSettle: true,
    journalPath: join(wfDir, 'workflow-wf_fail_sub_native_03.jsonl'),
    subagentMeta: { agentType: 'assistant', execution: { nodeId: 'local', conversationId: realChild.id } },
    subagentSpec: {
      agentId: 'wf_fail_sub_native_03:subagent-0',
      requestId: 'helm:spawn:wf_fail_sub_native_03',
      prompt: '原任务指令',
      agentType: 'assistant',
    },
  })

  seedFailedRecord(conv1, {
    id: 'wf_fail_sub_ext_04',
    name: 'subagent:ext:cli',
    conversationId: conv1,
    status: 'failed',
    error: '[subagent_failed] 首次外部执行模拟失败',
    createdAt: 400,
    updatedAt: 400,
    kind: 'subagent',
    notifyParentOnSettle: true,
    journalPath: join(wfDir, 'workflow-wf_fail_sub_ext_04.jsonl'),
    subagentMeta: { agentType: 'ext:cli', execution: { nodeId: 'local', executionId: 'pane-ext-4', effectiveCwd: dataDir } },
    subagentSpec: {
      agentId: 'wf_fail_sub_ext_04:subagent-0',
      requestId: 'helm:spawn:wf_fail_sub_ext_04',
      prompt: '外部终端任务',
      agentType: 'ext:cli',
    },
  })

  const uncertainJPath = join(wfDir, 'workflow-wf_fail_uncertain_05.jsonl')
  writeFileSync(
    uncertainJPath,
    `${JSON.stringify({ type: 'action_started', scopePath: 'root', scopeCallIndex: 0, index: 0, key: 'act', v: 1, seq: 0 })}\n`,
    'utf8',
  )
  seedFailedRecord(conv1, {
    id: 'wf_fail_uncertain_05',
    name: 'dsl-uncertain',
    conversationId: conv1,
    status: 'failed',
    error: 'workflow_action_uncertain: dangling action',
    createdAt: 500,
    updatedAt: 500,
    kind: 'workflow',
    notifyParentOnSettle: true,
    script: 'export const meta = { name: "u", description: "u" }\nreturn 1',
    journalPath: uncertainJPath,
  })

  // 在 conv2 再放 1 条可恢复失败 workflow 验证 --current 与 --all 边界
  const conv2JPath = join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', String(conv2), 'workflow-wf_fail_conv2_06.jsonl')
  mkdirSync(join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', String(conv2)), { recursive: true })
  writeFileSync(conv2JPath, '', 'utf8')
  seedFailedRecord(conv2, {
    id: 'wf_fail_conv2_06',
    name: 'dsl-conv2',
    conversationId: conv2,
    status: 'failed',
    error: 'network reset',
    createdAt: 600,
    updatedAt: 600,
    kind: 'workflow',
    notifyParentOnSettle: true,
    script: 'export const meta = { name: "dsl-conv2", description: "d" }\nreturn await agent("conv2-step")',
    journalPath: conv2JPath,
  })
  await app.kernel.documentStore.flush()

  hub = await startHub({ kernel: app.kernel as never, port: 0 })
  const setupRes = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 't5-cli-password-123' }),
  })
  const { token } = (await setupRes.json()) as { token: string }
  const cliEnv = {
    ...process.env,
    HELM_HUB_URL: hub.url,
    HELM_DATA_DIR: join(dataDir, 'cli-home'),
    HELM_TOKEN: token,
  }

  // 1) 参数互斥与缺失校验
  const badConflict = await runCli(['workflows', 'resume-failed', '--conversation-id', '1', '--all', '--json'], cliEnv)
  assert.notEqual(badConflict.code, 0, 'conversationId 与 --all 互斥必须报错')
  const badMissing = await runCli(['workflows', 'resume-failed', '--json'], cliEnv)
  assert.notEqual(badMissing.code, 0, '未提供范围参数必须报错')

  // 2) 对 conv1 执行 CLI `--current`：5 个失败任务拉起 4 个、跳过 1 个（且不影响 conv2）
  const firstCli = await runCli(['workflows', 'resume-failed', '--current', '--json'], {
    ...cliEnv,
    HELM_CONVERSATION_ID: String(conv1),
  })
  assert.equal(firstCli.code, 0, `resume-failed --current 失败: ${firstCli.err}`)
  const firstOut = JSON.parse(firstCli.out) as {
    resumed: WorkflowRunSummary[]
    skipped: Array<{ runId: string; reason: string }>
  }
  assert.equal(firstOut.resumed.length, 4, `应拉起 4 个可恢复任务，实得: ${JSON.stringify(firstOut)}`)
  assert.deepEqual(
    firstOut.resumed.map((r) => r.replayedFrom),
    ['wf_fail_dsl_01', 'wf_fail_dsl_02', 'wf_fail_sub_native_03', 'wf_fail_sub_ext_04'],
    '必须按源任务 createdAt 升序逐一恢复',
  )
  assert.equal(firstOut.skipped.length, 1)
  assert.equal(firstOut.skipped[0]!.runId, 'wf_fail_uncertain_05')
  assert.match(firstOut.skipped[0]!.reason, /workflow_action_uncertain/)

  // 验证原记录的 resumedByRunId 透传到 summary，且外部子代理收到了 resume='pane-ext-4'
  const listedConv1 = ((await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: conv1 })) as { runs: WorkflowRunSummary[] }).runs
  for (const srcId of ['wf_fail_dsl_01', 'wf_fail_dsl_02', 'wf_fail_sub_native_03', 'wf_fail_sub_ext_04']) {
    const srcSummary = listedConv1.find((r) => r.id === srcId)
    assert.ok(srcSummary?.resumedByRunId, `源记录 ${srcId} summary 必须透传 resumedByRunId`)
  }
  assert.equal(externalResumes.some((r) => r.resume === 'pane-ext-4'), true, '外部失败单子代理须凭 executionId 发起 resume')

  // 等待 4 个新拉起任务全部完成
  await waitFor(async () => {
    const cur = ((await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: conv1 })) as { runs: WorkflowRunSummary[] }).runs
    return firstOut.resumed.every((r) => cur.find((x) => x.id === r.id)?.status === 'completed')
  }, { timeoutMs: 20_000 })

  // 3) 对 conv1 重复调用：幂等返回 0 个新拉起
  const secondCli = await runCli(['workflows', 'resume-failed', '--conversation-id', String(conv1), '--json'], cliEnv)
  assert.equal(secondCli.code, 0, secondCli.err)
  const secondOut = JSON.parse(secondCli.out) as { resumed: WorkflowRunSummary[]; skipped: Array<{ runId: string; reason: string }> }
  assert.equal(secondOut.resumed.length, 0, '二次重复调用必须幂等返回 0 个新拉起')
  assert.equal(secondOut.skipped.length, 5)

  // 4) 全局 `--all`：自动拉起 conv2 下尚未恢复的 wf_fail_conv2_06
  const globalCli = await runCli(['workflows', 'resume-failed', '--all', '--json'], cliEnv)
  assert.equal(globalCli.code, 0, globalCli.err)
  const globalOut = JSON.parse(globalCli.out) as { resumed: WorkflowRunSummary[] }
  assert.deepEqual(globalOut.resumed.map((r) => r.replayedFrom), ['wf_fail_conv2_06'])
  await waitFor(async () => {
    const cur = ((await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: conv2 })) as { runs: WorkflowRunSummary[] }).runs
    return globalOut.resumed.every((r) => cur.find((x) => x.id === r.id)?.status === 'completed')
  }, { timeoutMs: 20_000 })
  } finally {
    await hub?.close().catch(() => {})
    await app.close().catch(() => {})
  }
})

test('安全红线：crashRecoveries > 3 熔断、secret_grant_expired_on_restart 拒绝降级、配置校验与 HELM_AUTO_RECOVER=0 逃生阀', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-safety-redlines-')
  const abortedIds: number[] = []
  const settledReports: WorkflowRunSummary[] = []
  const docs = new Map<string, unknown>()
  const state: WorkflowStateStore = {
    get: <T>(k: string, init: T) => (docs.has(k) ? structuredClone(docs.get(k) as T) : init),
    set: (k, v) => { docs.set(k, structuredClone(v)) },
  }
  const makeMockHost = (): WorkflowServiceHost => ({
    spawnAgent: async (req) => {
      req.onResolved?.({ nodeId: 'local', conversationId: 66 })
      return await new Promise<never>(() => {})
    },
    invokeAction: async () => ({}),
    listActions: () => [],
    getConversation: (id) => ({ id, title: 't', profileId: 'assistant', tags: [], cwd: dataDir, model: 'f/1', thinkingLevel: '', status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }),
    abortConversationGuarded: async (id) => { abortedIds.push(id) },
    onBackgroundAgentSettled: async (summary) => { settledReports.push(summary) },
    emitEvent: () => {},
  })

  // 1) 连续非优雅崩溃 3 次均可恢复（crashRecoveries = 1, 2, 3），第 4 次触发 [crash_recovery_limit] 熔断
  const svc0 = new WorkflowService({ dataDir, state, host: makeMockHost() })
  const { run: breakerRun } = await svc0.startBackgroundAgent({
    parentConversationId: 1,
    prompt: 'crash-loop-task',
  })
  // 模拟进程强杀（不调 suspend，不落 suspendedCleanly；手工关闭仅清理测试句柄前先保存崩溃态）
  const rawCrashed = JSON.parse(readFileSync(join(dataDir, 'artifacts', '1', `workflow-${breakerRun.id}.record.json`), 'utf8')) as Record<string, unknown>
  await svc0.close()
  // 还原强杀时的 running 记录（无 suspendedCleanly）
  const restoreRunning = (crashRecoveries?: number) => {
    const rec: Record<string, unknown> = {
      ...rawCrashed,
      status: 'running',
      ...(crashRecoveries !== undefined ? { crashRecoveries } : {}),
    }
    delete rec['suspendedCleanly']
    delete rec['error']
    delete rec['notifiedAt']
    writeFileSync(join(dataDir, 'artifacts', '1', `workflow-${breakerRun.id}.record.json`), JSON.stringify(rec), 'utf8')
    state.set('workflow/runs', [{ id: breakerRun.id, conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 }])
  }

  for (const expectedCount of [1, 2, 3]) {
    restoreRunning(expectedCount - 1)
    const s = new WorkflowService({ dataDir, state, host: makeMockHost() })
    await s.init()
    assert.equal(s.getRun(breakerRun.id).status, 'running', `第 ${expectedCount} 次崩溃恢复应继续运行`)
    const disk = JSON.parse(readFileSync(join(dataDir, 'artifacts', '1', `workflow-${breakerRun.id}.record.json`), 'utf8')) as Record<string, unknown>
    assert.equal(disk['crashRecoveries'], expectedCount)
    await s.close()
  }

  abortedIds.length = 0
  settledReports.length = 0
  restoreRunning(3)
  const sTrip = new WorkflowService({ dataDir, state, host: makeMockHost() })
  await sTrip.init()
  const tripped = sTrip.getRun(breakerRun.id)
  assert.equal(tripped.status, 'failed', '第 4 次异常崩溃（crashRecoveries=4 > 3）必须触发熔断')
  assert.match(tripped.error ?? '', /\[crash_recovery_limit\]/)
  assert.ok(abortedIds.includes(66), '熔断必须守卫中止关联子会话')
  assert.equal(settledReports.length, 1, '后台任务熔断必须向父会话补发失败通知')
  assert.equal(sTrip.listAutoResumeCandidates(3).some((c) => c.runId === breakerRun.id), false, '熔断记录不得进入自动续跑候选')
  await sTrip.close()

  // 2) secretNames 授予且崩溃于 onResolved 前：落盘不含 secretNames，重启诚实标 failed(secret_grant_expired_on_restart)
  const secretDir = useTempDir(t, 'helm-secret-redline-')
  const sDocs = new Map<string, unknown>()
  const sState: WorkflowStateStore = {
    get: <T>(k: string, init: T) => (sDocs.has(k) ? structuredClone(sDocs.get(k) as T) : init),
    set: (k, v) => { sDocs.set(k, structuredClone(v)) },
  }
  const enterPreResolve = deferred<void>()
  const preResolveHost: WorkflowServiceHost = {
    ...makeMockHost(),
    spawnAgent: async () => {
      enterPreResolve.resolve()
      return await new Promise<never>(() => {})
    },
  }
  const sSecret1 = new WorkflowService({ dataDir: secretDir, state: sState, host: preResolveHost })
  void sSecret1.startBackgroundAgent({
    parentConversationId: 1,
    prompt: 'use secret',
    agentType: 'herdr:claude',
    secretNames: ['PROD_API_TOKEN'],
  })
  await enterPreResolve.promise
  const idxEntries = sState.get<Array<{ id: string }>>('workflow/runs', [])
  assert.equal(idxEntries.length, 1)
  const secretRunId = idxEntries[0]!.id
  const secretRawText = readFileSync(join(secretDir, 'artifacts', '1', `workflow-${secretRunId}.record.json`), 'utf8')
  assert.equal(secretRawText.includes('PROD_API_TOKEN'), false, '磁盘记录严禁包含 secretNames 名称或明文')
  const secretRec = JSON.parse(secretRawText) as { subagentSpec?: { hadSecretGrant?: boolean } }
  assert.equal(secretRec.subagentSpec?.hadSecretGrant, true)

  const sSecret2 = new WorkflowService({ dataDir: secretDir, state: sState, host: makeMockHost() })
  await sSecret2.init()
  const secretSummary = sSecret2.getRun(secretRunId)
  assert.equal(secretSummary.status, 'failed')
  assert.match(secretSummary.error ?? '', /secret_grant_expired_on_restart/)
  await sSecret2.close()
  await sSecret1.close()

  // 3) HELM_AUTO_RECOVER=0 逃生阀与非法配置校验
  const envDir = useTempDir(t, 'helm-env-valve-')
  const prevEnv = process.env.HELM_AUTO_RECOVER
  process.env.HELM_AUTO_RECOVER = '0'
  try {
    const eSvc = new WorkflowService({ dataDir: envDir, state: sState, host: makeMockHost() })
    assert.equal(eSvc.isAutoRecoverOnRestart(), false, 'HELM_AUTO_RECOVER=0 必须立即关闭自动恢复')
    await eSvc.close()
  } finally {
    if (prevEnv === undefined) delete process.env.HELM_AUTO_RECOVER
    else process.env.HELM_AUTO_RECOVER = prevEnv
  }

  const cfgDir = useTempDir(t, 'helm-cfg-invalid-')
  const fauxCfg = makeFauxProvider()
  const kCfg = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir: cfgDir,
    cwd: cfgDir,
    model: 'faux/faux-1',
    providers: [fauxCfg.provider],
    autoResume: false,
  })
  t.after(async () => {
    await kCfg.close().catch(() => {})
  })
  await kCfg.plugins.register(createWorkflowPlugin())
  await assert.rejects(
    () => kCfg.plugins.setConfig('builtin:workflow', { autoRecoverOnRestart: 'not-a-boolean' as unknown as boolean }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
  )
})
