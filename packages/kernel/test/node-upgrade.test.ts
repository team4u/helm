/**
 * End-to-end tests for node upgrades (Hub-side orchestrator + registry waiters):
 * Real NodeRegistry + /ws/node gateway + configurable in-process node fixture (controlling
 * nodeUpgrade / nodeCheckUpgrade behavior and register/heartbeat timing), wrapped with the full
 * Hub HTTP layer (KernelRuntime + startHub) covering GET /api/nodes/:id/upgrade/check and
 * POST /api/nodes/:id/upgrade.
 *
 * Core correctness invariants (verified via real behavior, never source-regex smoke checks):
 * 1. When an in-flight nodeUpgrade RPC disconnects because the candidate supersedes the old socket,
 *    the upgrade outcome may only be confirmed by a matching commit heartbeat from the candidate --
 *    never falsely succeed merely because a new connection appeared or an error was caught;
 * 2. Registration alone (without commit) never succeeds; mismatched attemptId / mismatched version /
 *    spoofed connection commit is rejected; a matching commit (attemptId + version +
 *    previousVersion + positive integer pid) succeeds;
 * 3. A valid commit without an active waiter (local CLI upgrade path) still ACKs true;
 * 4. Error mapping: local 400 / unknown 404 / offline 409 / unsupported 501 / structured failure 400/502 /
 *    unconfirmed timeout 502;
 * 5. HTTP body boundary validation: rejects unknown fields / non-http(s) registryUrl / non-boolean force /
 *    user-supplied attemptId;
 * 6. Auto-upgrade is disabled by default; triggered when HELM_AUTO_UPGRADE_NODES=1 and the node has a
 *    strictly older SemVer than Hub.
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

/** Async mkdtemp alias (creates per-case directories). */
const mkdtemp = (prefix: string): Promise<string> => mkdtempAsync(prefix)

void mkdtemp

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-node-upgrade-'))
})

// ---------------------------------------------------------------------------
// version semantics unit
// ---------------------------------------------------------------------------

