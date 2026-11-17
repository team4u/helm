/**
 * Real integration tests for worktree runtime (new contract: WorktreeAllocator / cleanup_worktree
 * belong entirely to the builtin:workflow plugin).
 *
 * Covers (via real createHelm + faux model + temporary real Git repo + plugin public API):
 * 1. Real spawnAgent isolation:'worktree' (agent_spawn continuation via builtin:workflow fallback):
 *    real isolated worktree creation, child conversation and gate running inside the tree,
 *    onResolved returning managed id; cleanup_worktree action preserves branch by default.
 * 2. Worktree and uncommitted artifacts preserved after gate failure / model failure / abort until explicit cleanup
 *    (regression guard against accidental deletion; gate failure & abort confirm child stop so run lease releases
 *    per §1.2 and force cleanup can succeed).
 * 3. Active subagent (spawn unsettled): cleanup force:true still returns worktree_in_use;
 *    cleanup via action succeeds after settling.
 * 4. Action boundary validation: unknown keys / multiple selectors / zero selectors / invalid types return 400
 *    (HTTP action Schema); unregistered selector passes through 404 not_found; action enforces 401 auth.
 * 5. External plugin agent_spawn handled returning worktree: unified registration of worktreeId,
 *    cleanup_worktree cleans up via the same mechanism; missing nodeId fails explicitly with execution_info_invalid;
 *    isolation requested when external runtime is unclaimed -> native execution fails with unsupported_runtime.
 * 6. Concurrent resume mutual exclusion on the same child conversation (subagent_in_use).
 * 7. Background report requestId idempotency (durable dedupe + preserved across restarts).
 * 8. Durable lease fail-closed safety invariant: leftover lease after crash/restart causes
 *    cleanup_worktree to fail explicitly with worktree_execution_unknown; after normal spawn succeeds,
 *    lease releases and cleanup succeeds.
 *
 * Contract discipline: does not use removed KernelRuntime.worktrees / cleanupWorktree;
 * verifies everything via real createHelm + builtin:workflow public actions/tools; lease assertions simulate
 * leftover disk state via the plugin's private durable doc (actual persisted content after process death).
 *
 * Honesty discipline: real SQLite + real pi-durable SDK + faux model script + real temporary Git repo +
 * real HTTP handler; never mock git or fabricate completion results.
 *
 * Runner: tsx --test; each test specifies timeout: 60_000 to guard against deadlocks.
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

/** Extract managed worktree descriptor (under the workflow namespace within execution meta). */
function worktreeOf(info: AgentExecutionInfo | undefined) {
  return info === undefined ? undefined : extractWorkflowExecutionMeta(info).worktree
}

/**
 * Platform fact: process occupancy scanning currently supports Linux /proc only. Non-Linux platforms
 * explicitly reject cleanup during process checks (worktree_process_check_failed) — test contracts branch
 * by platform without fabricating complete=true or silently skipping (explicit cross-platform rejection is the current behavior).
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** Assert on non-Linux platforms that cleanup rejects explicitly (never fabricates 0 processes). */
async function assertCleanupPlatformRejected(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'worktree_process_check_failed', 'non-Linux platform: process scan unsupported, cleanup must reject explicitly')
    return true
  })
}

// ---------------------------------------------------------------------------
// Test fixture helpers
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
  /** Real createHelm instance (builtin:workflow enabled by default). */
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  /** Real HTTP handler (authenticated with process token). */
  handler: (request: Request) => Promise<Response>
  token: string
  /** builtin:workflow public action entrypoints (shared pipeline with HTTP/CLI/model tools). */
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
  /** Plugin private durable document (for lease/registry leftover assertions and restart crash simulation). */
  pluginDoc: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush(): Promise<void>
  }
  close(): Promise<void>
}

