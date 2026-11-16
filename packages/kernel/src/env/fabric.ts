/**
 * environment orchestration (EnvFabric): by target provide pi-durable ExecutionEnv.
 *
 * - `local`: directly re- use pi-durable  NodeExecutionEnv(process inside, without RPC);
 * - remote BYOM node:RemoteExecutionEnv over NodeRegistry(WS+birpc);
 *   remote node offline when wait for reconnect (can cancel),**never back to local**;
 * - environment option inject (managed HELM_TOKEN / HELM_HUB_URL / HELM_CONVERSATION_ID /
 *   SecretStash secret) via envOptions call back together into: secret service in fabric external,
 *   fabric only consume call back result, do not hold has secret;
 * - IPC bridge (ipcCall / ipcSubscribe): supply optional plugin (such as builtin:herdr) via
 *   node channel connect target machine on Unix Socket / Named Pipe, across node same construct.
 *
 * cache lifecycle (has boundary, without reference counter/LRU framework):
 * - **has conversation target (envForTarget and carries conversationId)**: by
 *   (conversationId, nodeId, cwd) cache bottom seat; conversation delete (deleteConversation)
 *   or modify nodeId/cwd(updateConversation) when evictConversation release the conversation
 *   all item. drive one by one only remove cache item, never invoke cleanup kill in-flight command - - the conversation
 *   in-flight exec/reader still hold has old instance reference and self however complete (abort path another row precise kill),
 *   instance follow finally a in-flight operation end by GC, cache do not increase long also do not mistakenly kill.
 * - **without conversation target (envFor / envForTarget without conversationId)**: short lifecycle
 *   object - - each time invoke create all new instance, use after i.e. abandon, never enter cache (herdr file handover,
 *   gate, without conversation HTTP exec all is short sequence). remote instance output sink by
 *   RemoteExecutionEnv by exec lifecycle self register/self deregister (see remote-env.ts),
 *   object discard i.e. without register leftover, does not need caller explicit release.
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

/** exec when together into environment option (secret and identity inject unique channel). */
export type EnvOptionsComposer = (input: {
  nodeId: string
  cwd: string
  conversationId?: number
}) => Promise<Record<string, string>> | Record<string, string>

export interface EnvFabricOptions {
  /**
   * Hub platform fact (default process.platform). only used to test or subject to control host inject; produce
   * must not fabricate local machine platform, remote platform still only take node register on report value.
   */
  hubPlatform?: () => string | undefined
  /** node token authentication (by external sign table provide; default reject everything register). */
  authenticate?: (nodeId: string, token: string) => boolean | Promise<boolean>
  /** heartbeat interval/timeout (milli second). */
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  /**
   * environment option inject call back:exec before together into additional env(such as HELM_HUB_URL,
   * HELM_CONVERSATION_ID, managed HELM_TOKEN,SecretStash secret). by external
   * secret service combine - -fabric do not hold has any secret.
   */
  envOptions?: EnvOptionsComposer
  /** local exec  PATH pre- directory (helm CLI wrap directory; default do not pre-). */
  cliBinDir?: () => string | undefined
  /** remote file operation parse RPC wait for reconnect cap (milli second); default see remote-env.ts. */
  remoteRpcWaitTimeoutMs?: number
  /** asset release failed diagnose log (dispose exhaust force clean up path; default console.error). */
  logReleaseError?: (message: string) => void
}

/** for outside only read diagnose opening path (debugBases; does not participate business logic). */
export interface EnvTargetSnapshot {
  key: string
  nodeId: string
  cwd: string
  conversationId?: number
}

