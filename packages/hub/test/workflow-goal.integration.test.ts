/**
 * Integration tests verifying multi-level workflows and automatic failure retries (T2 / T3).
 *
 * Covers the multi-level workflow & retry design:
 *
 * T2 (automatic goal failure retries, full real stack):
 * - Real `createHelm` + real `KernelRuntime` + faux provider + real `WorkflowService` (via `builtin:workflow`
 *   `run` action, same path as HTTP/CLI) + real `WorktreeAllocator`; gates run via `settleGate -> runGate -> runShell`
 *   with full process-group kill on timeout (never mocking kernel timeouts).
 * - `goal({ label: 'worker-c', isolation: 'worktree', maxAttempts: 3, gateTimeoutMs: 1000 })`:
 *   attempt 1 hangs 6s (killed at 1s by process-group timeout), attempt 2 exits 1, attempt 3 succeeds.
 * - Asserts: all 3 attempts reuse the same `conversationId` and worktree (`path`/`branch`/`id` identical,
 *   spawning only one child conversation overall); journal records `gate.timedOut`/`gate.exitCode` and
 *   `execution` per attempt; final `ok: true, attempts: 3`; killed gate process never writes its escape marker
 *   within the escape window (proving process-group kill actually terminated it).
 *
 * T3 (3-level nested identical labels + `resumeFromRunId` checkpoint resume, real engine):
 * - Master -> module sub-workflows -> module A runs two concurrent `'plan'` nodes (`agent.withMeta` and
 *   `goal(worktree)`), module B also uses `'plan'` (three `'plan'` conversations coexist in one run, isolated by `scopeId`).
 * - Module A: `goal` + idempotent git merge (`idempotent: true`) + `cleanup_worktree` all succeed; module B:
 *   `goal` exhausts 2 attempts on schema validation failure, throwing and failing the run, then resumes along
 *   the same conversation on attempt 3 after fixing the model response.
 * - `run({ resumeFromRunId })` after fixing the faux response: all of module A's agents (including `withMeta`
 *   `execution.worktree`) and actions hit the journal cache (`cached: true`, zero side-effect increments); only
 *   module B's failed nodes re-run live and complete; B's `resume('plan')` resumes B's own conversation
 *   (verified via conversation transcript, never bleeding into A's same-named conversation).
 *
 * Honesty discipline: real SQLite + real `pi-durable` + real Git repo + real file journal; faux provider
 * routes scripted replies solely by transcript markers without fabricating engine/kernel results.
 * Gate commands use cross-platform Node one-liners managed by kernel `runShell` process groups.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }`.
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

/** Process occupancy scan currently only supports Linux `/proc` (matching `worktree-runtime` platform behavior). */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** Model request router: selects response from transcript; throws on miss instead of silently falling back. */
type ModelRoute = (context: {
  texts: string[]
  afterToolResult: boolean
}) => AssistantMessage | undefined

/** Extracts all user text (plain strings and text blocks). */
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

/** Returns true when the most recent message is a tool result (tool finished, model re-invoked). */
function endsWithToolResult(context: TranscriptContext): boolean {
  const last = context.messages.at(-1)
  if (last === undefined) return false
  return JSON.stringify(last).includes('"toolResult"')
}

/** Builds a batch of identical routed faux response steps (each step routes on demand by request transcript). */
function routedResponses(route: ModelRoute, count: number) {
  const step = (context: TranscriptContext): AssistantMessage => {
    const message = route({ texts: userTextsOf(context), afterToolResult: endsWithToolResult(context) })
    if (message === undefined) {
      throw new Error(`faux route missed: last user text ${(userTextsOf(context).at(-1) ?? '(none)').slice(0, 200)}`)
    }
    return message
  }
  return Array.from({ length: count }, () => step)
}

// ---------------------------------------------------------------------------
// Test fixtures
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
  /** Entry point to `builtin:workflow` public actions (same path as HTTP/CLI/model tool). */
  runWorkflowAction(request: Record<string, unknown>): Promise<{ run: Record<string, any> }>
  inspectRun(runId: string): Promise<Record<string, any>>
  saveWorkflow(script: string): Promise<void>
  close(): Promise<void>
}