/** Real createHelm (with builtin:workflow enabled by default) + faux provider + HTTP handler. */
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
      // Durable doc key per plugin: `${pluginId}:${name}` (global helm_plugin_docs namespace).
      get: <T>(key: string, initial: T): T =>
        kernel.documentStore.get<T>(`builtin:workflow:worktree-state:${key}`, initial),
      set: <T>(key: string, value: T): void =>
        kernel.documentStore.set(`builtin:workflow:worktree-state:${key}`, value),
      flush: () => kernel.documentStore.flush(),
    },
    async close() {
      // Controlled shutdown (do not mask test assertions on close errors; shutdown failures are tracked separately).
      await app.close().catch(() => {})
    },
  }
}

/** Invoke HTTP POST /api/actions/builtin:workflow/cleanup_worktree directly via handler (real auth + JSON parsing). */
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

/** Suspended faux response helper: notifies onEnter when reached, then waits for release. */
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

/** Read {origin, backgroundRunId} from all helm.input entries in a conversation. */
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
// 1. Real spawnAgent isolation:'worktree' end-to-end (continuation fallback)
// ---------------------------------------------------------------------------

describe('builtin:worktree isolated spawn (agent_spawn continuation)', { timeout: 60_000 }, () => {
  it('spawnAgent isolation:worktree: real isolated tree + managed id returned + gate runs in tree + action cleanup preserves branch by default', { timeout: 60_000 }, async () => {
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
        prompt: 'execute task in isolated worktree',
        isolation: 'worktree',
        gate: 'pwd > .helm-gate-pwd.txt && test -f README.md',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.equal(result, 'task complete:worktree inside execute done')

      // ---- onResolved returns managed worktree metadata (stable id). ----
      assert.ok(resolved, 'onResolved should return execution environment metadata')
      assert.equal(resolved!.nodeId, 'local')
      assert.ok(resolved!.conversationId !== undefined && resolved!.conversationId > 1, 'should spawn a real child conversation')
      const worktree = worktreeOf(resolved)
      assert.ok(worktree, 'isolation:worktree must return worktree metadata')
      assert.ok(worktree!.path.includes(join(dir, '.helm-worktrees')), `worktree should be in sibling .helm-worktrees: ${worktree!.path}`)
      assert.ok(worktree!.branch.startsWith('helm/spawn-'), `branch should be helm/spawn-*: ${worktree!.branch}`)
      assert.ok(typeof worktree!.id === 'string' && worktree!.id.length > 0, 'must return managed registry id (worktreeId)')

      // ---- Real isolated tree: child conversation and gate artifacts are inside the tree. ----
      assert.ok(existsSync(worktree!.path), 'worktree directory should exist on disk')
      assert.ok(existsSync(join(worktree!.path, 'README.md')), 'worktree should check out initial commit contents')
      assert.ok(existsSync(join(worktree!.path, '.helm-child-pwd.txt')), 'child conversation bash artifact should be inside worktree')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-pwd.txt'), 'utf8').trim(), worktree!.path, 'child conversation pwd should be the worktree directory')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-branch.txt'), 'utf8').trim(), worktree!.branch, 'child conversation should be on helm/spawn-* branch')
      assert.ok(existsSync(join(worktree!.path, '.helm-gate-pwd.txt')), 'gate artifact should be inside worktree')
      assert.equal(readFileSync(join(worktree!.path, '.helm-gate-pwd.txt'), 'utf8').trim(), worktree!.path, 'gate pwd should be the worktree directory (gate executes inside tree)')
      assert.ok(!existsSync(join(repo, '.helm-gate-pwd.txt')), 'source repo must not be polluted by gate/child conversation')
      const child = env.kernel.getConversation(resolved!.conversationId!)
      assert.equal(child.cwd, worktree!.path, 'child conversation mirror cwd should be the worktree directory')

      // ---- Cleanup (builtin:workflow public action; preserves branch by default). ----
      // Uncommitted artifacts in tree: explicit force discard (non-force dirty rejection is covered by native-worktree tests).
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          conversationId: resolved!.conversationId,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.worktreeId, worktree!.id, 'cleanup result should return managed worktreeId')
        assert.equal(cleaned.branchDeleted, false, 'default cleanup must preserve branch')
        assert.ok(!existsSync(worktree!.path), 'worktree directory should be removed after cleanup')
        const branchList = execFileSync('git', ['branch', '--list', worktree!.branch], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes(worktree!.branch), `branch ${worktree!.branch} should be preserved by default (got ${branchList.trim()})`)
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }))
        assert.ok(existsSync(worktree!.path), 'directory must not be removed when non-Linux rejects cleanup')
      }
    } finally {
      await env.close()
    }
  })

  it('native subagent tool chain: model invokes subagent(isolation:worktree) to create real isolated tree; tool output contains cleanup hint/worktreeId', { timeout: 60_000 }, async () => {
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
      assert.ok(toolEntry, 'subagent tool result entry should exist')
      const text = JSON.stringify(toolEntry.model ?? '')
      assert.ok(text.includes('worktree='), `tool output should contain worktree metadata: ${text.slice(0, 400)}`)
      assert.ok(text.includes('cleanup_worktree'), 'tool output should contain cleanup_worktree hint')
      assert.ok(text.includes('worktreeId='), 'tool output should contain managed worktreeId')

      // Real child conversation created inside real isolated tree (mirror cwd equals isolated tree path).
      const child = env.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'should spawn a real child conversation')
      assert.ok(child.cwd.includes(join(dir, '.helm-worktrees')), 'child conversation should execute inside sibling .helm-worktrees isolated tree')
      assert.ok(existsSync(child.cwd), 'managed worktree should exist on disk')
      assert.ok((await env.kernel.getLastAssistantText(1)).includes('main turn complete'))
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Preserving worktree & uncommitted artifacts after gate failure / model failure / abort (regression guard)
// ---------------------------------------------------------------------------

describe('failed-path artifact preservation (guard against continuation cleanup accidental deletion)', { timeout: 60_000 }, () => {
  it('gate failed: worktree preserved after child produces uncommitted files (for human inspection), gate_failed thrown explicitly', { timeout: 60_000 }, async () => {
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
            prompt: 'produce output then fail gate',
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
      assert.ok(worktreeOf(resolved), 'onResolved should have already returned worktree before gate failed')
      const wtPath = worktreeOf(resolved)!.path
      // Critical regression guard: gate failure (child conversation settled) never triggers accidental reclamation; directory and
      // uncommitted artifacts stay until explicit cleanup (preserved even after §1.2 lease release).
      assert.ok(existsSync(wtPath), 'worktree must be preserved after gate failure for human inspection')
      assert.ok(existsSync(join(wtPath, 'wip-artifact.txt')), 'child uncommitted artifact must be preserved')
      // §1.2 lease release: gate failed = native child turn already failed and confirmed stopped by host,
      // so run lease should release (keeping Worktree record and child conversation mapping); explicit force
      // cleanup is no longer blocked by worktree_execution_unknown and can remove the directory.
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          conversationId: resolved!.conversationId,
          force: true,
        })
        assert.equal(cleaned.removed, true, 'explicit force cleanup should succeed after lease release')
        assert.equal(cleaned.branchDeleted, false, 'default cleanup must preserve branch')
        assert.ok(!existsSync(wtPath), 'worktree directory should be removed after explicit cleanup (artifact discarded with directory after inspection)')
      } else {
        // Non-Linux: lease gate already cleared; rejection only comes from platform limit on process scanning.
        await assertCleanupPlatformRejected(() =>
          env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }),
        )
        assert.ok(existsSync(wtPath), 'directory must not be removed when non-Linux rejects cleanup')
      }
    } finally {
      await env.close()
    }
  })

  it('model turn failed (schema mismatch twice): worktree and existing uncommitted artifacts preserved', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2b')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        // Schema output tool does not replace native kernel tools; child can run real tasks first before submitting result.
        fauxAssistantMessage([fauxToolCall('bash', { command: 'printf "child prior work\\n" > partial.txt' })], { stopReason: 'toolUse' }),
        // Two rounds of plain text fail schema: triggers schema_validation_failed.
        fauxAssistantMessage('this is not JSON'),
        fauxAssistantMessage('still is not JSON'),
      ])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'requires structured output but model fails',
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
      // Key assertion: continuation cleanup must not reclaim an already-bound child isolated tree (regression guard).
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'worktree must be preserved after model failure')
      assert.ok(existsSync(preExisting), 'uncommitted artifact must be preserved')
    } finally {
      await env.close()
    }
  })

  it('aborted mid-run: worktree and uncommitted artifacts preserved after settling', { timeout: 60_000 }, async () => {
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
        prompt: 'isolated task to be aborted',
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
      assert.ok(worktreeOf(resolved), 'onResolved should return worktree before abort')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'cancel-marker.txt')), 'child conversation should have written artifact before abort')
      // Artifact write happens during round 1 tool call; wait until round 2 model request actually enters held
      // before aborting, preventing premature cancellation during round 1 under high suite concurrency.
      const heldDeadline = Date.now() + 10_000
      while (!entered && Date.now() < heldDeadline) await new Promise((r) => setTimeout(r, 25))
      assert.ok(entered, 'should have entered suspended model turn before abort')

      controller.abort()
      held.release(fauxAssistantMessage('must not as result'))
      await assert.rejects(() => pending, (err: unknown) => err instanceof HelmError && err.code === 'aborted')

      const childId = resolved!.conversationId!
      await env.kernel.waitForIdle(childId)
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'worktree must be preserved after abort (already bound to child conversation, must not be deleted)')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'cancel-marker.txt')), 'uncommitted artifact must be preserved after abort')
      assert.ok(entered)
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. In-use protection: force:true still returns worktree_in_use; cleanup allowed after settle
// ---------------------------------------------------------------------------

