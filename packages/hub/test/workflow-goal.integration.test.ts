/**
 * 多级工作流与失败自动重试设计验收（T2/T3）集成测试。
 *
 * 对应 docs/archive/20261115-多级工作流与失败自动重试设计文档.md：
 *
 * T2（goal 失败自动重试，真实全链路）：
 * - 真 createHelm + 真 KernelRuntime + faux provider + 真 WorkflowService（经
 *   builtin:workflow 的 run 动作，与 HTTP/CLI 同链路）+ 真 WorktreeAllocator
 *   隔离树；gate 由内核 settleGate → runGate → runShell 真实执行，超时杀整
 *   个进程组（不 mock 核心超时）。
 * - goal({ label: 'worker-c', isolation: 'worktree', maxAttempts: 3,
 *   gateTimeoutMs: 1500 })：第 1 次门禁挂起 8s（被 1.5s 进程组超时强杀）、
 *   第 2 次门禁 exitCode=1、第 3 次成功。
 * - 断言：三次尝试共用同一 conversationId 与同一 worktree（path/branch/id
 *   一致，全程只派生一个子会话）；账本逐次记录 gate.timedOut / gate.exitCode
 *   与 execution；最终 ok: true, attempts: 3；被杀门禁进程在逃逸窗口内未
 *   写出存活标记（进程组 kill 真实生效，非只置标志）。
 *
 * T3（三级嵌套同名 label + resumeFromRunId 断点续跑，真实引擎）：
 * - 总控 → 模块子工作流 → 模块内两并发同名 'plan' 节点（agent.withMeta 与
 *   goal(worktree)），另一模块再用同名 'plan'（三个同名 label 会话在同一
 *   run 内共存，按 scopeId 隔离）。
 * - 模块 A：goal + 幂等 git merge（idempotent: true）+ cleanup_worktree
 *   全部成功；模块 B：普通 agent 因 Schema 校验失败返回 null，脚本 throw
 *   导致 Run failed。
 * - 修复 faux 模型响应后 run({ resumeFromRunId })：模块 A 的全部 agent（含
 *   withMeta 的 execution.worktree）与 action 命中账本缓存（cached: true，
 *   副作用计数零新增），仅模块 B 失败节点 live 重跑并最终 completed；
 *   B 侧 resume('plan') 续接的是 B 自己的子会话（按会话 transcript 证据
 *   核验，同名 label 不得串到 A 侧会话）。
 * - 顺序约束（如实声明）：账本前缀重放按 index+key 严格匹配，跨模块并发
 *   调用的落账顺序在重放 run 中不可复现（实验验证：缓存节点即时回放会使
 *   并发交错翻转变 live 重跑），故总控顺序启动两个模块；同名 label 的并发
 *   验收由模块 A 内部 parallel 的两个同名 'plan' 节点承载。
 *
 * 诚实性纪律：真 SQLite + 真 pi-durable + 真 Git 仓库 + 真文件账本；faux
 * provider 只按 transcript 标记路由脚本化模型响应，不伪造引擎/内核结果。
 * gate 命令统一 node 单行脚本（跨平台）；自建子进程仅由内核 runShell 按进
 * 程组管理，测试自身不 spawn 额外进程。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
 */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'

/** 进程占用扫描当前仅 Linux /proc（与 worktree-runtime 集成测试同款平台事实）。 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** 模型请求路由器：按 transcript 决定响应；无法路由时抛错（不静默兜底）。 */
type ModelRoute = (context: {
  texts: string[]
  afterToolResult: boolean
}) => AssistantMessage | undefined

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 提取全部 user 文本（字符串正文与文本块）。 */
function userTextsOf(context: TranscriptContext): string[] {
  const out: string[] = []
  for (const message of context.messages) {
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') {
      out.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text'
        ) {
          out.push(String((block as { text?: unknown }).text ?? ''))
        }
      }
    }
  }
  return out
}

/** 最近一条消息是否为工具结果（回合内工具执行完毕、模型被再次调用）。 */
function endsWithToolResult(context: TranscriptContext): boolean {
  const last = context.messages.at(-1)
  if (last === undefined) return false
  return JSON.stringify(last).includes('"toolResult"')
}

