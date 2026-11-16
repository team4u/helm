/**
 * Chord Context pass-through,HTTP ?wait=1 assert connect consolidate,harness.closed / HelmStore lead to life fault closed ring and
 * DiagnosticSink concentrate redaction on report test.
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

describe('tool layer Chord Context pass-through and structuredOutputSchema clean up', { timeout: 60_000 }, () => {
  it('read / write / edit / bash and resolveToolTarget pass-through when before execute context to api.agent', { timeout: 60_000 }, async () => {
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

describe('waitForInput and HTTP ?wait=1 AbortSignal pass-through', { timeout: 60_000 }, () => {
  it('waitForInput in signal abort when immediately solve except suspended and throw aborted, and do not cancel background durable turn', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('background turn continue complete')
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
      assert.ok(Date.now() - t0 < 2_000, 'abort waitForInput must immediately solve except suspended')

      // pre- abort signal directly fast failed
      await assert.rejects(
        () => kernel.waitForInput(1, submissionId, controller.signal),
        (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 499,
      )

      // release latch: background durable turn not by cancel, continue complete and can re- wait for gets complete result
      releaseTurn()
      const finalResult = await kernel.waitForInput(1, submissionId)
      assert.equal(finalResult.text, 'background turn continue complete')
    } finally {
      await kernel.close()
    }
  })

  it('POST /api/conversations/:id/input?wait=1 client assert connect immediately solve except server side wait for and background turn continue complete', { timeout: 60_000 }, async () => {
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

      // observe server side waitForInput what when enter and what when because client assert connect solve except suspended (do not change write real behavior)
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
          return fauxAssistantMessage('HTTPassert connect after background turn complete')
        },
      ])

      const url = new URL(`${hub.url}/api/conversations/1/input?wait=1`)
      const body = JSON.stringify({ text: 'trigger wait for after assert connect' })

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
          assert.fail(`client not assert connect before must not receives HTTP response (status=${res.statusCode})`)
        },
      )
      req.on('error', () => {
        // client actively destroy produce ECONNRESET ignore
      })
      req.write(body)
      req.end()

      await Promise.all([startedGate, waitEnteredGate])
      assert.equal(waitSettledAt, undefined, 'assert connect before server side waitForInput should where at suspended state')

      req.destroy()
      for (let i = 0; i < 40 && waitSettledAt === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }
      assert.ok(waitSettledAt !== undefined, 'client assert connect must immediately solve except server side waitForInput suspended')
      assert.ok(
        waitError instanceof HelmError && waitError.code === 'aborted' && waitError.status === 499,
        `server side should throw aborted 499(got ${String(waitError)})`,
      )

      // now background turn still not let through; let through after verify durable turn not by cancel, normal written to the database complete
      releaseTurn()
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const lastEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
      assert.ok(lastEntry, 'client assert connect must not cancel background durable turn')
      assert.equal(await kernel.getLastAssistantText(1), 'HTTPassert connect after background turn complete')
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})

describe('harness.closed,HelmStore lead to life store fault closed ring and DiagnosticSink', { timeout: 60_000 }, () => {
  it('normal close() does not trigger fatalError also produces no fault diagnose event', { timeout: 60_000 }, async () => {
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

  it('harness.closed with failed end when record fatalError, redaction on report diagnose, publish error notify and reject after continue write request', { timeout: 60_000 }, async () => {
    const dir = join(root, 'harness-failed')
    const diagnostics: KernelDiagnosticEvent[] = []
    const kernel = await openTestRuntime(dir, { onDiagnostic: (e) => diagnostics.push(e) })
    const notifications: HelmEventFrame[] = []
    kernel.events.subscribe((f) => {
      if (f.event.type === 'notification') notifications.push(f)
    })

    const secret = 'sk-harness-secret-leak-999'
    kernel.stash.addRedaction(secret)

    // only break Harness underlying storage.commit(HelmStore keep can write with verify EventHub real-time notify broadcast)
    const internals = kernel as unknown as {
      database: { storage: { commit: (...args: unknown[]) => Promise<unknown> } }
    }
    internals.database.storage.commit = async () => {
      throw new Error(`sqlite write failed: ${secret}`)
    }

    try {
      await assert.rejects(() => kernel.createConversation({}))
      // wait for harness.closed micro task/closure stop chain compute
      for (let i = 0; i < 40 && kernel.fatalError === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }

      assert.ok(kernel.fatalError instanceof HelmError, 'should record only read fatalError')
      assert.ok(!kernel.fatalError.message.includes(secret), 'fatalError must redaction')
      assert.ok(kernel.fatalError.message.includes('[REDACTED]'))

      const harnessDiag = diagnostics.find((d) => d.source === 'harness')
      assert.ok(harnessDiag, 'should to diagnose channel on report harness fault')
      assert.equal(harnessDiag.level, 'error')
      assert.ok(!harnessDiag.message.includes(secret))
      assert.ok(!(harnessDiag.error ?? '').includes(secret), 'diagnose error must redaction')

      assert.ok(notifications.length >= 1, 'harness fault should via EventHub publish error notify')
      const lastNote = notifications.at(-1)!.event as { type: 'notification'; level: string; body?: string }
      assert.equal(lastNote.level, 'error')
      assert.ok(!(lastNote.body ?? '').includes(secret), 'notify event body must redaction')

      // write/change new request must explicit reject while non- pretend store
      await assert.rejects(
        () => kernel.submitInput(1, 'write request should by reject'),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.createConversation({}),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.updateConversation(1, { title: 'must not succeeded' }),
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

  it('HelmStore instance level onError in many KernelRuntime instance between fully isolated and trigger diagnose and internal notify', { timeout: 60_000 }, async () => {
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

    // only to kernelA inject HelmStore SQL failed to write
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
      assert.ok(!kernelA.fatalError.message.includes(secretA), 'fatalError must redaction')
      assert.equal(kernelB.fatalError, undefined, 'kernelB must not subject to kernelA affect')

      const storeDiagA = diagA.find((d) => d.source === 'store')
      assert.ok(storeDiagA, 'diagA should receives store diagnose event')
      assert.ok(!(storeDiagA.error ?? '').includes(secretA), 'diagA error must redaction')
      assert.equal(diagB.length, 0, 'diagB must not receives kernelA fault')

      // internal host notify fall back still trigger reach kernelA, does not affect kernelB
      await new Promise((r) => setTimeout(r, 20))
      assert.ok(hostNotesA.length >= 1, 'kernelA internal listener should receives fault notify')
      assert.equal(hostNotesB.length, 0, 'kernelB must not receives fault notify')

      // kernelA after continue write/change new request by reject;kernelB normal work
      await assert.rejects(
        () => kernelA.submitInput(1, 'failed after commit'),
        (err: unknown) => err === kernelA.fatalError,
      )
      const convB = await kernelB.createConversation({ title: 'B normal' })
      assert.equal(convB.title, 'B normal')
    } finally {
      await assert.rejects(
        () => kernelA.close(),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      await kernelB.close()
    }
  })

  it('DiagnosticSink automatically redaction, isolated throw exception sink, and security format without prototype error object', { timeout: 60_000 }, async () => {
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
      message: 'contains super-secret-value alert',
      error: new Error('boom super-secret-value'),
      conversationId: 42,
    })
    emit({
      source: 'unit.nullproto',
      message: 'without prototype error',
      error: nullProto,
    })

    assert.equal(captured.length, 2)
    assert.equal(captured[0]!.level, 'warn')
    assert.equal(captured[0]!.conversationId, 42)
    assert.ok(!captured[0]!.message.includes('super-secret-value'))
    assert.ok(!(captured[0]!.error ?? '').includes('super-secret-value'))
    assert.equal(captured[1]!.error, '[unprintable error]')

    // throwing sink must not reverse devour caller
    const throwingEmit = createDiagnosticEmitter({
      sink: () => {
        throw new Error('sink crashed')
      },
    })
    assert.doesNotThrow(() =>
      throwingEmit({ source: 'unit.throw', message: 'should not propagate' }),
    )

    // independent HelmStore pass onDiagnostic when do not hit global state, by instance away diagnose channel
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

  it('KernelRuntime internal async/listen/teardown error unify gather until onDiagnostic', { timeout: 60_000 }, async () => {
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
    assert.ok(listenerDiag, 'internal event listener exception should enter onDiagnostic')
    assert.ok(!(listenerDiag.error ?? '').includes(secret), 'internal listener error must redaction')

    await kernel.close()
  })
})
