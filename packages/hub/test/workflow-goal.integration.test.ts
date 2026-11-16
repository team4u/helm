/**
 * many level workflow and failed automatically retry design verify (T2/T3) integration test.
 *
 * for should docs/archive/20261115-many level workflow and failed automatically retry design document.md:
 *
 * T2(goal failed automatically retry, real all link):
 * - true createHelm + true KernelRuntime + faux provider + true WorkflowService(via
 *   builtin:workflow  run action, and HTTP/CLI same link)+ true WorktreeAllocator
 *   isolated tree;gate by kernel settleGate → runGate → runShell real execute, timeout kill whole
 *   process group (do not mock core timeout).
 * - goal({ label: 'worker-c', isolation: 'worktree', maxAttempts: 3,
 *   gateTimeoutMs: 1000 }): 1 time gate suspended 6s(by 1s process group timeout strong kill),
 *    2 time gate exitCode=1, 3 time succeeded.
 * - assertion: three time attempt shared use the same conversationId and the same worktree(path/branch/id
 *   consistent, all process only derive a sub-conversation); ledger one by one time record gate.timedOut / gate.exitCode
 *   and execution; eventually ok: true, attempts: 3; by kill gate process in escape window inside not
 *   write out store mark record (process group kill real takes effect, non- only placement flag).
 *
 * T3(three level embed set same name label + resumeFromRunId checkpoint continue run, real engine):
 * - total control → module sub- workflow → module inside two concurrency same name 'plan' node (agent.withMeta and
 *   goal(worktree)), another module again use same name 'plan'(three same name label conversation in the same
 *   run inside shared store, by scopeId isolated).
 * - module A:goal + idempotent git merge(idempotent: true)+ cleanup_worktree
 *   all succeeded; module B:goal because Schema validation failed exhausted 2 time attempt, script throw
 *   leads to Run failed, restore after along the same conversation continue 3 time attempt.
 * - fix faux model response after run({ resumeFromRunId }): module A all agent(contains
 *   withMeta  execution.worktree) and action hit ledger cache (cached: true,
 *   side effect counter zero new increase), only module B failed node live heavy run and eventually completed;
 *   B side resume('plan') resume is B itself sub-conversation (by conversation transcript verify based on
 *   core verify, same name label must not string to A side conversation).
 * - total control concurrency start A/B,A internal again concurrency goal and leaf workflow; restore when cache node
 *   i.e. when return also must not let succeeded module re- execute model, merge or clean up.
 *
 * honest discipline: true SQLite + true pi-durable + true Git repository + true file ledger;faux
 * provider only by transcript mark record routing script model response, do not fabricate engine/kernel result.
 * gate command unify node single row script (across platform); self create child process only by kernel runShell by enter
 * process group manage, test itself do not spawn extra process.
 *
 * runner: tsx --test; each test explicit timeout: 60_000 guard against deadlock.
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGitTemplate,
  createHubTestApp,
  sleep,
  type FauxProviderHandle,
  type GitTemplate,
  type HubTestApp,
} from './helpers/hub-test-env.js'

/** process occupy scan when before only Linux /proc(and worktree-runtime integration test same style platform fact). */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** model request routing: by transcript decide response; cannot routing when throws (not silently fall back). */
type ModelRoute = (context: {
  texts: string[]
  afterToolResult: boolean
}) => AssistantMessage | undefined

/** extract all user text (string body text and text chunk). */
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

/** most near a message is otherwise is tool result (turn inside tool execute done, model by again invoke). */
function endsWithToolResult(context: TranscriptContext): boolean {
  const last = context.messages.at(-1)
  if (last === undefined) return false
  return JSON.stringify(last).includes('"toolResult"')
}

/** group install faux response step (the same routing function duplicate occupy, by request i.e. when routing). */
function routedResponses(route: ModelRoute, count: number) {
  const step = (context: TranscriptContext): AssistantMessage => {
    const message = route({ texts: userTextsOf(context), afterToolResult: endsWithToolResult(context) })
    if (message === undefined) {
      throw new Error(`faux routing missed: most near user text ${(userTextsOf(context).at(-1) ?? '(without)').slice(0, 200)}`)
    }
    return message
  }
  return Array.from({ length: count }, () => step)
}

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-workflow-goal-'))
  gitTemplate = createGitTemplate('helm-workflow-goal-tpl-')
})