describe('in-use worktree cleanup protection', { timeout: 60_000 }, () => {
  it('while model turn is active: force:true still returns worktree_in_use; cleanup via action succeeds after settle', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const held = heldResponse(() => {})
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo ok > in-use-marker.txt' })], { stopReason: 'toolUse' }),
        // Second turn suspends inside model request: SDK turn in-flight.
        held.step as never,
      ])
      let resolved: AgentExecutionInfo | undefined
      const controller = new AbortController()
      const pending = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'long task (occupancy check)',
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
      assert.ok(worktreeOf(resolved) && resolved?.conversationId, 'child conversation should be created')
      const childId = resolved!.conversationId!
      assert.equal(env.kernel.getConversation(childId).status, 'working', 'child conversation should be working while model is suspended')

      // Spawn unsettled: both conversation occupancy and in-flight spawn execution pose dual-reference risks;
      // even force:true must not clean up a running subagent's worktree.
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: childId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_in_use', `force cleanup of active worktree should reject, got ${(err as HelmError).code}`)
          return true
        },
      )
      assert.ok(existsSync(worktreeOf(resolved)!.path), 'directory must remain untouched when in-use check rejects')
      assert.ok(existsSync(join(worktreeOf(resolved)!.path, 'in-use-marker.txt')), 'artifacts must not be deleted while in use')

      // Clean shutdown: release model + abort, wait for spawn settle and child conversation idle.
      controller.abort()
      held.release(fauxAssistantMessage('(cancel)'))
      await assert.rejects(() => pending, (e: unknown) => e instanceof HelmError && e.code === 'aborted')
      await env.kernel.waitForIdle(childId)

      // After settle (abort path: native child turn failed and already confirmed stopped):
      // §1.2 run lease releases, so explicit force cleanup is no longer blocked by worktree_execution_unknown
      // and can remove the directory (branch preserved by default).
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({ conversationId: childId, force: true })
        assert.equal(cleaned.removed, true, 'after abort confirms stop, lease releases and force cleanup succeeds')
        assert.equal(cleaned.branchDeleted, false, 'default cleanup must preserve branch')
        assert.ok(!existsSync(worktreeOf(resolved)!.path), 'worktree directory should be removed after explicit cleanup')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: childId, force: true }))
        assert.ok(existsSync(worktreeOf(resolved)!.path), 'directory must not be removed when non-Linux rejects cleanup')
      }
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Action boundary validation (HTTP action Schema + auth + error code passthrough)
// ---------------------------------------------------------------------------

