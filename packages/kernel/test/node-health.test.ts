/**
 * node health snapshot (NodeHealthSnapshot) kernel support test:
 * 1. sanitizeNodeHealth boundary validate: required field illegal whole discard, optional disk field
 *    illegal separate ignore, not validate dirty field (redundant key) never pass-through.
 * 2. NodeRegistry.register / noteHeartbeat / /ws/node real link:
 *    register carry legal/illegal health filter and save; heartbeat incidentally new snapshot real-time refresh;
 *    non- this connect fabricate heartbeat cannot tamper other node health.
 * 3. GET /api/nodes:local node and online BYOM node all contains complete health snapshot
 *    (uptimeSec/loadAvg/memFreeBytes/memTotalBytes/diskFreeBytes/diskTotalBytes),
 *    and host real os metric consistent; node offline after online:false leaves no residue expired health.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type { NodeHealthSnapshot, NodeHeartbeatInput, NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import { NodeRegistry, sanitizeNodeHealth, attachNodeWsGateway, type HubConnectionLocal } from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, sleep as delay } from './helpers.js'

// ---------------------------------------------------------------------------
// test base seat
// ---------------------------------------------------------------------------

/** extreme simple EventEmitter(avoid and ws WebSocket construct difference; same event listen/trigger semantics). */
class EventEmitterShim {
  readonly #listeners = new Map<string, Set<() => void>>()
  on(event: string, listener: () => void): void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
  }
  once(event: string, listener: () => void): void {
    const wrapped = (): void => {
      this.#listeners.get(event)?.delete(wrapped)
      listener()
    }
    this.on(event, wrapped)
  }
  emit(event: string): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener()
  }
}