/** for runtime expose most small port. */
export interface EnvFabric {
  /** inside create register table (WS gateway connect line use:attachNodeWsGateway(server, { registry })). */
  readonly registry: NodeRegistry
  /**
   * without conversation effect domain execute environment (herdr file handover / gate / without conversation HTTP exec):
   * **short lifecycle object**- - each time invoke all new instance, use after i.e. abandon, never cache.local
   * process inside direct create; remote via RPC; unknown node return Remote env(operation when wait for reconnect),
   * **never back local**.
   */
  envFor(nodeId: string, cwd: string): ExecutionEnv
  /**
   * conversation effect domain execute environment (recommend entry): the same (nodeId,cwd) concurrency conversation each gets
   * independent env option effect domain - - each command envOptions live together into (fresh, contains
   * bind set managed token / HELM_CONVERSATION_ID / SecretStash secret), never
   * cache or borrow use on a conversation option snapshot. sharing transfer (same node a connect),
   * one by one command option isolated. without conversationId when do not inject any secret (fail-closed),
   * and does not enter cache (short lifecycle). carries conversationId when bottom seat by conversation cache,
   * conversation delete/target change via evictConversation release.
   */
  envForTarget(target: EnvTarget): ScopedExecutionEnv
  /** remote node is otherwise online (local constant true). */
  isOnline(nodeId: string): boolean
  /** wait for remote node enable (can cancel);local constant is true. */
  waitForOnline(nodeId: string, context: Context): Promise<boolean>
  /**
   * node local machine single time IPC invoke (across node connect target machine on Unix Socket / Named
   * Pipe). node unsupported IPC bridge or node offline when explicit errors (fail-fast, not silently fall back);
   * node upgrade arrange empty refuse new when RpcResult keep original node_draining error code (connect still in,
   * and offline/cancel can zone, by caller such as builtin:herdr self row type).
   */
  ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>>
  /**
   * node local machine streaming IPC subscribe:onLine one by one row call back;onClosed in end/disconnect/cancel when
   * exactly call back once; return function used to actively stop subscribe. node unsupported when throws; node
   * upgrade arrange empty refuse new when throw HelmError node_draining(503).
   */
  ipcSubscribe(
    nodeId: string,
    input: Omit<NodeIpcSubscribeInput, 'subscribeId'>,
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
  /** node register when on report hubUrl(remote managed child process back connect address guard constant). */
  getNodeHubUrl(nodeId: string): string | undefined
  /**
   * Hub platform fact most small only read port: default process.platform, test can explicit inject.
   * target platform specification only via this port read local can test Hub fact; produce must not fabricate.
   */
  readonly hubPlatform?: () => string | undefined
  /**
   * node platform (process.platform opening path) most small only read port:local constant Hub host;
   * remote only take register register value (not on report or offline return undefined). caller based on this do target
   * platform aware path specification - - platform unknown when do not guess, do not fallback Hub host platform.
   */
  nodePlatformOf(nodeId: string): string | undefined
  /**
   * file mutual exclusion queue (target node canonical path serial): in (nodeId, cwd) target inside
   * fn read-change-write window and kernel write/edit tool arrange the same queue (same file do not lose update;
   * other file/node mutual without waiting; symlink alias same key; new file by canonical parent directory concatenate).
   * local directly in Hub process queue execute; remote via short lifecycle RemoteExecutionEnv.
   * is not for bash/external process lock, also cannot heavy; detail see env/file-mutation-queue.ts.
   */
  withFileMutationQueue<T>(
    target: { nodeId: string; cwd: string; path: string },
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
  /**
   * one etc. public civilian any TCP tunnel: establish to target node host:port original Duplex.
   * - local:Hub process inside net.connect direct connect;
   * - remote: re- use registry.openTunnel(since has WS tunnel gateway, do not another create transfer);
   * - unknown/offline node explicit HelmError(node_offline 409), never fall back local;
   * - abort/timeout/error explicit throw and guarantee asset release (duplex without leaking).
   * host by node parse and connect (omit when target is 127.0.0.1).
   */
  openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex>
  /**
   * node local machine HTTP(S) fetch adapt layer (based on openTunnel):local directly return
   * globalThis.fetch; remote support any host and http/https- -http via tunnel
   * Duplex on node:http.request(createConnection),https in tunnel Duplex
   * on stack node:tls.connect(servername/certificate validate) after hand over to node:http.request;
   * 4xx/5xx still return Response, establish/transfer/disconnect error mapping HelmError, never fall back
   * local. supply plugin (ctx.host.nodeFetch) access target node perspective HTTP(S) service.
   */
  nodeFetch(nodeId: string): typeof fetch
  /**
   * target node process occupy snapshot (before deletion diagnose side; non- across process mutual exclusion):
   * - local:Hub process inside real /proc only read scan (zero helper spawn, do not use target cwd
   *   start any child process); only read cwd/fd/comm locate information, never read cmdline/environ;
   * - remote: via envPathUsage RPC in target node scan,**never fall back local machine**; node
   *   offline throw 409 node_offline, old edition daemon without this method throw 501
   *   path_usage_not_supported, can observability set inside non- permission class exception or cap trigger when return
   *   complete=false(caller must fail-closed, never when 0 occupy); permission
   *   cannot observability process (across uid or non-dumpable, such as systemd --user) count
   *   unobservable and in diagnostics such as present (does not affect complete, and Hub
   *   same uid ordinary can rotate store process forever can observability);
   * - non- Linux platform explicit not_supported(HelmError path_usage_not_supported).
   */
  inspectPathUsage(nodeId: string, path: string, signal?: AbortSignal): Promise<NodePathUsage>
  /**
   * release a certain conversation all target cache: only remove bases item (never invoke cleanup kill
   * the conversation in-flight command - - in-flight exec/reader hold old instance self however complete, see file head note release).
   * conversation delete or modify nodeId/cwd when invoke.
   */
  evictConversation(conversationId: number): void
  /** when before target cache item count (diagnose/test inside omit; does not participate business logic). */
  debugBaseCount(): number
  /** all bottom seat purpose only read diagnose (test/observability use; does not participate business logic). */
  debugBases(): EnvTargetSnapshot[]
  /** dispose: remote env clean up + register table close; idempotent; single failed such as record not silently. */
  dispose(): Promise<void>
}

/**
 * RPC boundary outside node snapshot strictly validate (AGENTS.md boundary schema discipline; illegal shape/
 * and request do not related join/self each other contradiction snapshot explicit reject, never part adopt message - - node return other
 * directory empty snapshot cannot use act this directory clean up based on).
 */
function validatePathUsageSnapshot(nodeId: string, expectedPath: string, value: unknown): NodePathUsage {
  const fail = (reason: string): HelmError =>
    new HelmError('node_path_usage_failed', `node ${nodeId} return process occupy snapshot illegal (${reason}), reject adopt message`, 502, {
      nodeId,
      expectedPath,
    })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('non- object')
  const v = value as Record<string, unknown>
  // and request related: snapshot must back visible archive one after target path (guard against take wrong snapshot fill when this directory based on).
  if (v['path'] !== expectedPath) {
    throw fail(`path and request do not symbol (expectation ${JSON.stringify(expectedPath)}, receives ${JSON.stringify(String(v['path']))})`)
  }
  if (!Array.isArray(v['processes'])) throw fail('processes non- array')
  if (v['processes'].length > 512) throw fail('processes exceeds together cap 512')
  const processes: NodePathUsageProcess[] = []
  const seenPids = new Set<number>()
  for (const raw of v['processes']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('processes item non- object')
    const p = raw as Record<string, unknown>
    if (!Number.isSafeInteger(p['pid']) || (p['pid'] as number) <= 0) throw fail('pid non- positive integer')
    if (seenPids.has(p['pid'] as number)) throw fail(`processes contains duplicate PID ${p['pid']}(same process many reference should dedupe)`)
    seenPids.add(p['pid'] as number)
    if (p['source'] !== 'cwd' && p['source'] !== 'fd') throw fail('source non- cwd|fd')
    if (typeof p['path'] !== 'string' || p['path'] === '') throw fail('process path non- non-empty string')
    if (p['name'] !== undefined && typeof p['name'] !== 'string') throw fail('name non- string')
    processes.push({
      pid: p['pid'] as number,
      ...(p['name'] !== undefined ? { name: p['name'] as string } : {}),
      source: p['source'] as 'cwd' | 'fd',
      path: p['path'] as string,
    })
  }
  if (!Number.isSafeInteger(v['matchedTotal']) || (v['matchedTotal'] as number) < 0) throw fail('matchedTotal non- non- negative integer')
  const matchedTotal = v['matchedTotal'] as number
  if (typeof v['processesTruncated'] !== 'boolean') throw fail('processesTruncated non- boolean')
  const truncated = v['processesTruncated'] as boolean
  // counter and manifest self consult: total count must not less than manifest count; truncate means total count greater than manifest count; not truncate
  // when two must each other etc. (such as truncated=true while matchedTotal=0 is contradiction).
  if (matchedTotal < processes.length) throw fail(`matchedTotal(${matchedTotal}) less than manifest count(${processes.length})`)
  if (truncated && matchedTotal <= processes.length) {
    throw fail(`processesTruncated=true but matchedTotal(${matchedTotal}) not exceeds manifest count(${processes.length})`)
  }
  if (!truncated && matchedTotal !== processes.length) {
    throw fail(`not truncate but matchedTotal(${matchedTotal}) and manifest count(${processes.length})inconsistent`)
  }
  if (typeof v['complete'] !== 'boolean') throw fail('complete non- boolean')
  // permission cannot observability (across uid or non-dumpable) blind spot counter: store in when must be non- negative
  // security integer; default by 0 adopt message (old node any durable reject all report complete=false,
  // default 0 semantics security - - will not blind spot disguise into complete and zero blind spot clean snapshot).
  if (v['unobservable'] !== undefined && (!Number.isSafeInteger(v['unobservable']) || (v['unobservable'] as number) < 0)) {
    throw fail('unobservable non- non- negative integer')
  }
  const unobservable = (v['unobservable'] as number | undefined) ?? 0
  if (!Array.isArray(v['diagnostics'])) throw fail('diagnostics non- array')
  if (v['diagnostics'].length > 128) throw fail('diagnostics exceeds together cap 128')
  if (v['diagnostics'].some((d) => typeof d !== 'string')) throw fail('diagnostics item non- string')
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
  // **bottom seat by conversation target cache**: only envForTarget(carries conversationId) use - -
  // conversation lifecycle has boundary (evictConversation release). without conversation target each time creates new.
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

  /** baseKey conversation segment. */
  const conversationIdOfKey = (key: string): number | undefined => {
    const part = key.split('\u0000')[2]
    return part !== undefined && part !== '-' && /^\d+$/.test(part) ? Number(part) : undefined
  }

  /** without cache creates new bottom seat:local process inside direct create; remote Remote(sink by exec lifecycle self manage). */
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

  /** take (or create) conversation target dedicated belong bottom seat (only carries conversationId target enter cache). */
  const baseFor = (nodeId: string, cwd: string, conversationId: number): ExecutionEnv => {
    const key = baseKey(nodeId, cwd, conversationId)
    let entry = bases.get(key)
    if (entry === undefined) {
      entry = freshBase(nodeId, cwd)
      bases.set(key, entry)
    }
    return entry
  }

  /** wait for node online rpc(IPC bridge shared use; without waiting reconnect, offline i.e. explicit errors). */
  const requireRpc = async (nodeId: string, signal?: AbortSignal): Promise<NodeEnvRpcFunctions> => {
    if (signal?.aborted) throw new HelmError('aborted', 'IPC invoke cancelled', 499)
    const rpc = registry.getNodeEnvRpc(nodeId)
    if (rpc !== undefined) return rpc
    throw new HelmError('node_offline', `node ${nodeId} offline, cannot establish IPC channel`, 409, { nodeId })
  }

  return {
    registry,
    hubPlatform,
    envFor(nodeId: string, cwd: string): ExecutionEnv {
      // without conversation short lifecycle object: never cache (same cwd reverse re- use also do not heap accumulate instance).
      return freshBase(nodeId, cwd)
    },

    envForTarget(target: EnvTarget): ScopedExecutionEnv {
      // target dedicated belong bottom seat + conversation option effect domain: the same (nodeId,cwd) two conversation bottom seat
      // instance independent (cwd mutual do not pollute), option each live together into. without conversationId 
      // target does not enter cache (short lifecycle;fail-closed do not inject secret).
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
        throw new HelmError('ipc_not_supported', `node ${nodeId} daemon unsupported local machine IPC invoke`, 501, {
          nodeId,
        })
      }
      const callId = input.callId ?? `ipc-${randomUUID()}`
      // signal abort when exhaust force destroy in-flight invoke (node side immediately close underlying socket).
      const onAbort = () => {
        void ipcAbort?.(callId).catch(() => undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC invoke cancelled', 499) }
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
        throw new HelmError('ipc_not_supported', `node ${nodeId} daemon unsupported local machine IPC subscribe`, 501, {
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
          // subscribe call back fault does not affect fabric.
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
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC subscribe cancelled', 499) }
      if (!result.ok) {
        closed = true
        finish(result.error.message)
        // upgrade arrange empty refuse new: node state condition, throw stable node_draining(503) - - and
        // ipc_subscribe_failed(node feature can layer failed) zone, do not swallow into ordinary failed.
        if (result.error.code === 'node_draining') {
          throw new HelmError(
            'node_draining',
            `node ${nodeId} is now upgrade arrange empty, reject new IPC subscribe:${result.error.message}`,
            503,
            { nodeId },
          )
        }
        throw new HelmError('ipc_subscribe_failed', `node ${nodeId} IPC failed to subscribe:${result.error.message}`, 502, {
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
      // local and Hub same process; test inject hubPlatform proxy table subject to control Hub fact.
      // remote only take register register platform(not on report/offline → undefined, by caller by
      // platform unknown semantics handle, never proxy guess).
      if (nodeId === 'local') return hubPlatform()
      const platform = registry.get(nodeId)?.platform
      return platform === undefined || platform === '' ? undefined : platform
    },

    async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
      const { host, port } = normalizeTunnelTarget(target)
      if (signal?.aborted) {
        throw new HelmError('aborted', 'tunnel establish cancelled', 499, { nodeId })
      }
      if (closing.signal.aborted) {
        throw new HelmError('node_offline', 'node tunnel service already close', 409, { nodeId })
      }
      // local also must reference and closure stop: including await connect during not yet return socket.
      if (nodeId === 'local') {
        const connectSignal = signal === undefined ? closing.signal : AbortSignal.any([signal, closing.signal])
        const duplex = await connectLocalTunnel(host ?? '127.0.0.1', port, connectSignal)
        if (closing.signal.aborted || signal?.aborted) {
          duplex.destroy()
          throw new HelmError('aborted', 'tunnel establish cancelled', 499, { nodeId })
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
      if (signal?.aborted) throw new HelmError('aborted', 'process occupy scan cancelled', 499, { nodeId })
      // first confirm actual node platform;Windows legal symbol path cannot by mistakenly report is illegal POSIX
      // path. unsupported platform explicit reject; remote offline still first report node cannot reach.
      const rpc = nodeId === 'local' ? undefined : await requireRpc(nodeId, signal)
      const platform = nodeId === 'local' ? hubPlatform() : registry.get(nodeId)?.platform
      if (platform && platform !== 'linux') {
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} platform '${platform}' unsupported process occupy scan (when before only Linux /proc), cannot verify target path 0 occupy`,
          501,
          { nodeId, platform },
        )
      }
      // support platform unify archive one target path, and and RPC snapshot back visible related.
      const normalized = validatePosixScanPath(targetPath)
      if (!normalized.ok) {
        throw new HelmError('validation_error', `process occupy scan reference illegal:${normalized.message}`, 400, { nodeId })
      }
      const expectedPath = normalized.value
      if (nodeId === 'local') {
        // Hub process inside real scan (platform via hubPlatform port, test can inject;
        // produce is process.platform, never fabricate).fs adapt and remote daemon shared use
        // @helm/env-io the same implement, never each duplicate one set fs semantics.
        const io = createNodePathUsageIo()
        const result = await scanPathUsage(expectedPath, {
          io,
          platform: hubPlatform(),
          signal,
        })
        if (result.ok) return result.value
        const { code, message } = result.error
        if (code === 'invalid') throw new HelmError('validation_error', `process occupy scan reference illegal:${message}`, 400, { nodeId })
        if (code === 'permission_denied') {
          throw new HelmError(
            'node_path_usage_failed',
            `local machine process occupy scan failed (permission do not enough):${message}`,
            502,
            { nodeId, code: 'permission_denied' },
          )
        }
        if (code === 'not_supported') {
          throw new HelmError(
            'path_usage_not_supported',
            `this Hub platform '${hubPlatform()}' unsupported process occupy scan (when before only Linux /proc; do not fabricate across platform result), cannot verify target path 0 occupy`,
            501,
            { nodeId, platform: hubPlatform() },
          )
        }
        if (code === 'aborted') throw new HelmError('aborted', message, 499, { nodeId })
        throw new HelmError('node_path_usage_failed', `local machine process occupy scan failed:${message}`, 502, { nodeId })
      }
      // remote: target node real scan, never fall back local machine.
      const fn = rpc!.envPathUsage
      if (fn === undefined) {
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} daemon unsupported envPathUsage(version old?), cannot verify target path 0 occupy; never fall back local machine scan`,
          501,
          { nodeId },
        )
      }
      // birpc may with undefined compute (gateway absorb old edition daemon missing method error): type on explicit contains undefined.
      let result: RpcResult<import('@helm/protocol').NodePathUsage> | undefined
      try {
        result = await fn({ path: expectedPath })
      } catch (error) {
        // birpc proxy make any method access all is function: old edition daemon missing this method when, invoke
        // withfunction not foundreject - - such as archive class is unsupported (501), never disguise
        // into scan failed or fall back local machine; transfer/timeout etc. other error still is 502.
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('[birpc] function') && message.includes('not found')) {
          throw new HelmError(
            'path_usage_not_supported',
            `node ${nodeId} daemon unsupported envPathUsage(version old?), cannot verify target path 0 occupy; never fall back local machine scan`,
            501,
            { nodeId, cause: message },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} process occupy scan failed to invoke:${message}`,
          502,
          { nodeId, cause: message },
        )
      }
      if (result === undefined || result === null) {
        // old edition daemon without envPathUsage:birpc via gateway onGeneralError absorb after
        // with undefined compute - - such as archive class unsupported (501), never fall back local machine, never when act empty snapshot.
        throw new HelmError(
          'path_usage_not_supported',
          `node ${nodeId} daemon unsupported envPathUsage(version old?), cannot verify target path 0 occupy; never fall back local machine scan`,
          501,
          { nodeId },
        )
      }
      // RPC message seal strictly validate:ok must strictly boolean; failed branch error must carry legal
      // code/message- - illegal message seal explicit node_path_usage_failed, never rely after continue
      // property access TypeError fall back.
      const envelope = result as { ok?: unknown; value?: unknown; error?: unknown }
      if (typeof envelope.ok !== 'boolean') {
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} process occupy scan return illegal message seal (ok non- strictly boolean, protocol violate reverse)`,
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
            `node ${nodeId} process occupy scan return illegal error message seal (missing legal code/message, protocol violate reverse)`,
            502,
            { nodeId },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `node ${nodeId} process occupy scan failed (${e.code}: ${e.message})`,
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
      // short lifecycle bottom seat: queue in process level Map(key contains env.id), independent of instance cache,
      // and tools.ts remote branch envFor instance sharing the same key empty between.
      const env = freshBase(target.nodeId, target.cwd)
      const context: Context = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
      return envWithFileMutationQueue(env, target.path, fn, context)
    },

    evictConversation(conversationId: number): void {
      // only remove cache item: never invoke entry.cleanup- -NodeExecutionEnv.cleanup
      // will kill activeChildPids(the conversation in-flight command by mistakenly kill),Remote by cwd
      // envCleanup will kill same cwd other conversation command. in-flight operation hold old instance reference self however
      // complete, instance then can GC; cache do not increase long.
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
      // first close node connect, let in-flight request by unknown terminal state end; offline clean up without waiting reconnect.
      await registry.close()
      // again one by one target hard clean up (dispose is closure stop semantics, kill in-flight command is pre- phase;Remote 
      // cleanup only deregister itself sink, do not by cwd  envCleanup- - that will mistakenly kill same node
      // same cwd other conversation command, node side in-flight command by connect level dispose fall back).
      const entries = [...bases]
      bases.clear()
      for (const [key, entry] of entries) {
        const [nodeId, cwd] = key.split('\u0000')
        entry
          .cleanup(BACKGROUND_CONTEXT)
          .catch((error: unknown) =>
            logReleaseError(
              `bottom seat clean up failed (node=${nodeId} cwd=${cwd}):${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      }
      // registry.close already in open head execute and idempotent internal converge; does not repeat invoke second time.
    },
  }
}

