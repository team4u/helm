/**
 * Cross-platform compute node connection registry: Hub-side `/ws/node` WS+birpc connection pool.
 *
 * Security invariants (each backed by dedicated tests):
 * - **Fail-closed authentication**: rejects all registrations when no `authenticate` callback is supplied
 *   (default-deny, never default-allow);
 * - **Atomic publication**: a connection (with its birpc proxy) is registered and waiters are woken only
 *   after it is completely ready (auth passed + RPC bound)—waiters never observe partial objects or undefined;
 * - **Heartbeat/output bound to current connection**: `noteHeartbeat(nodeId, socket)` only refreshes the
 *   connection registered for that nodeId, and `onEnvExecOutput` only accepts events from the currently
 *   registered connection—unregistered connections cannot keep another node alive or inject fake output;
 * - **Output routed per node**: dispatches by `nodeId` to all env sinks registered for that node (concurrent
 *   conversations on the same node never cross-talk; cross-node events are dropped);
 * - **IPC subscriptions routed strictly by `(nodeId, subscribeId)`**: node `onIpcEvent` / `onIpcClosed`
 *   callbacks reach only the matching subscription and remove it on close;
 * - **Evict/TTL/close truly disconnect**: when a new connection supersedes the same `nodeId`, both the old
 *   socket and old RPC are closed; heartbeat timeouts and `registry.close()` close sockets too rather than
 *   only deleting Map entries (preventing half-open connections from emitting events);
 * - Sockets closing during auth never publish ghost connections;
 * - `disconnect(nodeId)`: immediately closes the active ws+rpc when API revokes identity.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { WebSocket as WsSocket } from 'ws'
import type { BirpcReturn } from 'birpc'
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeHealthSnapshot,
  NodeHeartbeatInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeRegisterInput,
  NodeTunnelHello,
  NodeTunnelTarget,
} from '@helmx/protocol'
import type { Context } from '@earendil-works/chord/context'
import { HelmxError } from '@helmx/protocol'
import { TunnelTable, tunnelRpcFailureOf, type PendingTunnel } from './tunnel-table.js'
import {
  UpgradeWaiterSet,
  HelmxUpgradeCancelledError,
  type UpgradeWaiterHandle,
} from './upgrade-waiters.js'

/* Upgrade waiters and error types moved to `upgrade-waiters.ts`; tunnel registry moved to `tunnel-table.ts`;
 * re-exported here to preserve existing env public exports (`env/index.ts`, `fabric.ts`). */
export {
  HelmxUpgradeBusyError,
  HelmxUpgradeTimeoutError,
  HelmxUpgradeCancelledError,
  type UpgradeWaiterHandle,
} from './upgrade-waiters.js'

/** Functions exposed by the node to Hub (full env RPC suite + connection control). */
export type NodeSideFunctions = NodeEnvRpcFunctions & {
  register(input: NodeRegisterInput): Promise<{ ok: boolean; heartbeatMs: number; reason?: string }>
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
}

/** Non-negative finite number check (NaN/Infinity/negative/non-number are all invalid). */
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Finite number check (allows negatives; loadAvg is theoretically non-negative but validated as finite). */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Boundary validation: filter node-reported health snapshots before storing in registry.
 * If any required field (`collectedAt` / `uptimeSec` / `loadAvg` / `memFreeBytes` / `memTotalBytes`) is invalid,
 * drop the whole snapshot (returns undefined without throwing, never trusting unvalidated fields);
 * invalid optional disk fields are simply omitted.
 */
