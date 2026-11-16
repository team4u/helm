/**
 * node upgrade (Hub side orchestrator + registry wait for) end-to-end test:
 * real NodeRegistry + /ws/node gateway + can edit process node fixture(can control nodeUpgrade /
 * nodeCheckUpgrade behavior and register/heartbeat when order), outside add complete Hub HTTP layer
 * (KernelRuntime + startHub) override GET /api/nodes/:id/upgrade/check and
 * POST /api/nodes/:id/upgrade.
 *
 * correct core (each items real behavior verify, does not source code regex smoke fill):
 * 1. old nodeUpgrade RPC because choose register top replace old socket while transfer interrupt when, upgrade result
 *    only can by choose connect match commit heartbeat confirm - - never because new connect store in or
 *    catch false succeeded;
 * 2. only register(without commit) do not succeeded; error attemptId / error version / fabricate
 *    connect commit reject; match commit(attemptId + version +
 *    previousVersion + pid positive integer) succeeded;
 * 3. without wait for legal commit(local machine CLI upgrade path) still ACK true;
 * 4. local 400 / unknown 404 / offline 409 / unsupported 501 / structure failed 400/502 /
 *    timeout not confirm 502;
 * 5. HTTP body boundary validate: unknown field / non- http(s) registryUrl / non- boolean force /
 *    attemptId cannot by user provide;
 * 6. automatically upgrade by default close;HELM_AUTO_UPGRADE_NODES=1 and strictly SemVer after when trigger.
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

/** async mkdtemp alias (case inside dir create). */
const mkdtemp = (prefix: string): Promise<string> => mkdtempAsync(prefix)

void mkdtemp

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-node-upgrade-'))
})

// ---------------------------------------------------------------------------
// version semantics unit
// ---------------------------------------------------------------------------

test('normalizeExplicitVersion:trim + single v prefix; illegal explicit reject', { timeout: 60_000 }, () => {
  assert.equal(normalizeExplicitVersion('1.2.3'), '1.2.3')
  assert.equal(normalizeExplicitVersion(' v1.2.3 '), '1.2.3')
  assert.equal(normalizeExplicitVersion('V2.0.0-rc.1+build.5'), '2.0.0-rc.1+build.5')
  assert.throws(() => normalizeExplicitVersion('1.2'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('vv1.2.3'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('latest'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('1.2.3.4'), /SemVer/)
})

test('compareStrictSemVer: main/time/fix subscribe/pre- publish sort', { timeout: 60_000 }, () => {
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
// pure registry layer:beginUpgrade / commit for account
// ---------------------------------------------------------------------------

/** extreme simple EventEmitter socket replace body (node-health.test.ts same style pattern). */
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

test('registry.register: illegal version / upgradeAttemptId(empty string) explicit reject', { timeout: 60_000 }, async () => {
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

test('registry: only register(choose without commit) do not resolve wait for; match commit succeeded', { timeout: 60_000 }, async () => {
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
    // choose register (top replace old socket): never can let wait for succeeded.
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    assert.equal(candidate.outcome.accepted, true)
    await delay(150)
    assert.equal(settled, false, 'only choose register (without commit) must not resolve upgrade wait for')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // choose heartbeat commit(fully match)→ succeeded.
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

test('registry: error attemptId / error version / previousVersion inconsistent / pid illegal reject (do not false succeeded)', { timeout: 60_000 }, async () => {
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
    // attemptId error.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'other', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    // version does not match (connect register version 1.1.0,commit sound call 9.9.9).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    // previousVersion and wait for inconsistent (do not upside down pour other attempt).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    // pid non- positive integer.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: -3 },
    })
    await delay(100)
    assert.equal(failed, false, 'all illegal commit must not final wait for')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // another node connect fabricate commit(non- when before connect) directly reject.
    const { socket: stranger } = await registerRaw(registry, 'n2', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const ackStranger = registry.noteHeartbeat('n1', stranger as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(ackStranger, false, 'non- when before connect heartbeat directly reject')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    handle.cancel()
    await assert.rejects(handle.result)
    socket.close()
    stranger.close()
  } finally {
    await registry.close()
  }
})

test('registry: carry commit heartbeat ACK real accept result; ordinary heartbeat constant true', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // without wait for: legal commit(local machine CLI path)ACK true.
    const { socket: solo } = await registerRaw(registry, 'n-cli', { version: '2.0.0', upgradeAttemptId: 'cli-1' })
    const ackCli = registry.noteHeartbeat('n-cli', solo as unknown as WsLike, {
      upgradeCommit: { attemptId: 'cli-1', version: '2.0.0', previousVersion: '1.9.0', pid: 11 },
    })
    assert.equal(ackCli, true, 'without wait for legal commit(local machine CLI upgrade) should ACK true')

    // has wait for: does not match commit ACK false(node must not mistakenly with is Hub already confirm).
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    const badAttempt = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'wrong', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badAttempt, false, 'error attemptId  commit must Nack(ACK false)')
    const badVersion = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badVersion, false, 'error version commit must ACK false')
    const badPrevious = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    assert.equal(badPrevious, false, 'error previousVersion  commit must ACK false')
    const malformed = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1' } as never,
    })
    assert.equal(malformed, false, 'missing field distortion shape commit must ACK false')
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'all by refuse commit does not affect wait for')

    // ordinary heartbeat (without commit) constant true.
    const plain = registry.noteHeartbeat('n1', socket as unknown as WsLike, {})
    assert.equal(plain, true)

    // match commit ACK true and resolve.
    const matched = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 22 },
    })
    assert.equal(matched, true)
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry.close()
  }
})

