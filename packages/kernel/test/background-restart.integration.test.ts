/**
 * 后台子代理进程重启恢复真实集成测试（tsx --test；不修改实现，只验收行为）。
 *
 * 已修复的 P1 顺序问题：重启后若先 resume 全局调度器，遗留 running 的
 * kind:'subagent' 子会话会凭旧 checkpoint 继续跑模型回合；而只把 run 标
 * failed (interrupted) 并不会停掉 SDK 里的旧任务。修复契约：
 * 1. app 在注册任何插件之前调用 workflows.prepareRecovery()；
 * 2. prepareRecovery 经 host.prepareInterruptedConversations(ids) 用
 *    harness.inspect（只读）+ harness.abortTask（只落 abort 标记，不 resume）
 *    持久标记遗留子任务；调度器仍 paused；
 * 3. 所有插件注册后 workflows.init() 先 await host.abortConversation 让已标记
 *    子任务真正终止，再把 run 标 failed (interrupted)、向父会话投递一次报告，
 *    最后才 kernel.start() 恢复调度。
 *
 * 诚实性纪律：遗留任务由真实 tsx 子进程打开真 KernelRuntime + 真 SQLite
 * state.sqlite，用慢速 faux 流式中途 process.kill(SIGKILL) 制造（重启前确有
 * 未完成的真实模型生成任务，checkpoint 持久在 request 阶段）；恢复侧全部走
 * 真实 SDK 路径，绝不 mock 恢复，不用 callCount 假证明。
 *
 * 环境约束：子进程与主进程 cwd/HELM_DATA_DIR 全部在 mkdtemp 临时目录；
 * 全程无 Hub、无端口监听；finally 杀干净子进程并删除临时目录。
 * 每用例 timeout: 60_000；运行命令带总超时（timeout 50s tsx --test 本文件）。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID, type HelmEventFrame, type PluginDefinition } from '@helm/protocol'

import { KernelRuntime } from '../src/runtime/index.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/service.js'

const require = createRequire(import.meta.url)
/** 主仓 packages/kernel（测试随仓内 test/ 交付，src 依赖用相对导入；tsx loader 直跑源码）。 */
const KERNEL_DIR = new URL('../', import.meta.url).pathname
const PI_AI_DIR = join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai')
const KERNEL_SRC = pathToFileURL(join(KERNEL_DIR, 'src/runtime/index.ts')).href

const ROOT = ROOT_CONVERSATION_ID

// ---------------------------------------------------------------------------
// 用例 1（确定性单元）：prepareRecovery 先于 abortConversation / 通知
// ---------------------------------------------------------------------------

test('恢复顺序: prepareRecovery 先收集子会话落标记，init 才 abortConversation 并标 failed/interrupted，通知恰一次', { timeout: 60_000 }, async () => {
  const calls: string[] = []
  const stateMap = new Map<string, unknown>()
  const state: WorkflowStateStore = {
    get: <T>(key: string, initial: T): T => (stateMap.get(key) as T | undefined) ?? initial,
    set: <T>(key: string, value: T): void => {
      stateMap.set(key, JSON.parse(JSON.stringify(value)))
    },
    flush: async () => {},
  }
  const CHILD = 42
  const now = Date.now()
  const runKey = 'workflow/run/wf_seed_order'
  state.set('workflow/runs', [{ id: 'wf_seed_order', conversationId: ROOT, createdAt: now }])
  state.set(runKey, {
    id: 'wf_seed_order',
    name: 'subagent:worker',
    conversationId: ROOT,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    kind: 'subagent',
    notifyParentOnSettle: true,
    journalPath: '/tmp/nonexistent.jsonl',
    nodes: [{ id: 'subagent-0', kind: 'agent', label: 'subagent:worker', status: 'running', startedAt: now, conversationId: CHILD }],
    subagentMeta: { agentType: 'worker', execution: { nodeId: 'local', conversationId: CHILD, effectiveCwd: '/tmp' } },
  })
  const settled: string[] = []
  const host: WorkflowServiceHost = {
    spawnAgent: async () => {
      throw new Error('本用例不 spawn')
    },
    prepareInterruptedConversations: async (ids) => {
      calls.push(`prepare:${ids.join(',')}`)
    },
    invokeAction: async () => {
      throw new Error('本用例不调用 action')
    },
    listActions: () => [],
    getConversation: () => {
      throw new Error('本用例不读会话')
    },
    abortConversation: async (id) => {
      calls.push(`abort:${id}`)
    },
    emitEvent: () => {},
    onBackgroundAgentSettled: async (summary) => {
      settled.push(`${summary.id}:${summary.status}`)
    },
  }
  const svc = new WorkflowService({ dataDir: '/tmp/unused', state, host })

  await svc.prepareRecovery()
  assert.deepEqual(calls, [`prepare:${CHILD}`], 'prepareRecovery 必须先且只收集遗留子会话并调用 prepareInterruptedConversations')

  calls.length = 0
  await svc.init()
  const firstAbort = calls.findIndex((c) => c.startsWith('abort:'))
  assert.ok(firstAbort === 0, `init 首个宿主调用必须是 abortConversation（实际：${calls.join(' | ')}）`)
  assert.equal(calls.filter((c) => c.startsWith('prepare:')).length, 0, 'prepareRecovery 已执行过，init 不得重复调用 prepare')

  const record = stateMap.get(runKey) as { status: string; error?: string; notifiedAt?: number }
  assert.equal(record.status, 'failed', '遗留 running run 必须显式标 failed（不伪装 completed）')
  assert.match(record.error ?? '', /interrupted/, 'failed 原因必须是进程重启中断')
  assert.ok(record.notifiedAt !== undefined, '父会话通知必须落 notifiedAt（防重复投递）')
  assert.deepEqual(settled, ['wf_seed_order:failed'], 'onBackgroundAgentSettled 恰好补发一次 failed')
})