describe('cleanup_worktree action boundary (HTTP Schema / auth / passthrough)', { timeout: 60_000 }, () => {
  it('action boundary validation: unknown keys / multiple / zero selectors / invalid types return 400; unregistered selector returns 404 without triggering actual cleanup', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4a')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // Unknown key rejected (action inputSchema additionalProperties:false).
      const unknownKey = await postCleanup(env, { conversationId: 5, oops: true })
      assert.equal(unknownKey.status, 400)
      assert.equal(unknownKey.json.error.code, 'validation_error')

      // Multiple selectors rejected (conversationId + path).
      const multiA = await postCleanup(env, { conversationId: 5, path: '/tmp/x' })
      assert.equal(multiA.status, 400)
      assert.equal(multiA.json.error.code, 'validation_error')
      // Zero selectors rejected as well.
      const none = await postCleanup(env, {})
      assert.equal(none.status, 400)
      assert.equal(none.json.error.code, 'validation_error')

      // Invalid types: non-positive-int conversationId / non-boolean force / non-boolean deleteBranch
      // (rejected at action JSON Schema boundary).
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

      // Unregistered selector: syntactically valid selector with no record -> 404 not_found (user error,
      // does not masquerade as validation failure; never deletes unregistered directories).
      const unregistered = await postCleanup(env, { worktreeId: 'local:/tmp/no-such-wt' })
      assert.equal(unregistered.status, 404)
      assert.equal(unregistered.json.error.code, 'not_found')
    } finally {
      await env.close()
    }
  })

  it('successful invocation runs actual cleanup (removes real worktree, threads worktreeId); unregistered selector passes through 404 not_found', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4b')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // Spawn a clean managed worktree (no dirty artifacts, testing non-force success path).
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('complete')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'HTTP cleanup path task',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved) && worktreeOf(resolved)?.id, 'should return managed worktree id')
      const wt = worktreeOf(resolved)!

      // Cleanup by managed id succeeds (worktreeId exact selector; deleteBranch preserves branch by default).
      const ok = await postCleanup(env, { worktreeId: wt.id })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.removed, true)
      assert.equal(ok.json.branchDeleted, false)
      assert.equal(ok.json.path, wt.path)
      assert.ok(!existsSync(wt.path), 'HTTP cleanup should remove the worktree directory')

      // Unregistered selector: allocator's not_found (404) passes through as-is (not disguised as 500/200).
      const missing = await postCleanup(env, { conversationId: 999_999 })
      assert.equal(missing.status, 404)
      assert.equal(missing.json.error.code, 'not_found')
      assert.ok(String(missing.json.error.message).includes('未找到'), `error message should indicate only registered records can be cleaned: ${missing.json.error.message}`)
    } finally {
      await env.close()
    }
  })

  it('missing token returns 401 (action endpoints enforce authentication)', { timeout: 60_000 }, async () => {
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
// 5. External plugin agent_spawn handled: unified registration and explicit rejection
// ---------------------------------------------------------------------------

describe('external plugin agent_spawn handled and unified worktree registration', { timeout: 60_000 }, () => {
  it('allows plugin returning nodeId/executionId/worktree from real temp git worktree: unified worktreeId registration and shared cleanup_worktree mechanism (test boundary: custom stub plugin, not real Herdr)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5a')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // Plugin runs task inside a real git worktree (real git command, not a mock dir).
      const wtPath = join(dir, '.helm-worktrees', 'external-task')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-external-1', wtPath, 'HEAD'], { cwd: repo })
      writeFileSync(join(wtPath, 'external-result.txt'), 'done\n')

      await env.kernel.plugins.register({
        id: 'test:external-runtime',
        name: 'external runtime (test stub: returns real git worktree)',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            // namespace:kind format = external runtime (builtin:workflow does not pre-allocate,
            // only backfills registry and lease, handing full execution responsibility to this handler).
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

      // Unified registration: rewritten by onResolved into a managed record (with stable id).
      assert.ok(worktreeOf(resolved)?.id, 'externally returned worktree should be uniformly registered and backfilled with a stable id')
      assert.ok(worktreeOf(resolved)!.id!.startsWith('local:'), `managed id should have nodeId:path format: ${worktreeOf(resolved)!.id}`)

      // Cleanup uses the same mechanism as native: unified registry record can be located and cleaned up (helm/wf-* managed prefix).
      // (External handled path completed cleanly: lease released per contract, eligible for cleanup.)
      // Note: omit deleteBranch here — currently allocator updateRecord writes branchDeleteError: undefined
      // on the deleteBranch success branch, which doc-layer jsonClone rejects (covered separately in native-worktree.test.ts).
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          worktreeId: worktreeOf(resolved)!.id!,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.branchDeleted, false, 'default cleanup preserves branch')
        assert.ok(!existsSync(wtPath), 'cleanup should remove the external worktree')
        const branchList = execFileSync('git', ['branch', '--list', 'helm/wf-external-1'], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes('helm/wf-external-1'), 'branch should be preserved by default')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ worktreeId: worktreeOf(resolved)!.id!, force: true }))
        assert.ok(existsSync(wtPath), 'directory must not be removed when non-Linux rejects cleanup')
      }
    } finally {
      await env.close()
    }
  })

  it('returns worktree without nodeId: rejects explicitly with execution_info_invalid (never assumes local)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5c')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await env.kernel.plugins.register({
        id: 'test:no-node-runtime',
        name: 'runtime missing nodeId',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:no-node') return next(request) as unknown as void
            // Missing nodeId: must not assume local.
            request.onResolved?.({ executionId: 'exec-no-node', meta: { 'builtin:workflow': { worktree: { path: '/srv/wt/x', branch: 'helm/wf-x' } } } })
            return { action: 'handled', result: 'false succeeded: without node' }
          })
        },
      })
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'returned without node',
            agentType: 'test:no-node',
            isolation: 'worktree',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'execution_info_invalid')
          assert.ok(err.message.includes('nodeId'), `error should state missing nodeId: ${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('unclaimed external runtime agentType: native execution line throws unsupported_runtime (zero hardcoded plugin names, never silent fallback)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5d')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'external runtime with no handler',
            agentType: 'test:unclaimed',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `should throw HelmError, got ${err}`)
          assert.equal(err.code, 'unsupported_runtime')
          assert.ok(err.message.includes('test:unclaimed'), `error should reference external runtime identifier: ${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Concurrent resume mutual exclusion on the same child conversation (gate/structured output isolation)
// ---------------------------------------------------------------------------

describe('concurrent resume mutual exclusion on same child conversation', { timeout: 60_000 }, () => {
  it('second concurrent resume while first is in-flight returns subagent_in_use; first gate and structured output complete normally', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // First call: create a child conversation bound to a worktree.
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
      assert.ok(firstWtPath !== '', 'should return isolated tree path')

      // First resume: writes marker + structured output + gate (model held open to create in-flight window).
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
        prompt: 'first resume',
        resume: String(childId),
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        gate: 'test -f first-resume.txt',
        onResolved: () => {},
      } as AgentSpawnRequest)

      // Wait for model to consume the first two responses and enter the held step before mutating faux queue.
      await Promise.race([
        entered,
        first.then(() => { throw new Error('first resume ended before entering held response') }),
      ])
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')), 'first resume should execute inside the original worktree')

      // Concurrent second resume: same child conversation in-flight -> rejects explicitly (never races gate/structured output).
      env.faux.setResponses([fauxAssistantMessage('second resume must not execute')])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: 'second resume (concurrent)',
            resume: String(childId),
            gate: 'true',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'subagent_in_use')
          return true
        },
      )

      // Release first: structured output and gate complete cleanly without interference from second.
      held.release(fauxAssistantMessage('tail follow text'))
      const result = await first
      assert.deepEqual(result, { answer: 'a resume answer proposal' }, 'first resume structured output should return intact')
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')))
      // Only this single child conversation exists throughout (concurrent rejection does not spawn a duplicate).
      const children = env.kernel.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, 'concurrent rejection must not spawn a new child conversation')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Background report requestId idempotency (durable requestId + in-process singleflight)
