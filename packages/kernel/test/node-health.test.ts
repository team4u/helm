/**
 * Kernel support tests for node health snapshots (NodeHealthSnapshot):
 * 1. sanitizeNodeHealth boundary validation: invalid required fields drop the entire payload,
 *    invalid optional disk fields are omitted individually, unvalidated extra fields never pass through.
 * 2. NodeRegistry.register / noteHeartbeat / /ws/node real transport:
 *    registration filters and saves health; heartbeats refresh the snapshot in real time;
 *    forged heartbeats from other connections cannot tamper with another node's health.
 * 3. GET /api/nodes: both the local node and online BYOM nodes include complete health snapshots
 *    (uptimeSec/loadAvg/memFreeBytes/memTotalBytes/diskFreeBytes/diskTotalBytes) consistent with host OS
 *    metrics; once a node goes offline (online: false), stale health is cleared.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type { NodeHealthSnapshot, NodeHeartbeatInput, NodeRegisterInput, NodeRegisterResult } from '@helmx/protocol'
import { NodeRegistry, sanitizeNodeHealth, attachNodeWsGateway, type HubConnectionLocal } from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, sleep as delay } from './helpers.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Minimal EventEmitter (avoids constructor differences from ws WebSocket; identical on/once/emit semantics). */
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

/** Controllable socket stub at the registry layer (same pattern as env-registry-races.test.ts). */
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

/** Real /ws/node gateway + raw WS client (manual register/heartbeat with controllable timing). */
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

/** Raw WS node client (birpc: register + heartbeat with optional health payload). */
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
            /* ignore non-JSON frames */
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
        /* already closed */
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** Full Hub (KernelRuntime + startHub, including /api/nodes and /ws/node gateway). */
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
  assert.ok(health !== null && typeof health === 'object', `health must be an object: ${JSON.stringify(health)}`)
  const h = health as Record<string, unknown>
  assert.ok(Number.isFinite(h['collectedAt']), 'collectedAt must be a finite number')
  assert.ok(typeof h['uptimeSec'] === 'number' && Number.isFinite(h['uptimeSec']) && h['uptimeSec'] >= 0)
  assert.ok(
    Array.isArray(h['loadAvg']) &&
      h['loadAvg'].length === 3 &&
      h['loadAvg'].every((v) => typeof v === 'number' && Number.isFinite(v)),
    `loadAvg must be a 3-element tuple of finite numbers: ${JSON.stringify(h['loadAvg'])}`,
  )
  assert.ok(typeof h['memFreeBytes'] === 'number' && Number.isFinite(h['memFreeBytes']) && h['memFreeBytes'] >= 0)
  assert.ok(typeof h['memTotalBytes'] === 'number' && Number.isFinite(h['memTotalBytes']) && h['memTotalBytes'] >= 0)
  assert.ok(typeof h['diskFreeBytes'] === 'number' && Number.isFinite(h['diskFreeBytes']) && h['diskFreeBytes'] >= 0)
  assert.ok(typeof h['diskTotalBytes'] === 'number' && Number.isFinite(h['diskTotalBytes']) && h['diskTotalBytes'] >= 0)
}

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, async () => {
  rootDir = await makeTempDir('helmx-node-health-')
})

// ---------------------------------------------------------------------------
// 1. sanitizeNodeHealth boundary validation
// ---------------------------------------------------------------------------

test('sanitizeNodeHealth: preserves all valid fields and strips unknown extra fields', { timeout: 60_000 }, () => {
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
  assert.equal(clean !== undefined && 'extraField' in clean, false, 'unvalidated extra fields must never pass through')
})

