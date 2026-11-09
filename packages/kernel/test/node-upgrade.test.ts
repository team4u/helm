/**
 * 节点升级（Hub 侧 orchestrator + registry 等待器）端到端测试：
 * 真实 NodeRegistry + /ws/node 网关 + 可编程节点 fixture（可控 nodeUpgrade /
 * nodeCheckUpgrade 行为与 register/heartbeat 时序），外加完整 Hub HTTP 层
 * （KernelRuntime + startHub）覆盖 GET /api/nodes/:id/upgrade/check 与
 * POST /api/nodes/:id/upgrade。
 *
 * 正确性核心（每项真实行为验证，不做源码 regex 冒充）：
 * 1. 旧 nodeUpgrade RPC 因候选注册顶替旧 socket 而传输中断时，升级结果
 *    只能由候选连接的匹配 commit 心跳确认——绝不因「新连接存在」或
 *    catch 假成功；
 * 2. 仅 register（无 commit）不成功；错误 attemptId / 错误版本 / 伪造
 *    连接的 commit 拒绝；匹配 commit（attemptId + version +
 *    previousVersion + pid 正整数）成功；
 * 3. 无等待器的合法 commit（本机 CLI 升级路径）仍 ACK true；
 * 4. local 400 / 未知 404 / 离线 409 / 不支持 501 / 结构化失败 400/502 /
 *    超时未确认 502；
 * 5. HTTP body 边界校验：未知字段 / 非 http(s) registryUrl / 非布尔 force /
 *    attemptId 不可由用户提供；
 * 6. 自动升级默认关闭；HELM_AUTO_UPGRADE_NODES=1 且严格 SemVer 落后时触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp as mkdtempAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type {
  NodeEnvRpcFunctions,
  NodeHeartbeatInput,
  NodeRegisterInput,
  NodeRegisterResult,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
  RpcResult,
} from '@helm/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { NodeRegistry, HelmUpgradeBusyError, HelmUpgradeTimeoutError } from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { hubVersion, normalizeExplicitVersion, compareStrictSemVer } from '../src/runtime/semver.js'
import { startHub } from '../src/http/index.js'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

/** 异步 mkdtemp 别名（用例内 dir 创建）。 */
const mkdtemp = (prefix: string): Promise<string> => mkdtempAsync(prefix)

void mkdtemp

let rootDir: string

test('setup: 创建临时根目录', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-node-upgrade-'))
})

// ---------------------------------------------------------------------------
// 版本语义单元
// ---------------------------------------------------------------------------

test('normalizeExplicitVersion：trim + 单 v 前缀；非法显式拒绝', { timeout: 60_000 }, () => {
  assert.equal(normalizeExplicitVersion('1.2.3'), '1.2.3')
  assert.equal(normalizeExplicitVersion(' v1.2.3 '), '1.2.3')
  assert.equal(normalizeExplicitVersion('V2.0.0-rc.1+build.5'), '2.0.0-rc.1+build.5')
  assert.throws(() => normalizeExplicitVersion('1.2'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('vv1.2.3'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('latest'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('1.2.3.4'), /SemVer/)
})

test('compareStrictSemVer：主/次/修订/预发布排序', { timeout: 60_000 }, () => {
  assert.equal(compareStrictSemVer('1.2.3', '1.2.3'), 0)
  assert.equal(compareStrictSemVer('0.9.9', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.10.0', '1.9.0'), 1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha.1', '1.0.0-alpha.2'), -1)
  assert.equal(compareStrictSemVer('1.0.0-2', '1.0.0-10'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0-beta'), -1)
})

test('hubVersion：读 kernel package.json（严格 SemVer）', { timeout: 60_000 }, () => {
  const v = hubVersion()
  assert.match(v, /^\d+\.\d+\.\d+/, `hub 版本需为严格 SemVer：${v}`)
})

// ---------------------------------------------------------------------------
// 纯 registry 层：beginUpgrade / commit 对账
// ---------------------------------------------------------------------------

/** 极简 EventEmitter socket 替身（node-health.test.ts 同款模式）。 */
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

class RegistrySocket extends EventEmitterShim {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

type WsLike = import('ws').WebSocket

async function registerRaw(
  registry: NodeRegistry,
  nodeId: string,
  extra: { version?: string; upgradeAttemptId?: string } = {},
): Promise<{ socket: RegistrySocket; outcome: { accepted: boolean; reason?: string } }> {
  const socket = new RegistrySocket()
  const outcome = await registry.register(
    socket as unknown as WsLike,
    {
      nodeId,
      token: `${nodeId}:secret`,
      hostname: 'upgrade-probe',
      platform: 'test',
      ...(extra.version !== undefined ? { version: extra.version } : {}),
      ...(extra.upgradeAttemptId !== undefined ? { upgradeAttemptId: extra.upgradeAttemptId } : {}),
    },
    () => ({ $close() {} }) as never,
  )
  return { socket, outcome }
}

test('registry.register：非法 version / upgradeAttemptId（空串）显式拒绝', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const badVersion = await registerRaw(registry, 'n1', { version: '' })
    assert.equal(badVersion.outcome.accepted, false)
    assert.equal(badVersion.outcome.reason, 'invalid version')
    const badAttempt = await registerRaw(registry, 'n2', { upgradeAttemptId: '' })
    assert.equal(badAttempt.outcome.accepted, false)
    assert.equal(badAttempt.outcome.reason, 'invalid upgradeAttemptId')
  } finally {
    await registry.close()
  }
})

test('registry：仅 register（候选无 commit）不 resolve 等待器；匹配 commit 成功', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    let settled = false
    void handle.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // 候选注册（顶替旧 socket）：绝不能让等待器成功。
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    assert.equal(candidate.outcome.accepted, true)
    await delay(150)
    assert.equal(settled, false, '仅候选注册（无 commit）不得 resolve 升级等待器')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // 候选心跳 commit（完全匹配）→ 成功。
    const ack = registry.noteHeartbeat('n1', candidate.socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 4242 },
    })
    assert.equal(ack, true)
    const result = await handle.result
    assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true, pid: 4242 })
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
    socket.close()
  } finally {
    await registry.close()
  }
})

