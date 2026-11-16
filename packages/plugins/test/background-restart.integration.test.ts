/**
 * 后台子代理进程重启恢复真实集成测试（tsx --test；不修改实现，只验收行为）。
 *
 * 已修复的 P1 顺序问题：重启后若先 resume 全局调度器，遗留 running 的
 * kind:'subagent' 子会话会凭旧 checkpoint 继续跑模型回合；而只把 run 标
 * failed (interrupted) 并不会停掉 SDK 里的旧任务。修复契约：
 * 1. app 在注册任何插件之前调用 workflows.prepareRecovery()；
 * 2. prepareRecovery 经 host.abortConversationGuarded(id)（调度器 paused 相位：
 *    harness.inspect 只读 + harness.abortTask 只落 abort 标记，不 resume、
 *    不等结算）逐个持久标记遗留子任务，且 human 归属被内核守卫拒绝；
 * 3. 所有插件注册后 workflows.init() 再次 await host.abortConversationGuarded
 *    （调度器已恢复，等待真实终态）让已标记子任务真正终止，再把 run 标
 *    failed (interrupted)、向父会话投递一次报告，最后才 kernel.start()。
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
import { createPluginBuildProvider } from '@helm/plugin-build'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { type HelmEventFrame, type PluginDefinition } from '@helm/protocol'

import { KernelRuntime } from '../../kernel/src/runtime/index.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/engine/service.js'

const require = createRequire(import.meta.url)
/** 主仓 packages/kernel（测试跨目录显式导入 kernel 源码；tsx loader 直跑源码）。 */
const KERNEL_DIR = new URL('../../kernel/', import.meta.url).pathname
const PI_AI_DIR = join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai')
const KERNEL_SRC = pathToFileURL(join(KERNEL_DIR, 'src/runtime/index.ts')).href

/** 初始会话 id（SDK 保留 #1 承载；普通会话语义，无产品级特权）。 */
const ROOT_CONVERSATION_ID = 1 as const
const ROOT = ROOT_CONVERSATION_ID

// ---------------------------------------------------------------------------
// 用例 1（确定性单元）：prepareRecovery 先于 abortConversation / 通知
// ---------------------------------------------------------------------------

test('恢复顺序: prepareRecovery 先收集子会话落标记，init 才 abortConversation 并标 failed/interrupted，通知恰一次', { timeout: 60_000 }, async (t) => {
  const calls: string[] = []
  const stateMap = new Map<string, unknown>()
  const state: WorkflowStateStore = {
    get: <T>(key: string, initial: T): T => (stateMap.get(key) as T | undefined) ?? initial,
    set: <T>(key: string, value: T): void => {
      stateMap.set(key, JSON.parse(JSON.stringify(value)))
    },
    flush: async () => {},
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-bg-order-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })
  const CHILD = 42
  const now = Date.now()
  // 新契约：records doc 只存 workflow/runs 轻量索引；完整 RunRecord 落记录
  // 文件 dataDir/artifacts/<convId>/workflow-<runId>.record.json（纯
  // WorkflowService fake 的 dataDir 即传入 dataDir，无插件目录前缀）。
  state.set('workflow/runs', [{ id: 'wf_seed_order', conversationId: ROOT, status: 'running', createdAt: now, updatedAt: now }])
  const recordDir = join(dataDir, 'artifacts', String(ROOT))
  const recordPath = join(recordDir, 'workflow-wf_seed_order.record.json')
  mkdirSync(recordDir, { recursive: true })
  writeFileSync(recordPath, JSON.stringify({
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
  }), 'utf8')
  const settled: string[] = []
  const host: WorkflowServiceHost = {
    spawnAgent: async () => {
      throw new Error('本用例不 spawn')
    },
    invokeAction: async () => {
      throw new Error('本用例不调用 action')
    },
    listActions: () => [],
    getConversation: () => {
      throw new Error('本用例不读会话')
    },
    abortConversationGuarded: async (id) => {
      calls.push(`abort:${id}`)
    },
    emitEvent: () => {},
    onBackgroundAgentSettled: async (summary) => {
      settled.push(`${summary.id}:${summary.status}`)
    },
  }
  const svc = new WorkflowService({ dataDir, state, host })

  await svc.prepareRecovery()
  assert.deepEqual(calls, [`abort:${CHILD}`], 'prepareRecovery 必须先逐个守卫中止（paused 相位落持久 abort 标记）遗留子会话')

  calls.length = 0
  await svc.init()
  const firstAbort = calls.findIndex((c) => c.startsWith('abort:'))
  assert.ok(firstAbort === 0, `init 首个宿主调用必须是 abortConversation（实际：${calls.join(' | ')}）`)

  const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as { status: string; error?: string; notifiedAt?: number }
  assert.equal(record.status, 'failed', '遗留 running run 必须显式标 failed（不伪装 completed）')
  assert.match(record.error ?? '', /interrupted/, 'failed 原因必须是进程重启中断')
  assert.ok(record.notifiedAt !== undefined, '父会话通知必须落 notifiedAt（防重复投递）')
  // records doc 只维护轻量索引：唯一键 workflow/runs，状态同步终态。
  assert.deepEqual([...stateMap.keys()], ['workflow/runs'], 'records doc 只存轻量索引（无 per-run 完整键）')
  const indexEntry = (stateMap.get('workflow/runs') as Array<{ id: string; status: string }>).find((e) => e.id === 'wf_seed_order')
  assert.equal(indexEntry?.status, 'failed', '索引状态必须同步 failed 终态')
  assert.deepEqual(settled, ['wf_seed_order:failed'], 'onBackgroundAgentSettled 恰好补发一次 failed')
})