after(() => {
  gitTemplate?.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
})

interface RuntimeEnv {
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  conversationId: number
  /** builtin:workflow public action total line (HTTP/CLI/model tool same link). */
  runWorkflowAction(request: Record<string, unknown>): Promise<{ run: Record<string, any> }>
  inspectRun(runId: string): Promise<Record<string, any>>
  saveWorkflow(script: string): Promise<void>
  close(): Promise<void>
}

/** real createHelm(builtin:workflow by default enable)+ faux provider;cwd points to real Git repository. */
async function openRuntime(dataDir: string, repoDir: string): Promise<RuntimeEnv> {
  const { app, kernel, faux } = await createHubTestApp({
    dataDir,
    cwd: repoDir,
  })
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

/** read run real ledger file (plugin data directory plugins/builtin%3Aworkflow/artifacts/<convId>/workflow-<runId>.jsonl). */
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

/** recursion find same name file (process escape mark record troubleshoot). */
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
// T2:goal failed automatically retry (real KernelRuntime + worktree isolated + real gate timeout)
// ---------------------------------------------------------------------------

describe('T2 goal gate failed automatically retry (true kernel/faux/WorkflowService/worktree)', { timeout: 60_000 }, () => {
  it('three time attempt same conversation same worktree:gate timeout strong kill / exit 1 / succeeded,attempts=3', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)

    // gate script (gate in worktree inside execute, by mark record file decide behavior):
    // - only attempt-1: suspended 6 second (exceeds gateTimeoutMs=1000, should by process group timeout kill;
    //   if kill expires,6s after write out escape mark record gate-1-escaped.txt and with 0 exit)
    // - attempt-2 store in:exit 1
    // - attempt-3 store in:exit 0
    const gateCommand =
      'node -e "const fs=require(\'fs\');' +
      "if(fs.existsSync('attempt-3.txt'))process.exit(0);" +
      "if(fs.existsSync('attempt-2.txt'))process.exit(1);" +
      "setTimeout(function(){fs.writeFileSync('gate-1-escaped.txt','alive')},6000)" +
      '"'
    const script =
      'export const meta = { name: "t2-goal-retry", description: "goal gate three state retry verify" }\n' +
      'const result = await goal({\n' +
      '  label: "worker-c",\n' +
      '  objective: "T2-GOAL-OBJECTIVE: in isolated worktree inside complete commit and via gate",\n' +
      '  isolation: "worktree",\n' +
      `  gate: ${JSON.stringify(gateCommand)},\n` +
      '  gateTimeoutMs: 1000,\n' +
      '  maxAttempts: 3,\n' +
      '})\n' +
      'return result\n'

    // faux model routing: each time attempt first use bash write attempt-N.txt mark record, again back text;
    // when before attempt ordinal by transcript in [attempt N failed] incremental chunk decide.
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

      // ---- eventually result: 3 time attempt succeeded,attempts=3, back pass execute metadata.----
      assert.equal(run.status, 'completed', JSON.stringify(run.error))
      assert.equal(run.result.ok, true)
      assert.equal(run.result.attempts, 3)
      assert.equal(run.result.output, 'T2-A3-DONE')
      assert.ok(run.result.execution, 'goal result should back pass execution metadata')
      assert.equal(run.result.execution.conversationId > env.conversationId, true, 'should derive sub-conversation')
      const worktree = run.result.execution.worktree
      assert.ok(worktree, 'isolation:worktree should back pass worktree metadata')
      assert.ok(worktree.path.includes(join(dir, '.helm-worktrees')), `worktree should at same level .helm-worktrees:${worktree.path}`)
      assert.ok(worktree.branch.startsWith('helm/spawn-'), `branch should be helm/spawn-*:${worktree.branch}`)
      assert.ok(typeof worktree.id === 'string' && worktree.id.length > 0, 'should back pass managed worktreeId')
      assert.equal(run.result.gate.ok, true, ' 3 time gate should via')

      // ---- all process only derive a sub-conversation: three time attempt resume the same conversation.----
      const children = env.kernel
        .listConversations()
        .filter((c) => c.parentConversationId === env.conversationId)
      assert.equal(children.length, 1, `should only a sub-conversation, got ${children.length}`)
      assert.equal(children[0]!.id, run.result.execution.conversationId)
      assert.equal(children[0]!.cwd, worktree.path, 'sub-conversation cwd should be isolated worktree')

      // ---- real ledger: three time attempt one by one account,gate result and execute metadata complete.----
      const entries = readJournal(dataDir, env.conversationId, run.id).filter((e) => e['type'] === 'agent')
      assert.equal(entries.length, 3, `ledger should has 3  agent attempt record, got ${entries.length}`)
      const [first, second, third] = entries as [
        Record<string, any>,
        Record<string, any>,
        Record<string, any>,
      ]
      assert.deepEqual(
        entries.map((e) => [e['index'], e['attempt'], e['ok']]),
        [[0, 1, false], [1, 2, false], [2, 3, true]],
        `attempt ledger should by index/attempt/ok account:${JSON.stringify(entries.map((e) => ({ i: e['index'], a: e['attempt'], ok: e['ok'] })))}`,
      )
      //  1 time: gate 1s process group timeout strong kill (real runShell timeout path).
      assert.equal(first['timedOut'], true, 'original generate gate timeout also should mark record this time attempt timedOut')
      assert.equal(first['gate'].ok, false)
      assert.equal(first['gate'].timedOut, true, ' 1 time gate should such as back pass timedOut=true')
      assert.equal(first['gate'].exitCode, null, 'by kill process without exit code, should be null')
      //  2 time: gate exit code 1.
      assert.equal(second['gate'].ok, false)
      assert.equal(second['gate'].exitCode, 1, ' 2 time gate should back pass exitCode=1')
      assert.equal(second['gate'].timedOut, false)
      assert.equal(second['resumed'], true, ' 2 time attempt should is resume (resumed mark record)')
      //  3 time: succeeded and still mark record resume.
      assert.equal(third['ok'], true)
      assert.equal(third['attempt'], 3)
      assert.equal(third['resumed'], true)

      // ---- same conversationId / same worktree(path,branch,id three time consistent).----
      for (const entry of entries) {
        assert.equal(entry['execution'].conversationId, run.result.execution.conversationId)
        assert.equal(entry['execution'].worktree.path, worktree.path)
        assert.equal(entry['execution'].worktree.branch, worktree.branch)
        assert.equal(entry['execution'].worktree.id, worktree.id)
      }
      // three time attempt mark record file all in the same worktree inside (attempt indeed in the same tree in execute).
      for (const n of [1, 2, 3]) {
        assert.ok(existsSync(join(worktree.path, `attempt-${n}.txt`)), `attempt-${n}.txt should store in at the same worktree`)
      }
      assert.ok(existsSync(worktree.path), 'retry all process keep the same worktree(failed do not reclaim)')

      // ---- process group kill real: suspended gate if not by kill,6s after will write out escape mark record;
      // and the whole run will by drag to 6s or more.----
      const goalNode = (run.nodes ?? []).find((n: Record<string, any>) => n['label'] === 'worker-c')
      assert.ok(goalNode, 'should store in label worker-c  agent node')
      assert.equal(goalNode!['status'], 'done')
      assert.equal(goalNode!['conversationId'], run.result.execution.conversationId)
      assert.ok(
        typeof run['updatedAt'] === 'number' && typeof run['createdAt'] === 'number',
        'run summary should carry createdAt/updatedAt',
      )
      assert.ok(
        run['updatedAt'] - run['createdAt'] < 5_800,
        `the whole run use when ${run['updatedAt'] - run['createdAt']}ms should less than 5.8s suspended floor (gate by 1s process group timeout terminate)`,
      )
      const escaped = findFileRecursive(dir, 'gate-1-escaped.txt')
      if (escaped.length > 0) {
        // already exists i.e. immediately failed (fast at escape window guard against defend branch).
        assert.fail(`gate process escape (not by process group kill die):${escaped.join(', ')}`)
      }
      while (Date.now() - startedAt < 6_200) await sleep(100)
      assert.deepEqual(
        findFileRecursive(dir, 'gate-1-escaped.txt'),
        [],
        'by kill gate process in 6s escape window after must not write out store mark record (process group kill real takes effect)',
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3: three level embed set same name label + resumeFromRunId checkpoint continue run
// ---------------------------------------------------------------------------

describe('T3 three level embed set same name plan and resumeFromRunId checkpoint continue run', { timeout: 60_000 }, () => {
  it('module A all cache re- use, only module B failed node live heavy run, metadata complete restore', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)
    const signalPath = join(repo, 'b-open-gate.txt')
    // module B  plan can switch failed/succeeded (fix simulated model response after resume).
    const state = { modB: 'fail' as 'fail' | 'ok' }

    // ---- faux routing: by most near user text mark record dispatch;MODB-FIX first at MODB-PLAN(its
    // transcript also contains two mark record).----
    const route: ModelRoute = ({ texts, afterToolResult }) => {
      const last = texts.at(-1) ?? ''
      const has = (marker: string) => texts.some((t) => t.includes(marker))
      if (has('MODB-FIX-OBJECTIVE')) {
        // scopeId isolated core verify:B  resume('plan') must in B itself plan conversation - -
        // transcript contains B plan mark record and excludes A side same name label conversation content.
        if (!has('MODB-PLAN-OBJECTIVE') || has('MODA-GOAL-OBJECTIVE') || has('SUBA-PLAN-OBJECTIVE')) {
          throw new Error(
            `resume('plan') resume error conversation (scope isolated break):transcript mark record ${JSON.stringify(texts.map((t) => t.slice(0, 60)))}`,
          )
        }
        return fauxAssistantMessage('B-FIX-OK')
      }
      if (has('MODB-PLAN-OBJECTIVE')) {
        return state.modB === 'fail'
          ? fauxAssistantMessage('this is not legal JSON')
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

    // ---- three level script: total control (inline)→ module t3-mod-a / t3-mod-b → leaf t3-sub-a.----
    // module A internal parallel bear load same name 'plan' true concurrency (goal and leaf sub- workflow);
    // total control also concurrency start two module, verify restore when independent scope cache invoke still can hit.
    const goalGate = 'node -e "process.exit(require(\'fs\').existsSync(\'mod-a-done.txt\')?0:1)"'
    // signal action append write one row, concurrent act side effect counter - -resume must not append second row.
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
      'export const meta = { name: "t3-sub-a", description: "three level embed set leaf:agent.withMeta same name plan" }\n' +
      'const r = await agent.withMeta("SUBA-PLAN-OBJECTIVE: directly answer task summary", { label: "plan" })\n' +
      'if (!r.ok) throw new Error("t3-sub-a failed: " + r.error)\n' +
      'return r\n'

    const modAScript =
      'export const meta = { name: "t3-mod-a", description: "moduleA: concurrency same name plan(goal+leaf)+ idempotent together and clean up" }\n' +
      'const pair = await parallel([\n' +
      '  () => workflow("t3-sub-a", {}),\n' +
      '  () => goal({\n' +
      '    label: "plan",\n' +
      '    objective: "MODA-GOAL-OBJECTIVE: write mod-a-done.txt and commit to when before branch",\n' +
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
      'export const meta = { name: "t3-mod-b", description: "moduleB: same name plan goal exhausted after restore" }\n' +
      'const result = await goal({ objective: "MODB-PLAN-OBJECTIVE: by Schema return answer proposal", label: "plan", maxAttempts: 2, schema: ' +
      JSON.stringify(planSchema) +
      ' })\n' +
      'if (!result.ok) throw new Error("mod-b plan goal failed (schema)")\n' +
      'const plan = JSON.parse(result.output)\n' +
      'const fix = await agent("MODB-FIX-OBJECTIVE: confirm already resume this module plan conversation", { resume: "plan" })\n' +
      'return { plan, fix, attempts: result.attempts }\n'

    const masterScript =
      'export const meta = { name: "t3-master", description: "total control: two same name plan module concurrency start" }\n' +
      'const pair = await parallel([\n' +
      '  () => workflow("t3-mod-a", args),\n' +
      '  () => workflow("t3-mod-b", args),\n' +
      '])\n' +
      'const a = pair[0]\n' +
      'const b = pair[1]\n' +
      'if (!a) throw new Error("module A workflow failed")\n' +
      'if (!b) throw new Error("module B workflow failed")\n' +
      'return { a, b }\n'

    try {
      // ---- save three sub- workflow define (real save action + meta.name naming).----
      for (const script of [subAScript, modAScript, modBScript]) {
        await env.saveWorkflow(script)
      }

      const runArgs = { repoDir: repo, linux: PROCESS_SCAN_ON }

      // ----  1 time run: module B  plan goal exhausted attempt → run failed.----
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
          assert.ok(error instanceof HelmError, `should be HelmError, got ${String(error)}`)
          assert.equal(error.code, 'workflow_failed')
          const details = error.details as { runId?: string } | undefined
          assert.ok(typeof details?.runId === 'string', 'failed detail situation should carry runId')
          failedRunId = details!.runId!
          return true
        },
      )
      const failed = (await env.inspectRun(failedRunId)).run
      assert.equal(failed.status, 'failed')
      assert.match(String(failed.error), /module B workflow failed/, `concurrency module B failed should by total control explicit report:${failed.error}`)
      assert.doesNotMatch(String(failed.error), /module A workflow failed/, `module A must not first at module B report failed:${failed.error}`)

      //  1 time ledger: module A all succeeded; module B  plan failed but keep execute metadata.
      const journal1 = readJournal(dataDir, env.conversationId, failedRunId)
      const agentEntries = journal1.filter((e) => e['type'] === 'agent')
      const goalEntry = agentEntries.find(
        (e) => e['ok'] === true && e['execution']?.['worktree']?.['branch']?.startsWith('helm/spawn-'),
      )
      assert.ok(goalEntry, 'module A  goal should succeeded and account worktree metadata')
      const failedPlan = agentEntries.find((e) => e['ok'] === false)
      assert.ok(failedPlan, 'module B  plan failed should account')
      assert.equal(failedPlan!['attempt'], 1)
      assert.ok(
        typeof failedPlan!['execution']?.['conversationId'] === 'number',
        'failed attempt should keep conversationId(failed do not discard execute metadata)',
      )
      const actionEntries = journal1.filter((e) => e['type'] === 'action')
      // action ledger row excludes label(by index/key account); amount, succeeded and idempotent mark record and
      // each action real side effect verify based on (signal counter/git log/branch delete) jointly lock verify.
      assert.equal(
        actionEntries.length,
        PROCESS_SCAN_ON ? 3 : 2,
        `should account merge-a${PROCESS_SCAN_ON ? '/cleanup-a' : ''}/signal-b, got ${actionEntries.length}`,
      )
      for (const entry of actionEntries) {
        assert.equal(entry['ok'], true, `action should all succeeded:${JSON.stringify(entry)}`)
        assert.equal(entry['idempotent'], true, 'all action should explicit mark record idempotent')
      }
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', 'module A signal action should exactly execute once')

      // real side effect: merge commit already in main; isolated tree already clean up.
      const logText = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.match(logText, /feat: mod-a/, 'module branch should real together main')
      if (PROCESS_SCAN_ON) {
        const goalBranch = goalEntry!['execution']['worktree']['branch'] as string
        const branchList = execFileSync('git', ['branch', '--list', goalBranch], { cwd: repo, encoding: 'utf8' })
        assert.equal(branchList.trim(), '', 'cleanup(deleteBranch) after module branch should by delete')
      }
      const failedPlanConversationId = failedPlan!['execution']['conversationId'] as number
      // same name 'plan' three conversation shared store mutual do not confuse:goal / leaf / module B each independent sub-conversation.
      assert.equal(agentEntries.filter(e => e['ok'] === false).length, 2, 'module B should exhausted two time attempt')
      const planConversationIds = agentEntries
        .filter(e => (e['attempt'] ?? 1) === 1)
        .map((e) => e['execution']?.['conversationId'])
        .filter((id) => typeof id === 'number')
      assert.equal(
        new Set(planConversationIds).size,
        planConversationIds.length,
        `same name plan three conversation should mutual do not identical:${JSON.stringify(planConversationIds)}`,
      )

      // ---- fix simulated model response after checkpoint continue run: only failed node live, the rest all cache.----
      state.modB = 'ok'
      env.faux.setResponses(routedResponses(route, 24))
      const { run: resumed } = await env.runWorkflowAction({
        resumeFromRunId: failedRunId,
        conversationId: env.conversationId,
        wait: true,
      })
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error))
      assert.equal(resumed.replayedFrom, failedRunId, 'continue run run should mark record replayedFrom')

      // module A value complete restore (withMeta metadata from ledger cache rebuild).
      const a = resumed.result.a
      assert.ok(a, 'module A result should store in')
      assert.equal(a.sub.ok, true)
      assert.equal(a.sub.output, 'SUBA-OK')
      assert.equal(a.goal.ok, true)
      assert.equal(a.goal.attempts, 1)
      assert.equal(a.goal.output, 'A-GOAL-DONE')
      assert.ok(a.goal.execution.worktree, 'goal  execution.worktree should from cache restore')
      assert.equal(a.goal.execution.worktree.branch, goalEntry!['execution']['worktree']['branch'])
      assert.equal(a.goal.execution.worktree.id, goalEntry!['execution']['worktree']['id'])
      assert.equal(a.goal.execution.worktree.path, goalEntry!['execution']['worktree']['path'])
      assert.equal(a.mergeOk, true)
      assert.equal(a.cleaned, PROCESS_SCAN_ON ? true : null)

      // module B: along original failed goal conversation resume,fix still resume B itself plan.
      const b = resumed.result.b
      assert.deepEqual(b.plan, { answer: 'b-plan-ok' })
      assert.equal(b.fix, 'B-FIX-OK')
      assert.equal(b.attempts, 3, 'restore round should in two time history failed after continue 3 time attempt')

      // side effect zero duplicate: signal counter keep one row; together commit does not repeat.
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', 'resume must not repeat execution module A idempotent action')
      const logText2 = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.equal((logText2.match(/feat: mod-a/g) ?? []).length, 1, 'merge action must not repeat execution')

      // node level core verify: module A node all cached; only module B  plan/fix live.
      const nodes = (resumed.nodes ?? []) as Array<Record<string, any>>
      const agentNodes = nodes.filter((n) => n['kind'] === 'agent' || String(n['id']).startsWith('agent-'))
      const liveAgentNodes = agentNodes.filter((n) => n['cached'] !== true)
      assert.equal(liveAgentNodes.length, 2, `should exactly has 2  live agent node (B  plan and fix), got ${JSON.stringify(liveAgentNodes.map((n) => ({ id: n['id'], label: n['label'] })))}`)
      const livePlan = liveAgentNodes.find((n) => n['label'] === 'plan')
      assert.ok(livePlan, 'live heavy run failed node should keep label plan')
      assert.ok(
        livePlan!['conversationId'] === failedPlanConversationId,
        'failed goal should resume original generate conversation, do not and A side same name plan confuse',
      )
      const cachedAgentNodes = agentNodes.filter((n) => n['cached'] === true)
      assert.equal(cachedAgentNodes.length, 2, 'module A  sub-a plan and goal two agent node should all hit cache')
      const actionNodes = nodes.filter((n) => String(n['id']).startsWith('action-'))
      assert.ok(actionNodes.length >= 3, 'action node should appear in enter tree')
      assert.ok(actionNodes.every((n) => n['cached'] === true), 'all action node should hit cache (zero side effect replay)')
    } finally {
      await env.close()
    }
  })
})
