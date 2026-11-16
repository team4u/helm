/**
 * across platform compute node connect register table:Hub side /ws/node  WS+birpc connection pool.
 *
 * security semantics (each all has real test):
 * - **fail-closed authentication**: not provide authenticate call back when reject everything register (default
 *   reject, never default let through);
 * - **atomic publish**: connect object (contains birpc proxy) fully ready (authentication via + rpc bind set)
 *   after only then register and wake wait for - - wait for never will gets half into product/undefined;
 * - **heartbeat/output bind set when before connect**:noteHeartbeat(nodeId, socket) only refresh the
 *   connect register nodeId;onEnvExecOutput only accept registered connect event - - not registered
 *   connect cannot keep-alive other person node, also cannot fabricate/inject other node output;
 * - **output by node routing**:dispatch by nodeId find the node all env instance sink
 *   (same node many conversation concurrency env mutual do not string disturb, across node event directly discard);
 * - **IPC subscribe by (nodeId, subscribeId) precise routing**: node call back onIpcEvent /
 *   onIpcClosed only dispatch to for should subscribe, subscribe close i.e. excerpt except;
 * - **replace/TTL/close all truly disconnect**: same nodeId new connect top old on connect close old
 *   socket + $close old rpc; heartbeat timeout and registry.close() same close socket,
 *   do not only delete Map(guard against half open connect continue event);
 * - authentication during socket already close → do not publish ghost connect;
 * - disconnect(nodeId):API delete identity when immediately disconnect when before ws+rpc.
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
} from '@helm/protocol'
import type { Context } from '@earendil-works/chord/context'
import { HelmError } from '@helm/protocol'
import { TunnelTable, tunnelRpcFailureOf, type PendingTunnel } from './tunnel-table.js'
import {
  UpgradeWaiterSet,
  HelmUpgradeCancelledError,
  type UpgradeWaiterHandle,
} from './upgrade-waiters.js'

/* upgrade wait for and error type already split until upgrade-waiters.ts, tunnel register already split until tunnel-table.ts;
 * via this module again export keep env package public exports (env/index.ts,fabric.ts) do not change. */
export {
  HelmUpgradeBusyError,
  HelmUpgradeTimeoutError,
  HelmUpgradeCancelledError,
  type UpgradeWaiterHandle,
} from './upgrade-waiters.js'

/** node side supply Hub invoke function collection (env RPC all collection + connect control). */
export type NodeSideFunctions = NodeEnvRpcFunctions & {
  register(input: NodeRegisterInput): Promise<{ ok: boolean; heartbeatMs: number; reason?: string }>
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
}

/** non- negative finite count value validate (NaN/Infinity/negative number/non- count value one rule illegal). */
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** finite count value validate (allows negative value,loadAvg argument non- negative but by finite count contract validate). */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * boundary validate: external node on report health snapshot in enter register table before filter.
 * required field (collectedAt / uptimeSec / loadAvg / memFreeBytes / memTotalBytes)
 * any one illegal i.e. whole discard (return undefined, do not throw exception, do not trust not validate dirty field);
 * optional disk field illegal when only ignore the field.
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
  /** invoke node side function proxy (env RPC + register/heartbeat). */
  rpc: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
  socket: WsSocket
  connectedAt: number
  lastSeenAt: number
  hostname: string
  platform: string
  /** node on report software version (illegal/not provide when do not save). */
  version?: string
  /** upgrade choose carry attempt ID(heartbeat commit by it for account). */
  upgradeAttemptId?: string
  /** node end config Hub address (remote managed child process back connect use). */
  hubUrl?: string
  /** most near once register or heartbeat incidentally health snapshot (boundary validate after can message data). */
  health?: NodeHealthSnapshot
}

/** Hub side local function (each connect a, bind set the connect register identity). */
export interface HubConnectionLocal {
  onEnvExecOutput(event: EnvExecOutputEvent): void
  onIpcEvent(event: NodeIpcEvent): void
  onIpcClosed(event: NodeIpcClosedEvent): void
}

export interface RegisterOutcome {
  accepted: boolean
  reason?: string
  /** expectation heartbeat interval (milli second). */
  heartbeatMs?: number
}