// ---------------------------------------------------------------------------
// 真实遗留制造：子进程真 KernelRuntime + 慢速 faux 流式中途 SIGKILL
// ---------------------------------------------------------------------------

/** 子进程 seeder 源码（真实 SDK 持久任务；写临时 .mts 由 tsx 直跑）。 */
function seederSource(kernelSrc: string, piAiModelsSrc: string, piAiFauxSrc: string, pluginBuildSrc: string): string {
  return `import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels } from '${piAiModelsSrc}'
import { fauxAssistantMessage, fauxProvider } from '${piAiFauxSrc}'
import { KernelRuntime } from '${kernelSrc}'
import { createPluginBuildProvider } from '${pluginBuildSrc}'

const dataDir = process.env.HELM_SEED_DIR!
const models = createModels()
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage('这是一段被慢速流式输出的长文本用于确保 SIGKILL 时模型回合仍在流式中')])
const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
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
// 植入 startBackgroundAgent 的持久 run 记录（新契约：插件私有 records 文档
// 只存 workflow/runs 轻量索引；完整 RunRecord 落插件数据目录记录文件
// <dataDir>/plugins/builtin%3Aworkflow/artifacts/<convId>/workflow-<runId>.record.json）
const now = Date.now()
const recordDir = join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1')
mkdirSync(recordDir, { recursive: true })
writeFileSync(join(recordDir, 'workflow-wf_seed_real.record.json'), JSON.stringify({
  id: 'wf_seed_real', name: 'subagent', conversationId: 1, status: 'running',
  createdAt: now, updatedAt: now, kind: 'subagent', notifyParentOnSettle: true,
  journalPath: join(dataDir, 'wf-seed-real.jsonl'),
  nodes: [{ id: 'subagent-0', kind: 'agent', label: 'subagent', status: 'running', startedAt: now, conversationId: childId }],
  subagentMeta: { execution: { nodeId: 'local', conversationId: childId } },
}))
const doc = kernel.documentStore
doc.set('builtin:workflow:records', {
  'workflow/runs': [{ id: 'wf_seed_real', conversationId: 1, status: 'running', createdAt: now, updatedAt: now }],
})
await doc.flush()
process.stdout.write('CHILD=' + childId + '\\n')
await delay(300) // flush 落盘窗口
process.kill(process.pid, 'SIGKILL')
`
}