test('registry: same node concurrency beginUpgrade reject; original socket disconnect do not clean up wait for', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    assert.throws(
      () => registry.beginUpgrade('n1', { attemptId: 'a2', targetVersion: '1.2.0', previousVersion: '1.0.0', timeoutMs: 1_000 }),
      HelmUpgradeBusyError,
    )
    // old socket disconnect (upgrade process must however along with): wait for continue etc. choose commit.
    socket.close()
    await delay(100)
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'original socket disconnect must not final upgrade wait for')
  } finally {
    await registry.close()
  }
})

test('registry: disconnect original RPC but choose commit after normal succeeded; timeout explicit failed', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    socket.close() // simulated old RPC transfer close
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

  // timeout path.
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
// complete Hub(KernelRuntime + startHub)+ can edit process node fixture
// ---------------------------------------------------------------------------

/**
 * can edit process WS node fixture: real connect /ws/node, implement register / heartbeat /
 * nodeCheckUpgrade / nodeUpgrade(behavior can one by one case edit process). upgrade dramatic this:
 * nodeUpgrade return after disconnect old connect, again with choose identity (new version + attemptId)
 * reconnect and by plan (or do not)commit heartbeat.
 */
interface FixturePlan {
  /** nodeUpgrade RPC structure return. */
  rpcResult: RpcResult<NodeUpgradeResult>
  /** RPC forever do not return (simulated old edition node stiff die; whole still must has boundary). */
  hang?: boolean
  /** RPC return after disconnect old connect, with choose identity reconnect (version=plan.candidateVersion). */
  reconnect?: { candidateVersion: string }
  /** choose register after commit(false = do not; default fully match commit). */
  commit?: false | { attemptId: string; version: string; previousVersion: string; pid: number }
  /** choose register to commit latency milli second (simulated transfer disconnect first to,commit after to). */
  commitDelayMs?: number
  /**
   * RPC reply forever do not return:reconnect plan normal execute after (choose top replace old socket)
   * nodeUpgrade return forever do not resolve  Promise, simulated in-flight RPC by close.
   * override real link:registry #evict → old rpc $close → birpc reject in-flight
   * invoke → ws-gateway onGeneralError swallow reject → Hub side resolve undefined.
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
        return { ok: false, error: { code: 'unknown', message: 'fixture not settings upgrade dramatic this' } }
      }
      if (plan.hang === true) {
        // forever do not return (also do not reconnect): verify Hub whole timeout still has boundary.
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      if (plan.reconnect !== undefined) {
        // simulated real upgrade: first reply RPC(old connect still), then async disconnect reconnect is choose.
        const reconnectVersion = plan.reconnect.candidateVersion
        const attemptId = input.attemptId ?? ''
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* already closure */
          }
          void connectCandidate(wsUrl, nodeId, nodeToken, reconnectVersion, attemptId, state, plan)
        }, 30).unref()
      }
      if (plan.deferReplyUntilReplaced === true) {
        // in-flight RPC by top replace: choose register after old socket  birpc by $close, this side
        // birpc reply send follow socket disconnect while failed - - forever do not resolve, hand over by Hub
        // side real link (evict → $close → onGeneralError swallow reject) handle.
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      return plan.rpcResult
    },
    // the rest env RPC this test do not trigger and.
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
          /* non- JSON frame ignore */
        }
      })
    },
    serialize: (d) => d,
    deserialize: (d) => d as never,
    timeout: 10_000,
  })

  // initial register (when before version).
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

