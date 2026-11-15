/**
 * workflow-examples.test.ts — docs/workflows/examples 三个示例脚本（cross-review /
 * module-dev / arch-master）的策略分支回归，覆盖《20261115-多级工作流与失败
 * 自动重试设计文档》§5。
 *
 * 全部用真实 runWorkflow（真 worker_threads + vm realm）+ 确定性 fake host：
 * 不执行真实 git、不调用真实模型、不落账本文件。示例位置按 import.meta.url
 * 相对解析，从任意 cwd（含根目录 scripts/run-tests.mjs）运行均有效。
 *
 * 关键分支：
 * - cross-review：create_and_refine 第 1 轮修复即续接 author（resume 与
 *   model/cwd 互斥不违规）；复核失败（verdictMissing）与检查维度失败都不得
 *   冒充“没有问题”；fix_in_place 首轮修复是新会话且可携带 model。
 * - module-dev：goal 输出为字符串需自行 JSON.parse；并发子任务文件不得重叠；
 *   合入阶段不改 ambient 阶段（显式 phase 选项，无竞态）；合并冲突与模块整体
 *   门禁失败交给 goal 修复；review_then_tasks 把嵌套 cross-review 结论注入子任务。
 * - arch-master：幂等合并 + mergedInto 清理；主干合并冲突与全仓门禁失败交给
 *   goal 修复；模块子工作流失败（parallel 折为 null）显式失败，不冒充完成。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowActionEntry, WorkflowAgentEntry, WorkflowEntry } from '../src/workflow/engine/progress.js'
import {
  precheckScriptSyntax,
  runWorkflow,
  type WorkflowHost,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from '../src/workflow/engine/runtime.js'

const timeout = { timeout: 60_000 } as const

const examplesDir = fileURLToPath(new URL('../../../docs/workflows/examples', import.meta.url))
const example = (name: string): string => readFileSync(`${examplesDir}/${name}.js`, 'utf8')

// ---------------------------------------------------------------------------
// 语法与元数据预检
// ---------------------------------------------------------------------------

describe('workflow examples precheck', () => {
  for (const name of ['cross-review', 'module-dev', 'arch-master']) {
    it(`${name} passes syntax and metadata precheck`, timeout, () => {
      const checked = precheckScriptSyntax(example(name))
      assert.equal(checked.meta.name, name)
      assert.ok(checked.meta.description.length > 0)
      assert.ok(checked.body.length > 0)
    })
  }
})

// ---------------------------------------------------------------------------
// 确定性 fake host
// ---------------------------------------------------------------------------

interface AgentCall {
  kind: 'spawn' | 'resume'
  label: string
  agentId: string
  prompt: string
  model?: string
  cwd?: string
  isolation?: string
  gate?: string
  maxSubagentDepth?: number
  timeoutMs?: number
  gateTimeoutMs?: number
}

interface ActionCall {
  actionId: string
  input: Record<string, unknown>
}

type AgentResponder = (
  request: WorkflowSpawnRequest,
  call: AgentCall,
) => WorkflowSpawnResult | Promise<WorkflowSpawnResult>

interface HostOptions {
  agents: Record<string, AgentResponder>
  resume?: (agentId: string, prompt: string) => Promise<WorkflowSpawnResult>
  actions?: Record<string, (input: Record<string, unknown>) => unknown>
  workflows?: Record<string, string>
}

function makeHost(options: HostOptions) {
  const agentCalls: AgentCall[] = []
  const resumeCalls: AgentCall[] = []
  const actionCalls: ActionCall[] = []
  const host: WorkflowHost = {
    async spawnAgent(request) {
      const call: AgentCall = {
        kind: 'spawn',
        label: request.label,
        agentId: request.agentId,
        prompt: request.prompt,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
        ...(request.gate !== undefined ? { gate: request.gate } : {}),
        ...(request.maxSubagentDepth !== undefined ? { maxSubagentDepth: request.maxSubagentDepth } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
      }
      agentCalls.push(call)
      const respond = options.agents[request.label]
      if (respond === undefined) {
        throw new Error(`fake host：未注册的 agent label "${request.label}"`)
      }
      return respond(request, call)
    },
    abortAgent() {},
    ...(options.resume !== undefined
      ? {
          resumeAgent: async (agentId: string, prompt: string): Promise<WorkflowSpawnResult> => {
            const call: AgentCall = { kind: 'resume', label: `resume:${agentId}`, agentId, prompt }
            agentCalls.push(call)
            resumeCalls.push(call)
            return options.resume!(agentId, prompt)
          },
        }
      : {}),
    async runGate() {
      throw new Error('fake host：gate 应随 spawn/resume 结果回传，不得触发 runGate fallback')
    },
    async invokeAction(actionId, input) {
      const record: ActionCall = { actionId, input: (input ?? {}) as Record<string, unknown> }
      actionCalls.push(record)
      const handler = options.actions?.[actionId]
      if (handler === undefined) throw new Error(`fake host：未注册的动作 "${actionId}"`)
      return { pluginId: actionId, actionId, result: handler(record.input) }
    },
    ...(options.workflows !== undefined
      ? {
          loadWorkflow: async (ref: { name?: string; scriptPath?: string }) => {
            const script = ref.name !== undefined ? options.workflows?.[ref.name] : undefined
            return script === undefined
              ? { ok: false, message: `fake host：未保存的工作流 "${String(ref.name)}"` }
              : { ok: true, script }
          },
        }
      : {}),
  }
  return { host, agentCalls, resumeCalls, actionCalls }
}

let nextConversationId = 1000
const freshConversationId = (): number => ++nextConversationId

const jsonText = (value: unknown): string => JSON.stringify(value)

function agentOk(text: string, conversationId = freshConversationId()): WorkflowSpawnResult {
  return { ok: true, text, executionInfo: { conversationId } }
}

function withWorktree(
  result: WorkflowSpawnResult,
  worktree: { id: string; path: string; branch: string },
): WorkflowSpawnResult {
  const executionInfo: AgentExecutionInfo = {
    ...(result.executionInfo ?? {}),
    effectiveCwd: worktree.path,
    meta: { 'builtin:workflow': { worktree } },
  }
  return { ...result, executionInfo }
}

function withGate(result: WorkflowSpawnResult, ok: boolean, output = ''): WorkflowSpawnResult {
  return { ...result, gate: { ok, output } }
}

/** goal 调用的标准成功回包：JSON 文本（goal 输出恒为字符串）+ 工作树 + 门禁通过。 */
function goalJson(
  value: unknown,
  worktree?: { id: string; path: string; branch: string },
): WorkflowSpawnResult {
  const base = worktree !== undefined ? withWorktree(agentOk(jsonText(value)), worktree) : agentOk(jsonText(value))
  return withGate(base, true)
}