// ---------------------------------------------------------------------------

describe('background report requestId idempotency (same mechanism as builtin:workflow delivery)', { timeout: 60_000 }, () => {
  it('3 concurrent + post-terminal duplicate calls produce only one helm.input with origin=agent and meta.backgroundRunId=runId; deduped durably across restart', { timeout: 60_000 }, async () => {
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
      // Faux gives only one response: a duplicate delivery would trigger a second model request and fail due to empty queue.
      env.faux.setResponses([fauxAssistantMessage('parent conversation receives back report after answer')])
      await Promise.all([deliver(), deliver(), deliver()])
      await env.kernel.waitForIdle(1)
      // Duplicate call after terminal state: intercepted by durable submissionByRequest.
      await deliver()

      const reports = (await agentReports(env.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `same runId should deliver only one report, got ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent', 'report input origin must be agent')

      // Corroboration: faux was requested exactly once (duplicate delivery would cause callCount > 1).
      assert.equal(env.faux.state.callCount, 1, `parent conversation model should be called once, got ${env.faux.state.callCount}`)
    } finally {
      await env.close()
    }

    // Reopen same dataDir: SDK durable submissionByRequest deduplicates across restarts.
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
      assert.equal(reports.length, 1, `duplicate report after restart must not produce a second helm.input, got ${JSON.stringify(reports)}`)
    } finally {
      await reopened.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Durable lease fail-closed safety invariant: leftover lease after crash blocks cleanup
// ---------------------------------------------------------------------------

describe('durable lease unknown-occupancy protection (fail-closed)', { timeout: 60_000 }, () => {
  it('when leftover lease exists (crash/restart simulation), cleanup_worktree throws worktree_execution_unknown; after normal spawn succeeds, lease releases and cleanup succeeds', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // Real worktree (external registration format, simulating an external runtime such as Herdr).
      const wtPath = join(dir, '.helm-worktrees', 'lease-check')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-lease-1', wtPath, 'HEAD'], { cwd: repo })

      // Write leftover lease + allocator registry directly to the plugin's private durable doc
      // (simulating execution started -> process died -> restarted with no in-flight state).
      // Matches doc structure: worktree-state nested map with allocator key 'runtime/worktrees'
      // ({version, records}) and lease table 'worktree-leases'.
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

      // Unknown occupancy: cannot prove underlying process (e.g. remote Herdr) stopped; rejected even with force (prevents deleting an active dir).
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_execution_unknown')
          assert.ok(err.message.includes('不能清理'), `error should direct user to inspect / manually clean up: ${err.message}`)
          return true
        },
      )
      assert.ok(existsSync(wtPath), 'directory must remain untouched when unknown occupancy rejects')

      // Normal native spawn (success path): lease registers and releases on settle, enabling subsequent cleanup.
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('lease release verify complete')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'success task (lease release)',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved), 'successful spawn should return worktree')
      const leases = env.pluginDoc.get<Record<string, { info?: AgentExecutionInfo }>>('worktree-leases', {})
      const leasePaths = Object.values(leases).map((l) => worktreeOf(l.info)?.path)
      assert.ok(
        !leasePaths.includes(worktreeOf(resolved)!.path),
        `lease should be released after successful settle, got ${JSON.stringify(leasePaths)}`,
      )
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true })
        assert.equal(cleaned.removed, true, 'cleanup should succeed after lease release')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true }))
      }
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. createHelm real background integration: subagent(background:true, isolation:worktree, gate)
// ---------------------------------------------------------------------------

describe('createHelm background subagent end-to-end (background + worktree + gate + parent turn ends first)', { timeout: 60_000 }, () => {
  it('while background run is active: run is running, child is in gate, cleanup rejects; after releasing gate, run settles and delivers idempotent summary with runId/worktree to parent', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't9')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    const kernel = env.kernel
    // Release file outside isolated tree (inside parent repo): gate inside worktree waits for external signal.
    const releaseFile = join(repo, '.helm-test-release.txt')
    try {
      // First response: parent invokes subagent(background:true), followed by enough normal assistant replies
      // (parent turn ends after returning runId; subagent completion and parent summary reply may consume in either order).
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

      // Tool output should contain runId and worktree metadata (background handle).
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      const toolEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('"subagent"'))
      assert.ok(toolEntry, 'subagent tool result should exist')
      const toolText = JSON.stringify(toolEntry.model ?? '')
      const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
      assert.ok(runIdMatch, `tool output should contain runId: ${toolText.slice(0, 400)}`)
      const runId = runIdMatch[1]!

      // During background run: run is running; child conversation created and in gate (blocked waiting),
      // while parent turn already finished (parent idle != child finished — parent-ends-first semantics).
      let run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'running', `background run should be running, got ${run.status}`)
      const child = kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'background child conversation should be spawned')
      const childCwd = child.cwd
      assert.ok(existsSync(childCwd), 'background child conversation should bind to a real isolated tree')

      // Cleanup rejected while running (gate holds + run in-flight; force does not bypass occupancy check).
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: child.id, force: true }),
        (err: unknown) =>
          err instanceof HelmError && (err.code === 'worktree_in_use' || err.code === 'worktree_execution_unknown'),
      )
      assert.ok(existsSync(childCwd), 'directory must remain untouched when cleanup rejects during run')

      // Release gate: write release file, wait for run to settle and parent report turn to complete.
      writeFileSync(releaseFile, 'release\n')
      // Poll inspect action until terminal status.
      for (let i = 0; i < 600; i++) {
        run = (await env.invoke.inspect(runId)).run
        if (run.status !== 'running') break
        await new Promise((r) => setTimeout(r, 20))
      }
      // Critical wait: terminal status visible != report delivered yet. Engine settle chain runs
      // onBackgroundAgentSettled (submitInput report to parent) after marking terminal — wait until actual entry arrives.
      let reported = false
      for (let i = 0; i < 600; i++) {
        const hits = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
        if (hits.length > 0) {
          reported = true
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(reported, `background report entry should arrive within timeout (runId=${runId}, status=${run.status})`)
      // Wait for parent turn to finish consuming report entry before verifying idempotent single delivery.
      await kernel.waitForIdle(1)

      run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'completed', `run should be completed after releasing gate, got ${run.status}${run.error ? `(error: ${run.error})` : ''}`)

      // Report input: exactly one helm.input with origin=agent and meta.backgroundRunId=runId.
      const reports = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `should have exactly one background report, got ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent')
      // Report content includes runId and managed worktree id (for human resume/cleanup).
      const reportTexts = (await kernel.getConversationDetail(1, { limit: 200 })).entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => String((e.data as { text?: unknown } | undefined)?.text ?? ''))
        .filter((t) => t.includes(runId))
      assert.ok(reportTexts.length >= 1, 'report text should contain runId')
      // Report text should contain managed worktree id (extracted from worktreeId=... in tool output,
      // handles paths containing / without character-class truncation).
      const toolMatch = /worktreeId=\\+"([^"\\\n]+)/.exec(toolText)
      assert.ok(toolMatch, `tool output should contain managed worktreeId: ${toolText.slice(0, 300)}`)
      assert.ok(
        reportTexts.some((t) => t.includes(toolMatch[1]!)),
        `report should contain managed worktree id ${toolMatch[1]}`,
      )
    } finally {
      // Guard against cleanup deadlock: release gate and wait for idle on any assertion failure before closing.
      try {
        writeFileSync(releaseFile, 'release\n')
        await kernel.waitForIdle(1).catch(() => {})
      } catch {
        /* best-effort in finally */
      }
      await env.close()
    }
  })
})
