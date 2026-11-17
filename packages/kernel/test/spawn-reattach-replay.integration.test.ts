/**
 * PluginToolSpec.replay 与 spawnAgent(requestId + reattach.conversationId) 跨重启恢复集成测试。
 *
 * 覆盖：
 * 1. reattach 边界强校验与并发保护（与 resume/fork 互斥 400、非法 conversationId 400、
 *    缺少/跨父归属 404 且绝不新建会话、缺失 requestId 400、仅 executionId 400 unsupported_runtime、
 *    并发重挂 409 subagent_in_use 与 activeSpawnExecutions 占位清理）；
 * 2. PluginToolSpec.replay: 'safe' 在 runtime.close() 与 SIGKILL 崩溃中断后自动重放完成回合，
 *    而 replay: 'unsafe' / 缺省工具在 SIGKILL 后绝不重放并收敛为 interrupted 错误结果；
 * 3. spawnAgent 携带 requestId + reattach.conversationId（普通文本+gate、schema+gate 重启后调用工具、
 *    崩溃前已提交 register_structured_output 回填免重追问、:schema-heal 回合崩溃重挂去重）
 *    在 runtime.close() 与 SIGKILL 下原位续跑结算、零重复用户消息。
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
            `seeder 异常退出 (code=${code}, signal=${signal}, killedByParent=${killedByParent}): ${stdout}${stderr}`.slice(0, 2000),
          ),
        )
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

test('spawnAgent reattach 边界强校验：互斥、非法 ID、父归属不符与并发占锁', { timeout: 60_000 }, async (t) => {
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

  // 先派生一个真实子会话
  faux.setResponses([fauxAssistantMessage('初始子会话完成')])
  let childId = 0
  await runtime.spawnAgent({
    parentConversationId: 1,
    prompt: '初始派生',
    requestId: 'req-init',
    onResolved: (info) => {
      childId = info.conversationId ?? 0
    },
  })
  assert.ok(childId > 1)
  const convCountBefore = runtime.listConversations().length
  const callsBefore = faux.state.callCount

  // 1) reattach 与 resume / fork 互斥（400 validation_error）
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: '冲突',
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
        prompt: '冲突',
        requestId: 'req-conflict-2',
        fork: true,
        reattach: { conversationId: childId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )

  // 2) 非法 reattach 形状 / 非正安全整数 conversationId / 空 requestId
  for (const badConvId of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () =>
        runtime.spawnAgent({
          parentConversationId: 1,
          prompt: '非法',
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
        prompt: '空对象',
        requestId: 'req-empty',
        reattach: {},
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: '相对路径',
        requestId: 'req-rel-cwd',
        reattach: { conversationId: childId, effectiveCwd: 'relative/path' },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: '缺少 requestId',
        reattach: { conversationId: childId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )

  // 3) 会话不存在、根会话无父链、跨父归属不符（404 not_found，绝不新建会话假冒重挂）
  for (const [parentId, targetId] of [
    [1, 999999],
    [1, 1],
    [999, childId],
  ] as const) {
    await assert.rejects(
      () =>
        runtime.spawnAgent({
          parentConversationId: parentId,
          prompt: '越权重挂',
          requestId: 'req-wrong-owner',
          reattach: { conversationId: targetId },
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
    )
  }

  // 4) 仅 executionId 到达原生执行行（无外部运行时插件接管）：显式 unsupported_runtime
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: '外部重挂',
        requestId: 'req-exec-only',
        reattach: { executionId: 'pane-1' },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime' && err.status === 400,
  )

  assert.equal(runtime.listConversations().length, convCountBefore, '拒绝路径绝不得新建会话')
  assert.equal(faux.state.callCount, callsBefore, '拒绝路径绝不得触发模型请求')

  // 5) 并发重挂占锁（activeSpawnExecutions + claimSpawnConversation）：409 subagent_in_use
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
    name: '并发重挂锁测试插件',
    definePlugin(ctx) {
      ctx.tool({
        name: 'hold_tool',
        description: '阻塞等待释放',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          enteredTool()
          await gateTool
          return 'released'
        },
      })
    },
  })

  // 先建立一次运行中子会话，在工具阻塞期间由另一侧发起并发重挂（不通过同一 spawn 调用本身）
  // 场景 A：通过 runtime.close() 中断后重挂，再由第二个并发重挂检测 409 冲突
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_tool', {}, { id: 'hold-1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('慢子会话完成'),
  ])
  let slowChildId = 0
  const firstRun = runtime.spawnAgent({
    parentConversationId: 1,
    prompt: '执行阻塞工具',
    requestId: 'req-concurrent',
    cwd: childWorkDir,
    onResolved: (info) => {
      slowChildId = info.conversationId ?? 0
    },
  })
  await waitTool
  assert.ok(
    runtime.agentSpawn.listActiveSpawnExecutions().some((info) => info.conversationId === slowChildId),
    '在途 spawn 必须在 activeSpawnExecutions 可见',
  )
  await assert.rejects(
    () =>
      runtime.spawnAgent({
        parentConversationId: 1,
        prompt: '并发重挂',
        requestId: 'req-concurrent',
        reattach: { conversationId: slowChildId },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'subagent_in_use' && err.status === 409,
  )
  releaseTool()
  assert.equal(await firstRun, '慢子会话完成')
  assert.equal(
    runtime.agentSpawn.listActiveSpawnExecutions().some((info) => info.conversationId === slowChildId),
    false,
    '完成后 activeSpawnExecutions 必须释放',
  )
})

test('PluginToolSpec.replay: safe 在 runtime.close() 与 SIGKILL 下自动重放；unsafe 绝不重放', { timeout: 60_000 }, async (t) => {
  // ---- A) runtime.close() 优雅中断期间重放 replay: 'safe' 插件工具 ----
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
    name: '可重放插件工具',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_lookup',
        description: '可重放只读插件工具',
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
  void r1.submitInput(1, '调用插件安全工具').catch(() => {})
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
      return fauxAssistantMessage('插件安全工具重放成功')
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
    name: '可重放插件工具',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_lookup',
        description: '可重放只读插件工具',
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
  assert.equal(await r2.getLastAssistantText(1), '插件安全工具重放成功')
  const closeResults = collectToolResultTexts(capturedCtx)
  assert.ok(
    closeResults.some((tr) => !tr.isError && tr.text.includes('SAFE_REPLAYED:alpha')),
    `close() 后 replay:'safe' 插件工具必须重放返回真实结果（实际：${JSON.stringify(closeResults)}）`,
  )

  // ---- B) SIGKILL 真实进程崩溃：safe 插件工具自动重放，unsafe 插件工具绝不重放 ----
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
  name: 'SIGKILL 插件重放验证',
  definePlugin(ctx) {
    ctx.tool({
      name: 'plugin_safe',
      description: '可重放插件工具',
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
      description: '非幂等插件工具',
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
void runtime.submitInput(1, '并行运行 safe 与 unsafe 插件工具').catch(() => {})
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
      return fauxAssistantMessage('SIGKILL 插件工具重放边界验证完成')
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
      name: 'SIGKILL 插件重放验证',
      definePlugin(ctx) {
        ctx.tool({
          name: 'plugin_safe',
          description: '可重放插件工具',
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
          description: '非幂等插件工具',
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
    assert.equal(readFileSync(safeMarker, 'utf8'), 'ss', 'replay: safe 在 SIGKILL 后必须重放一次')
    assert.equal(readFileSync(unsafeMarker, 'utf8'), 'u', 'replay: unsafe 在 SIGKILL 后绝不能重放')
    assert.equal(await recovered.getLastAssistantText(1), 'SIGKILL 插件工具重放边界验证完成')
    const results = collectToolResultTexts(sigkillCtx)
    assert.ok(results.some((tr) => !tr.isError && tr.text.includes('SIGKILL_SAFE_OK:k1')))
    assert.ok(results.some((tr) => tr.isError && /interrupted/i.test(tr.text)))
  } finally {
    await recovered.close()
  }
})

test('spawnAgent(requestId + reattach.conversationId) 跨 runtime.close() 原位续跑（纯文本/schema/pre-crash 回填/heal）且零重复用户消息', { timeout: 60_000 }, async (t) => {
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string' },
      count: { type: 'integer' },
    },
    required: ['status', 'count'],
    additionalProperties: false,
  } as Record<string, unknown>

  // ---- 场景 1：带 schema + gate，在插件 safe 工具执行期 close()，重启后调用 register_structured_output 并过 gate ----
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
    name: '暂停工具',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_pause',
        description: '可重放暂停工具',
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
      prompt: '产出结构化状态',
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

  // 重启（模拟 pluginHost.start() 先于 harness.resume()）：预挂 reattach 后再 start()
  const { models: m1b, faux: f1b } = createFaux()
  f1b.setResponses([
    fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { status: 'resumed', count: 7 } })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('已完成结构化提交'),
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
    name: '暂停工具',
    definePlugin(ctx) {
      ctx.tool({
        name: 'safe_pause',
        description: '可重放暂停工具',
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
    prompt: '产出结构化状态',
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
  assert.equal(await countUserEntries(r1b, childId1), 1, '重挂不得重复写入用户消息')
  assert.equal(r1b.listConversations().length, 2, '重挂不得新建额外子会话')

  // ---- 场景 2：崩溃前 register_structured_output 已成功落库，重启后模型仅输出收尾文本，回填 accepted 免追问 ----
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
    name: '结构化后暂停',
    definePlugin(ctx) {
      ctx.tool({
        name: 'after_structured_pause',
        description: '占位等待关停',
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
      prompt: '先提交结构化输出再继续',
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
  f2b.setResponses([fauxAssistantMessage('收尾纯文本（不重复调用 register_structured_output）')])
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
    name: '结构化后暂停',
    definePlugin(ctx) {
      ctx.tool({
        name: 'after_structured_pause',
        description: '占位等待关停',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => 'done_after_restart',
      })
    },
  })
  await r2b.start()
  const result2b = await r2b.spawnAgent({
    parentConversationId: 1,
    prompt: '先提交结构化输出再继续',
    requestId: 'req-prefilled-1',
    schema,
    reattach: { conversationId: childId2 },
  })
  assert.deepEqual(result2b, { status: 'pre-crash', count: 9 })
  assert.equal(f2b.state.callCount, 1, '已回填 accepted 后绝不发 :schema-heal 二次追问')
  assert.equal(await countUserEntries(r2b, childId2), 1)

  // ---- 场景 3：在 :schema-heal 追问回合中断，重挂后幂等去重 :schema-heal（零重复追问） ----
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
    name: '追问期暂停',
    definePlugin(ctx) {
      ctx.tool({
        name: 'heal_pause',
        description: '追问期阻塞工具',
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
    fauxAssistantMessage('首轮忘记调用结构化工具'),
    fauxAssistantMessage([fauxToolCall('heal_pause', {}, { id: 'hp1' })], { stopReason: 'toolUse' }),
  ])
  const spawn3a = r3a
    .spawnAgent({
      parentConversationId: 1,
      prompt: '请输出结构化 JSON',
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
    fauxAssistantMessage('追问后完成'),
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
    name: '追问期暂停',
    definePlugin(ctx) {
      ctx.tool({
        name: 'heal_pause',
        description: '追问期阻塞工具',
        inputSchema: { type: 'object', properties: {} },
        replay: 'safe',
        execute: async () => 'heal_pause_ok',
      })
    },
  })
  await r3b.start()
  const result3b = await r3b.spawnAgent({
    parentConversationId: 1,
    prompt: '请输出结构化 JSON',
    requestId: 'req-heal-close',
    schema,
    reattach: { conversationId: childId3 },
  })
  assert.deepEqual(result3b, { status: 'healed', count: 2 })
  assert.equal(await countUserEntries(r3b, childId3), 2, '首轮与 :schema-heal 各恰一条 pi.user（零重复）')

  // ---- 场景 4：纯文本回合在 close() 前已写完（lastAssistant 内存缓存未建），重挂直接取回文本并跑过 gate ----
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
    prompt: '纯文本任务',
    requestId: 'req-plain-done',
    cwd: dir4,
    onResolved: (info) => {
      childId4 = info.conversationId ?? 0
    },
  })
  assert.equal(plainFirst, 'PRE_RESTART_PLAIN_TEXT')
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
    prompt: '纯文本任务',
    requestId: 'req-plain-done',
    gate: 'test -f plain-gate.txt',
    reattach: { conversationId: childId4 },
    onGateResult: (gate) => {
      plainGate = gate
    },
  })
  assert.equal(reattachedPlain, 'PRE_RESTART_PLAIN_TEXT')
  assert.equal(plainGate?.ok, true)
  assert.equal(f4b.state.callCount, 0, '崩溃前已完成的提交重挂不得重发模型请求')
  assert.equal(await countUserEntries(r4b, childId4), 1)
})

test('spawnAgent(requestId + reattach.conversationId) 跨 SIGKILL 原位恢复（含已落库 schema 回填、gate 验收、零重复消息）', { timeout: 60_000 }, async (t) => {
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
  prompt: '先提交结构化结果再运行命令',
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
      return fauxAssistantMessage('SIGKILL 后收尾完成')
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
      prompt: '先提交结构化结果再运行命令',
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
    assert.equal(seenInterruptedBash, true, 'SIGKILL 后 bash 必须以 interrupted 交给模型自愈')
    assert.equal(readFileSync(join(childWorkDir, 'bash_runs.txt'), 'utf8'), 'x', '非安全 bash 绝不重放')
    assert.equal(reattachedInfo?.conversationId, childId)
    assert.equal(reattachedInfo?.effectiveCwd, childWorkDir)
    assert.equal(gateInfo?.ok, true)
    assert.equal(f2.state.callCount, 1, '已回填崩溃前 register_structured_output，不得重复追问')
    assert.equal(await countUserEntries(recovered, childId), 1, 'SIGKILL 重挂后必须保持零重复用户消息')
    assert.equal(recovered.listConversations().length, 2)
  } finally {
    await recovered.close()
  }

  // ---- B) SIGKILL 中断在调用 register_structured_output 之前，重启后首次调用工具通过 schema + gate ----
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
  prompt: '先检查环境再提交结构化输出',
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
    fauxAssistantMessage('SIGKILL 后首次调用结构化工具完成'),
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
      prompt: '先检查环境再提交结构化输出',
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