const agentFailed = (error: string): WorkflowSpawnResult => ({ ok: false, error })

function agentsOf(progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] {
  return progress.filter((e): e is WorkflowAgentEntry => e.type === 'workflow_agent')
}

function actionsOf(progress: readonly WorkflowEntry[]): WorkflowActionEntry[] {
  return progress.filter((e): e is WorkflowActionEntry => e.type === 'workflow_action')
}

const envExecResult = (ok: boolean, output: string) => ({ ok, exitCode: ok ? 0 : 1, output, timedOut: false })

const cleanupResult = (input: Record<string, unknown>) => ({
  removed: true,
  worktreeId: input.worktreeId,
  path: '/repo/wt/leaf',
  branch: 'helm/task',
  nodeId: 'local',
  branchDeleted: true,
})

const execOkActions = {
  'env.exec': (input: Record<string, unknown>) => {
    const command = String(input.command)
    if (command.includes('merge-base --is-ancestor')) return envExecResult(true, 'merge done')
    if (command.includes('pnpm test')) return envExecResult(true, 'module gate pass')
    throw new Error(`fake host：未预期的 env.exec 命令 "${command}"`)
  },
  'builtin:workflow.cleanup_worktree': cleanupResult,
}

// ---------------------------------------------------------------------------
// cross-review 示例
// ---------------------------------------------------------------------------