// ---------------------------------------------------------------------------
// 真实遗留制造：子进程真 KernelRuntime + 慢速 faux 流式中途 SIGKILL
// ---------------------------------------------------------------------------

/** 子进程 seeder 源码（真实 SDK 持久任务；写临时 .mts 由 tsx 直跑）。 */
function seederSource(kernelSrc: string, piAiModelsSrc: string, piAiFauxSrc: string): string {
  return `import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels } from '${piAiModelsSrc}'
import { fauxAssistantMessage, fauxProvider } from '${piAiFauxSrc}'
import { KernelRuntime } from '${kernelSrc}'

const dataDir = process.env.HELM_SEED_DIR!
const models = createModels()
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage('这是一段被慢速流式输出的长文本用于确保 SIGKILL 时模型回合仍在流式中')])
const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
// 真实原生 spawn：创建子会话并提交输入（submission 内部 resume 调度器，回合真实运行）
let childId = 0
void kernel.spawnAgent({
  parentConversationId: 1,
  prompt: '执行一个会被进程重启打断的长任务',
  onResolved: (info) => { if (info.conversationId) childId = info.conversationId },
  signal: AbortSignal.timeout(120_000),
}).catch((e) => { process.stderr.write('seed spawn error: ' + e + '\\n') })
// 等子会话真正进入 working（真实回合在跑）
for (let i = 0; i < 200; i++) {
  await delay(100)
  if (childId && kernel.listConversations().some((c) => c.id === childId && c.status === 'working')) break
}
if (!childId) { process.stderr.write('seed: no child\\n'); process.exit(3) }
await delay(1200) // 让部分 token 落盘（progress persistWithinMs 默认 1000ms）
// 植入 startBackgroundAgent 的持久 run 记录（与 WorkflowService 契约同构）
const now = Date.now()
const doc = kernel.documentStore
doc.set('workflow/runs', [{ id: 'wf_seed_real', conversationId: 1, createdAt: now }])
doc.set('workflow/run/wf_seed_real', {
  id: 'wf_seed_real', name: 'subagent', conversationId: 1, status: 'running',
  createdAt: now, updatedAt: now, kind: 'subagent', notifyParentOnSettle: true,
  journalPath: join(dataDir, 'wf-seed-real.jsonl'),
  nodes: [{ id: 'subagent-0', kind: 'agent', label: 'subagent', status: 'running', startedAt: now, conversationId: childId }],
  subagentMeta: { execution: { nodeId: 'local', conversationId: childId } },
})
await doc.flush()
process.stdout.write('CHILD=' + childId + '\\n')
await delay(300) // flush 落盘窗口
process.kill(process.pid, 'SIGKILL')
`
}