test('sanitizeNodeHealth: invalid required field discards entire payload (returns undefined, never throws)', { timeout: 60_000 }, () => {
  const bad: unknown[] = [
    undefined,
    null,
    'string',
    42,
    [],
    {},
    // invalid collectedAt
    { ...validHealth(), collectedAt: -1 },
    { ...validHealth(), collectedAt: Number.NaN },
    { ...validHealth(), collectedAt: Number.POSITIVE_INFINITY },
    { ...validHealth(), collectedAt: '123' },
    // invalid uptimeSec
    { ...validHealth(), uptimeSec: -5 },
    { ...validHealth(), uptimeSec: Number.NaN },
    // invalid loadAvg (length / element type)
    { ...validHealth(), loadAvg: [0.1, 0.2] },
    { ...validHealth(), loadAvg: [0.1, 0.2, 0.3, 0.4] },
    { ...validHealth(), loadAvg: [0.1, 'x', 0.3] },
    { ...validHealth(), loadAvg: [0.1, Number.NaN, 0.3] },
    { ...validHealth(), loadAvg: 'not-array' },
    // invalid memFreeBytes / memTotalBytes
    { ...validHealth(), memFreeBytes: -1 },
    { ...validHealth(), memFreeBytes: Number.NaN },
    { ...validHealth(), memTotalBytes: -1 },
    { ...validHealth(), memTotalBytes: Number.POSITIVE_INFINITY },
  ]
  for (const payload of bad) {
    assert.equal(sanitizeNodeHealth(payload), undefined, `invalid payload must return undefined: ${JSON.stringify(payload)}`)
  }
})

test('sanitizeNodeHealth: invalid optional disk fields are omitted individually without dropping valid fields', { timeout: 60_000 }, () => {
  const noDisk = sanitizeNodeHealth({ ...validHealth(), diskFreeBytes: undefined })
  assert.ok(noDisk !== undefined)
  assert.equal('diskFreeBytes' in noDisk, false, 'missing diskFreeBytes must not leave an empty property key')
  assert.equal(noDisk.diskTotalBytes, 8192)

  const badDisk = sanitizeNodeHealth({
    ...validHealth(),
    diskFreeBytes: -100,
    diskTotalBytes: 'lots',
  })
  assert.ok(badDisk !== undefined)
  assert.equal('diskFreeBytes' in badDisk, false, 'invalid diskFreeBytes should be omitted')
  assert.equal('diskTotalBytes' in badDisk, false, 'invalid diskTotalBytes should be omitted')
  assert.equal(badDisk.memTotalBytes, 4096, 'remaining valid fields stay intact')
})

// ---------------------------------------------------------------------------
// 2. Registry: filter health on register + refresh via noteHeartbeat + tamper guard
// ---------------------------------------------------------------------------

test('register: stores valid health, filters invalid health, omits health key when missing', { timeout: 60_000 }, async () => {
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
    assert.equal(bad.accepted, true, 'invalid health must not fail registration itself (filtered at boundary, connection stays open)')
    assert.equal(registry.get('node-bad')?.health, undefined, 'invalid health must not be stored')

    const none = await registerFake(registry, 'node-none')
    assert.equal(none.accepted, true)
    assert.equal('health' in (registry.get('node-none') ?? {}), false, 'omitted health must not leave an empty key')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat: updates snapshot in real time; payloadless heartbeat updates lastSeenAt only; invalid payload does not overwrite', { timeout: 60_000 }, async () => {
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
    assert.equal(refreshed.uptimeSec, 999_999, 'heartbeat snapshot must replace stale value')
    assert.ok(refreshed.collectedAt >= first.collectedAt)

    // Payloadless heartbeat: updates lastSeenAt only, leaving health intact.
    const keep = registry.get('hb-node')!.health
    assert.equal(registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket), true)
    assert.deepEqual(registry.get('hb-node')!.health, keep)

    // Invalid payload: must not overwrite existing valid snapshot.
    assert.equal(
      registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), memFreeBytes: Number.NaN } as never,
      }),
      true,
    )
    assert.deepEqual(registry.get('hb-node')!.health, keep, 'invalid snapshot must not overwrite valid value')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat: forged heartbeat from non-owning socket cannot tamper with another node (returns false)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const victim = validHealth()
    const a = await registerFake(registry, 'victim-node', victim)
    const b = await registerFake(registry, 'attacker-node')
    const stranger = new RegistrySocket()

    // Socket B forging heartbeat for node A: must be rejected.
    assert.equal(
      registry.noteHeartbeat('victim-node', b.socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), uptimeSec: 666 },
      }),
      false,
    )
    assert.deepEqual(registry.get('victim-node')?.health, victim, 'forged heartbeat must not tamper with victim health')

    // Unregistered socket forging heartbeat: also rejected.
    assert.equal(
      registry.noteHeartbeat('victim-node', stranger as unknown as import('ws').WebSocket, { health: validHealth() }),
      false,
    )
    // Missing nodeId: rejected.
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
// 3. Real /ws/node gateway pipeline: register and heartbeat carrying health
// ---------------------------------------------------------------------------