const DIMENSIONS = [
  { id: 'sec', title: '安全', instruction: '检查输入校验与机密处理' },
  { id: 'perf', title: '性能', instruction: '检查热点路径的性能风险' },
]

const finding = (id: string, claim: string) => ({
  id,
  severity: 'major',
  location: `src/${id}.ts:10`,
  claim,
  evidence: `依据：${id}`,
  suggestion: `建议：${id}`,
})

const planJson = (mode: string) => ({
  mode,
  targetSummary: '实现登录模块方案',
  authorInstruction: '编写实现方案（load_skill: api-design）',
  verifierInstruction: '对照源码与 AGENTS.md 剔除误报',
  checkDimensions: DIMENSIONS,
})

interface ReviewIssue {
  id: string
  dimension: string
  verdict: { rejected: boolean } | null
  verdictMissing: boolean
}

interface ReviewValue {
  passed: boolean
  result: string
  history: Array<{ round: number; confirmedCount: number; issues: ReviewIssue[] }>
}

describe('cross-review example', () => {
  it('create_and_refine closes the loop: first fix resumes author, false positives rejected, round 2 clean', timeout, async () => {
    const { host, agentCalls, resumeCalls } = makeHost({
      agents: {
        planner: () => agentOk(jsonText(planJson('create_and_refine'))),
        author: () => agentOk('方案草稿 v1'),
        'check-sec-r1': () => agentOk(jsonText({ findings: [finding('f1', '缺少输入校验'), finding('f2', '脱离上下文的问题')] })),
        'check-perf-r1': () => agentOk(jsonText({ findings: [] })),
        'verify-sec-f1-r1': () => agentOk(jsonText({ rejected: false, reason: '成立' })),
        'verify-sec-f2-r1': () => agentOk(jsonText({ rejected: true, reason: '误报' })),
        'check-sec-r2': () => agentOk(jsonText({ findings: [] })),
        'check-perf-r2': () => agentOk(jsonText({ findings: [] })),
      },
      resume: async () => agentOk('方案 v2'),
    })
    const result = await runWorkflow({
      script: example('cross-review'),
      args: { modelB: 'provider/b', modelC: 'provider/c', cwd: '/repo/app' },
      host,
    })
    assert.equal(result.status, 'completed', result.error)
    const value = result.value as ReviewValue
    assert.equal(value.passed, true)
    assert.equal(value.result, '方案 v2')
    assert.equal(value.history.length, 2)
    assert.equal(value.history[0]!.round, 1)
    assert.equal(value.history[0]!.confirmedCount, 1)
    const kept = value.history[0]!.issues[0]!
    assert.equal(kept.id, 'f1')
    assert.equal(kept.dimension, '安全')
    assert.equal(kept.verdictMissing, false)
    assert.equal(kept.verdict!.rejected, false)
    assert.ok(!value.history[0]!.issues.some((issue) => issue.id === 'f2'), '被驳回的误报不得进入修复清单')
    assert.equal(value.history[1]!.confirmedCount, 0)
    // create 模式：初稿后第 1 轮修复即续接同一 author 会话（不再 spawn）。
    const authorSpawns = agentCalls.filter((call) => call.label === 'author' && call.kind === 'spawn')
    assert.equal(authorSpawns.length, 1, 'author 只 spawn 一次（初稿）')
    assert.equal(resumeCalls.length, 1)
    assert.ok(resumeCalls[0]!.prompt.includes('f1'), '修复指令携带已确认问题')
    assert.ok(resumeCalls[0]!.prompt.includes('verdictMissing'), '修复指令说明存疑标记语义')
  })

  it('fix_in_place: failed verifier keeps the finding as verdictMissing instead of dropping it; first fix is a fresh spawn', timeout, async () => {
    const { host, agentCalls, resumeCalls } = makeHost({
      agents: {
        planner: () => agentOk(jsonText(planJson('fix_in_place'))),
        author: () => agentOk('修复后内容'),
        'check-sec-r1': () => agentOk(jsonText({ findings: [finding('f9', '并发写入竞态')] })),
        'check-perf-r1': () => agentOk(jsonText({ findings: [] })),
        'verify-sec-f9-r1': () => agentFailed('verifier offline'),
        'check-sec-r2': () => agentOk(jsonText({ findings: [] })),
        'check-perf-r2': () => agentOk(jsonText({ findings: [] })),
      },
    })
    const result = await runWorkflow({
      script: example('cross-review'),
      args: { modelB: 'provider/b', modelC: 'provider/c' },
      host,
    })
    assert.equal(result.status, 'completed', result.error)
    const value = result.value as ReviewValue
    assert.equal(value.passed, true)
    const round1 = value.history[0]!
    assert.equal(round1.confirmedCount, 1)
    assert.equal(round1.issues[0]!.id, 'f9')
    assert.equal(round1.issues[0]!.verdict, null)
    assert.equal(round1.issues[0]!.verdictMissing, true, '复核失败必须显式暴露为存疑，不得折叠成无问题')
    // fix_in_place 第 1 轮修复是新会话：可携带 model（与 resume 互斥不违规）。
    const authorSpawns = agentCalls.filter((call) => call.label === 'author' && call.kind === 'spawn')
    assert.equal(authorSpawns.length, 1)
    assert.equal(authorSpawns[0]!.model, 'provider/b')
    assert.equal(resumeCalls.length, 0)
  })

  it('review_only: a failed check dimension fails the run explicitly instead of masquerading as clean', timeout, async () => {
    const { host } = makeHost({
      agents: {
        planner: () => agentOk(jsonText(planJson('review_only'))),
        'check-sec-r1': () => agentFailed('agent exploded'),
        'check-perf-r1': () => agentOk(jsonText({ findings: [] })),
      },
    })
    const result = await runWorkflow({
      script: example('cross-review'),
      args: { modelB: 'provider/b', modelC: 'provider/c' },
      host,
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('存在执行失败的检查维度'), `error: ${result.error}`)
  })
})

// ---------------------------------------------------------------------------
// module-dev 示例
// ---------------------------------------------------------------------------

const MOD_ARGS = {
  moduleName: 'auth',
  moduleScope: 'packages/auth',
  archSpec: '共享接口约定 v1',
  modelB: 'provider/b',
  modelC: 'provider/c',
  gateCmd: 'pnpm test --filter auth',
}

const MOD_WT = { id: 'wt-mod', path: '/repo/wt/auth', branch: 'helm/mod-auth' }

const TASK_T1 = {
  id: 't1',
  title: '数据模型',
  files: ['packages/auth/model.ts'],
  instruction: '实现数据模型',
  testCmd: 'pnpm test model',
}
const TASK_T2 = {
  id: 't2',
  title: '路由',
  files: ['packages/auth/routes.ts'],
  instruction: '实现路由',
  testCmd: 'pnpm test routes',
  maxSubagentDepth: 3,
}

const taskAgents = {
  'task-t1': () => withGate(withWorktree(agentOk('task t1 done'), { id: 'wt-t1', path: '/repo/wt/auth-t1', branch: 'helm/task-t1' }), true),
  'task-t2': () => withGate(withWorktree(agentOk('task t2 done'), { id: 'wt-t2', path: '/repo/wt/auth-t2', branch: 'helm/task-t2' }), true),
}

describe('module-dev example', () => {
  it('parallel_tasks: streaming merge with idempotent command, mergedInto cleanup, and race-free phase attribution', timeout, async () => {
    const { host, agentCalls, actionCalls } = makeHost({
      agents: {
        plan: () => goalJson({ strategy: 'parallel_tasks', tasks: [TASK_T1, TASK_T2] }, MOD_WT),
        ...taskAgents,
      },
      actions: execOkActions,
    })
    const result = await runWorkflow({ script: example('module-dev'), args: MOD_ARGS, host })
    assert.equal(result.status, 'completed', result.error)
    assert.deepEqual(result.value, { moduleName: 'auth', branch: 'helm/mod-auth', worktreeId: 'wt-mod' })

    // 子任务 goal：从模块工作树切子级 worktree，深度按任务设置，超时齐备。
    const t1 = agentCalls.find((call) => call.label === 'task-t1')!
    assert.equal(t1.cwd, MOD_WT.path)
    assert.equal(t1.isolation, 'worktree')
    assert.equal(t1.model, 'provider/c')
    assert.equal(t1.maxSubagentDepth, 2)
    assert.equal(t1.timeoutMs, 300_000)
    assert.equal(t1.gateTimeoutMs, 120_000)
    assert.ok(t1.gate!.includes('pnpm test model'))
    assert.equal(agentCalls.find((call) => call.label === 'task-t2')!.maxSubagentDepth, 3)

    // 幂等合并命令：先检查已合入再合并；allowFailure 在 input 里。
    const merges = actionCalls.filter(
      (call) => call.actionId === 'env.exec' && String(call.input.command).includes('merge-base --is-ancestor'),
    )
    assert.equal(merges.length, 2)
    for (const merge of merges) {
      assert.equal(merge.input.allowFailure, true)
      assert.equal(merge.input.cwd, MOD_WT.path)
    }
    assert.ok(merges.some((merge) => String(merge.input.command).includes('"helm/task-t1"')))
    assert.ok(merges.some((merge) => String(merge.input.command).includes('"helm/task-t2"')))

    // 子工作树清理：带 mergedInto=模块分支，无需 force。
    const cleanups = actionCalls.filter((call) => call.actionId === 'builtin:workflow.cleanup_worktree')
    assert.deepEqual(
      cleanups.map((call) => call.input),
      [
        { worktreeId: 'wt-t1', mergedInto: 'helm/mod-auth', deleteBranch: true },
        { worktreeId: 'wt-t2', mergedInto: 'helm/mod-auth', deleteBranch: true },
      ],
    )

    // 阶段归属无竞态：任务节点稳定留在「执行开发」，合入节点全部「合入与清理」。
    const agents = agentsOf(result.progress)
    assert.ok(agents.filter((e) => e.label.startsWith('task-')).every((e) => e.phaseTitle === '执行开发'))
    const actions = actionsOf(result.progress)
    for (const label of ['merge-t1', 'merge-t2', 'cleanup-t1', 'cleanup-t2', 'module-gate']) {
      assert.equal(actions.find((e) => e.label === label)?.phaseTitle, '合入与清理', `action ${label} 阶段归属`)
    }
  })

  it('parallel_tasks: merge conflict and failed module gate are repaired by goal agents, not by silent pass', timeout, async () => {
    const { host, agentCalls } = makeHost({
      agents: {
        plan: () => goalJson({ strategy: 'parallel_tasks', tasks: [TASK_T1] }, MOD_WT),
        'task-t1': taskAgents['task-t1']!,
        'conflict-t1': () => withGate(agentOk('冲突已解决'), true),
        modfix: () => withGate(agentOk('模块修复完成'), true),
      },
      actions: {
        'env.exec': (input: Record<string, unknown>) => {
          const command = String(input.command)
          if (command.includes('merge-base --is-ancestor')) {
            return envExecResult(false, 'CONFLICT (content): Merge conflict in packages/auth/model.ts')
          }
          if (command === MOD_ARGS.gateCmd) return envExecResult(false, '2 tests failed')
          throw new Error(`fake host：未预期的 env.exec 命令 "${command}"`)
        },
        'builtin:workflow.cleanup_worktree': cleanupResult,
      },
    })
    const result = await runWorkflow({ script: example('module-dev'), args: MOD_ARGS, host })
    assert.equal(result.status, 'completed', result.error)
    const conflict = agentCalls.find((call) => call.label === 'conflict-t1')!
    assert.equal(conflict.model, 'provider/b')
    assert.equal(conflict.cwd, MOD_WT.path)
    assert.ok(conflict.gate!.includes('MERGE_HEAD'), '冲突修复门禁必须确认合并已完成')
    assert.ok(conflict.gate!.includes(MOD_ARGS.gateCmd))
    const modfix = agentCalls.find((call) => call.label === 'modfix')!
    assert.equal(modfix.model, 'provider/b')
    assert.equal(modfix.cwd, MOD_WT.path)
    assert.ok(modfix.prompt.includes('2 tests failed'))
  })

  it('parallel_tasks: overlapping task files are rejected explicitly', timeout, async () => {
    const { host } = makeHost({
      agents: {
        plan: () =>
          goalJson(
            {
              strategy: 'parallel_tasks',
              tasks: [
                { ...TASK_T1, files: ['packages/auth/model.ts', 'packages/auth/shared.ts'] },
                { ...TASK_T2, files: ['packages/auth/shared.ts'] },
              ],
            },
            MOD_WT,
          ),
      },
      actions: execOkActions,
    })
    const result = await runWorkflow({ script: example('module-dev'), args: MOD_ARGS, host })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('文件不得重叠'), `error: ${result.error}`)
    assert.ok(result.error!.includes('packages/auth/shared.ts'))
  })

  it('review_then_tasks: nested cross-review conclusions flow into the task objective', timeout, async () => {
    const { host, agentCalls } = makeHost({
      agents: {
        plan: () => goalJson({ strategy: 'review_then_tasks', tasks: [TASK_T1] }, MOD_WT),
        planner: () => agentOk(jsonText(planJson('create_and_refine'))),
        author: () => agentOk('方案：分两步完成'),
        'check-sec-r1': () => agentOk(jsonText({ findings: [] })),
        'check-perf-r1': () => agentOk(jsonText({ findings: [] })),
        'task-t1': taskAgents['task-t1']!,
      },
      actions: execOkActions,
      workflows: { 'cross-review': example('cross-review') },
    })
    const result = await runWorkflow({ script: example('module-dev'), args: MOD_ARGS, host })
    assert.equal(result.status, 'completed', result.error)
    const taskCall = agentCalls.find((call) => call.label === 'task-t1')!
    assert.ok(taskCall.prompt.includes('【模块实现方案】'), '子任务指令必须携带评审结论')
    assert.ok(taskCall.prompt.includes('方案：分两步完成'))
  })
})