/** 只读探针 Harness：验证 paused + abort 标记（不解锁调度器）。 */
async function readOnlyInspect(dataDir: string): Promise<{ scheduling: string; tasks: Array<{ kind: string; conversationId: number; abortRequested: boolean; status: string }> }> {
  const { openHelmDatabase } = await import('../src/runtime/sqlite.js')
  const db = await openHelmDatabase(dataDir)
  try {
    const probe = await Harness.open(db.storage, { models: createModels(), registry: createRegistry(), readOnly: true }, BACKGROUND_CONTEXT)
    try {
      const inspection = await probe.inspect(BACKGROUND_CONTEXT)
      return {
        scheduling: inspection.scheduling,
        tasks: inspection.tasks.map((t) => ({
          kind: t.record.kind,
          conversationId: Number(t.record.conversationId),
          abortRequested: t.record.abortRequested,
          status: String(t.record.state.status),
        })),
      }
    } finally {
      await probe.close(BACKGROUND_CONTEXT).catch(() => {})
    }
  } finally {
    await db.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 用例 2（真实端到端）：SIGKILL 遗留 -> prepareRecovery 只落标记 -> init 终止
// -> 父收 failed/interrupted -> resume 原子会话执行新输入
// ---------------------------------------------------------------------------

test('真实恢复: SIGKILL 遗留子会话仍 paused 时 prepareRecovery 只落 abort 标记零模型调用；init 终止后父收 interrupted 报告；resume 原子会话执行新输入', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-bg-restart-'))
  const seedDir = mkdtempSync(join(tmpdir(), 'helm-bg-seed-'))
  const seederPath = join(seedDir, 'seed.mts')
  writeFileSync(seederPath, seederSource(KERNEL_SRC, pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href, pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href), 'utf8')
  const tsxCli = require.resolve('tsx/cli')
  let child: ReturnType<typeof spawn> | undefined
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    rmSync(seedDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  try {
    // ---- 1) 子进程制造真实遗留（慢速流式中途 SIGKILL；cwd/env 全临时，无端口）----
    child = spawn(process.execPath, [tsxCli, seederPath], {
      cwd: KERNEL_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: seedDir,
        HELM_SEED_DIR: dataDir,
        HELM_DATA_DIR: dataDir,
        HELM_WATCHDOG_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childId = 0
    const exits: Promise<void>[] = []
    exits.push(
      new Promise<void>((resolve, reject) => {
        let out = ''
        let err = ''
        child!.stdout!.on('data', (d: Buffer) => {
          out += d.toString()
          const m = /CHILD=(\d+)/.exec(out)
          if (m) childId = Number(m[1])
        })
        child!.stderr!.on('data', (d: Buffer) => {
          err += d.toString()
        })
        child!.on('exit', (code, signal) => {
          // 自杀式 process.kill(SIGKILL)：Node 子进程回调里报 code=137/signal=null，内核语义等价 SIGKILL。
          if (signal !== 'SIGKILL' && code !== 137) reject(new Error(`seeder 必须死于 SIGKILL（实际 code=${code} signal=${signal}）：${out}${err}`.slice(0, 2000)))
          else resolve()
        })
        child!.on('error', reject)
      }),
    )
    await Promise.race([Promise.all(exits), delay(30_000, undefined, { ref: false }).then(() => { throw new Error('seeder 30s 未退出') })])
    assert.ok(childId > 1, `必须拿到子会话 ID（收到 ${childId}）`)

    // ---- 2) 重启进程：KernelRuntime(autoResume:false) + WorkflowService（app 同款接线）----
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false, watchdogIntervalMs: 0 })
    t.after(async () => {
      await kernel.close().catch(() => {})
    })
    await kernel.plugins.register({
      id: 'test:restart-probe',
      name: '重启恢复探针',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled(() => {
          // turn_settled 挂接验证插件注册路径可用；报告断言用事件订阅（下方）。
        })
      },
    } satisfies PluginDefinition)
    const rootInputs: Array<{ conversationId: number; origin?: string; kind?: string }> = []
    kernel.events.subscribe((frame: HelmEventFrame) => {
      const e = frame.event as { type?: string; conversationId?: number; entry?: { kind?: string; data?: { origin?: string; meta?: { kind?: string } } } }
      if (e.type === 'conversation.entry' && e.conversationId === ROOT && e.entry?.kind === 'helm.input') {
        rootInputs.push({ conversationId: e.conversationId, origin: e.entry.data?.origin, kind: e.entry.data?.meta?.kind })
      }
    })
    const workflows = new WorkflowService({
      dataDir: kernel.dataDir,
      state: kernel.documentStore,
      redact: (text) => kernel.stash.redact(text),
      host: {
        spawnAgent: (request) => kernel.spawnAgent(request),
        prepareInterruptedConversations: (ids) => kernel.prepareInterruptedConversations(ids),
        runGate: (command, context) => kernel.runGate(command, context),
        invokeAction: (pluginId, actionId, input, context) => kernel.plugins.invokeAction(pluginId, actionId, input, context),
        listActions: () => kernel.plugins.listActions(),
        getConversation: (id) => kernel.getConversation(id),
        abortConversation: (id) => kernel.abortConversation(id),
        emitEvent: (type, payload) => kernel.events.publish(type, payload),
        onRunSettled: () => {},
        onBackgroundAgentSettled: (summary) => kernel.reportBackgroundAgent(summary, { parentConversationId: ROOT }),
      },
    })
    t.after(async () => {
      await workflows.close().catch(() => {})
    })
    assert.equal(kernel.getConversation(childId).parentConversationId, ROOT, '遗留子会话镜像与父关联必须在重启后恢复')

    // ---- 3) prepareRecovery：只落 abort 标记；调度器仍 paused；零模型调用 ----
    await workflows.prepareRecovery()
    assert.equal(faux.state.callCount, 0, 'prepareRecovery 绝不发起任何模型调用')
    const probe1 = await readOnlyInspect(dataDir)
    assert.equal(probe1.scheduling, 'paused', 'prepareRecovery 后调度器必须仍 paused（未 resume）')
    const gen = probe1.tasks.filter((task) => task.conversationId === childId && task.kind === 'pi.generation')
    assert.equal(gen.length, 1, `应存在恰好 1 个遗留 pi.generation 任务（实际 ${probe1.tasks.map((x) => x.kind).join(',')}）`)
    assert.equal(gen[0]!.abortRequested, true, '遗留任务必须已落持久 abort 标记')
    assert.notEqual(gen[0]!.status, 'terminal', '标记阶段任务不得已终态（尚未终止）')

    // ---- 4) workflows.init()：真正终止子任务，标 failed(interrupted)，父收报告 ----
    // 父会话将消费 agent 来源报告并产生一次真实模型回合
    faux.setResponses([fauxAssistantMessage('收到后台中断报告')])
    await workflows.init()
    await kernel.waitForIdle(ROOT).catch(() => {})
    assert.equal(faux.state.callCount, 1, `恢复期恰好一次模型调用（父会话报告回合；实际 ${faux.state.callCount}；旧子会话绝不能凭旧 checkpoint 复燃）`)
    const run = workflows.getRun('wf_seed_real')
    assert.equal(run.status, 'failed', `遗留 run 必须标 failed（实际 ${run.status}）`)
    assert.match(run.error ?? '', /interrupted/, 'failed 原因必须是进程重启中断')
    assert.equal(kernel.getConversation(childId).status, 'idle', '旧子会话终态 idle（不再 working）')
    const reportInputs = rootInputs.filter((i) => i.origin === 'agent' && i.kind === 'subagent_report')
    assert.equal(reportInputs.length, 1, `父会话恰好收到一次 agent 来源中断报告（实际 ${JSON.stringify(rootInputs)}）`)

    // ---- 5) kernel.start() 恢复调度：旧子会话不再生成新回合 ----
    await kernel.start()
    await delay(600)
    assert.equal(faux.state.callCount, 1, 'kernel.start 后旧子会话仍不得再发起模型调用')

    // 调度器已 resume 后再次 prepare 必须显式拒绝（不安全恢复顺序）
    await assert.rejects(() => kernel.prepareInterruptedConversations([childId]), (err: { code?: string }) => err.code === 'recovery_already_started')

    // ---- 6) 显式 resume 原子会话：执行新输入（新回合真实模型调用）----
    faux.setResponses([fauxAssistantMessage('续接后的新回答')])
    let resumedConv = 0
    const answer = await kernel.spawnAgent({
      parentConversationId: ROOT,
      resume: String(childId),
      prompt: '重启后的新输入',
      onResolved: (info) => {
        if (info.conversationId) resumedConv = info.conversationId
      },
    })
    assert.equal(resumedConv, childId, 'resume 必须续接原子会话，绝不新建')
    assert.equal(answer, '续接后的新回答', 'resume 回合返回真实模型输出')
    assert.equal(faux.state.callCount, 2, `resume 恰好新增一次子会话模型调用（实际 ${faux.state.callCount}）`)
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }
})
