/**
 * Managed node daemon: persistent node identity + per-generation WS+birpc connection lifecycle.
 *
 * - Identity: `<dataDir>/node.json` (`nodeId` + `token`, mode `0600`, strictly validated).
 *   Supplied via Hub JOIN token (`nodeId:secret`, excluding `local`) or explicit `identity` option.
 * - Connection generations: every WebSocket attempt creates an isolated generation (`EnvRpcServer` +
 *   `birpc`). Handshake/register/heartbeat failures all retire that generation idempotently
 *   (`hubRpc.$close()`, `server.dispose()`, `socket.terminate()`), ensuring callbacks from retired
 *   generations never mutate newer state.
 * - Heartbeat: budget = `clamp(interval * 3 / 4, 1s, 30s)`, non-overlapping; 2 consecutive timeouts
 *   or an explicit `false` reply retire the generation and trigger reconnect.
 * - Managed `helm` CLI PATH: locates the local `helm` binary directory and prepends it to `PATH`
 *   for remote shells; fails explicitly at startup if missing.
 * - Reconnect: exponential backoff (default 500ms..30s), unbounded retries, cancelled cleanly on
 *   `close()` which waits for all retiring generations to finish disposing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeConnectInput,
  NodeEnvRpcFunctions,
  NodeHealthSnapshot,
  NodeHeartbeatInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeRegisterInput,
  NodeRegisterResult,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeCommit,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
  RpcEnvError,
  RpcResult,
} from '@helm/protocol';
import { DEFAULT_NODE_ID } from '@helm/protocol';
import { atomicWriteJson, findEnvKey, getEnvEntry, prependEnvPath, setEnvEntry } from '@helm/env-io';
import { createNodeEnvRpcServer, type NodeEnvRpcServer, type NodeEnvRpcServerOptions } from './env-rpc-server.js';
import { createSocketBirpcEvents } from './birpc-events.js';
import {
  UpgradeCommitUnconfirmedError,
  UpgradeRejectedError,
  checkNodeUpgrade,
  filterRpcRegistryUrl,
  getNodeVersion,
  performNodeUpgrade,
  type PerformNodeUpgradeOptions,
} from './upgrader.js';

/** Hub-side RPC functions invoked by the node daemon (`register`, `heartbeat`, event streams). */
export interface HubSideFunctions {
  register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>;
  onEnvExecOutput(event: EnvExecOutputEvent): Promise<void> | void;
  onIpcEvent?(event: NodeIpcEvent): Promise<void> | void;
  onIpcClosed?(event: NodeIpcClosedEvent): Promise<void> | void;
}

export interface NodeIdentity {
  nodeId: string;
  token: string;
  /** Hub URL recorded at bind time (informational hint; callers may override via `hubUrl`). */
  hubUrl?: string;
}

export interface NodeDaemonOptions {
  hubUrl: string;
  identity: NodeIdentity;
  dataDir: string;
  /** Env RPC server options (`defaultCwd` defaults to `dataDir`). */
  envServer?: Omit<NodeEnvRpcServerOptions, 'defaultCwd' | 'onExecOutput' | 'onIpcEvent' | 'onIpcClosed'>;
  /** Base reconnect delay in ms (defaults to 500). */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect delay in ms (defaults to 30_000). */
  reconnectMaxDelayMs?: number;
  /** Log sink (defaults to `console.error`). Never logs secret tokens. */
  log?: (message: string) => void;
  /**
   * Managed-host upgrade hook: launches a candidate daemon from a staged release and returns a
   * `{ pid, commit, abort }` handle. Omitting this causes `nodeUpgrade` to fail with `not_supported`.
   */
  prepareUpgradeReplacement?: PerformNodeUpgradeOptions['prepareReplacement'];
  /** Called with replacement PID after upgrade commit (or unconfirmed commit) so the old host exits. */
  onUpgradeReplaced?: (pid: number) => void;
  /** Upgrade attempt ID sent on registration for candidate reconciliation on the Hub. */
  upgradeAttemptId?: string;
  /** Candidate pending-activation mode: starts draining until `confirmUpgrade` verifies activation. */
  pendingActivation?: boolean;
}

export interface NodeDaemon {
  readonly identity: NodeIdentity;
  readonly hubUrl: string;
  /** Returns true if currently connected and registered with the Hub. */
  isConnected(): boolean;
  /**
   * Resolves `true` immediately if already online, or waits for the next registration outcome
   * (`true` on success; `false` on close, disconnect, rejection, or timeout).
   */
  waitUntilRegistered(timeoutMs?: number): Promise<boolean>;
  /** Disconnect, dispose all active generation servers, clear timers, and wait for cleanup. Idempotent. */
  close(): Promise<void>;
  /** Check available upgrades (throws an Error with `.code` on failure). `trustedRegistry=true` is CLI-only. */
  checkUpgrade(input?: NodeUpgradeCheckInput, trustedRegistry?: boolean): Promise<NodeUpgradeCheckResult>;
  /** Trigger self-upgrade (drain -> stage -> replace -> commit/rollback); throws `.code='not_supported'` if unmanaged. */
  upgrade(input?: NodeUpgradeRpcInput, trustedRegistry?: boolean): Promise<NodeUpgradeResult>;
  /** Candidate local activation confirmation; records commit and pushes heartbeat asynchronously. */
  confirmUpgrade(commit: NodeUpgradeCommit): Promise<void>;
  /** True while an upgrade is in flight or committed awaiting host exit. */
  isUpgrading(): boolean;
}