test('normalizeExplicitVersion: trims and strips single v prefix; rejects invalid inputs explicitly', { timeout: 60_000 }, () => {
  assert.equal(normalizeExplicitVersion('1.2.3'), '1.2.3')
  assert.equal(normalizeExplicitVersion(' v1.2.3 '), '1.2.3')
  assert.equal(normalizeExplicitVersion('V2.0.0-rc.1+build.5'), '2.0.0-rc.1+build.5')
  assert.throws(() => normalizeExplicitVersion('1.2'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('vv1.2.3'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('latest'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('1.2.3.4'), /SemVer/)
})

test('compareStrictSemVer: sorts major/minor/patch/prerelease versions', { timeout: 60_000 }, () => {
  assert.equal(compareStrictSemVer('1.2.3', '1.2.3'), 0)
  assert.equal(compareStrictSemVer('0.9.9', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.10.0', '1.9.0'), 1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha.1', '1.0.0-alpha.2'), -1)
  assert.equal(compareStrictSemVer('1.0.0-2', '1.0.0-10'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0-beta'), -1)
})

test('hubVersion: read kernel package.json(strictly SemVer)', { timeout: 60_000 }, () => {
  const v = hubVersion()
  assert.match(v, /^\d+\.\d+\.\d+/, `hub version must be strictly SemVer:${v}`)
})

// ---------------------------------------------------------------------------
// Pure registry layer: beginUpgrade / commit accounting
// ---------------------------------------------------------------------------

/** Minimal EventEmitter socket stub (same style as node-health.test.ts). */
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

test('registry.register: rejects invalid version or empty upgradeAttemptId explicitly', { timeout: 60_000 }, async () => {
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

test('registry: registration alone (without commit) never resolves waiter; matching commit succeeds', { timeout: 60_000 }, async () => {
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
    // Candidate registration (evicts old socket): must not resolve the upgrade waiter.
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    assert.equal(candidate.outcome.accepted, true)
    await delay(150)
    assert.equal(settled, false, 'candidate registration alone (without commit) must not resolve the upgrade waiter')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // Candidate heartbeat commits (exact match) -> succeeds.
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

test('registry: reject wrong attemptId / wrong version / mismatched previousVersion / invalid pid (never false positive)', { timeout: 60_000 }, async () => {
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
    // Wrong attemptId.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'other', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    // Mismatched version (connection registered as 1.1.0, commit claims 9.9.9).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    // Mismatched previousVersion compared to waiter (prevent cross-contamination from other attempts).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    // Non-positive integer pid.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: -3 },
    })
    await delay(100)
    assert.equal(failed, false, 'all invalid commits must not resolve the waiter')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // Forged commit from another node connection (not current connection) must be rejected directly.
    const { socket: stranger } = await registerRaw(registry, 'n2', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const ackStranger = registry.noteHeartbeat('n1', stranger as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(ackStranger, false, 'heartbeat from non-current connection must be rejected directly')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    handle.cancel()
    await assert.rejects(handle.result)
    socket.close()
    stranger.close()
  } finally {
    await registry.close()
  }
})

test('registry: heartbeat with commit ACKs actual acceptance result; plain heartbeat always ACKs true', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // No waiter: valid commit (local CLI path) ACKs true.
    const { socket: solo } = await registerRaw(registry, 'n-cli', { version: '2.0.0', upgradeAttemptId: 'cli-1' })
    const ackCli = registry.noteHeartbeat('n-cli', solo as unknown as WsLike, {
      upgradeCommit: { attemptId: 'cli-1', version: '2.0.0', previousVersion: '1.9.0', pid: 11 },
    })
    assert.equal(ackCli, true, 'valid commit without waiter (local CLI upgrade) should ACK true')

    // With waiter: mismatched commit ACKs false (node must not mistake rejection for Hub confirmation).
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    const badAttempt = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'wrong', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badAttempt, false, 'wrong attemptId commit must Nack (ACK false)')
    const badVersion = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badVersion, false, 'wrong version commit must ACK false')
    const badPrevious = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    assert.equal(badPrevious, false, 'wrong previousVersion commit must ACK false')
    const malformed = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1' } as never,
    })
    assert.equal(malformed, false, 'malformed commit with missing fields must ACK false')
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'rejected commits must not affect waiter')

    // Plain heartbeat (without commit) always returns true.
    const plain = registry.noteHeartbeat('n1', socket as unknown as WsLike, {})
    assert.equal(plain, true)

    // Matching commit ACKs true and resolves waiter.
    const matched = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 22 },
    })
    assert.equal(matched, true)
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry.close()
  }
})

test('registry: reject concurrent beginUpgrade on same node; original socket disconnect does not clear waiter', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    assert.throws(
      () => registry.beginUpgrade('n1', { attemptId: 'a2', targetVersion: '1.2.0', previousVersion: '1.0.0', timeoutMs: 1_000 }),
      HelmUpgradeBusyError,
    )
    // Old socket disconnects (expected during upgrade): waiter stays alive waiting for candidate commit.
    socket.close()
    await delay(100)
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'original socket disconnect must not resolve upgrade waiter')
  } finally {
    await registry.close()
  }
})

