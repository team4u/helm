/**
 * Integration tests for graceful Hub restart retention and tool replay recovery.
 *
 * Core invariants covered:
 * 1. openHelmxDatabase shared connection proxy: storage.close() does not close the underlying db early
 *    while HelmxStore shares it; initialization catch closes the db cleanly to avoid FD leaks;
 * 2. KernelRuntime.close() during human conversation streaming generation shuts down gracefully:
 *    harness.close() runs before pluginHost/store/database, returning GenerationTask to pending
 *    (restarts === undefined, never forcibly aborted by closeAborts); on restart, generation resumes
 *    automatically without re-submitting submitInput;
 * 3. Internal runtime.started event dispatches after pluginHost.start() and harness.resume() without
 *    broadcasting externally;
 * 4. Read-only tools `read` and `read_artifact` declare `replay: 'safe'`: whether interrupted in
 *    `phase: 'execute'` by runtime.close() or a real SIGKILL crash, restarting automatically replays
 *    them and returns real content;
 * 5. Mutating tool `bash` keeps `replay: 'unsafe'`: after a real SIGKILL crash it never replays,
 *    converges to an interrupted tool error result, and lets the next model turn decide recovery.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import type { HelmxEventFrame } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'

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

async function inspectHarnessTasks(dataDir: string): Promise<
  Array<{ kind: string; conversationId: number; status: string; abortRequested: boolean; restarts: number | undefined }>
> {
  const db = await openHelmxDatabase(dataDir)
  try {
    const probe = await Harness.open(
      db.storage,
      { models: createModels(), registry: createRegistry(), readOnly: true },
      BACKGROUND_CONTEXT,
    )
    try {
      const inspection = await probe.inspect(BACKGROUND_CONTEXT)
      return inspection.tasks.map((t) => ({
        kind: t.record.kind,
        conversationId: Number(t.record.conversationId),
        status: String(t.record.state.status),
        abortRequested: t.record.abortRequested,
        restarts: t.record.restarts,
      }))
    } finally {
      await probe.close(BACKGROUND_CONTEXT).catch(() => {})
    }
  } finally {
    await db.close().catch(() => {})
  }
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
      HELMX_DATA_DIR: dataDir,
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
        reject(new Error(`seeder exited unexpectedly (code=${code}, signal=${signal}, killedByParent=${killedByParent}): ${stdout}${stderr}`.slice(0, 2000)))
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
        // process group already exited
      }
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

test('openHelmxDatabase: storage.close() preserves shared db; init failure closes db in catch to avoid FD leaks', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helmx-sqlite-proxy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const db = await openHelmxDatabase(dir)
  await db.storage.close(BACKGROUND_CONTEXT)
  const rows = await db.db.all<{ ok: number }>('SELECT 1 AS ok')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.ok, 1, 'underlying db remains readable and writable after storage.close() until database.close()')
  await db.close()

  // Seed partial broken schema: openNodeSqliteDatabase succeeds, then HELMX_SCHEMA index creation on helmx_artifacts(conversation_id) fails.
  const failDir = mkdtempSync(join(tmpdir(), 'helmx-sqlite-fail-'))
  t.after(() => rmSync(failDir, { recursive: true, force: true }))
  const seeded = await openNodeSqliteDatabase(join(failDir, 'state.sqlite'))
  await seeded.exec('CREATE TABLE helmx_artifacts (id TEXT PRIMARY KEY);')
  await seeded.close()

  await assert.rejects(() => openHelmxDatabase(failDir))
  // If catch failed to close db, removing and reopening at the same path would fail with stale FD/lock; verify clean reopen.
  rmSync(join(failDir, 'state.sqlite'), { force: true })
  const recovered = await openHelmxDatabase(failDir)
  await recovered.close()
})

test('runtime.close() during streaming preserves continuity: GenerationTask returns to pending without restarts, resumes automatically, and dispatches runtime.started in order', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-graceful-gen-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const { models: models1, faux: faux1 } = createFaux({ tokensPerSecond: 2, tokenSize: { min: 1, max: 1 } })
  const runtime1 = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models1,
    autoResume: false,
  })
  t.after(() => runtime1.close().catch(() => {}))

  const lifecycleOrder: string[] = []
  const leakedToEvents: string[] = []
  const unsubscribe = runtime1.events.subscribe((frame: HelmxEventFrame) => {
    const ev = frame.event as { type?: string }
    if (ev.type === 'runtime.started') leakedToEvents.push(ev.type)
  })
  t.after(() => unsubscribe())
  await runtime1.plugins.register({
    id: 'test:lifecycle-order',
    name: 'lifecycle order probe',
    definePlugin(ctx) {
      ctx.service({
        id: 'order-probe',
        start() {
          lifecycleOrder.push('plugin.start')
        },
        stop() {},
      })
      ctx.host.onEvent('runtime.started', () => {
        lifecycleOrder.push('runtime.started')
      })
    },
  })

  await runtime1.start()
  assert.deepEqual(lifecycleOrder, ['plugin.start', 'runtime.started'])
  assert.equal(leakedToEvents.length, 0, 'runtime.started is an internal event (broadcast: false) and must not leak to external SSE')

  // Slow streaming generation: verify conversation enters working and emits partial tokens before graceful close.
  faux1.setResponses([fauxAssistantMessage('long slow streaming output text used to ensure turn stays mid-generation on graceful shutdown')])
  void runtime1.submitInput(1, 'please generate a long reply').catch(() => {})
  const deadline = Date.now() + 15_000
  while (runtime1.getConversation(1).status !== 'working' && Date.now() < deadline) {
    await delay(30)
  }
  assert.equal(runtime1.getConversation(1).status, 'working', 'conversation must enter working within 15s')
  await delay(600)

  await runtime1.close()

  const tasksAfterClose = await inspectHarnessTasks(dataDir)
  const genTask = tasksAfterClose.find((task) => task.kind === 'pi.generation' && task.conversationId === 1)
  assert.ok(genTask, `generation checkpoint must be preserved after graceful shutdown (actual: ${JSON.stringify(tasksAfterClose)})`)
  assert.equal(genTask.status, 'pending')
  assert.equal(genTask.abortRequested, false)
  assert.equal(genTask.restarts, undefined, 'graceful close() must not increment crash restart counter')

  // Restart and start(): automatically finishes the pending reply without calling submitInput again.
  const { models: models2, faux: faux2 } = createFaux()
  faux2.setResponses([fauxAssistantMessage('graceful restart continuation complete')])
  const runtime2 = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models2,
    autoResume: false,
  })
  t.after(() => runtime2.close().catch(() => {}))
  await runtime2.start()
  await runtime2.waitForIdle(1)

  assert.equal(faux2.state.callCount, 1)
  assert.equal(runtime2.getConversation(1).status, 'done')
  assert.equal(await runtime2.getLastAssistantText(1), 'graceful restart continuation complete')
})

test('replay: safe read-only tools read and read_artifact automatically replay to finish turn after runtime.close()', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-safe-replay-close-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeFileSync(join(dataDir, 'note.txt'), 'READ_REPLAY_OK_CONTENT\n', 'utf8')

  // ---- 1) read hits runtime.close() during phase: 'execute' ----
  const { models: m1, faux: f1 } = createFaux()
  const r1 = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: m1,
    autoResume: true,
  })
  const art = await r1.artifacts.writeUploaded(1, {
    name: 'report.txt',
    bytes: Buffer.from('ARTIFACT_REPLAY_OK_CONTENT\n', 'utf8'),
  })

  const origSpill = r1.artifacts.spill.bind(r1.artifacts)
  let readEntered!: () => void
  const waitReadEntered = new Promise<void>((resolve) => {
    readEntered = resolve
  })
  let allowSpillReturn!: () => void
  const gateSpill = new Promise<void>((resolve) => {
    allowSpillReturn = resolve
  })
  r1.artifacts.spill = (async (...args: Parameters<typeof origSpill>) => {
    if (String(args[1]).startsWith('read-')) {
      readEntered()
      await gateSpill
    }
    return origSpill(...args)
  }) as typeof r1.artifacts.spill

  f1.setResponses([fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }, { id: 'read-gate-1' })], { stopReason: 'toolUse' })])
  void r1.submitInput(1, 'read note.txt').catch(() => {})
  await waitReadEntered
  // Start close() so Harness aborts ToolTask's abortSignal first, then release spill to make wrapToolExecute throw AbortError.
  const closePromise1 = r1.close()
  await delay(80)
  allowSpillReturn()
  await closePromise1

  let capturedReadContext: TranscriptContext | undefined
  const { models: m2, faux: f2 } = createFaux()
  f2.setResponses([
    (ctx) => {
      capturedReadContext = ctx
      return fauxAssistantMessage('read replay succeeded')
    },
  ])
  const r2 = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: m2,
    autoResume: false,
  })
  await r2.start()
  await r2.waitForIdle(1)
  assert.equal(await r2.getLastAssistantText(1), 'read replay succeeded')
  const readToolResults = collectToolResultTexts(capturedReadContext)
  assert.ok(
    readToolResults.some((tr) => !tr.isError && tr.text.includes('READ_REPLAY_OK_CONTENT')),
    `read should replay automatically and return real file content (actual: ${JSON.stringify(readToolResults)})`,
  )

  // ---- 2) read_artifact hits r2.close() during phase: 'execute' ----
  const origReadBuffer = r2.artifacts.readBuffer.bind(r2.artifacts)
  let artEntered!: () => void
  const waitArtEntered = new Promise<void>((resolve) => {
    artEntered = resolve
  })
  let allowReadBufferReturn!: () => void
  const gateReadBuffer = new Promise<void>((resolve) => {
    allowReadBufferReturn = resolve
  })
  r2.artifacts.readBuffer = (async (...args: Parameters<typeof origReadBuffer>) => {
    artEntered()
    await gateReadBuffer
    return origReadBuffer(...args)
  }) as typeof r2.artifacts.readBuffer

  f2.setResponses([fauxAssistantMessage([fauxToolCall('read_artifact', { id: art.id })], { stopReason: 'toolUse' })])
  void r2.submitInput(1, 'read artifact').catch(() => {})
  await waitArtEntered
  const closePromise2 = r2.close()
  await delay(80)
  allowReadBufferReturn()
  await closePromise2

  let capturedArtContext: TranscriptContext | undefined
  const { models: m3, faux: f3 } = createFaux()
  f3.setResponses([
    (ctx) => {
      capturedArtContext = ctx
      return fauxAssistantMessage('read_artifact replay succeeded')
    },
  ])
  const r3 = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: m3,
    autoResume: false,
  })
  t.after(() => r3.close().catch(() => {}))
  await r3.start()
  await r3.waitForIdle(1)
  assert.equal(await r3.getLastAssistantText(1), 'read_artifact replay succeeded')
  const artToolResults = collectToolResultTexts(capturedArtContext)
  assert.ok(
    artToolResults.some((tr) => !tr.isError && tr.text.includes('ARTIFACT_REPLAY_OK_CONTENT')),
    `read_artifact should replay automatically and return real artifact content (actual: ${JSON.stringify(artToolResults)})`,
  )
})

test('real SIGKILL crash: read replays automatically and succeeds; bash never replays and settles as interrupted for model recovery', { timeout: 60_000 }, async (t) => {
  // ---- A) read replays automatically after SIGKILL crash in child process ----
  const readDir = mkdtempSync(join(tmpdir(), 'helmx-sigkill-read-'))
  const readSeedDir = mkdtempSync(join(tmpdir(), 'helmx-sigkill-read-seed-'))
  t.after(() => {
    rmSync(readSeedDir, { recursive: true, force: true })
    rmSync(readDir, { recursive: true, force: true })
  })
  writeFileSync(join(readDir, 'note.txt'), 'SIGKILL_READ_REPLAY_OK\n', 'utf8')
  await runSeederUntilSigkill(
    readSeedDir,
    readDir,
    `
import { KernelRuntime } from ${JSON.stringify(KERNEL_RUNTIME_SRC)}
import { createModels } from ${JSON.stringify(PI_AI_MODELS_URL)}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
const dataDir = process.env.HELMX_DATA_DIR
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }, { id: 'read-sigkill-1' })], { stopReason: 'toolUse' })])
const runtime = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: true })
const origSpill = runtime.artifacts.spill.bind(runtime.artifacts)
runtime.artifacts.spill = async (...args) => {
  if (String(args[1]).startsWith('read-')) {
    process.stdout.write('READY_READ\\n')
    await new Promise(() => {})
  }
  return origSpill(...args)
}
void runtime.submitInput(1, 'read file').catch(() => {})
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_READ'),
  )
  let readCtxAfterKill: TranscriptContext | undefined
  const { models: rm, faux: rf } = createFaux()
  rf.setResponses([
    (ctx) => {
      readCtxAfterKill = ctx
      return fauxAssistantMessage('read-only replay succeeded after crash')
    },
  ])
  const readRecover = await KernelRuntime.open({
    dataDir: readDir,
    cwd: readDir,
    model: 'faux/faux-1',
    models: rm,
    autoResume: true,
  })
  try {
    await readRecover.waitForIdle(1)
    assert.equal(await readRecover.getLastAssistantText(1), 'read-only replay succeeded after crash')
    const results = collectToolResultTexts(readCtxAfterKill)
    assert.ok(
      results.some((tr) => !tr.isError && tr.text.includes('SIGKILL_READ_REPLAY_OK')),
      `read must replay after SIGKILL and return real file content (actual: ${JSON.stringify(results)})`,
    )
  } finally {
    await readRecover.close()
  }

  // ---- B) bash never replays after SIGKILL crash in child process and converges as interrupted ----
  const bashDir = mkdtempSync(join(tmpdir(), 'helmx-sigkill-bash-'))
  const bashSeedDir = mkdtempSync(join(tmpdir(), 'helmx-sigkill-bash-seed-'))
  t.after(() => {
    rmSync(bashSeedDir, { recursive: true, force: true })
    rmSync(bashDir, { recursive: true, force: true })
  })
  const markerPath = join(bashDir, 'run_count.txt')
  await runSeederUntilSigkill(
    bashSeedDir,
    bashDir,
    `
import { KernelRuntime } from ${JSON.stringify(KERNEL_RUNTIME_SRC)}
import { createModels } from ${JSON.stringify(PI_AI_MODELS_URL)}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
const dataDir = process.env.HELMX_DATA_DIR
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage([fauxToolCall('bash', { command: 'printf x >> run_count.txt; echo BASH_RUNNING; sleep 60' })], { stopReason: 'toolUse' })])
const runtime = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: true })
void runtime.submitInput(1, 'execute external command').catch(() => {})
const deadline = Date.now() + 15000
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
while (!existsSync(join(dataDir, 'run_count.txt')) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 40))
}
process.stdout.write('READY_BASH\\n')
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_BASH'),
  )
  assert.equal(existsSync(markerPath), true)
  assert.equal(readFileSync(markerPath, 'utf8'), 'x', 'bash executed exactly once before crash')

  let bashCtxAfterKill: TranscriptContext | undefined
  const { models: bm, faux: bf } = createFaux()
  bf.setResponses([
    (ctx) => {
      bashCtxAfterKill = ctx
      return fauxAssistantMessage('confirmed command interrupted without replay')
    },
  ])
  const bashRecover = await KernelRuntime.open({
    dataDir: bashDir,
    cwd: bashDir,
    model: 'faux/faux-1',
    models: bm,
    autoResume: true,
  })
  try {
    await bashRecover.waitForIdle(1)
    assert.equal(readFileSync(markerPath, 'utf8'), 'x', 'unsafe tool bash must never replay after restart')
    assert.equal(await bashRecover.getLastAssistantText(1), 'confirmed command interrupted without replay')
    const results = collectToolResultTexts(bashCtxAfterKill)
    assert.ok(
      results.some((tr) => tr.isError && /interrupted/i.test(tr.text)),
      `interrupted bash must hand an interrupted error back to the model to continue (actual: ${JSON.stringify(results)})`,
    )
  } finally {
    await bashRecover.close()
  }
})
