/**
 * Environment orchestration (`EnvFabric`): provides `pi-durable` `ExecutionEnv` instances per target.
 *
 * - `local`: reuses `pi-durable`'s `NodeExecutionEnv` in-process (no RPC);
 * - Remote BYOM nodes: `RemoteExecutionEnv` over `NodeRegistry` (WS+birpc);
 *   waits for reconnect when offline (cancellable) and **never falls back to local**;
 * - Env option injection (managed `HELM_TOKEN` / `HELM_HUB_URL` / `HELM_CONVERSATION_ID` /
 *   SecretStash secrets) via the `envOptions` callback: the secret service lives outside fabric,
 *   and fabric only consumes the callback output without holding secrets itself;
 * - IPC bridge (`ipcCall` / `ipcSubscribe`): lets optional plugins (e.g. `builtin:herdr`) connect
 *   to Unix Sockets / Named Pipes on the target machine over the node channel, consistently across nodes.
 *
 * Cache lifecycle (bounded without ref-counting or LRU machinery):
 * - **Conversation-scoped targets (`envForTarget` with `conversationId`)**: cached per
 *   `(conversationId, nodeId, cwd)`; `evictConversation` removes all entries for a conversation when
 *   it is deleted or its `nodeId`/`cwd` changes. Eviction only removes cache entries and never calls
 *   `cleanup` to kill in-flight commands—active `exec`/readers keep referencing the old instance and
 *   finish normally (aborts kill explicitly elsewhere), and the instance is GC'd after the last in-flight
 *   operation finishes (no unbounded growth, no accidental kills);
 * - **Non-conversation targets (`envFor` / `envForTarget` without `conversationId`)**: short-lived
 *   objects—created fresh on every call and discarded after use, never cached (herdr file handoffs,
 *   gates, non-conversation HTTP execs). Remote instances self-register/unregister output sinks per
 *   `exec` lifecycle (see `remote-env.ts`), leaving nothing in registries when discarded.
 */

import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { createLocalExecutionEnv } from './local-host-env.js'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import {
  HelmError,
  type NodeEnvRpcFunctions,
  type NodeIpcCallInput,
  type NodeIpcSubscribeInput,
  type NodePathUsage,
  type NodePathUsageProcess,
  type NodeTunnelTarget,
  type RpcResult,
} from '@helm/protocol'
import {
  createNodePathUsageIo,
  scanPathUsage,
  validatePosixScanPath,
} from '@helm/env-io'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { NodeRegistry, normalizeTunnelTarget } from './registry.js'
import { RemoteExecutionEnv } from './remote-env.js'
import { connectLocalTunnel, tunnelFetch } from './node-fetch.js'
import { createScopedExecutionEnv, type EnvTarget, type ScopedExecutionEnv } from './scoped-env.js'
import { envWithFileMutationQueue } from './file-mutation-queue.js'

export { ExecOutputHub } from './exec-output.js'
export { NodeRegistry, tokenAuthenticator, sha256hex, normalizeTunnelTarget } from './registry.js'
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions, UpgradeWaiterHandle } from './registry.js'
export { HelmUpgradeBusyError, HelmUpgradeTimeoutError, HelmUpgradeCancelledError } from './registry.js'
export { RemoteExecutionEnv } from './remote-env.js'
export type { NodeRpcResolver, RemoteExecutionEnvOptions } from './remote-env.js'
export { attachNodeWsGateway } from './ws-gateway.js'
export type { NodeWsGateway, NodeWsGatewayOptions } from './ws-gateway.js'
export { attachNodeTunnelGateway } from './ws-tunnel-gateway.js'
export type { NodeTunnelGateway, NodeTunnelGatewayOptions } from './ws-tunnel-gateway.js'
export { createScopedExecutionEnv } from './scoped-env.js'
export type { EnvTarget, ScopedExecutionEnv } from './scoped-env.js'

/** Injects environment options at exec time (sole channel for secrets and identity injection). */
export type EnvOptionsComposer = (input: {
  nodeId: string
  cwd: string
  conversationId?: number
}) => Promise<Record<string, string>> | Record<string, string>

