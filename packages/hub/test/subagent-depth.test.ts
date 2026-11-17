/**
 * Subagent nesting depth contract: `builtin:workflow` managed subagents can nest up to 2 levels by default.
 *
 * Source of truth (persisted across restarts): plugin-private doc `subagent-conversations` registers child
 * conversations spawned through the `agent_spawn` pipeline (`onResolved` returns `conversationId`),
 * recording `depth` / `parentConversationId` / `maxSubagentDepth` (subtree ceiling snapshot).
 * Forked conversations and SuperAgent workers (created via `createConversation`, bypassing `spawn`)
 * stay outside the registry and are not subject to nesting caps. Missing/corrupt entries fail explicitly.
 *
 * Three enforcement layers:
 * 1. `before_turn`: strips `subagent` / `SubagentWorkflow` on leaf turns at the subtree ceiling
 *    (depth-1 subagents keep dispatch tools so they can dispatch depth-2 children);
 * 2. Tool/action boundaries: `subagent` tool, `SubagentWorkflow` tool, and `run` action reject before creating
 *    any run record (`HelmError('subagent_depth_exceeded')`, carrying facts);
 * 3. `agent_spawn` highest-priority fallback (priority 300, ahead of isolation=200 worktree allocation):
 *    direct `kernel.spawnAgent` calls also reject without recording new entries.
 *
 * Explicit grants: `AgentSpawnRequest.maxSubagentDepth` (and `subagent` tool param) can grant a subtree ceiling
 * (1..5), while managed subagents cannot raise their inherited ceiling; plugin config exposes a global default.
 *
 * Honesty discipline: all real execution (faux model, real child conversations, real doc persistence, real
 * restarts), no mocked engine, no fabricated rejection results.
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { withWorkflowSpawnMeta } from '@helm/plugins/contracts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { makeFauxProvider, type FauxProviderHandle } from './helpers/hub-test-env.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-subagent-depth-test-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** Reads the persisted private registry directly from `state.sqlite` after flushing (verifies restart source of truth). */
function readRegistryRaw(dataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = ?")
      .get('builtin:workflow:subagent-conversations') as { value: string } | undefined
    if (row === undefined) return {}
    return JSON.parse(row.value) as Record<string, unknown>
  } finally {
    db.close()
  }
}

