/**
 * Chord Context 透传、HTTP ?wait=1 断连收口、harness.closed / HelmStore 致命故障闭环与
 * DiagnosticSink 集中脱敏上报测试。
 */

import {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withContextValue,
  type Context,
} from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { HelmError, type HelmEventFrame } from '@helm/protocol'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
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

let root: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-ctx-faults-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeFauxModels() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

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

describe('工具层 Chord Context 透传与 structuredOutputSchema 清理', { timeout: 60_000 }, () => {
  it('read / write / edit / bash 及 resolveToolTarget 透传当前执行 context 给 api.agent', { timeout: 60_000 }, async () => {
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

describe('waitForInput 与 HTTP ?wait=1 AbortSignal 透传', { timeout: 60_000 }, () => {
  it('waitForInput 在 signal 中止时立即解除挂起并抛 aborted，且不取消后台持久回合', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('后台回合继续完成')
        },
      ])

      const { submissionId } = await kernel.submitInput(1, '慢回合')
      await startedGate

      const controller = new AbortController()
      const waitPromise = kernel.waitForInput(1, submissionId, controller.signal)
      const t0 = Date.now()
      controller.abort()
      await assert.rejects(
        () => waitPromise,
        (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 499,
      )
      assert.ok(Date.now() - t0 < 2_000, '中止 waitForInput 必须立即解除挂起')

      // 预中止 signal 直接快速失败
      await assert.rejects(
        () => kernel.waitForInput(1, submissionId, controller.signal),
        (err: unknown) => err instanceof HelmError && err.code === 'aborted' && err.status === 499,
      )

      // 释放门闩：后台持久回合未被取消，继续完成并可重新等待拿到完整结果
      releaseTurn()
      const finalResult = await kernel.waitForInput(1, submissionId)
      assert.equal(finalResult.text, '后台回合继续完成')
    } finally {
      await kernel.close()
    }
  })

  it('POST /api/conversations/:id/input?wait=1 客户端断连立即解除服务端等待且后台回合继续完成', { timeout: 60_000 }, async () => {
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

      // 观察服务端 waitForInput 何时进入及何时因客户端断连解除挂起（不改写真实行为）
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
          return fauxAssistantMessage('HTTP断连后后台回合完成')
        },
      ])

      const url = new URL(`${hub.url}/api/conversations/1/input?wait=1`)
      const body = JSON.stringify({ text: '触发等待后断连' })

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
          assert.fail(`客户端未断连前不应收到 HTTP 响应（status=${res.statusCode}）`)
        },
      )
      req.on('error', () => {
        // 客户端主动 destroy 产生的 ECONNRESET 忽略
      })
      req.write(body)
      req.end()

      await Promise.all([startedGate, waitEnteredGate])
      assert.equal(waitSettledAt, undefined, '断连前服务端 waitForInput 应处于挂起状态')

      req.destroy()
      for (let i = 0; i < 40 && waitSettledAt === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }
      assert.ok(waitSettledAt !== undefined, '客户端断连必须立即解除服务端 waitForInput 挂起')
      assert.ok(
        waitError instanceof HelmError && waitError.code === 'aborted' && waitError.status === 499,
        `服务端应抛出 aborted 499（实得 ${String(waitError)}）`,
      )

      // 此时后台回合仍未放行；放行后验证持久回合未被取消、正常落库完成
      releaseTurn()
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1)
      const lastEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
      assert.ok(lastEntry, '客户端断连不得取消后台持久回合')
      assert.equal(await kernel.getLastAssistantText(1), 'HTTP断连后后台回合完成')
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})