export interface EnvFabricOptions {
  /**
   * Hub host platform (defaults to `process.platform`). Only injected by tests or controlled hosts;
   * production never fabricates the local platform, and remote platforms always use values reported at node registration.
   */
  hubPlatform?: () => string | undefined
  /** Node token authenticator (provided by external token store; defaults to rejecting all registrations). */
  authenticate?: (nodeId: string, token: string) => boolean | Promise<boolean>
  /** Heartbeat interval and offline timeout (ms). */
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  /**
   * Callback injecting extra env vars before exec (e.g. `HELM_HUB_URL`, `HELM_CONVERSATION_ID`,
   * managed `HELM_TOKEN`, SecretStash secrets). Wired externally to the secret service—fabric holds no secrets.
   */
  envOptions?: EnvOptionsComposer
  /** Directory prepended to PATH for local exec (helm CLI wrapper dir; defaults to none). */
  cliBinDir?: () => string | undefined
  /** Cap on waiting for reconnect during remote file RPCs (ms); see `remote-env.ts` for default. */
  remoteRpcWaitTimeoutMs?: number
  /** Diagnostic logger when releasing resources fails during `dispose` fallback cleanup (defaults to `console.error`). */
  logReleaseError?: (message: string) => void
}

/** Read-only diagnostic snapshot for external inspection (`debugBases`; never affects business logic). */
export interface EnvTargetSnapshot {
  key: string
  nodeId: string
  cwd: string
  conversationId?: number
}