/** 组装 faux 响应步（同一路由函数重复占位，按请求即时路由）。 */
function routedResponses(route: ModelRoute, count: number) {
  const step = (context: TranscriptContext): AssistantMessage => {
    const message = route({ texts: userTextsOf(context), afterToolResult: endsWithToolResult(context) })
    if (message === undefined) {
      throw new Error(`faux 路由未命中：最近用户文本 ${(userTextsOf(context).at(-1) ?? '(无)').slice(0, 200)}`)
    }
    return message
  }
  return Array.from({ length: count }, () => step)
}

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-workflow-goal-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 真实临时 Git 仓库（main 分支 + 初始提交；用户级配置隔离）。 */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@helm.local'])
  git(['config', 'user.name', 'helm-test'])
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  return dir
}

interface RuntimeEnv {
  app: Awaited<ReturnType<typeof createHelm>>
  kernel: Awaited<ReturnType<typeof createHelm>>['kernel']
  faux: ReturnType<typeof fauxProvider>
  conversationId: number
  /** builtin:workflow 公开动作总线（HTTP/CLI/模型工具同链路）。 */
  runWorkflowAction(request: Record<string, unknown>): Promise<{ run: Record<string, any> }>
  inspectRun(runId: string): Promise<Record<string, any>>
  saveWorkflow(script: string): Promise<void>
  close(): Promise<void>
}

/** 真实 createHelm（builtin:workflow 默认启用）+ faux provider；cwd 指向真实 Git 仓库。 */
async function openRuntime(dataDir: string, repoDir: string): Promise<RuntimeEnv> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const app = await createHelm({
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    models: models as never,
  } as never)
  const kernel = app.kernel
  const conversationId = kernel.listConversations()[0]!.id
  return {
    app,
    kernel,
    faux,
    conversationId,
    runWorkflowAction: (request) =>
      kernel.plugins.invokeAction('builtin:workflow', 'run', request) as never,
    inspectRun: (runId) =>
      kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as never,
    saveWorkflow: async (script) => {
      await kernel.plugins.invokeAction('builtin:workflow', 'save', { script })
    },
    async close() {
      await app.close().catch(() => {})
    },
  }
}

/** 读取 run 的真实账本文件（插件数据目录 plugins/builtin%3Aworkflow/artifacts/<convId>/workflow-<runId>.jsonl）。 */
function readJournal(dataDir: string, conversationId: number, runId: string): Array<Record<string, any>> {
  const path = join(
    dataDir,
    'plugins',
    'builtin%3Aworkflow',
    'artifacts',
    String(conversationId),
    `workflow-${runId}.jsonl`,
  )
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>)
}

/** 递归查找同名文件（进程逃逸标记排查）。 */
function findFileRecursive(root: string, name: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === name) found.push(path)
    }
  }
  walk(root)
  return found
}

// ---------------------------------------------------------------------------
// T2：goal 失败自动重试（真实 KernelRuntime + worktree 隔离 + 真实门禁超时）
// ---------------------------------------------------------------------------