test('registry：错误 attemptId / 错误版本 / previousVersion 不一致 / pid 非法拒绝（不假成功）', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    let failed = false
    void handle.result.then(
      () => undefined,
      () => {
        failed = true
      },
    )

    const conn = registry.get('n1')
    assert.notEqual(conn, undefined)
    // attemptId 错误。
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'other', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    // 版本不匹配（连接注册版本 1.1.0，commit 声称 9.9.9）。
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    // previousVersion 与等待器不一致（不倒灌别的 attempt）。
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    // pid 非正整数。
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: -3 },
    })
    await delay(100)
    assert.equal(failed, false, '全部非法 commit 不得终结等待器')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // 另一节点的连接伪造 commit（非当前连接）直接拒绝。
    const { socket: stranger } = await registerRaw(registry, 'n2', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const ackStranger = registry.noteHeartbeat('n1', stranger as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(ackStranger, false, '非当前连接的心跳直接拒绝')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    handle.cancel()
    await assert.rejects(handle.result)
    socket.close()
    stranger.close()
  } finally {
    await registry.close()
  }
})

test('registry：携带 commit 的心跳 ACK 真实接受结果；普通心跳恒 true', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // 无等待器：合法 commit（本机 CLI 路径）ACK true。
    const { socket: solo } = await registerRaw(registry, 'n-cli', { version: '2.0.0', upgradeAttemptId: 'cli-1' })
    const ackCli = registry.noteHeartbeat('n-cli', solo as unknown as WsLike, {
      upgradeCommit: { attemptId: 'cli-1', version: '2.0.0', previousVersion: '1.9.0', pid: 11 },
    })
    assert.equal(ackCli, true, '无等待器的合法 commit（本机 CLI 升级）应 ACK true')

    // 有等待器：不匹配的 commit ACK false（节点不得误以为 Hub 已确认）。
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    const badAttempt = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'wrong', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badAttempt, false, '错误 attemptId 的 commit 必须 Nack（ACK false）')
    const badVersion = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badVersion, false, '错误版本的 commit 必须 ACK false')
    const badPrevious = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    assert.equal(badPrevious, false, '错误 previousVersion 的 commit 必须 ACK false')
    const malformed = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1' } as never,
    })
    assert.equal(malformed, false, '缺字段的畸形 commit 必须 ACK false')
    assert.equal(registry.hasUpgradeWaiter('n1'), true, '全部被拒 commit 不影响等待器')

    // 普通心跳（无 commit）恒 true。
    const plain = registry.noteHeartbeat('n1', socket as unknown as WsLike, {})
    assert.equal(plain, true)

    // 匹配 commit ACK true 并 resolve。
    const matched = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 22 },
    })
    assert.equal(matched, true)
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry.close()
  }
})