// ---------------------------------------------------------------------------
// arch-master 示例
// ---------------------------------------------------------------------------

const ARCH_ARGS = {
  archSpec: '总体架构方案',
  modelB: 'provider/b',
  modelC: 'provider/c',
  finalGateCmd: 'pnpm check',
  modules: [{ name: 'auth', scope: 'packages/auth', gateCmd: 'pnpm test auth' }],
}

describe('arch-master example', () => {
  it('runs the real module-dev child workflow and repairs the failed full-repo gate via goal', timeout, async () => {
    const { host, agentCalls, actionCalls } = makeHost({
      agents: {
        'contract-first': () => withGate(agentOk('contract committed'), true),
        plan: () => goalJson({ strategy: 'direct', directInstruction: '实现登录' }, MOD_WT),
        'direct-impl': () => withGate(agentOk('direct done'), true),
        'root-final-fix': () => withGate(agentOk('全仓修复完成'), true),
      },
      actions: {
        'env.exec': (input: Record<string, unknown>) => {
          const command = String(input.command)
          if (command.includes('merge-base --is-ancestor')) return envExecResult(true, 'merge done')
          if (command === 'pnpm test auth') return envExecResult(true, 'module gate pass')
          if (command === 'pnpm check') return envExecResult(false, 'typecheck failed')
          throw new Error(`fake host：未预期的 env.exec 命令 "${command}"`)
        },
        'builtin:workflow.cleanup_worktree': cleanupResult,
      },
      workflows: { 'module-dev': example('module-dev') },
    })
    const result = await runWorkflow({
      script: example('arch-master'),
      args: { ...ARCH_ARGS, contractSpec: '更新共享接口定义' },
      host,
    })
    assert.equal(result.status, 'completed', result.error)
    assert.deepEqual(result.value, { status: 'completed', modules: ['auth'] })

    const contract = agentCalls.find((call) => call.label === 'contract-first')!
    assert.equal(contract.model, 'provider/b')
    assert.equal(contract.gate, 'pnpm typecheck && test -z "$(git status --porcelain)"')
    const direct = agentCalls.find((call) => call.label === 'direct-impl')!
    assert.equal(direct.cwd, MOD_WT.path)
    assert.equal(direct.model, 'provider/c')
    const finalFix = agentCalls.find((call) => call.label === 'root-final-fix')!
    assert.equal(finalFix.model, 'provider/b')
    assert.ok(finalFix.prompt.includes('typecheck failed'))
    assert.ok(finalFix.gate!.includes('pnpm check'))

    // 主干幂等合并 + 清理（mergedInto=HEAD，删分支）。
    const merge = actionCalls.find(
      (call) => call.actionId === 'env.exec' && String(call.input.command).includes('merge-base --is-ancestor'),
    )!
    assert.ok(String(merge.input.command).includes('"helm/mod-auth"'))
    const cleanup = actionCalls.find((call) => call.actionId === 'builtin:workflow.cleanup_worktree')!
    assert.deepEqual(cleanup.input, { worktreeId: 'wt-mod', mergedInto: 'HEAD', deleteBranch: true })
  })

  it('repairs a root merge conflict via goal before cleanup', timeout, async () => {
    const { host, agentCalls } = makeHost({
      agents: {
        plan: () => goalJson({ strategy: 'direct', directInstruction: '实现登录' }, MOD_WT),
        'direct-impl': () => withGate(agentOk('direct done'), true),
        'root-conflict-auth': () => withGate(agentOk('主干冲突已解决'), true),
      },
      actions: {
        'env.exec': (input: Record<string, unknown>) => {
          const command = String(input.command)
          if (command.includes('merge-base --is-ancestor')) {
            return envExecResult(false, 'CONFLICT (content): Merge conflict in packages/auth/model.ts')
          }
          if (command === 'pnpm test auth') return envExecResult(true, 'module gate pass')
          if (command === 'pnpm check') return envExecResult(true, 'all green')
          throw new Error(`fake host：未预期的 env.exec 命令 "${command}"`)
        },
        'builtin:workflow.cleanup_worktree': cleanupResult,
      },
      workflows: { 'module-dev': example('module-dev') },
    })
    const result = await runWorkflow({ script: example('arch-master'), args: ARCH_ARGS, host })
    assert.equal(result.status, 'completed', result.error)
    assert.deepEqual(result.value, { status: 'completed', modules: ['auth'] })
    const conflict = agentCalls.find((call) => call.label === 'root-conflict-auth')!
    assert.equal(conflict.model, 'provider/b')
    assert.ok(conflict.gate!.includes('MERGE_HEAD'))
    assert.ok(conflict.prompt.includes('CONFLICT'))
  })

  it('fails explicitly when a module child workflow fails (parallel null is not completion)', timeout, async () => {
    const { host } = makeHost({
      agents: {
        // 非法 strategy：module-dev 的 schema 校验失败 → 子工作流抛错 → parallel 折为 null。
        plan: () => goalJson({ strategy: 'bogus' }, MOD_WT),
      },
      actions: execOkActions,
      workflows: { 'module-dev': example('module-dev') },
    })
    const result = await runWorkflow({ script: example('arch-master'), args: ARCH_ARGS, host })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('存在未完成的模块子工作流'), `error: ${result.error}`)
  })
})