/** can control when order register table layer socket replace body (same env-registry-races.test.ts pattern). */
class RegistrySocket extends EventEmitterShim {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

const validHealth = (): NodeHealthSnapshot => ({
  collectedAt: Date.now(),
  uptimeSec: 1234,
  loadAvg: [0.5, 0.25, 0.125],
  memFreeBytes: 1024,
  memTotalBytes: 4096,
  diskFreeBytes: 2048,
  diskTotalBytes: 8192,
})

async function registerFake(
  registry: NodeRegistry,
  nodeId: string,
  health?: unknown,
): Promise<{ socket: RegistrySocket; accepted: boolean }> {
  const socket = new RegistrySocket()
  const result = await registry.register(
    socket as unknown as import('ws').WebSocket,
    {
      nodeId,
      token: `${nodeId}:secret`,
      hostname: 'probe',
      platform: 'test',
      ...(health !== undefined ? { health: health as NodeHealthSnapshot } : {}),
    },
    () => ({ $close() {} }) as never,
  )
  return { socket, accepted: result.accepted }
}

/** real /ws/node gateway + original WS client (manually register/heartbeat, can control when order). */
async function startGatewayHub(): Promise<{
  url: string
  registry: NodeRegistry
  close(): Promise<void>
}> {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const gateway = attachNodeWsGateway(server, { registry })
  return {
    url: `ws://127.0.0.1:${port}`,
    registry,
    close: async () => {
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** original WS node client (birpc:register + heartbeat incidentally health). */
async function connectNode(
  url: string,
  nodeId: string,
): Promise<{
  ws: WebSocket
  register(health?: unknown): Promise<NodeRegisterResult>
  heartbeat(input?: NodeHeartbeatInput): Promise<boolean>
  close(): void
}> {
  const ws = new WebSocket(`${url}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    },
    HubConnectionLocal
  >(
    {
      onEnvExecOutput: () => undefined,
      onIpcEvent: () => undefined,
      onIpcClosed: () => undefined,
    },
    {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
      },
      on: (cb) => {
        ws.on('message', (raw) => {
          const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
          try {
            cb(JSON.parse(text) as never)
          } catch {
            /* non- JSON frame ignore */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  return {
    ws,
    register: (health?: unknown) =>
      rpc.register({
        nodeId,
        token: `${nodeId}:secret`,
        hostname: 'health-probe',
        platform: process.platform,
        ...(health !== undefined ? { health: health as NodeHealthSnapshot } : {}),
      }),
    heartbeat: (input?: NodeHeartbeatInput) => rpc.heartbeat(nodeId, input),
    close: () => {
      try {
        rpc.$close()
      } catch {
        /* already closure */
      }
      try {
        ws.close()
      } catch {
        /* already closure */
      }
    },
  }
}

/** complete Hub(KernelRuntime + startHub, contains /api/nodes and /ws/node gateway). */
async function openHubApp(dir: string): Promise<{
  kernel: KernelRuntime
  hub: Awaited<ReturnType<typeof startHub>>
  token: string
  close(): Promise<void>
}> {
  const { models } = makeFauxModels()
  const kernel = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
  })
  const hub = await startHub({
    kernel: kernel as never,
    port: 0,
  })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'node-health-test-pass' }),
  })
  const { token } = (await setup.json()) as { token: string }
  return {
    kernel,
    hub,
    token,
    close: async () => {
      await hub.close()
      await kernel.close()
    },
  }
}

async function listNodesViaApi(hubUrl: string, token: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${hubUrl}/api/nodes`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  return (await res.json()) as Array<Record<string, unknown>>
}

function assertCompleteHealth(health: unknown): void {
  assert.ok(health !== null && typeof health === 'object', `health must be an object:${JSON.stringify(health)}`)
  const h = health as Record<string, unknown>
  assert.ok(Number.isFinite(h['collectedAt']), 'collectedAt must be finite count')
  assert.ok(typeof h['uptimeSec'] === 'number' && Number.isFinite(h['uptimeSec']) && h['uptimeSec'] >= 0)
  assert.ok(
    Array.isArray(h['loadAvg']) &&
      h['loadAvg'].length === 3 &&
      h['loadAvg'].every((v) => typeof v === 'number' && Number.isFinite(v)),
    `loadAvg must be length 3 finite count meta group:${JSON.stringify(h['loadAvg'])}`,
  )
  assert.ok(typeof h['memFreeBytes'] === 'number' && Number.isFinite(h['memFreeBytes']) && h['memFreeBytes'] >= 0)
  assert.ok(typeof h['memTotalBytes'] === 'number' && Number.isFinite(h['memTotalBytes']) && h['memTotalBytes'] >= 0)
  assert.ok(typeof h['diskFreeBytes'] === 'number' && Number.isFinite(h['diskFreeBytes']) && h['diskFreeBytes'] >= 0)
  assert.ok(typeof h['diskTotalBytes'] === 'number' && Number.isFinite(h['diskTotalBytes']) && h['diskTotalBytes'] >= 0)
}

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, async () => {
  rootDir = await makeTempDir('helm-node-health-')
})

// ---------------------------------------------------------------------------
// 1. sanitizeNodeHealth boundary validate
// ---------------------------------------------------------------------------

test('sanitizeNodeHealth: legal payload all amount keep, unknown dirty field remove', { timeout: 60_000 }, () => {
  const raw = {
    ...validHealth(),
    extraField: 'dirty',
  }
  const clean = sanitizeNodeHealth(raw)
  assert.deepEqual(clean, {
    collectedAt: raw.collectedAt,
    uptimeSec: 1234,
    loadAvg: [0.5, 0.25, 0.125],
    memFreeBytes: 1024,
    memTotalBytes: 4096,
    diskFreeBytes: 2048,
    diskTotalBytes: 8192,
  })
  assert.equal(clean !== undefined && 'extraField' in clean, false, 'not validate dirty field never pass-through')
})

test('sanitizeNodeHealth: required field any one illegal whole discard (undefined, never throw exception)', { timeout: 60_000 }, () => {
  const bad: unknown[] = [
    undefined,
    null,
    'string',
    42,
    [],
    {},
    // collectedAt illegal
    { ...validHealth(), collectedAt: -1 },
    { ...validHealth(), collectedAt: Number.NaN },
    { ...validHealth(), collectedAt: Number.POSITIVE_INFINITY },
    { ...validHealth(), collectedAt: '123' },
    // uptimeSec illegal
    { ...validHealth(), uptimeSec: -5 },
    { ...validHealth(), uptimeSec: Number.NaN },
    // loadAvg illegal (length / type)
    { ...validHealth(), loadAvg: [0.1, 0.2] },
    { ...validHealth(), loadAvg: [0.1, 0.2, 0.3, 0.4] },
    { ...validHealth(), loadAvg: [0.1, 'x', 0.3] },
    { ...validHealth(), loadAvg: [0.1, Number.NaN, 0.3] },
    { ...validHealth(), loadAvg: 'not-array' },
    // memFreeBytes / memTotalBytes illegal
    { ...validHealth(), memFreeBytes: -1 },
    { ...validHealth(), memFreeBytes: Number.NaN },
    { ...validHealth(), memTotalBytes: -1 },
    { ...validHealth(), memTotalBytes: Number.POSITIVE_INFINITY },
  ]
  for (const payload of bad) {
    assert.equal(sanitizeNodeHealth(payload), undefined, `illegal payload must return undefined:${JSON.stringify(payload)}`)
  }
})

test('sanitizeNodeHealth: optional disk field illegal only ignore the field, the rest keep', { timeout: 60_000 }, () => {
  const noDisk = sanitizeNodeHealth({ ...validHealth(), diskFreeBytes: undefined })
  assert.ok(noDisk !== undefined)
  assert.equal('diskFreeBytes' in noDisk, false, 'diskFreeBytes default when must not appear the key')
  assert.equal(noDisk.diskTotalBytes, 8192)

  const badDisk = sanitizeNodeHealth({
    ...validHealth(),
    diskFreeBytes: -100,
    diskTotalBytes: 'lots',
  })
  assert.ok(badDisk !== undefined)
  assert.equal('diskFreeBytes' in badDisk, false, 'illegal diskFreeBytes ignore')
  assert.equal('diskTotalBytes' in badDisk, false, 'illegal diskTotalBytes ignore')
  assert.equal(badDisk.memTotalBytes, 4096, 'the rest field do not subject to affect')
})

// ---------------------------------------------------------------------------
// 2. register table:register filter save + noteHeartbeat refresh + fabricate heartbeat guard against tamper
// ---------------------------------------------------------------------------

test('register: legal health save, illegal health filter, default produces no health key', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const good = validHealth()
    const g = await registerFake(registry, 'node-good', good)
    assert.equal(g.accepted, true)
    assert.deepEqual(registry.get('node-good')?.health, good)

    const bad = await registerFake(registry, 'node-bad', {
      ...validHealth(),
      loadAvg: [1, 2],
      memTotalBytes: -1,
    })
    assert.equal(bad.accepted, true, 'illegal health does not affect register itself (boundary filter, do not reject connect)')
    assert.equal(registry.get('node-bad')?.health, undefined, 'illegal health must not save')

    const none = await registerFake(registry, 'node-none')
    assert.equal(none.accepted, true)
    assert.equal('health' in (registry.get('node-none') ?? {}), false, 'not on report health when produces no empty key')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat: new snapshot real-time refresh; without payload only refresh lastSeenAt; illegal payload does not override', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const first = validHealth()
    const { socket } = await registerFake(registry, 'hb-node', first)
    const connBefore = registry.get('hb-node')!
    await delay(5)
    assert.ok(registry.get('hb-node')!.lastSeenAt >= connBefore.lastSeenAt)

    const second = { ...validHealth(), uptimeSec: 999_999, collectedAt: Date.now() }
    assert.equal(registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket, { health: second }), true)
    const refreshed = registry.get('hb-node')!.health!
    assert.equal(refreshed.uptimeSec, 999_999, 'heartbeat snapshot must override old value')
    assert.ok(refreshed.collectedAt >= first.collectedAt)

    // without payload heartbeat: only refresh lastSeenAt,health keep do not change.
    const keep = registry.get('hb-node')!.health
    assert.equal(registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket), true)
    assert.deepEqual(registry.get('hb-node')!.health, keep)

    // illegal payload: does not override since has legal snapshot.
    assert.equal(
      registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), memFreeBytes: Number.NaN } as never,
      }),
      true,
    )
    assert.deepEqual(registry.get('hb-node')!.health, keep, 'illegal snapshot must not override legal value')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat: non- this connect fabricate heartbeat cannot tamper other node health(return false)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const victim = validHealth()
    const a = await registerFake(registry, 'victim-node', victim)
    const b = await registerFake(registry, 'attacker-node')
    const stranger = new RegistrySocket()

    // B connect fabricate A node heartbeat: must by refuse.
    assert.equal(
      registry.noteHeartbeat('victim-node', b.socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), uptimeSec: 666 },
      }),
      false,
    )
    assert.deepEqual(registry.get('victim-node')?.health, victim, 'fabricate heartbeat must not tamper victim health')

    // not registered connect fabricate: same by refuse.
    assert.equal(
      registry.noteHeartbeat('victim-node', stranger as unknown as import('ws').WebSocket, { health: validHealth() }),
      false,
    )
    // missing node: refuse.
    assert.equal(
      registry.noteHeartbeat('ghost', a.socket as unknown as import('ws').WebSocket, { health: validHealth() }),
      false,
    )
    assert.deepEqual(registry.get('victim-node')?.health, victim)
  } finally {
    await registry.close()
  }
})