test('registry：同节点并发 beginUpgrade 拒绝；原 socket 断开不清理等待器', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    assert.throws(
      () => registry.beginUpgrade('n1', { attemptId: 'a2', targetVersion: '1.2.0', previousVersion: '1.0.0', timeoutMs: 1_000 }),
      HelmUpgradeBusyError,
    )
    // 旧 socket 断开（升级过程必然伴随）：等待器继续等候选 commit。
    socket.close()
    await delay(100)
    assert.equal(registry.hasUpgradeWaiter('n1'), true, '原 socket 断开不得终结升级等待器')
  } finally {
    await registry.close()
  }
})

test('registry：断开原 RPC 但候选 commit 后正常成功；超时显式失败', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    socket.close() // 模拟旧 RPC 传输关闭
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.noteHeartbeat('n1', candidate.socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 7 },
    })
    const result = await handle.result
    assert.equal(result.ok, true)
    assert.equal(result.upgraded, true)
    assert.equal(result.pid, 7)
  } finally {
    await registry.close()
  }

  // 超时路径。
  const registry2 = new NodeRegistry({ authenticate: () => true })
  try {
    await registerRaw(registry2, 'n1', { version: '1.0.0' })
    const handle = registry2.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 200,
    })
    await assert.rejects(handle.result, HelmUpgradeTimeoutError)
    assert.equal(registry2.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry2.close()
  }
})

// ---------------------------------------------------------------------------
// 完整 Hub（KernelRuntime + startHub）+ 可编程节点 fixture
// ---------------------------------------------------------------------------

/**
 * 可编程 WS 节点 fixture：真实连 /ws/node，实现 register / heartbeat /
 * nodeCheckUpgrade / nodeUpgrade（行为可逐用例编程）。升级剧本：
 * nodeUpgrade 返回后断开旧连接，再以候选身份（新 version + attemptId）
 * 重连并按计划发（或不发）commit 心跳。
 */
interface FixturePlan {
  /** nodeUpgrade RPC 的结构化返回。 */
  rpcResult: RpcResult<NodeUpgradeResult>
  /** RPC 永不返回（模拟旧版节点僵死；整体仍必须有界）。 */
  hang?: boolean
  /** RPC 返回后断开旧连接，以候选身份重连（version=plan.candidateVersion）。 */
  reconnect?: { candidateVersion: string }
  /** 候选注册后发 commit（false = 不发；缺省发完全匹配的 commit）。 */
  commit?: false | { attemptId: string; version: string; previousVersion: string; pid: number }
  /** 候选注册到发 commit 的延迟毫秒（模拟「传输断开先到，commit 后到」）。 */
  commitDelayMs?: number
  /**
   * RPC 应答永不返回：reconnect 计划正常执行后（候选顶替旧 socket）
   * nodeUpgrade 返回永不 resolve 的 Promise，模拟「在途 RPC 被关闭」。
   * 覆盖真实链路：registry #evict → 旧 rpc $close → birpc reject 在途
   * 调用 → ws-gateway onGeneralError 吞 reject → Hub 侧 resolve undefined。
   */
  deferReplyUntilReplaced?: boolean
}

interface FixtureNode {
  nodeId: string
  registeredVersion: string | undefined
  lastAttemptId: string | undefined
  close(): void
}

async function connectFixtureNode(
  wsUrl: string,
  nodeId: string,
  nodeToken: string,
  version: string,
): Promise<
  FixtureNode & {
    setPlan(plan: FixturePlan): void
    registerOverride(extra: { version?: string; upgradeAttemptId?: string }): Promise<NodeRegisterResult>
    sendHeartbeat(input?: NodeHeartbeatInput): Promise<boolean>
    upgradeCalls: NodeUpgradeRpcInput[]
  }
