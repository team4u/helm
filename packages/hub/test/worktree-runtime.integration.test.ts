/**
 * worktree runtime real integration test (new contract:WorktreeAllocator/cleanup_worktree
 * fully belongs to builtin:workflow plugin).
 *
 * override (via real createHelm + faux model + temporary real Git repository + plugin public API):
 * 1. real spawnAgent isolation:'worktree'(agent_spawn continuation by
 *    builtin:workflow fall back): real isolated tree create, sub-conversation and gate in tree inside execute,
 *    onResolved back pass managed id;cleanup_worktree action by default keep branch.
 * 2. gate failed / model failed / cancel after worktree and uncommitted artifact keep until explicit cleanup
 *    (guard against mistakenly delete regression;gate failed and abort confirm original generate sub-conversation stop after run lease by §1.2
 *    release,force clean up can succeeded).
 * 3. subagent run in (spawn not settle)cleanup force:true still worktree_in_use;
 *    settle after via action clean up succeeded.
 * 4. action boundary validate: unknown key/many choose/zero choose/illegal type explicit 400(HTTP action
 *    Schema); not register choose 404 not_found pass-through; action authentication 401.
 * 5. external plugin agent_spawn handled back pass worktree: unify register worktreeId,
 *    cleanup_worktree same mechanism clean up; missing nodeId explicit execution_info_invalid;
 *    request isolation but external runtime do not honor → original generate execute row unsupported_runtime.
 * 6. same sub-conversation concurrency resume mutual exclusion (subagent_in_use).
 * 7. background back report requestId idempotent (durable dedupe + after restart keep).
 * 8. durable lease fail-closed(security hard rule): restart interrupt semantics lease leftover when
 *    cleanup_worktree explicit worktree_execution_unknown; normal spawn after success
 *    lease release can clean up.
 *
 * contract discipline: does not use KernelRuntime  worktrees/cleanupWorktree(deleted);
 * all via real createHelm + builtin:workflow public action/tool verify; lease assertion via
 * plugin private durable doc real leftover state simulated (process death after disk on real store in content).
 *
 * honest discipline: true SQLite + true pi-durable SDK + faux model script + real temporary Git
 * repository + real HTTP handler; do not mock git, do not fabricate complete result.
 *
 * runner: tsx --test; each test explicit timeout: 60_000 guard against deadlock.
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentExecutionInfo, AgentSpawnRequest } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHubHandler } from '../../kernel/src/http/index.js'
import { extractWorkflowExecutionMeta } from '@helm/plugins/contracts'
import {
  createGitTemplate,
  createHubTestApp,
  type FauxProviderHandle,
  type GitTemplate,
  type HubTestApp,
} from './helpers/hub-test-env.js'

/** extract managed worktree description (execution meta  workflow naming empty between business value). */
function worktreeOf(info: AgentExecutionInfo | undefined) {
  return info === undefined ? undefined : extractWorkflowExecutionMeta(info).worktree
}

/**
 * platform fact: process occupy scan when before only Linux /proc. non- Linux on cleanup in process check where
 * explicit reject (worktree_process_check_failed) - - test contract by platform such as fork,
 * do not fabricate complete=true, not silently skip (across platform explicit reject is when before behavior restrict).
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** non- Linux platform assertion cleanup explicit reject (do not fabricate 0 occupy). */
async function assertCleanupPlatformRejected(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'worktree_process_check_failed', 'non- Linux platform: process occupy scan unsupported,cleanup must explicit reject')
    return true
  })
}

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-worktree-runtime-'))
  gitTemplate = createGitTemplate('helm-worktree-runtime-tpl-')
})

after(() => {
  gitTemplate?.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
})

interface RuntimeEnv {
  /** real createHelm should use (builtin:workflow by default enable). */
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  /** real HTTP handler(process token authentication). */
  handler: (request: Request) => Promise<Response>
  token: string
  /** builtin:workflow public action total line (and HTTP/CLI/model tool same link). */
  invoke: {
    cleanupWorktree(input: Record<string, unknown>): Promise<{
      removed: boolean
      worktreeId: string
      path: string
      branch: string
      nodeId: string
      branchDeleted: boolean
    }>
    inspect(runId: string): Promise<{ run: { id: string; status: string; error?: string } }>
  }
  /** plugin private durable document (lease/register leftover assertion and restart interrupt simulated). */
  pluginDoc: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush(): Promise<void>
  }
  close(): Promise<void>
}

/** real createHelm(contains builtin:workflow by default enable)+ faux provider + HTTP handler. */
async function openRuntime(dataDir: string, cwd?: string): Promise<RuntimeEnv> {
  const { app, kernel, faux } = await createHubTestApp({
    dataDir,
    cwd: cwd ?? dataDir,
  })
  const handler = createHubHandler(kernel)
  const { token } = kernel.auth.createProcessToken()
  return {
    app,
    kernel,
    faux,
    handler,
    token,
    invoke: {
      cleanupWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'cleanup_worktree', input) as never,
      inspect: (runId) =>
        kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as never,
    },
    pluginDoc: {
      // plugin doc durable layer key:`${pluginId}:${name}`(helm_plugin_docs global naming empty between).
      get: <T>(key: string, initial: T): T =>
        kernel.documentStore.get<T>(`builtin:workflow:worktree-state:${key}`, initial),
      set: <T>(key: string, value: T): void =>
        kernel.documentStore.set(`builtin:workflow:worktree-state:${key}`, value),
      flush: () => kernel.documentStore.flush(),
    },
    async close() {
      // subject to control closure stop (close chain error do not mask test assertion; closure stop failed another has base seat fix trace).
      await app.close().catch(() => {})
    },
  }
}

