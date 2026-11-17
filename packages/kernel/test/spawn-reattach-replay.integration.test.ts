/**
 * Cross-restart recovery integration tests for PluginToolSpec.replay and spawnAgent(requestId + reattach.conversationId).
 *
 * Covers:
 * 1. Strong reattach boundary validation and concurrency guards (mutual exclusion with resume/fork 400, invalid conversationId 400,
 *    missing/wrong-parent 404 without creating a new conversation, missing requestId 400, executionId-only 400 unsupported_runtime,
 *    concurrent reattach 409 subagent_in_use and activeSpawnExecutions slot cleanup);
 * 2. PluginToolSpec.replay: 'safe' automatically replays to finish the turn after runtime.close() and SIGKILL crashes,
 *    while replay: 'unsafe' / default tools never replay after SIGKILL and converge to an interrupted error result;
 * 3. spawnAgent with requestId + reattach.conversationId (plain text + gate, schema + gate calling tool after restart,
 *    pre-crash committed register_structured_output backfill avoiding re-prompt, :schema-heal turn crash reattach dedup)
 *    resumes and settles in-place across runtime.close() and SIGKILL with zero duplicate user messages.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type AgentExecutionInfo, type AgentGateResult } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

const require = createRequire(import.meta.url)
const KERNEL_DIR = new URL('../', import.meta.url).pathname
const PI_AI_DIR = join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai')
const KERNEL_RUNTIME_SRC = pathToFileURL(join(KERNEL_DIR, 'src/runtime/index.ts')).href
const PI_AI_MODELS_URL = pathToFileURL(join(PI_AI_DIR, 'dist/models.js')).href
const PI_AI_FAUX_URL = pathToFileURL(join(PI_AI_DIR, 'dist/providers/faux.js')).href

function createFaux(opts?: Parameters<typeof fauxProvider>[0]) {
  const models = createModels()
  const faux = fauxProvider(opts)
  models.setProvider(faux.provider)
  return { models, faux }
}

function collectToolResultTexts(context: TranscriptContext | undefined): Array<{ text: string; isError: boolean }> {
  if (!context) return []
  const out: Array<{ text: string; isError: boolean }> = []
  for (const msg of context.messages) {
    if (msg.role === 'toolResult') {
      const text = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
      out.push({ text, isError: msg.isError })
    }
  }
  return out
}

async function countUserEntries(runtime: KernelRuntime, conversationId: number): Promise<number> {
  const detail = await runtime.getConversationDetail(conversationId, { limit: 200 })
  return detail.entries.filter((e) => e.kind === 'pi.user').length
}

async function runSeederUntilSigkill(
  seedDir: string,
  dataDir: string,
  script: string,
  waitForReady: (stdout: string) => boolean,
): Promise<void> {
  const seederPath = join(seedDir, 'seeder.mts')
  writeFileSync(seederPath, script, 'utf8')
  const tsxCli = require.resolve('tsx/cli')
  const child = spawn(process.execPath, [tsxCli, seederPath], {
    cwd: KERNEL_DIR,
    detached: true,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: seedDir,
      HELM_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let stdout = ''
    let stderr = ''
    let killedByParent = false
    const exited = new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (!killedByParent && waitForReady(stdout)) {
          killedByParent = true
          child.kill('SIGKILL')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('exit', (code, signal) => {
        if (killedByParent && (signal === 'SIGKILL' || code === 137)) {
          resolve()
          return
        }
        reject(
          new Error(
            `seeder exited unexpectedly (code=${code}, signal=${signal}, killedByParent=${killedByParent}): ${stdout}${stderr}`.slice(0, 2000),
          ),
        )
      })
      child.on('error', reject)
    })
    await Promise.race([
      exited,
      delay(25_000, undefined, { ref: false }).then(() => {
        throw new Error(`seeder did not reach ready state within 25s: ${stdout}${stderr}`.slice(0, 2000))
      }),
    ])
  } finally {
    if (child.pid !== undefined) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Process group already exited
      }
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

test('spawnAgent reattach strong boundary validation: mutual exclusion, invalid ID, wrong parent, and concurrent lock', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-reattach-boundary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const { models, faux } = createFaux()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  t.after(() => runtime.close().catch(() => {}))

  // First spawn a real child conversation
  faux.setResponses([fauxAssistantMessage('initial child done')])
  let childId = 0
  await runtime.spawnAgent({
    parentConversationId: 1,
    prompt: 'initial spawn',
    requestId: 'req-init',
    onResolved: (info) => {
      childId = info.conversationId ?? 0
    },
  })
  assert.ok(childId > 1)
  const convCountBefore = runtime.listConversations().length
  const callsBefore = faux.state.callCount

  // 1) reattach mutually exclusive with resume / fork (400 validation_error)
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'conflict',
        requestId: 'req-conflict-1',
        resume: String(childId),
        reattach: { conversationId: childId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'conflict',
        requestId: 'req-conflict-2',
        fork: true,
        reattach: { conversationId: childId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )

  // 2) Invalid reattach shapes / non-positive or non-safe-integer conversationId / missing requestId
  for (const badConvId of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () =>
        runtime.spawnAgent({
          parentConversationId: 1,
          prompt: 'invalid',
          requestId: 'req-bad-id',
          reattach: { conversationId: badConvId },
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )
  }
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'empty object',
        requestId: 'req-empty',
        reattach: {},
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'relative path',
        requestId: 'req-rel-cwd',
        reattach: { conversationId: childId, effectiveCwd: 'relative/path' },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'missing requestId',
        reattach: { conversationId: childId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )

  // 3) Missing conversation, root without parent chain, wrong parent ownership (404 not_found, never create fake child)
  for (const [parentId, targetId] of [
    [1, 999999],
    [1, 1],
    [999, childId],
  ] as const) {
    await assert.rejects(
      () =>
        runtime.spawnAgent({
          parentConversationId: parentId,
          prompt: 'unauthorized reattach',
          requestId: 'req-wrong-owner',
          reattach: { conversationId: targetId },
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
    )
  }

  // 4) executionId-only reaching native runner (no external runtime plugin claimed it): explicit unsupported_runtime
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'external reattach',
        requestId: 'req-exec-only',
        reattach: { executionId: 'pane-1' },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime' && err.status === 400,
  )

  assert.equal(runtime.listConversations().length, convCountBefore, 'rejected paths must never create conversations')
  assert.equal(faux.state.callCount, callsBefore, 'rejected paths must never trigger model calls')

  // 5) Concurrent reattach lock (activeSpawnExecutions + claimSpawnConversation): 409 subagent_in_use
  const childWorkDir = join(dir, 'slow-child')
  mkdirSync(childWorkDir, { recursive: true })
  let releaseTool!: () => void
  const gateTool = new Promise<void>((resolve) => {
    releaseTool = resolve
  })
  let enteredTool!: () => void
  const waitTool = new Promise<void>((resolve) => {
    enteredTool = resolve
  })
  await runtime.plugins.register({
    id: 'test:reattach-lock',
    name: 'Concurrent reattach lock test plugin',
    definePlugin(ctx) {
      ctx.tool({
        name: 'hold_tool',
        description: 'blocks waiting for release',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          enteredTool()
          await gateTool
          return 'released'
        },
      })
    },
  })

  // Launch an in-flight child conversation; while blocked in tool, attempt concurrent reattach from outside
  // Scenario A: also covers activeSpawnExecutions visibility and cleanup after completion
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_tool', {}, { id: 'hold-1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('slow child done'),
  ])
  let slowChildId = 0
  const firstRun = runtime.spawnAgent({
    parentConversationId: 1,
    prompt: 'run blocking tool',
    requestId: 'req-concurrent',
    cwd: childWorkDir,
    onResolved: (info) => {
      slowChildId = info.conversationId ?? 0
    },
  })
  await waitTool
  assert.ok(
    runtime.agentSpawn.listActiveSpawnExecutions().some((info) => info.conversationId === slowChildId),
    'in-flight spawn must appear in activeSpawnExecutions',
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: 'concurrent reattach',
        requestId: 'req-concurrent',
        reattach: { conversationId: slowChildId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'subagent_in_use' && err.status === 409,
  )
  releaseTool()
  assert.equal(await firstRun, 'slow child done')
  assert.equal(
    runtime.agentSpawn.listActiveSpawnExecutions().some((info) => info.conversationId === slowChildId),
    false,
    'activeSpawnExecutions entry must be released after completion',
  )
})

test('PluginToolSpec.replay: safe replays across runtime.close() and SIGKILL; unsafe never replays', { timeout: 60_000 }, async (t) => {
  // ---- A) Replay replay: 'safe' plugin tool after graceful runtime.close() ----
  const closeDir = mkdtempSync(join(tmpdir(), 'helm-plugin-replay-close-'))
  t.after(() => rmSync(closeDir, { recursive: true, force: true }))

  let firstCalls = 0
  let enteredSafe!: () => void
  const waitEnteredSafe = new Promise<void>((resolve) => {
    enteredSafe = resolve
  })
  let releaseFirst!: () => void
  const gateFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const { models: m1, faux: f1 } = createFaux()
  const r1 = await KernelRuntime.open({
    dataDir: closeDir,
    cwd: closeDir,
    model: 'faux/faux-1',
    models: m1,
    autoResume: false,
  })
  await r1.plugins.register({
    id: 'test:replay-close',
    name: 'Replayable plugin tool',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_lookup',
        description: 'replayable read-only plugin tool',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        replay: 'safe',
        execute: async (input: { key: string }) => {
          firstCalls += 1
          enteredSafe()
          await gateFirst
          return `never:${input.key}`
        },
      })
    },
  })
  await r1.start()

  f1.setResponses([
    fauxAssistantMessage([fauxToolCall('safe_lookup', { key: 'alpha' }, { id: 'plugin-call-1' })], {
      stopReason: 'toolUse',
    }),
  ])
  void r1.submitInput(1, 'invoke safe plugin tool').catch(() => {})
  await waitEnteredSafe
  const closing = r1.close()
  await delay(60)
  releaseFirst()
  await closing
  assert.equal(firstCalls, 1)

  let replayCalls = 0
  let capturedCtx: TranscriptContext | undefined
  const { models: m2, faux: f2 } = createFaux()
  f2.setResponses([
    (ctx) => {
      capturedCtx = ctx
      return fauxAssistantMessage('safe plugin tool replayed cleanly')
    },
  ])
  const r2 = await KernelRuntime.open({
    dataDir: closeDir,
    cwd: closeDir,
    model: 'faux/faux-1',
    models: m2,
    autoResume: false,
  })
  t.after(() => r2.close().catch(() => {}))
  await r2.plugins.register({
    id: 'test:replay-close',
    name: 'Replayable plugin tool',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_lookup',
        description: 'replayable read-only plugin tool',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        replay: 'safe',
        execute: async (input: { key: string }) => {
          replayCalls += 1
          return `SAFE_REPLAYED:${input.key}`
        },
      })
    },
  })
  await r2.start()
  await r2.waitForIdle(1)
  assert.equal(replayCalls, 1)
  assert.equal(await r2.getLastAssistantText(1), 'safe plugin tool replayed cleanly')
  const closeResults = collectToolResultTexts(capturedCtx)
  assert.ok(
    closeResults.some((tr) => !tr.isError && tr.text.includes('SAFE_REPLAYED:alpha')),
    `replay:'safe' plugin tool must replay and return real result after close() (actual: ${JSON.stringify(closeResults)})`,
  )

  // ---- B) Real SIGKILL crash: safe plugin tool auto-replays, unsafe never replays ----
  const killDir = mkdtempSync(join(tmpdir(), 'helm-plugin-replay-sigkill-'))
  const seedDir = mkdtempSync(join(tmpdir(), 'helm-plugin-replay-seed-'))
  t.after(() => {
    rmSync(seedDir, { recursive: true, force: true })
    rmSync(killDir, { recursive: true, force: true })
  })
  const safeMarker = join(killDir, 'safe_runs.txt')
  const unsafeMarker = join(killDir, 'unsafe_runs.txt')

  await runSeederUntilSigkill(
    seedDir,
    killDir,
    `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { KernelRuntime } from ${JSON.stringify(KERNEL_RUNTIME_SRC)}
import { createModels } from ${JSON.stringify(PI_AI_MODELS_URL)}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
const dataDir = process.env.HELM_DATA_DIR
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('plugin_safe', { item: 'k1' }, { id: 'sigkill-safe-1' }),
      fauxToolCall('plugin_unsafe', { item: 'u1' }, { id: 'sigkill-unsafe-1' }),
    ],
    { stopReason: 'toolUse' },
  ),
])
const runtime = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
await runtime.plugins.register({
  id: 'test:replay-sigkill',
  name: 'SIGKILL plugin replay check',
  definePlugin(ctx) {
    ctx.tool({
      name: 'plugin_safe',
      description: 'replayable plugin tool',
      inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
      replay: 'safe',
      execute: async (input) => {
        appendFileSync(join(dataDir, 'safe_runs.txt'), 's')
        await new Promise(() => {})
        return input.item
      },
    })
    ctx.tool({
      name: 'plugin_unsafe',
      description: 'non-idempotent plugin tool',
      inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
      replay: 'unsafe',
      execute: async (input) => {
        appendFileSync(join(dataDir, 'unsafe_runs.txt'), 'u')
        await new Promise(() => {})
        return input.item
      },
    })
  },
})
await runtime.start()
void runtime.submitInput(1, 'run safe and unsafe plugin tools in parallel').catch(() => {})
const { existsSync } = await import('node:fs')
const deadline = Date.now() + 15000
while (
  (!existsSync(join(dataDir, 'safe_runs.txt')) || !existsSync(join(dataDir, 'unsafe_runs.txt'))) &&
  Date.now() < deadline
) {
  await new Promise((r) => setTimeout(r, 40))
}
process.stdout.write('READY_PLUGIN_TOOLS\\n')
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_PLUGIN_TOOLS'),
  )
  assert.equal(readFileSync(safeMarker, 'utf8'), 's')
  assert.equal(readFileSync(unsafeMarker, 'utf8'), 'u')

  let sigkillCtx: TranscriptContext | undefined
  const { models: km, faux: kf } = createFaux()
  kf.setResponses([
    (ctx) => {
      sigkillCtx = ctx
      return fauxAssistantMessage('SIGKILL plugin tool replay boundary verified')
    },
  ])
  const recovered = await KernelRuntime.open({
    dataDir: killDir,
    cwd: killDir,
    model: 'faux/faux-1',
    models: km,
    autoResume: false,
  })
  try {
    await recovered.plugins.register({
      id: 'test:replay-sigkill',
      name: 'SIGKILL plugin replay check',
      definePlugin(ctx) {
        ctx.tool({
          name: 'plugin_safe',
          description: 'replayable plugin tool',
          inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
          replay: 'safe',
          execute: async (input: { item: string }) => {
            const { appendFileSync } = await import('node:fs')
            appendFileSync(safeMarker, 's')
            return `SIGKILL_SAFE_OK:${input.item}`
          },
        })
        ctx.tool({
          name: 'plugin_unsafe',
          description: 'non-idempotent plugin tool',
          inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
          replay: 'unsafe',
          execute: async (input: { item: string }) => {
            const { appendFileSync } = await import('node:fs')
            appendFileSync(unsafeMarker, 'u')
            return `SHOULD_NOT_RUN:${input.item}`
          },
        })
      },
    })
    await recovered.start()
    await recovered.waitForIdle(1)
    assert.equal(readFileSync(safeMarker, 'utf8'), 'ss', 'replay: safe must replay once after SIGKILL')
    assert.equal(readFileSync(unsafeMarker, 'utf8'), 'u', 'replay: unsafe must never replay after SIGKILL')
    assert.equal(await recovered.getLastAssistantText(1), 'SIGKILL plugin tool replay boundary verified')
    const results = collectToolResultTexts(sigkillCtx)
    assert.ok(results.some((tr) => !tr.isError && tr.text.includes('SIGKILL_SAFE_OK:k1')))
    assert.ok(results.some((tr) => tr.isError && /interrupted/i.test(tr.text)))
  } finally {
    await recovered.close()
  }
})

test('spawnAgent(requestId + reattach.conversationId) resumes in-place across runtime.close() (plain text / schema / pre-crash backfill / heal) with zero duplicate user messages', { timeout: 60_000 }, async (t) => {
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string' },
      count: { type: 'integer' },
    },
    required: ['status', 'count'],
    additionalProperties: false,
  } as Record<string, unknown>

  // ---- Scenario 1: with schema + gate, close() while safe plugin tool runs, call register_structured_output and pass gate after restart ----
  const dir1 = mkdtempSync(join(tmpdir(), 'helm-reattach-close-schema-'))
  t.after(() => rmSync(dir1, { recursive: true, force: true }))
  const childDir1 = join(dir1, 'work-1')
  mkdirSync(childDir1, { recursive: true })
  writeFileSync(join(childDir1, 'gate-ok.txt'), 'ok\n', 'utf8')

  let enteredGateTool!: () => void
  const waitGateTool = new Promise<void>((resolve) => {
    enteredGateTool = resolve
  })
  let releaseGateTool!: () => void
  const allowGateTool = new Promise<void>((resolve) => {
    releaseGateTool = resolve
  })
  const { models: m1a, faux: f1a } = createFaux()
  const r1a = await KernelRuntime.open({
    dataDir: dir1,
    cwd: dir1,
    model: 'faux/faux-1',
    models: m1a,
    autoResume: false,
  })
  await r1a.plugins.register({
    id: 'test:pause-helper',
    name: 'Pause tool',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_pause',
        description: 'replayable pause tool',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => {
          enteredGateTool()
          await allowGateTool
          return 'paused'
        },
      })
    },
  })
  await r1a.start()

  let childId1 = 0
  f1a.setResponses([
    fauxAssistantMessage([fauxToolCall('safe_pause', {}, { id: 'p1' })], { stopReason: 'toolUse' }),
  ])
  const spawn1a = r1a
    .spawnAgent({
      parentConversationId: 1,
      prompt: 'produce structured status',
      requestId: 'req-close-schema-1',
      cwd: childDir1,
      schema,
      gate: 'test -f gate-ok.txt',
      onResolved: (info) => {
        childId1 = info.conversationId ?? 0
      },
    })
    .catch(() => undefined)
  await waitGateTool
  assert.ok(childId1 > 1)
  const close1a = r1a.close()
  await delay(60)
  releaseGateTool()
  await close1a
  await spawn1a

  // Restart (simulates pluginHost.start() ahead of harness.resume()): attach reattach before start()
  const { models: m1b, faux: f1b } = createFaux()
  f1b.setResponses([
    fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { status: 'resumed', count: 7 } })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('structured submission completed'),
  ])
  const r1b = await KernelRuntime.open({
    dataDir: dir1,
    cwd: dir1,
    model: 'faux/faux-1',
    models: m1b,
    autoResume: false,
  })
  t.after(() => r1b.close().catch(() => {}))
  await r1b.plugins.register({
    id: 'test:pause-helper',
    name: 'Pause tool',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_pause',
        description: 'replayable pause tool',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => 'resumed_tool_ok',
      })
    },
  })
  let resolved1b: AgentExecutionInfo | undefined
  let gate1b: AgentGateResult | undefined
  const reattachPromise1b = r1b.spawnAgent({
    parentConversationId: 1,
    prompt: 'produce structured status',
    requestId: 'req-close-schema-1',
    schema,
    gate: 'test -f gate-ok.txt',
    reattach: { conversationId: childId1 },
    onResolved: (info) => {
      resolved1b = info
    },
    onGateResult: (gate) => {
      gate1b = gate
    },
  })
  await r1b.start()
  const result1b = await reattachPromise1b
  assert.deepEqual(result1b, { status: 'resumed', count: 7 })
  assert.equal(resolved1b?.conversationId, childId1)
  assert.equal(resolved1b?.effectiveCwd, childDir1)
  assert.equal(gate1b?.ok, true)
  assert.equal(await countUserEntries(r1b, childId1), 1, 'reattach must not write duplicate user message')
  assert.equal(r1b.listConversations().length, 2, 'reattach must not create an extra child conversation')

  // ---- Scenario 2: register_structured_output already committed before crash; post-restart emits plain text only, accepted backfill skips follow-up prompt ----
  const dir2 = mkdtempSync(join(tmpdir(), 'helm-reattach-close-prefilled-'))
  t.after(() => rmSync(dir2, { recursive: true, force: true }))
  let enteredSecondTool!: () => void
  const waitSecondTool = new Promise<void>((resolve) => {
    enteredSecondTool = resolve
  })
  let releaseSecondTool!: () => void
  const allowSecondTool = new Promise<void>((resolve) => {
    releaseSecondTool = resolve
  })

  const { models: m2a, faux: f2a } = createFaux()
  const r2a = await KernelRuntime.open({
    dataDir: dir2,
    cwd: dir2,
    model: 'faux/faux-1',
    models: m2a,
    autoResume: false,
  })
  await r2a.plugins.register({
    id: 'test:prefill-pause',
    name: 'Post-structured pause',
    definePlugin(ctx) {
      ctx.tool({
        name: 'after_structured_pause',
        description: 'holds until shutdown',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => {
          enteredSecondTool()
          await allowSecondTool
          return 'ok'
        },
      })
    },
  })
  await r2a.start()

  let childId2 = 0
  f2a.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('register_structured_output', { output: { status: 'pre-crash', count: 9 } })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxToolCall('after_structured_pause', {}, { id: 'p2' })], { stopReason: 'toolUse' }),
  ])
  const spawn2a = r2a
    .spawnAgent({
      parentConversationId: 1,
      prompt: 'submit structured output first then continue',
      requestId: 'req-prefilled-1',
      schema,
      onResolved: (info) => {
        childId2 = info.conversationId ?? 0
      },
    })
    .catch(() => undefined)
  await waitSecondTool
  const close2a = r2a.close()
  await delay(60)
  releaseSecondTool()
  await close2a
  await spawn2a

  const { models: m2b, faux: f2b } = createFaux()
  f2b.setResponses([fauxAssistantMessage('closing plain text without re-calling register_structured_output')])
  const r2b = await KernelRuntime.open({
    dataDir: dir2,
    cwd: dir2,
    model: 'faux/faux-1',
    models: m2b,
    autoResume: false,
  })
  t.after(() => r2b.close().catch(() => {}))
  await r2b.plugins.register({
    id: 'test:prefill-pause',
    name: 'Post-structured pause',
    definePlugin(ctx) {
      ctx.tool({
        name: 'after_structured_pause',
        description: 'holds until shutdown',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => 'done_after_restart',
      })
    },
  })
  await r2b.start()
  const result2b = await r2b.spawnAgent({
    parentConversationId: 1,
    prompt: 'submit structured output first then continue',
    requestId: 'req-prefilled-1',
    schema,
    reattach: { conversationId: childId2 },
  })
  assert.deepEqual(result2b, { status: 'pre-crash', count: 9 })
  assert.equal(f2b.state.callCount, 1, 'accepted backfill must skip sending a second :schema-heal follow-up')
  assert.equal(await countUserEntries(r2b, childId2), 1)

  // ---- Scenario 3: interrupted during :schema-heal follow-up turn; reattach deduplicates :schema-heal idempotently (zero duplicate prompt) ----
  const dir3 = mkdtempSync(join(tmpdir(), 'helm-reattach-close-heal-'))
  t.after(() => rmSync(dir3, { recursive: true, force: true }))
  let enteredHealTool!: () => void
  const waitHealTool = new Promise<void>((resolve) => {
    enteredHealTool = resolve
  })
  let releaseHealTool!: () => void
  const allowHealTool = new Promise<void>((resolve) => {
    releaseHealTool = resolve
  })

  const { models: m3a, faux: f3a } = createFaux()
  const r3a = await KernelRuntime.open({
    dataDir: dir3,
    cwd: dir3,
    model: 'faux/faux-1',
    models: m3a,
    autoResume: false,
  })
  await r3a.plugins.register({
    id: 'test:heal-pause',
    name: 'Pause during heal',
    definePlugin(ctx) {
      ctx.tool({
        name: 'heal_pause',
        description: 'blocking tool during heal turn',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => {
          enteredHealTool()
          await allowHealTool
          return 'heal-tool-resumed'
        },
      })
    },
  })
  await r3a.start()

  let childId3 = 0
  f3a.setResponses([
    fauxAssistantMessage('forgot structured tool on first turn'),
    fauxAssistantMessage([fauxToolCall('heal_pause', {}, { id: 'hp1' })], { stopReason: 'toolUse' }),
  ])
  const spawn3a = r3a
    .spawnAgent({
      parentConversationId: 1,
      prompt: 'output structured JSON',
      requestId: 'req-heal-close',
      schema,
      onResolved: (info) => {
        childId3 = info.conversationId ?? 0
      },
    })
    .catch(() => undefined)
  await waitHealTool
  const close3a = r3a.close()
  await delay(60)
  releaseHealTool()
  await close3a
  await spawn3a

  const { models: m3b, faux: f3b } = createFaux()
  f3b.setResponses([
    fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { status: 'healed', count: 2 } })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done after heal'),
  ])
  const r3b = await KernelRuntime.open({
    dataDir: dir3,
    cwd: dir3,
    model: 'faux/faux-1',
    models: m3b,
    autoResume: false,
  })
  t.after(() => r3b.close().catch(() => {}))
  await r3b.plugins.register({
    id: 'test:heal-pause',
    name: 'Pause during heal',
    definePlugin(ctx) {
      ctx.tool({
        name: 'heal_pause',
        description: 'blocking tool during heal turn',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => 'heal_pause_ok',
      })
    },
  })
  await r3b.start()
  const result3b = await r3b.spawnAgent({
    parentConversationId: 1,
    prompt: 'output structured JSON',
    requestId: 'req-heal-close',
    schema,
    reattach: { conversationId: childId3 },
  })
  assert.deepEqual(result3b, { status: 'healed', count: 2 })
  assert.equal(await countUserEntries(r3b, childId3), 2, 'exactly one pi.user for initial turn and one for :schema-heal (zero duplicates)')

  // ---- Scenario 4: plain-text turn already persisted before close() (in-memory lastAssistant unpopulated); reattach reads text directly and runs gate ----
  const dir4 = mkdtempSync(join(tmpdir(), 'helm-reattach-close-plain-'))
  t.after(() => rmSync(dir4, { recursive: true, force: true }))
  writeFileSync(join(dir4, 'plain-gate.txt'), 'pass\n', 'utf8')
  const { models: m4a, faux: f4a } = createFaux()
  const r4a = await KernelRuntime.open({
    dataDir: dir4,
    cwd: dir4,
    model: 'faux/faux-1',
    models: m4a,
    autoResume: true,
  })
  f4a.setResponses([fauxAssistantMessage('PRE_RESTART_PLAIN_TEXT')])
  let childId4 = 0
  const plainFirst = await r4a.spawnAgent({
    parentConversationId: 1,
    prompt: 'plain text task',
    title: 'Original plain task',
    requestId: 'req-plain-done',
    cwd: dir4,
    onResolved: (info) => {
      childId4 = info.conversationId ?? 0
    },
  })
  assert.equal(plainFirst, 'PRE_RESTART_PLAIN_TEXT')
  assert.equal(r4a.getConversation(childId4).title, 'Original plain task')
  await r4a.close()

  const { models: m4b, faux: f4b } = createFaux()
  const r4b = await KernelRuntime.open({
    dataDir: dir4,
    cwd: dir4,
    model: 'faux/faux-1',
    models: m4b,
    autoResume: true,
  })
  t.after(() => r4b.close().catch(() => {}))
  let plainGate: AgentGateResult | undefined
  const reattachedPlain = await r4b.spawnAgent({
    parentConversationId: 1,
    prompt: 'plain text task',
    title: 'Overwrite attempt on reattach',
    requestId: 'req-plain-done',
    gate: 'test -f plain-gate.txt',
    reattach: { conversationId: childId4 },
    onGateResult: (gate) => {
      plainGate = gate
    },
  })
  assert.equal(reattachedPlain, 'PRE_RESTART_PLAIN_TEXT')
  assert.equal(r4b.getConversation(childId4).title, 'Original plain task', 'reattach must preserve original child title')
  assert.equal(plainGate?.ok, true)
  assert.equal(f4b.state.callCount, 0, 'reattach after pre-crash settled submission must not re-send model request')
  assert.equal(await countUserEntries(r4b, childId4), 1)
})

test('spawnAgent(requestId + reattach.conversationId) recovers in-place across SIGKILL (committed schema backfill, gate verification, zero duplicate messages)', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-reattach-sigkill-'))
  const seedDir = mkdtempSync(join(tmpdir(), 'helm-reattach-sigkill-seed-'))
  t.after(() => {
    rmSync(seedDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  const childWorkDir = join(dir, 'child-workspace')
  mkdirSync(childWorkDir, { recursive: true })
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      stage: { type: 'string' },
    },
    required: ['ok', 'stage'],
    additionalProperties: false,
  } as Record<string, unknown>

  await runSeederUntilSigkill(
    seedDir,
    dir,
    `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KernelRuntime } from ${JSON.stringify(KERNEL_RUNTIME_SRC)}
import { createModels } from ${JSON.stringify(PI_AI_MODELS_URL)}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
const dataDir = process.env.HELM_DATA_DIR
const childDir = join(dataDir, 'child-workspace')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall('register_structured_output', { output: { ok: true, stage: 'before-sigkill' } })],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage(
    [fauxToolCall('bash', { command: 'touch gate_ready.txt; printf x >> bash_runs.txt; echo READY_SPAWN_KILL; sleep 60' })],
    { stopReason: 'toolUse' },
  ),
])
const runtime = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: true })
void runtime.spawnAgent({
  parentConversationId: 1,
  prompt: 'submit structured result then run command',
  requestId: 'req-sigkill-reattach',
  cwd: childDir,
  schema: ${JSON.stringify(schema)},
  gate: 'test -f gate_ready.txt',
  onResolved: (info) => {
    writeFileSync(join(dataDir, 'child_id.txt'), String(info.conversationId ?? ''), 'utf8')
  },
}).catch(() => {})
const { existsSync } = await import('node:fs')
const deadline = Date.now() + 15000
while (
  (!existsSync(join(dataDir, 'child_id.txt')) || !existsSync(join(childDir, 'bash_runs.txt'))) &&
  Date.now() < deadline
) {
  await new Promise((r) => setTimeout(r, 40))
}
process.stdout.write('READY_SPAWN_KILL\\n')
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_SPAWN_KILL'),
  )

  const childId = Number(readFileSync(join(dir, 'child_id.txt'), 'utf8').trim())
  assert.ok(Number.isSafeInteger(childId) && childId > 1)
  assert.equal(readFileSync(join(childWorkDir, 'bash_runs.txt'), 'utf8'), 'x')

  const { models: m2, faux: f2 } = createFaux()
  let seenInterruptedBash = false
  f2.setResponses([
    (ctx) => {
      const results = collectToolResultTexts(ctx)
      seenInterruptedBash = results.some((r) => r.isError && /interrupted/i.test(r.text))
      return fauxAssistantMessage('finished wrapping up after SIGKILL')
    },
  ])
  const recovered = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: m2,
    autoResume: false,
  })
  try {
    let reattachedInfo: AgentExecutionInfo | undefined
    let gateInfo: AgentGateResult | undefined
    const reattachPromise = recovered.spawnAgent({
      parentConversationId: 1,
      prompt: 'submit structured result then run command',
      requestId: 'req-sigkill-reattach',
      schema,
      gate: 'test -f gate_ready.txt',
      reattach: { conversationId: childId },
      onResolved: (info) => {
        reattachedInfo = info
      },
      onGateResult: (gate) => {
        gateInfo = gate
      },
    })
    await recovered.start()
    const outcome = await reattachPromise
    assert.deepEqual(outcome, { ok: true, stage: 'before-sigkill' })
    assert.equal(seenInterruptedBash, true, 'after SIGKILL, bash must surface as interrupted for model recovery')
    assert.equal(readFileSync(join(childWorkDir, 'bash_runs.txt'), 'utf8'), 'x', 'unsafe bash must never replay')
    assert.equal(reattachedInfo?.conversationId, childId)
    assert.equal(reattachedInfo?.effectiveCwd, childWorkDir)
    assert.equal(gateInfo?.ok, true)
    assert.equal(f2.state.callCount, 1, 'pre-crash register_structured_output backfilled; must not re-prompt')
    assert.equal(await countUserEntries(recovered, childId), 1, 'SIGKILL reattach must preserve zero duplicate user messages')
    assert.equal(recovered.listConversations().length, 2)
  } finally {
    await recovered.close()
  }

  // ---- B) SIGKILL before calling register_structured_output; calls tool on first post-restart turn and passes schema + gate ----
  const dirPost = mkdtempSync(join(tmpdir(), 'helm-reattach-sigkill-post-'))
  const seedDirPost = mkdtempSync(join(tmpdir(), 'helm-reattach-sigkill-post-seed-'))
  t.after(() => {
    rmSync(seedDirPost, { recursive: true, force: true })
    rmSync(dirPost, { recursive: true, force: true })
  })
  const childWorkPost = join(dirPost, 'work-post')
  mkdirSync(childWorkPost, { recursive: true })
  writeFileSync(join(childWorkPost, 'post-gate.txt'), 'ok\n', 'utf8')

  await runSeederUntilSigkill(
    seedDirPost,
    dirPost,
    `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KernelRuntime } from ${JSON.stringify(KERNEL_RUNTIME_SRC)}
import { createModels } from ${JSON.stringify(PI_AI_MODELS_URL)}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
const dataDir = process.env.HELM_DATA_DIR
const childDir = join(dataDir, 'work-post')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall('bash', { command: 'printf y >> step.txt; sleep 60' })],
    { stopReason: 'toolUse' },
  ),
])
const runtime = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: true })
void runtime.spawnAgent({
  parentConversationId: 1,
  prompt: 'inspect environment then submit structured output',
  requestId: 'req-sigkill-post-tool',
  cwd: childDir,
  schema: ${JSON.stringify(schema)},
  gate: 'test -f post-gate.txt',
  onResolved: (info) => {
    writeFileSync(join(dataDir, 'child_id.txt'), String(info.conversationId ?? ''), 'utf8')
  },
}).catch(() => {})
const { existsSync } = await import('node:fs')
const deadline = Date.now() + 15000
while (
  (!existsSync(join(dataDir, 'child_id.txt')) || !existsSync(join(childDir, 'step.txt'))) &&
  Date.now() < deadline
) {
  await new Promise((r) => setTimeout(r, 40))
}
process.stdout.write('READY_POST_KILL\\n')
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_POST_KILL'),
  )

  const postChildId = Number(readFileSync(join(dirPost, 'child_id.txt'), 'utf8').trim())
  assert.ok(Number.isSafeInteger(postChildId) && postChildId > 1)

  const { models: mPost, faux: fPost } = createFaux()
  fPost.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('register_structured_output', { output: { ok: true, stage: 'after-sigkill' } })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('completed structured tool call after SIGKILL'),
  ])
  const recoveredPost = await KernelRuntime.open({
    dataDir: dirPost,
    cwd: dirPost,
    model: 'faux/faux-1',
    models: mPost,
    autoResume: false,
  })
  try {
    let postGate: AgentGateResult | undefined
    const postPromise = recoveredPost.spawnAgent({
      parentConversationId: 1,
      prompt: 'inspect environment then submit structured output',
      requestId: 'req-sigkill-post-tool',
      schema,
      gate: 'test -f post-gate.txt',
      reattach: { conversationId: postChildId },
      onGateResult: (gate) => {
        postGate = gate
      },
    })
    await recoveredPost.start()
    const postOutcome = await postPromise
    assert.deepEqual(postOutcome, { ok: true, stage: 'after-sigkill' })
    assert.equal(postGate?.ok, true)
    assert.equal(await countUserEntries(recoveredPost, postChildId), 1)
    assert.equal(recoveredPost.listConversations().length, 2)
  } finally {
    await recoveredPost.close()
  }
})