describe('harness.closed、HelmStore 致命存储故障闭环与 DiagnosticSink', { timeout: 60_000 }, () => {
  it('正常 close() 不触发 fatalError 也不产生故障诊断事件', { timeout: 60_000 }, async () => {
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

  it('harness.closed 以 failed 结束时记录 fatalError、脱敏上报诊断、发布错误通知并拒绝后续写请求', { timeout: 60_000 }, async () => {
    const dir = join(root, 'harness-failed')
    const diagnostics: KernelDiagnosticEvent[] = []
    const kernel = await openTestRuntime(dir, { onDiagnostic: (e) => diagnostics.push(e) })
    const notifications: HelmEventFrame[] = []
    kernel.events.subscribe((f) => {
      if (f.event.type === 'notification') notifications.push(f)
    })

    const secret = 'sk-harness-secret-leak-999'
    kernel.stash.addRedaction(secret)

    // 仅破坏 Harness 底层 storage.commit（HelmStore 保持可写以验证 EventHub 实时通知广播）
    const internals = kernel as unknown as {
      database: { storage: { commit: (...args: unknown[]) => Promise<unknown> } }
    }
    internals.database.storage.commit = async () => {
      throw new Error(`sqlite write failed: ${secret}`)
    }

    try {
      await assert.rejects(() => kernel.createConversation({}))
      // 等待 harness.closed 微任务/关停链结算
      for (let i = 0; i < 40 && kernel.fatalError === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
      }

      assert.ok(kernel.fatalError instanceof HelmError, '应记录只读 fatalError')
      assert.ok(!kernel.fatalError.message.includes(secret), 'fatalError 必须脱敏')
      assert.ok(kernel.fatalError.message.includes('[REDACTED]'))

      const harnessDiag = diagnostics.find((d) => d.source === 'harness')
      assert.ok(harnessDiag, '应向诊断通道上报 harness 故障')
      assert.equal(harnessDiag.level, 'error')
      assert.ok(!harnessDiag.message.includes(secret))
      assert.ok(!(harnessDiag.error ?? '').includes(secret), '诊断 error 必须脱敏')

      assert.ok(notifications.length >= 1, 'harness 故障应通过 EventHub 发布错误通知')
      const lastNote = notifications.at(-1)!.event as { type: 'notification'; level: string; body?: string }
      assert.equal(lastNote.level, 'error')
      assert.ok(!(lastNote.body ?? '').includes(secret), '通知事件体必须脱敏')

      // 写/变更新请求必须明确拒绝而非假装存活
      await assert.rejects(
        () => kernel.submitInput(1, '写请求应被拒绝'),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.createConversation({}),
        (err: unknown) => err === kernel.fatalError,
      )
      await assert.rejects(
        () => kernel.updateConversation(1, { title: '不应成功' }),
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

  it('HelmStore 实例级 onError 在多 KernelRuntime 实例间完全隔离且触发诊断与内部通知', { timeout: 60_000 }, async () => {
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

    // 仅给 kernelA 注入 HelmStore SQL 写入失败
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

      assert.ok(kernelA.fatalError instanceof HelmError, 'kernelA 应记录 fatalError')
      assert.ok(!kernelA.fatalError.message.includes(secretA), 'fatalError 必须脱敏')
      assert.equal(kernelB.fatalError, undefined, 'kernelB 不得受 kernelA 影响')

      const storeDiagA = diagA.find((d) => d.source === 'store')
      assert.ok(storeDiagA, 'diagA 应收到 store 诊断事件')
      assert.ok(!(storeDiagA.error ?? '').includes(secretA), 'diagA error 必须脱敏')
      assert.equal(diagB.length, 0, 'diagB 不得收到 kernelA 的故障')

      // 内部宿主通知兜底仍触达 kernelA，不影响 kernelB
      await new Promise((r) => setTimeout(r, 20))
      assert.ok(hostNotesA.length >= 1, 'kernelA 内部监听器应收到故障通知')
      assert.equal(hostNotesB.length, 0, 'kernelB 不得收到故障通知')

      // kernelA 后续写/变更新请求被拒绝；kernelB 正常工作
      await assert.rejects(
        () => kernelA.submitInput(1, '失败后提交'),
        (err: unknown) => err === kernelA.fatalError,
      )
      const convB = await kernelB.createConversation({ title: 'B 正常' })
      assert.equal(convB.title, 'B 正常')
    } finally {
      await assert.rejects(
        () => kernelA.close(),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      await kernelB.close()
    }
  })

  it('DiagnosticSink 自动脱敏、隔离抛出异常的 sink，并安全格式化无原型错误对象', { timeout: 60_000 }, async () => {
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
      message: '包含 super-secret-value 的告警',
      error: new Error('boom super-secret-value'),
      conversationId: 42,
    })
    emit({
      source: 'unit.nullproto',
      message: '无原型错误',
      error: nullProto,
    })

    assert.equal(captured.length, 2)
    assert.equal(captured[0]!.level, 'warn')
    assert.equal(captured[0]!.conversationId, 42)
    assert.ok(!captured[0]!.message.includes('super-secret-value'))
    assert.ok(!(captured[0]!.error ?? '').includes('super-secret-value'))
    assert.equal(captured[1]!.error, '[unprintable error]')

    // throwing sink 不得反噬调用方
    const throwingEmit = createDiagnosticEmitter({
      sink: () => {
        throw new Error('sink crashed')
      },
    })
    assert.doesNotThrow(() =>
      throwingEmit({ source: 'unit.throw', message: 'should not propagate' }),
    )

    // 独立 HelmStore 传入 onDiagnostic 时不打全局状态、按实例走诊断通道
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

  it('KernelRuntime 内部异步/监听/teardown 错误统一收拢至 onDiagnostic', { timeout: 60_000 }, async () => {
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
    assert.ok(listenerDiag, '内部事件监听器异常应进入 onDiagnostic')
    assert.ok(!(listenerDiag.error ?? '').includes(secret), '内部监听器错误必须脱敏')

    await kernel.close()
  })
})