/** 只读探针 Harness：验证 paused + abort 标记（不解锁调度器）。 */
async function readOnlyInspect(dataDir: string): Promise<{ scheduling: string; tasks: Array<{ kind: string; conversationId: number; abortRequested: boolean; status: string }> }> {
  const { openHelmDatabase } = await import('../../kernel/src/runtime/sqlite.js')
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
  writeFileSync(seederPath, seederSource(KERNEL_SRC, pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href, pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href, import.meta.resolve('@helm/plugin-build')), 'utf8')
  const tsxCli = require.resolve('tsx/cli')
  let child: ReturnType<typeof spawn> | undefined
  // t.after 按注册顺序执行：先杀子进程/清理 seeder 目录；dataDir 必须等内核
  // close（stop 链最终投影要读记录文件）之后再删，注册在后半部分。
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    rmSync(seedDir, { recursive: true, force: true })
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

    // ---- 2) 重启进程：KernelRuntime(autoResume:false) + builtin:workflow 插件（app 同款顺序）----
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
    t.after(async () => {
      await kernel.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    })
    const rootInputs: Array<{ conversationId: number; origin?: string; kind?: string }> = []
    kernel.events.subscribe((frame: HelmEventFrame) => {
      const e = frame.event as { type?: string; conversationId?: number; entry?: { kind?: string; data?: { origin?: string; meta?: { kind?: string } } } }
      if (e.type === 'conversation.entry' && e.conversationId === ROOT && e.entry?.kind === 'helm.input') {
        rootInputs.push({ conversationId: e.conversationId, origin: e.entry.data?.origin, kind: e.entry.data?.meta?.kind })
      }
    })
    assert.equal(kernel.getConversation(childId).parentConversationId, ROOT, '遗留子会话镜像与父关联必须在重启后恢复')

    // ---- 3+4) 注册 builtin:workflow 插件与探针插件（deferServices 启动屏障：
    // 注册期不启动任何服务；kernel.start() 先全局 prepare 再逐插件 start）。
    // 探针插件的 prepare 在 workflow prepareRecovery 完成后被调起并阻塞在
    // 人工闸门上：此刻断言调度器仍 paused、遗留子任务已落 abortRequested
    // 持久标记（prepare 阶段中间态，不是 init 后的最终状态）。
    faux.setResponses([fauxAssistantMessage('收到后台中断报告')])
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve })
    const probeOrder: string[] = []
    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.plugins.register({
      id: 'test:restart-probe',
      name: '重启恢复探针',
      definePlugin(ctx) {
        ctx.service({
          id: 'barrier-probe',
          async prepare() {
            // 此刻全局屏障阶段 1 进行中：workflow 的 prepareRecovery 已完成
            //（注册顺序在前），其后的 start 尚未发生（阶段 2 未开始）。
            probeOrder.push('prepare')
            await prepareGate
          },
          async start() {
            probeOrder.push('start')
          },
          async stop() {},
        })
        ctx.hook.onTurnSettled(() => {
          // turn_settled 挂接验证插件注册路径可用；报告断言用事件订阅（下方）。
        })
      },
    } satisfies PluginDefinition)
    const startPromise = kernel.start()
    // 屏障中间：workflow prepareRecovery 已落 abort 标记，但没有任何服务 start，
    // 调度器仍 paused、零模型调用。用只读探针 Harness 验证持久中间态。
    await delay(200)
    const midPrepare = await readOnlyInspect(dataDir)
    assert.equal(midPrepare.scheduling, 'paused', `prepare 屏障期间调度器必须仍 paused（实际 ${midPrepare.scheduling}）`)
    const interruptedTask = midPrepare.tasks.find(
      (task) => task.conversationId === childId && task.kind.includes('generation'),
    )
    assert.ok(
      interruptedTask !== undefined && interruptedTask.abortRequested === true,
      `prepare 屏障期间遗留子任务必须已带持久 abortRequested 标记（实际 tasks=${JSON.stringify(midPrepare.tasks)}）`,
    )
    assert.equal(faux.state.callCount, 0, 'prepare 屏障期间零模型调用')
    releasePrepare()
    await startPromise
    await kernel.waitForIdle(ROOT).catch(() => {})
    assert.equal(faux.state.callCount, 1, `恢复期恰好一次模型调用（父会话报告回合；实际 ${faux.state.callCount}；旧子会话绝不能凭旧 checkpoint 复燃）`)
    const runs = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: Array<{ id: string; status: string; error?: string }> }
    const run = runs.runs.find((r) => r.id === 'wf_seed_real')
    assert.ok(run, `遗留 run 应存在（实际 ${JSON.stringify(runs.runs.map((r) => r.id))}）`)
    assert.equal(run.status, 'failed', `遗留 run 必须标 failed（实际 ${run.status}）`)
    assert.match(run.error ?? '', /interrupted/, 'failed 原因必须是进程重启中断')
    assert.equal(kernel.getConversation(childId).status, 'idle', '旧子会话终态 idle（不再 working）')
    const reportInputs = rootInputs.filter((i) => i.origin === 'agent' && i.kind === 'subagent_report')
    assert.equal(reportInputs.length, 1, `父会话恰好收到一次 agent 来源中断报告（实际 ${JSON.stringify(rootInputs)}）`)
    assert.deepEqual(probeOrder, ['prepare', 'start'], `屏障顺序必须 prepare 全部完成后才 start（实际 ${JSON.stringify(probeOrder)}）`)

    // ---- 5) kernel.start() 恢复调度：旧子会话不再生成新回合 ----
    await kernel.start()
    await delay(600)
    assert.equal(faux.state.callCount, 1, 'kernel.start 后旧子会话仍不得再发起模型调用')

    // 相位自适应（专用恢复方法已删除）：调度器已 resume 后，同一
    // abortConversationGuarded 走普通中止语义（SDK abort + 等待空闲），
    // 对 idle 子会话是安全 no-op，绝不复燃旧回合，也不再需要专用 409。
    await kernel.abortConversationGuarded(childId, {})

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