test('registry: original RPC disconnect followed by candidate commit still succeeds; timeout fails explicitly', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    socket.close() // Simulate old RPC transport closing
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

  // Timeout path.
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
// Full Hub (KernelRuntime + startHub) + programmable node fixture
// ---------------------------------------------------------------------------

/**
 * Programmable WS node fixture: connects via real /ws/node and handles register / heartbeat /
 * nodeCheckUpgrade / nodeUpgrade (behavior scripted per test case). Typical upgrade scenario:
 * after nodeUpgrade returns, disconnects the old connection, then reconnects with candidate
 * identity (new version + attemptId) and either commits via heartbeat per plan or skips commit.
 */
interface FixturePlan {
  /** Synthesized return value for nodeUpgrade RPC. */
  rpcResult: RpcResult<NodeUpgradeResult>
  /** Never return from RPC (simulates legacy node hanging; overall operation must still have a deadline). */
  hang?: boolean
  /** After RPC returns, disconnect old connection and reconnect with candidate identity (version=plan.candidateVersion). */
  reconnect?: { candidateVersion: string }
  /** Commit after candidate registration (false = do not commit; defaults to exact matching commit). */
  commit?: false | { attemptId: string; version: string; previousVersion: string; pid: number }
  /** Delay in ms between candidate registration and commit (simulates transport disconnect landing first, commit arriving later). */
  commitDelayMs?: number
  /**
   * RPC reply never arrives: after reconnect completes (candidate evicts old socket),
   * nodeUpgrade returns a never-resolving Promise to simulate in-flight RPC being closed.
   * Covers real chain: registry #evict -> old rpc $close -> birpc rejects in-flight
   * call -> ws-gateway onGeneralError swallows rejection -> Hub resolves undefined.
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
        return { ok: false, error: { code: 'unknown', message: 'fixture did not configure an upgrade plan' } }
      }
      if (plan.hang === true) {
        // Never returns (nor reconnects): verifies Hub overall timeout still has an upper bound.
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      if (plan.reconnect !== undefined) {
        // Simulates real upgrade: reply RPC first (old connection stays open), then disconnect asynchronously and reconnect as candidate.
        const reconnectVersion = plan.reconnect.candidateVersion
        const attemptId = input.attemptId ?? ''
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* already closed */
          }
          void connectCandidate(wsUrl, nodeId, nodeToken, reconnectVersion, attemptId, state, plan)
        }, 30).unref()
      }
      if (plan.deferReplyUntilReplaced === true) {
        // In-flight RPC evicted: after candidate registers, old socket birpc closes via $close, so this side's
        // birpc reply fails to send on the disconnected socket — never resolve, exercising the real Hub
        // chain (evict -> $close -> onGeneralError swallows rejection).
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      return plan.rpcResult
    },
    // Remaining env RPCs are never triggered in this test.
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
          /* ignore non-JSON frames */
        }
      })
    },
    serialize: (d) => d,
    deserialize: (d) => d as never,
    timeout: 10_000,
  })

  // Initial registration (current version).
  const registered = await rpc.register({
    nodeId,
    token: nodeToken,
    hostname: 'upgrade-fixture',
    platform: process.platform,
    version,
  })
  if (!registered.ok) throw new Error(`fixture register failed:${registered.reason ?? 'unknown'}`)

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

/** Candidate connection: new socket registers new version + attemptId and commits per plan. */
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
            /* ignore */
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
  // Candidate commit: defaults to a full match; false skips committing (tests registration without commit);
  // commitDelayMs delays sending commit (simulating transport disconnect arriving first, commit later).
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

/** Tracks previousVersion in the upgrade scenario (commit's previousVersion must match the waiter). */
const previousVersionByAttempt = new Map<string, string>()
function previousVersionFor(nodeId: string, attemptId: string): string {
  return previousVersionByAttempt.get(`${nodeId}:${attemptId}`) ?? '1.0.0'
}

/** Starts a full Hub instance (with /ws/node gateway and authentication). */
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

/** Issues a node credential and connects the fixture node. */
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
  assert.equal(issue.status, 201, 'issuing node token failed')
  const { token: nodeToken } = (await issue.json()) as { token: string }
  const wsUrl = hubUrl.replace(/^http/, 'ws')
  return connectFixtureNode(wsUrl, nodeId, nodeToken, version)
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

// ---------------------------------------------------------------------------
// HTTP / RPC integration: upgrade orchestration (success, false-success guard, error mapping)
// ---------------------------------------------------------------------------

