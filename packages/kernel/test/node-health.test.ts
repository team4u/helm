/**
 * 节点健康快照（NodeHealthSnapshot）内核支持测试：
 * 1. sanitizeNodeHealth 边界校验：必填字段非法整体丢弃、可选磁盘字段
 *    非法单独忽略、未校验的脏字段（多余键）绝不透传。
 * 2. NodeRegistry.register / noteHeartbeat / /ws/node 真实链路：
 *    注册携带合法/非法 health 的过滤与保存；心跳捎带新快照实时刷新；
 *    非本连接伪造心跳无法篡改其它节点的 health。
 * 3. GET /api/nodes：local 节点与在线 BYOM 节点均包含完整健康快照
 *    （uptimeSec/loadAvg/memFreeBytes/memTotalBytes/diskFreeBytes/diskTotalBytes），
 *    与宿主真实 os 指标一致；节点离线后 online:false 不残留过期 health。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import { setTimeout as delay } from 'node:timers/promises'
import type { NodeHealthSnapshot, NodeHeartbeatInput, NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import { NodeRegistry, sanitizeNodeHealth, attachNodeWsGateway, type HubConnectionLocal } from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

// ---------------------------------------------------------------------------
// 测试基座
// ---------------------------------------------------------------------------

/** 极简 EventEmitter（避免与 ws WebSocket 的构造差异；同事件监听/触发语义）。 */
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

/** 可控时序的注册表层 socket 替身（同 env-registry-races.test.ts 模式）。 */
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

/** 真实 /ws/node 网关 + 原始 WS 客户端（手动 register/heartbeat，可控时序）。 */
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

/** 原始 WS 节点客户端（birpc：register + heartbeat 捎带 health）。 */
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
            /* 非 JSON 帧忽略 */
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
        /* 已关 */
      }
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    },
  }
}

/** 完整 Hub（KernelRuntime + startHub，含 /api/nodes 与 /ws/node 网关）。 */
async function openHubApp(dir: string): Promise<{
  kernel: KernelRuntime
  hub: Awaited<ReturnType<typeof startHub>>
  token: string
  close(): Promise<void>
}> {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
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
  assert.ok(health !== null && typeof health === 'object', `health 需为对象：${JSON.stringify(health)}`)
  const h = health as Record<string, unknown>
  assert.ok(Number.isFinite(h['collectedAt']), 'collectedAt 需为有限数')
  assert.ok(typeof h['uptimeSec'] === 'number' && Number.isFinite(h['uptimeSec']) && h['uptimeSec'] >= 0)
  assert.ok(
    Array.isArray(h['loadAvg']) &&
      h['loadAvg'].length === 3 &&
      h['loadAvg'].every((v) => typeof v === 'number' && Number.isFinite(v)),
    `loadAvg 需为长度 3 的有限数元组：${JSON.stringify(h['loadAvg'])}`,
  )
  assert.ok(typeof h['memFreeBytes'] === 'number' && Number.isFinite(h['memFreeBytes']) && h['memFreeBytes'] >= 0)
  assert.ok(typeof h['memTotalBytes'] === 'number' && Number.isFinite(h['memTotalBytes']) && h['memTotalBytes'] >= 0)
  assert.ok(typeof h['diskFreeBytes'] === 'number' && Number.isFinite(h['diskFreeBytes']) && h['diskFreeBytes'] >= 0)
  assert.ok(typeof h['diskTotalBytes'] === 'number' && Number.isFinite(h['diskTotalBytes']) && h['diskTotalBytes'] >= 0)
}

let rootDir: string

test('setup: 创建临时根目录', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-node-health-'))
})

// ---------------------------------------------------------------------------
// 1. sanitizeNodeHealth 边界校验
// ---------------------------------------------------------------------------

test('sanitizeNodeHealth：合法载荷全量保留，未知脏字段剔除', { timeout: 60_000 }, () => {
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
  assert.equal(clean !== undefined && 'extraField' in clean, false, '未校验的脏字段绝不透传')
})