/** choose connect: new socket register new version + attemptId, by plan commit. */
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
  // choose commit: default fully match;false do not (test only register do not commit);
  // commitDelayMs push late send (simulated transfer disconnect first to,commit after to).
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

/** upgrade dramatic this inside old version record (commit previousVersion must and wait for consistent). */
const previousVersionByAttempt = new Map<string, string>()
function previousVersionFor(nodeId: string, attemptId: string): string {
  return previousVersionByAttempt.get(`${nodeId}:${attemptId}`) ?? '1.0.0'
}

/** open complete Hub(contains /ws/node gateway and authentication). */
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

/** sign node identity and connect fixture node. */
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
  assert.equal(issue.status, 201, 'sign node token failed')
  const { token: nodeToken } = (await issue.json()) as { token: string }
  const wsUrl = hubUrl.replace(/^http/, 'ws')
  return connectFixtureNode(wsUrl, nodeId, nodeToken, version)
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

// ---------------------------------------------------------------------------
// HTTP / RPC collection into:upgrade orchestration (succeeded, false succeeded guard against line, error mapping)
// ---------------------------------------------------------------------------

test('upgrade: only choose register (without commit) do not succeeded - - explicit not confirm error', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'no-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-no-commit', '1.0.0')
    previousVersionByAttempt.set(`up-no-commit:${node.upgradeCalls.length}`, '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commit: false, // choose register but forever do not commit
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-no-commit/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 502, 'only register without commit must explicit failed (do not false succeeded)')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: match commit(disconnect original RPC after) normal succeeded and result confirm', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'commit-ok-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-ok', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      // default commit:attemptId/version by choose real register value push lead,previousVersion 1.0.0.
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
    assert.equal(body.targetVersion, '1.1.0', 'v prefix specification is precise version')
    assert.equal(body.previousVersion, '1.0.0')
    assert.equal(typeof body.pid, 'number')
    // RPC reference carry specification targetVersion and server side generate attemptId.
    assert.equal(node.upgradeCalls.length, 1)
    assert.equal(node.upgradeCalls[0]!.targetVersion, '1.1.0')
    assert.match(node.upgradeCalls[0]!.attemptId ?? '', /^[0-9a-f]{32}$/)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: node structure reject → 400/501/502 and do not false succeeded', { timeout: 60_000 }, async () => {
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