// ---------------------------------------------------------------------------
// 3. real /ws/node gateway link: register and heartbeat incidentally health
// ---------------------------------------------------------------------------

test('/ws/node:register and heartbeat carry health snapshot real-time write connect', { timeout: 60_000 }, async () => {
  const hub = await startGatewayHub()
  try {
    const node = await connectNode(hub.url, 'ws-health-node')
    const registered = await node.register({ ...validHealth(), uptimeSec: 100 }).catch((error: unknown) => {
      throw new Error(`register failed to invoke:${String(error instanceof Error ? error.stack : error)}`)
    })
    assert.equal(registered.ok, true, `register by refuse:${JSON.stringify(registered)}`)
    assert.deepEqual(hub.registry.get('ws-health-node')?.health?.uptimeSec, 100)
    assertCompleteHealth(hub.registry.get('ws-health-node')?.health)

    // heartbeat incidentally new snapshot: real-time override.
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 200 } }), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // without second parameter old style heartbeat still compatibility (only refresh lastSeenAt).
    assert.equal(await node.heartbeat(), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // heartbeat carry illegal snapshot: does not override since has value.
    assert.equal(
      await node.heartbeat({ health: { ...validHealth(), loadAvg: [9] } as never }),
      true,
    )
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200, 'illegal snapshot does not override')
    node.close()
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 4. GET /api/nodes:local and online BYOM node complete health; offline leaves no residue
// ---------------------------------------------------------------------------