export interface NodeRegistryOptions {
  /** heartbeat timeout (milli second) judge offline; default 45s. */
  heartbeatTimeoutMs?: number
  /** register reply to node heartbeat interval; default 15s. */
  heartbeatIntervalMs?: number
  /**
   * node token validate (sha256(wholeToken) than for etc.; by external sign table provide).
   * **default reject everything register (fail-closed)**.
   */
  authenticate: (nodeId: string, token: string) => boolean | Promise<boolean>
}

interface Waiter {
  nodeId: string
  resolve: (rpc: NodeEnvRpcFunctions | undefined) => void
  cancelled: () => void
}

/* tunnel register (PendingTunnel/ActiveTunnel) and upgrade wait for (UpgradeWaiter,
 * UpgradeWaiterHandle) type and implement respectively split until tunnel-table.ts / upgrade-waiters.ts. */

/** IPC subscribe call back collection. */
export interface IpcSink {
  onEvent: (line: string) => void
  onClosed: (error?: string) => void
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** tunnel target boundary validate:port 1..65535 security integer;host non-empty,≤255 character, without control character/first tail whitespace (illegal i.e. HelmError validation_error, not silently change write). */
export function normalizeTunnelTarget(target: NodeTunnelTarget): { host: string | undefined; port: number } {
  if (target === null || typeof target !== 'object') {
    throw new HelmError('validation_error', 'tunnel target must be { host?, port } object', 400)
  }
  const { host, port } = target as Partial<NodeTunnelTarget>
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new HelmError('validation_error', 'tunnel target port must be 1..65535 security integer', 400, { port })
  }
  if (host === undefined) return { host: undefined, port }
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 255 ||
    host.trim() !== host ||
    // control character and any whitespace (contains internal space/Tab) one rule reject: host name disallows whitespace.
    /\s/.test(host) ||
    // control character (contains NUL) one rule reject.
    [...host].some((ch) => {
      const code = ch.charCodeAt(0)
      return code < 0x20 || code === 0x7f
    })
  ) {
    throw new HelmError('validation_error', 'tunnel target host must be non-empty, without whitespace/control character string (≤255 character)', 400, { host })
  }
  return { host, port }
}