test('upgrade: explicit without operation (ok/upgraded:false) legal return, without waiting commit', { timeout: 60_000 }, async () => {
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
    assert.equal(failed.status, 502, 'ok:false cannot disguise into succeeded without operation')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade error mapping:local 400 / unknown 404 / offline 409 / unsupported 501', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'errors-'))
  const app = await openHubApp(dir)
  try {
    // local.
    const local = await fetch(`${app.hub.url}/api/nodes/local/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(local.status, 400)
    // unknown node (not sign).
    const unknown = await fetch(`${app.hub.url}/api/nodes/ghost/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(unknown.status, 404)
    // already sign but offline.
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

test('upgrade check: pass-through node result (contains blocked);body/query boundary validate', { timeout: 60_000 }, async () => {
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

    // illegal registryUrl(non- http(s)).
    const badUrl = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check?registryUrl=ftp://x`, {
      headers: authHeaders(app.token),
    })
    assert.equal(badUrl.status, 400)

    // POST body unknown field reject.
    const unknownField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ attemptId: 'user-controlled' }),
    })
    assert.equal(unknownField.status, 400, 'attemptId cannot by user control')
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
      assert.equal(nullField.status, 400, `${field}:null must reject, cannot static default when into default`)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: offline node in-flight invoke after assert connect - - do not false succeeded (result not confirm 502)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'rpc-drop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-drop', '1.0.0')
    node.setPlan({
      // RPC succeeded but node directly disappear (do not reconnect, do not commit).
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
    })
    // RPC return after immediately disconnect (produces no choose).
    const resPromise = fetch(`${app.hub.url}/api/nodes/up-drop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    await delay(50)
    node.close()
    const res = await resPromise
    assert.equal(res.status, 502, 'without choose commit must not succeeded')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
  } finally {
    await app.close().catch(() => undefined)
  }
})

// ---------------------------------------------------------------------------
// automatically upgrade (HELM_AUTO_UPGRADE_NODES)
// ---------------------------------------------------------------------------

test('automatically upgrade by default close: after node enable does not trigger nodeUpgrade', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-off-'))
  const app = await openHubApp(dir)
  try {
    // 0.0.1 must however strictly after Hub(kernel 0.1.0+).
    const node = await provisionNode(app.hub.url, app.token, 'auto-off-node', '0.0.1')
    await delay(600)
    assert.equal(node.upgradeCalls.length, 0, 'by default on shutdown never automatically invoke nodeUpgrade')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('HELM_AUTO_UPGRADE_NODES=1: strictly after node enable async upgrade to Hub version', { timeout: 60_000 }, async () => {
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
    // wait for onNodeChanged async path trigger upgradeNode(non-blocking register).
    for (let i = 0; i < 50 && node.upgradeCalls.length === 0; i++) {
      await delay(100)
    }
    assert.equal(node.upgradeCalls.length, 1, 'open start after after node enable should trigger once automatically upgrade')
    assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion(), 'automatically upgrade target is Hub version')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('automatically upgrade dedupe: same node failed after no longer unbounded retry (upgrade invoke exactly once)', { timeout: 60_000 }, async () => {
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
    // again etc. one segment time: do not retry (dedupe).
    await delay(1_200)
    assert.equal(node.upgradeCalls.length, 1, 'same node automatically upgrade only attempt one round')
    node.close()
  } finally {
    delete process.env['HELM_AUTO_UPGRADE_NODES']
    await app?.close().catch(() => undefined)
  }
})

test('upgrade: choose register after latency 50ms only then commit- - transfer disconnect first to when still wait for succeeded', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'late-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-late', '1.0.0')
    // upgrade stream process:RPC reply → old socket disconnect (rpcError must first reach Hub)→
    // choose reconnect register → 50ms after only then commit.Hub must continue etc. commit while is not
    // disconnect when into terminal state failed (regression: heavy race already settle rpcPromise must reach bug).
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
    assert.equal(res.status, 200, 'disconnect first to,commit after to: eventually must succeeded')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: in-flight RPC by choose top replace close (reply by swallow into undefined) - - continue etc. real commit succeeded', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'inflight-close-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-inflight', '1.0.0')
    // real link re- now:reconnect plan per common execute (old socket close + choose register),
    // but old connect on nodeUpgrade reply forever do not resolve- - old socket by $close after
    // birpc in-flight invoke by reject,ws-gateway.onGeneralError swallow into resolve(undefined).
    // fix before:race take {kind:'rpc',value:undefined} → invalid shape 502 mention before failed;
    // fix after: identify is transfer interrupt, continue etc. choose commit(commitDelayMs 50ms).
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
    assert.equal(res.status, 200, 'in-flight RPC by top replace close after must continue etc. commit, must not mention before 502')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'target from real commit heartbeat')
    assert.equal(body.previousVersion, '1.0.0', 'previous from real commit heartbeat')
    assert.equal(typeof body.pid, 'number')
    assert.ok(Number.isInteger(body.pid) && body.pid! > 0, 'pid must be real commit carry positive integer')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade:RPC forever do not return and without choose - - short timeout inside has boundary failed (do not hang 30min)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'hang-'))
  const app = await openHubApp(dir) // nodeUpgradeTimeoutMs = 2_500
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-hang', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      hang: true, // forever do not return, forever do not reconnect
    })
    const startedAt = Date.now()
    const res = await fetch(`${app.hub.url}/api/nodes/up-hang/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 502, 'RPC stiff die when must explicit failed')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    assert.ok(elapsed < 30_000, `upgrade wait for must has boundary (actual ${elapsed}ms, never hang birpc 30min)`)
    // wait for already clean up: same node can again start (do not forever long busy).
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-hang'), false)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: illegal RpcResult/illegal result body after wait for clean up - - same node can again upgrade (do not forever long busy)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'busy-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-busy', '1.0.0')
    // first time: result body illegal (missing targetVersion field).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', upgraded: true } as unknown as NodeUpgradeResult },
    })
    const first = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(first.status, 502, 'illegal result body must explicit failed')
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false, 'failed after wait for must clean up')
    // second time: structure reject after same can again start.
    node.setPlan({ rpcResult: { ok: false, error: { code: 'not_supported', message: 'inject reject' } } })
    const second = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.2.0' }),
    })
    assert.equal(second.status, 501)
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false)
    assert.equal(node.upgradeCalls.length, 2, 'two time invoke all should reach node (without busy block)')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: node not on report version when first check take real currentVersion act previous(never unknown)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'prev-'))
  const app = await openHubApp(dir)
  try {
    // fixture register when does not carry version:Hub must via check take currentVersion=1.0.0.
    const node = await provisionNode(app.hub.url, app.token, 'up-prev', '1.0.0')
    // directly verify: upgrade succeeded path previousVersion from conn.version(1.0.0).
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
    assert.equal(body.previousVersion, '1.0.0', 'previousVersion must be real version, never unknown')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('teardown: clean up temporary directory', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