/** Opens a real `createHelm` (`builtin:workflow` enabled by default) + faux provider rooted at a real Git repo. */
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

/** Reads the run's real journal file (`plugins/builtin%3Aworkflow/artifacts/<convId>/workflow-<runId>.jsonl`). */
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

/** Recursively searches for files matching `name` (to detect escaped background processes). */
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
// T2: Automatic goal retry on failure (real KernelRuntime + worktree isolation + real gate timeout)
// ---------------------------------------------------------------------------

describe('T2 goal gate automatic retry (real kernel / faux / WorkflowService / worktree)', { timeout: 60_000 }, () => {
  it('reuses same conversation and worktree across 3 attempts: gate timeout kill / exit 1 / success, attempts=3', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)

    // Gate script (runs inside the worktree; behavior controlled by marker files):
    // - attempt 1 only: sleeps 10s (exceeds gateTimeoutMs=1000, killed via process-group timeout;
    //   if kill fails, writes escape marker `gate-1-escaped.txt` after 10s and exits 0)
    // - attempt 2 present: exits 1
    // - attempt 3 present: exits 0
    const gateCommand =
      'node -e "const fs=require(\'fs\');' +
      "if(fs.existsSync('attempt-3.txt'))process.exit(0);" +
      "if(fs.existsSync('attempt-2.txt'))process.exit(1);" +
      "setTimeout(function(){fs.writeFileSync('gate-1-escaped.txt','alive')},10000)" +
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

    // Faux model routing: each attempt first writes `attempt-N.txt` via bash, then replies with text;
    // attempt number is determined from `[attempt N failed]` retry feedback in the transcript.
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

      // ---- Final result: succeeds on attempt 3, attempts=3, returns execution metadata. ----
      assert.equal(run.status, 'completed', JSON.stringify(run.error))
      assert.equal(run.result.ok, true)
      assert.equal(run.result.attempts, 3)
      assert.equal(run.result.output, 'T2-A3-DONE')
      assert.ok(run.result.execution, 'goal result should return execution metadata')
      assert.equal(run.result.execution.conversationId > env.conversationId, true, 'should spawn child conversation')
      const worktree = run.result.execution.worktree
      assert.ok(worktree, 'isolation:worktree should return worktree metadata')
      assert.ok(worktree.path.includes(join(dir, '.helm-worktrees')), `worktree should be under sibling .helm-worktrees: ${worktree.path}`)
      assert.ok(worktree.branch.startsWith('helm/spawn-'), `branch should start with helm/spawn-: ${worktree.branch}`)
      assert.ok(typeof worktree.id === 'string' && worktree.id.length > 0, 'should return managed worktreeId')
      assert.equal(run.result.gate.ok, true, '3rd-attempt gate should pass')

      // ---- Exactly one child conversation spawned overall; all 3 attempts resume it. ----
      const children = env.kernel
        .listConversations()
        .filter((c) => c.parentConversationId === env.conversationId)
      assert.equal(children.length, 1, `should have exactly one child conversation, got ${children.length}`)
      assert.equal(children[0]!.id, run.result.execution.conversationId)
      assert.equal(children[0]!.cwd, worktree.path, 'child conversation cwd should be the isolated worktree')

      // ---- Real journal: all 3 attempts recorded with complete gate results and execution metadata. ----
      const entries = readJournal(dataDir, env.conversationId, run.id).filter((e) => e['type'] === 'agent')
      assert.equal(entries.length, 3, `journal should have 3 agent attempt records, got ${entries.length}`)
      const [first, second, third] = entries as [
        Record<string, any>,
        Record<string, any>,
        Record<string, any>,
      ]
      assert.deepEqual(
        entries.map((e) => [e['index'], e['attempt'], e['ok']]),
        [[0, 1, false], [1, 2, false], [2, 3, true]],
        `attempt journal should record index/attempt/ok: ${JSON.stringify(entries.map((e) => ({ i: e['index'], a: e['attempt'], ok: e['ok'] })))}`,
      )
      // Attempt 1: gate killed by 1s process-group timeout (real runShell timeout path).
      assert.equal(first['timedOut'], true, 'native gate timeout should also mark the attempt timedOut')
      assert.equal(first['gate'].ok, false)
      assert.equal(first['gate'].timedOut, true, '1st gate should report timedOut=true')
      assert.equal(first['gate'].exitCode, null, 'killed process has null exitCode')
      // Attempt 2: gate exits with code 1.
      assert.equal(second['gate'].ok, false)
      assert.equal(second['gate'].exitCode, 1, '2nd gate should report exitCode=1')
      assert.equal(second['gate'].timedOut, false)
      assert.equal(second['resumed'], true, '2nd attempt should be marked resumed')
      // Attempt 3: succeeds and still carries `resumed=true`.
      assert.equal(third['ok'], true)
      assert.equal(third['attempt'], 3)
      assert.equal(third['resumed'], true)

      // ---- Same conversationId and worktree (path, branch, id identical across all 3 attempts). ----
      for (const entry of entries) {
        assert.equal(entry['execution'].conversationId, run.result.execution.conversationId)
        assert.equal(entry['execution'].worktree.path, worktree.path)
        assert.equal(entry['execution'].worktree.branch, worktree.branch)
        assert.equal(entry['execution'].worktree.id, worktree.id)
      }
      // Marker files from all 3 attempts coexist inside the same worktree.
      for (const n of [1, 2, 3]) {
        assert.ok(existsSync(join(worktree.path, `attempt-${n}.txt`)), `attempt-${n}.txt should exist in the shared worktree`)
      }
      assert.ok(existsSync(worktree.path), 'worktree is preserved across retries (not reclaimed on failure)')

      // ---- Process-group kill is genuine: an unkilled gate would write escape marker after 6s
      // and stretch the run past 6s. ----
      const goalNode = (run.nodes ?? []).find((n: Record<string, any>) => n['label'] === 'worker-c')
      assert.ok(goalNode, 'agent node with label worker-c should exist')
      assert.equal(goalNode!['status'], 'done')
      assert.equal(goalNode!['conversationId'], run.result.execution.conversationId)
      assert.ok(
        typeof run['updatedAt'] === 'number' && typeof run['createdAt'] === 'number',
        'run summary should carry createdAt/updatedAt',
      )
      assert.ok(
        run['updatedAt'] - run['createdAt'] < 9_500,
        `total run duration ${run['updatedAt'] - run['createdAt']}ms should be under 9.5s (gate terminated at 1s timeout)`,
      )
      const escaped = findFileRecursive(dir, 'gate-1-escaped.txt')
      if (escaped.length > 0) {
        // Fail fast if escape marker already appeared before waiting out the window.
        assert.fail(`gate process escaped process-group kill: ${escaped.join(', ')}`)
      }
      while (Date.now() - startedAt < 10_200) await sleep(100)
      assert.deepEqual(
        findFileRecursive(dir, 'gate-1-escaped.txt'),
        [],
        'killed gate process must not write escape marker even after 6s window',
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3: 3-level nested identical labels + resumeFromRunId checkpoint resume
// ---------------------------------------------------------------------------

describe('T3 3-level nested identical plan labels and resumeFromRunId checkpoint resume', { timeout: 60_000 }, () => {
  it('module A hits cache completely while only module B failed node reruns live, restoring full metadata', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const dataDir = join(dir, 'data')
    const env = await openRuntime(dataDir, repo)
    const signalPath = join(repo, 'b-open-gate.txt')
    // Module B's `plan` switches from fail to ok between initial run and resumed run.
    const state = { modB: 'fail' as 'fail' | 'ok' }

    // ---- Faux routing: dispatch by transcript marker; `MODB-FIX` takes priority over `MODB-PLAN`
    // (since its resumed transcript contains both markers). ----
    const route: ModelRoute = ({ texts, afterToolResult }) => {
      const last = texts.at(-1) ?? ''
      const has = (marker: string) => texts.some((t) => t.includes(marker))
      if (has('MODB-FIX-OBJECTIVE')) {
        // Core `scopeId` isolation assertion: B's `resume('plan')` must resume B's own `plan` conversation
        // (transcript contains B's plan marker and none of A's same-named conversations).
        if (!has('MODB-PLAN-OBJECTIVE') || has('MODA-GOAL-OBJECTIVE') || has('SUBA-PLAN-OBJECTIVE')) {
          throw new Error(
            `resume('plan') hit the wrong conversation (scope isolation broken): transcript markers ${JSON.stringify(texts.map((t) => t.slice(0, 60)))}`,
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

    // ---- 3-level scripts: master (inline) -> modules `t3-mod-a` / `t3-mod-b` -> leaf `t3-sub-a`. ----
    // Module A runs two concurrent `'plan'` nodes (`goal` and leaf sub-workflow);
    // master also runs both modules concurrently to verify scope-isolated cache replay on resume.
    const goalGate = 'node -e "process.exit(require(\'fs\').existsSync(\'mod-a-done.txt\')?0:1)"'
    // Signal action appends one line as a side-effect counter; resume must not append a second line.
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
      // ---- Save the three sub-workflows (real `save` action + `meta.name` naming). ----
      for (const script of [subAScript, modAScript, modBScript]) {
        await env.saveWorkflow(script)
      }

      const runArgs = { repoDir: repo, linux: PROCESS_SCAN_ON }

      // ---- Run 1: module B's `plan` goal exhausts retries -> run fails. ----
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
          assert.ok(error instanceof HelmError, `expected HelmError, got ${String(error)}`)
          assert.equal(error.code, 'workflow_failed')
          const details = error.details as { runId?: string } | undefined
          assert.ok(typeof details?.runId === 'string', 'failure details should carry runId')
          failedRunId = details!.runId!
          return true
        },
      )
      const failed = (await env.inspectRun(failedRunId)).run
      assert.equal(failed.status, 'failed')
      assert.match(String(failed.error), /module B workflow failed/, `module B failure should be reported explicitly by master: ${failed.error}`)
      assert.doesNotMatch(String(failed.error), /module A workflow failed/, `module A must not fail before module B: ${failed.error}`)

      // Run 1 journal: module A succeeded; module B's `plan` failed yet retained execution metadata.
      const journal1 = readJournal(dataDir, env.conversationId, failedRunId)
      const agentEntries = journal1.filter((e) => e['type'] === 'agent')
      const goalEntry = agentEntries.find(
        (e) => e['ok'] === true && e['execution']?.['worktree']?.['branch']?.startsWith('helm/spawn-'),
      )
      assert.ok(goalEntry, 'module A goal should succeed and record worktree metadata')
      const failedPlan = agentEntries.find((e) => e['ok'] === false)
      assert.ok(failedPlan, 'module B plan failure should be recorded')
      assert.equal(failedPlan!['attempt'], 1)
      assert.ok(
        typeof failedPlan!['execution']?.['conversationId'] === 'number',
        'failed attempt should retain conversationId instead of discarding execution metadata',
      )
      const actionEntries = journal1.filter((e) => e['type'] === 'action')
      // Action journal rows omit label (recorded by index/key); verify count, success, `idempotent`,
      // and actual side effects (signal counter / git log / branch deletion).
      assert.equal(
        actionEntries.length,
        PROCESS_SCAN_ON ? 3 : 2,
        `expected merge-a${PROCESS_SCAN_ON ? '/cleanup-a' : ''}/signal-b, got ${actionEntries.length}`,
      )
      for (const entry of actionEntries) {
        assert.equal(entry['ok'], true, `all actions should succeed: ${JSON.stringify(entry)}`)
        assert.equal(entry['idempotent'], true, 'all actions should be marked idempotent')
      }
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', 'module A signal action should execute exactly once')

      // Real side effects: merge commit landed on main; worktree cleaned up.
      const logText = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.match(logText, /feat: mod-a/, 'module branch should actually merge into main')
      if (PROCESS_SCAN_ON) {
        const goalBranch = goalEntry!['execution']['worktree']['branch'] as string
        const branchList = execFileSync('git', ['branch', '--list', goalBranch], { cwd: repo, encoding: 'utf8' })
        assert.equal(branchList.trim(), '', 'module branch should be deleted after cleanup(deleteBranch)')
      }
      const failedPlanConversationId = failedPlan!['execution']['conversationId'] as number
      // All three `'plan'` conversations remain distinct (`goal` / leaf / module B).
      assert.equal(agentEntries.filter(e => e['ok'] === false).length, 2, 'module B should have exhausted two attempts')
      const planConversationIds = agentEntries
        .filter(e => (e['attempt'] ?? 1) === 1)
        .map((e) => e['execution']?.['conversationId'])
        .filter((id) => typeof id === 'number')
      assert.equal(
        new Set(planConversationIds).size,
        planConversationIds.length,
        `three same-named plan conversations must be distinct: ${JSON.stringify(planConversationIds)}`,
      )

      // ---- Resume from checkpoint after fixing model response: only failed nodes run live; all others cached. ----
      state.modB = 'ok'
      env.faux.setResponses(routedResponses(route, 24))
      const { run: resumed } = await env.runWorkflowAction({
        resumeFromRunId: failedRunId,
        conversationId: env.conversationId,
        wait: true,
      })
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error))
      assert.equal(resumed.replayedFrom, failedRunId, 'resumed run should record replayedFrom')

      // Module A values fully restored (`withMeta` metadata reconstructed from journal cache).
      const a = resumed.result.a
      assert.ok(a, 'module A result should be present')
      assert.equal(a.sub.ok, true)
      assert.equal(a.sub.output, 'SUBA-OK')
      assert.equal(a.goal.ok, true)
      assert.equal(a.goal.attempts, 1)
      assert.equal(a.goal.output, 'A-GOAL-DONE')
      assert.ok(a.goal.execution.worktree, 'goal execution.worktree should be restored from cache')
      assert.equal(a.goal.execution.worktree.branch, goalEntry!['execution']['worktree']['branch'])
      assert.equal(a.goal.execution.worktree.id, goalEntry!['execution']['worktree']['id'])
      assert.equal(a.goal.execution.worktree.path, goalEntry!['execution']['worktree']['path'])
      assert.equal(a.mergeOk, true)
      assert.equal(a.cleaned, PROCESS_SCAN_ON ? true : null)

      // Module B: resumes original failed goal conversation; `fix` resumes B's own `plan`.
      const b = resumed.result.b
      assert.deepEqual(b.plan, { answer: 'b-plan-ok' })
      assert.equal(b.fix, 'B-FIX-OK')
      assert.equal(b.attempts, 3, 'resumed round should continue to attempt 3 after 2 prior failures')

      // Zero duplicate side effects: signal counter stays 1 line; merge commit does not repeat.
      assert.equal(readFileSync(signalPath, 'utf8'), 'x\n', 'resume must not re-run module A idempotent actions')
      const logText2 = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' })
      assert.equal((logText2.match(/feat: mod-a/g) ?? []).length, 1, 'merge action must not repeat')

      // Node-level verification: all module A nodes cached; only module B `plan`/`fix` ran live.
      const nodes = (resumed.nodes ?? []) as Array<Record<string, any>>
      const agentNodes = nodes.filter((n) => n['kind'] === 'agent' || String(n['id']).startsWith('agent-'))
      const liveAgentNodes = agentNodes.filter((n) => n['cached'] !== true)
      assert.equal(liveAgentNodes.length, 2, `expected exactly 2 live agent nodes (B plan and fix), got ${JSON.stringify(liveAgentNodes.map((n) => ({ id: n['id'], label: n['label'] })))}`)
      const livePlan = liveAgentNodes.find((n) => n['label'] === 'plan')
      assert.ok(livePlan, 'live rerun failed node should retain label plan')
      assert.ok(
        livePlan!['conversationId'] === failedPlanConversationId,
        'failed goal should resume its original conversation without colliding with A same-named plan',
      )
      const cachedAgentNodes = agentNodes.filter((n) => n['cached'] === true)
      assert.equal(cachedAgentNodes.length, 2, 'module A sub-a plan and goal nodes should both hit cache')
      const actionNodes = nodes.filter((n) => String(n['id']).startsWith('action-'))
      assert.ok(actionNodes.length >= 3, 'action nodes should appear in node tree')
      assert.ok(actionNodes.every((n) => n['cached'] === true), 'all action nodes should hit cache (zero side-effect replay)')
    } finally {
      await env.close()
    }
  })
})
