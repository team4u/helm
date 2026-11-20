/**
 * Startup node-join grace tests (unit + restart integration).
 *
 * Covers:
 * - `waitForNodesOnline` pure mechanism: immediate return on empty set / zero timeout, early return
 *   when all nodes reconnect before the deadline, honest still-offline reporting on expiry;
 * - `resolveNodeJoinGraceMs` env parsing (default / explicit / 0 disables / invalid fails loudly);
 * - listen-before-start HTTP gate: real unstarted kernel answers `503 hub_starting` on API routes
 *   while `/api/auth/status` stays available;
 * - end-to-end restart: a conversation bound to a registered remote node with an interrupted live
 *   run makes `kernel.start()` hold recovery until the node daemon reconnects (the restart race the
 *   grace closes), after which the re-driven turn completes against the reconnected node's Hub.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  createNodeDaemon,
  type NodeDaemon,
} from '@helmx/node'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { waitForNodesOnline } from '../src/runtime/node-join-grace.js'
import { resolveNodeJoinGraceMs } from '../src/runtime/runtime-bootstrap.js'
import { cleanupDir, makeFauxModels, sleep } from './helpers.js'

const require = createRequire(import.meta.url)
const KERNEL_DIR = fileURLToPath(new URL('../', import.meta.url))
const PI_AI_FAUX_URL = pathToFileURL(
  join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'),
).href
const KERNEL_SRC = pathToFileURL(join(KERNEL_DIR, 'src/runtime/index.ts')).href
const TSX_CLI = require.resolve('tsx/cli')

let rootDir: string

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'helmx-node-join-grace-'))
})

after(async () => {
  await cleanupDir(rootDir)
})

// ---------------------------------------------------------------------------
// Unit: waitForNodesOnline (pure mechanism, injectable clock/events)
// ---------------------------------------------------------------------------

describe('waitForNodesOnline (unit)', { timeout: 60_000 }, () => {
  it('returns immediately with zero wait when the needed set is empty', async () => {
    const events: string[] = []
    const result = await waitForNodesOnline({
      nodeIds: new Set(['lx']),
      timeoutMs: 5_000,
      isOnline: () => true, // already online -> filtered out before waiting
      onNodeChanged: (listener) => {
        events.push('subscribed')
        return () => events.push('unsubscribed')
      },
      log: () => undefined,
    })
    assert.deepEqual(result, { waitedNodeIds: [], onlineNodeIds: [], stillOfflineNodeIds: [], elapsedMs: 0 })
    assert.deepEqual(events, [], 'no event subscription for an empty pending set')
  })

  it('returns immediately when timeoutMs is 0 even with offline nodes', async () => {
    const result = await waitForNodesOnline({
      nodeIds: new Set(['lx']),
      timeoutMs: 0,
      isOnline: () => false,
      onNodeChanged: () => () => undefined,
      log: () => undefined,
    })
    assert.deepEqual(result, { waitedNodeIds: [], onlineNodeIds: [], stillOfflineNodeIds: [], elapsedMs: 0 })
  })

  it('resolves early when all pending nodes reconnect before the deadline', async () => {
    let clock = 1_000
    const online = new Set(['a'])
    const listeners = new Set<(nodeId: string, online: boolean) => void>()
    const waitPromise = waitForNodesOnline({
      nodeIds: new Set(['a', 'b']),
      timeoutMs: 10_000,
      isOnline: (nodeId) => online.has(nodeId),
      onNodeChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      now: () => clock,
      log: () => undefined,
    })
    await sleep(20)
    clock = 1_250
    online.add('b')
    listeners.forEach((notify) => notify('b', true))
    const result = await waitPromise
    assert.deepEqual(result.waitedNodeIds, ['b'], 'already-online nodes are not waited for')
    assert.deepEqual(result.onlineNodeIds, ['b'])
    assert.deepEqual(result.stillOfflineNodeIds, [])
    assert.equal(result.elapsedMs, 250)
  })

  it('reports still-offline nodes honestly when the grace expires', async () => {
    let clock = 0
    const result = await waitForNodesOnline({
      nodeIds: new Set(['gone']),
      timeoutMs: 50,
      isOnline: () => false,
      onNodeChanged: () => () => undefined,
      now: () => clock,
      log: () => undefined,
    })
    assert.deepEqual(result.waitedNodeIds, ['gone'])
    assert.deepEqual(result.onlineNodeIds, [])
    assert.deepEqual(result.stillOfflineNodeIds, ['gone'])
    assert.ok(result.elapsedMs >= 0 && result.elapsedMs < 5_000)
  })

  it('ignores offline events and unknown node ids; only pending-node online events count', async () => {
    let clock = 10_000
    const online = new Set<string>()
    const listeners = new Set<(nodeId: string, online: boolean) => void>()
    const waitPromise = waitForNodesOnline({
      nodeIds: new Set(['lx']),
      timeoutMs: 30_000,
      isOnline: (nodeId) => online.has(nodeId),
      onNodeChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      now: () => clock,
      log: () => undefined,
    })
    await sleep(10)
    listeners.forEach((notify) => notify('lx', false))
    listeners.forEach((notify) => notify('other', true))
    await sleep(10)
    clock = 10_100
    online.add('lx')
    listeners.forEach((notify) => notify('lx', true))
    const result = await waitPromise
    assert.deepEqual(result.onlineNodeIds, ['lx'])
    assert.equal(result.elapsedMs, 100)
  })
})

// ---------------------------------------------------------------------------
// Unit: resolveNodeJoinGraceMs env parsing
// ---------------------------------------------------------------------------

describe('resolveNodeJoinGraceMs (unit)', { timeout: 60_000 }, () => {
  it('defaults to 10s and honors explicit values including 0', () => {
    assert.equal(resolveNodeJoinGraceMs({}), 10_000)
    assert.equal(resolveNodeJoinGraceMs({ HELMX_NODE_JOIN_GRACE_MS: '0' }), 0)
    assert.equal(resolveNodeJoinGraceMs({ HELMX_NODE_JOIN_GRACE_MS: '2500' }), 2_500)
  })

  it('fails loudly on invalid values instead of silently coercing', () => {
    assert.equal(resolveNodeJoinGraceMs({ HELMX_NODE_JOIN_GRACE_MS: '' }), 10_000, 'empty string counts as unset')
    for (const bad of ['-1', 'abc', '1.5']) {
      assert.throws(() => resolveNodeJoinGraceMs({ HELMX_NODE_JOIN_GRACE_MS: bad }), /HELMX_NODE_JOIN_GRACE_MS/)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: listen-before-start HTTP gate + restart node-join grace
// ---------------------------------------------------------------------------

describe('startup node-join grace (restart integration)', { timeout: 60_000 }, () => {
  it('503 hub_starting gates API routes (auth/status exempt) while the kernel is not started', async () => {
    const dataDir = join(rootDir, 'http-gate')
    const { models } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      models: models as never,
      autoResume: false,
    })
    const hub = await startHub({ kernel: kernel as never, port: 0 })
    try {
      const gated = await fetch(`${hub.url}/api/conversations`)
      assert.equal(gated.status, 503)
      const body = (await gated.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'hub_starting')

      const probe = await fetch(`${hub.url}/api/auth/status`)
      assert.equal(probe.status, 200)

      await kernel.start()
      const open = await fetch(`${hub.url}/api/conversations`)
      assert.notEqual(open.status, 503, 'gate lifts once the kernel is started')
      assert.equal(open.status, 401, 'normal auth boundary resumes after the gate')
    } finally {
      await hub.close()
      await kernel.close()
    }
  })

  it('kernel.start() holds recovery for a registered offline node with interrupted live work, then proceeds once it reconnects', { timeout: 60_000 }, async () => {
    const dataDir = join(rootDir, 'restart-race')
    await mkdir(dataDir, { recursive: true })
    const nodeDataDir = join(rootDir, 'restart-race-node')
    const workDir = join(rootDir, 'restart-race-work')
    await mkdir(nodeDataDir, { recursive: true })
    await mkdir(workDir, { recursive: true })

    // ---- Phase 1 (child process): register the node token, create a remote-bound conversation,
    // start a slow streaming turn, then SIGKILL mid-run (real crash artifact). ----
    const out = await spawnSigkillSeeder(
      `import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(PI_AI_FAUX_URL)}
import { KernelRuntime } from ${JSON.stringify(KERNEL_SRC)}

const dataDir = process.env.HELMX_DATA_DIR!
const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } })
faux.setResponses([fauxAssistantMessage('这是一段极慢速流式回复用于在流式中途触发真实SIGKILL强杀现场验证启动节点回连等待屏障')])
const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', providers: [faux.provider], autoResume: false })
const issued = await kernel.nodes.issueNodeToken('grace-node')
const conv = await kernel.createConversation({ nodeId: 'grace-node', cwd: process.env.HELMX_WORK_DIR!, title: 'remote-bound' })
await kernel.start()
await kernel.submitInput(conv.id, '开始慢速任务')
for (let i = 0; i < 400; i++) {
  await delay(10)
  if (kernel.getConversation(conv.id).status === 'working') break
}
assert.ok(kernel.getConversation(conv.id).status === 'working', '回合应在强杀前处于 working')
await kernel.documentStore.flush()
await new Promise((resolve) => process.stdout.write('NODE_TOKEN=' + issued.token + ',CONV=' + conv.id + '\\n', resolve))
process.kill(process.pid, 'SIGKILL')
`,
      { HELMX_DATA_DIR: dataDir, HELMX_WORK_DIR: workDir },
    )
    const match = /NODE_TOKEN=([^\s,]+),CONV=(\d+)/.exec(out)
    assert.ok(match, `seeder 输出异常: ${out.slice(-500)}`)
    const nodeToken = match[1]
    const convId = Number(match[2])

    // ---- Phase 2 (this process): reopen on the same dataDir, listen first, verify the gate,
    // then confirm kernel.start() holds recovery until the node daemon reconnects. ----
    const fauxFast = fauxProvider()
    fauxFast.setResponses([fauxAssistantMessage('GRACE_RECOVERED_OK')])
    const kernel = await KernelRuntime.open({
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [fauxFast.provider],
      autoResume: false,
      nodeJoinGraceMs: 8_000,
    })
    const hub = await startHub({ kernel: kernel as never, port: 0 })
    let daemon: NodeDaemon | undefined
    try {
      assert.equal(kernel.started, false)
      const gated = await fetch(`${hub.url}/api/conversations`)
      assert.equal(gated.status, 503, 'API gated while pre-start even with recovery-dependent work pending')

      // Recovery holds: with the registered node offline and the interrupted conversation bound to
      // it, start() must not settle before the node reconnects (no plugins registered, so without
      // the grace this resolves near-instantly).
      const startedAt = Date.now()
      const startPromise = kernel.start()
      await delay(700)
      assert.equal(kernel.started, false, 'grace must hold recovery while the node is offline')

      daemon = await createNodeDaemon({
        hubUrl: hub.url,
        identity: { nodeId: 'grace-node', token: nodeToken! },
        dataDir: nodeDataDir,
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 400,
        log: () => undefined,
      })
      assert.ok(await daemon.waitUntilRegistered(), 'daemon should reconnect promptly')

      await startPromise
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed >= 650, `start() should have waited for the node (elapsed ${elapsed}ms)`)
      assert.equal(kernel.started, true)
      assert.equal(kernel.envFabric.isOnline('grace-node'), true)

      // The interrupted turn re-drove against the reconnected world and completed.
      for (let i = 0; i < 300; i++) {
        await delay(20)
        const status = kernel.getConversation(convId).status
        if (status !== 'working' && status !== 'blocked') break
      }
      const finalStatus = kernel.getConversation(convId).status
      assert.ok(finalStatus !== 'working' && finalStatus !== 'blocked', `re-driven turn should settle (status=${finalStatus})`)
      const lastText = await kernel.getLastAssistantText(convId)
      assert.ok(lastText.includes('GRACE_RECOVERED_OK'), `re-drive should complete with the fast response: ${lastText.slice(0, 120)}`)
    } finally {
      await daemon?.close()
      await hub.close()
      await kernel.close()
    }
  })
})

/** Spawn a tsx child running `scriptBody`; resolve stdout on SIGKILL (crash artifact), fail otherwise. */
function spawnSigkillSeeder(scriptBody: string, extraEnv: Record<string, string>): Promise<string> {
  const scriptPath = join(rootDir, `seeder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mts`)
  writeFileSync(scriptPath, scriptBody, 'utf-8')
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, scriptPath], {
    cwd: KERNEL_DIR,
    env: {
      ...process.env,
      HELMX_DATA_DIR: extraEnv.HELMX_DATA_DIR,
      HELMX_WORK_DIR: extraEnv.HELMX_WORK_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf-8')
    })
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' || code === 137) resolve(out)
      else reject(new Error(`seeder 未以 SIGKILL 结束（code=${code} signal=${signal}）:\n${out}\n${err}`))
    })
    child.on('error', reject)
    setTimeout(
      () => {
        child.kill('SIGKILL')
        reject(new Error('SIGKILL seeder 45s 超时'))
      },
      45_000,
    ).unref()
  })
}
