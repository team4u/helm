/**
 * subagent embed set deep contract:builtin:workflow managed subagent by default can embed set 2 layer.
 *
 * fact source (across restarts durable): plugin private doc `subagent-conversations` register via
 * agent_spawn pipeline succeeded derive (onResolved back pass conversationId) sub-conversation,
 * item contains depth / parentConversationId / maxSubagentDepth(sub- tree cap snapshot);
 * fork conversation and SuperAgent worker(via createConversation create, do not via spawn
 * pipeline) does not enter table, do not subject to embed set restrict affect. register fact missing or corrupt when explicit reject.
 *
 * three path guard against line:
 * 1. before_turn: reach sub- tree cap leaf turn strip subagent / SubagentWorkflow
 *    (one layer subagent by default keep dispatch work tool, can continue dispatch two layer);
 * 2. tool/action entry:subagent tool,SubagentWorkflow tool,run action in create
 *    any run record before reject (HelmError subagent_depth_exceeded, carry fact);
 * 3. agent_spawn most high priority fall back (priority 300, first at isolation 200 
 *    worktree allocate): directly tune kernel.spawnAgent also by refuse and register new fact.
 *
 * explicit extend:AgentSpawnRequest.maxSubagentDepth(subagent tool reference same name segment)
 * grant sub- tree deep cap (1..5), managed subagent must not mention high inherit cap; host plugin config
 * provide global default value read write opening.
 *
 * honest discipline: all real execute (faux model, true sub-conversation, true doc persist, true
 * restart restore), do not mock engine, do not fabricate reject result.
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

/** read plugin private register table durable value (flush after from state.sqlite direct read, verify across restarts fact). */
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

/** direct write plugin private doc(app already on shutdown use; verify corrupt record explicit reject). */
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

/** register table item assertion auxiliary: archive one read depth / parentConversationId / maxSubagentDepth. */
function registryEntry(dataDir: string, conversationId: number): Record<string, unknown> {
  const raw = readRegistryRaw(dataDir)[String(conversationId)]
  assert.ok(raw !== undefined && typeof raw === 'object', `conversation ${conversationId} should register subagent-conversations table`)
  return raw as Record<string, unknown>
}