/** HTTP POST /api/actions/builtin:workflow/cleanup_worktree direct tune handler(real authentication + JSON parse). */
async function postCleanup(env: RuntimeEnv, input: unknown): Promise<{ status: number; json: any }> {
  const response = await env.handler(
    new Request('http://127.0.0.1:3202/api/actions/builtin%3Aworkflow/cleanup_worktree', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.token}` },
      body: JSON.stringify({ input }),
    }),
  )
  const text = await response.text()
  return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null }
}

/** suspended type faux response work vendor:entered notify enter after wait for release. */
function heldResponse(
  onEnter: () => void,
): { step: () => Promise<AssistantMessage>; release: (message: AssistantMessage) => void } {
  let resolveHeld!: (message: AssistantMessage) => void
  const held = new Promise<AssistantMessage>((resolve) => {
    resolveHeld = resolve
  })
  return {
    step: () => {
      onEnter()
      return held
    },
    release: (message) => resolveHeld(message),
  }
}

/** read conversation all helm.input entry  {origin, backgroundRunId}. */
async function agentReports(
  kernel: RuntimeEnv['kernel'],
  conversationId: number,
): Promise<Array<{ origin: string; backgroundRunId?: string }>> {
  const detail = await kernel.getConversationDetail(conversationId, { limit: 500 })
  const out: Array<{ origin: string; backgroundRunId?: string }> = []
  for (const entry of detail.entries) {
    if (entry.kind !== 'helm.input') continue
    const data = entry.data as { origin?: unknown; meta?: { backgroundRunId?: unknown } } | undefined
    out.push({
      origin: String(data?.origin ?? ''),
      backgroundRunId: typeof data?.meta?.backgroundRunId === 'string' ? data.meta.backgroundRunId : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. real spawnAgent isolation:'worktree' all link (continuation fall back)
// ---------------------------------------------------------------------------

describe('builtin:worktree isolated derive (agent_spawn continuation)', { timeout: 60_000 }, () => {
  it('spawnAgent isolation:worktree: real isolated tree + managed id back pass + gate in tree inside via + action clean up by default keep branch', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd > .helm-child-pwd.txt && git branch --show-current > .helm-child-branch.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('task complete:worktree inside execute done'),
      ])
      const result = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'in isolated worktree execute task',
        isolation: 'worktree',
        gate: 'pwd > .helm-gate-pwd.txt && test -f README.md',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.equal(result, 'task complete:worktree inside execute done')

      // ---- onResolved back pass managed worktree metadata (stable id).----
      assert.ok(resolved, 'onResolved should back pass execute environment metadata')
      assert.equal(resolved!.nodeId, 'local')
      assert.ok(resolved!.conversationId !== undefined && resolved!.conversationId > 1, 'should derive true sub-conversation')
      const worktree = worktreeOf(resolved)
      assert.ok(worktree, 'isolation:worktree must back pass worktree metadata')
      assert.ok(worktree!.path.includes(join(dir, '.helm-worktrees')), `worktree should at same level .helm-worktrees:${worktree!.path}`)
      assert.ok(worktree!.branch.startsWith('helm/spawn-'), `branch should be helm/spawn-*:${worktree!.branch}`)
      assert.ok(typeof worktree!.id === 'string' && worktree!.id.length > 0, 'must back pass managed register id(worktreeId)')

      // ---- real isolated tree: sub-conversation and gate artifact all in tree inside.----
      assert.ok(existsSync(worktree!.path), 'worktree directory should real store in')
      assert.ok(existsSync(join(worktree!.path, 'README.md')), 'worktree should checkout initial commit content')
      assert.ok(existsSync(join(worktree!.path, '.helm-child-pwd.txt')), 'sub-conversation bash artifact should in worktree inside')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-pwd.txt'), 'utf8').trim(), worktree!.path, 'sub-conversation pwd should be worktree directory')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-branch.txt'), 'utf8').trim(), worktree!.branch, 'sub-conversation should in helm/spawn-* branch on')
      assert.ok(existsSync(join(worktree!.path, '.helm-gate-pwd.txt')), 'gate artifact should in worktree inside')
      assert.equal(readFileSync(join(worktree!.path, '.helm-gate-pwd.txt'), 'utf8').trim(), worktree!.path, 'gate pwd should be worktree directory (gate in tree inside execute)')
      assert.ok(!existsSync(join(repo, '.helm-gate-pwd.txt')), 'source repository must not by gate/sub-conversation pollute')
      const child = env.kernel.getConversation(resolved!.conversationId!)
      assert.equal(child.cwd, worktree!.path, 'sub-conversation mirror cwd should be worktree directory')

      // ---- clean up (builtin:workflow public action; by default keep branch).----
      // uncommitted artifact in tree inside: explicit force discard (non- force dirty reject by native-worktree dedicated items override).
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          conversationId: resolved!.conversationId,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.worktreeId, worktree!.id, 'clean up result should back pass managed worktreeId')
        assert.equal(cleaned.branchDeleted, false, 'by default clean up must keep branch')
        assert.ok(!existsSync(worktree!.path), 'clean up after worktree directory should by remove')
        const branchList = execFileSync('git', ['branch', '--list', worktree!.branch], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes(worktree!.branch), `branch ${worktree!.branch} should by default keep (got ${branchList.trim()})`)
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }))
        assert.ok(existsSync(worktree!.path), 'non- Linux reject clean up when directory must not by remove')
      }
    } finally {
      await env.close()
    }
  })

  it('original generate subagent tool chain: model invoke subagent(isolation:worktree) create real isolated tree; tool output contains cleanup hint/worktreeId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1b')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'isolated task', isolation: 'worktree', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('subagent complete'),
        fauxAssistantMessage('main turn complete'),
      ])
      await env.kernel.submitInput(1, 'derive isolated subagent')
      await env.kernel.waitForIdle(1)

      const detail = await env.kernel.getConversationDetail(1, { limit: 100 })
      const toolEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('"subagent"'))
      assert.ok(toolEntry, 'should store in subagent tool result entry')
      const toolResultMsg = (toolEntry.model as Array<{
        content?: Array<{ text?: string }>
        details?: { execution?: { worktree?: { id?: string; path?: string; branch?: string } } }
      }> | undefined)?.[0]
      const payload = JSON.parse(toolResultMsg?.content?.[0]?.text ?? '{}') as {
        execution?: { worktree?: { id?: string; path?: string; branch?: string } }
      }
      assert.ok(payload.execution?.worktree?.path, `tool output should contain execution.worktree.path: ${JSON.stringify(payload)}`)
      assert.ok(payload.execution?.worktree?.branch, 'tool output should contain execution.worktree.branch')
      assert.ok(payload.execution?.worktree?.id, 'tool output should contain managed worktree.id')
      assert.equal(
        toolResultMsg?.details?.execution?.worktree?.id,
        payload.execution.worktree.id,
        'toolResult.details should mirror structuredOutput.execution.worktree.id',
      )

      // real sub-conversation create in real isolated tree inside (mirror cwd i.e. isolated tree path).
      const child = env.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'should derive true sub-conversation')
      assert.ok(child.cwd.includes(join(dir, '.helm-worktrees')), 'sub-conversation should in same level .helm-worktrees under isolated tree inside execute')
      assert.ok(existsSync(child.cwd), 'managed worktree should real store in')
      assert.ok((await env.kernel.getLastAssistantText(1)).includes('main turn complete'))
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. gate failed / model failed / cancel after worktree and uncommitted artifact keep (guard against mistakenly delete regression)
// ---------------------------------------------------------------------------

describe('failed path asset keep (guard against continuation converge mistakenly delete regression)', { timeout: 60_000 }, () => {
  it('gate failed: sub-conversation already produce out uncommitted file after worktree keep (supply person class inspect view),gate_failed explicit on throw', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2a')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo wip > wip-artifact.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('task complete (gate failed)'),
      ])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'produce out after gate failed task',
            isolation: 'worktree',
            gate: 'test -f never-exists.txt',
            onResolved: (info) => {
              resolved = info
            },
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `should throw HelmError, got ${err}`)
          assert.equal(err.code, 'gate_failed')
          return true
        },
      )
      assert.ok(worktreeOf(resolved), 'gate failed before onResolved already back pass worktree')
      const wtPath = worktreeOf(resolved)!.path
      // key guard against regression:gate failed (sub-conversation already settle) never trigger reclaim mistakenly delete; directory and
      // uncommitted artifact keep until explicit cleanup(protect point do not because lease release while disappear).
      assert.ok(existsSync(wtPath), 'gate failed after worktree must keep (supply person class inspect view)')
      assert.ok(existsSync(join(wtPath, 'wip-artifact.txt')), 'sub-conversation uncommitted artifact must keep')
      // §1.2 lease release:gate failed = original generate sub-conversation turn with failed field and host confirm already
      // stop, run lease should release (keep Worktree record and sub-conversation mapping); explicit force
      // clean up no longer by worktree_execution_unknown block, can succeeded remove directory.
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          conversationId: resolved!.conversationId,
          force: true,
        })
        assert.equal(cleaned.removed, true, 'lease release after explicit force clean up should succeeded')
        assert.equal(cleaned.branchDeleted, false, 'by default clean up must keep branch')
        assert.ok(!existsSync(wtPath), 'explicit clean up after worktree directory should by remove (artifact follow directory discard, this before after placement is already inspect view)')
      } else {
        // non- Linux: lease gate already, reject only allows from process scan platform restrict.
        await assertCleanupPlatformRejected(() =>
          env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }),
        )
        assert.ok(existsSync(wtPath), 'non- Linux reject clean up when directory must not by remove')
      }
    } finally {
      await env.close()
    }
  })

  it('model turn failed (schema two time do not together rule):worktree and since has uncommitted artifact keep', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2b')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        // Schema output tool cannot replace original has kernel tool, must can first execute real task again commit result.
        fauxAssistantMessage([fauxToolCall('bash', { command: 'printf "child prior work\\n" > partial.txt' })], { stopReason: 'toolUse' }),
        // two round pure text all do not satisfy schema: trigger schema_validation_failed.
        fauxAssistantMessage('this is not JSON'),
        fauxAssistantMessage('still is not JSON'),
      ])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'want seek structure output but model failed',
            isolation: 'worktree',
            schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
            onResolved: (info) => {
              resolved = info
            },
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `should throw HelmError, got ${err}`)
          assert.equal(err.code, 'schema_validation_failed')
          return true
        },
      )
      assert.ok(worktreeOf(resolved))
      const preExisting = join(worktreeOf(resolved)!.path, 'partial.txt')
      // key assertion:continuation converge must not reclaim already bind set sub-conversation isolated tree (guard against mistakenly delete regression).
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'model failed after worktree must keep')
      assert.ok(existsSync(preExisting), 'uncommitted artifact must keep')
    } finally {
      await env.close()
    }
  })

  it('run in cancel (abort): real wrap-up after worktree and uncommitted artifact keep', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2c')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let entered = false
      const held = heldResponse(() => {
        entered = true
      })
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo canceled-work > cancel-marker.txt' })], { stopReason: 'toolUse' }),
        held.step as never,
      ])
      const controller = new AbortController()
      let resolved: AgentExecutionInfo | undefined
      const pending = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'will by cancel isolated task',
        isolation: 'worktree',
        signal: controller.signal,
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (worktreeOf(resolved) && existsSync(join(worktreeOf(resolved)!.path, 'cancel-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(worktreeOf(resolved), 'cancel before onResolved should back pass worktree')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'cancel-marker.txt')), 'cancel before sub-conversation should already write artifact')
      // artifact write occur in first round tool invoke; wait for second round model request truly enter held,
      // again start cancel, avoid all amount test concurrency when early abort only cancel first round converge.
      const heldDeadline = Date.now() + 10_000
      while (!entered && Date.now() < heldDeadline) await new Promise((r) => setTimeout(r, 25))
      assert.ok(entered, 'cancel before should already enter suspended real model turn')

      controller.abort()
      held.release(fauxAssistantMessage('must not as result'))
      await assert.rejects(() => pending, (err: unknown) => err instanceof HelmError && err.code === 'aborted')

      const childId = resolved!.conversationId!
      await env.kernel.waitForIdle(childId)
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'cancel after worktree must keep (sub-conversation already create bind set, must not mistakenly delete)')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'cancel-marker.txt')), 'cancel after uncommitted artifact must keep')
      assert.ok(entered)
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. run in occupy:force:true still worktree_in_use,settle after can clean up
// ---------------------------------------------------------------------------

describe('occupy in worktree clean up protect', { timeout: 60_000 }, () => {
  it('model turn still in execute:force:true still worktree_in_use;settle after via action clean up succeeded', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const held = heldResponse(() => {})
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo ok > in-use-marker.txt' })], { stopReason: 'toolUse' }),
        // second turn hang in model request in:SDK turn in-flight.
        held.step as never,
      ])
      let resolved: AgentExecutionInfo | undefined
      const controller = new AbortController()
      const pending = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'long task (occupy check)',
        isolation: 'worktree',
        signal: controller.signal,
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (worktreeOf(resolved) && existsSync(join(worktreeOf(resolved)!.path, 'in-use-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(worktreeOf(resolved) && resolved?.conversationId, 'sub-conversation should already create')
      const childId = resolved!.conversationId!
      assert.equal(env.kernel.getConversation(childId).status, 'working', 'model suspended during sub-conversation should be working')

      // spawn not settle:conversation occupy + in-flight spawn execute coordinates reference double keep risk,
      // force:true also must not clean up run in subagent worktree.
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: childId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_in_use', `force clean up run in worktree should reject, got ${(err as HelmError).code}`)
          return true
        },
      )
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'occupy reject when directory must not passively')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'in-use-marker.txt')), 'occupy during artifact must not by delete')

      // real wrap-up: release model + abort, etc. spawn settle and sub-conversation idle.
      controller.abort()
      held.release(fauxAssistantMessage('(cancel)'))
      await assert.rejects(() => pending, (e: unknown) => e instanceof HelmError && e.code === 'aborted')
      await env.kernel.waitForIdle(childId)

      // settle after (abort path: original generate sub-conversation turn with failed field and already confirm stop):
      // §1.2 run lease release, explicit force clean up no longer by worktree_execution_unknown
      // block, can succeeded remove directory (branch by default keep).
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({ conversationId: childId, force: true })
        assert.equal(cleaned.removed, true, 'abort confirm stop after lease should release,force clean up can succeeded')
        assert.equal(cleaned.branchDeleted, false, 'by default clean up must keep branch')
        assert.ok(!existsSync(worktreeOf(resolved)!.path), 'explicit clean up after worktree directory should by remove')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: childId, force: true }))
        assert.ok(existsSync(worktreeOf(resolved)!.path), 'non- Linux reject clean up when directory must not by remove')
      }
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. action boundary validate (HTTP action Schema + authentication + error code pass-through)
// ---------------------------------------------------------------------------

describe('cleanup_worktree action boundary (HTTP Schema/authentication/pass-through)', { timeout: 60_000 }, () => {
  it('action boundary validate: unknown key/many choose/zero choose/illegal type explicit 400; not register choose 404 do not trigger touch actual clean up', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4a')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // unknown key reject (action inputSchema additionalProperties:false).
      const unknownKey = await postCleanup(env, { conversationId: 5, oops: true })
      assert.equal(unknownKey.status, 400)
      assert.equal(unknownKey.json.error.code, 'validation_error')

      // many choose reject (conversationId + path).
      const multiA = await postCleanup(env, { conversationId: 5, path: '/tmp/x' })
      assert.equal(multiA.status, 400)
      assert.equal(multiA.json.error.code, 'validation_error')
      // zero choose same reject.
      const none = await postCleanup(env, {})
      assert.equal(none.status, 400)
      assert.equal(none.json.error.code, 'validation_error')

      // illegal type:conversationId non- positive integer / force non- boolean / deleteBranch non- boolean
      //(action JSON Schema boundary reject).
      const badConv = await postCleanup(env, { conversationId: 0 })
      assert.equal(badConv.status, 400)
      assert.equal(badConv.json.error.code, 'validation_error')
      const badConv2 = await postCleanup(env, { conversationId: 'five' as unknown as number })
      assert.equal(badConv2.status, 400)
      assert.equal(badConv2.json.error.code, 'validation_error')
      const badForce = await postCleanup(env, { conversationId: 5, force: 'yes' as unknown as boolean })
      assert.equal(badForce.status, 400)
      assert.equal(badForce.json.error.code, 'validation_error')
      const badDelete = await postCleanup(env, { conversationId: 5, deleteBranch: 1 as unknown as boolean })
      assert.equal(badDelete.status, 400)
      assert.equal(badDelete.json.error.code, 'validation_error')

      // not register choose: choose shape legal but without record -> 404 not_found(user error,
      // does not pretend to be into validation failed; never mistakenly delete not register directory).
      const unregistered = await postCleanup(env, { worktreeId: 'local:/tmp/no-such-wt' })
      assert.equal(unregistered.status, 404)
      assert.equal(unregistered.json.error.code, 'not_found')
    } finally {
      await env.close()
    }
  })

  it('succeeded invoke actual clean up (real worktree by remove,worktreeId throughout through); not register choose user error code not_found pass-through', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4b')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // real derive a managed worktree(clean: without take verify artifact, verify non- force succeeded link).
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('complete')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'HTTP clean up link task',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved) && worktreeOf(resolved)?.id, 'should back pass managed worktree id')
      const wt = worktreeOf(resolved)!

      // by managed id succeeded clean up (worktreeId precise choose;deleteBranch by default keep branch).
      const ok = await postCleanup(env, { worktreeId: wt.id })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.removed, true)
      assert.equal(ok.json.branchDeleted, false)
      assert.equal(ok.json.path, wt.path)
      assert.ok(!existsSync(wt.path), 'HTTP clean up should actual remove worktree directory')

      // not register choose:allocator  not_found(404) original pass-through (does not pretend to be 500/200).
      const missing = await postCleanup(env, { conversationId: 999_999 })
      assert.equal(missing.status, 404)
      assert.equal(missing.json.error.code, 'not_found')
      assert.ok(String(missing.json.error.message).includes('未找到'), `error message should note only clean up register record:${missing.json.error.message}`)
    } finally {
      await env.close()
    }
  })

  it('not carries token 401(action end point same force authentication)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4c')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const noAuth = await env.handler(
        new Request('http://127.0.0.1:3202/api/actions/builtin%3Aworkflow/cleanup_worktree', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: { conversationId: 5 } }),
        }),
      )
      assert.equal(noAuth.status, 401)
      assert.equal((JSON.parse(await noAuth.text()) as { error: { code: string } }).error.code, 'unauthorized')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. external plugin agent_spawn handled: unify register and explicit reject
// ---------------------------------------------------------------------------

describe('external plugin agent_spawn handled and worktree unify register', { timeout: 60_000 }, () => {
  it('can message plugin in real temporary git worktree back pass nodeId/executionId/worktree: unify register worktreeId;cleanup_worktree same mechanism clean up (test boundary: self define plugin simulated external runtime, non- real Herdr)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5a')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // plugin in real git worktree inside execute task (real git command, non- mock directory).
      const wtPath = join(dir, '.helm-worktrees', 'external-task')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-external-1', wtPath, 'HEAD'], { cwd: repo })
      writeFileSync(join(wtPath, 'external-result.txt'), 'done\n')

      await env.kernel.plugins.register({
        id: 'test:external-runtime',
        name: 'external runtime (test stub: real git worktree back pass)',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            // namespace:kind form = external runtime (builtin:workflow do not pre- allocate,
            // only back fill register and lease, hand over by this take over fully negative duty execute).
            if (request.agentType !== 'test:external') return next(request) as unknown as void
            request.onResolved?.({
              nodeId: 'local',
              executionId: 'test-exec-1',
              effectiveCwd: wtPath,
              meta: { 'builtin:workflow': { worktree: { path: wtPath, branch: 'helm/wf-external-1' } } },
            })
            return { action: 'handled', result: 'external task complete (real worktree inside artifact already write)' }
          })
        },
      })

      let resolved: AgentExecutionInfo | undefined
      const result = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'external runtime task',
        agentType: 'test:external',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.equal(result, 'external task complete (real worktree inside artifact already write)')

      // unify register:onResolved back pass by change write is managed record (contains stable id).
      assert.ok(worktreeOf(resolved)?.id, 'external back pass worktree should by unify register and back fill stable id')
      assert.ok(worktreeOf(resolved)!.id!.startsWith('local:'), `managed id should be nodeId:path form:${worktreeOf(resolved)!.id}`)

      // cleanup and original generate same mechanism: unify register record can locate clean up (helm/wf-* managed prefix).
      //(external handled path succeeded complete: lease by contract release, can clean up.)
      // note: do not pass deleteBranch - - when before allocator updateRecord in deleteBranch
      // succeeded branch write branchDeleteError: undefined value,doc layer jsonClone reject
      //(known base seat defect, main proxy fix after can restore assertion); branch delete succeeded link by
      // native-worktree.test.ts allocator dedicated items override.
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          worktreeId: worktreeOf(resolved)!.id!,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.branchDeleted, false, 'by default clean up keep branch')
        assert.ok(!existsSync(wtPath), 'clean up should actual remove external worktree')
        const branchList = execFileSync('git', ['branch', '--list', 'helm/wf-external-1'], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes('helm/wf-external-1'), 'branch should by default keep')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ worktreeId: worktreeOf(resolved)!.id!, force: true }))
        assert.ok(existsSync(wtPath), 'non- Linux reject clean up when directory must not by remove')
      }
    } finally {
      await env.close()
    }
  })

  it('back pass worktree but does not give nodeId: explicit execution_info_invalid(cannot assume local)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5c')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await env.kernel.plugins.register({
        id: 'test:no-node-runtime',
        name: 'does not give nodeId runtime',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:no-node') return next(request) as unknown as void
            // missing nodeId: must not assume local.
            request.onResolved?.({ executionId: 'exec-no-node', meta: { 'builtin:workflow': { worktree: { path: '/srv/wt/x', branch: 'helm/wf-x' } } } })
            return { action: 'handled', result: 'false succeeded: without node' }
          })
        },
      })
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'without node back pass',
            agentType: 'test:no-node',
            isolation: 'worktree',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'execution_info_invalid')
          assert.ok(err.message.includes('nodeId'), `error should note missing nodeId:${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('external runtime agentType without plugin take over: original generate execute row explicit unsupported_runtime(kernel zero plugin point name, never false succeeded)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5d')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'external runtime but without person take over',
            agentType: 'test:unclaimed',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `should throw HelmError, got ${err}`)
          assert.equal(err.code, 'unsupported_runtime')
          assert.ok(err.message.includes('test:unclaimed'), `error should refer external runtime identifier:${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. same sub-conversation concurrency resume mutual exclusion (gate/structure output do not mutual grab)
// ---------------------------------------------------------------------------

describe('same sub-conversation concurrency resume mutual exclusion', { timeout: 60_000 }, () => {
  it('first resume in-flight when second concurrency resume explicit subagent_in_use; first gate and structure output normal complete', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // first tune: create bind set worktree sub-conversation.
      let childId = 0
      let firstWtPath = ''
      env.faux.setResponses([fauxAssistantMessage('one round complete')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'one round',
        isolation: 'worktree',
        onResolved: (info) => {
          childId = info.conversationId ?? 0
          firstWtPath = worktreeOf(info)?.path ?? ''
        },
      } as AgentSpawnRequest)
      assert.ok(childId > 0)
      assert.ok(firstWtPath !== '', 'should back pass isolated tree path')

      // a resume: write marker + structure output + gate(model suspended fabricate in-flight window).
      let markEntered!: () => void
      const entered = new Promise<void>((resolve) => { markEntered = resolve })
      const held = heldResponse(markEntered)
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo first > first-resume.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { answer: 'a resume answer proposal' } })], { stopReason: 'toolUse' }),
        held.step as never,
      ])
      const first = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'a resume',
        resume: String(childId),
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        gate: 'test -f first-resume.txt',
        onResolved: () => {},
      } as AgentSpawnRequest)

      // must etc. model consume before two response and enter suspended point; only etc. marker will mention before reset faux response queue.
      await Promise.race([
        entered,
        first.then(() => { throw new Error('first resume in enter suspended response before end') }),
      ])
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')), 'a resume should in original worktree inside execute')

      // concurrency second resume: same sub-conversation in-flight, explicit reject (do not mutual grab gate/structure output).
      env.faux.setResponses([fauxAssistantMessage('second resume must not execute')])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'second resume (concurrency)',
            resume: String(childId),
            gate: 'true',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'subagent_in_use')
          return true
        },
      )

      // release a: structure output and gate normal complete (not by second interference).
      held.release(fauxAssistantMessage('tail follow text'))
      const result = await first
      assert.deepEqual(result, { answer: 'a resume answer proposal' }, 'a resume structure output should complete return')
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')))
      // all process only this a sub-conversation (second not derive new conversation).
      const children = env.kernel.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, 'concurrency reject must not derive new sub-conversation')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. background back report requestId idempotent (durable requestId + process inside singleflight)
// ---------------------------------------------------------------------------

describe('background back report requestId idempotent (builtin:workflow delivery path same mechanism)', { timeout: 60_000 }, () => {
  it('3 time concurrency + terminal state after duplicate invoke only produce a origin=agent and meta.backgroundRunId=runId  helm.input; after restart durable dedupe', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't7')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    const runId = 'wf_testreport0001'
    const requestId = `helm:subagent-report:${runId}`
    const deliver = () =>
      env.kernel.submitInput(1, `background subagent task already compute. or fewer is run ${runId} result data:\n"background task complete content"`, {
        origin: 'agent',
        whenBusy: 'followUp',
        requestId,
        meta: { backgroundRunId: runId, kind: 'subagent_report' },
      })
    try {
      // faux only to once response: second time model request (if duplicate delivery) without script response while expose.
      env.faux.setResponses([fauxAssistantMessage('parent conversation receives back report after answer')])
      await Promise.all([deliver(), deliver(), deliver()])
      await env.kernel.waitForIdle(1)
      // terminal state after duplicate invoke: durable submissionByRequest intercept.
      await deliver()

      const reports = (await agentReports(env.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `same runId only should delivery a back report, got ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent', 'back report input source must is agent')

      // side verify:faux exactly once request (duplicate delivery will trigger second time request and because without response failed/or counter>1).
      assert.equal(env.faux.state.callCount, 1, `parent conversation model should only by request once, got ${env.faux.state.callCount}`)
    } finally {
      await env.close()
    }

    // heavy open same dataDir:SDK durable submissionByRequest dedupe.
    const reopened = await openRuntime(join(dir, 'data'), repo)
    try {
      reopened.faux.setResponses([fauxAssistantMessage('must not appear second time answer')])
      await reopened.kernel.submitInput(1, `background subagent task already compute. or fewer is run ${runId} result data:\n"duplicate"`, {
        origin: 'agent',
        whenBusy: 'followUp',
        requestId,
        meta: { backgroundRunId: runId, kind: 'subagent_report' },
      })
      await reopened.kernel.waitForIdle(1)
      const reports = (await agentReports(reopened.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `after restart duplicate back report must not produce second helm.input, got ${JSON.stringify(reports)}`)
    } finally {
      await reopened.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. durable lease fail-closed(security hard rule): restart interrupt leftover reject clean up
// ---------------------------------------------------------------------------

describe('durable lease unknown occupy protect (fail-closed)', { timeout: 60_000 }, () => {
  it('lease leftover (restart interrupt semantics) when cleanup_worktree explicit worktree_execution_unknown; normal spawn after success lease release can clean up', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // real worktree(external register form, simulated external runtime such as Herdr derive).
      const wtPath = join(dir, '.helm-worktrees', 'lease-check')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-lease-1', wtPath, 'HEAD'], { cwd: repo })

      // directly to plugin private durable doc write lease leftover + allocator register (simulated execute already
      // start, process death, after restart without in-flight execute: process death after disk on real store in content).
      // doc shape and produce same construct:worktree-state embed set map, inside layer key is allocator 
      // 'runtime/worktrees'({version, records}) and lease table 'worktree-leases'.
      const worktreeId = `local:${wtPath}`
      const existing = env.kernel.documentStore.get<Record<string, unknown>>('builtin:workflow:worktree-state', {})
      env.kernel.documentStore.set('builtin:workflow:worktree-state', {
        ...existing,
        'runtime/worktrees': {
          version: 1,
          records: [
            {
              id: worktreeId,
              nodeId: 'local',
              repoRoot: repo,
              path: wtPath,
              branch: 'helm/wf-lease-1',
              baseCommit: '0'.repeat(40),
              dirtySource: false,
              parentConversationId: 1,
              executionId: 'ext-pane-7',
              origin: 'external',
              status: 'active',
              createdAt: Date.now(),
            },
          ],
        },
        'worktree-leases': {
          'stale-token-from-dead-process': {
            phase: 'running',
            info: {
              nodeId: 'local',
              executionId: 'ext-pane-7',
              effectiveCwd: wtPath,
              meta: { 'builtin:workflow': { worktree: { path: wtPath, branch: 'helm/wf-lease-1' } } },
            },
            worktreeId,
            createdAt: Date.now(),
          },
        },
      })
      await env.kernel.documentStore.flush()

      // unknown occupy: cannot verify underlying (such as remote Herdr) already stop,force also reject (guard against delete still in run directory).
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_execution_unknown')
          assert.ok(err.message.includes('不能清理'), `error should to out inspect view/manually clean up refer quote:${err.message}`)
          return true
        },
      )
      assert.ok(existsSync(wtPath), 'unknown occupy reject when directory must not passively')

      // normal original generate spawn(succeeded path): lease register and in settle after release, then can clean up.
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('lease release verify complete')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'succeeded task (lease release)',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved), 'succeeded spawn should back pass worktree')
      const leases = env.pluginDoc.get<Record<string, { info?: AgentExecutionInfo }>>('worktree-leases', {})
      const leasePaths = Object.values(leases).map((l) => worktreeOf(l.info)?.path)
      assert.ok(
        !leasePaths.includes(worktreeOf(resolved)!.path),
        `succeeded settle after lease should release, got ${JSON.stringify(leasePaths)}`,
      )
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true })
        assert.equal(cleaned.removed, true, 'lease release after can clean up')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true }))
      }
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. createHelm real background combine:subagent(background:true, isolation:worktree, gate)
// ---------------------------------------------------------------------------