test('GET /api/nodes:local and online BYOM all contains complete real health; offline leaves no residue expired health', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'api-'))
  const app = await openHubApp(dir)
  try {
    // local: and host real os metric consistent.
    const initial = await listNodesViaApi(app.hub.url, app.token)
    assert.equal(initial.length, 1)
    assert.equal(initial[0]!['id'], 'local')
    const localHealth = initial[0]!['health'] as Record<string, unknown>
    assertCompleteHealth(localHealth)
    assert.ok(
      Math.abs((localHealth['uptimeSec'] as number) - os.uptime()) < 60,
      `local uptimeSec should connect near host os.uptime():${String(localHealth['uptimeSec'])}`,
    )
    assert.ok(
      Math.abs((localHealth['memTotalBytes'] as number) - os.totalmem()) < 1024 * 1024,
      'local memTotalBytes should equal host os.totalmem()',
    )
    assert.deepEqual(localHealth['loadAvg'], os.loadavg(), 'local loadAvg should equal host os.loadavg()')

    // sign + register real WS node (register incidentally complete health).
    const issue = await fetch(`${app.hub.url}/api/nodes/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
      body: JSON.stringify({ nodeId: 'health-byom' }),
    })
    assert.equal(issue.status, 201)
    const { token: nodeToken } = (await issue.json()) as { token: string }
    const wsUrl = app.hub.url.replace(/^http/, 'ws')
    const node = await connectNodeWithToken(wsUrl, 'health-byom', nodeToken)
    assert.equal((await node.register(validHealth())).ok, true)

    const withByom = await listNodesViaApi(app.hub.url, app.token)
    assert.equal(withByom.length, 2)
    const byom = withByom.find((n) => n['id'] === 'health-byom')!
    assert.equal(byom['online'], true)
    assertCompleteHealth(byom['health'])
    assert.equal((byom['health'] as { uptimeSec: number }).uptimeSec, 1234, 'register snapshot original pass-through')

    // heartbeat incidentally new snapshot -> API real-time visible.
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 4321 } }), true)
    const refreshed = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal((refreshed['health'] as { uptimeSec: number }).uptimeSec, 4321, 'heartbeat snapshot via API real-time visible')

    // disconnect -> offline leaves no residue expired health.
    node.close()
    await delay(300)
    const offline = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal(offline['online'], false)
    assert.equal(offline['health'], undefined, 'offline after must not leftover expired health')
  } finally {
    await app.close().catch(() => undefined)
    await cleanupDir(dir).catch(() => undefined)
  }
})

/** use real sign token connect (connectNode  token fixed is <nodeId>:secret, only gateway replace body use). */
async function connectNodeWithToken(
  url: string,
  nodeId: string,
  token: string,
): Promise<{
  ws: WebSocket
  register(health?: unknown): Promise<NodeRegisterResult>
  heartbeat(input?: NodeHeartbeatInput): Promise<boolean>
  close(): void
}> {
  const ws = new WebSocket(`${url}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    },
    HubConnectionLocal
  >(
    {
      onEnvExecOutput: () => undefined,
      onIpcEvent: () => undefined,
      onIpcClosed: () => undefined,
    },
    {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
      },
      on: (cb) => {
        ws.on('message', (raw) => {
          const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
          try {
            cb(JSON.parse(text) as never)
          } catch {
            /* non- JSON frame ignore */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  return {
    ws,
    register: (health?: unknown) =>
      rpc.register({
        nodeId,
        token,
        hostname: 'health-probe',
        platform: process.platform,
        ...(health !== undefined ? { health: health as NodeHealthSnapshot } : {}),
      }),
    heartbeat: (input?: NodeHeartbeatInput) => rpc.heartbeat(nodeId, input),
    close: () => {
      try {
        rpc.$close()
      } catch {
        /* already closure */
      }
      try {
        ws.close()
      } catch {
        /* already closure */
      }
    },
  }
}

test('teardown: clean up temporary directory', { timeout: 60_000 }, async () => {
  await cleanupDir(rootDir)
})