test('sanitizeNodeHealth：必填字段任一非法整体丢弃（undefined，绝不抛异常）', { timeout: 60_000 }, () => {
  const bad: unknown[] = [
    undefined,
    null,
    'string',
    42,
    [],
    {},
    // collectedAt 非法
    { ...validHealth(), collectedAt: -1 },
    { ...validHealth(), collectedAt: Number.NaN },
    { ...validHealth(), collectedAt: Number.POSITIVE_INFINITY },
    { ...validHealth(), collectedAt: '123' },
    // uptimeSec 非法
    { ...validHealth(), uptimeSec: -5 },
    { ...validHealth(), uptimeSec: Number.NaN },
    // loadAvg 非法（长度 / 类型）
    { ...validHealth(), loadAvg: [0.1, 0.2] },
    { ...validHealth(), loadAvg: [0.1, 0.2, 0.3, 0.4] },
    { ...validHealth(), loadAvg: [0.1, 'x', 0.3] },
    { ...validHealth(), loadAvg: [0.1, Number.NaN, 0.3] },
    { ...validHealth(), loadAvg: 'not-array' },
    // memFreeBytes / memTotalBytes 非法
    { ...validHealth(), memFreeBytes: -1 },
    { ...validHealth(), memFreeBytes: Number.NaN },
    { ...validHealth(), memTotalBytes: -1 },
    { ...validHealth(), memTotalBytes: Number.POSITIVE_INFINITY },
  ]
  for (const payload of bad) {
    assert.equal(sanitizeNodeHealth(payload), undefined, `非法载荷必须返回 undefined：${JSON.stringify(payload)}`)
  }
})

test('sanitizeNodeHealth：可选磁盘字段非法仅忽略该字段，其余保留', { timeout: 60_000 }, () => {
  const noDisk = sanitizeNodeHealth({ ...validHealth(), diskFreeBytes: undefined })
  assert.ok(noDisk !== undefined)
  assert.equal('diskFreeBytes' in noDisk, false, 'diskFreeBytes 缺省时不得出现该键')
  assert.equal(noDisk.diskTotalBytes, 8192)

  const badDisk = sanitizeNodeHealth({
    ...validHealth(),
    diskFreeBytes: -100,
    diskTotalBytes: 'lots',
  })
  assert.ok(badDisk !== undefined)
  assert.equal('diskFreeBytes' in badDisk, false, '非法 diskFreeBytes 忽略')
  assert.equal('diskTotalBytes' in badDisk, false, '非法 diskTotalBytes 忽略')
  assert.equal(badDisk.memTotalBytes, 4096, '其余字段不受影响')
})

// ---------------------------------------------------------------------------
// 2. 注册表：register 过滤保存 + noteHeartbeat 刷新 + 伪造心跳防篡改
// ---------------------------------------------------------------------------

test('register：合法 health 保存、非法 health 过滤、缺省不产生 health 键', { timeout: 60_000 }, async () => {
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
    assert.equal(bad.accepted, true, '非法 health 不影响注册本身（边界过滤，不拒绝连接）')
    assert.equal(registry.get('node-bad')?.health, undefined, '非法 health 不得保存')

    const none = await registerFake(registry, 'node-none')
    assert.equal(none.accepted, true)
    assert.equal('health' in (registry.get('node-none') ?? {}), false, '未上报 health 时不产生空键')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat：新快照实时刷新；无载荷仅刷新 lastSeenAt；非法载荷不覆盖', { timeout: 60_000 }, async () => {
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
    assert.equal(refreshed.uptimeSec, 999_999, '心跳快照必须覆盖旧值')
    assert.ok(refreshed.collectedAt >= first.collectedAt)

    // 无载荷心跳：只刷新 lastSeenAt，health 保持不变。
    const keep = registry.get('hb-node')!.health
    assert.equal(registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket), true)
    assert.deepEqual(registry.get('hb-node')!.health, keep)

    // 非法载荷：不覆盖既有合法快照。
    assert.equal(
      registry.noteHeartbeat('hb-node', socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), memFreeBytes: Number.NaN } as never,
      }),
      true,
    )
    assert.deepEqual(registry.get('hb-node')!.health, keep, '非法快照不得覆盖合法值')
  } finally {
    await registry.close()
  }
})