export function sanitizeNodeHealth(raw: unknown): NodeHealthSnapshot | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (!isNonNegativeFinite(o['collectedAt'])) return undefined
  if (!isNonNegativeFinite(o['uptimeSec'])) return undefined
  const load = o['loadAvg']
  if (
    !Array.isArray(load) ||
    load.length !== 3 ||
    !load.every((v) => isFiniteNumber(v))
  ) {
    return undefined
  }
  if (!isNonNegativeFinite(o['memFreeBytes'])) return undefined
  if (!isNonNegativeFinite(o['memTotalBytes'])) return undefined
  const health: NodeHealthSnapshot = {
    collectedAt: o['collectedAt'],
    uptimeSec: o['uptimeSec'],
    loadAvg: [load[0]!, load[1]!, load[2]!],
    memFreeBytes: o['memFreeBytes'],
    memTotalBytes: o['memTotalBytes'],
  }
  if (isNonNegativeFinite(o['diskFreeBytes'])) health.diskFreeBytes = o['diskFreeBytes']
  if (isNonNegativeFinite(o['diskTotalBytes'])) health.diskTotalBytes = o['diskTotalBytes']
  return health
}

export interface NodeConnection {
  nodeId: string
  /** Proxy for invoking node-side functions (env RPC + register/heartbeat). */
  rpc: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
  socket: WsSocket
  connectedAt: number
  lastSeenAt: number
  hostname: string
  platform: string
  /** Software version reported by the node (omitted if invalid or unprovided). */
  version?: string
  /** Upgrade attempt ID carried by the candidate (heartbeat commit reconciles against it). */
  upgradeAttemptId?: string
  /** Hub URL configured on the node (for remote managed child processes connecting back). */
  hubUrl?: string
  /** Most recent health snapshot from registration or heartbeat (trusted after boundary validation). */
  health?: NodeHealthSnapshot
}

/** Hub-side local functions (one instance per connection, bound to that connection's registered identity). */
export interface HubConnectionLocal {
  onEnvExecOutput(event: EnvExecOutputEvent): void
  onIpcEvent(event: NodeIpcEvent): void
  onIpcClosed(event: NodeIpcClosedEvent): void
}

export interface RegisterOutcome {
  accepted: boolean
  reason?: string
  /** Expected heartbeat interval (ms). */
  heartbeatMs?: number
}

export interface NodeRegistryOptions {
  /** Heartbeat timeout (ms) before marking offline; defaults to 45s. */
  heartbeatTimeoutMs?: number
  /** Heartbeat interval returned to nodes on registration; defaults to 15s. */
  heartbeatIntervalMs?: number
  /**
   * Node token validator (e.g. comparing `sha256(wholeToken)`; provided by external token store).
   * **Defaults to rejecting all registrations (fail-closed)**.
   */
  authenticate: (nodeId: string, token: string) => boolean | Promise<boolean>
}

interface Waiter {
  nodeId: string
  resolve: (rpc: NodeEnvRpcFunctions | undefined) => void
  cancelled: () => void
}

/* Tunnel table (`PendingTunnel`/`ActiveTunnel`) and upgrade waiters (`UpgradeWaiter`,
 * `UpgradeWaiterHandle`) live in `tunnel-table.ts` / `upgrade-waiters.ts`. */

/** IPC subscription callback pair. */
interface IpcSink {
  onEvent: (line: string) => void
  onClosed: (error?: string) => void
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Validate tunnel target at boundary: port must be 1..65535 safe integer; host (if present) must be non-empty, <=255 chars, without control chars or whitespace (invalid fails with HelmxError `validation_error`, never silently mutated). */
export function normalizeTunnelTarget(target: NodeTunnelTarget): { host: string | undefined; port: number } {
  if (target === null || typeof target !== 'object') {
    throw new HelmxError('validation_error', 'tunnel target must be a { host?, port } object', 400)
  }
  const { host, port } = target as Partial<NodeTunnelTarget>
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new HelmxError('validation_error', 'tunnel target port must be an integer between 1 and 65535', 400, { port })
  }
  if (host === undefined) return { host: undefined, port }
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 255 ||
    host.trim() !== host ||
    // Reject control chars and any whitespace (including internal spaces/tabs): hostnames forbid whitespace.
    /\s/.test(host) ||
    // Reject all control characters (including NUL).
    [...host].some((ch) => {
      const code = ch.charCodeAt(0)
      return code < 0x20 || code === 0x7f
    })
  ) {
    throw new HelmxError('validation_error', 'tunnel target host must be a non-empty string without whitespace or control characters (<= 255 characters)', 400, { host })
  }
  return { host, port }
}