// ---------------------------------------------------------------------------
// 用例 3（内核机制回归）：paused 相位 guarded 中止逐会话持久标记 + human
// 红线覆盖恢复窗口（专用 prepareInterruptedConversations 已删除，语义并入
// abortConversationGuarded 相位自适应）
// ---------------------------------------------------------------------------

test('相位自适应 guarded 中止: paused 时逐会话落持久标记且不 resume；human 归属在恢复窗口同样拒绝；start 后同方法回落普通中止语义', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-bg-restart3-'))
  const seedDir = mkdtempSync(join(tmpdir(), 'helm-bg-seed3-'))
  const seederPath = join(seedDir, 'seed.mts')
  writeFileSync(seederPath, seederSource(KERNEL_SRC, pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href, pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href, import.meta.resolve('@helm/plugin-build')), 'utf8')
  const tsxCli = require.resolve('tsx/cli')
  let child: ReturnType<typeof spawn> | undefined
  // 同用例 2：先杀子进程/清理 seeder 目录，dataDir 在内核 close 后再删。
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    rmSync(seedDir, { recursive: true, force: true })
  })
  try {
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
    await new Promise<void>((resolve, reject) => {
      let out = ''
      child!.stdout!.on('data', (chunk: Buffer) => {
        out += String(chunk)
        const m = /CHILD=(\d+)/.exec(out)
        if (m && childId === 0) childId = Number(m[1])
      })
      child!.stderr!.on('data', () => {})
      child!.on('exit', (code, signal) => {
        if (signal !== 'SIGKILL' && code !== 137) reject(new Error(`seeder 必须死于 SIGKILL（实际 code=${code} signal=${signal}）`))
        else resolve()
      })
      child!.on('error', reject)
    })
    assert.ok(childId > 1, `必须拿到子会话 ID（收到 ${childId}）`)

    // 重启（不注册任何插件、autoResume:false：调度器保持 paused，恢复屏障窗口）。
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
    t.after(async () => {
      await kernel.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    })

    // human 红线覆盖恢复窗口：paused 相位对 human 归属会话拒绝持久标记。
    kernel.markConversationOwnership(childId, 'human')
    await assert.rejects(
      () => kernel.abortConversationGuarded(childId, {}),
      (err: { code?: string }) => err.code === 'ownership_conflict',
    )
    let snap = await readOnlyInspect(dataDir)
    let task = snap.tasks.find((tk) => tk.conversationId === childId)
    assert.ok(task !== undefined && task.abortRequested === false, 'human 拒绝路径绝不落 abort 标记')
    assert.equal(snap.scheduling, 'paused', 'human 拒绝路径不得唤醒调度器')

    // helm 归属：paused 相位只落持久 abort 标记（不 resume、不等结算、零模型调用）。
    kernel.markConversationOwnership(childId, 'helm')
    await kernel.abortConversationGuarded(childId, {})
    snap = await readOnlyInspect(dataDir)
    task = snap.tasks.find((tk) => tk.conversationId === childId)
    assert.ok(task !== undefined && task.abortRequested === true, 'paused 相位必须落持久 abortRequested 标记')
    assert.equal(snap.scheduling, 'paused', 'paused 相位标记绝不 resume 调度器')
    assert.equal(faux.state.callCount, 0, 'paused 相位零模型调用')

    // start 后（调度器 running）：同一方法回落普通中止语义（idle 子会话为
    // 安全 no-op，绝不复燃旧回合）。
    await kernel.start()
    await kernel.abortConversationGuarded(childId, {})
    await kernel.waitForIdle(childId).catch(() => {})
    assert.equal(faux.state.callCount, 0, 'running 相位中止已标记的遗留任务仍零新增模型调用')
    assert.equal(kernel.getConversation(childId).status, 'idle', '遗留子会话终态 idle')
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }
})