test('/ws/node: register and heartbeat health snapshots persist on active connection', { timeout: 60_000 }, async () => {
  const hub = await startGatewayHub()
  try {
    const node = await connectNode(hub.url, 'ws-health-node')
    const registered = await node.register({ ...validHealth(), uptimeSec: 100 }).catch((error: unknown) => {
      throw new Error(`register invocation failed: ${String(error instanceof Error ? error.stack : error)}`)
    })
    assert.equal(registered.ok, true, `registration rejected: ${JSON.stringify(registered)}`)
    assert.deepEqual(hub.registry.get('ws-health-node')?.health?.uptimeSec, 100)
    assertCompleteHealth(hub.registry.get('ws-health-node')?.health)

    // Heartbeat with new snapshot: updates in real time.
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 200 } }), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // Legacy 1-arg heartbeat still compatible (updates lastSeenAt only).
    assert.equal(await node.heartbeat(), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // Heartbeat with invalid snapshot: preserves existing valid value.
    assert.equal(
      await node.heartbeat({ health: { ...validHealth(), loadAvg: [9] } as never }),
      true,
    )
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200, 'invalid snapshot must not overwrite')
    node.close()
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 4. GET /api/nodes: complete health for local and online BYOM; offline leaves no stale health
// ---------------------------------------------------------------------------

test('GET /api/nodes: local and online BYOM carry real complete health; offline retains no stale health', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'api-'))
  const app = await openHubApp(dir)
  try {
    // local: matches real host OS metrics.
    const initial = await listNodesViaApi(app.hub.url, app.token)
    assert.equal(initial.length, 1)
    assert.equal(initial[0]!['id'], 'local')
    const localHealth = initial[0]!['health'] as Record<string, unknown>
    assertCompleteHealth(localHealth)
    assert.ok(
      Math.abs((localHealth['uptimeSec'] as number) - os.uptime()) < 60,
      `local uptimeSec should stay close to host os.uptime(): ${String(localHealth['uptimeSec'])}`,
    )
    assert.ok(
      Math.abs((localHealth['memTotalBytes'] as number) - os.totalmem()) < 1024 * 1024,
      'local memTotalBytes should equal host os.totalmem()',
    )
    assert.deepEqual(localHealth['loadAvg'], os.loadavg(), 'local loadAvg should equal host os.loadavg()')

    // Issue token + register real WS node (with complete health on register).
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
    assert.equal((byom['health'] as { uptimeSec: number }).uptimeSec, 1234, 'register snapshot passes through verbatim')

    // Heartbeat with updated snapshot -> immediately visible via API.
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 4321 } }), true)
    const refreshed = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal((refreshed['health'] as { uptimeSec: number }).uptimeSec, 4321, 'heartbeat snapshot is immediately visible via API')

    // Disconnect -> offline node retains no stale health.
    node.close()
    await delay(300)
    const offline = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal(offline['online'], false)
    assert.equal(offline['health'], undefined, 'offline node must not retain stale health')
  } finally {
    await app.close().catch(() => undefined)
    await cleanupDir(dir).catch(() => undefined)
  }
})

/** Connects using an issued token (connectNode fixes token to <nodeId>:secret for stub-gateway use only). */
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
            /* ignore non-JSON frames */
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
        /* already closed */
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}

test('teardown: clean up temporary directory', { timeout: 60_000 }, async () => {
  await cleanupDir(rootDir)
})