const CONNECT_TIMEOUT_MS = 10_000;
const REGISTER_TIMEOUT_MS = 15_000;
const HEARTBEAT_BUDGET_MIN_MS = 1_000;
const HEARTBEAT_BUDGET_MAX_MS = 30_000;
const CLOSE_SETTLE_TIMEOUT_MS = 10_000;
const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_FIRST_FRAME_TIMEOUT_MS = 15_000;
const TUNNEL_FIRST_FRAME_MAX_BYTES = 64 * 1024;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JOIN_SECRET_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

/** Resolve node data directory: explicit > `HELM_DATA_DIR` > `~/.helm`. */
export function resolveNodeDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = process.env['HELM_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.helm');
}

/**
 * Collect read-only host health metrics (`uptime`, `loadavg`, memory, and disk via `fs.statfs`,
 * falling back to `homedir` if `targetDir` does not exist yet and omitting disk fields if unavailable).
 */
export async function collectNodeHealth(targetDir?: string): Promise<NodeHealthSnapshot> {
  const load = os.loadavg();
  const snapshot: NodeHealthSnapshot = {
    collectedAt: Date.now(),
    uptimeSec: os.uptime(),
    loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memFreeBytes: os.freemem(),
    memTotalBytes: os.totalmem(),
  };
  try {
    const dir = targetDir ?? os.homedir();
    let stats: { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };
    try {
      stats = await fs.statfs(dir);
    } catch {
      stats = await fs.statfs(os.homedir());
    }
    snapshot.diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    snapshot.diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // `statfs` unavailable on this platform/path; omit disk fields rather than interrupting heartbeats.
  }
  return snapshot;
}

/**
 * Parse a JOIN token (`nodeId:secret`); `nodeId` excludes colons and the reserved `'local'` ID,
 * while `secret` may contain colons (split on the first colon).
 */
export function parseJoinToken(token: string): { nodeId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  if (token !== token.trim()) return null;
  const index = token.indexOf(':');
  if (index <= 0 || index === token.length - 1) return null;
  const nodeId = token.slice(0, index);
  const secret = token.slice(index + 1);
  if (!NODE_ID_PATTERN.test(nodeId) || nodeId === DEFAULT_NODE_ID) return null;
  if (!JOIN_SECRET_PATTERN.test(secret)) return null;
  return { nodeId, secret };
}