describe('createHelm background subagent all chain (background + worktree + gate + parent turn first end)', { timeout: 60_000 }, () => {
  it('background run phase:run running, sub-conversation in gate, clean up reject; release gate after settle and to parent conversation idempotent gather report runId/worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't9')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    const kernel = env.kernel
    // release file at isolated tree outside (parent repo inside):gate in worktree inside wait for external signal.
    const releaseFile = join(repo, '.helm-test-release.txt')
    try {
      // first response: parent conversation invoke subagent(background:true); its after to enough ordinary answer
      //(parent runId after end turn; subagent complete text and gather report round parent back should, who first consume all can).
      env.faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', {
            prompt: 'background isolated task: wait for release file after complete task',
            background: true,
            isolation: 'worktree',
            gate: `timeout 10 sh -c 'while ! test -f ${releaseFile}; do sleep 0.01; done'`,
          })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('background task already dispatch out, this turn end'),
        fauxAssistantMessage('subagent background complete'),
        fauxAssistantMessage('gather report round complete'),
        fauxAssistantMessage('gather report round fall back'),
      ])

      await kernel.submitInput(1, 'dispatch a background isolated subagent')
      await kernel.waitForIdle(1)

      // tool output should contains runId and worktree metadata (background handle).
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      const toolEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('"subagent"'))
      assert.ok(toolEntry, 'should store in subagent tool result')
      const toolText = JSON.stringify(toolEntry.model ?? '')
      const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
      assert.ok(runIdMatch, `tool output should contains runId:${toolText.slice(0, 400)}`)
      const runId = runIdMatch[1]!

      // background run phase:run running; sub-conversation already create, enter gate(blocked=gate wait for),
      // parent turn already end (parent idle does not mean sub- end - - first end semantics).
      let run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'running', `background run should be running, got ${run.status}`)
      const child = kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'background sub-conversation should already derive')
      const childCwd = child.cwd
      assert.ok(existsSync(childCwd), 'background sub-conversation should bind set real isolated tree')

      // run in clean up reject (gate occupy + run in-flight;force do not bypass in use check).
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: child.id, force: true }),
        (err: unknown) =>
          err instanceof HelmError && (err.code === 'worktree_in_use' || err.code === 'worktree_execution_unknown'),
      )
      assert.ok(existsSync(childCwd), 'run in reject clean up when directory must not passively')

      // release gate: write release file, wait for run settle and parent conversation back report round complete.
      writeFileSync(releaseFile, 'release\n')
      // wait for terminal state: polling inspect action.
      for (let i = 0; i < 600; i++) {
        run = (await env.invoke.inspect(runId)).run
        if (run.status !== 'running') break
        await new Promise((r) => setTimeout(r, 20))
      }
      // key wait for: terminal state visible ≠ gather report already delivery. engine settle chain in terminal state after also want execute
      // onBackgroundAgentSettled(to parent conversation submitInput gather report) - -inspect see to terminal state
      // when the step may still in-flight. must etc. to real gather report entry after again continue.
      let reported = false
      for (let i = 0; i < 600; i++) {
        const hits = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
        if (hits.length > 0) {
          reported = true
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(reported, `background gather report entry should in row boundary inside reach (runId=${runId},status=${run.status})`)
      // gather report entry reach after etc. parent turn consume completely (gather report round model back should), again verify idempotent exactly a.
      await kernel.waitForIdle(1)

      run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'completed', `release gate after run should completed, got ${run.status}${run.error ? `(error: ${run.error})` : ''}`)

      // gather report input: exactly a origin=agent,meta.backgroundRunId=runId  helm.input.
      const reports = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `should exactly a background gather report, got ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent')
      // gather report content contains runId and worktree managed id(person class can based on this resume/clean up).
      const reportTexts = (await kernel.getConversationDetail(1, { limit: 200 })).entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => String((e.data as { text?: unknown } | undefined)?.text ?? ''))
        .filter((t) => t.includes(runId))
      assert.ok(reportTexts.length >= 1, 'gather report text should contains runId')
      // gather report text should contain managed worktree id from structured execution.worktree.id.
      const toolMsg = (toolEntry.model as Array<{ content?: Array<{ text?: string }> }> | undefined)?.[0]
      const parsedTool = JSON.parse(toolMsg?.content?.[0]?.text ?? '{}') as { execution?: { worktree?: { id?: string } } }
      const wtId = parsedTool.execution?.worktree?.id
      assert.ok(typeof wtId === 'string' && wtId.length > 0, `tool output should contain execution.worktree.id:${toolText.slice(0, 300)}`)
      assert.ok(
        reportTexts.some((t) => t.includes(wtId)),
        `gather report should contains managed worktree id ${wtId}`,
      )
    } finally {
      // guard against clean up deadlock: regardless of assertion into failed all release gate and wait for terminal state after again closure stop.
      try {
        writeFileSync(releaseFile, 'release\n')
        await kernel.waitForIdle(1).catch(() => {})
      } catch {
        /* finally exhaust force */
      }
      await env.close()
    }
  })
})