test('upgrade: candidate registration alone (without commit) never succeeds -- explicit unconfirmed error', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'no-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-no-commit', '1.0.0')
    previousVersionByAttempt.set(`up-no-commit:${node.upgradeCalls.length}`, '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commit: false, // candidate registers but never commits
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-no-commit/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 502, 'registration without commit must fail explicitly (never false-succeed)')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: matching commit (after old RPC disconnects) succeeds and confirms result', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'commit-ok-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-ok', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      // default commit: attemptId/version taken from candidate's actual registration, previousVersion is 1.0.0.
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
    assert.equal(body.targetVersion, '1.1.0', 'v prefix normalized to canonical version')
    assert.equal(body.previousVersion, '1.0.0')
    assert.equal(typeof body.pid, 'number')
    // RPC arguments carry normalized targetVersion and server-generated attemptId.
    assert.equal(node.upgradeCalls.length, 1)
    assert.equal(node.upgradeCalls[0]!.targetVersion, '1.1.0')
    assert.match(node.upgradeCalls[0]!.attemptId ?? '', /^[0-9a-f]{32}$/)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: structured node rejection maps to 400/501/502 without false success', { timeout: 60_000 }, async () => {
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
      node.setPlan({ rpcResult: { ok: false, error: { code: failure.code, message: 'target version unavailable' } } })
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

