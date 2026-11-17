/**
 * Chord Context propagation, HTTP ?wait=1 disconnect abort wiring, harness.closed / HelmStore fatal
 * storage circuit breaker, and DiagnosticSink centralized redaction & reporting tests.
 */

import {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withContextValue,
  type Context,
} from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { HelmError, type HelmEventFrame } from '@helm/protocol'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { startHub } from '../src/http/index.js'
import {
  KernelRuntime,
  createDiagnosticEmitter,
  type KernelDiagnosticEvent,
} from '../src/runtime/index.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../src/runtime/tools.js'
import { resolveToolTarget } from '../src/runtime/tools/tool-target.js'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

let root: string

before(async () => {
  root = await makeTempDir('helm-ctx-faults-')
})

after(async () => {
  await cleanupDir(root)
})

async function openTestRuntime(
  dir: string,
  options: { onDiagnostic?: (event: KernelDiagnosticEvent) => void; autoResume?: boolean } = {},
) {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    externalSkillRoots: [],
    ...(options.autoResume !== undefined ? { autoResume: options.autoResume } : {}),
    ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  })
  return Object.assign(runtime, { __faux: faux })
}

async function makeToolDeps(dir: string): Promise<HelmToolDeps> {
  await ensureDataDir(dir)
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts,
  }
}

describe('tool layer Chord Context passthrough and structuredOutputSchema coverage', { timeout: 60_000 }, () => {
  it('read / write / edit / bash and resolveToolTarget pass current execution context through to api.agent', { timeout: 60_000 }, async () => {
    const dir = join(root, 'tools-ctx')
    const deps = await makeToolDeps(dir)
    const samplePath = join(dir, 'sample.txt')
    writeFileSync(samplePath, 'hello world\n', 'utf8')

    const TRACE_KEY = createContextKey<string>('test.traceId')
    const ac = new AbortController()
    const customCtx = withAbortSignal(
      ac.signal,
      withContextValue(TRACE_KEY, 'trace-123', BACKGROUND_CONTEXT),
    )

    const seenContexts: Context[] = []
    const api = {
      conversationId: 1 as never,
      callId: 'call-1',
      async agent(ctx: Context) {
        seenContexts.push(ctx)
        return { cwd: dir } as never
      },
    } as unknown as ToolExecutionApi

    const readTool = createReadTool(deps)
    const writeTool = createWriteTool(deps)
    const editTool = createEditTool(deps)
    const bashTool = createBashTool(deps)

    assert.ok(readTool.structuredOutputSchema)
    assert.ok(writeTool.structuredOutputSchema)
    assert.ok(editTool.structuredOutputSchema)
    assert.ok(bashTool.structuredOutputSchema)

    const targetWithCtx = await resolveToolTarget(deps, api, customCtx)
    assert.ok(!('error' in targetWithCtx))
    assert.strictEqual(seenContexts.at(-1), customCtx)
    assert.equal(seenContexts.at(-1)?.value(TRACE_KEY), 'trace-123')

    const targetDefault = await resolveToolTarget(deps, api)
    assert.ok(!('error' in targetDefault))
    assert.strictEqual(seenContexts.at(-1), BACKGROUND_CONTEXT)

    const readRes = await readTool.execute({ path: samplePath }, api, customCtx)
    assert.equal(readRes.isError, undefined)
    assert.strictEqual(seenContexts.at(-1), customCtx)

    const writeRes = await writeTool.execute({ path: join(dir, 'out.txt'), content: 'alpha\n' }, api, customCtx)
    assert.equal(writeRes.isError, undefined)
    assert.strictEqual(seenContexts.at(-1), customCtx)

    const editRes = await editTool.execute(
      { path: join(dir, 'out.txt'), oldText: 'alpha', newText: 'beta' },
      api,
      customCtx,
    )
    assert.equal(editRes.isError, undefined)
    assert.strictEqual(seenContexts.at(-1), customCtx)

    const bashRes = await bashTool.execute({ command: 'echo ok' }, api, customCtx)
    assert.equal(bashRes.isError, false)
    assert.strictEqual(seenContexts.at(-1), customCtx)
  })
})