/** timing-safe token validate call back (sign table store sha256(wholeToken) ten six enter system). */
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
  /** each node output sink list (same node many env instance). */
  readonly #outputSinks = new Map<string, Set<(event: EnvExecOutputEvent) => void>>()
  /** IPC subscribe routing:nodeId -> subscribeId -> sink. */
  readonly #ipcSinks = new Map<string, Map<string, IpcSink>>()
  /** node undo epoch: each time evict/disconnect/replace pass increase; in-flight register wake after must validate. */
  readonly #nodeEpoch = new Map<string, number>()
  /** pass-through tunnel register table (pending/active two spread table and batch amount final; see tunnel-table.ts). */
  readonly #tunnels = new TunnelTable()
  /** upgrade wait for set (register/commit compute/closure stop clean up; see upgrade-waiters.ts). */
  readonly #upgrades = new UpgradeWaiterSet()
  #sweeper: NodeJS.Timeout | undefined
  #closed = false

  constructor(options: NodeRegistryOptions) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000
    // fail-closed: without authentication call back → one rule reject.
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

  /** node on take offline call back (KernelRuntime based on this publish node.changed SSE event). */
  onNodeChanged(listener: (nodeId: string, online: boolean) => void): () => void {
    this.#nodeChangedListeners.add(listener)
    return () => {
      this.#nodeChangedListeners.delete(listener)
    }
  }

  /** register output sink(by node;fabric is the node each env instance register). */
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

  /** register IPC subscribe call back (nodeId + subscribeId precise routing). */
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
   * node WS connect register entry (ws-gateway in connect layer invoke;birpc proxy by gateway
   * establish, via attach parameter pass - - proxy local end i.e. hub side function, output/heartbeat/
   * IPC event bind set this connect). authentication via and proxy bind set after completion**atomic**publish.
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
    // boundary validate:version / upgradeAttemptId want particle default want particle non-empty string;
    // illegal type/empty string explicit reject register (not silently discard - - that will break upgrade for account identity).
    if (version !== undefined && (typeof version !== 'string' || version === '')) {
      return { accepted: false, reason: 'invalid version' }
    }
    if (upgradeAttemptId !== undefined && (typeof upgradeAttemptId !== 'string' || upgradeAttemptId === '')) {
      return { accepted: false, reason: 'invalid upgradeAttemptId' }
    }
    // undo epoch snapshot: authentication await during removeNode/round swap/top replace all will pass increase,
    // late to resolve(true) no longer by undo old connect publish online.
    const epochAtStart = this.#epochOf(nodeId)
    let valid = false
    try {
      valid = await this.#authenticate(nodeId, token)
    } catch {
      valid = false
    }
    if (!valid) return { accepted: false, reason: 'invalid token' }
    // authentication during connect may already assert: do not publish ghost connect.
    if (socket.readyState !== socket.OPEN) return { accepted: false, reason: 'connection closed during auth' }
    if (this.#closed) return { accepted: false, reason: 'registry closed' }
    // undo hard rule: authentication in-flight during occur evict/disconnect(removeNode, token round swap,
    // new connect top replace)→ this register already expires, reject publish (old connect never heavy enable).
    if (this.#epochOf(nodeId) !== epochAtStart) {
      return { accepted: false, reason: 'register superseded by revoke/replace' }
    }

    // establish proxy: local function bind set this connect and publish proxy (not publish before/by undo after event all discard).
    let publishEpoch = epochAtStart
    let published = false
    const isLive = (): boolean =>
      published && this.#epochOf(nodeId) === publishEpoch && this.#connections.get(nodeId)?.rpc === rpc
    let rpc!: BirpcReturn<NodeSideFunctions, HubConnectionLocal>
    rpc = attach({
      onEnvExecOutput: (event) => {
        if (!isLive()) return // undo/top replace after late to output do not pollute new proxy
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

    // top old connect: truly close old socket + rpc(do not only delete Map), and push enter epoch
    //(old proxy late to event from this one rule discard).
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

    this.#wakeWaiters(nodeId) // fully ready after only then wake
    this.#notifyNodeChanged(nodeId, true)
    this.#ensureSweeper()
    return { accepted: true, heartbeatMs: this.#heartbeatIntervalMs }
  }

  /**
   * create upgrade wait for: return result only by match heartbeat upgradeCommit resolve;
   * timeout / cancel() / registry.close() reject(original socket transfer disconnect do not final
   * wait for - - upgrade itself then along with choose top replace old connect). same node concurrency upgrade wait for explicit reject.
   * register do not resolve wait for - - choose register only carry attemptId, truly succeeded
   * confirm only can from choose itself commit heartbeat.
   */
  beginUpgrade(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#closed) throw new Error('registry closed')
    return this.#upgrades.begin(nodeId, params)
  }

  /** test inside omit: node is otherwise store in in-flight upgrade wait for. */
  hasUpgradeWaiter(nodeId: string): boolean {
    return this.#upgrades.has(nodeId)
  }

  // --- node pass-through tunnel ---------------------------------------------------------

  /** independent gateway authentication delegate: re- use register authentication (tokenAuthenticator / fail-closed). */
  async authenticateToken(nodeId: string, token: string): Promise<boolean> {
    if (this.#closed) return false
    try {
      return await this.#authenticate(nodeId, token)
    } catch {
      return false
    }
  }

  /** test inside omit: in-flight/already establish tunnel counter. */
  debugTunnelCounts(): { pending: number; active: number } {
    return this.#tunnels.counts()
  }

  /**
   * establish to remote node target host:port byte pipeline (any TCP;host default
   * 127.0.0.1, by node parse connect): invoke when before connect nodeTunnelOpen after
   * **immediately**wait for independent gateway first frame (acceptTunnel),RPC result in background for account - - slow/assert
   * RPC will not card timeout and abort. failed semantics (all HelmError, never fall back local):
   * - node offline / register table close:node_offline(409);
   * - node not implemented nodeTunnelOpen:node_tunnel_not_supported(501);
   * - gateway back connect timeout (default 10s):node_tunnel_timeout(504);
   * - node upgrade arrange empty refuse new:node_draining(503, node online but let upgrade,
   *   must not and node_offline confuse, also must not archive and is aborted);
   * - RPC explicit failed / assert connect:node_tunnel_connect_failed(502);abort:499.
   * any failed/cancel path all exhaust force notify node nodeTunnelAbort(catch observe, do not etc.
   * network back package only then reject),pending/active register sync clean up, do not pending.
   */
  async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
    const { host, port } = normalizeTunnelTarget(target)
    if (this.#closed) {
      throw new HelmError('node_offline', `node ${nodeId} offline, cannot establish tunnel`, 409, { nodeId })
    }
    const conn = this.#connections.get(nodeId)
    if (conn === undefined) {
      throw new HelmError('node_offline', `node ${nodeId} offline, cannot establish tunnel`, 409, { nodeId })
    }
    const open = conn.rpc.nodeTunnelOpen
    if (open === undefined) {
      throw new HelmError('node_tunnel_not_supported', `node ${nodeId} daemon unsupported pass-through tunnel`, 501, { nodeId })
    }
    const tunnelId = randomUUID()
    const epoch = this.#epochOf(nodeId)
    const timeoutMs = 10_000

    /** exhaust force notify node cancel ready listen (must fault tolerance: assert connect/unsupported when non-blocking local clean up). */
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
      reject: undefined as unknown as (error: HelmError) => void,
      settled: false,
    }
    const pendingPromise = new Promise<Duplex>((resolve, reject) => {
      let granted: Duplex | undefined
      const settle = (): void => {
        const duplex = granted
        if (pending.settled || duplex === undefined) return
        pending.settled = true
        clearTimeout(pending.timer)
        // excerpt pending, register active and hang close excerpt except hook (see tunnel-table.ts).
        this.#tunnels.activate(tunnelId, nodeId, duplex)
        resolve(duplex)
      }
      // gateway recognize verify via after hand over fine Duplex(see grantTunnel): fill i.e. compute.
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
    // guard against not handle rejection observer missing (caller await before sync reject path).
    pendingPromise.catch(() => undefined)
    pending.timer = setTimeout(() => {
      abortNode()
      pending.reject(new HelmError(
        'node_tunnel_timeout',
        `node ${nodeId} tunnel ${tunnelId} not in ${timeoutMs}ms inside back connect`,
        504,
        { nodeId, tunnelId },
      ))
    }, timeoutMs)
    pending.timer.unref?.()
    this.#tunnels.addPending(pending)

    const onAbort = (): void => {
      abortNode()
      pending.reject(new HelmError('aborted', 'tunnel establish cancelled', 499, { nodeId, tunnelId }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // RPC result background for account: do not await(slow/assert RPC do not card timeout and abort); succeeded only used to
    // mention before set format failed (node explicit reject),rejection also observe(produces no unhandled).
    void open({ tunnelId, ...(host === undefined ? {} : { host }), port }).then(
      (result) => {
        if (pending.settled) return
        if (result.ok) return
        const { code, status } = tunnelRpcFailureOf(result.error.code)
        abortNode()
        pending.reject(new HelmError(
          code,
          `node ${nodeId} establish tunnel failed:${result.error.message}`,
          status,
          { nodeId, tunnelId, port },
        ))
      },
      (error: unknown) => {
        if (pending.settled) return
        abortNode()
        pending.reject(new HelmError(
          'node_tunnel_connect_failed',
          `node ${nodeId} tunnel RPC failed:${error instanceof Error ? error.message : String(error)}`,
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
   * independent gateway first frame consume entry (pure recognize verify/match, do not any frame - - frame archive gateway):
   * recognize verify + once match + epoch re- inspect all via return true, gateway then hand over fine Duplex
   *(grantTunnel) and self row ok frame; any one does not match return false(gateway back error frame
   * after close and self row destroy stream, without leaking).
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

  /** gateway hand over fine Duplex: recognize verify already (acceptTunnel true after invoke);pending already set format
   * failed then destroy hand over come stream (without leaking). */
  grantTunnel(tunnelId: string, duplex: Duplex): void {
    this.#tunnels.grant(tunnelId, duplex)
  }

  /** heartbeat: only when nodeId and send connect register identity consistent only then refresh; carry legal health
   * snapshot when sync override conn.health(illegal snapshot ignore, does not affect lastSeenAt refresh;
   * birpc default tail reference will serialization is null, same by without payload handle). carry upgradeCommit
   * when ACK reverse reflect commit real accept result (illegal/does not match → false); ordinary heartbeat
   * (without commit) constant true. */
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

  /** immediately disconnect designate node (API delete identity when invoke). idempotent.
   *
   * undo hard rule: even if when before without already publish connect, also pass increase undo epoch- - authentication in-flight register
   * (await authenticate not wake) in wake come after must by refuse, never by undo old connect
   * publish online (removeNode/token round swap semantics). */
  disconnect(nodeId: string): void {
    const conn = this.#connections.get(nodeId)
    if (conn !== undefined) {
      this.#evict(nodeId, conn, 'revoked')
      return
    }
    // without already publish connect: still push enter epoch make in-flight register expires.
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
  }

  /** disconnect alias (semantics: hang deregister identity). */
  revoke(nodeId: string): void {
    this.disconnect(nodeId)
  }

  #dispatchOutput(nodeId: string, event: EnvExecOutputEvent): void {
    const sinks = this.#outputSinks.get(nodeId)
    if (sinks === undefined) return
    for (const sink of sinks) {
      try {
        sink(event)
      } catch {
        // single sink fault does not affect other.
      }
    }
  }

  /** when before undo epoch(default 0;evict/disconnect/replace pass increase). */
  #epochOf(nodeId: string): number {
    return this.#nodeEpoch.get(nodeId) ?? 0
  }

  #notifyNodeChanged(nodeId: string, online: boolean): void {
    for (const listener of [...this.#nodeChangedListeners]) {
      try {
        listener(nodeId, online)
      } catch {
        // listener fault does not affect register table itself.
      }
    }
  }

  #evict(nodeId: string, conn: NodeConnection, reason: string): void {
    if (this.#connections.get(nodeId) !== conn) return
    this.#connections.delete(nodeId)
    // upgrade wait for do not in on disconnect clean up: upgrade process itself then along with old socket close,
    // choose new connect top replace; succeeded confirm only can from choose commit heartbeat. wait for by
    // cancel / timeout / registry.close / match commit final, never because disconnect false terminal state.
    // undo epoch pass increase: in-flight register (authentication await in) and this proxy late to event all expires.
    this.#nodeEpoch.set(nodeId, this.#epochOf(nodeId) + 1)
    try {
      conn.rpc.$close()
    } catch {
      // already close.
    }
    if (conn.socket.readyState === conn.socket.OPEN || conn.socket.readyState === conn.socket.CONNECTING) {
      try {
        conn.socket.close(1000, reason)
      } catch {
        // ignore.
      }
    }
    // on disconnect final the node all IPC subscribe (connect already lose, subscribe no longer has event source).
    const ipcMap = this.#ipcSinks.get(nodeId)
    if (ipcMap !== undefined) {
      const sinks = [...ipcMap.values()]
      ipcMap.clear()
      for (const sink of sinks) {
        try {
          sink.onClosed(`node ${nodeId} disconnected`)
        } catch {
          // subscribe call back fault does not affect other subscribe.
        }
      }
    }
    // on disconnect reject the node all in-flight tunnel and destroy already establish tunnel duplex:
    // tunnel semantics bind set when before connect proxy (epoch), swap proxy i.e. unavailable, never pending.
    this.#tunnels.finalize((owner) => owner === nodeId, {
      pending: (owner, tunnelId) => new HelmError(
        'node_offline',
        `node ${owner} disconnected, tunnel ${tunnelId} establish abort`,
        409,
        { nodeId: owner, tunnelId },
      ),
      active: (owner, tunnelId) => new HelmError(
        'node_offline',
        `node ${owner} disconnected, tunnel ${tunnelId} close`,
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

  /** wait for node re- online;context cancel when return undefined. */
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

  /** supply fabric implement NodeRpcResolver. */
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

  /** close register table: disconnect all connect (closure socket + rpc), wake wait for, empty sink. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    // all tunnel final (pending reject;active excerpt except register and destroy duplex, consumer aware disconnect).
    this.#tunnels.finalize(() => true, {
      pending: (_nodeId, tunnelId) => new HelmError(
        'node_offline',
        `register table already close, tunnel ${tunnelId} establish abort`,
        409,
        { tunnelId },
      ),
      active: (_nodeId, tunnelId) => new HelmError(
        'node_offline',
        `register table already close, tunnel ${tunnelId} close`,
        409,
        { tunnelId },
      ),
    })
    this.#upgrades.rejectAll(new HelmUpgradeCancelledError('registry closed'))
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
export type { NodeHealthSnapshot, NodeHeartbeatInput } from '@helm/protocol'
