/**
 * Hub process restart graceful closure stop keep and tool replay restore real integration test.
 *
 * override core invariant:
 * 1. openHelmDatabase sharing connect proxy:storage.close() do not mention before close and HelmStore shared use
 *    underlying db; failed to initialize when catch branch thing close db, avoid FD leak leak;
 * 2. KernelRuntime.close() in person class conversation streaming generate phase graceful closure stop:harness.close() first at
 *    pluginHost/store/database execute,GenerationTask retreat back pending(restarts === undefined,
 *    never by closeAborts strong row abort); after restart no need to re- submitInput automatically complete back re-;
 * 3. runtime.started internal event in pluginHost.start() and harness.resume() after dispatch and do not broadcast;
 * 4. only read tool read and read_artifact declaration replay: 'safe': regardless of is runtime.close()
 *    also is real SIGKILL process crash interrupt in phase: 'execute', restart all automatically replay and return real content;
 * 5. non- security tool bash keep replay: 'unsafe': real SIGKILL crash interrupt after never replay, converge is
 *    interrupted tool error result and hand over by under one model turn continue decide policy.
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
import type { HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'

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
  const db = await openHelmDatabase(dataDir)
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
        reject(new Error(`seeder exception exit (code=${code}, signal=${signal}, killedByParent=${killedByParent}): ${stdout}${stderr}`.slice(0, 2000)))
      })
      child.on('error', reject)
    })
    await Promise.race([
      exited,
      delay(25_000, undefined, { ref: false }).then(() => {
        throw new Error(`seeder 25s not enter ready state: ${stdout}${stderr}`.slice(0, 2000))
      }),
    ])
  } finally {
    if (child.pid !== undefined) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // process group already whole exit
      }
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

test('openHelmDatabase:storage.close() do not mention before closure sharing db; failed to initialize catch thing close db guard against FD leak leak', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-sqlite-proxy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const db = await openHelmDatabase(dir)
  await db.storage.close(BACKGROUND_CONTEXT)
  const rows = await db.db.all<{ ok: number }>('SELECT 1 AS ok')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.ok, 1, 'storage.close() after underlying thing db still can read write until database.close()')
  await db.close()

  // pre- build leftover missing table structure:openNodeSqliteDatabase succeeded, then HELM_SCHEMA create index helm_artifacts(conversation_id) failed
  const failDir = mkdtempSync(join(tmpdir(), 'helm-sqlite-fail-'))
  t.after(() => rmSync(failDir, { recursive: true, force: true }))
  const seeded = await openNodeSqliteDatabase(join(failDir, 'state.sqlite'))
  await seeded.exec('CREATE TABLE helm_artifacts (id TEXT PRIMARY KEY);')
  await seeded.close()

  await assert.rejects(() => openHelmDatabase(failDir))
  // if catch not close db, the same path under clean up and heavy open will leftover FD/lock; verify can without block remove and heavy open
  rmSync(join(failDir, 'state.sqlite'), { force: true })
  const recovered = await openHelmDatabase(failDir)
  await recovered.close()
})

test('runtime.close() in streaming generate during without loss keep-alive:GenerationTask retreat back pending and without restarts, after restart automatically complete back re- and by order dispatch runtime.started', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-graceful-gen-'))
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
  const unsubscribe = runtime1.events.subscribe((frame: HelmEventFrame) => {
    const ev = frame.event as { type?: string }
    if (ev.type === 'runtime.started') leakedToEvents.push(ev.type)
  })
  t.after(() => unsubscribe())
  await runtime1.plugins.register({
    id: 'test:lifecycle-order',
    name: 'lifecycle order probe needle',
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
  assert.equal(leakedToEvents.length, 0, 'runtime.started is internal event (broadcast: false), must not broadcast to external SSE')

  // slow fast streaming generate: confirm conversation enter working and part token start output after execute graceful closure stop
  faux1.setResponses([fauxAssistantMessage('this is one segment by graceful closure stop slow fast streaming output long text used to ensure closure stop when turn still in generate in')])
  void runtime1.submitInput(1, 'please generate long back re-').catch(() => {})
  const deadline = Date.now() + 15_000
  while (runtime1.getConversation(1).status !== 'working' && Date.now() < deadline) {
    await delay(30)
  }
  assert.equal(runtime1.getConversation(1).status, 'working', '15s inside conversation must enter working state')
  await delay(600)

  await runtime1.close()

  const tasksAfterClose = await inspectHarnessTasks(dataDir)
  const genTask = tasksAfterClose.find((task) => task.kind === 'pi.generation' && task.conversationId === 1)
  assert.ok(genTask, `graceful closure stop after must keep generation checkpoint(actual:${JSON.stringify(tasksAfterClose)})`)
  assert.equal(genTask.status, 'pending')
  assert.equal(genTask.abortRequested, false)
  assert.equal(genTask.restarts, undefined, 'graceful close() must not count crash restart time count restarts')

  // restart and start(): no need to re- submitInput, automatically continue run complete
  const { models: models2, faux: faux2 } = createFaux()
  faux2.setResponses([fauxAssistantMessage('graceful restart connect continue complete')])
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
  assert.equal(await runtime2.getLastAssistantText(1), 'graceful restart connect continue complete')
})

test('replay: safe only read tool read and read_artifact in runtime.close() interrupt after automatically replay complete turn', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-safe-replay-close-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeFileSync(join(dataDir, 'note.txt'), 'READ_REPLAY_OK_CONTENT\n', 'utf8')

  // ---- 1) read in phase: 'execute' encounter runtime.close() ----
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
  // first start close() make Harness abort when before ToolTask abortSignal, again let through spill return, trigger wrapToolExecute throw AbortError
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
    `read should automatically replay and return real file content (actual:${JSON.stringify(readToolResults)})`,
  )

  // ---- 2) read_artifact in phase: 'execute' encounter r2.close() ----
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
    `read_artifact should automatically replay and return real artifact content (actual:${JSON.stringify(artToolResults)})`,
  )
})

test('SIGKILL real crash:read automatically replay succeeded;bash never replay and converge is interrupted hand over model continue row', { timeout: 60_000 }, async (t) => {
  // ---- A) read in child process SIGKILL crash after automatically replay ----
  const readDir = mkdtempSync(join(tmpdir(), 'helm-sigkill-read-'))
  const readSeedDir = mkdtempSync(join(tmpdir(), 'helm-sigkill-read-seed-'))
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
const dataDir = process.env.HELM_DATA_DIR
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
      return fauxAssistantMessage('crash after only read replay succeeded')
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
    assert.equal(await readRecover.getLastAssistantText(1), 'crash after only read replay succeeded')
    const results = collectToolResultTexts(readCtxAfterKill)
    assert.ok(
      results.some((tr) => !tr.isError && tr.text.includes('SIGKILL_READ_REPLAY_OK')),
      `SIGKILL after read must replay return real file (actual:${JSON.stringify(results)})`,
    )
  } finally {
    await readRecover.close()
  }

  // ---- B) bash in child process SIGKILL crash after never replay, converge is interrupted ----
  const bashDir = mkdtempSync(join(tmpdir(), 'helm-sigkill-bash-'))
  const bashSeedDir = mkdtempSync(join(tmpdir(), 'helm-sigkill-bash-seed-'))
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
const dataDir = process.env.HELM_DATA_DIR
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
  assert.equal(readFileSync(markerPath, 'utf8'), 'x', 'crash before bash exactly execute once')

  let bashCtxAfterKill: TranscriptContext | undefined
  const { models: bm, faux: bf } = createFaux()
  bf.setResponses([
    (ctx) => {
      bashCtxAfterKill = ctx
      return fauxAssistantMessage('already confirm command interrupt, not replay')
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
    assert.equal(readFileSync(markerPath, 'utf8'), 'x', 'non- security tool bash after restart never can replay')
    assert.equal(await bashRecover.getLastAssistantText(1), 'already confirm command interrupt, not replay')
    const results = collectToolResultTexts(bashCtxAfterKill)
    assert.ok(
      results.some((tr) => tr.isError && /interrupted/i.test(tr.text)),
      `bash interrupt after must with interrupted error hand over by model continue row (actual:${JSON.stringify(results)})`,
    )
  } finally {
    await bashRecover.close()
  }
})