/**
 * derive a real sub-conversation chain (and produce path same construct:onResolved reference and register table record account):
 * parents in order is chain on parent conversation, return all new conversation id.
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
    assert.ok(childId !== undefined, `should from ${parent} derive sub-conversation and back pass conversationId`)
    created.push(childId)
  }
  return created
}



// ---------------------------------------------------------------------------
// 1. top-level derive one layer: fact register + one layer subagent keep dispatch work tool
// ---------------------------------------------------------------------------

describe('workflow subagent deep contract (by default cap 2)', { timeout: 60_000 }, () => {
  test('top-level conversation derive one layer: register depth=1/parent chain/sub- tree cap=2; one layer subagent turn keep subagent/SubagentWorkflow', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth1')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // top-level: derive a subagent (real original generate spawn, true sub-conversation; explicit sync wait for result).
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'sub- task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('subagent answer'),
        fauxAssistantMessage('main turn complete'),
      ])
      await app.kernel.submitInput(1, 'derive subagent')
      await app.kernel.waitForIdle(1)

      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'top-level derive should create true sub-conversation')

      // register table: private doc persist deep fact (across restarts can read).
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child.id)
      assert.equal(entry['depth'], 1, 'top-level directly derive one layer subagent depth=1')
      assert.equal(entry['parentConversationId'], 1)
      assert.equal(entry['maxSubagentDepth'], 2, 'default sub- tree cap is default value 2')

      // one layer subagent turn before_turn: dispatch work tool keep (by default can continue dispatch two layer).
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
      assert.ok(childTools, 'should observe to subagent turn tool manifest')
      assert.ok(
        childTools!.includes('subagent') && childTools!.includes('SubagentWorkflow'),
        `one layer subagent turn should keep dispatch work tool (actual:${childTools!.join(',')})`,
      )
      assert.ok(childTools!.includes('bash'), 'non- dispatch work tool do not subject to affect (bash still in)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. one layer subagent via real tool chain continue dispatch two layer: register depth=2; two layer turn strip dispatch work tool
  // -------------------------------------------------------------------------

  test('one layer subagent via subagent tool continue dispatch two layer: register depth=2/parent chain; two layer subagent turn strip dispatch work tool', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth2')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // model consume order (sync spawn one by one layer await, order determine):
      // top-level toolUse(subagent) → one layer subagent toolUse(subagent) → two layer subagent text
      // → one layer continue answer → top-level continue answer.
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
      assert.ok(child1, 'should derive one layer sub-conversation')
      await app.kernel.waitForIdle(child1.id)
      const child2 = app.kernel.listConversations().find((c) => c.parentConversationId === child1.id)
      assert.ok(child2, 'one layer subagent should via tool chain derive two layer sub-conversation')

      await app.kernel.documentStore.flush()
      const e1 = registryEntry(dir, child1.id)
      assert.equal(e1['depth'], 1)
      assert.equal(e1['parentConversationId'], 1)
      const e2 = registryEntry(dir, child2.id)
      assert.equal(e2['depth'], 2, 'two layer subagent depth=2')
      assert.equal(e2['parentConversationId'], child1.id)
      assert.equal(e2['maxSubagentDepth'], 2, 'sub- tree cap inherit parent conversation takes effect cap')

      // two layer subagent turn before_turn: dispatch work tool by strip (reach cap i.e. leaf).
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
      assert.ok(leafTools, 'should observe to two layer subagent turn tool manifest')
      assert.ok(
        !leafTools!.includes('subagent') && !leafTools!.includes('SubagentWorkflow'),
        `two layer subagent turn should strip dispatch work tool (actual:${leafTools!.join(',')})`,
      )
      assert.ok(leafTools!.includes('bash'), 'non- dispatch work tool do not subject to affect (bash still in)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. two layer reject:spawnAgent fall back + run action entry, all produces no side effect
  // -------------------------------------------------------------------------

  test('two layer subagent reject again derive:spawnAgent 403 subagent_depth_exceeded(contains fact);run action set to two layer by refuse and without run record; one layer compare group let through', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth3')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      const child2 = (await spawnChain(app, faux, [child1]))[0]!

      // direct tune (contains isolation:worktree - - must in worktree allocate before reject, produces no
      // any git side effect or lease record).
      await assert.rejects(
        () =>
          app.kernel.spawnAgent({
            parentConversationId: child2,
            prompt: 'attempt dispatch three layer',
            isolation: 'worktree',
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `should be HelmError(actual ${String(err)})`)
          assert.equal(err.code, 'subagent_depth_exceeded')
          assert.equal(err.status, 403)
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 2, 'error detail situation should carry depth=2 fact')
          assert.equal(details?.maxSubagentDepth, 2)
          return true
        },
      )

      // run action (HTTP/CLI same link) set to two layer conversation: reject.
      await assert.rejects(
        () =>
          app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
            script: 'export const meta = { name: "t", description: "d" }\nreturn 1',
            conversationId: child2,
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )

      // without new run record produce.
      const runs = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
        runs: Array<{ id: string }>
      }
      assert.equal(runs.runs.length, 0, 'reject path must not produce any run record')

      // one layer compare group: direct tune spawnAgent let through (one layer by default can continue dispatch two layer).
      const anotherChild2 = (await spawnChain(app, faux, [child1]))[0]!
      assert.ok(anotherChild2 > 0)
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, anotherChild2)['depth'], 2)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 4. one layer subagent can run workflow (run action let through), its engine node derive by depth record account
  // -------------------------------------------------------------------------

  test('one layer subagent can run SubagentWorkflow:run action let through, node derive sub-conversation register depth=2', { timeout: 60_000 }, async () => {
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
      assert.ok(nodeConv, 'engine node should real derive sub-conversation')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, nodeConv)
      assert.equal(entry['depth'], 2, 'one layer conversation run engine node derive register depth=2')
      assert.equal(entry['parentConversationId'], child1)
      // two layer node is leaf: direct tune spawnAgent by refuse.
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: nodeConv, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 5. background reject contract: managed subagent (helm-owned) explicit background:true by explicit reject
  // -------------------------------------------------------------------------

  test('managed subagent explicit background:true: explicit reject (guard against early compute), do not derive, do not create run; sync default still available', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth5')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      // one layer subagent is helm-owned automatically conversation: explicit background:true must explicit errors,
      // must not static default change write is sync, also must not derive sub-conversation/create run(guard against automatically caller early compute).
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
        `reject information should explicit refer out background do not by allows:${toolText.slice(0, 300)}`,
      )
      const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {
        conversationId: child1,
      })) as { runs: Array<{ id: string; kind?: string }> }
      assert.equal(runs.length, 0, 'by refuse invoke must not create any run record')
      assert.equal(
        app.kernel.listConversations().filter((c) => c.parentConversationId === child1).length,
        0,
        'by refuse invoke must not derive sub-conversation',
      )

      // the same managed conversation default (omit background) still away sync path: directly wait for result.
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
      assert.ok(child2, 'default sync invoke should normal derive two layer sub-conversation')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child2.id)
      assert.equal(entry['depth'], 2, 'sync derive two layer subagent same register depth=2')

      // two layer subagent is leaf: direct tune spawnAgent by refuse.
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child2.id, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 6. fork conversation do not by mistakenly damage
  // -------------------------------------------------------------------------

  test('fork conversation (has parentConversationId) do not by mistakenly damage: tool complete,spawn and run action available', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth6')
    const faux = makeFauxProvider()
    const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // top-level complete a turn (provide can fork item).
      faux.setResponses([fauxAssistantMessage('top-level answer')])
      await app.kernel.submitInput(1, '你好')
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 10 })
      const numericEntry = detail.entries.find((e) => Number.isInteger(Number(e.id)) && Number(e.id) > 0)
      assert.ok(numericEntry, 'should has can fork item (number entryId)')
      const entryId = Number(numericEntry!.id)

      const forked = await app.kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork conversation same has parent chain')

      // fork do not in register table inside:spawnAgent let through,run action let through (wait terminal state).
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
  // 7. SuperAgent worker do not by mistakenly damage (has parentConversationId, but do not via spawn pipeline)
  // -------------------------------------------------------------------------

  test('SuperAgent worker do not by mistakenly damage:dispatch_worker create conversation can normal derive subagent', { timeout: 60_000 }, async () => {
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
      assert.equal(worker.parentConversationId !== undefined, true, 'worker has parent chain')

      // worker do not in register table:spawnAgent let through.
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
  // 8. restart restore:depth/parent chain fact across restarts durable, two layer still by refuse, one layer still can dispatch
  // -------------------------------------------------------------------------

  test('restart restore: deep fact across restarts durable, two layer still by refuse, one layer still can dispatch new two layer', { timeout: 60_000 }, async () => {
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
    // restart: the same dataDir, register table fact takes effect.
    {
      const faux = makeFauxProvider()
      const app = await createHelm({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child1, 'after restart one layer sub-conversation mirror should restore')
        const child2 = app.kernel
          .listConversations()
          .find((c) => c.parentConversationId === child1.id)
        assert.ok(child2, 'after restart two layer sub-conversation mirror should restore')

        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: child2.id,
              prompt: 'after restart dispatch three layer',
            }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
        // one layer compare group still let through (after restart still can dispatch new two layer).
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
  // 9. without compatibility read: missing depth/cap field corrupt item must explicit errors
  // -------------------------------------------------------------------------

  test('register fact missing when explicit failed, do not guess deep and permission', { timeout: 60_000 }, async () => {
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
    // simulated old record: strip new fact field (old contract only agentType/runId/createdAt).
    {
      const registry = readRegistryRaw(dir)
      const legacy = registry[String(legacyChildId)] as Record<string, unknown>
      assert.ok(legacy, 'old conversation should has register item')
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
  // 10. explicit extend request field:maxSubagentDepth=3 allows three layer; invalid value explicit reject
  // -------------------------------------------------------------------------

  test('explicit deep grant:maxSubagentDepth=3 when three layer available, three layer is leaf; new register inherit grant cap', { timeout: 60_000 }, async () => {
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
      assert.ok(grantedChild > 0, 'should derive sub-conversation and back pass conversationId')
      const child1 = grantedChild
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child1)['maxSubagentDepth'], 3, 'register table should snapshot explicit grant cap')
      assert.equal(registryEntry(dir, child1)['depth'], 1)

      // three layer chain all available (1 → 2 → 3), three layer is leaf.
      const child2 = (await spawnChain(app, faux, [child1]))[0]!
      const child3 = (await spawnChain(app, faux, [child2]))[0]!
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child2)['maxSubagentDepth'], 3, 'subagent inherit sub- tree grant cap')
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

      // invalid value explicit reject (not silently clamp): out of bounds / non- integer.
      for (const invalid of [0, 6, 2.5]) {
        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: 1,
              prompt: 'invalid grant',
              meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: invalid as number }),
            }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError, `maxSubagentDepth=${invalid} should be HelmError`)
            assert.equal(err.code, 'validation_error')
            return true
          },
        )
      }
      // subagent cannot self row mention high inherit cap, also cannot settings low at target tier cap.
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
      // reject path do not register any new fact.
      await app.kernel.documentStore.flush()
      const registry = readRegistryRaw(dir)
      assert.equal(Object.keys(registry).length, 3, 'only should register three layer chain 3 item')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 11. global config via host unify entry write, and in after restart affect new task tree.
  // -------------------------------------------------------------------------

  test('plugin config maxSubagentDepth can read write, across restarts durable, illegal count value explicit reject derive', { timeout: 60_000 }, async () => {
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
            `config value ${String(invalid)} should in persist boundary by reject`,
          )
        }
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2, 'illegal config must not pollute valid config')
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