> {
  const upgradeCalls: NodeUpgradeRpcInput[] = []
  const state = {
    plan: undefined as FixturePlan | undefined,
    registeredVersion: undefined as string | undefined,
    lastAttemptId: undefined as string | undefined,
  }
  const ws = new WebSocket(`${wsUrl}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  const nodeSide: NodeEnvRpcFunctions & {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>
    heartbeat(id: string, input?: NodeHeartbeatInput): Promise<boolean>
  } = {
    register: async (input: NodeRegisterInput) => {
      state.registeredVersion = input.version
      if (input.upgradeAttemptId !== undefined) state.lastAttemptId = input.upgradeAttemptId
      return { ok: true, heartbeatMs: 60_000 }
    },
    heartbeat: async () => true,
    nodeCheckUpgrade: async () =>
      ({ ok: true, value: { currentVersion: version, latestVersion: '9.9.9', updateAvailable: true } }) as RpcResult<NodeUpgradeCheckResult>,
    nodeUpgrade: async (input: NodeUpgradeRpcInput) => {
      upgradeCalls.push(input)
      const plan = state.plan
      if (plan === undefined) {
        return { ok: false, error: { code: 'unknown', message: 'fixture 未设置升级剧本' } }
      }
      if (plan.hang === true) {
        // 永不返回（也不重连）：验证 Hub 整体超时仍有界。
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      if (plan.reconnect !== undefined) {
        // 模拟真实升级：先应答 RPC（旧连接仍活），随后异步断开重连为候选。
        const reconnectVersion = plan.reconnect.candidateVersion
        const attemptId = input.attemptId ?? ''
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* 已关 */
          }
          void connectCandidate(wsUrl, nodeId, nodeToken, reconnectVersion, attemptId, state, plan)
        }, 30).unref()
      }
      if (plan.deferReplyUntilReplaced === true) {
        // 在途 RPC 被顶替：候选注册后旧 socket 的 birpc 被 $close，本侧
        // birpc 的应答发送将随 socket 断开而失败——永不 resolve，交由 Hub
        // 侧真实链路（evict → $close → onGeneralError 吞 reject）处理。
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      return plan.rpcResult
    },
    // 其余 env RPC 本测试不触及。
  } as unknown as NodeEnvRpcFunctions & {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>
    heartbeat(id: string, input?: NodeHeartbeatInput): Promise<boolean>
  }

  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    } & NodeEnvRpcFunctions,
    typeof nodeSide
  >(nodeSide, {
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
  })

  // 初始注册（当前版本）。
  const registered = await rpc.register({
    nodeId,
    token: nodeToken,
    hostname: 'upgrade-fixture',
    platform: process.platform,
    version,
  })
  if (!registered.ok) throw new Error(`fixture 注册失败：${registered.reason ?? 'unknown'}`)

  return {
    nodeId,
    get registeredVersion() {
      return state.registeredVersion
    },
    get lastAttemptId() {
      return state.lastAttemptId
    },
    upgradeCalls,
    setPlan(plan) {
      state.plan = plan
    },
    async registerOverride(extra) {
      return rpc.register({
        nodeId,
        token: nodeToken,
        hostname: 'upgrade-fixture',
        platform: process.platform,
        ...(extra.version !== undefined ? { version: extra.version } : {}),
        ...(extra.upgradeAttemptId !== undefined ? { upgradeAttemptId: extra.upgradeAttemptId } : {}),
      })
    },
    sendHeartbeat: (input) => rpc.heartbeat(nodeId, input),
    close() {
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

/** 候选连接：新 socket 注册新版本 + attemptId，按计划发 commit。 */
async function connectCandidate(
  wsUrl: string,
  nodeId: string,
  nodeToken: string,
  version: string,
  attemptId: string,
  state: { registeredVersion: string | undefined; lastAttemptId: string | undefined },
  plan: FixturePlan,
): Promise<void> {
  const ws = new WebSocket(`${wsUrl}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  }).catch(() => undefined)
  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    },
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    }
  >(
    {
      register: async (input: NodeRegisterInput) => {
        state.registeredVersion = input.version
        if (input.upgradeAttemptId !== undefined) state.lastAttemptId = input.upgradeAttemptId
        return { ok: true, heartbeatMs: 60_000 }
      },
      heartbeat: async () => true,
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
            /* 忽略 */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  const outcome = await rpc
    .register({
      nodeId,
      token: nodeToken,
      hostname: 'upgrade-fixture',
      platform: process.platform,
      version,
      upgradeAttemptId: attemptId,
    })
    .catch(() => undefined)
  if (outcome === undefined || !outcome.ok) return
  // 候选 commit：缺省发完全匹配；false 不发（测试「仅注册不 commit」）；
  // commitDelayMs 推迟发送（模拟传输断开先到、commit 后到）。
  const commit = plan.commit
  if (commit === false) return
  const sendCommit = async (): Promise<void> => {
    const payload: NodeHeartbeatInput = {
      upgradeCommit:
        commit !== undefined
          ? commit
          : {
              attemptId,
              version,
              previousVersion: previousVersionFor(nodeId, attemptId),
              pid: 4321,
            },
    }
    await rpc.heartbeat(nodeId, payload).catch(() => undefined)
  }
  if ((plan.commitDelayMs ?? 0) > 0) {
    setTimeout(() => {
      void sendCommit()
    }, plan.commitDelayMs).unref()
    return
  }
  await sendCommit()
}

/** 升级剧本内的旧版本记录（commit previousVersion 需与等待器一致）。 */
const previousVersionByAttempt = new Map<string, string>()
function previousVersionFor(nodeId: string, attemptId: string): string {
  return previousVersionByAttempt.get(`${nodeId}:${attemptId}`) ?? '1.0.0'
}

/** 打开完整 Hub（含 /ws/node 网关与鉴权）。 */
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
    watchdogIntervalMs: 0,
    nodeUpgradeTimeoutMs: 600,
  })
  const hub = await startHub({
    kernel: kernel as never,
    port: 0,
  })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'node-upgrade-test-pass' }),
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