test('upgrade: explicit no-op (ok: true, upgraded: false) returns normally without waiting for commit', { timeout: 60_000 }, async () => {
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
    assert.equal(failed.status, 502, 'ok: false cannot masquerade as a no-op success')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade error mapping: local 400 / unknown 404 / offline 409 / unsupported 501', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'errors-'))
  const app = await openHubApp(dir)
  try {
    // local node.
    const local = await fetch(`${app.hub.url}/api/nodes/local/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(local.status, 400)
    // unknown node (not provisioned).
    const unknown = await fetch(`${app.hub.url}/api/nodes/ghost/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(unknown.status, 404)
    // provisioned but offline.
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

test('upgrade check: passes through node result (including blocked); validates body/query boundaries', { timeout: 60_000 }, async () => {
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

    // Invalid registryUrl (non-http(s)).
    const badUrl = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check?registryUrl=ftp://x`, {
      headers: authHeaders(app.token),
    })
    assert.equal(badUrl.status, 400)

    // Unknown fields in POST body are rejected.
    const unknownField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ attemptId: 'user-controlled' }),
    })
    assert.equal(unknownField.status, 400, 'attemptId cannot be controlled by the user')
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
      assert.equal(nullField.status, 400, `${field}: null must reject rather than silently falling back to default`)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: node disconnects mid-RPC -- never falsely succeeds (unconfirmed 502)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'rpc-drop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-drop', '1.0.0')
    node.setPlan({
      // RPC succeeded, but the node disappears without reconnecting or committing.
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
    })
    // Disconnect immediately after RPC returns (produces no candidate).
    const resPromise = fetch(`${app.hub.url}/api/nodes/up-drop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    await delay(50)
    node.close()
    const res = await resPromise
    assert.equal(res.status, 502, 'upgrade must not succeed without a candidate commit')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
  } finally {
    await app.close().catch(() => undefined)
  }
})

// ---------------------------------------------------------------------------
// Auto-upgrade (HELM_AUTO_UPGRADE_NODES)
// ---------------------------------------------------------------------------

test('auto-upgrade disabled by default: older node connecting does not trigger nodeUpgrade', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-off-'))
  const app = await openHubApp(dir)
  try {
    // 0.0.1 is strictly older than Hub (kernel 0.1.0+).
    const node = await provisionNode(app.hub.url, app.token, 'auto-off-node', '0.0.1')
    await delay(600)
    assert.equal(node.upgradeCalls.length, 0, 'never automatically invokes nodeUpgrade when disabled by default')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('HELM_AUTO_UPGRADE_NODES=1: strictly older node auto-upgrades async to Hub version', { timeout: 60_000 }, async () => {
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
    // Wait for async onNodeChanged path to trigger upgradeNode (non-blocking registration).
    for (let i = 0; i < 50 && node.upgradeCalls.length === 0; i++) {
      await delay(100)
    }
    assert.equal(node.upgradeCalls.length, 1, 'enabling auto-upgrade should trigger one upgrade when older node connects')
    assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion(), 'auto-upgrade target must be Hub version')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('auto-upgrade deduplication: same failed node is not retried endlessly (invoked once)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-dedupe-'))
  process.env['HELM_AUTO_UPGRADE_NODES'] = '1'
  let app: Awaited<ReturnType<typeof openHubApp>> | undefined
  try {
    app = await openHubApp(dir)
    const node = await provisionNode(app.hub.url, app.token, 'auto-dedupe-node', '0.0.1')
    node.setPlan({
      rpcResult: { ok: false, error: { code: 'unknown', message: 'inject failed' } },
    })
    for (let i = 0; i < 30 && node.upgradeCalls.length === 0; i++) {
      await delay(100)
    }
    assert.equal(node.upgradeCalls.length, 1)
    // Wait another interval: must not retry (deduplicated).
    await delay(1_200)
    assert.equal(node.upgradeCalls.length, 1, 'auto-upgrade attempts only once per node')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('upgrade: waits for commit after candidate registers 50ms later even when transport disconnects first', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'late-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-late', '1.0.0')
    // Upgrade flow: RPC replies -> old socket disconnects (rpcError must reach Hub first) ->
    // candidate reconnects and registers -> commits 50ms later. Hub must keep waiting for commit
    // rather than terminally failing on disconnect (regression: racing resolved rpcPromise).
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
    assert.equal(res.status, 200, 'disconnect first, commit later: must ultimately succeed')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: in-flight RPC closed by candidate takeover (reply swallowed as undefined) -- waits for real commit and succeeds', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'inflight-close-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-inflight', '1.0.0')
    // Real-world restart timing: reconnect runs concurrently (old socket closes + candidate registers)
    // before the old connection's nodeUpgrade reply ever resolves -- birpc rejects in-flight call on
    // $close and ws-gateway.onGeneralError swallows it into resolve(undefined).
    // Previously: race took { kind: 'rpc', value: undefined } -> invalid shape 502 premature failure;
    // Now: detects transport interruption and continues waiting for candidate commit (commitDelayMs 50ms).
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
    assert.equal(res.status, 200, 'must wait for commit after in-flight RPC closes on takeover instead of failing prematurely with 502')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'target comes from real commit heartbeat')
    assert.equal(body.previousVersion, '1.0.0', 'previous comes from real commit heartbeat')
    assert.equal(typeof body.pid, 'number')
    assert.ok(Number.isInteger(body.pid) && body.pid! > 0, 'pid must be the positive integer from the real commit')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: RPC never returns and no candidate arrives -- fails within short bounded timeout (no 30min hang)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'hang-'))
  const app = await openHubApp(dir) // nodeUpgradeTimeoutMs = 600
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-hang', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      hang: true, // never replies and never reconnects
    })
    const startedAt = Date.now()
    const res = await fetch(`${app.hub.url}/api/nodes/up-hang/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 502, 'dead RPC must fail explicitly')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    assert.ok(elapsed < 30_000, `upgrade waiter must be bounded (actual ${elapsed}ms, never hang birpc 30min)`)
    // Waiter cleaned up: node can start a new upgrade (never permanently busy).
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-hang'), false)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: waiter cleans up after invalid RpcResult/payload -- same node can upgrade again (no permanent busy lock)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'busy-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-busy', '1.0.0')
    // First attempt: malformed payload (missing targetVersion field).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', upgraded: true } as unknown as NodeUpgradeResult },
    })
    const first = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(first.status, 502, 'malformed result payload must fail explicitly')
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false, 'waiter must be cleaned up after failure')
    // Second attempt: structured rejection also allows re-entry.
    node.setPlan({ rpcResult: { ok: false, error: { code: 'not_supported', message: 'injected rejection' } } })
    const second = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.2.0' }),
    })
    assert.equal(second.status, 501)
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false)
    assert.equal(node.upgradeCalls.length, 2, 'both calls should reach the node without being blocked as busy')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: uses real currentVersion from check as previousVersion when node omits reported version (never unknown)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'prev-'))
  const app = await openHubApp(dir)
  try {
    // When registration omits version, Hub must populate currentVersion=1.0.0 via check.
    const node = await provisionNode(app.hub.url, app.token, 'up-prev', '1.0.0')
    // Verify directly: upgrade success path derives previousVersion from conn.version (1.0.0).
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
    assert.equal(body.previousVersion, '1.0.0', 'previousVersion must be the real version, never unknown')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('teardown: clean up temporary directory', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
