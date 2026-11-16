/**
 * Hub 进程重启优雅关停保留与工具重放恢复真实集成测试。
 *
 * 覆盖核心不变量：
 * 1. openHelmDatabase 共享连接代理：storage.close() 不提前关闭与 HelmStore 共用的
 *    底层 db；初始化失败时 catch 分支物理关闭 db，避免 FD 泄漏；
 * 2. KernelRuntime.close() 在人类会话流式生成期优雅关停：harness.close() 先于
 *    pluginHost/store/database 执行，GenerationTask 退回 pending（restarts === undefined，
 *    绝不被 closeAborts 强行 abort）；重启后无需重新 submitInput 自动完成回复；
 * 3. runtime.started 内部事件在 pluginHost.start() 与 harness.resume() 之后派发且不广播；
 * 4. 只读工具 read 与 read_artifact 声明 replay: 'safe'：无论是 runtime.close()
 *    还是真实 SIGKILL 进程崩溃中断在 phase: 'execute'，重启均自动重放并返回真实内容；
 * 5. 非安全工具 bash 保持 replay: 'unsafe'：真实 SIGKILL 崩溃中断后绝不重放，收敛为
 *    interrupted 工具错误结果并交由下一模型回合继续决策。
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
        reject(new Error(`seeder 异常退出 (code=${code}, signal=${signal}, killedByParent=${killedByParent}): ${stdout}${stderr}`.slice(0, 2000)))
      })
      child.on('error', reject)
    })
    await Promise.race([
      exited,
      delay(25_000, undefined, { ref: false }).then(() => {
        throw new Error(`seeder 25s 未进入就绪状态: ${stdout}${stderr}`.slice(0, 2000))
      }),
    ])
  } finally {
    if (child.pid !== undefined) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // 进程组已整体退出
      }
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

test('openHelmDatabase：storage.close() 不提前关共享 db；初始化失败 catch 物理关闭 db 防 FD 泄漏', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-sqlite-proxy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const db = await openHelmDatabase(dir)
  await db.storage.close(BACKGROUND_CONTEXT)
  const rows = await db.db.all<{ ok: number }>('SELECT 1 AS ok')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.ok, 1, 'storage.close() 后底层物理 db 仍可读写直到 database.close()')
  await db.close()

  // 预造残缺表结构：openNodeSqliteDatabase 成功，随后 HELM_SCHEMA 建索引 helm_artifacts(conversation_id) 失败
  const failDir = mkdtempSync(join(tmpdir(), 'helm-sqlite-fail-'))
  t.after(() => rmSync(failDir, { recursive: true, force: true }))
  const seeded = await openNodeSqliteDatabase(join(failDir, 'state.sqlite'))
  await seeded.exec('CREATE TABLE helm_artifacts (id TEXT PRIMARY KEY);')
  await seeded.close()

  await assert.rejects(() => openHelmDatabase(failDir))
  // 若 catch 未关闭 db，同一路径下清理与重开会残留 FD/锁；验证可无阻塞移除并重开
  rmSync(join(failDir, 'state.sqlite'), { force: true })
  const recovered = await openHelmDatabase(failDir)
  await recovered.close()
})

test('runtime.close() 在流式生成期间无损保活：GenerationTask 退回 pending 且无 restarts，重启后自动完成回复并按序派发 runtime.started', { timeout: 60_000 }, async (t) => {
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
    name: '生命周期顺序探针',
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
  assert.equal(leakedToEvents.length, 0, 'runtime.started 为内部事件（broadcast: false），不得广播到外部 SSE')

  // 慢速流式生成：确认会话进入 working 且部分 token 开始输出后执行优雅关停
  faux1.setResponses([fauxAssistantMessage('这是一段被优雅关停慢速流式输出的长文本用于确保关停时回合仍在生成中')])
  void runtime1.submitInput(1, '请生成长回复').catch(() => {})
  const deadline = Date.now() + 15_000
  while (runtime1.getConversation(1).status !== 'working' && Date.now() < deadline) {
    await delay(30)
  }
  assert.equal(runtime1.getConversation(1).status, 'working', '15s 内会话必须进入 working 状态')
  await delay(600)

  await runtime1.close()

  const tasksAfterClose = await inspectHarnessTasks(dataDir)
  const genTask = tasksAfterClose.find((task) => task.kind === 'pi.generation' && task.conversationId === 1)
  assert.ok(genTask, `优雅关停后必须保留 generation checkpoint（实际：${JSON.stringify(tasksAfterClose)}）`)
  assert.equal(genTask.status, 'pending')
  assert.equal(genTask.abortRequested, false)
  assert.equal(genTask.restarts, undefined, '优雅 close() 不得计入崩溃重启次数 restarts')

  // 重启并 start()：无需重新 submitInput，自动续跑完成
  const { models: models2, faux: faux2 } = createFaux()
  faux2.setResponses([fauxAssistantMessage('优雅重启接续完成')])
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
  assert.equal(await runtime2.getLastAssistantText(1), '优雅重启接续完成')
})

test('replay: safe 只读工具 read 与 read_artifact 在 runtime.close() 中断后自动重放完成回合', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-safe-replay-close-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeFileSync(join(dataDir, 'note.txt'), 'READ_REPLAY_OK_CONTENT\n', 'utf8')

  // ---- 1) read 在 phase: 'execute' 遭遇 runtime.close() ----
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
  void r1.submitInput(1, '读取 note.txt').catch(() => {})
  await waitReadEntered
  // 先发起 close() 使 Harness 中止当前 ToolTask abortSignal，再放行 spill 返回，触发 wrapToolExecute 抛 AbortError
  const closePromise1 = r1.close()
  await delay(80)
  allowSpillReturn()
  await closePromise1

  let capturedReadContext: TranscriptContext | undefined
  const { models: m2, faux: f2 } = createFaux()
  f2.setResponses([
    (ctx) => {
      capturedReadContext = ctx
      return fauxAssistantMessage('read 重放成功')
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
  assert.equal(await r2.getLastAssistantText(1), 'read 重放成功')
  const readToolResults = collectToolResultTexts(capturedReadContext)
  assert.ok(
    readToolResults.some((tr) => !tr.isError && tr.text.includes('READ_REPLAY_OK_CONTENT')),
    `read 应自动重放并返回真实文件内容（实际：${JSON.stringify(readToolResults)}）`,
  )

  // ---- 2) read_artifact 在 phase: 'execute' 遭遇 r2.close() ----
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
  void r2.submitInput(1, '读取产物').catch(() => {})
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
      return fauxAssistantMessage('read_artifact 重放成功')
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
  assert.equal(await r3.getLastAssistantText(1), 'read_artifact 重放成功')
  const artToolResults = collectToolResultTexts(capturedArtContext)
  assert.ok(
    artToolResults.some((tr) => !tr.isError && tr.text.includes('ARTIFACT_REPLAY_OK_CONTENT')),
    `read_artifact 应自动重放并返回真实产物内容（实际：${JSON.stringify(artToolResults)}）`,
  )
})

test('SIGKILL 真实崩溃：read 自动重放成功；bash 绝不重放并收敛为 interrupted 交模型续行', { timeout: 60_000 }, async (t) => {
  // ---- A) read 在子进程 SIGKILL 崩溃后自动重放 ----
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
void runtime.submitInput(1, '读取文件').catch(() => {})
await new Promise(() => {})
`,
    (stdout) => stdout.includes('READY_READ'),
  )
  let readCtxAfterKill: TranscriptContext | undefined
  const { models: rm, faux: rf } = createFaux()
  rf.setResponses([
    (ctx) => {
      readCtxAfterKill = ctx
      return fauxAssistantMessage('崩溃后只读重放成功')
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
    assert.equal(await readRecover.getLastAssistantText(1), '崩溃后只读重放成功')
    const results = collectToolResultTexts(readCtxAfterKill)
    assert.ok(
      results.some((tr) => !tr.isError && tr.text.includes('SIGKILL_READ_REPLAY_OK')),
      `SIGKILL 后 read 必须重放返回真实文件（实际：${JSON.stringify(results)}）`,
    )
  } finally {
    await readRecover.close()
  }

  // ---- B) bash 在子进程 SIGKILL 崩溃后绝不重放，收敛为 interrupted ----
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
void runtime.submitInput(1, '执行外部命令').catch(() => {})
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
  assert.equal(readFileSync(markerPath, 'utf8'), 'x', '崩溃前 bash 恰执行一次')

  let bashCtxAfterKill: TranscriptContext | undefined
  const { models: bm, faux: bf } = createFaux()
  bf.setResponses([
    (ctx) => {
      bashCtxAfterKill = ctx
      return fauxAssistantMessage('已确认命令中断，未重放')
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
    assert.equal(readFileSync(markerPath, 'utf8'), 'x', '非安全工具 bash 重启后绝不能重放')
    assert.equal(await bashRecover.getLastAssistantText(1), '已确认命令中断，未重放')
    const results = collectToolResultTexts(bashCtxAfterKill)
    assert.ok(
      results.some((tr) => tr.isError && /interrupted/i.test(tr.text)),
      `bash 中断后必须以 interrupted 错误交由模型续行（实际：${JSON.stringify(results)}）`,
    )
  } finally {
    await bashRecover.close()
  }
})