/** Timing-safe token validator callback (token store persists `sha256(wholeToken)` in hex). */
export function tokenAuthenticator(
  sha256HexOf: (nodeId: string) => string | undefined,
): (nodeId: string, token: string) => boolean {
  return (nodeId, token) => {
    const expected = sha256HexOf(nodeId)
    if (expected === undefined) return false
    return safeEqual(sha256hex(token), expected)
  }
}

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class NodeRegistry {
  readonly #connections = new Map<string, NodeConnection>()
  readonly #waiters = new Set<Waiter>()
  readonly #heartbeatIntervalMs: number
  readonly #heartbeatTimeoutMs: number
  readonly #authenticate: (nodeId: string, token: string) => boolean | Promise<boolean>
  readonly #nodeChangedListeners = new Set<(nodeId: string, online: boolean) => void>()
  /** Output sink list per node (multiple env instances on the same node). */
  readonly #outputSinks = new Map<string, Set<(event: EnvExecOutputEvent) => void>>()
  /** IPC subscription routing: `nodeId -> subscribeId -> sink`. */
  readonly #ipcSinks = new Map<string, Map<string, IpcSink>>()
  /** Node revocation epoch: incremented on every evict/disconnect/replace; checked after async auth wakes up. */
  readonly #nodeEpoch = new Map<string, number>()
  /** Passthrough tunnel table (pending/active maps and bulk finalization; see `tunnel-table.ts`). */
  readonly #tunnels = new TunnelTable()
  /** Upgrade waiter set (registration/commit settlement/shutdown cleanup; see `upgrade-waiters.ts`). */
  readonly #upgrades = new UpgradeWaiterSet()
  #sweeper: NodeJS.Timeout | undefined
  #closed = false

  constructor(options: NodeRegistryOptions) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000
    // Fail-closed: reject everything if no auth callback is provided.
    this.#authenticate = options.authenticate ?? (() => false)
  }

  get heartbeatIntervalMs(): number {
    return this.#heartbeatIntervalMs
  }

  list(): NodeConnection[] {
    return [...this.#connections.values()].map((c) => ({ ...c }))
  }

  get(nodeId: string): NodeConnection | undefined {
    const conn = this.#connections.get(nodeId)
    return conn === undefined ? undefined : { ...conn }
  }

  /** Node online/offline change callback (used by `KernelRuntime` to publish `node.changed` SSE events). */
  onNodeChanged(listener: (nodeId: string, online: boolean) => void): () => void {
    this.#nodeChangedListeners.add(listener)
    return () => {
      this.#nodeChangedListeners.delete(listener)
    }
  }

  /** Register an output sink for a node (called by fabric per env instance). */
  addOutputSink(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void {
    let set = this.#outputSinks.get(nodeId)
    if (set === undefined) {
      set = new Set()
      this.#outputSinks.set(nodeId, set)
    }
    set.add(sink)
  }

  removeOutputSink(nodeId: string, sink: (event: EnvExecOutputEvent) => void): void {
    this.#outputSinks.get(nodeId)?.delete(sink)
  }

  /** Register an IPC subscription sink (routed strictly by `nodeId + subscribeId`). */
  addIpcSink(nodeId: string, subscribeId: string, sink: IpcSink): void {
    let map = this.#ipcSinks.get(nodeId)
    if (map === undefined) {
      map = new Map()
      this.#ipcSinks.set(nodeId, map)
    }
    map.set(subscribeId, sink)
  }

  removeIpcSink(nodeId: string, subscribeId: string): void {
    this.#ipcSinks.get(nodeId)?.delete(subscribeId)
  }

  #dispatchIpcEvent(nodeId: string, event: NodeIpcEvent): void {
    this.#ipcSinks.get(nodeId)?.get(event.subscribeId)?.onEvent(event.line)
  }

  #dispatchIpcClosed(nodeId: string, event: NodeIpcClosedEvent): void {
    const map = this.#ipcSinks.get(nodeId)
    if (map === undefined) return
    const sink = map.get(event.subscribeId)
    if (sink === undefined) return
    map.delete(event.subscribeId)
    sink.onClosed(event.error)
  }

  /**
   * WS node connection registration entrypoint (invoked at the connection layer by `ws-gateway`;
   * gateway creates the birpc proxy and passes `attach`, binding Hub-side local callbacks for
   * output/heartbeat/IPC events strictly to this connection). Publishes **atomically** once auth
   * passes and the proxy is bound.
   */
  async register(
    socket: WsSocket,
    input: NodeRegisterInput,
    attach: (local: HubConnectionLocal) => BirpcReturn<NodeSideFunctions, HubConnectionLocal>,
  ): Promise<RegisterOutcome> {
    if (this.#closed) return { accepted: false, reason: 'registry closed' }
    const { nodeId, token, hostname, platform, hubUrl, version, upgradeAttemptId } = input ?? ({} as NodeRegisterInput)
    if (typeof nodeId !== 'string' || nodeId === 'local' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      return { accepted: false, reason: 'invalid nodeId' }
    }
    if (typeof token !== 'string' || token.length === 0) return { accepted: false, reason: 'missing token' }
    // Boundary validation: when present, `version` / `upgradeAttemptId` must be non-empty strings;
    // reject invalid types or empty strings explicitly (never silently drop, which would break upgrade reconciliation).
    if (version !== undefined && (typeof version !== 'string' || version === '')) {
      return { accepted: false, reason: 'invalid version' }
    }
    if (upgradeAttemptId !== undefined && (typeof upgradeAttemptId !== 'string' || upgradeAttemptId === '')) {
      return { accepted: false, reason: 'invalid upgradeAttemptId' }
    }
    // Snapshot revocation epoch: any removeNode/token rotation/replacement during async auth increments it,
    // preventing late `resolve(true)` from publishing an invalidated connection online.
    const epochAtStart = this.#epochOf(nodeId)
    let valid = false
    try {
      valid = await this.#authenticate(nodeId, token)
    } catch {
      valid = false
    }
    if (!valid) return { accepted: false, reason: 'invalid token' }
    // Socket may have closed during auth: never publish a ghost connection.
    if (socket.readyState !== socket.OPEN) return { accepted: false, reason: 'connection closed during auth' }
    if (this.#closed) return { accepted: false, reason: 'registry closed' }
    // Revocation invariant: if eviction/disconnect occurred while auth was in flight (`removeNode`, token
    // rotation, or replacement by a newer connection), this registration is stale—refuse to publish.
    if (this.#epochOf(nodeId) !== epochAtStart) {
      return { accepted: false, reason: 'register superseded by revoke/replace' }
    }

    // Build proxy: bind local callbacks to this connection and epoch (discard events before publication or after eviction).
    let publishEpoch = epochAtStart
    let published = false
    const isLive = (): boolean =>
      published && this.#epochOf(nodeId) === publishEpoch && this.#connections.get(nodeId)?.rpc === rpc
    let rpc!: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
    rpc = attach({
      onEnvExecOutput: (event) => {
        if (!isLive()) return // late output after revocation/replacement must not pollute the new generation
        this.#dispatchOutput(nodeId, event)
      },
      onIpcEvent: (event) => {
        if (!isLive()) return
        this.#dispatchIpcEvent(nodeId, event)
      },
      onIpcClosed: (event) => {
        if (!isLive()) return
        this.#dispatchIpcClosed(nodeId, event)
      },
    })

    // Evict previous connection: actually close old socket + rpc (not just Map delete) and bump epoch
    // (subsequent late events from the old proxy are dropped).
    const prev = this.#connections.get(nodeId)
    if (prev !== undefined) this.#evict(nodeId, prev, 'replaced')
    publishEpoch = this.#epochOf(nodeId)

    const health = sanitizeNodeHealth(input?.health)
    const conn: NodeConnection = {
      nodeId,
      rpc,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      hostname: typeof hostname === 'string' ? hostname : '',
      platform: typeof platform === 'string' ? platform : '',
      ...(version !== undefined ? { version } : {}),
      ...(upgradeAttemptId !== undefined ? { upgradeAttemptId } : {}),
      ...(typeof hubUrl === 'string' && hubUrl !== '' ? { hubUrl } : {}),
      ...(health !== undefined ? { health } : {}),
    }
    this.#connections.set(nodeId, conn)
    published = true

    const gone = (): void => this.#evict(nodeId, conn, socket.readyState === socket.CLOSED ? 'closed' : 'error')
    socket.once('close', gone)
    socket.once('error', gone)

    this.#wakeWaiters(nodeId) // wake waiters only after fully published
    this.#notifyNodeChanged(nodeId, true)
    this.#ensureSweeper()
    return { accepted: true, heartbeatMs: this.#heartbeatIntervalMs }
  }

  /**
   * Create an upgrade waiter: resolves only on a matching heartbeat `upgradeCommit`;
   * rejects on timeout, `cancel()`, or `registry.close()` (disconnecting the old socket never settles the
   * waiter because upgrades restart and replace the old connection with the candidate). Concurrent upgrade
   * waiters on the same node reject explicitly. `register` does not resolve the waiter—the candidate's
   * registration only carries `attemptId`, and real confirmation comes only from its commit heartbeat.
   */
  beginUpgrade(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#closed) throw new Error('registry closed')
    return this.#upgrades.begin(nodeId, params)
  }

  /** Test-only helper: whether the node has an in-flight upgrade waiter. */
  hasUpgradeWaiter(nodeId: string): boolean {
    return this.#upgrades.has(nodeId)
  }

  // --- Node passthrough tunnels ---------------------------------------------------------

  /** Token authentication delegate for the dedicated tunnel gateway: reuses registry auth (`tokenAuthenticator` / fail-closed). */
  async authenticateToken(nodeId: string, token: string): Promise<boolean> {
    if (this.#closed) return false
    try {
      return await this.#authenticate(nodeId, token)
    } catch {
      return false
    }
  }

  /** Test-only helper: counts of pending and active tunnels. */
  debugTunnelCounts(): { pending: number; active: number } {
    return this.#tunnels.counts()
  }

  /**
   * Open a byte-stream pipe to `host:port` on a remote node (arbitrary TCP; `host` defaults to `127.0.0.1`,
   * resolved and connected on the node): calls `nodeTunnelOpen` on the current connection and **immediately**
   * awaits the dedicated gateway first-frame handshake (`acceptTunnel`), settling the RPC in the background
   * so slow/closing RPCs don't stall timeouts or aborts. Failure semantics (all HelmxError, never falls back to local):
   * - node offline / registry closed: `node_offline` (409);
   * - node does not implement `nodeTunnelOpen`: `node_tunnel_not_supported` (501);
   * - gateway callback timeout (default 10s): `node_tunnel_timeout` (504);
   * - node draining for upgrade: `node_draining` (503, online but yielding to upgrade; distinct from `node_offline` and `aborted`);
   * - RPC explicit failure / closed connection: `node_tunnel_connect_failed` (502); abort: 499.
   * Any failure/cancel path makes a best-effort `nodeTunnelAbort` notification (swallowing errors without
   * blocking rejection on network replies) and cleans up pending/active entries synchronously without leaking.
   */
  async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
    const { host, port } = normalizeTunnelTarget(target)
    if (this.#closed) {
      throw new HelmxError('node_offline', `node ${nodeId} is offline; cannot establish tunnel`, 409, { nodeId })
    }
    const conn = this.#connections.get(nodeId)
    if (conn === undefined) {
      throw new HelmxError('node_offline', `node ${nodeId} is offline; cannot establish tunnel`, 409, { nodeId })
    }
    const open = conn.rpc.nodeTunnelOpen
    if (open === undefined) {
      throw new HelmxError('node_tunnel_not_supported', `node ${nodeId} daemon does not support passthrough tunnels`, 501, { nodeId })
    }
    const tunnelId = randomUUID()
    const epoch = this.#epochOf(nodeId)
    const timeoutMs = 10_000

    /** Best-effort notification to node to cancel pending connect (fault-tolerant so broken sockets/unsupported daemons don't block local cleanup). */
    const abortNode = (): void => {
      conn.rpc.nodeTunnelAbort?.(tunnelId).catch(() => undefined)
    }

    const pending: PendingTunnel = {
      tunnelId,
      nodeId,
      epoch,
      timeoutMs,
      timer: undefined as unknown as NodeJS.Timeout,
      grant: undefined as unknown as (duplex: Duplex) => void,
      reject: undefined as unknown as (error: HelmxError) => void,
      settled: false,
    }
    const pendingPromise = new Promise<Duplex>((resolve, reject) => {
      let granted: Duplex | undefined
      const settle = (): void => {
        const duplex = granted
        if (pending.settled || duplex === undefined) return
        pending.settled = true
        clearTimeout(pending.timer)
        // Remove pending, register active, and hook close cleanup (see `tunnel-table.ts`).
        this.#tunnels.activate(tunnelId, nodeId, duplex)
        resolve(duplex)
      }
      // Gateway calls `grantTunnel` after auth passes, handing over the ready Duplex and settling pending.
      pending.grant = (duplex) => {
        if (pending.settled) { duplex.destroy(); return }
        granted = duplex
        settle()
      }
      pending.reject = (error) => {
        if (pending.settled) return
        pending.settled = true
        clearTimeout(pending.timer)
        this.#tunnels.dropPending(tunnelId)
        reject(error)
      }
    })
    // Prevent unhandledRejection when a synchronous rejection fires before caller awaits.
    pendingPromise.catch(() => undefined)
    pending.timer = setTimeout(() => {
      abortNode()
      pending.reject(new HelmxError(
        'node_tunnel_timeout',
        `node ${nodeId} tunnel ${tunnelId} did not connect back within ${timeoutMs}ms`,
        504,
        { nodeId, tunnelId },
      ))
    }, timeoutMs)
    pending.timer.unref?.()
    this.#tunnels.addPending(pending)

    const onAbort = (): void => {
      abortNode()
      pending.reject(new HelmxError('aborted', 'tunnel establishment cancelled', 499, { nodeId, tunnelId }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // Reconcile RPC result in the background without blocking (`slow`/`closed` RPCs won't stall timeout/abort);
    // only failures prior to settlement reject early, with rejections observed to prevent unhandled errors.
    void open({ tunnelId, ...(host === undefined ? {} : { host }), port }).then(
      (result) => {
        if (pending.settled) return
        if (result.ok) return
        const { code, status } = tunnelRpcFailureOf(result.error.code)
        abortNode()
        pending.reject(new HelmxError(
          code,
          `node ${nodeId} failed to establish tunnel: ${result.error.message}`,
          status,
          { nodeId, tunnelId, port },
        ))
      },
      (error: unknown) => {
        if (pending.settled) return
        abortNode()
        pending.reject(new HelmxError(
          'node_tunnel_connect_failed',
          `node ${nodeId} tunnel RPC failed: ${error instanceof Error ? error.message : String(error)}`,
          502,
          { nodeId, tunnelId, port },
        ))
      },
    )

    try {
      return await pendingPromise
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Dedicated gateway first-frame check (pure auth/matching; framing stays inside the gateway):
   * returns true only when auth, single-use pending match, and epoch recheck all pass, letting the gateway
   * emit `{ type: 'ok' }` and hand over the Duplex (`grantTunnel`); on any mismatch returns false (gateway
   * sends error frame, closes, and destroys the stream without leaking).
   */
  async acceptTunnel(
    nodeId: string,
    token: string,
    tunnelId: string,
  ): Promise<boolean> {
    const pending = this.#tunnels.getPending(tunnelId)
    if (pending === undefined || pending.settled) return false
    if (pending.nodeId !== nodeId) return false
    if (pending.epoch !== this.#epochOf(nodeId)) return false
    if (!(await this.authenticateToken(nodeId, token))) return false
    if (pending.settled || this.#tunnels.getPending(tunnelId) !== pending) return false
    return true
  }

  /** Gateway Duplex handoff after `acceptTunnel` returned true; destroys incoming stream without leaking if pending already failed to settle. */
  grantTunnel(tunnelId: string, duplex: Duplex): void {
    this.#tunnels.grant(tunnelId, duplex)
  }

  /**
   * Heartbeat handler: refreshes only when `nodeId` matches the sending socket's registered identity;
   * updates `conn.health` when a valid health snapshot is attached (invalid snapshots are ignored without
   * blocking `lastSeenAt` refresh; birpc serializes trailing undefined as null, treated identically to omitted);
   * when `upgradeCommit` is present, ACK reflects real commit acceptance (invalid/mismatched -> false);
   * normal heartbeats (without commit) always return true.
   */
  noteHeartbeat(nodeId: string, fromSocket: WsSocket, input?: NodeHeartbeatInput): boolean {
    const conn = this.#connections.get(nodeId)
    if (conn === undefined || conn.socket !== fromSocket) return false
    conn.lastSeenAt = Date.now()
    if (input !== undefined && input !== null) {
      const health = sanitizeNodeHealth(input.health)
      if (health !== undefined) conn.health = health
      if (input.upgradeCommit !== undefined && input.upgradeCommit !== null) {
        return this.#upgrades.applyCommit(nodeId, conn, input.upgradeCommit)
      }
    }
    return true
  }

  /**
   * Immediately disconnect the specified node (called when API deletes/revokes credentials). Idempotent.
   *
   * Revocation invariant: even if no published connection exists yet, still increment the revocation epoch so any
   * in-flight registration (`await authenticate`) is rejected when it resumes, never bringing a revoked connection online.
   */
  disconnect(nodeId: string): void {
    const conn = this.#connections.get(nodeId)
    if (conn !== undefined) {
      this.#evict(nodeId, conn, 'revoked')
      return
    }
    // No published connection yet: still bump epoch to invalidate in-flight registrations.
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
  }

  #dispatchOutput(nodeId: string, event: EnvExecOutputEvent): void {
    const sinks = this.#outputSinks.get(nodeId)
    if (sinks === undefined) return
    for (const sink of sinks) {
      try {
        sink(event)
      } catch {
        // One sink's error must not affect other sinks.
      }
    }
  }

  /** Current revocation epoch (starts at 0; incremented on evict/disconnect/replace). */
  #epochOf(nodeId: string): number {
    return this.#nodeEpoch.get(nodeId) ?? 0
  }

  #notifyNodeChanged(nodeId: string, online: boolean): void {
    for (const listener of [...this.#nodeChangedListeners]) {
      try {
        listener(nodeId, online)
      } catch {
        // Listener errors must not break the registry.
      }
    }
  }

  #evict(nodeId: string, conn: NodeConnection, reason: string): void {
    if (this.#connections.get(nodeId) !== conn) return
    this.#connections.delete(nodeId)
    // Do NOT clear upgrade waiters on disconnect: upgrades naturally close the old socket when the candidate
    // replaces it, and only the candidate's commit heartbeat confirms success. Waiters settle only via
    // cancel / timeout / registry.close / matching commit—never prematurely on disconnect.
    // Increment revocation epoch so in-flight registrations and late events from this proxy are invalidated.
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
    try {
      conn.rpc.$close()
    } catch {
      // already closed.
    }
    if (conn.socket.readyState === conn.socket.OPEN || conn.socket.readyState === conn.socket.CONNECTING) {
      try {
        conn.socket.close(1000, reason)
      } catch {
        // ignore.
      }
    }
    // Terminate all IPC subscriptions for this node on disconnect (event source is gone).
    const ipcMap = this.#ipcSinks.get(nodeId)
    if (ipcMap !== undefined) {
      const sinks = [...ipcMap.values()]
      ipcMap.clear()
      for (const sink of sinks) {
        try {
          sink.onClosed(`node ${nodeId} disconnected`)
        } catch {
          // Subscriber callback error must not affect other subscriptions.
        }
      }
    }
    // Reject all pending tunnels and destroy all active tunnel duplexes for this node on disconnect:
    // tunnel lifetime is tied to this connection's generation (epoch), so replacement invalidates it without leaks.
    this.#tunnels.finalize((owner) => owner === nodeId, {
      pending: (owner, tunnelId) => new HelmxError(
        'node_offline',
        `node ${owner} disconnected; tunnel ${tunnelId} establishment aborted`,
        409,
        { nodeId: owner, tunnelId },
      ),
      active: (owner, tunnelId) => new HelmxError(
        'node_offline',
        `node ${owner} disconnected; tunnel ${tunnelId} closed`,
        409,
        { nodeId: owner, tunnelId },
      ),
    })
    this.#notifyNodeChanged(nodeId, false)
    this.#wakeWaiters(nodeId)
  }

  #wakeWaiters(nodeId: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.nodeId !== nodeId) continue
      this.#waiters.delete(waiter)
      const conn = this.#connections.get(nodeId)
      waiter.resolve(conn !== undefined ? conn.rpc : undefined)
    }
  }

  /** Wait for a node to come back online; returns `undefined` if `context` is cancelled. */
  async waitForNodeOnline(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions | undefined> {
    if (this.#closed || context.abortSignal?.aborted) return undefined
    const existing = this.#connections.get(nodeId)
    if (existing !== undefined) return existing.rpc
    const waiter: Waiter = {
      nodeId,
      resolve: () => undefined,
      cancelled: () => undefined,
    }
    const promise = new Promise<NodeEnvRpcFunctions | undefined>((resolve) => {
      waiter.resolve = resolve
    })
    const cancelPromise = new Promise<undefined>((resolve) => {
      waiter.cancelled = () => resolve(undefined)
    })
    const signal = context.abortSignal
    const onAbort = () => waiter.cancelled()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.#waiters.add(waiter)
    try {
      return await Promise.race([promise, cancelPromise])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.#waiters.delete(waiter)
    }
  }

  /** Exposes RPC lookup for fabric's `NodeRpcResolver`. */
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined {
    return this.#connections.get(nodeId)?.rpc
  }

  #ensureSweeper(): void {
    if (this.#sweeper !== undefined || this.#closed) return
    this.#sweeper = setInterval(() => {
      const now = Date.now()
      for (const [nodeId, conn] of [...this.#connections]) {
        if (now - conn.lastSeenAt > this.#heartbeatTimeoutMs) {
          this.#evict(nodeId, conn, 'heartbeat timeout')
        }
      }
    }, Math.min(10_000, this.#heartbeatTimeoutMs))
    this.#sweeper.unref()
  }

  /** Close the registry: disconnect all connections (closing sockets + RPCs), wake waiters, and clear sinks. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    // Settle all tunnels (reject pending; unregister active and destroy duplexes so consumers see disconnect).
    this.#tunnels.finalize(() => true, {
      pending: (_nodeId, tunnelId) => new HelmxError(
        'node_offline',
        `registry closed; tunnel ${tunnelId} establishment aborted`,
        409,
        { tunnelId },
      ),
      active: (_nodeId, tunnelId) => new HelmxError(
        'node_offline',
        `registry closed; tunnel ${tunnelId} closed`,
        409,
        { tunnelId },
      ),
    })
    this.#upgrades.rejectAll(new HelmxUpgradeCancelledError('registry closed'))
    for (const [nodeId, conn] of [...this.#connections]) {
      this.#evict(nodeId, conn, 'registry closed')
    }
    this.#connections.clear()
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter)
      waiter.resolve(undefined)
    }
    this.#outputSinks.clear()
    this.#ipcSinks.clear()
    this.#nodeEpoch.clear()
    this.#nodeChangedListeners.clear()
  }
}

export type { NodeRegisterInput }
export type { NodeHealthSnapshot, NodeHeartbeatInput } from '@helmx/protocol'