// ---------------------------------------------------------------------------
// 用例 4：同步/CLI 工作流（notifyParentOnSettle 未设）在 SIGKILL 与 close() 后全覆盖收敛
// ---------------------------------------------------------------------------

test('同步工作流全覆盖收敛：SIGKILL 与 graceful close() 均回收遗留原生子会话、清 pendingChildCleanup 且绝不通知父会话', { timeout: 60_000 }, async (t) => {
  // ---- A) SIGKILL 中断同步工作流 ----
  const sigkillDir = mkdtempSync(join(tmpdir(), 'helm-sync-sigkill-'))
  const seedDir = mkdtempSync(join(tmpdir(), 'helm-sync-seed-'))
  const seederPath = join(seedDir, 'sync-seed.mts')
  const workflowSrc = pathToFileURL(new URL('../src/workflow.ts', import.meta.url).pathname).href
  writeFileSync(
    seederPath,
    `import { setTimeout as delay } from 'node:timers/promises'
import { createModels } from ${JSON.stringify(pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href)}
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href)}
import { KernelRuntime } from ${JSON.stringify(KERNEL_SRC)}
import { createPluginBuildProvider } from ${JSON.stringify(import.meta.resolve('@helm/plugin-build'))}
import { createWorkflowPlugin } from ${JSON.stringify(workflowSrc)}

const dataDir = process.env.HELM_SEED_DIR!
const models = createModels()
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage('这是一段慢速同步工作流输出确保在进程被强杀前子会话仍处于工作状态')])
const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
await kernel.plugins.register(createWorkflowPlugin())
await kernel.start()
const { run } = await kernel.plugins.invokeAction('builtin:workflow', 'run', {
  conversationId: 1,
  script: 'export const meta = { name: "sync-sigkill", description: "test" }\\nreturn await agent("slow-sync-step")',
}) as { run: { id: string } }
let childId = 0
for (let i = 0; i < 200; i++) {
  await delay(50)
  const working = kernel.listConversations().find((c) => c.parentConversationId === 1 && c.status === 'working')
  if (working) {
    childId = working.id
    break
  }
}
if (!childId) process.exit(4)
await delay(1100)
await kernel.documentStore.flush()
process.stdout.write('CHILD=' + childId + ',RUN=' + run.id + '\\n')
await delay(100)
process.kill(process.pid, 'SIGKILL')
`,
    'utf8',
  )
  const tsxCli = require.resolve('tsx/cli')
  let child: ReturnType<typeof spawn> | undefined
  let kernelAfterKill: KernelRuntime | undefined
  t.after(async () => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    await kernelAfterKill?.close().catch(() => {})
    rmSync(seedDir, { recursive: true, force: true })
    rmSync(sigkillDir, { recursive: true, force: true })
  })

  try {
    child = spawn(process.execPath, [tsxCli, seederPath], {
      cwd: KERNEL_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: seedDir,
        HELM_SEED_DIR: sigkillDir,
        HELM_DATA_DIR: sigkillDir,
        HELM_WATCHDOG_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childId = 0
    let runId = ''
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let out = ''
        let err = ''
        child!.stdout!.on('data', (d: Buffer) => {
          out += d.toString()
          const m = /CHILD=(\d+),RUN=([^\s]+)/.exec(out)
          if (m) {
            childId = Number(m[1])
            runId = m[2]!
          }
        })
        child!.stderr!.on('data', (d: Buffer) => { err += d.toString() })
        child!.on('exit', (code, signal) => {
          if (signal === 'SIGKILL' || code === 137) resolve()
          else reject(new Error(`sync seeder exit code=${code} signal=${signal}: ${out}${err}`.slice(0, 2000)))
        })
        child!.on('error', reject)
      }),
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error('sync seeder 30s 未退出')
      }),
    ])
    assert.ok(childId > 1 && runId !== '')

    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: sigkillDir,
      cwd: sigkillDir,
      model: 'faux/faux-1',
      models,
      autoResume: false,
    })
    kernelAfterKill = kernel
    const rootInputs: unknown[] = []
    kernel.events.subscribe((frame: HelmEventFrame) => {
      const e = frame.event as { type?: string; conversationId?: number; entry?: { kind?: string } }
      if (e.type === 'conversation.entry' && e.conversationId === ROOT && e.entry?.kind === 'helm.input') {
        rootInputs.push(e.entry)
      }
    })
    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.start()

    assert.equal(faux.state.callCount, 0, '同步工作流重启恢复不得新增模型调用（子会话与父会话均零调用）')
    assert.equal(kernel.getConversation(childId).status, 'idle', '同步工作流遗留子会话必须收敛为 idle')
    assert.equal(rootInputs.length, 0, '同步工作流恢复不得向父会话投递通知')
    const runs = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
      runs: Array<{ id: string; status: string; error?: string }>
    }
    const settled = runs.runs.find((r) => r.id === runId)
    assert.equal(settled?.status, 'failed')
    assert.match(settled?.error ?? '', /interrupted/)
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }

  // ---- B) graceful kernel.close() 中断同步工作流 ----
  const closeDir = mkdtempSync(join(tmpdir(), 'helm-sync-close-'))
  const fauxC1 = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
  const modelsC1 = createModels()
  modelsC1.setProvider(fauxC1.provider)
  fauxC1.setResponses([fauxAssistantMessage('优雅关停期缓慢输出的同步子会话长回复内容确保仍在执行中')])
  const k1 = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir: closeDir,
    cwd: closeDir,
    model: 'faux/faux-1',
    models: modelsC1,
    autoResume: false,
  })
  let k2: KernelRuntime | undefined
  t.after(async () => {
    await k1.close().catch(() => {})
    await k2?.close().catch(() => {})
    rmSync(closeDir, { recursive: true, force: true })
  })
  await k1.plugins.register(createWorkflowPlugin())
  await k1.start()

  const { run: closeRun } = (await k1.plugins.invokeAction('builtin:workflow', 'run', {
    conversationId: ROOT,
    script: 'export const meta = { name: "sync-graceful", description: "test" }\nreturn await agent("slow-sync-close")',
  })) as { run: { id: string } }
  let closeChildId = 0
  for (let i = 0; i < 200; i++) {
    await delay(30)
    const working = k1.listConversations().find((c) => c.parentConversationId === ROOT && c.status === 'working')
    if (working) {
      closeChildId = working.id
      break
    }
  }
  assert.ok(closeChildId > 1, '同步子会话必须进入 working')
  await k1.close()

  const recordPath = join(closeDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1', `workflow-${closeRun.id}.record.json`)
  const recordAfterClose = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
  assert.equal(recordAfterClose['status'], 'aborted')
  assert.equal(recordAfterClose['pendingChildCleanup'], true, 'host closing 时存在子会话必须写入 pendingChildCleanup')

  const fauxC2 = fauxProvider()
  const modelsC2 = createModels()
  modelsC2.setProvider(fauxC2.provider)
  k2 = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir: closeDir,
    cwd: closeDir,
    model: 'faux/faux-1',
    models: modelsC2,
    autoResume: false,
  })
  const rootInputs2: unknown[] = []
  k2.events.subscribe((frame: HelmEventFrame) => {
    const e = frame.event as { type?: string; conversationId?: number; entry?: { kind?: string } }
    if (e.type === 'conversation.entry' && e.conversationId === ROOT && e.entry?.kind === 'helm.input') {
      rootInputs2.push(e.entry)
    }
  })
  await k2.plugins.register(createWorkflowPlugin())
  await k2.start()

  assert.equal(fauxC2.state.callCount, 0, '关停残留子会话重启不得继续执行或发父通知')
  assert.equal(k2.getConversation(closeChildId).status, 'idle')
  assert.equal(rootInputs2.length, 0)
  const recordAfterRestart = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
  assert.equal(recordAfterRestart['pendingChildCleanup'], undefined, 'init() 恢复后必须清除 pendingChildCleanup')
})