/** Minimal surface exposed to the runtime. */
export interface EnvFabric {
  /** Internal connection registry (used to wire WS gateway: `attachNodeWsGateway(server, { registry })`). */
  readonly registry: NodeRegistry
  /**
   * Unscoped execution environment (herdr file handoffs / gates / unscoped HTTP exec):
   * **short-lived instance**—created fresh on every call and discarded after use, never cached.
   * Local runs directly in-process; remote goes over RPC; unknown nodes return a `RemoteExecutionEnv`
   * (waits for reconnect on use), **never falling back to local**.
   */
  envFor(nodeId: string, cwd: string): ExecutionEnv
  /**
   * Conversation-scoped execution environment (preferred entrypoint): concurrent conversations sharing
   * `(nodeId, cwd)` each get an isolated env-option scope—every command invokes `envOptions` freshly
   * (bound managed token / `HELM_CONVERSATION_ID` / SecretStash secrets) without caching or borrowing
   * another conversation's snapshot. Transport stays shared (one connection per node), while per-command
   * env options stay isolated. When `conversationId` is omitted, no secrets are injected (fail-closed)
   * and instances are short-lived (not cached); when `conversationId` is present, instances are cached
   * per conversation and released via `evictConversation` on deletion or target change.
   */
  envForTarget(target: EnvTarget): ScopedExecutionEnv
  /** Whether a remote node is online (`local` is always true). */
  isOnline(nodeId: string): boolean
  /** Wait for a remote node to come online (cancellable); `local` is always true. */
  waitForOnline(nodeId: string, context: Context): Promise<boolean>
  /**
   * Single-shot local-IPC call on a node (connects to a Unix Socket / Named Pipe on the target machine
   * across nodes). Throws explicitly if IPC bridge is unsupported or node is offline (fail-fast, no silent fallback);
   * preserves `node_draining` in `RpcResult` when the node is draining for upgrade (connection is still alive
   * and distinguishable from offline/cancelled so callers like `builtin:herdr` can classify it).
   */
  ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>>
  /**
   * Streaming local-IPC subscription on a node: `onLine` fires per line; `onClosed` fires exactly once
   * on end/disconnect/cancel; returns a stop function. Throws if unsupported; throws `HelmError('node_draining', ..., 503)`
   * if the node is draining for upgrade.
   */
  ipcSubscribe(
    nodeId: string,
    input: Omit<NodeIpcSubscribeInput, 'subscribeId'>,
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
  /** Hub URL reported by a node at registration (kept current for remote spawned processes connecting back). */
  getNodeHubUrl(nodeId: string): string | undefined
  /**
   * Minimal read-only port for Hub host platform: defaults to `process.platform` and is injectable in tests.
   * Target-platform normalization uses this only for local (or test-configured Hub) facts; never fabricated in production.
   */
  readonly hubPlatform?: () => string | undefined
  /**
   * Minimal read-only port for a node's platform (`process.platform` format): `local` always returns Hub host;
   * remote returns the value reported at registration (undefined if unreported or offline). Callers use this for
   * target-platform-aware path normalization—never guessing or falling back to Hub platform when unknown.
   */
  nodePlatformOf(nodeId: string): string | undefined
  /**
   * Per-file mutation mutex queue (serialized per canonical path on target node): wraps read-modify-write
   * windows inside `(nodeId, cwd)` in the exact same queue as kernel `write`/`edit` tools (prevents lost updates
   * on the same file while leaving other files/nodes unblocked; symlink aliases share one key; new files join
   * their canonical parent dir). Local runs in-process; remote uses a short-lived `RemoteExecutionEnv`.
   * Does not lock bash/external processes and is non-reentrant; see `env/file-mutation-queue.ts`.
   */
  withFileMutationQueue<T>(
    target: { nodeId: string; cwd: string; path: string },
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
  /**
   * First-class arbitrary TCP tunnel primitive: opens a raw Duplex to `host:port` on the target node.
   * - `local`: direct in-process `net.connect`;
   * - remote: reuses `registry.openTunnel` (served by the dedicated WS tunnel gateway without a second transport);
   * - unknown/offline node: throws `HelmError('node_offline', ..., 409)` explicitly, never falling back to local;
   * - abort/timeout/error: throws explicitly and guarantees resource cleanup (no leaked Duplex).
   * `host` is resolved and connected on the node (defaults to `127.0.0.1` if omitted).
   */
  openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex>
  /**
   * Node-local HTTP(S) fetch adapter (layered on `openTunnel`): `local` returns `globalThis.fetch` directly;
   * remote supports arbitrary hosts and http/https—http passes the tunnel Duplex to `node:http.request`
   * (`createConnection`), while https stacks `node:tls.connect` (SNI + cert verification) onto the tunnel
   * Duplex before handing it to `node:http.request`. 4xx/5xx return Responses intact; connect/transport/disconnect
   * errors map to HelmError without ever falling back to local. Exposed to plugins via `ctx.host.nodeFetch`.
   */
  nodeFetch(nodeId: string): typeof fetch
  /**
   * Snapshot of processes occupying a path on the target node (pre-deletion diagnostics; not a cross-process mutex):
   * - `local`: read-only `/proc` scan inside the Hub process (zero helper spawns; never spawns inside target cwd);
   *   only inspects `cwd`/`fd`/`comm`, never `cmdline`/`environ`;
   * - remote: scans on the target node via `envPathUsage` RPC, **never falling back to local**; offline nodes throw
   *   `409 node_offline`, older daemons missing the method throw `501 path_usage_not_supported`, non-permission
   *   errors or cap hits during observability return `complete=false` (callers must fail-closed rather than treating
   *   as zero usage); permission-blocked processes (cross-uid or non-dumpable like `systemd --user`) increment
   *   `unobservable` and appear in `diagnostics` without clearing `complete` (same-uid Hub-managed processes stay observable);
   * - non-Linux platforms fail explicitly with `not_supported` (`HelmError('path_usage_not_supported')`).
   */
  inspectPathUsage(nodeId: string, path: string, signal?: AbortSignal): Promise<NodePathUsage>
  /**
   * Release all cached target instances for a conversation: deletes entries only (never calls `cleanup` to kill
   * in-flight commands—active `exec`/readers finish using their held references; see file header comment).
   * Called on conversation deletion or `nodeId`/`cwd` updates.
   */
  evictConversation(conversationId: number): void
  /** Current number of cached target entries (diagnostics/tests only; never affects business logic). */
  debugBaseCount(): number
  /** Read-only snapshot of cached target entries (tests/observability only; never affects business logic). */
  debugBases(): EnvTargetSnapshot[]
  /** Shut down: clean up remote envs and close registry; idempotent; logs individual failures rather than swallowing them. */
  dispose(): Promise<void>
}

/**
 * Strict RPC-boundary validation of node path-usage snapshots (`AGENTS.md` boundary schema discipline):
 * explicitly rejects malformed shapes, mismatched targets, or self-contradictory counts without accepting
 * partial snapshots (an empty snapshot from another directory must never justify deleting this directory).
 */
function validatePathUsageSnapshot(nodeId: string, expectedPath: string, value: unknown): NodePathUsage {
  const fail = (reason: string): HelmError =>
    new HelmError('node_path_usage_failed', `node ${nodeId} returned an invalid process-usage snapshot (${reason}); refusing to use it`, 502, {
      nodeId,
      expectedPath,
    })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('not an object')
  const v = value as Record<string, unknown>
  // Request correlation: snapshot must echo the normalized target path (prevents substituting another directory's snapshot).
  if (v['path'] !== expectedPath) {
    throw fail(`path does not match request (expected ${JSON.stringify(expectedPath)}, got ${JSON.stringify(String(v['path']))})`)
  }
  if (!Array.isArray(v['processes'])) throw fail('processes is not an array')
  if (v['processes'].length > 512) throw fail('processes exceeds array cap of 512')
  const processes: NodePathUsageProcess[] = []
  const seenPids = new Set<number>()
  for (const raw of v['processes']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('processes item is not an object')
    const p = raw as Record<string, unknown>
    if (!Number.isSafeInteger(p['pid']) || (p['pid'] as number) <= 0) throw fail('pid is not a positive integer')
    if (seenPids.has(p['pid'] as number)) throw fail(`processes contains duplicate PID ${p['pid']} (multiple references per process must be deduplicated)`)
    seenPids.add(p['pid'] as number)
    if (p['source'] !== 'cwd' && p['source'] !== 'fd') throw fail('source is not cwd|fd')
    if (typeof p['path'] !== 'string' || p['path'] === '') throw fail('process path is not a non-empty string')
    if (p['name'] !== undefined && typeof p['name'] !== 'string') throw fail('name is not a string')
    processes.push({
      pid: p['pid'] as number,
      ...(p['name'] !== undefined ? { name: p['name'] as string } : {}),
      source: p['source'] as 'cwd' | 'fd',
      path: p['path'] as string,
    })
  }
  if (!Number.isSafeInteger(v['matchedTotal']) || (v['matchedTotal'] as number) < 0) throw fail('matchedTotal is not a non-negative integer')
  const matchedTotal = v['matchedTotal'] as number
  if (typeof v['processesTruncated'] !== 'boolean') throw fail('processesTruncated is not a boolean')
  const truncated = v['processesTruncated'] as boolean
  // Self-consistency between count and list: total cannot be less than list length; truncated implies total > list;
  // non-truncated requires exact equality (e.g. truncated=true with matchedTotal=0 is self-contradictory).
  if (matchedTotal < processes.length) throw fail(`matchedTotal (${matchedTotal}) is less than list length (${processes.length})`)
  if (truncated && matchedTotal <= processes.length) {
    throw fail(`processesTruncated=true but matchedTotal (${matchedTotal}) does not exceed list length (${processes.length})`)
  }
  if (!truncated && matchedTotal !== processes.length) {
    throw fail(`not truncated, but matchedTotal (${matchedTotal}) disagrees with list length (${processes.length})`)
  }
  if (typeof v['complete'] !== 'boolean') throw fail('complete is not a boolean')
  // Blind-spot counter for unobservable processes (cross-uid or non-dumpable): must be a non-negative safe integer
  // when present; defaults to 0 when omitted (older nodes already report complete=false on any denial, so defaulting to 0
  // never turns blind spots into clean zero-blind-spot complete snapshots).
  if (v['unobservable'] !== undefined && (!Number.isSafeInteger(v['unobservable']) || (v['unobservable'] as number) < 0)) {
    throw fail('unobservable is not a non-negative integer')
  }
  const unobservable = (v['unobservable'] as number | undefined) ?? 0
  if (!Array.isArray(v['diagnostics'])) throw fail('diagnostics is not an array')
  if (v['diagnostics'].length > 128) throw fail('diagnostics exceeds array cap of 128')
  if (v['diagnostics'].some((d) => typeof d !== 'string')) throw fail('diagnostics item is not a string')
  return {
    path: v['path'] as string,
    processes,
    matchedTotal,
    processesTruncated: truncated,
    complete: v['complete'] as boolean,
    unobservable,
    diagnostics: v['diagnostics'] as string[],
  }
}

export function createEnvFabric(options: EnvFabricOptions): EnvFabric {
  const { envOptions, cliBinDir } = options
  const logReleaseError = options.logReleaseError ?? ((message: string) => console.error(`[helm] env fabric: ${message}`))
  // **Cache target backends only per conversation**: used solely by `envForTarget` with `conversationId`
  // (bounded by conversation lifetime via `evictConversation`). Unscoped targets always create fresh instances.
  const bases = new Map<string, ExecutionEnv>()
  const closing = new AbortController()
  const localTunnels = new Set<Duplex>()
  const registry = new NodeRegistry({
    authenticate: options.authenticate ?? (() => false),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  })
  const hubPlatform = (): string => options.hubPlatform?.() || process.platform
  const remoteResolver = {
    getNodeEnvRpc: (nodeId: string): NodeEnvRpcFunctions | undefined => registry.getNodeEnvRpc(nodeId),
    waitForNodeOnline: (nodeId: string, context: Context) => registry.waitForNodeOnline(nodeId, context),
    addOutputSink: (nodeId: string, sink: (event: import('@helm/protocol').EnvExecOutputEvent) => void) =>
      registry.addOutputSink(nodeId, sink),
    removeOutputSink: (nodeId: string, sink: (event: import('@helm/protocol').EnvExecOutputEvent) => void) =>
      registry.removeOutputSink(nodeId, sink),
  }

  const baseKey = (nodeId: string, cwd: string, conversationId: number): string =>
    `${nodeId}\u0000${cwd}\u0000${conversationId}`

  /** Extract conversationId segment from `baseKey`. */
  const conversationIdOfKey = (key: string): number | undefined => {
    const part = key.split('\u0000')[2]
    return part !== undefined && part !== '-' && /^\d+$/.test(part) ? Number(part) : undefined
  }

  /** Create an uncached backend: local runs in-process; remote uses `RemoteExecutionEnv` (manages sinks per exec). */
  const freshBase = (nodeId: string, cwd: string): ExecutionEnv =>
    nodeId === 'local'
      ? createLocalExecutionEnv({ cwd })
      : new RemoteExecutionEnv(
          remoteResolver,
          {
            nodeId,
            cwd,
            ...(options.remoteRpcWaitTimeoutMs === undefined ? {} : { rpcWaitTimeoutMs: options.remoteRpcWaitTimeoutMs }),
          },
        )

  /** Get or create the dedicated backend for a conversation target (only targets with `conversationId` enter cache). */
  const baseFor = (nodeId: string, cwd: string, conversationId: number): ExecutionEnv => {
    const key = baseKey(nodeId, cwd, conversationId)
    let entry = bases.get(key)
    if (entry === undefined) {
      entry = freshBase(nodeId, cwd)
      bases.set(key, entry)
    }
    return entry
  }

  /** Require an online node's RPC (shared by IPC bridge; fails immediately when offline without waiting for reconnect). */
  const requireRpc = async (nodeId: string, signal?: AbortSignal): Promise<NodeEnvRpcFunctions> => {
    if (signal?.aborted) throw new HelmError('aborted', 'IPC call cancelled', 499)
    const rpc = registry.getNodeEnvRpc(nodeId)
    if (rpc !== undefined) return rpc
    throw new HelmError('node_offline', `node ${nodeId} is offline; cannot establish IPC channel`, 409, { nodeId })
  }

  return {
    registry,
    hubPlatform,
    envFor(nodeId: string, cwd: string): ExecutionEnv {
      // Unscoped short-lived object: never cached (repeated calls for the same cwd never accumulate instances).
      return freshBase(nodeId, cwd)
    },

    envForTarget(target: EnvTarget): ScopedExecutionEnv {
      // Target-dedicated backend + conversation option scope: two conversations sharing `(nodeId, cwd)` get
      // independent backends (cwd mutations stay isolated) and fresh per-call option injection. Unscoped targets
      // (without `conversationId`) skip the cache (short-lived; fail-closed with no secrets injected).
      const base =
        target.conversationId === undefined
          ? freshBase(target.nodeId, target.cwd)
          : baseFor(target.nodeId, target.cwd, target.conversationId)
      return createScopedExecutionEnv(base, target, envOptions, cliBinDir === undefined ? {} : { cliBinDir })
    },

    isOnline(nodeId: string): boolean {
      if (nodeId === 'local') return true
      return registry.get(nodeId) !== undefined
    },

    async waitForOnline(nodeId: string, context: Context): Promise<boolean> {
      if (nodeId === 'local') return true
      return (await registry.waitForNodeOnline(nodeId, context)) !== undefined
    },

    async ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>> {
      const rpc = await requireRpc(nodeId, signal)
      const ipcCallFn = rpc.ipcCall
      const ipcAbort = rpc.ipcAbortCall
      if (ipcCallFn === undefined) {
        throw new HelmError('ipc_not_supported', `node ${nodeId} daemon does not support local IPC calls`, 501, {
          nodeId,
        })
      }
      const callId = input.callId ?? `ipc-${randomUUID()}`
      // Best-effort abort of in-flight call when `signal` fires (node closes underlying socket immediately).
      const onAbort = () => {
        void ipcAbort?.(callId).catch(() => undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC call cancelled', 499) }
      try {
        return await ipcCallFn({ ...input, callId })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },

    async ipcSubscribe(
      nodeId: string,
      input: Omit<NodeIpcSubscribeInput, 'subscribeId'>,
      onLine: (line: string) => void,
      onClosed: (error?: string) => void,
      signal?: AbortSignal,
    ): Promise<() => void> {
      const rpc = await requireRpc(nodeId, signal)
      const ipcSubscribeFn = rpc.ipcSubscribe
      const ipcUnsubscribeFn = rpc.ipcUnsubscribe
      if (ipcSubscribeFn === undefined || ipcUnsubscribeFn === undefined) {
        throw new HelmError('ipc_not_supported', `node ${nodeId} daemon does not support local IPC subscriptions`, 501, {
          nodeId,
        })
      }
      const subscribeId = randomUUID()
      let closed = false
      let closedOnce = false
      const finish = (error?: string): void => {
        if (closedOnce) return
        closedOnce = true
        signal?.removeEventListener('abort', onAbort)
        registry.removeIpcSink(nodeId, subscribeId)
        try {
          onClosed(error)
        } catch {
          // Subscriber callback faults must not break fabric.
        }
      }
      const onAbort = () => {
        if (closed) return
        closed = true
        void ipcUnsubscribeFn(subscribeId).catch(() => undefined)
        finish('aborted')
      }
      registry.addIpcSink(nodeId, subscribeId, {
        onEvent: (line) => {
          if (closed) return
          try { onLine(line) } catch { onAbort() }
        },
        onClosed: (error) => {
          if (closed) return
          closed = true
          finish(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      let result: Awaited<ReturnType<typeof ipcSubscribeFn>>
      try { result = await ipcSubscribeFn({ ...input, subscribeId }) }
      catch (error) { closed = true; finish('node connection lost'); throw error }
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC subscription cancelled', 499) }
      if (!result.ok) {
        closed = true
        finish(result.error.message)
        // Node draining for upgrade: throw stable `node_draining` (503) to distinguish from ordinary `ipc_subscribe_failed`
        // rather than swallowing node state into a generic error.
        if (result.error.code === 'node_draining') {
          throw new HelmError(
            'node_draining',
            `node ${nodeId} is draining for upgrade; rejecting new IPC subscription: ${result.error.message}`,
            503,
            { nodeId },
          )
        }
        throw new HelmError('ipc_subscribe_failed', `node ${nodeId} IPC subscription failed: ${result.error.message}`, 502, {
          nodeId,
          code: result.error.code,
        })
      }
      return () => {
        if (closed) return
        closed = true
        void ipcUnsubscribeFn(subscribeId).catch(() => undefined)
        finish()
      }
    },

    getNodeHubUrl(nodeId: string): string | undefined {
      if (nodeId === 'local') return undefined
      return registry.get(nodeId)?.hubUrl
    },

    nodePlatformOf(nodeId: string): string | undefined {
      // `local` shares the Hub process; tests can inject `hubPlatform` to reflect controlled Hub facts.
      // Remote takes only the platform registered on connect (unreported/offline -> undefined; callers handle unknown rather than guessing).
      if (nodeId === 'local') return hubPlatform()
      const platform = registry.get(nodeId)?.platform
      return platform === undefined || platform === '' ? undefined : platform
    },

    async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
      const { host, port } = normalizeTunnelTarget(target)
      if (signal?.aborted) {
        throw new HelmError('aborted', 'tunnel establishment cancelled', 499, { nodeId })
      }
      if (closing.signal.aborted) {
        throw new HelmError('node_offline', 'node tunnel service is closed', 409, { nodeId })
      }
      // Also track local tunnels for shutdown: including sockets still awaiting connect.
      if (nodeId === 'local') {
        const connectSignal = signal === undefined ? closing.signal : AbortSignal.any([signal, closing.signal])
        const duplex = await connectLocalTunnel(host ?? '127.0.0.1', port, connectSignal)
        if (closing.signal.aborted || signal?.aborted) {
          duplex.destroy()
          throw new HelmError('aborted', 'tunnel establishment cancelled', 499, { nodeId })
        }
        localTunnels.add(duplex)
        duplex.once('close', () => localTunnels.delete(duplex))
        return duplex
      }
      return await registry.openTunnel(nodeId, { ...(host === undefined ? {} : { host }), port }, signal)
    },

    nodeFetch(nodeId: string): typeof fetch {
      if (nodeId === 'local') return globalThis.fetch
      return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init)
        return tunnelFetch(
          (target, signal) => this.openTunnel(nodeId, target, signal),
          nodeId,
          request,
        ) as ReturnType<typeof fetch>
      }) as typeof fetch
    },

    async inspectPathUsage(nodeId: string, targetPath: string, signal?: AbortSignal): Promise<NodePathUsage> {
      if (signal?.aborted) throw new HelmError('aborted', 'path usage scan cancelled', 499, { nodeId })
      // Check actual node platform first so valid Windows drive paths are not misreported as invalid POSIX paths;
      // unsupported platforms reject explicitly, while offline remote nodes still report unreachable first.
      const rpc = nodeId === 'local' ? undefined : await requireRpc(nodeId, signal)
      const platform = nodeId === 'local' ? hubPlatform() : registry.get(nodeId)?.platform
      if (platform && platform !== 'linux') {
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} platform '${platform}' does not support process usage scanning (currently Linux /proc only); cannot verify zero usage for target path`,
          501,
          { nodeId, platform },
        )
      }
      // Normalize target path uniformly across supported platforms for matching against the RPC response.
      const normalized = validatePosixScanPath(targetPath)
      if (!normalized.ok) {
        throw new HelmError('validation_error', `invalid path usage scan argument: ${normalized.message}`, 400, { nodeId })
      }
      const expectedPath = normalized.value
      if (nodeId === 'local') {
        // Real in-process scan on Hub (platform via `hubPlatform` port so tests can override while production
        // uses `process.platform` without fabrication). Shares `@helm/env-io` implementation with remote daemons
        // rather than duplicating filesystem logic.
        const io = createNodePathUsageIo()
        const result = await scanPathUsage(expectedPath, {
          io,
          platform: hubPlatform(),
          signal,
        })
        if (result.ok) return result.value
        const { code, message } = result.error
        if (code === 'invalid') throw new HelmError('validation_error', `invalid path usage scan argument: ${message}`, 400, { nodeId })
        if (code === 'permission_denied') {
          throw new HelmError(
            'node_path_usage_failed',
            `local process usage scan failed (permission denied): ${message}`,
            502,
            { nodeId, code: 'permission_denied' },
          )
        }
        if (code === 'not_supported') {
          throw new HelmError(
            'path_usage_not_supported',
            `Hub platform '${hubPlatform()}' does not support process usage scanning (currently Linux /proc only; refusing to fabricate cross-platform result); cannot verify zero usage for target path`,
            501,
            { nodeId, platform: hubPlatform() },
          )
        }
        if (code === 'aborted') throw new HelmError('aborted', message, 499, { nodeId })
        throw new HelmError('node_path_usage_failed', `local process usage scan failed: ${message}`, 502, { nodeId })
      }
      // Remote: scan on the target node directly; never fall back to local.
      const fn = rpc!.envPathUsage
      if (fn === undefined) {
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} daemon does not support envPathUsage (outdated version?); cannot verify zero usage and will not fall back to local scan`,
          501,
          { nodeId },
        )
      }
      // birpc may resolve to undefined (gateway absorbs missing-method errors on old daemons): explicitly allow undefined.
      let result: RpcResult<import('@helm/protocol').NodePathUsage> | undefined
      try {
        result = await fn({ path: expectedPath })
      } catch (error) {
        // birpc proxy exposes every property as a function: calling a missing method on an older daemon rejects
        // with `function ... not found`—classify this as unsupported (501) rather than scan failure or local fallback;
        // transport/timeout errors remain 502.
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('[birpc] function') && message.includes('not found')) {
          throw new HelmError(
            'path_usage_not_supported',
            `node ${nodeId} daemon does not support envPathUsage (outdated version?); cannot verify zero usage and will not fall back to local scan`,
            501,
            { nodeId, cause: message },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} path usage scan RPC failed: ${message}`,
          502,
          { nodeId, cause: message },
        )
      }
      if (result === undefined || result === null) {
        // Older daemon without `envPathUsage`: birpc gateway `onGeneralError` absorbed it as undefined—classify
        // as unsupported (501), never fall back to local and never treat as an empty snapshot.
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} daemon does not support envPathUsage (outdated version?); cannot verify zero usage and will not fall back to local scan`,
          501,
          { nodeId },
        )
      }
      // Strict RPC envelope validation: `ok` must be strictly boolean; failed envelopes must carry valid
      // `code`/`message`—invalid envelopes fail explicitly with `node_path_usage_failed` rather than TypeErrors later.
      const envelope = result as { ok?: unknown; value?: unknown; error?: unknown }
      if (typeof envelope.ok !== 'boolean') {
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} path usage scan returned an invalid envelope (ok is not a strict boolean; protocol violation)`,
          502,
          { nodeId },
        )
      }
      if (!envelope.ok) {
        const e = envelope.error as { code?: unknown; message?: unknown } | undefined
        if (
          typeof e !== 'object' || e === null ||
          typeof e.code !== 'string' || e.code === '' ||
          typeof e.message !== 'string' || e.message === ''
        ) {
          throw new HelmError(
            'node_path_usage_failed',
            `node ${nodeId} path usage scan returned an invalid error envelope (missing valid code/message; protocol violation)`,
            502,
            { nodeId },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} path usage scan failed (${e.code}: ${e.message})`,
          502,
          { nodeId, code: e.code },
        )
      }
      return validatePathUsageSnapshot(nodeId, expectedPath, envelope.value)
    },

    async withFileMutationQueue<T>(
      target: { nodeId: string; cwd: string; path: string },
      fn: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      // Short-lived backend: queue lives in a process-wide Map (key includes `env.id`), independent of instance caching,
      // and shares the exact same key namespace with `tools.ts`'s `envFor` remote branch.
      const env = freshBase(target.nodeId, target.cwd)
      const context: Context = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
      return envWithFileMutationQueue(env, target.path, fn, context)
    },

    evictConversation(conversationId: number): void {
      // Remove cache entries only: never call `entry.cleanup`—`NodeExecutionEnv.cleanup` kills `activeChildPids`
      // (killing in-flight commands for the conversation), and `RemoteExecutionEnv`'s `envCleanup` would kill
      // commands from other conversations sharing the cwd. Active ops retain old references and finish cleanly.
      for (const [key] of [...bases]) {
        if (conversationIdOfKey(key) === conversationId) bases.delete(key)
      }
    },

    debugBaseCount(): number {
      return bases.size
    },

    debugBases(): EnvTargetSnapshot[] {
      return [...bases].map(([key]) => ({
        key,
        nodeId: key.split('\u0000')[0]!,
        cwd: key.split('\u0000')[1]!,
        ...(conversationIdOfKey(key) !== undefined ? { conversationId: conversationIdOfKey(key) } : {}),
      }))
    },

    async dispose(): Promise<void> {
      closing.abort()
      for (const duplex of localTunnels) duplex.destroy()
      localTunnels.clear()
      // Close node connections first so in-flight requests settle as unknown without waiting for reconnect during shutdown.
      await registry.close()
      // Clean up remaining target backends individually (killing in-flight commands happened prior to dispose;
      // Remote `cleanup` only unregisters its own sinks without calling cwd-wide `envCleanup` that would kill
      // other conversations on the same node/cwd, while node-side commands fall back to connection-level dispose).
      const entries = [...bases]
      bases.clear()
      for (const [key, entry] of entries) {
        const [nodeId, cwd] = key.split('\u0000')
        entry
          .cleanup(BACKGROUND_CONTEXT)
          .catch((error: unknown) =>
            logReleaseError(
              `backend cleanup failed (node=${nodeId} cwd=${cwd}): ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      }
      // `registry.close()` already ran upfront and converges idempotently; no need to call it a second time.
    },
  }
}