/** Strictly validate a `NodeIdentity` object. */
function assertValidIdentity(identity: unknown, context: string): asserts identity is NodeIdentity {
  const invalid = (detail: string): Error =>
    new Error(`${context}: ${detail} (expected { nodeId, token[, hubUrl] } with nodeId matching ${NODE_ID_PATTERN})`);
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw invalid('value is not an object');
  }
  const record = identity as Record<string, unknown>;
  if (typeof record['nodeId'] !== 'string' || !NODE_ID_PATTERN.test(record['nodeId']) || record['nodeId'] === DEFAULT_NODE_ID) {
    throw invalid('nodeId is missing or invalid');
  }
  if (typeof record['token'] !== 'string' || parseJoinToken(record['token'])?.nodeId !== record['nodeId']) {
    throw invalid('token is invalid or does not match nodeId');
  }
  if (record['hubUrl'] !== undefined) {
    if (typeof record['hubUrl'] !== 'string') throw invalid('hubUrl must be a string');
    try {
      assertValidHubUrl(record['hubUrl']);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Validate an `http(s)` Hub URL without userinfo, fragment, or query parameters. */
function assertValidHubUrl(hubUrl: string): URL {
  if (typeof hubUrl !== 'string' || hubUrl === '' || hubUrl !== hubUrl.trim()) throw new Error('Hub URL must be a non-empty URL');
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error('Hub URL is malformed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Hub URL protocol must be http or https: ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Hub URL must not contain userinfo (user:pass@)');
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Hub URL must not contain a fragment or query string');
  }
  return parsed;
}

/** Read `<dataDir>/node.json`: returns `null` only on `ENOENT`; throws explicitly on corruption or I/O errors. */
export async function readNodeIdentity(dataDir: string): Promise<NodeIdentity | null> {
  const file = path.join(dataDir, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`node identity file is corrupt (${file}): invalid JSON`);
  }
  try {
    assertValidIdentity(parsed, `node identity file has invalid schema (${file})`);
  } catch (error) {
    throw new Error(`node identity file has invalid schema (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

/** Atomically persist `<dataDir>/node.json` with `0600` permissions via the shared `@helm/env-io` primitive. */
export async function writeNodeIdentity(dataDir: string, identity: NodeIdentity): Promise<void> {
  assertValidIdentity(identity, 'invalid node identity');
  await atomicWriteJson(path.join(dataDir, 'node.json'), identity, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Identity binding lock (in-process queue + cross-process lock file)
// ---------------------------------------------------------------------------

const bindLocks = new Map<string, Promise<unknown>>();

/** Serialize identity binding per `dataDir` via an in-process queue and exclusive `node.json.lock` (`wx`). */
async function withIdentityLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = bindLocks.get(dataDir);
  let releaseInner: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  bindLocks.set(dataDir, gate);
  try {
    if (previous !== undefined) await previous;
  } catch {
    // Prior failure does not block subsequent bind attempts.
  }
  const lockPath = path.join(dataDir, 'node.json.lock');
  let handle: fs.FileHandle | undefined;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(
        `concurrent identity bind conflict: ${lockPath} already exists (another helm-node connect is writing, or a previous bind crashed); confirm no bind is active and remove the lock file before retrying`,
      );
    }
  } catch (error) {
    releaseInner();
    if (bindLocks.get(dataDir) === gate) bindLocks.delete(dataDir);
    throw error;
  }
  try {
    return await fn();
  } finally {
    await handle!.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    releaseInner();
    if (bindLocks.get(dataDir) === gate) bindLocks.delete(dataDir);
  }
}

/**
 * Persist JOIN identity binding: saves new identity, rotates token for the same `nodeId`, or
 * rejects a different `nodeId` explicitly (requires manual cleanup of `node.json`).
 */
export async function bindIdentityFromJoinToken(
  dataDir: string,
  token: string,
  hubUrl: string,
): Promise<NodeIdentity> {
  const parsed = parseJoinToken(token);
  if (parsed === null) {
    throw new Error(`invalid JOIN token format (expected nodeId:secret, nodeId without colons and not 'local'): ${describeToken(token)}`);
  }
  try {
    assertValidHubUrl(hubUrl);
  } catch (error) {
    throw new Error(`JOIN bind failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedDataDir = path.resolve(dataDir);
  return await withIdentityLock(resolvedDataDir, async () => {
    const existing = await readNodeIdentity(resolvedDataDir);
    if (existing !== null && existing.nodeId !== parsed.nodeId) {
      throw new Error(
        `dataDir is already bound to node ${existing.nodeId}, refusing to rebind to ${parsed.nodeId}; remove ${path.join(dataDir, 'node.json')} first if changing nodes`,
      );
    }
    const identity: NodeIdentity = { nodeId: parsed.nodeId, token, hubUrl };
    await writeNodeIdentity(resolvedDataDir, identity);
    return identity;
  });
}

/** Redacted token shape description for error messages (never leaks prefix or secret bytes). */
function describeToken(token: string): string {
  const kind = typeof token !== 'string' ? `type ${typeof token}` : `length ${token.length}`;
  return `token (${kind}) does not match expected format`;
}

/** Parse and bind runtime identity from JOIN token input (never falls back to stale stored identity on bad token). */
async function resolveRunIdentity(dataDir: string, input: NodeConnectInput): Promise<NodeIdentity> {
  if (parseJoinToken(input.token) === null) {
    throw new Error(
      `invalid token, refusing to start (must be a Hub-issued JOIN token nodeId:secret without colons in nodeId, not 'local'): ${describeToken(input.token)}`,
    );
  }
  return bindIdentityFromJoinToken(dataDir, input.token, input.hubUrl);
}

// ---------------------------------------------------------------------------
// Managed `helm` CLI bin directory discovery
// ---------------------------------------------------------------------------

export type ResolvedCliBinDir = { dir: string } | { error: string };

type RegisterOutcome = { kind: 'ack'; result: NodeRegisterResult } | { kind: 'timeout' } | { kind: 'error' };
type HeartbeatOutcome = { kind: 'ack'; alive: boolean } | { kind: 'timeout' };

const statExecutable = async (target: string): Promise<boolean> => {
  try {
    const st = await fs.stat(target);
    if (process.platform === 'win32') return st.isFile();
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * Locate the directory containing the local `helm` CLI binary (prepended to `PATH` for remote bash):
 * explicit arg / `HELM_CLI_BIN_DIR` -> `PATH` -> ancestor `node_modules/.bin`.
 */
export async function resolveManagedHelmBinDir(explicit?: string): Promise<ResolvedCliBinDir> {
  const describe = async (dir: string): Promise<ResolvedCliBinDir> => {
    const entry = process.platform === 'win32' ? path.join(dir, 'helm.cmd') : path.join(dir, 'helm');
    return (await statExecutable(entry)) ? { dir } : { error: `executable helm client not found in ${dir}` };
  };
  if (explicit !== undefined && explicit !== '') return await describe(explicit);
  const fromEnv = process.env['HELM_CLI_BIN_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return await describe(fromEnv);
  const inheritedPath = getEnvEntry(process.env, 'PATH') ?? '';
  for (const entry of inheritedPath.split(path.delimiter)) {
    if (!entry) continue;
    const result = await describe(entry);
    if ('dir' in result) return result;
  }
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = selfDir, depth = 0; dir !== path.dirname(dir) && depth < 16; dir = path.dirname(dir), depth += 1) {
    const candidate = path.join(dir, 'node_modules', '.bin');
    const result = await describe(candidate);
    if ('dir' in result) return result;
  }
  return {
    error:
      'unable to locate local helm client bin directory (remote bash cannot invoke helm). ' +
      'Install the standalone helm client on PATH or set HELM_CLI_BIN_DIR=<dir containing helm executable>',
  };
}

/** Prepend `binDir` to `PATH` inside `shellEnv` while preserving Windows host `Path` casing. */
const prependPath = (binDir: string, shellEnv: Record<string, string | undefined>): Record<string, string | undefined> => {
  const next: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) setEnvEntry(next, key, value);
  }
  if (findEnvKey(next, 'PATH') === undefined) {
    const inherited = getEnvEntry(process.env, 'PATH');
    if (inherited !== undefined) {
      const hostKey = findEnvKey(process.env, 'PATH') ?? 'PATH';
      setEnvEntry(next, hostKey, inherited);
    }
  }
  prependEnvPath(next, binDir);
  return next;
};

async function withinBudget<T>(operation: Promise<T>, timeoutMs: number, expired: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(expired), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createNodeDaemon(options: NodeDaemonOptions): Promise<NodeDaemon> {
  const {
    hubUrl,
    identity,
    dataDir,
    envServer = {},
    reconnectBaseDelayMs = 500,
    reconnectMaxDelayMs = 30_000,
    log: writeLog = (message) => console.error(`[helm-node] ${message}`),
  } = options;

  assertValidIdentity(identity, 'invalid node identity');
  const log = (message: string): void => writeLog(message.replaceAll(identity.token, '[REDACTED]'));
  const hub = assertValidHubUrl(hubUrl);

  const tunnelWsUrl = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${hub.pathname.replace(/\/+$/, '')}/ws/node-tunnel`;

  /**
   * Open a tunnel WebSocket stream bound to `gen`: sends `{ nodeId, token, tunnelId }`, validates the
   * `NodeTunnelControl` response frame (`type === 'ok'`), and resolves with `createWebSocketStream(ws)`.
   */
  const openTunnelStreamFor = (
    gen: NonNullable<typeof generation>,
  ): ((tunnelId: string, signal?: AbortSignal) => Promise<Duplex>) =>
  (tunnelId, signal): Promise<Duplex> => {
    if (closed || generation !== gen || gen.registered !== true) {
      return Promise.reject(
        Object.assign(new Error('tunnel transport unavailable (connection generation retired)'), { code: 'aborted' }),
      );
    }
    return new Promise<Duplex>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket | undefined;
      let connectTimer: NodeJS.Timeout | undefined;
      let frameTimer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const guardError = (err: Error): void => {
        if (settled) {
          try {
            ws?.terminate();
          } catch {
            // Already destroyed.
          }
          return;
        }
        cleanup(err);
      };
      const cleanup = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        if (frameTimer !== undefined) clearTimeout(frameTimer);
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        ws?.removeAllListeners('message');
        ws?.removeAllListeners('open');
        ws?.removeListener('error', guardError);
        ws?.once('error', () => {
          try {
            ws?.terminate();
          } catch {
            // Already destroyed.
          }
        });
        if (signal?.aborted) ws?.terminate();
        else {
          try {
            ws?.close();
          } catch {
            ws?.terminate();
          }
        }
        reject(
          error ??
            Object.assign(
              new Error('tunnel WebSocket closed before handshake completed'),
              { code: 'aborted' },
            ),
        );
      };
      connectTimer = setTimeout(() => {
        cleanup(Object.assign(new Error(`tunnel WS connect timed out after ${TUNNEL_CONNECT_TIMEOUT_MS}ms`), { code: 'timeout' }));
      }, TUNNEL_CONNECT_TIMEOUT_MS);
      frameTimer = setTimeout(() => {
        cleanup(Object.assign(new Error(`tunnel control frame timed out after ${TUNNEL_FIRST_FRAME_TIMEOUT_MS}ms`), { code: 'timeout' }));
      }, TUNNEL_FIRST_FRAME_TIMEOUT_MS);
      onAbort = (): void => {
        cleanup(Object.assign(new Error('tunnel handshake aborted'), { code: 'aborted' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        ws = new WebSocket(tunnelWsUrl);
      } catch (error) {
        cleanup(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ws.on('error', guardError);
      ws.once('open', () => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        if (settled) return;
        ws!.send(JSON.stringify({ nodeId: identity.nodeId, token: identity.token, tunnelId }));
      });
      const onMessage = (raw: unknown): void => {
        if (settled) return;
        let frame: unknown;
        try {
          const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
          if (Buffer.byteLength(text, 'utf8') > TUNNEL_FIRST_FRAME_MAX_BYTES) {
            cleanup(Object.assign(new Error('tunnel control frame exceeds 64KiB limit'), { code: 'invalid' }));
            return;
          }
          frame = JSON.parse(text);
        } catch {
          cleanup(Object.assign(new Error('tunnel control frame is not valid JSON'), { code: 'invalid' }));
          return;
        }
        const record = frame as { type?: unknown; message?: unknown } | null;
        if (frame === null || typeof frame !== 'object' || typeof record?.type !== 'string') {
          cleanup(Object.assign(new Error('tunnel control frame is not a JSON object'), { code: 'invalid' }));
          return;
        }
        if (frameTimer !== undefined) clearTimeout(frameTimer);
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        ws!.removeListener('message', onMessage);
        if (record.type === 'ok') {
          settled = true;
          resolve(createWebSocketStream(ws!));
          return;
        }
        const detail = typeof record.message === 'string' ? record.message : JSON.stringify(frame).slice(0, 200);
        settled = true;
        try {
          ws!.close();
        } catch {
          ws!.terminate();
        }
        reject(
          Object.assign(new Error(`tunnel handshake rejected: ${detail}`), {
            code: record.type === 'timeout' ? 'timeout' : 'invalid',
          }),
        );
      };
      ws.on('message', onMessage);
      ws.once('close', () => cleanup());
    });
  };

  const cliBin = await resolveManagedHelmBinDir(envServer.shellEnv?.['HELM_CLI_BIN_DIR'] as string | undefined);

  let closed = false;
  let generation:
    | {
        server: NodeEnvRpcServer;
        hubRpc: BirpcReturn<HubSideFunctions, NodeEnvRpcFunctions>;
        socket: WebSocket;
        heartbeatTimer: NodeJS.Timeout | undefined;
        connectTimeout?: NodeJS.Timeout;
        registered: boolean;
        disposePromise?: Promise<void>;
      }
    | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = reconnectBaseDelayMs;
  const settlingDisposes = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];

  const registerWaiters = new Set<(ok: boolean) => void>();

  const confirmOffline = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(false);
  };

  const announceRegistered = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(true);
  };

  const scheduleReconnect = (): void => {
    if (closed || connectTimer !== undefined) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectMaxDelayMs, reconnectDelay * 2);
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      connect();
    }, delay);
  };

  const clearHeartbeat = (gen: NonNullable<typeof generation>): void => {
    if (gen.heartbeatTimer !== undefined) {
      clearInterval(gen.heartbeatTimer);
      gen.heartbeatTimer = undefined;
    }
  };

  /** Retire a single connection generation idempotently without disturbing newer generations. */
  const retireGeneration = (gen: NonNullable<typeof generation>): Promise<void> => {
    if (gen.disposePromise) return gen.disposePromise;
    clearHeartbeat(gen);
    clearTimeout(gen.connectTimeout);
    gen.registered = false;
    try {
      gen.hubRpc.$close();
    } catch {
      // Already closed.
    }
    if (gen.socket.readyState === WebSocket.OPEN || gen.socket.readyState === WebSocket.CONNECTING) {
      try {
        gen.socket.terminate();
      } catch {
        // Ignore.
      }
    }
    const dispose = gen.server
      .dispose()
      .catch((error: unknown) => {
        cleanupErrors.push(error);
        log('failed to clean up node connection resources');
      })
      .finally(() => {
        settlingDisposes.delete(dispose);
      });
    gen.disposePromise = dispose;
    settlingDisposes.add(dispose);
    if (generation === gen) {
      generation = undefined;
      confirmOffline();
    }
    return dispose;
  };

  let upgradeInFlight: Promise<RpcResult<NodeUpgradeResult>> | undefined;
  let upgradeActive = false;
  let upgradeCommit: NodeUpgradeCommit | undefined;
  let suspendReconnect = false;
  let drainingGlobally = options.pendingActivation === true;
  const applyDraining = (value: boolean): void => {
    drainingGlobally = value;
    generation?.server.setDraining(value);
  };

  /** Push an immediate heartbeat carrying `upgradeCommit` on the current registered generation (no-op if offline). */
  const pushHeartbeatSoon = (withCommit: boolean): void => {
    const gen = generation;
    if (gen === undefined || !gen.registered || gen.heartbeatTimer === undefined) return;
    const beat = (async () => {
      const health = await collectNodeHealth(dataDir).catch(() => undefined);
      const input: NodeHeartbeatInput = {
        ...(health !== undefined ? { health } : {}),
        ...(withCommit && upgradeCommit !== undefined ? { upgradeCommit } : {}),
      };
      await gen.hubRpc.heartbeat(identity.nodeId, input).catch(() => false);
    })();
    void beat.catch(() => undefined);
  };

  const parseUpgradeAttemptId = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '' || value.length > 128) {
      throw Object.assign(new Error(`invalid upgradeAttemptId: ${JSON.stringify(value)}`), { code: 'invalid' });
    }
    return value;
  };

  const assertUpgradeCheckInput = (input: unknown): NodeUpgradeCheckInput | undefined => {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Object.assign(new Error('input must be an object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['registryUrl']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field: ${key}`), { code: 'invalid' });
    }
    if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
      throw Object.assign(new Error('registryUrl must be a string'), { code: 'invalid' });
    }
    return record as NodeUpgradeCheckInput;
  };

  const assertUpgradeRpcInput = (input: unknown): NodeUpgradeRpcInput | undefined => {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Object.assign(new Error('input must be an object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['targetVersion', 'registryUrl', 'force', 'attemptId']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field: ${key}`), { code: 'invalid' });
    }
    if (record['targetVersion'] !== undefined && typeof record['targetVersion'] !== 'string') {
      throw Object.assign(new Error('targetVersion must be a string'), { code: 'invalid' });
    }
    if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
      throw Object.assign(new Error('registryUrl must be a string'), { code: 'invalid' });
    }
    if (record['force'] !== undefined && typeof record['force'] !== 'boolean') {
      throw Object.assign(new Error('force must be a boolean'), { code: 'invalid' });
    }
    if (record['attemptId'] !== undefined) parseUpgradeAttemptId(record['attemptId']);
    return record as NodeUpgradeRpcInput;
  };

  const assertUpgradeCommit = (input: unknown): NodeUpgradeCommit => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw Object.assign(new Error('commit must be an object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['attemptId', 'version', 'previousVersion', 'pid']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field: ${key}`), { code: 'invalid' });
    }
    const attemptId = parseUpgradeAttemptId(record['attemptId']);
    if (attemptId === undefined) throw Object.assign(new Error('attemptId is missing or invalid'), { code: 'invalid' });
    for (const key of ['version', 'previousVersion'] as const) {
      const value = record[key];
      if (typeof value !== 'string' || value === '' || value.length > 128) {
        throw Object.assign(new Error(`${key} must be a non-empty string`), { code: 'invalid' });
      }
    }
    if (typeof record['pid'] !== 'number' || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0) {
      throw Object.assign(new Error('pid must be a positive integer'), { code: 'invalid' });
    }
    return {
      attemptId,
      version: record['version'] as string,
      previousVersion: record['previousVersion'] as string,
      pid: record['pid'],
    };
  };

  const startConnect = (): void => {
    const wsUrl = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${hub.pathname.replace(/\/+$/, '')}/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}`;

    const socket = new WebSocket(wsUrl);
    const genHandle: { current?: NonNullable<typeof generation> } = {};
    const server = createNodeEnvRpcServer({
      defaultCwd: dataDir,
      ...envServer,
      shellEnv: baseShellEnv,
      onExecOutput: (event) => pushEvent('onEnvExecOutput', event),
      onIpcEvent: (event) => pushEvent('onIpcEvent', event),
      onIpcClosed: (event) => pushEvent('onIpcClosed', event),
      openTunnelStream: (tunnelId: string, signal?: AbortSignal) => {
        const gen = genHandle.current;
        if (gen === undefined) {
          return Promise.reject(
            Object.assign(new Error('tunnel transport unavailable (connection generation retired)'), { code: 'aborted' }),
          );
        }
        return openTunnelStreamFor(gen)(tunnelId, signal);
      },
    });
    if (drainingGlobally) server.setDraining(true);
    const hubRpc = createBirpc<HubSideFunctions, NodeEnvRpcFunctions>(
      // Mount upgrade RPCs outside env server's `pendingOperations` guard to prevent self-deadlock on dispose.
      Object.assign(Object.create(null), server, {
        async nodeCheckUpgrade(input: NodeUpgradeCheckInput): Promise<RpcResult<NodeUpgradeCheckResult>> {
          return await daemonCheckUpgrade(input, false);
        },
        async nodeUpgrade(input: NodeUpgradeRpcInput): Promise<RpcResult<NodeUpgradeResult>> {
          return await daemonUpgrade(input, false);
        },
      }),
      {
        post: (data) => {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error(`[birpc] cannot send on non-OPEN WS (readyState=${socket.readyState})`);
          }
          socket.send(JSON.stringify(data));
        },
        onGeneralError: (error, functionName) => {
          log(`RPC send failed (${functionName ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
          onGone('RPC transport failed');
          return true;
        },
        ...createSocketBirpcEvents(socket, (message) => {
          log(`${message}; terminating connection`);
          onGone('invalid frame');
        }),
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30 * 60 * 1000,
      },
    );

    const gen: NonNullable<typeof generation> = {
      server,
      hubRpc,
      socket,
      heartbeatTimer: undefined,
      registered: false,
    };
    generation = gen;
    genHandle.current = gen;
    let gone = false;

    const onGone = (reason: string): void => {
      if (gone || generation !== gen) return;
      gone = true;
      clearTimeout(connectTimeout);
      const dispose = retireGeneration(gen);
      gen.disposePromise = dispose;
      log(`connection closed (${reason}), ${closed ? 'stopped' : 'reconnecting'}`);
      scheduleReconnect();
    };

    function pushEvent(method: 'onEnvExecOutput' | 'onIpcEvent' | 'onIpcClosed', event: EnvExecOutputEvent | NodeIpcEvent | NodeIpcClosedEvent): void {
      if (generation !== gen) return;
      const fn = gen.hubRpc[method];
      if (!fn) {
        onGone('stream callback unavailable');
        throw new Error('Hub does not support node streaming callback');
      }
      try {
        void Promise.resolve(fn.asEvent(event as never)).catch(() => onGone('stream send failed'));
      } catch (error) {
        onGone('stream send failed');
        throw error;
      }
    }

    const connectTimeout = setTimeout(() => {
      if (generation === gen && !gone) onGone('connect timeout');
    }, CONNECT_TIMEOUT_MS);

    gen.connectTimeout = connectTimeout;

    socket.on('open', () => {
      if (closed || generation !== gen) return;
      clearTimeout(connectTimeout);
      void (async () => {
        const health = await collectNodeHealth(dataDir).catch(() => undefined);
        const ack = await withinBudget<RegisterOutcome>(
          hubRpc.register({
            nodeId: identity.nodeId, token: identity.token,
            hostname: os.hostname(), platform: process.platform, hubUrl,
            version: getNodeVersion(),
            ...(options.upgradeAttemptId !== undefined ? { upgradeAttemptId: options.upgradeAttemptId } : {}),
            ...(health !== undefined ? { health } : {}),
          }).then((result) => ({ kind: 'ack', result })),
          REGISTER_TIMEOUT_MS,
          { kind: 'timeout' },
        ).catch((): RegisterOutcome => ({ kind: 'error' }));
        if (closed || generation !== gen) return;
        if (ack.kind !== 'ack') {
          log(ack.kind === 'timeout' ? 'registration timed out' : 'registration failed (connection interrupted)');
          onGone(ack.kind === 'timeout' ? 'register timeout' : 'register failed');
          return;
        }
        const result = ack.result;
        if (result?.ok !== true || !Number.isFinite(result.heartbeatMs) || result.heartbeatMs <= 0 || result.heartbeatMs > 300_000) {
          log('registration rejected');
          onGone('register rejected');
          return;
        }
        gen.registered = true;
        reconnectDelay = reconnectBaseDelayMs;
        announceRegistered();

        let commitPending = upgradeCommit !== undefined;
        let commitAcked = false;
        const interval = typeof result.heartbeatMs === 'number' && result.heartbeatMs > 0 ? result.heartbeatMs : 15_000;
        const budget = Math.min(Math.max(Math.floor((interval * 3) / 4), HEARTBEAT_BUDGET_MIN_MS), HEARTBEAT_BUDGET_MAX_MS);
        let inFlight = false;
        let misses = 0;
        gen.heartbeatTimer = setInterval(() => {
          if (closed || generation !== gen) return;
          if (inFlight) return;
          inFlight = true;
          if (upgradeCommit !== undefined && !commitAcked) commitPending = true;
          const outcome = withinBudget<HeartbeatOutcome>(
            (async () => {
              const beat = await collectNodeHealth(dataDir).catch(() => undefined);
              const alive = await hubRpc.heartbeat(
                identity.nodeId,
                {
                  ...(beat !== undefined ? { health: beat } : {}),
                  ...(commitPending && upgradeCommit !== undefined ? { upgradeCommit } : {}),
                },
              );
              return { kind: 'ack', alive: alive === true };
            })(),
            budget,
            { kind: 'timeout' },
          )
            .catch((): HeartbeatOutcome => ({ kind: 'ack', alive: false }))
            .finally(() => {
              inFlight = false;
            });
          void outcome.then((r) => {
            if (closed || generation !== gen) return;
            if (r.kind === 'timeout') {
              misses += 1;
              if (misses >= 2) {
                log('consecutive heartbeat timeouts; reconnecting');
                onGone('heartbeat timeout');
              }
              return;
            }
            if (r.alive) {
              misses = 0;
              if (commitPending && upgradeCommit !== undefined) {
                commitPending = false;
                commitAcked = true;
              }
              return;
            }
            log('heartbeat rejected (registration expired); reconnecting');
            onGone('heartbeat rejected');
          });
        }, interval);
      })().catch((error: unknown) => {
        if (closed || generation !== gen) return;
        log(`registration error: ${error instanceof Error ? error.message : String(error)}`);
        onGone('register error');
      });
    });

    socket.on('close', () => onGone('closed'));
    socket.on('error', (err) => {
      log(`WS error: ${err instanceof Error ? err.message : String(err)}`);
      onGone('error');
    });
    socket.on('unexpected-response', (_req, res) => {
      log(`WS rejected: HTTP ${res.statusCode}`);
      try {
        res.resume();
      } catch {
        // Ignore.
      }
      onGone('rejected');
    });
  };

  const connect = (): void => {
    if (closed) return;
    if (suspendReconnect) return;
    if (generation !== undefined) return;
    startConnect();
  };

  let baseShellEnv: Record<string, string | undefined> = {
    HELM_HUB_URL: hubUrl,
    HELM_DATA_DIR: dataDir,
    ...(envServer.shellEnv ?? {}),
  };
  if ('dir' in cliBin) {
    baseShellEnv = prependPath(cliBin.dir, baseShellEnv);
  } else {
    log(`failed to locate helm client: ${cliBin.error}`);
    throw new Error(cliBin.error);
  }

  let closePromise: Promise<void> | undefined;

  const resolveUpgradeRegistry = (registryUrl: string | undefined, trustedRegistry: boolean): string | undefined =>
    trustedRegistry === true ? (registryUrl === undefined || registryUrl === '' ? undefined : registryUrl) : filterRpcRegistryUrl(registryUrl);

  const daemonCheckUpgrade = async (
    input: NodeUpgradeCheckInput | undefined,
    trustedRegistry: boolean,
  ): Promise<RpcResult<NodeUpgradeCheckResult>> => {
    try {
      const parsed = assertUpgradeCheckInput(input);
      const registryUrl = resolveUpgradeRegistry(parsed?.registryUrl, trustedRegistry);
      const value = await checkNodeUpgrade(dataDir, {
        ...(registryUrl !== undefined ? { registryUrl } : {}),
        currentVersion: getNodeVersion(),
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: rpcErrorOf(error) };
    }
  };

  const unwrapRpc = async <T>(result: Promise<RpcResult<T>>): Promise<T> => {
    const settled = await result;
    if (!settled.ok) {
      throw Object.assign(new Error(settled.error.message), { code: settled.error.code });
    }
    return settled.value;
  };

  const daemonUpgrade = (
    input: NodeUpgradeRpcInput | undefined,
    trustedRegistry: boolean,
  ): Promise<RpcResult<NodeUpgradeResult>> => {
    if (closed) {
      return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'daemon is closed; rejecting upgrade request' } });
    }
    if (upgradeActive || upgradeInFlight !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid', message: 'upgrade is already in progress or committed awaiting exit; rejecting concurrent request' },
      });
    }
    if (options.prepareUpgradeReplacement === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'not_supported',
          message: 'daemon has no upgrade replacement host configured (prepareUpgradeReplacement missing); rejecting upgrade',
        },
      });
    }
    let run: Promise<RpcResult<NodeUpgradeResult>>;
    run = (async (): Promise<RpcResult<NodeUpgradeResult>> => {
      await Promise.resolve();
      upgradeActive = true;
      suspendReconnect = true;
      try {
        const parsed = assertUpgradeRpcInput(input);
        const registryUrl = resolveUpgradeRegistry(parsed?.registryUrl, trustedRegistry);
        const value = await performNodeUpgrade(dataDir, {
          ...(parsed?.targetVersion !== undefined ? { targetVersion: parsed.targetVersion } : {}),
          ...(registryUrl !== undefined ? { registryUrl } : {}),
          ...(parsed?.force === true ? { force: true } : {}),
          ...(parsed?.attemptId !== undefined ? { attemptId: parsed.attemptId } : {}),
          currentVersion: getNodeVersion(),
          prepareReplacement: options.prepareUpgradeReplacement,
          getActiveExecCount: () =>
            (generation?.server.getActiveExecCount() ?? 0) +
            (generation?.server.getActiveTunnelCount() ?? 0) +
            (generation?.server.getActiveIpcCallCount() ?? 0),
          setDraining: applyDraining,
          onScheduleShutdown: options.onUpgradeReplaced,
        });
        if (value.upgraded) return { ok: true, value };
        upgradeActive = false;
        suspendReconnect = false;
        applyDraining(false);
        connect();
        return { ok: true, value };
      } catch (error) {
        if (!isCommitUnconfirmed(error)) {
          upgradeActive = false;
          suspendReconnect = false;
          applyDraining(false);
          connect();
        }
        return { ok: false, error: rpcErrorOf(error) };
      } finally {
        upgradeInFlight = undefined;
      }
    })();
    upgradeInFlight = run;
    return run;
  };

  const rpcErrorOf = (error: unknown): RpcEnvError => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UpgradeRejectedError) return { code: 'invalid', message };
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'invalid' || code === 'not_supported' || code === 'aborted') {
      return { code, message };
    }
    return { code: 'unknown', message };
  };

  const isCommitUnconfirmed = (error: unknown): boolean => {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
      if (current instanceof UpgradeCommitUnconfirmedError) return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  };

  const daemon: NodeDaemon = {
    identity,
    hubUrl,
    isConnected: () => generation?.registered === true && generation.socket.readyState === WebSocket.OPEN,
    waitUntilRegistered(timeoutMs = 10_000): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (generation?.registered === true && generation.socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiter = (ok: boolean): void => {
          clearTimeout(timer);
          registerWaiters.delete(waiter);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          registerWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        registerWaiters.add(waiter);
      });
    },
    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = (async () => {
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
          const gen = generation;
          if (gen) retireGeneration(gen);
          confirmOffline();
          const drained = await withinBudget(Promise.all([...settlingDisposes]).then(() => true), CLOSE_SETTLE_TIMEOUT_MS, false);
          if (!drained) throw new Error('timed out cleaning up node connection resources; in-flight resources remain open');
          if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'failed to clean up node connection resources');
        })();
      }
      return closePromise;
    },
    checkUpgrade: (input?, trustedRegistry?) => unwrapRpc(daemonCheckUpgrade(input, trustedRegistry === true)),
    upgrade: (input?, trustedRegistry?) => unwrapRpc(daemonUpgrade(input, trustedRegistry === true)),
    confirmUpgrade: async (commit: NodeUpgradeCommit): Promise<void> => {
      const validated = assertUpgradeCommit(commit);
      if (options.pendingActivation === true) {
        const expectedAttempt = options.upgradeAttemptId;
        if (
          (expectedAttempt !== undefined && validated.attemptId !== expectedAttempt) ||
          validated.version !== getNodeVersion() ||
          validated.pid !== process.pid
        ) {
          throw Object.assign(
            new Error(
              `confirmUpgrade does not match this candidate daemon, rejecting activation (attemptId=${validated.attemptId}, version=${validated.version}, pid=${validated.pid}; expected attemptId=${expectedAttempt ?? '(unspecified)'}, version=${getNodeVersion()}, pid=${process.pid})`,
            ),
            { code: 'invalid' },
          );
        }
      }
      upgradeCommit = validated;
      applyDraining(false);
      pushHeartbeatSoon(true);
    },
    isUpgrading: (): boolean => upgradeActive,
  };

  connect();
  return daemon;
}