/** 签发节点身份并连接 fixture 节点。 */
async function provisionNode(
  hubUrl: string,
  token: string,
  nodeId: string,
  version: string,
): Promise<ReturnType<typeof connectFixtureNode>> {
  const issue = await fetch(`${hubUrl}/api/nodes/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ nodeId }),
  })
  assert.equal(issue.status, 201, '签发节点令牌失败')
  const { token: nodeToken } = (await issue.json()) as { token: string }
  const wsUrl = hubUrl.replace(/^http/, 'ws')
  return connectFixtureNode(wsUrl, nodeId, nodeToken, version)
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

// ---------------------------------------------------------------------------
// HTTP / RPC 集成：upgrade 编排（成功、假成功防线、错误映射）
// ---------------------------------------------------------------------------

test('upgrade：仅候选注册（无 commit）不成功——显式未确认错误', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'no-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-no-commit', '1.0.0')
    previousVersionByAttempt.set(`up-no-commit:${node.upgradeCalls.length}`, '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commit: false, // 候选注册但永不 commit
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-no-commit/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 502, '仅注册无 commit 必须显式失败（不假成功）')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：匹配 commit（断开原 RPC 后）正常成功且结果确认', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'commit-ok-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-ok', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      // 缺省 commit：attemptId/version 由候选真实注册值推导，previousVersion 1.0.0。
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-ok/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: ' v1.1.0 ' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'v 前缀规范化为精确版本')
    assert.equal(body.previousVersion, '1.0.0')
    assert.equal(typeof body.pid, 'number')
    // RPC 入参携带规范化 targetVersion 与服务端生成的 attemptId。
    assert.equal(node.upgradeCalls.length, 1)
    assert.equal(node.upgradeCalls[0]!.targetVersion, '1.1.0')
    assert.match(node.upgradeCalls[0]!.attemptId ?? '', /^[0-9a-f]{32}$/)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：节点结构化拒绝 → 400/501/502 且不假成功', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'reject-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-reject', '1.0.0')
    const failures = [
      { code: 'invalid', status: 400 },
      { code: 'not_supported', status: 501 },
      { code: 'unknown', status: 502 },
    ] as const
    for (const failure of failures) {
      node.setPlan({ rpcResult: { ok: false, error: { code: failure.code, message: '目标版本不可用' } } })
      const res = await fetch(`${app.hub.url}/api/nodes/up-reject/upgrade`, {
        method: 'POST',
        headers: authHeaders(app.token),
        body: JSON.stringify({ targetVersion: '1.1.0' }),
      })
      assert.equal(res.status, failure.status, failure.code)
    }
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：明确无操作（ok/upgraded:false）合法返回，不等待 commit', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'noop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-noop', '1.1.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.1.0', targetVersion: '1.1.0', upgraded: false } },
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-noop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.upgraded, false)
    node.setPlan({
      rpcResult: { ok: true, value: { ok: false, previousVersion: '1.1.0', targetVersion: '1.1.0', upgraded: false } },
    })
    const failed = await fetch(`${app.hub.url}/api/nodes/up-noop/upgrade`, {
      method: 'POST', headers: authHeaders(app.token), body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(failed.status, 502, 'ok:false 不能伪装成成功的无操作')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade 错误映射：local 400 / 未知 404 / offline 409 / 不支持 501', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'errors-'))
  const app = await openHubApp(dir)
  try {
    // local。
    const local = await fetch(`${app.hub.url}/api/nodes/local/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(local.status, 400)
    // 未知节点（未签发）。
    const unknown = await fetch(`${app.hub.url}/api/nodes/ghost/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(unknown.status, 404)
    // 已签发但离线。
    const issue = await fetch(`${app.hub.url}/api/nodes/issue`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ nodeId: 'up-offline' }),
    })
    assert.equal(issue.status, 201)
    const offline = await fetch(`${app.hub.url}/api/nodes/up-offline/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(offline.status, 409)
    const offlineBody = (await offline.json()) as { error: { code: string } }
    assert.equal(offlineBody.error.code, 'node_offline')
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade check：透传节点结果（含 blocked）；body/query 边界校验', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'check-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-check', '1.0.0')
    const res = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeCheckResult
    assert.equal(body.currentVersion, '1.0.0')
    assert.equal(body.latestVersion, '9.9.9')
    assert.equal(body.updateAvailable, true)
    node.close()

    // 非法 registryUrl（非 http(s)）。
    const badUrl = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check?registryUrl=ftp://x`, {
      headers: authHeaders(app.token),
    })
    assert.equal(badUrl.status, 400)

    // POST body 未知字段拒绝。
    const unknownField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ attemptId: 'user-controlled' }),
    })
    assert.equal(unknownField.status, 400, 'attemptId 不可由用户控制')
    const badForce = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ force: 'yes' }),
    })
    assert.equal(badForce.status, 400)
    const badRegistry = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ registryUrl: 'javascript:alert(1)' }),
    })
    assert.equal(badRegistry.status, 400)
    const badVersion = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: 'latest' }),
    })
    assert.equal(badVersion.status, 400)
    for (const field of ['targetVersion', 'registryUrl']) {
      const nullField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
        method: 'POST', headers: authHeaders(app.token), body: JSON.stringify({ [field]: null }),
      })
      assert.equal(nullField.status, 400, `${field}:null 必须拒绝，不能静默当成缺省`)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：离线节点在途调用后断连——不假成功（结果未确认 502）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'rpc-drop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-drop', '1.0.0')
    node.setPlan({
      // RPC 成功但节点直接消失（不重连、不 commit）。
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
    })
    // RPC 返回后立即断开（不产生候选）。
    const resPromise = fetch(`${app.hub.url}/api/nodes/up-drop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    await delay(50)
    node.close()
    const res = await resPromise
    assert.equal(res.status, 502, '无候选 commit 不得成功')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
  } finally {
    await app.close().catch(() => undefined)
  }
})

// ---------------------------------------------------------------------------
// 自动升级（HELM_AUTO_UPGRADE_NODES）
// ---------------------------------------------------------------------------

test('自动升级默认关闭：落后节点上线不触发 nodeUpgrade', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-off-'))
  const app = await openHubApp(dir)
  try {
    // 0.0.1 必然严格落后 Hub（kernel 0.1.0+）。
    const node = await provisionNode(app.hub.url, app.token, 'auto-off-node', '0.0.1')
    await delay(600)
    assert.equal(node.upgradeCalls.length, 0, '默认关闭时绝不自动调用 nodeUpgrade')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('HELM_AUTO_UPGRADE_NODES=1：严格落后节点上线异步升级到 Hub 版本', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-on-'))
  process.env['HELM_AUTO_UPGRADE_NODES'] = '1'
  let app: Awaited<ReturnType<typeof openHubApp>> | undefined
  try {
    app = await openHubApp(dir)
    const node = await provisionNode(app.hub.url, app.token, 'auto-on-node', '0.0.1')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
      reconnect: { candidateVersion: hubVersion() },
    })
    // 等待 onNodeChanged 异步路径触发 upgradeNode（不阻塞注册）。
    for (let i = 0; i < 50 && node.upgradeCalls.length === 0; i++) {
      await delay(100)
    }
    assert.equal(node.upgradeCalls.length, 1, '开启后落后节点上线应触发一次自动升级')
    assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion(), '自动升级目标为 Hub 版本')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('自动升级去重：同节点失败后不再无限重试（升级调用恰一次）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-dedupe-'))
  process.env['HELM_AUTO_UPGRADE_NODES'] = '1'
  let app: Awaited<ReturnType<typeof openHubApp>> | undefined
  try {
    app = await openHubApp(dir)
    const node = await provisionNode(app.hub.url, app.token, 'auto-dedupe-node', '0.0.1')
    node.setPlan({
      rpcResult: { ok: false, error: { code: 'unknown', message: '注入失败' } },
    })
    for (let i = 0; i < 30 && node.upgradeCalls.length === 0; i++) {
      await delay(100)
    }
    assert.equal(node.upgradeCalls.length, 1)
    // 再等一段时间：不重试（去重）。
    await delay(1_200)
    assert.equal(node.upgradeCalls.length, 1, '同节点自动升级只尝试一轮')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('upgrade：候选注册后延迟 50ms 才 commit——传输断开先到时仍等待成功', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'late-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-late', '1.0.0')
    // 升级流程：RPC 应答 → 旧 socket 断开（rpcError 必先到达 Hub）→
    // 候选重连注册 → 50ms 后才发 commit。Hub 必须继续等 commit 而不是
    // 把断开当成终态失败（回归：重 race 已 settle rpcPromise 的必达 bug）。
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commitDelayMs: 50,
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-late/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200, '断开先到、commit 后到：最终必须成功')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：在途 RPC 被候选顶替关闭（应答被吞成 undefined）——继续等真实 commit 成功', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'inflight-close-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-inflight', '1.0.0')
    // 真实链路复现：reconnect 计划照常执行（旧 socket 关闭 + 候选注册），
    // 但旧连接上的 nodeUpgrade 应答永不 resolve——旧 socket 被 $close 后
    // birpc 在途调用被 reject，ws-gateway.onGeneralError 吞成 resolve(undefined)。
    // 修复前：race 拿 {kind:'rpc',value:undefined} → invalid shape 502 提前失败；
    // 修复后：识别为传输中断，继续等候选 commit（commitDelayMs 50ms）。
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      deferReplyUntilReplaced: true,
      commitDelayMs: 50,
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-inflight/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200, '在途 RPC 被顶替关闭后必须继续等 commit，不得提前 502')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'target 来自真实 commit 心跳')
    assert.equal(body.previousVersion, '1.0.0', 'previous 来自真实 commit 心跳')
    assert.equal(typeof body.pid, 'number')
    assert.ok(Number.isInteger(body.pid) && body.pid! > 0, 'pid 必须是真实 commit 携带的正整数')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：RPC 永不返回且无候选——短超时内有界失败（不挂 30min）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'hang-'))
  const app = await openHubApp(dir) // nodeUpgradeTimeoutMs = 2_500
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-hang', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      hang: true, // 永不返回，永不重连
    })
    const startedAt = Date.now()
    const res = await fetch(`${app.hub.url}/api/nodes/up-hang/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 502, 'RPC 僵死时必须显式失败')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    assert.ok(elapsed < 30_000, `升级等待必须有界（实际 ${elapsed}ms，绝不挂 birpc 30min）`)
    // 等待器已清理：同节点可再次发起（不永久 busy）。
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-hang'), false)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：非法 RpcResult/非法结果体后等待器清理——同节点可再次升级（不永久 busy）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'busy-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-busy', '1.0.0')
    // 第一次：结果体非法（缺 targetVersion 字段）。
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', upgraded: true } as unknown as NodeUpgradeResult },
    })
    const first = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(first.status, 502, '非法结果体必须显式失败')
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false, '失败后等待器必须清理')
    // 第二次：结构化拒绝后同样可再次发起。
    node.setPlan({ rpcResult: { ok: false, error: { code: 'not_supported', message: '注入拒绝' } } })
    const second = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.2.0' }),
    })
    assert.equal(second.status, 501)
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false)
    assert.equal(node.upgradeCalls.length, 2, '两次调用都应到达节点（无 busy 阻塞）')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade：节点未上报 version 时先 check 取真实 currentVersion 作 previous（绝不 unknown）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'prev-'))
  const app = await openHubApp(dir)
  try {
    // fixture 注册时不携带 version：Hub 必须经 check 拿 currentVersion=1.0.0。
    const node = await provisionNode(app.hub.url, app.token, 'up-prev', '1.0.0')
    // 直接验证：升级成功路径的 previousVersion 来自 conn.version（1.0.0）。
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-prev/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.previousVersion, '1.0.0', 'previousVersion 必须是真实版本，绝不 unknown')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('teardown: 清理临时根目录', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