/** Writes plugin private doc directly (for testing corrupt records after closing app). */
function writePluginDocRaw(dataDir: string, name: string, value: unknown): void {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'))
  try {
    db.prepare(
      `INSERT INTO helm_plugin_docs (plugin_id, name, value, updated_at) VALUES ('__global', ?, ?, ?)
       ON CONFLICT(plugin_id, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(name, JSON.stringify(value), Date.now())
  } finally {
    db.close()
  }
}

/** Helper to read and assert a registry entry (`depth` / `parentConversationId` / `maxSubagentDepth`). */
function registryEntry(dataDir: string, conversationId: number): Record<string, unknown> {
  const raw = readRegistryRaw(dataDir)[String(conversationId)]
  assert.ok(raw !== undefined && typeof raw === 'object', `conversation ${conversationId} should be registered in subagent-conversations`)
  return raw as Record<string, unknown>
}

/**
 * Spawns a real child conversation chain (matching production `onResolved` + registry behavior):
 * each entry in `parents` acts as parent for the next spawned child; returns created child IDs.
 */
async function spawnChain(
  app: Awaited<ReturnType<typeof createHelm>>,
  faux: FauxProviderHandle,
  parents: number[],
): Promise<number[]> {
  const created: number[] = []
  for (const parent of parents) {
    let childId: number | undefined
    faux.setResponses([fauxAssistantMessage(`subagent ${parent} answer`)])
    await app.kernel.spawnAgent({
      parentConversationId: parent,
      prompt: `from ${parent} derive`,
      onResolved: (info) => {
        if (info.conversationId !== undefined) childId = info.conversationId
      },
    })
    assert.ok(childId !== undefined, `should spawn child from ${parent} and return conversationId`)
    created.push(childId)
  }
  return created
}



// ---------------------------------------------------------------------------
// 1. Depth 1 from top-level: fact registration + depth-1 subagent retains dispatch tools
// ---------------------------------------------------------------------------

describe('workflow subagent depth contract (default ceiling 2)', { timeout: 60_000 }, () => {
  test('top-level spawn depth=1: records depth/parent/ceiling=2; depth-1 subagent keeps subagent/SubagentWorkflow', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth1')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Top-level: spawn a subagent (real native spawn, real child conversation, synchronous wait).
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'sub- task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('subagent answer'),
        fauxAssistantMessage('main turn complete'),
      ])
      await app.kernel.submitInput(1, 'derive subagent')
      await app.kernel.waitForIdle(1)

      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'top-level spawn should create a real child conversation')

      // Registry: private doc persists depth fact (survives restart).
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child.id)
      assert.equal(entry['depth'], 1, 'direct child of top-level conversation has depth=1')
      assert.equal(entry['parentConversationId'], 1)
      assert.equal(entry['maxSubagentDepth'], 2, 'default subtree ceiling is 2')

      // Depth-1 subagent `before_turn`: dispatch tools are preserved (can still dispatch depth-2).
      let childTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: 'deep observer',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child.id) {
              childTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('one layer subagent directly answer')])
      await app.kernel.submitInput(child.id, 'subagent by mention question')
      await app.kernel.waitForIdle(child.id)
      assert.ok(childTools, 'should observe tool list on subagent turn')
      assert.ok(
        childTools!.includes('subagent') && childTools!.includes('SubagentWorkflow'),
        `depth-1 subagent turn should retain dispatch tools (actual: ${childTools!.join(',')})`,
      )
      assert.ok(childTools!.includes('bash'), 'non-dispatch tools stay intact (bash present)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. Depth-1 subagent spawns depth-2 child: depth=2 recorded; depth-2 turn strips dispatch tools
  // -------------------------------------------------------------------------

  test('depth-1 subagent spawns depth-2 via subagent tool: records depth=2; depth-2 strips dispatch tools', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth2')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Deterministic FIFO consumption order for synchronous nested spawns:
      // top-level toolUse(subagent) -> depth-1 toolUse(subagent) -> depth-2 text -> depth-1 text -> top-level text.
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'one layer task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'two layer task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('two layer subagent answer'),
        fauxAssistantMessage('one layer subagent complete'),
        fauxAssistantMessage('main turn complete'),
      ])
      await app.kernel.submitInput(1, 'derive one layer, let it continue dispatch two layer')
      await app.kernel.waitForIdle(1)

      const child1 = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child1, 'should spawn depth-1 child conversation')
      await app.kernel.waitForIdle(child1.id)
      const child2 = app.kernel.listConversations().find((c) => c.parentConversationId === child1.id)
      assert.ok(child2, 'depth-1 subagent should spawn depth-2 child conversation via tool')

      await app.kernel.documentStore.flush()
      const e1 = registryEntry(dir, child1.id)
      assert.equal(e1['depth'], 1)
      assert.equal(e1['parentConversationId'], 1)
      const e2 = registryEntry(dir, child2.id)
      assert.equal(e2['depth'], 2, 'depth-2 subagent has depth=2')
      assert.equal(e2['parentConversationId'], child1.id)
      assert.equal(e2['maxSubagentDepth'], 2, 'subtree ceiling inherits parent effective ceiling')

      // Depth-2 `before_turn`: dispatch tools are stripped at the ceiling (leaf).
      let leafTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: 'deep observer',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child2.id) {
              leafTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('two layer leaf only can directly answer')])
      await app.kernel.submitInput(child2.id, 'leaf by mention question')
      await app.kernel.waitForIdle(child2.id)
      assert.ok(leafTools, 'should observe tool list on depth-2 turn')
      assert.ok(
        !leafTools!.includes('subagent') && !leafTools!.includes('SubagentWorkflow'),
        `depth-2 subagent turn should strip dispatch tools (actual: ${leafTools!.join(',')})`,
      )
      assert.ok(leafTools!.includes('bash'), 'non-dispatch tools stay intact (bash present)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. Depth-2 rejection: spawnAgent fallback + run action entry, zero side effects
  // ---------------------------------------------------------------------------

  test('depth-2 rejects further spawns (403 subagent_depth_exceeded) and run actions with no run records; depth-1 still allowed', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth3')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      const child2 = (await spawnChain(app, faux, [child1]))[0]!

      // Direct call (with `isolation: 'worktree'` — must reject prior to worktree allocation with zero git/lease side effects).
      await assert.rejects(
        () =>
          app.kernel.spawnAgent({
            parentConversationId: child2,
            prompt: 'attempt dispatch three layer',
            isolation: 'worktree',
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `expected HelmError (got ${String(err)})`)
          assert.equal(err.code, 'subagent_depth_exceeded')
          assert.equal(err.status, 403)
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 2, 'error details should report depth=2')
          assert.equal(details?.maxSubagentDepth, 2)
          return true
        },
      )

      // `run` action (HTTP/CLI path) targeting depth-2 conversation rejects.
      await assert.rejects(
        () =>
          app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
            script: 'export const meta = { name: "t", description: "d" }\nreturn 1',
            conversationId: child2,
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )

      // Zero run records created.
      const runs = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
        runs: Array<{ id: string }>
      }
      assert.equal(runs.runs.length, 0, 'rejected path must not create run records')

      // Depth-1 control: direct `spawnAgent` succeeds (depth-1 can spawn depth-2).
      const anotherChild2 = (await spawnChain(app, faux, [child1]))[0]!
      assert.ok(anotherChild2 > 0)
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, anotherChild2)['depth'], 2)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 4. Depth-1 subagent can run workflows (`run` action allowed); engine nodes register at depth=2
  // -------------------------------------------------------------------------

  test('depth-1 subagent can run SubagentWorkflow: run action succeeds and engine node registers at depth=2', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth4')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      faux.setResponses([fauxAssistantMessage('engine node subagent answer')])
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script:
          'export const meta = { name: "nested-one", description: "d" }\nconst t = await agent("node task")\nreturn t',
        conversationId: child1,
        wait: true,
      })) as { run: { status: string; result: unknown; nodes?: Array<{ conversationId?: number }> } }
      assert.equal(run.run.status, 'completed', JSON.stringify(run.run))
      const nodeConv = run.run.nodes?.find((n) => n.conversationId !== undefined)?.conversationId
      assert.ok(nodeConv, 'engine node should spawn a real child conversation')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, nodeConv)
      assert.equal(entry['depth'], 2, 'engine node spawned from depth-1 registers with depth=2')
      assert.equal(entry['parentConversationId'], child1)
      // Depth-2 node is a leaf: direct `spawnAgent` rejects.
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: nodeConv, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 5. Background rejection contract: managed subagent (`helm`-owned) rejects explicit `background: true`
  // -------------------------------------------------------------------------

  test('managed subagent rejects explicit background: true with no spawn/run; sync default continues working', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth5')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      // Depth-1 subagent is a `helm`-owned autonomous conversation: explicit `background: true` must fail
      // without silently downgrading to sync, spawning a child, or creating a run (prevents premature parent return).
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'by refuse background task', background: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('one layer continue answer'),
      ])
      await app.kernel.submitInput(child1, 'dispatch a background subagent')
      await app.kernel.waitForIdle(child1)

      const detail = await app.kernel.getConversationDetail(child1, { limit: 30 })
      const toolText = [...detail.entries]
        .reverse()
        .map((e) => JSON.stringify(e.model ?? ''))
        .find((t) => t.includes('"subagent"')) ?? ''
      assert.ok(
        toolText.includes('subagent_failed') && toolText.includes('background'),
        `rejection message should state that background is disallowed: ${toolText.slice(0, 300)}`,
      )
      const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {
        conversationId: child1,
      })) as { runs: Array<{ id: string; kind?: string }> }
      assert.equal(runs.length, 0, 'rejected call must not create any run record')
      assert.equal(
        app.kernel.listConversations().filter((c) => c.parentConversationId === child1).length,
        0,
        'rejected call must not spawn a child conversation',
      )

      // Default (omitting `background`) on the same managed conversation stays synchronous and waits for the result.
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'sync two layer task' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('sync two layer answer'),
        fauxAssistantMessage('one layer sync continue answer'),
      ])
      await app.kernel.submitInput(child1, 'again dispatch a sync subagent')
      await app.kernel.waitForIdle(child1)
      const child2 = app.kernel.listConversations().find((c) => c.parentConversationId === child1)
      assert.ok(child2, 'default sync invocation should spawn depth-2 child conversation')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child2.id)
      assert.equal(entry['depth'], 2, 'sync depth-2 subagent also registers with depth=2')

      // Depth-2 subagent is a leaf: direct `spawnAgent` rejects.
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child2.id, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 6. Forked conversations are not misclassified
  // -------------------------------------------------------------------------

  test('forked conversations (with parentConversationId) are unaffected: spawn and run actions remain available', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth6')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Complete one top-level turn to obtain a forkable entry.
      faux.setResponses([fauxAssistantMessage('top-level answer')])
      await app.kernel.submitInput(1, '你好')
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 10 })
      const numericEntry = detail.entries.find((e) => Number.isInteger(Number(e.id)) && Number(e.id) > 0)
      assert.ok(numericEntry, 'should have a forkable entry (numeric entryId)')
      const entryId = Number(numericEntry!.id)

      const forked = await app.kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'forked conversation carries parentConversationId')

      // Fork is outside the registry: both `spawnAgent` and `run` action succeed.
      faux.setResponses([fauxAssistantMessage('fork subagent answer')])
      const spawned = await app.kernel.spawnAgent({
        parentConversationId: forked.id,
        prompt: 'fork conversation normal derive',
      })
      assert.ok(spawned !== undefined)
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script: 'export const meta = { name: "fork-ok", description: "d" }\nreturn 7',
        conversationId: forked.id,
        wait: true,
      })) as { run: { status: string; result: unknown } }
      assert.equal(run.run.status, 'completed')
      assert.equal(run.run.result, 7)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 7. SuperAgent workers are not misclassified (have parentConversationId, but bypass spawn)
  // -------------------------------------------------------------------------

  test('SuperAgent workers are unaffected: dispatch_worker conversations can spawn subagents normally', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth7')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      await app.kernel.plugins.enable('builtin:superagent')
      const dispatched = (await app.kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
        prompt: 'worker task',
        profileId: 'assistant',
      })) as { workerConversationId: number }
      const worker = app.kernel.getConversation(dispatched.workerConversationId)
      assert.equal(worker.parentConversationId !== undefined, true, 'worker has parentConversationId')

      // Worker is outside the registry: `spawnAgent` succeeds.
      faux.setResponses([fauxAssistantMessage('worker derive subagent answer'), fauxAssistantMessage('worker turn complete')])
      const spawned = await app.kernel.spawnAgent({
        parentConversationId: worker.id,
        prompt: 'worker normal derive',
      })
      assert.ok(spawned !== undefined)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 8. Restart restoration: depth/parent facts persist across restarts
  // -------------------------------------------------------------------------

  test('restart restoration: depth facts persist across restarts (depth-2 still rejects, depth-1 can still spawn)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth8')
    {
      const faux = makeFauxProvider()
      const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        await spawnChain(app, faux, [child1])
      } finally {
        await app.close()
      }
    }
    // Restart on the same `dataDir`: registry facts remain in effect.
    {
      const faux = makeFauxProvider()
      const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child1, 'depth-1 child conversation should restore after restart')
        const child2 = app.kernel
          .listConversations()
          .find((c) => c.parentConversationId === child1.id)
        assert.ok(child2, 'depth-2 child conversation should restore after restart')

        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: child2.id,
              prompt: 'after restart dispatch three layer',
            }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
        // Depth-1 control still allowed (can spawn a new depth-2 child after restart).
        const newChild2 = (await spawnChain(app, faux, [child1.id]))[0]!
        assert.ok(newChild2 > 0)
        await app.kernel.documentStore.flush()
        assert.equal(registryEntry(dir, newChild2)['depth'], 2)
      } finally {
        await app.close()
      }
    }
  })

  // -------------------------------------------------------------------------
  // 9. No legacy fallback: corrupt entries missing depth/ceiling fail explicitly
  // -------------------------------------------------------------------------

  test('corrupt registry entries missing depth facts fail explicitly without guessing', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth9')
    let legacyChildId = 0
    {
      const faux = makeFauxProvider()
      const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        legacyChildId = child1
        await app.kernel.documentStore.flush()
      } finally {
        await app.close()
      }
    }
    // Simulate legacy record by stripping new fields (`agentType`/`createdAt` only).
    {
      const registry = readRegistryRaw(dir)
      const legacy = registry[String(legacyChildId)] as Record<string, unknown>
      assert.ok(legacy, 'child conversation should have a registry entry')
      writePluginDocRaw(dir, 'builtin:workflow:subagent-conversations', {
        [String(legacyChildId)]: {
          ...(typeof legacy['agentType'] === 'string' ? { agentType: legacy['agentType'] } : {}),
          createdAt: legacy['createdAt'] ?? Date.now(),
        },
      })
    }
    const faux = makeFauxProvider()
    await assert.rejects(
      () => createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] }),
      /深度登记无效/,
    )
  })

  // -------------------------------------------------------------------------
  // 10. Explicit ceiling grant: `maxSubagentDepth=3` allows depth 3; invalid values reject
  // -------------------------------------------------------------------------

  test('explicit depth grant: maxSubagentDepth=3 permits depth 3 as leaf; descendants inherit ceiling', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth10')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      faux.setResponses([fauxAssistantMessage('one layer answer')])
      let grantedChild = 0
      await app.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'grant three layer sub- tree',
        meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: 3 }),
        onResolved: (info) => {
          if (info.conversationId !== undefined) grantedChild = info.conversationId
        },
      })
      assert.ok(grantedChild > 0, 'should spawn child conversation and return conversationId')
      const child1 = grantedChild
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child1)['maxSubagentDepth'], 3, 'registry should snapshot granted ceiling')
      assert.equal(registryEntry(dir, child1)['depth'], 1)

      // Full 3-level chain succeeds (1 -> 2 -> 3), with depth 3 as the leaf.
      const child2 = (await spawnChain(app, faux, [child1]))[0]!
      const child3 = (await spawnChain(app, faux, [child2]))[0]!
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child2)['maxSubagentDepth'], 3, 'descendant inherits subtree ceiling')
      assert.equal(registryEntry(dir, child3)['depth'], 3)
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child3, prompt: 'four layer attempt' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'subagent_depth_exceeded')
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 3)
          assert.equal(details?.maxSubagentDepth, 3)
          return true
        },
      )

      // Out-of-range / non-integer values reject explicitly without silent clamping.
      for (const invalid of [0, 6, 2.5]) {
        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: 1,
              prompt: 'invalid grant',
              meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: invalid as number }),
            }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError, `maxSubagentDepth=${invalid} should throw HelmError`)
            assert.equal(err.code, 'validation_error')
            return true
          },
        )
      }
      // Subagents cannot raise their inherited ceiling or override below target depth.
      for (const ceiling of [4, 1]) {
        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: child1,
              prompt: 'out of bounds authorization',
              meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: ceiling }),
            }),
          (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
        )
      }
      // Rejected paths record no new registry entries.
      await app.kernel.documentStore.flush()
      const registry = readRegistryRaw(dir)
      assert.equal(Object.keys(registry).length, 3, 'only the 3 valid chain entries should be registered')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 11. Global config updated via host port persists across restarts for new subtrees
  // -------------------------------------------------------------------------

  test('plugin config maxSubagentDepth persists across restarts and rejects invalid values', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth11')
    {
      const faux = makeFauxProvider()
      const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
        for (const invalid of [0, 99, 2.5, Number.NaN]) {
          await assert.rejects(
            () => app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: invalid }),
            /maxSubagentDepth|field maxSubagentDepth/,
            `invalid config value ${String(invalid)} should be rejected at persistence boundary`,
          )
        }
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2, 'invalid config must not corrupt valid config')
        await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: 1 })
        const child = (await spawnChain(app, faux, [1]))[0]!
        await assert.rejects(
          () => app.kernel.spawnAgent({ parentConversationId: child, prompt: 'exceeds global one layer' }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
      } finally {
        await app.close()
      }
    }
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1)
      const child = (await spawnChain(app, faux, [1]))[0]!
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child, prompt: 'after restart still over limit' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
      await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: null })
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
    } finally {
      await app.close()
    }
  })
})