describe('waitForInput and HTTP ?wait=1 AbortSignal passthrough', { timeout: 60_000 }, () => {
  it('waitForInput unblocks immediately with aborted error when signal aborts, without cancelling background durable turn', { timeout: 60_000 }, async () => {
    const dir = join(root, 'wait-abort-direct')
    const kernel = await openTestRuntime(dir)
    try {
      let releaseTurn!: () => void
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      let turnStarted!: () => void
      const startedGate = new Promise<void>((resolve) => {
        turnStarted = resolve
      })

      kernel.__faux.setResponses([
        async () => {
          turnStarted()
          await turnGate
          return fauxAssistantMessage('background turn completed')
        },
      ])

      const { submissionId } = await kernel.submitInput(1, 'slow turn')
      await startedGate

      const controller = new AbortController()
      const waitPromise = kernel.waitForInput(1, submissionId, controller.signal)
      const t0 = Date.now()
      controller.abort()
      await assert.rejects(
        () => waitPromise,
        (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 499,
      )
      assert.ok(Date.now() - t0 < 2_000, 'aborting waitForInput must unblock immediately')

      // Pre-aborted signal fails fast immediately
      await assert.rejects(
        () => kernel.waitForInput(1, submissionId, controller.signal),
        (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 499,
      )

      // Release latch: background durable turn was not cancelled, finishes cleanly, and re-awaiting receives full result
      releaseTurn()
      const finalResult = await kernel.waitForInput(1, submissionId)
      assert.equal(finalResult.text, 'background turn completed')
    } finally {
      await kernel.close()
    }
  })

  it('POST /api/conversations/:id/input?wait=1 client disconnect immediately unblocks server wait while background turn completes', { timeout: 60_000 }, async () => {
    const dir = join(root, 'wait-abort-http')
    const kernel = await openTestRuntime(dir)
    const hub = await startHub({ kernel, port: 0 })
    try {
      const { token } = await kernel.auth.setup('secret-passphrase-123')
      let releaseTurn!: () => void
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      let turnStarted!: () => void
      const startedGate = new Promise<void>((resolve) => {
        turnStarted = resolve
      })

      // Observe when server waitForInput enters and unblocks on client disconnect (without altering real behavior)
      let waitEntered!: () => void
      const waitEnteredGate = new Promise<void>((resolve) => {
        waitEntered = resolve
      })
      let waitSettledAt: number | undefined
      let waitError: unknown
      const origWaitForInput = kernel.waitForInput.bind(kernel)
      kernel.waitForInput = async (id, submissionId, signal) => {
        waitEntered()
        try {
          return await origWaitForInput(id, submissionId, signal)
        } catch (err) {
          waitError = err
          throw err
        } finally {
          waitSettledAt = Date.now()
        }
      }

      kernel.__faux.setResponses([
        async () => {
          turnStarted()
          await turnGate
          return fauxAssistantMessage('background turn completed after HTTP disconnect')
        },
      ])

      const url = new URL(`${hub.url}/api/conversations/1/input?wait=1`)
      const body = JSON.stringify({ text: 'trigger wait then disconnect' })

      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          assert.fail(`must not receive HTTP response before client disconnect (status=${res.statusCode})`)
        },
      )
      req.on('error', () => {
        // Ignore ECONNRESET triggered by deliberate client destroy
      })
      req.write(body)
      req.end()

      await Promise.all([startedGate, waitEnteredGate])
      assert.equal(waitSettledAt, undefined, 'server waitForInput should remain suspended prior to disconnect')

      req.destroy()
      for (let i = 0; i < 40 && waitSettledAt === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }
      assert.ok(waitSettledAt !== undefined, 'client disconnect must unblock server waitForInput immediately')
      assert.ok(
        waitError instanceof HelmError && waitError.code === 'aborted' && waitError.status === 499,
        `server side should reject with aborted 499 (got ${String(waitError)})`,
      )

      // Release background turn; verify durable turn continued and persisted cleanly
      releaseTurn()
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const lastEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
      assert.ok(lastEntry, 'client disconnect must not cancel background durable turn')
      assert.equal(await kernel.getLastAssistantText(1), 'background turn completed after HTTP disconnect')
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})

describe('harness.closed, HelmStore fatal storage circuit breaker, and DiagnosticSink', { timeout: 60_000 }, () => {
  it('normal close() does not set fatalError or emit fault diagnostics', { timeout: 60_000 }, async () => {
    const dir = join(root, 'normal-close')
    const diagnostics: KernelDiagnosticEvent[] = []
    const kernel = await openTestRuntime(dir, { onDiagnostic: (e) => diagnostics.push(e) })
    const notifications: HelmEventFrame[] = []
    kernel.events.subscribe((f) => {
      if (f.event.type === 'notification') notifications.push(f)
    })

    await kernel.close()
    assert.equal(kernel.fatalError, undefined)
    assert.equal(diagnostics.length, 0)
    assert.equal(notifications.length, 0)
  })

  it('harness.closed ending in failure records fatalError, reports redacted diagnostics, publishes error notification, and rejects subsequent writes', { timeout: 60_000 }, async () => {
    const dir = join(root, 'harness-failed')
    const diagnostics: KernelDiagnosticEvent[] = []
    const kernel = await openTestRuntime(dir, { onDiagnostic: (e) => diagnostics.push(e) })
    const notifications: HelmEventFrame[] = []
    kernel.events.subscribe((f) => {
      if (f.event.type === 'notification') notifications.push(f)
    })

    const secret = 'sk-harness-secret-leak-999'
    kernel.stash.addRedaction(secret)

    // Break only Harness underlying storage.commit (leave HelmStore writable to test live EventHub notification)
    const internals = kernel as unknown as {
      database: { storage: { commit: (...args: unknown[]) => Promise<unknown> } }
    }
    internals.database.storage.commit = async () => {
      throw new Error(`sqlite write failed: ${secret}`)
    }

    try {
      await assert.rejects(() => kernel.createConversation({}))
      // Wait for harness.closed microtask/shutdown pipeline to settle
      for (let i = 0; i < 40 && kernel.fatalError === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }

      assert.ok(kernel.fatalError instanceof HelmError, 'should record readonly fatalError')
      assert.ok(!kernel.fatalError.message.includes(secret), 'fatalError must be redacted')
      assert.ok(kernel.fatalError.message.includes('[REDACTED]'))

      const harnessDiag = diagnostics.find((d) => d.source === 'harness')
      assert.ok(harnessDiag, 'should emit harness fault on diagnostic channel')
      assert.equal(harnessDiag.level, 'error')
      assert.ok(!harnessDiag.message.includes(secret))
      assert.ok(!(harnessDiag.error ?? '').includes(secret), 'diagnostic error must be redacted')

      assert.ok(notifications.length >= 1, 'harness fault should publish error notification via EventHub')
      const lastNote = notifications.at(-1)!.event as { type: 'notification'; level: string; body?: string }
      assert.equal(lastNote.level, 'error')
      assert.ok(!(lastNote.body ?? '').includes(secret), 'notification body must be redacted')

      // Subsequent write/mutation requests must reject explicitly rather than pretending health
      await assert.rejects(
        () => kernel.submitInput(1, 'write request should reject'),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.createConversation({}),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.updateConversation(1, { title: 'must fail' }),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.resetConversation(1),
        (err: unknown) => err === kernel.fatalError,
      )
    } finally {
      await kernel.close()
    }
  })

  it('HelmStore instance-scoped onError isolates multiple KernelRuntime instances and routes diagnostics and internal notifications', { timeout: 60_000 }, async () => {
    const dirA = join(root, 'multi-a')
    const dirB = join(root, 'multi-b')
    const diagA: KernelDiagnosticEvent[] = []
    const diagB: KernelDiagnosticEvent[] = []
    const kernelA = await openTestRuntime(dirA, { onDiagnostic: (e) => diagA.push(e) })
    const kernelB = await openTestRuntime(dirB, { onDiagnostic: (e) => diagB.push(e) })

    const secretA = 'sk-store-secret-aaa'
    kernelA.stash.addRedaction(secretA)

    const hostNotesA: unknown[] = []
    const hostNotesB: unknown[] = []
    kernelA.onEvent('notification', (p) => {
      hostNotesA.push(p)
    })
    kernelB.onEvent('notification', (p) => {
      hostNotesB.push(p)
    })

    // Inject SQL write failure strictly into kernelA's HelmStore
    const internalsA = kernelA as unknown as {
      database: { db: { run: (sql: string, ...params: unknown[]) => Promise<unknown> } }
    }
    const origRun = internalsA.database.db.run.bind(internalsA.database.db)
    internalsA.database.db.run = (sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO helm_plugin_docs')) {
        return Promise.reject(new Error(`injected store write failure: ${secretA}`))
      }
      return origRun(sql, ...params)
    }

    try {
      kernelA.documentStore.set('pluginA:k', { ok: true })
      await assert.rejects(
        () => kernelA.documentStore.flush(),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )

      assert.ok(kernelA.fatalError instanceof HelmError, 'kernelA should record fatalError')
      assert.ok(!kernelA.fatalError.message.includes(secretA), 'fatalError must be redacted')
      assert.equal(kernelB.fatalError, undefined, 'kernelB must stay isolated from kernelA faults')

      const storeDiagA = diagA.find((d) => d.source === 'store')
      assert.ok(storeDiagA, 'diagA should receive store diagnostic event')
      assert.ok(!(storeDiagA.error ?? '').includes(secretA), 'diagA error must be redacted')
      assert.equal(diagB.length, 0, 'diagB must receive zero events from kernelA fault')

      // Internal host notification fallback delivers to kernelA without spilling to kernelB
      await new Promise((r) => setTimeout(r, 20))
      assert.ok(hostNotesA.length >= 1, 'kernelA internal listener should receive fault notification')
      assert.equal(hostNotesB.length, 0, 'kernelB must receive zero fault notifications')

      // kernelA rejects subsequent writes while kernelB keeps working cleanly
      await assert.rejects(
        () => kernelA.submitInput(1, 'should fail after breaker trip'),
        (err: unknown) => err === kernelA.fatalError,
      )
      const convB = await kernelB.createConversation({ title: 'B healthy' })
      assert.equal(convB.title, 'B healthy')
    } finally {
      await assert.rejects(
        () => kernelA.close(),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      await kernelB.close()
    }
  })

  it('DiagnosticSink auto-redacts, isolates throwing sinks, and safely formats null-prototype error objects', { timeout: 60_000 }, async () => {
    const captured: KernelDiagnosticEvent[] = []
    const stash = new SecretStash()
    stash.addRedaction('super-secret-value')

    const emit = createDiagnosticEmitter({
      sink: (event) => captured.push(event),
      redact: (t) => stash.redact(t),
    })

    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto['x'] = 1
    emit({
      level: 'warn',
      source: 'unit.test',
      message: 'alert with super-secret-value',
      error: new Error('boom super-secret-value'),
      conversationId: 42,
    })
    emit({
      source: 'unit.nullproto',
      message: 'null-prototype error',
      error: nullProto,
    })

    assert.equal(captured.length, 2)
    assert.equal(captured[0]!.level, 'warn')
    assert.equal(captured[0]!.conversationId, 42)
    assert.ok(!captured[0]!.message.includes('super-secret-value'))
    assert.ok(!(captured[0]!.error ?? '').includes('super-secret-value'))
    assert.equal(captured[1]!.error, '[unprintable error]')

    // Throwing sinks must not throw back to callers
    const throwingEmit = createDiagnosticEmitter({
      sink: () => {
        throw new Error('sink crashed')
      },
    })
    assert.doesNotThrow(() =>
      throwingEmit({ source: 'unit.throw', message: 'should not propagate' }),
    )

    // Standalone HelmStore with onDiagnostic routes through per-instance sink without hitting globals
    const db = await openHelmDatabase(join(root, 'standalone-store'))
    const storeEvents: KernelDiagnosticEvent[] = []
    const store = new HelmStore(db, {
      onDiagnostic: (e) => storeEvents.push(e),
      redact: (t) => stash.redact(t),
    })
    await store.load()
    const rawDb = (store as unknown as { db: { run: (sql: string, ...p: unknown[]) => Promise<void> } }).db
    const orig = rawDb.run.bind(rawDb)
    rawDb.run = (sql: string, ...p: unknown[]) => {
      if (sql.includes('helm_plugin_docs')) {
        return Promise.reject(new Error('standalone super-secret-value'))
      }
      return orig(sql, ...p)
    }
    store.putPluginDoc('p', 'k', '{"a":1}')
    await assert.rejects(() => store.flushPublic(), HelmError)
    assert.equal(storeEvents.length, 1)
    assert.equal(storeEvents[0]!.source, 'store')
    assert.ok(!(storeEvents[0]!.error ?? '').includes('super-secret-value'))
    await store.close()
    await db.close()
  })

  it('KernelRuntime internal async/listener/teardown errors funnel centrally into onDiagnostic', { timeout: 60_000 }, async () => {
    const dir = join(root, 'runtime-diag')
    const diagnostics: KernelDiagnosticEvent[] = []
    const kernel = await openTestRuntime(dir, { onDiagnostic: (e) => diagnostics.push(e) })

    const secret = 'sk-internal-listener-secret'
    kernel.stash.addRedaction(secret)

    kernel.onEvent('custom.fail', () => {
      throw new Error(`listener boom: ${secret}`)
    })
    await kernel.emitHostEvent('custom.fail', { ok: true }, { broadcast: false })
    await new Promise((r) => setTimeout(r, 15))

    const listenerDiag = diagnostics.find((d) => d.source === 'runtime.events')
    assert.ok(listenerDiag, 'internal event listener fault should report via onDiagnostic')
    assert.ok(!(listenerDiag.error ?? '').includes(secret), 'internal listener error must be redacted')

    await kernel.close()
  })
})