test('noteHeartbeat：非本连接伪造心跳无法篡改其它节点的 health（返回 false）', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const victim = validHealth()
    const a = await registerFake(registry, 'victim-node', victim)
    const b = await registerFake(registry, 'attacker-node')
    const stranger = new RegistrySocket()

    // B 连接伪造 A 节点心跳：必须被拒。
    assert.equal(
      registry.noteHeartbeat('victim-node', b.socket as unknown as import('ws').WebSocket, {
        health: { ...validHealth(), uptimeSec: 666 },
      }),
      false,
    )
    assert.deepEqual(registry.get('victim-node')?.health, victim, '伪造心跳不得篡改 victim health')

    // 未注册连接伪造：同样被拒。
    assert.equal(
      registry.noteHeartbeat('victim-node', stranger as unknown as import('ws').WebSocket, { health: validHealth() }),
      false,
    )
    // 不存在节点：拒。
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
// 3. 真实 /ws/node 网关链路：注册与心跳捎带 health
// ---------------------------------------------------------------------------

test('/ws/node：register 与 heartbeat 携带 health 快照实时写入连接', { timeout: 60_000 }, async () => {
  const hub = await startGatewayHub()
  try {
    const node = await connectNode(hub.url, 'ws-health-node')
    const registered = await node.register({ ...validHealth(), uptimeSec: 100 }).catch((error: unknown) => {
      throw new Error(`register 调用失败：${String(error instanceof Error ? error.stack : error)}`)
    })
    assert.equal(registered.ok, true, `注册被拒：${JSON.stringify(registered)}`)
    assert.deepEqual(hub.registry.get('ws-health-node')?.health?.uptimeSec, 100)
    assertCompleteHealth(hub.registry.get('ws-health-node')?.health)

    // 心跳捎带新快照：实时覆盖。
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 200 } }), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // 无第二参数的旧式心跳仍兼容（仅刷新 lastSeenAt）。
    assert.equal(await node.heartbeat(), true)
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200)

    // 心跳携带非法快照：不覆盖既有值。
    assert.equal(
      await node.heartbeat({ health: { ...validHealth(), loadAvg: [9] } as never }),
      true,
    )
    assert.equal(hub.registry.get('ws-health-node')?.health?.uptimeSec, 200, '非法快照不覆盖')
    node.close()
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 4. GET /api/nodes：local 与在线 BYOM 节点完整 health；离线不残留
// ---------------------------------------------------------------------------

test('GET /api/nodes：local 与在线 BYOM 均含完整真实 health；离线不残留过期 health', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'api-'))
  const app = await openHubApp(dir)
  try {
    // local：与宿主真实 os 指标一致。
    const initial = await listNodesViaApi(app.hub.url, app.token)
    assert.equal(initial.length, 1)
    assert.equal(initial[0]!['id'], 'local')
    const localHealth = initial[0]!['health'] as Record<string, unknown>
    assertCompleteHealth(localHealth)
    assert.ok(
      Math.abs((localHealth['uptimeSec'] as number) - os.uptime()) < 60,
      `local uptimeSec 应接近宿主 os.uptime()：${String(localHealth['uptimeSec'])}`,
    )
    assert.ok(
      Math.abs((localHealth['memTotalBytes'] as number) - os.totalmem()) < 1024 * 1024,
      'local memTotalBytes 应等于宿主 os.totalmem()',
    )
    assert.deepEqual(localHealth['loadAvg'], os.loadavg(), 'local loadAvg 应等于宿主 os.loadavg()')

    // 签发 + 注册真实 WS 节点（register 捎带完整 health）。
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
    assert.equal((byom['health'] as { uptimeSec: number }).uptimeSec, 1234, '注册快照原样透传')

    // 心跳捎带新快照 -> API 实时可见。
    assert.equal(await node.heartbeat({ health: { ...validHealth(), uptimeSec: 4321 } }), true)
    const refreshed = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal((refreshed['health'] as { uptimeSec: number }).uptimeSec, 4321, '心跳快照经 API 实时可见')

    // 断开 -> 离线不残留过期 health。
    node.close()
    await delay(300)
    const offline = (await listNodesViaApi(app.hub.url, app.token)).find((n) => n['id'] === 'health-byom')!
    assert.equal(offline['online'], false)
    assert.equal(offline['health'], undefined, '离线后不得残留过期 health')
  } finally {
    await app.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

/** 用真实签发 token 连接（connectNode 的 token 固定为 <nodeId>:secret，仅网关替身用）。 */
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
            /* 非 JSON 帧忽略 */
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
        /* 已关 */
      }
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    },
  }
}

test('teardown: 清理临时根目录', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