// ---------------------------------------------------------------------------
// 用例 5：原生 isolation:'worktree' SIGKILL 崩溃租约在 runtime.started 后自动收敛
// ---------------------------------------------------------------------------

test('原生 isolation:worktree SIGKILL 崩溃租约在重启 runtime.started 后自动回收并放行 cleanup_worktree；外部 executionId 租约保持 fail-closed', { timeout: 60_000 }, async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'helm-wt-sigkill-'))
  const repoDir = join(baseDir, 'repo')
  const dataDir = join(baseDir, 'data')
  const seedDir = join(baseDir, 'seed')
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(seedDir, { recursive: true })

  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@helm.local'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.name', 'Helm Test'], { cwd: repoDir })
  writeFileSync(join(repoDir, 'README.md'), 'init\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir })

  const workflowSrc = pathToFileURL(new URL('../src/workflow.ts', import.meta.url).pathname).href
  const seederPath = join(seedDir, 'wt-seed.mts')
  writeFileSync(
    seederPath,
    `import { setTimeout as delay } from 'node:timers/promises'
import { createModels } from ${JSON.stringify(pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href)}
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href)}
import { KernelRuntime } from ${JSON.stringify(KERNEL_SRC)}
import { createPluginBuildProvider } from ${JSON.stringify(import.meta.resolve('@helm/plugin-build'))}
import { createWorkflowPlugin } from ${JSON.stringify(workflowSrc)}

const dataDir = process.env.HELM_SEED_DIR!
const repoDir = process.env.HELM_REPO_DIR!
const models = createModels()
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage('这是一段慢速工作树隔离子代理流式文本确保进程崩溃时原生租约仍在运行中')])
const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: repoDir, model: 'faux/faux-1', models, autoResume: false })
await kernel.plugins.register(createWorkflowPlugin())
await kernel.start()
const { run } = await kernel.plugins.invokeAction('builtin:workflow', 'run', {
  conversationId: 1,
  script: 'export const meta = { name: "wt-sigkill", description: "test" }\\nreturn await agent("wt-slow", { isolation: "worktree" })',
}) as { run: { id: string } }
let childId = 0
for (let i = 0; i < 200; i++) {
  await delay(50)
  const working = kernel.listConversations().find((c) => c.parentConversationId === 1 && c.status === 'working')
  if (working) {
    childId = working.id
    break
  }
}
if (!childId) process.exit(5)
await delay(1100)
await kernel.documentStore.flush()
process.stdout.write('CHILD=' + childId + ',RUN=' + run.id + '\\n')
await delay(100)
process.kill(process.pid, 'SIGKILL')
`,
    'utf8',
  )

  const tsxCli = require.resolve('tsx/cli')
  let child: ReturnType<typeof spawn> | undefined
  let recoveredKernel: KernelRuntime | undefined
  t.after(async () => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    await recoveredKernel?.close().catch(() => {})
    rmSync(baseDir, { recursive: true, force: true })
  })

  try {
    child = spawn(process.execPath, [tsxCli, seederPath], {
      cwd: KERNEL_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: seedDir,
        HELM_SEED_DIR: dataDir,
        HELM_REPO_DIR: repoDir,
        HELM_DATA_DIR: dataDir,
        HELM_WATCHDOG_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childId = 0
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let out = ''
        let err = ''
        child!.stdout!.on('data', (d: Buffer) => {
          out += d.toString()
          const m = /CHILD=(\d+),RUN=([^\s]+)/.exec(out)
          if (m) childId = Number(m[1])
        })
        child!.stderr!.on('data', (d: Buffer) => { err += d.toString() })
        child!.on('exit', (code, signal) => {
          if (signal === 'SIGKILL' || code === 137) resolve()
          else reject(new Error(`wt seeder exit code=${code} signal=${signal}: ${out}${err}`.slice(0, 2000)))
        })
        child!.on('error', reject)
      }),
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error('wt seeder 30s 未退出')
      }),
    ])
    assert.ok(childId > 1)

    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/faux-1',
      models,
      autoResume: false,
    })
    recoveredKernel = kernel

    // 在插件启动前校验真实崩溃现场已落原生 running 租约，并同时种入 1 条外部 executionId 租约做对比。
    const preState = kernel.documentStore.get<Record<string, unknown>>('builtin:workflow:worktree-state', {})
    const preLeases = (preState['worktree-leases'] as Record<string, { phase: string; info: { conversationId?: number; executionId?: string } }> | undefined) ?? {}
    const nativeLeaseKeys = Object.entries(preLeases)
      .filter(([, l]) => l.info.conversationId === childId && l.info.executionId === undefined)
      .map(([k]) => k)
    assert.equal(nativeLeaseKeys.length, 1, `SIGKILL 现场应有 1 条原生租约（实际：${JSON.stringify(preLeases)}）`)

    preLeases['ext-lease-seed'] = {
      phase: 'running',
      info: { conversationId: 9999, executionId: 'herdr:pane-keep' },
      worktreeId: 'wt-ext-keep',
      createdAt: 1,
    } as never
    preState['worktree-leases'] = preLeases
    kernel.documentStore.set('builtin:workflow:worktree-state', preState)
    await kernel.documentStore.flush()

    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.start()

    assert.equal(faux.state.callCount, 0, '工作树遗留子会话重启期零新增模型调用')
    assert.equal(kernel.getConversation(childId).status, 'idle', '子会话先于租约回收收敛 idle')

    const postState = kernel.documentStore.get<Record<string, unknown>>('builtin:workflow:worktree-state', {})
    const postLeases = (postState['worktree-leases'] as Record<string, unknown> | undefined) ?? {}
    assert.equal(postLeases[nativeLeaseKeys[0]!], undefined, '已停止原生租约必须被 runtime.started 自动回收')
    assert.ok(postLeases['ext-lease-seed'], '外部 executionId 租约必须继续保留 fail-closed')

    // 确认 cleanup_worktree 不再被 worktree_execution_unknown 阻塞
    try {
      const cleaned = (await kernel.plugins.invokeAction('builtin:workflow', 'cleanup_worktree', {
        conversationId: childId,
        deleteBranch: true,
      })) as { removed: boolean }
      assert.equal(cleaned.removed, true)
    } catch (error) {
      assert.ok(
        error instanceof Error && 'code' in error && (error as { code?: string }).code === 'worktree_process_check_failed',
        `原生租约回收后 cleanup_worktree 只允许环境 /proc 限制，实得：${String(error)}`,
      )
    }
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }
})