describe('T2 goal 门禁失败自动重试（真内核/faux/WorkflowService/worktree）', { timeout: 60_000 }, () => {
  it('三次尝试同会话同 worktree：gate 超时强杀 / exit 1 / 成功，attempts=3', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = makeGitRepo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)

    // 门禁脚本（gate 在 worktree 内执行，按标记文件决定行为）：
    // - 仅 attempt-1：挂起 8 秒（超过 gateTimeoutMs=1500，应被进程组超时杀掉；
    //   若 kill 失效，8s 后写出逃逸标记 gate-1-escaped.txt 并以 0 退出）
    // - attempt-2 存在：exit 1
    // - attempt-3 存在：exit 0
    const gateCommand =
      'node -e "const fs=require(\'fs\');' +
      "if(fs.existsSync('attempt-3.txt'))process.exit(0);" +
      "if(fs.existsSync('attempt-2.txt'))process.exit(1);" +
      "setTimeout(function(){fs.writeFileSync('gate-1-escaped.txt','alive')},8000)" +
      '"'
    const script =
      'export const meta = { name: "t2-goal-retry", description: "goal 门禁三态重试验收" }\n' +
      'const result = await goal({\n' +
      '  label: "worker-c",\n' +
      '  objective: "T2-GOAL-OBJECTIVE：在隔离工作树内完成提交并通过门禁",\n' +
      '  isolation: "worktree",\n' +
      `  gate: ${JSON.stringify(gateCommand)},\n` +
      '  gateTimeoutMs: 1500,\n' +
      '  maxAttempts: 3,\n' +
      '})\n' +
      'return result\n'

    // faux 模型路由：每次尝试先用 bash 写 attempt-N.txt 标记，再回文本；
    // 当前尝试序号由 transcript 中的 [attempt N failed] 增量块判定。
    const t2Route: ModelRoute = ({ texts, afterToolResult }) => {
      if (!texts.some((t) => t.includes('T2-GOAL-OBJECTIVE'))) return undefined
      const attempt = texts.some((t) => t.includes('[attempt 2 failed]'))
        ? 3
        : texts.some((t) => t.includes('[attempt 1 failed]'))
          ? 2
          : 1
      if (afterToolResult) return fauxAssistantMessage(`T2-A${attempt}-DONE`)
      return fauxAssistantMessage(
        [
          fauxToolCall('bash', {
            command: `node -e "require('fs').writeFileSync('attempt-${attempt}.txt','1')"`,
          }),
        ],
        { stopReason: 'toolUse' },
      )
    }

    try {
      env.faux.setResponses(routedResponses(t2Route, 10))
      const startedAt = Date.now()
      const { run } = await env.runWorkflowAction({
        script,
        conversationId: env.conversationId,
        wait: true,
      })

      // ---- 最终结果：第 3 次尝试成功，attempts=3，回传执行元数据。----
      assert.equal(run.status, 'completed', JSON.stringify(run.error))
      assert.equal(run.result.ok, true)
      assert.equal(run.result.attempts, 3)
      assert.equal(run.result.output, 'T2-A3-DONE')
      assert.ok(run.result.execution, 'goal 结果应回传 execution 元数据')
      assert.equal(run.result.execution.conversationId > env.conversationId, true, '应派生子会话')
      const worktree = run.result.execution.worktree
      assert.ok(worktree, 'isolation:worktree 应回传 worktree 元数据')
      assert.ok(worktree.path.includes(join(dir, '.helm-worktrees')), `worktree 应位于同级 .helm-worktrees：${worktree.path}`)
      assert.ok(worktree.branch.startsWith('helm/spawn-'), `分支应为 helm/spawn-*：${worktree.branch}`)
      assert.ok(typeof worktree.id === 'string' && worktree.id.length > 0, '应回传受管 worktreeId')
      assert.equal(run.result.gate.ok, true, '第 3 次门禁应通过')

      // ---- 全程只派生一个子会话：三次尝试续接同一会话。----
      const children = env.kernel
        .listConversations()
        .filter((c) => c.parentConversationId === env.conversationId)
      assert.equal(children.length, 1, `应只有一个子会话，实得 ${children.length}`)
      assert.equal(children[0]!.id, run.result.execution.conversationId)
      assert.equal(children[0]!.cwd, worktree.path, '子会话 cwd 应为隔离工作树')

      // ---- 真实账本：三次尝试逐条落账，gate 结果与执行元数据完整。----
      const entries = readJournal(dataDir, env.conversationId, run.id).filter((e) => e['type'] === 'agent')
      assert.equal(entries.length, 3, `账本应有 3 条 agent 尝试记录，实得 ${entries.length}`)
      const [first, second, third] = entries as [
        Record<string, any>,
        Record<string, any>,
        Record<string, any>,
      ]
      assert.deepEqual(
        entries.map((e) => [e['index'], e['attempt'], e['ok']]),
        [[0, 1, false], [1, 2, false], [2, 3, true]],
        `尝试账本应按 index/attempt/ok 落账：${JSON.stringify(entries.map((e) => ({ i: e['index'], a: e['attempt'], ok: e['ok'] })))}`,
      )
      // 第 1 次：门禁 1.5s 进程组超时强杀（真实 runShell 超时路径）。
      //（原生链路门禁事实在 gate.timedOut/exitCode；attempt 级 timedOut 仅在
      // 宿主 fallback 门禁路径透传，不在此断言。）
      assert.equal(first['gate'].ok, false)
      assert.equal(first['gate'].timedOut, true, '第 1 次门禁应如实回传 timedOut=true')
      assert.equal(first['gate'].exitCode, null, '被杀进程无退出码，应为 null')
      // 第 2 次：门禁退出码 1。
      assert.equal(second['gate'].ok, false)
      assert.equal(second['gate'].exitCode, 1, '第 2 次门禁应回传 exitCode=1')
      assert.equal(second['gate'].timedOut, false)
      assert.equal(second['resumed'], true, '第 2 次尝试应是续接（resumed 标记）')
      // 第 3 次：成功且仍标记续接。
      assert.equal(third['ok'], true)
      assert.equal(third['attempt'], 3)
      assert.equal(third['resumed'], true)

      // ---- 同 conversationId / 同 worktree（path、branch、id 三次一致）。----
      for (const entry of entries) {
        assert.equal(entry['execution'].conversationId, run.result.execution.conversationId)
        assert.equal(entry['execution'].worktree.path, worktree.path)
        assert.equal(entry['execution'].worktree.branch, worktree.branch)
        assert.equal(entry['execution'].worktree.id, worktree.id)
      }
      // 三次尝试的标记文件都落在同一工作树内（尝试确实在同一树中执行）。
      for (const n of [1, 2, 3]) {
        assert.ok(existsSync(join(worktree.path, `attempt-${n}.txt`)), `attempt-${n}.txt 应存在于同一 worktree`)
      }
      assert.ok(existsSync(worktree.path), '重试全程保留同一 worktree（失败不回收）')

      // ---- 进程组 kill 真实性：挂起门禁若未被杀，8s 后会写出逃逸标记；
      // 且整个 run 会被拖到 8s 以上（本轮实测约 2s）。----
      const goalNode = (run.nodes ?? []).find((n: Record<string, any>) => n['label'] === 'worker-c')
      assert.ok(goalNode, '应存在 label worker-c 的 agent 节点')
      assert.equal(goalNode!['status'], 'done')
      assert.equal(goalNode!['conversationId'], run.result.execution.conversationId)
      assert.ok(
        typeof run['updatedAt'] === 'number' && typeof run['createdAt'] === 'number',
        'run 摘要应携带 createdAt/updatedAt',
      )
      assert.ok(
        run['updatedAt'] - run['createdAt'] < 8_000,
        `整个 run 用时 ${run['updatedAt'] - run['createdAt']}ms 应远小于 8s 挂起下限（门禁被 1.5s 进程组超时终止）`,
      )
      const escaped = findFileRecursive(dir, 'gate-1-escaped.txt')
      if (escaped.length > 0) {
        // 已存在即立刻失败（快于逃逸窗口的防御分支）。
        assert.fail(`门禁进程逃逸（未被进程组杀死）：${escaped.join(', ')}`)
      }
      while (Date.now() - startedAt < 9_500) await sleep(200)
      assert.deepEqual(
        findFileRecursive(dir, 'gate-1-escaped.txt'),
        [],
        '被杀门禁进程在 8s 逃逸窗口后不得写出存活标记（进程组 kill 真实生效）',
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3：三级嵌套同名 label + resumeFromRunId 断点续跑
// ---------------------------------------------------------------------------

describe('T3 三级嵌套同名 plan 与 resumeFromRunId 断点续跑', { timeout: 60_000 }, () => {
  it('模块 A 全缓存复用、仅模块 B 失败节点 live 重跑，元数据完整还原', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = makeGitRepo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)
    const signalPath = join(repo, 'b-open-gate.txt')
    // 模块 B 的 plan 可切换失败/成功（修复模拟模型响应后 resume）。
    const state = { modB: 'fail' as 'fail' | 'ok' }

    // ---- faux 路由：按最近用户文本标记分发；MODB-FIX 先于 MODB-PLAN（其
    // transcript 同时含两者标记）。----
    const route: ModelRoute = ({ texts, afterToolResult }) => {
      const last = texts.at(-1) ?? ''
      const has = (marker: string) => texts.some((t) => t.includes(marker))
      if (has('MODB-FIX-OBJECTIVE')) {
        // scopeId 隔离核验：B 的 resume('plan') 必须落在 B 自己的 plan 会话——
        // transcript 含 B 计划标记且不含 A 侧同名 label 会话内容。
        if (!has('MODB-PLAN-OBJECTIVE') || has('MODA-GOAL-OBJECTIVE') || has('SUBA-PLAN-OBJECTIVE')) {
          throw new Error(
            `resume('plan') 续接了错误会话（scope 隔离破坏）：transcript 标记 ${JSON.stringify(texts.map((t) => t.slice(0, 60)))}`,
          )
        }
        return fauxAssistantMessage('B-FIX-OK')
      }
      if (has('MODB-PLAN-OBJECTIVE')) {
        return state.modB === 'fail'
          ? fauxAssistantMessage('这不是合法 JSON')
          : fauxAssistantMessage('{"answer":"b-plan-ok"}')
      }
      if (has('MODA-GOAL-OBJECTIVE')) {
        if (afterToolResult) return fauxAssistantMessage('A-GOAL-DONE')
        return fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command:
                'node -e "require(\'fs\').writeFileSync(\'mod-a-done.txt\',\'1\')" && ' +
                'git add -A && git commit -m "mod-a work"',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (has('SUBA-PLAN-OBJECTIVE')) return fauxAssistantMessage('SUBA-OK')
      return undefined
    }

    // ---- 三级脚本：总控（内联）→ 模块 t3-mod-a / t3-mod-b → 叶子 t3-sub-a。----
    // 模块 A 内部 parallel 承载同名 'plan' 的真并发（goal 与叶子子工作流）；
    // 总控顺序启动两模块（账本前缀重放的调用顺序确定性约束，见文件头）。
    const goalGate = 'node -e "process.exit(require(\'fs\').existsSync(\'mod-a-done.txt\')?0:1)"'
    // 信号动作追加写一行，兼作副作用计数器——resume 不得追加第二行。
    const signalCommand = [
      'node',
      '-e',
      'require(\'fs\').appendFileSync(process.argv[1],\'x\\n\')',
      signalPath,
    ]
    const planSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }

    const subAScript =
      'export const meta = { name: "t3-sub-a", description: "三级嵌套叶子：agent.withMeta 同名 plan" }\n' +
      'const r = await agent.withMeta("SUBA-PLAN-OBJECTIVE：直接回答任务摘要", { label: "plan" })\n' +
      'if (!r.ok) throw new Error("t3-sub-a failed: " + r.error)\n' +
      'return r\n'

    const modAScript =
      'export const meta = { name: "t3-mod-a", description: "模块A：并发同名 plan（goal+叶子）+ 幂等合入与清理" }\n' +
      'const pair = await parallel([\n' +
      '  () => workflow("t3-sub-a", {}),\n' +
      '  () => goal({\n' +
      '    label: "plan",\n' +
      '    objective: "MODA-GOAL-OBJECTIVE：写入 mod-a-done.txt 并提交到当前分支",\n' +
      '    isolation: "worktree",\n' +
      `    gate: ${JSON.stringify(goalGate)},\n` +
      '    gateTimeoutMs: 5000,\n' +
      '    maxAttempts: 2,\n' +
      '  }),\n' +
      '])\n' +
      'const sub = pair[0]\n' +
      'const g = pair[1]\n' +
      'if (!sub || sub.ok !== true) throw new Error("mod-a sub failed")\n' +
      'if (!g || g.ok !== true || !g.execution || !g.execution.worktree) throw new Error("mod-a goal failed: " + (g ? (g.error || "no worktree") : "null"))\n' +
      'const branch = g.execution.worktree.branch\n' +
      'const merge = await action("env.exec", {\n' +
      '  cwd: args.repoDir,\n' +
      '  command: "git merge-base --is-ancestor " + branch + " HEAD || git merge --no-ff -m \\"feat: mod-a\\" " + branch,\n' +
      '  allowFailure: true,\n' +
      '}, { idempotent: true, label: "merge-a" })\n' +
      'if (!merge.ok) throw new Error("mod-a merge failed: " + merge.output)\n' +
      'let cleaned = null\n' +
      'if (args.linux) {\n' +
      '  const c = await action("builtin:workflow.cleanup_worktree", { worktreeId: g.execution.worktree.id, deleteBranch: true }, { idempotent: true, label: "cleanup-a" })\n' +
      '  cleaned = c.removed === true\n' +
      '}\n' +
      'const signal = await action("env.exec", { command: ' +
      JSON.stringify(signalCommand) +
      ', cwd: args.repoDir }, { idempotent: true, label: "signal-b" })\n' +
      'if (!signal.ok) throw new Error("mod-a signal failed")\n' +
      'return { sub, goal: g, mergeOk: merge.ok, cleaned, branch }\n'

    const modBScript =
      'export const meta = { name: "t3-mod-b", description: "模块B：同名 plan agent 失败（resume 后成功）" }\n' +
      'const plan = await agent("MODB-PLAN-OBJECTIVE：按 Schema 返回答案", { label: "plan", schema: ' +
      JSON.stringify(planSchema) +
      ' })\n' +
      'if (!plan) throw new Error("mod-b plan agent failed (schema)")\n' +
      'const fix = await agent("MODB-FIX-OBJECTIVE：确认已续接本模块 plan 会话", { resume: "plan" })\n' +
      'return { plan, fix }\n'

    const masterScript =
      'export const meta = { name: "t3-master", description: "总控：两个同名 plan 模块（顺序启动，见测试文件头顺序约束说明）" }\n' +
      'const a = await workflow("t3-mod-a", args)\n' +
      'if (!a) throw new Error("module A workflow failed")\n' +
      'const b = await workflow("t3-mod-b", args)\n' +
      'if (!b) throw new Error("module B workflow failed")\n' +
      'return { a, b }\n'

    try {
      // ---- 保存三个子工作流定义（真实 save 动作 + meta.name 命名）。----
      for (const script of [subAScript, modAScript, modBScript]) {
        await env.saveWorkflow(script)
      }

      const runArgs = { repoDir: repo, linux: PROCESS_SCAN_ON }

      // ---- 第 1 次运行：模块 B 的 plan agent Schema 失败 → run failed。----
      env.faux.setResponses(routedResponses(route, 24))
      let failedRunId = ''
      await assert.rejects(
        () =>
          env.runWorkflowAction({
            script: masterScript,
            args: runArgs,
            conversationId: env.conversationId,
            wait: true,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HelmError, `应为 HelmError，实得 ${String(error)}`)
          assert.equal(error.code, 'workflow_failed')
          const details = error.details as { runId?: string } | undefined
          assert.ok(typeof details?.runId === 'string', '失败详情应携带 runId')
          failedRunId = details!.runId!
          return true
        },
      )
      const failed = (await env.inspectRun(failedRunId)).run
      assert.equal(failed.status, 'failed')
      assert.match(String(failed.error), /mod-b plan agent failed/, `失败应源于模块 B 的 plan agent：${failed.error}`)
      assert.doesNotMatch(String(failed.error), /mod-a|module A/, `模块 A 不应失败：${failed.error}`)

      // 第 1 次账本：模块 A 全部成功；模块 B 的 plan 失败但保留执行元数据。
      const journal1 = readJournal(dataDir, env.conversationId, failedRunId)
      const agentEntries = journal1.filter((e) => e['type'] === 'agent')
      const goalEntry = agentEntries.find(
        (e) => e['ok'] === true && e['execution']?.['worktree']?.['branch']?.startsWith('helm/spawn-'),
      )
      assert.ok(goalEntry, '模块 A 的 goal 应成功并落账 worktree 元数据')
      const failedPlan = agentEntries.find((e) => e['ok'] === false)
      assert.ok(failedPlan, '模块 B 的 plan 失败应落账')
      assert.equal(failedPlan!['attempt'], 1)
      assert.ok(
        typeof failedPlan!['execution']?.['conversationId'] === 'number',
        '失败尝试应保留 conversationId（失败不丢弃执行元数据）',
      )
      const actionEntries = journal1.filter((e) => e['type'] === 'action')
      // 动作账本行不含 label（按 index/key 落账）；数量、成功与幂等标记与
      // 各动作的真实副作用证据（信号计数/git log/分支删除）共同锁验。
      assert.equal(
        actionEntries.length,
        PROCESS_SCAN_ON ? 3 : 2,
        `应落账 merge-a${PROCESS_SCAN_ON ? '/cleanup-a' : ''}/signal-b，实得 ${actionEntries.length}`,
      )
      for (const entry of actionEntries) {
        assert.equal(entry['ok'], true, `动作应全部成功：${JSON.stringify(entry)}`)
        assert.equal(entry['idempotent'], true, '全部动作应显式标记幂等')
      }
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', '模块 A 信号动作应恰好执行一次')

      // 真实副作用：合并提交已落在 main；隔离树已清理。
      const logText = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.match(logText, /feat: mod-a/, '模块分支应真实合入 main')
      if (PROCESS_SCAN_ON) {
        const goalBranch = goalEntry!['execution']['worktree']['branch'] as string
        const branchList = execFileSync('git', ['branch', '--list', goalBranch], { cwd: repo, encoding: 'utf8' })
        assert.equal(branchList.trim(), '', 'cleanup(deleteBranch) 后模块分支应被删除')
      }
      const failedPlanConversationId = failedPlan!['execution']['conversationId'] as number
      // 同名 'plan' 三会话共存互不混淆：goal / 叶子 / 模块 B 各自独立子会话。
      const planConversationIds = agentEntries
        .map((e) => e['execution']?.['conversationId'])
        .filter((id) => typeof id === 'number')
      assert.equal(
        new Set(planConversationIds).size,
        planConversationIds.length,
        `同名 plan 的三个会话应互不相同：${JSON.stringify(planConversationIds)}`,
      )

      // ---- 修复模拟模型响应后断点续跑：仅失败节点 live，其余全缓存。----
      state.modB = 'ok'
      env.faux.setResponses(routedResponses(route, 24))
      const { run: resumed } = await env.runWorkflowAction({
        resumeFromRunId: failedRunId,
        conversationId: env.conversationId,
        wait: true,
      })
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error))
      assert.equal(resumed.replayedFrom, failedRunId, '续跑 run 应标记 replayedFrom')

      // 模块 A 值完整还原（withMeta 元数据从账本缓存重建）。
      const a = resumed.result.a
      assert.ok(a, '模块 A 结果应存在')
      assert.equal(a.sub.ok, true)
      assert.equal(a.sub.output, 'SUBA-OK')
      assert.equal(a.goal.ok, true)
      assert.equal(a.goal.attempts, 1)
      assert.equal(a.goal.output, 'A-GOAL-DONE')
      assert.ok(a.goal.execution.worktree, 'goal 的 execution.worktree 应从缓存还原')
      assert.equal(a.goal.execution.worktree.branch, goalEntry!['execution']['worktree']['branch'])
      assert.equal(a.goal.execution.worktree.id, goalEntry!['execution']['worktree']['id'])
      assert.equal(a.goal.execution.worktree.path, goalEntry!['execution']['worktree']['path'])
      assert.equal(a.mergeOk, true)
      assert.equal(a.cleaned, PROCESS_SCAN_ON ? true : null)

      // 模块 B：plan live 重跑成功（新子会话），fix 续接 B 自己的 plan 会话。
      const b = resumed.result.b
      assert.deepEqual(b.plan, { answer: 'b-plan-ok' })
      assert.equal(b.fix, 'B-FIX-OK')

      // 副作用零重复：信号计数保持一行；合入提交不重复。
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', 'resume 不得重复执行模块 A 的幂等动作')
      const logText2 = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.equal((logText2.match(/feat: mod-a/g) ?? []).length, 1, 'merge 动作不得重复执行')

      // 节点级核验：模块 A 的节点全部 cached；仅模块 B 的 plan/fix live。
      const nodes = (resumed.nodes ?? []) as Array<Record<string, any>>
      const agentNodes = nodes.filter((n) => n['kind'] === 'agent' || String(n['id']).startsWith('agent-'))
      const liveAgentNodes = agentNodes.filter((n) => n['cached'] !== true)
      assert.equal(liveAgentNodes.length, 2, `应恰有 2 个 live agent 节点（B 的 plan 与 fix），实得 ${JSON.stringify(liveAgentNodes.map((n) => ({ id: n['id'], label: n['label'] })))}`)
      const livePlan = liveAgentNodes.find((n) => n['label'] === 'plan')
      assert.ok(livePlan, 'live 重跑的失败节点应保留 label plan')
      assert.ok(
        typeof livePlan!['conversationId'] === 'number' && livePlan!['conversationId'] !== failedPlanConversationId,
        'live 重跑应派生新子会话（不复用失败会话，也不与 A 侧会话混淆）',
      )
      const cachedAgentNodes = agentNodes.filter((n) => n['cached'] === true)
      assert.equal(cachedAgentNodes.length, 2, '模块 A 的 sub-a plan 与 goal 两个 agent 节点应全部命中缓存')
      const actionNodes = nodes.filter((n) => String(n['id']).startsWith('action-'))
      assert.ok(actionNodes.length >= 3, '动作节点应出现在进度树')
      assert.ok(actionNodes.every((n) => n['cached'] === true), '全部动作节点应命中缓存（零副作用重放）')
    } finally {
      await env.close()
    }
  })
})