/** CLI entrypoint (`helm-node connect`): runs in foreground until `signal` aborts. */
export async function runNodeDaemon(
  input: NodeConnectInput,
  options: { signal?: AbortSignal; dataDir?: string; envServer?: NodeDaemonOptions['envServer'] } = {},
): Promise<void> {
  const dataDir = resolveNodeDataDir(options.dataDir);
  const identity = await resolveRunIdentity(dataDir, input);
  const daemon = await createNodeDaemon({
    hubUrl: input.hubUrl,
    identity,
    dataDir,
    envServer: options.envServer,
  });
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      options.signal?.removeEventListener('abort', stop);
      void daemon.close().then(resolve, reject);
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Handle-returning entrypoint for embedding/testing without capturing process signals. */
export async function runNodeDaemonHandle(
  input: NodeConnectInput,
  options: {
    signal?: AbortSignal;
    dataDir?: string;
    prepareUpgradeReplacement?: NodeDaemonOptions['prepareUpgradeReplacement'];
    onUpgradeReplaced?: NodeDaemonOptions['onUpgradeReplaced'];
    upgradeAttemptId?: string;
    pendingActivation?: boolean;
  } = {},
): Promise<NodeDaemon> {
  const dataDir = resolveNodeDataDir(options.dataDir);
  const identity = await resolveRunIdentity(dataDir, input);
  const daemon = await createNodeDaemon({
    hubUrl: input.hubUrl,
    identity,
    dataDir,
    ...(options.prepareUpgradeReplacement !== undefined ? { prepareUpgradeReplacement: options.prepareUpgradeReplacement } : {}),
    ...(options.onUpgradeReplaced !== undefined ? { onUpgradeReplaced: options.onUpgradeReplaced } : {}),
    ...(options.upgradeAttemptId !== undefined ? { upgradeAttemptId: options.upgradeAttemptId } : {}),
    ...(options.pendingActivation !== undefined ? { pendingActivation: options.pendingActivation } : {}),
  });
  if (options.signal) {
    const signal = options.signal;
    const originalClose = daemon.close.bind(daemon);
    const stop = (): void => { void daemon.close().catch(() => console.error('[helm-node] failed to close resources on abort signal')); };
    daemon.close = () => {
      signal.removeEventListener('abort', stop);
      return originalClose();
    };
    if (signal.aborted) await daemon.close();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return daemon;
}
