/**
 * subject to control node daemon: file identity + single era proxy in-flight WS+birpc lifecycle.
 *
 * - identity:`<dataDir>/node.json`(nodeId + token,0600, all field strictly validate). two kinds of source:
 *   a) Hub sign JOIN token `nodeId:secret`(nodeId excludes smoke number) - -
 *      runNodeDaemon directly from token parse and persist (atomic 0600 write);
 *   b) explicit identity parameter (createNodeDaemon low layer entry, test fixture use).
 * - connect era proxy (generation): once connect attempt self new WebSocket start i.e. create proxy - - grasp manually/
 *   register/heartbeat any one phase failed all away the same idempotent final path:close rpc,dispose the proxy
 *   env server(closure reader, kill the proxy command, destroy IPC socket), terminate socket;
 *   old proxy call back never trigger touch new proxy state; the same moment at most a reconnect count when, a in-flight connect.
 * - heartbeat: single time heartbeat pre- compute = heartbeat interval 3/4(1s..30s seal top); in-flight heartbeat not set before
 *   do not under one jump; connect continue 2 time pre- compute inside without reply or by explicit reject → final when before proxy and reconnect.
 * - remote managed shell can directly run `helm`:daemon local machine managed helm client bin
 *   directory pre- to PATH;bin directory cannot locate when start i.e. explicit diagnose failed, never false call support.
 * - reconnect: exponential backoff (by default 500ms start, cap 30s), unbounded retry; reconnect wait for phase keep
 *   event loop store (count when do not unref), store pattern by close() terminate everything. disconnect during
 *   in-flight RPC immediately failed - - already start envExec do not replay (result unknown semantics).
 * - waitUntilRegistered: reverse reflect**when before**register state - - already online immediately true; wait for in
 *   invoke by**under once**register result settle(new register can its translate is true); when before proxy
 *   final and where at offline when resolve(false), never remove succeeded when now online, never fabricate.
 * - store pattern do not take over process signal (CLI/host self row manage lifecycle);
 *   close() idempotent, return before wait for all in-flight era proxy clean up complete, without orphan child timer.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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
import { findEnvKey, getEnvEntry, prependEnvPath, setEnvEntry } from '@helm/env-io';
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

/** node side invoke Hub function collection (register/heartbeat/onEnvExecOutput/onIpc*). */
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
  /** sign when record hub address (hint use; actual connect with hubUrl parameter is allow). */
  hubUrl?: string;
}

export interface NodeDaemonOptions {
  hubUrl: string;
  identity: NodeIdentity;
  dataDir: string;
  /** env RPC server option (defaultCwd by default dataDir). */
  envServer?: Omit<NodeEnvRpcServerOptions, 'defaultCwd' | 'onExecOutput' | 'onIpcEvent' | 'onIpcClosed'>;
  /** reconnect basis latency (milli second); default 500. */
  reconnectBaseDelayMs?: number;
  /** reconnect most large latency (milli second); default 30_000. */
  reconnectMaxDelayMs?: number;
  /** log (default console.error). never back pass message content (must not contains token). */
  log?: (message: string) => void;
  /**
   * upgrade replace hook (managed host provide): receive already staged choose release, negative duty start
   * choose daemon and return registered inactive replace handle;commit()/abort() by engine
   * in arrange empty after completion invoke. not provide when nodeUpgrade explicit reject (not_supported).
   */
  prepareUpgradeReplacement?: PerformNodeUpgradeOptions['prepareReplacement'];
  /** upgrade commit succeeded (or commit not confirm keep let) after call back old host pid: old process should exit. */
  onUpgradeReplaced?: (pid: number) => void;
  /** upgrade attempt ID: upgrade after new daemon reconnect when follow register on report supply Hub for account. */
  upgradeAttemptId?: string;
  /** choose await activate pattern:env server from create i.e. draining, until confirmUpgrade solve except. */
  pendingActivation?: boolean;
}

export interface NodeDaemon {
  readonly identity: NodeIdentity;
  readonly hubUrl: string;
  /** when before is otherwise connect and registered. */
  isConnected(): boolean;
  /**
   * wait for register result: already online immediately true; otherwise wait for**under once**register attempt result - -
   * succeeded true; close/offline confirm/by refuse/timeout false. never history succeeded when now online.
   */
  waitUntilRegistered(timeoutMs?: number): Promise<boolean>;
  /** stop: disconnect connect,dispose all era proxy env server, clean up timer. idempotent, return before wait for clean up complete. */
  close(): Promise<void>;
  /**
   * check node available update (real run package version vs registry most new); failed throw carries code  Error
 * (CLI convention:Promise directly carry result, non- RpcResult).
   * trustedRegistry=true only limit local machine can message invoke (CLI host) explicit designate registry source;
   * RPC path one rule false, only allows filterRpcRegistryUrl allows manifest inside source.
   */
  checkUpgrade(input?: NodeUpgradeCheckInput, trustedRegistry?: boolean): Promise<NodeUpgradeCheckResult>;
  /**
   * trigger self upgrade (arrange empty → stage → replace daemon → commit/rollback); failed throw carries code 
 * Error. without prepareUpgradeReplacement when throw not_supported, never fabricate result.
   */
  upgrade(input?: NodeUpgradeRpcInput, trustedRegistry?: boolean): Promise<NodeUpgradeResult>;
  /**
   * local machine already activate call back (choose invoke): record commit and immediately async follow heartbeat on report Hub;
   * only in parameter legal and record under local activate state after resolve- - do not because Hub ACK timeout while failed,
   * after each time heartbeat/re- register idempotent retry.
   */
  confirmUpgrade(commit: NodeUpgradeCommit): Promise<void>;
  /** upgrade in progress or committed await exit. */
  isUpgrading(): boolean;
}

// - - constant pre- compute - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
/** WS grasp manually (TCP+HTTP upgrade) pre- compute; timeout final this time attempt away reconnect. */
const CONNECT_TIMEOUT_MS = 10_000;
/** single time register total pre- compute (WS open after). */
const REGISTER_TIMEOUT_MS = 15_000;
/** heartbeat pre- compute under/cap (actual = min(max(interval*3/4, 1s), 30s)). */
const HEARTBEAT_BUDGET_MIN_MS = 1_000;
const HEARTBEAT_BUDGET_MAX_MS = 30_000;
/** close wait for era proxy clean up fall back cap. */
const CLOSE_SETTLE_TIMEOUT_MS = 10_000;
/** tunnel WS connect (TCP+HTTP upgrade) pre- compute; timeout destroy and reject this time tunnel. */
const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
/** tunnel first frame (NodeTunnelControl) wait for pre- compute and single frame byte cap. */
const TUNNEL_FIRST_FRAME_TIMEOUT_MS = 15_000;
const TUNNEL_FIRST_FRAME_MAX_BYTES = 64 * 1024;
/** NODE_ID legal character (JOIN  nodeId segment, non- local). */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** JOIN token secret segment non-empty and excludes control character/first tail whitespace. */
const JOIN_SECRET_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

/** node data directory: explicit > HELM_DATA_DIR > ~/.helm. */
export function resolveNodeDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = process.env['HELM_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.helm');
}

/**
 * collect local machine node health snapshot (pure only read):
 * - basis metric from os module (uptime/loadavg/freemem/totalmem);
 * - disk empty between use fs.statfs collect target directory which in mount point (directory missing fall back homedir,
 *   still failed then omit disk field); any collect failed all must not interrupt register/heartbeat main stream process.
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
      // target directory missing (mount point not yet ready etc.): fall back homedir again try once.
      stats = await fs.statfs(os.homedir());
    }
    snapshot.diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    snapshot.diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // statfs unavailable (platform/permission): omit disk field, never throw interrupt heartbeat.
  }
  return snapshot;
}

/** JOIN token format:`nodeId:secret`(nodeId excludes smoke number, non- keep local ID).
 * reject:local ID, whitespace nodeId/secret, control character.secret can contains smoke number (take first segment after all).
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

/** strictly validate identity object:null/array/broken nodeId/token/hubUrl one rule reject. */
function assertValidIdentity(identity: unknown, context: string): asserts identity is NodeIdentity {
  const invalid = (detail: string): Error =>
    new Error(`${context}:${detail}(expectation { nodeId, token[, hubUrl] },nodeId match ${NODE_ID_PATTERN})`);
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw invalid('value is not object');
  }
  const record = identity as Record<string, unknown>;
  if (typeof record['nodeId'] !== 'string' || !NODE_ID_PATTERN.test(record['nodeId']) || record['nodeId'] === DEFAULT_NODE_ID) {
    throw invalid('nodeId missing or illegal');
  }
  if (typeof record['token'] !== 'string' || parseJoinToken(record['token'])?.nodeId !== record['nodeId']) {
    throw invalid('token illegal or and nodeId inconsistent');
  }
  if (record['hubUrl'] !== undefined) {
    if (typeof record['hubUrl'] !== 'string') throw invalid('hubUrl non- string');
    try {
      assertValidHubUrl(record['hubUrl']);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
}

/** validate http(s) Hub URL: protocol, host, without userinfo/fragment/credentials query. */
function assertValidHubUrl(hubUrl: string): URL {
  if (typeof hubUrl !== 'string' || hubUrl === '' || hubUrl !== hubUrl.trim()) throw new Error('Hub address must be non-empty URL');
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error('Hub address cannot parse');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Hub address protocol must is http(s): ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Hub address must not contains userinfo(user:pass@)');
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Hub address must not contains fragment or query parameter');
  }
  return parsed;
}

/** read node identity: only ENOENT treated as not config return null; corrupt/structure illegal/IO error explicit throw. */
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
    throw new Error(`node identity file corrupt (${file}): cannot parse JSON`);
  }
  try {
    assertValidIdentity(parsed, `node identity file structure illegal (${file})`);
  } catch (error) {
    throw new Error(`node identity file structure illegal (${file}):${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

/** atomic write identity (same directory temp file + rename;0600,chmod failed explicit throw). */
export async function writeNodeIdentity(dataDir: string, identity: NodeIdentity): Promise<void> {
  assertValidIdentity(identity, 'node identity illegal');
  const target = path.join(dataDir, 'node.json');
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

// - - bind set mutual exclusion (process inside + across process lock file) - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

/** process inside bind set mutual exclusion (same dataDir concurrency bindIdentityFromJoinToken serial). */
const bindLocks = new Map<string, Promise<unknown>>();

/**
 * across process identity lock:`node.json.lock`(O_CREAT|O_EXCL). leave effect domain i.e. clean up
 * (contains exception); pure plain lock file satisfy development phase need to - - does not stale lock arbitration.
 */
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
    // before order failed non-blocking this time bind set.
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
        `concurrency bind set conflict:${lockPath} already exists (another helm-node connect is now write, or on time bind set exception exit leftover; confirm after delete the file retry)`,
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
 * persist identity bind set (JOIN semantics; bind set all process hold lock):
 * - without since has identity: persist token identity;
 * - since has same nodeId: token round swap (new secret update);
 * - since has different nodeId: explicit errors (the same data directory must not static default change swap gate), must human clean up.
 */
export async function bindIdentityFromJoinToken(
  dataDir: string,
  token: string,
  hubUrl: string,
): Promise<NodeIdentity> {
  const parsed = parseJoinToken(token);
  if (parsed === null) {
    throw new Error(`JOIN token format illegal (expectation nodeId:secret,nodeId excludes smoke number, must not is local):${describeToken(token)}`);
  }
  try {
    assertValidHubUrl(hubUrl);
  } catch (error) {
    throw new Error(`JOIN bind set failed:${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedDataDir = path.resolve(dataDir);
  return await withIdentityLock(resolvedDataDir, async () => {
    const existing = await readNodeIdentity(resolvedDataDir);
    if (existing !== null && existing.nodeId !== parsed.nodeId) {
      throw new Error(
        `data directory already bind set node ${existing.nodeId}, reject change bind is ${parsed.nodeId}; such as indeed must more swap please first delete ${path.join(dataDir, 'node.json')}`,
      );
    }
    const identity: NodeIdentity = { nodeId: parsed.nodeId, token, hubUrl };
    await writeNodeIdentity(resolvedDataDir, identity);
    return identity;
  });
}

/** illegal token security description (forever do not output prefix/content, only to shape). */
function describeToken(token: string): string {
  const kind = typeof token !== 'string' ? `type ${typeof token}` : `length ${token.length}`;
  return `token (${kind}) does not match format`;
}

/**
 * from JOIN token parse run identity:token illegal one rule explicit reject, never fall back since store identity
 * (pass token is exactly intent itself - - broken token yet static default use old identity run is authentication incident).
 */
async function resolveRunIdentity(dataDir: string, input: NodeConnectInput): Promise<NodeIdentity> {
  if (parseJoinToken(input.token) === null) {
    throw new Error(
      `token illegal, reject start (must be Hub sign JOIN token nodeId:secret,nodeId excludes smoke number, must not is local):${describeToken(input.token)}`,
    );
  }
  return bindIdentityFromJoinToken(dataDir, input.token, input.hubUrl);
}

// - - managed helm client bin directory - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

/** managed helm client bin directory parse result: directory or explicit diagnose (without can static default fall back path). */
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
 * parse local machine managed helm client bin directory (remote bash `helm ...` source):
 * a) explicit reference / `HELM_CLI_BIN_DIR` environment variable;
 * b) when before PATH in already deploy client;
 * c) one by one level to on find node_modules/.bin(workspace install layout, contains helm link).
 * find fewer than i.e. return explicit diagnose - - never false call support.
 */
export async function resolveManagedHelmBinDir(explicit?: string): Promise<ResolvedCliBinDir> {
  const describe = async (dir: string): Promise<ResolvedCliBinDir> => {
    const entry = process.platform === 'win32' ? path.join(dir, 'helm.cmd') : path.join(dir, 'helm');
    return (await statExecutable(entry)) ? { dir } : { error: `directory ${dir} in find fewer than can execute helm client` };
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
  // node_modules/.bin fall back (pnpm workspace layout; each time re- parse avoid cache stale).
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = selfDir, depth = 0; dir !== path.dirname(dir) && depth < 16; dir = path.dirname(dir), depth += 1) {
    const candidate = path.join(dir, 'node_modules', '.bin');
    const result = await describe(candidate);
    if ('dir' in result) return result;
  }
  return {
    error:
      'cannot locate local machine helm client bin directory (remote bash cannot run helm).' +
      'please deploy independent helm client and its add PATH, or settings HELM_CLI_BIN_DIR=<contains helm can execute file directory>',
  };
}

/** pre- managed bin directory to PATH(build daemon shellEnv use;win32 large small write security keep host machine Path). */
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

  assertValidIdentity(identity, 'node identity illegal');
  const log = (message: string): void => writeLog(message.replaceAll(identity.token, '[REDACTED]'));
  const hub = assertValidHubUrl(hubUrl);

  // - - tunnel WS address (same source push lead: keep protocol http->ws / https->wss,host/port and
  // base path; in base path after concatenate /ws/node-tunnel, without base path then directly use;
  // tunnel identity only follow hello first frame pass,URL does not carry tunnelId).
  const tunnelWsUrl = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${hub.pathname.replace(/\/+$/, '')}/ws/node-tunnel`;

  /**
   * open single tunnel double work stream: new ws connect same source /ws/node-tunnel, send single row JSON
   * hello(only { nodeId, token, tunnelId }), wait for first frame NodeTunnelControl- - only
   * type=ok return double work stream, otherwise close and throws (not silently disguise succeeded).signal cancel when
   * immediately terminate underlying ws and reject; call back bind when before generation: old proxy final after
   * call back reject (old proxy server already draining/disposed, new proxy do not subject to affect).
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
      // honor bottom error handle: any when (contains cleanup after close route in) ws error all
      // must by absorb, never not catch crash process;settled after only destroy.
      const guardError = (err: Error): void => {
        if (settled) {
          try {
            ws?.terminate();
          } catch {
            // already destroy.
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
        // grasp manually failed/cancel path: no longer closure center after continue frame; keep guardError absorb close route in
        //  error, cancel when terminate immediately disconnect (do not etc. close grasp manually).
        ws?.removeAllListeners('message');
        ws?.removeAllListeners('open');
        ws?.removeListener('error', guardError);
        ws?.once('error', () => {
          try {
            ws?.terminate();
          } catch {
            // already destroy.
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
        // connect already establish:connect pre- compute stop, this after by frame pre- compute and abort take over.
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        if (settled) return;
        // single row JSON hello: only { nodeId, token, tunnelId }(protocol define field,
        // do not self row append type/port etc.; credentials only store in at daemon layer).
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
        // switch stream before remove grasp manually listener: this after frame archive createWebSocketStream 
        // double work stream, no longer enter this grasp manually branch.
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

  // remote bash must can directly run helm: cannot locate i.e. failed to start (explicit diagnose, not silently fall back).
  const cliBin = await resolveManagedHelmBinDir(envServer.shellEnv?.['HELM_CLI_BIN_DIR'] as string | undefined);

  let closed = false;
  /** in-flight connect era proxy (self new WebSocket start store in,close/failed after empty). */
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
  /** clean up in era proxy (dispose not set);close() wait for they arrange empty. */
  const settlingDisposes = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];

  const registerWaiters = new Set<(ok: boolean) => void>();

  /**
   * offline confirm:resolve all wait for false. only for when before wait for takes effect - -
   * then reconnect register still can new wait for translate is true(do not cache failed).
   */
  const confirmOffline = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(false);
  };

  /** new register result: only on success clean up wait for (failed do not cache - - under time attempt still can succeeded). */
  const announceRegistered = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(true);
  };

  /** at most a reconnect count when: already has not triggered count when then keep do not change. */
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

  /**
   * era proxy final (idempotent, only the era proxy itself path invoke):rpc $close,socket terminate,
   * dispose env server(register settling,close() wait for arrange empty). never trigger touch global state
   * of outside state - - when before proxy empty after, late to call back i.e. expires. return dispose promise.
   */
  const retireGeneration = (gen: NonNullable<typeof generation>): Promise<void> => {
    if (gen.disposePromise) return gen.disposePromise;
    clearHeartbeat(gen);
    clearTimeout(gen.connectTimeout);
    gen.registered = false;
    try {
      gen.hubRpc.$close();
    } catch {
      // already close.
    }
    if (gen.socket.readyState === WebSocket.OPEN || gen.socket.readyState === WebSocket.CONNECTING) {
      try {
        gen.socket.terminate();
      } catch {
        // ignore.
      }
    }
    const dispose = gen.server
      .dispose()
      .catch((error: unknown) => {
        cleanupErrors.push(error);
        log('node connect asset clean up failed');
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

  // - - self upgrade (nodeUpgrade RPC / confirmUpgrade activate) - - - - - - - - - - - - - -
  /** upgrade in-flight (performNodeUpgrade not set) or committed/not confirm (wait for host exit). */
  let upgradeInFlight: Promise<RpcResult<NodeUpgradeResult>> | undefined;
  /** isUpgrading state: upgrade start placement true; failed rollback clean false; succeeded/not confirm keep true. */
  let upgradeActive = false;
  /** local machine already activate upgrade commit(idempotent follow each time heartbeat retry direct until close). */
  let upgradeCommit: NodeUpgradeCommit | undefined;

  /**
   * upgrade phase paused old daemon reconnect: by connect() check; failed rollback after restore.
   * note each proxy env server  draining by performNodeUpgrade  setDraining
   * call back directly drive, must effect at when before proxy, assert proxy reconnect new proxy inherit global paused/activate state.
   */
  let suspendReconnect = false;
  /** global draining(upgrade arrange empty / choose await activate): new era proxy server create i.e. inherit. */
  let drainingGlobally = options.pendingActivation === true;
  const applyDraining = (value: boolean): void => {
    drainingGlobally = value;
    generation?.server.setDraining(value);
  };

  /**
   * immediately async push once heartbeat:confirmUpgrade activate after immediately on report commit(do not etc. under one clap).
   * target is when before registered connect: without on connect static default skip (after continue register/heartbeat idempotent retry).
   */
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

  /**
   * when before proxy heartbeat carry commit after receives alive=true:Hub already confirm, stop retry.
   * alive=false(false heartbeat path):commit in memory continuous keep to close,
   * await re- register after success by under once heartbeat retry.
   */

  const parseUpgradeAttemptId = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '' || value.length > 128) {
      throw Object.assign(new Error(`upgradeAttemptId illegal:${JSON.stringify(value)}`), { code: 'invalid' });
    }
    return value;
  };

  /** RPC reference strictly boundary validate:null/array/unknown field type one rule invalid. */
  const assertUpgradeCheckInput = (input: unknown): NodeUpgradeCheckInput | undefined => {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Object.assign(new Error('input must be object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['registryUrl']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field:${key}`), { code: 'invalid' });
    }
    if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
      throw Object.assign(new Error('registryUrl must be string'), { code: 'invalid' });
    }
    return record as NodeUpgradeCheckInput;
  };

  const assertUpgradeRpcInput = (input: unknown): NodeUpgradeRpcInput | undefined => {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Object.assign(new Error('input must be object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['targetVersion', 'registryUrl', 'force', 'attemptId']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field:${key}`), { code: 'invalid' });
    }
    if (record['targetVersion'] !== undefined && typeof record['targetVersion'] !== 'string') {
      throw Object.assign(new Error('targetVersion must be string'), { code: 'invalid' });
    }
    if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
      throw Object.assign(new Error('registryUrl must be string'), { code: 'invalid' });
    }
    if (record['force'] !== undefined && typeof record['force'] !== 'boolean') {
      throw Object.assign(new Error('force must be boolean'), { code: 'invalid' });
    }
    if (record['attemptId'] !== undefined) parseUpgradeAttemptId(record['attemptId']);
    return record as NodeUpgradeRpcInput;
  };

  const assertUpgradeCommit = (input: unknown): NodeUpgradeCommit => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw Object.assign(new Error('commit must be object'), { code: 'invalid' });
    }
    const record = input as Record<string, unknown>;
    const known = new Set(['attemptId', 'version', 'previousVersion', 'pid']);
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw Object.assign(new Error(`unknown field:${key}`), { code: 'invalid' });
    }
    const attemptId = parseUpgradeAttemptId(record['attemptId']);
    if (attemptId === undefined) throw Object.assign(new Error('attemptId missing or illegal'), { code: 'invalid' });
    for (const key of ['version', 'previousVersion'] as const) {
      const value = record[key];
      if (typeof value !== 'string' || value === '' || value.length > 128) {
        throw Object.assign(new Error(`${key} must be non-empty string`), { code: 'invalid' });
      }
    }
    if (typeof record['pid'] !== 'number' || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0) {
      throw Object.assign(new Error('pid must be positive integer'), { code: 'invalid' });
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

    // - - new era proxy: connect attempt i.e. create proxy (grasp manually failed also want dispose server/rpc) - -
    const socket = new WebSocket(wsUrl);
    // lazy indirectly reference:gen in server after only then group create, avoid TDZ; old proxy final after
    // genHandle.current placement empty, old proxy call back immediately reject new tunnel.
    const genHandle: { current?: NonNullable<typeof generation> } = {};
    const server = createNodeEnvRpcServer({
      defaultCwd: dataDir,
      ...envServer,
      shellEnv: baseShellEnv,
      onExecOutput: (event) => pushEvent('onEnvExecOutput', event),
      onIpcEvent: (event) => pushEvent('onIpcEvent', event),
      onIpcClosed: (event) => pushEvent('onIpcClosed', event),
      // tunnel transfer by daemon layer inject (hold has hubUrl/identity): this proxy call back bind this proxy,
      // old proxy final after reject new tunnel,env-rpc-server layer zero credentials;signal cancel create connect.
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
      // upgrade RPC hang in outside layer (server of on): never can enter env server  pendingOperations
      // guard- - upgrade will dispose old proxy server, if by itself await will deadlock.
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
        // non- OPEN one rule explicit throws (message must not without sound lose); event push invoke side already catch.
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error(`[birpc] WS non- OPEN state reject send (readyState=${socket.readyState})`);
        }
        socket.send(JSON.stringify(data));
      },
      // post throws (disconnect half open etc.) will by birpc message handle path re- throw: in this absorb and
      // diagnose, also final when before proxy (disconnect semantics by reconnect honor bottom, not silently lose message also do not crash).
      onGeneralError: (error, functionName) => {
        log(`RPC failed to send (${functionName ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
        onGone('RPC transport failed');
        return true;
      },
      // on/off wrap reference strictly match for (see birpc-events):$close after listener complete excerpt except.
      ...createSocketBirpcEvents(socket, (message) => {
        log(`${message}, terminate connect`);
        onGone('invalid frame');
      }),
      serialize: (data) => data,
      deserialize: (data) => data as never,
      timeout: 30 * 60 * 1000, // envExec etc. long request pre- compute;register/heartbeat separate limit when
    });

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

    /** era proxy final unique path: idempotent, only handle this proxy. */
    const onGone = (reason: string): void => {
      if (gone || generation !== gen) return;
      gone = true;
      clearTimeout(connectTimeout);
      const dispose = retireGeneration(gen);
      gen.disposePromise = dispose;
      log(`connect disconnect (${reason}),${closed ? 'already stop' : 'reconnect'}`);
      scheduleReconnect();
    };

    function pushEvent(method: 'onEnvExecOutput' | 'onIpcEvent' | 'onIpcClosed', event: EnvExecOutputEvent | NodeIpcEvent | NodeIpcClosedEvent): void {
      if (generation !== gen) return;
      const fn = gen.hubRpc[method];
      if (!fn) {
        onGone('stream callback unavailable');
        throw new Error('Hub unsupported node streaming call back');
      }
      try {
        void Promise.resolve(fn.asEvent(event as never)).catch(() => onGone('stream send failed'));
      } catch (error) {
        onGone('stream send failed');
        throw error;
      }
    }

    // grasp manually pre- compute: timeout i.e. final this proxy (close event follow of while come but already idempotent).
    const connectTimeout = setTimeout(() => {
      if (generation === gen && !gone) onGone('connect timeout');
    }, CONNECT_TIMEOUT_MS);

    gen.connectTimeout = connectTimeout;

    socket.on('open', () => {
      if (closed || generation !== gen) return;
      clearTimeout(connectTimeout);
      void (async () => {
        // register short pre- compute: timeout by failed final this proxy (does not occupy 30 minute RPC pre- compute).
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
          log(ack.kind === 'timeout' ? 'register timeout' : 'register failed (connect interrupt)');
          onGone(ack.kind === 'timeout' ? 'register timeout' : 'register failed');
          return;
        }
        const result = ack.result;
        if (result?.ok !== true || !Number.isFinite(result.heartbeatMs) || result.heartbeatMs <= 0 || result.heartbeatMs > 300_000) {
          log('register by reject');
          onGone('register rejected');
          return;
        }
        gen.registered = true;
        reconnectDelay = reconnectBaseDelayMs;
        announceRegistered();

        // heartbeat: pre- compute = interval  3/4(1s..30s); in-flight do not overlap; connect continue 2 time
        // pre- compute inside without reply or by explicit reject → final when before proxy and reconnect.
        // upgrade commit activate after each jump carry upgradeCommit,Hub ACK confirm after stop incidentally.
        let commitPending = upgradeCommit !== undefined;
        let commitAcked = false;
        const interval = typeof result.heartbeatMs === 'number' && result.heartbeatMs > 0 ? result.heartbeatMs : 15_000;
        const budget = Math.min(Math.max(Math.floor((interval * 3) / 4), HEARTBEAT_BUDGET_MIN_MS), HEARTBEAT_BUDGET_MAX_MS);
        let inFlight = false;
        let misses = 0;
        gen.heartbeatTimer = setInterval(() => {
          if (closed || generation !== gen) return;
          if (inFlight) return; // on one jump still in pre- compute window inside: skip this clap, do not heap accumulate
          inFlight = true;
          if (upgradeCommit !== undefined && !commitAcked) commitPending = true; // not confirm before continuous carry
          const outcome = withinBudget<HeartbeatOutcome>(
            (async () => {
              // each jump incidentally most new health snapshot; collect failed still send heartbeat (without interruption store signal).
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
                log('heartbeat connect continue timeout, reconnect');
                onGone('heartbeat timeout');
              }
              return;
            }
            if (r.alive) {
              misses = 0;
              if (commitPending && upgradeCommit !== undefined) {
                commitPending = false; // Hub already confirm this time commit
                commitAcked = true;
              }
              return;
            }
            log('heartbeat by refuse (register already expires), reconnect');
            onGone('heartbeat rejected');
          });
        }, interval);
      })().catch((error: unknown) => {
        if (closed || generation !== gen) return;
        log(`register failed: ${error instanceof Error ? error.message : String(error)}`);
        onGone('register error');
      });
    });

    socket.on('close', () => onGone('closed'));
    socket.on('error', (err) => {
      log(`WS error: ${err instanceof Error ? err.message : String(err)}`);
      onGone('error');
    });
    socket.on('unexpected-response', (_req, res) => {
      log(`WS reject: HTTP ${res.statusCode}`);
      try {
        res.resume(); // release underlying request/response, avoid handle leak leak
      } catch {
        // ignore.
      }
      onGone('rejected');
    });
  };

  const connect = (): void => {
    if (closed) return;
    if (suspendReconnect) return; // upgrade committed/not confirm: old daemon paused reconnect wait for host exit
    if (generation !== undefined) return; // at most a in-flight era proxy (guard against parallel connect)
    startConnect();
  };

  // daemon child process base environment:HELM_HUB_URL is the node actual connect Hub(do not reference
  // Hub end local bin/dataDir);PATH pre- managed helm client bin directory.
  let baseShellEnv: Record<string, string | undefined> = {
    HELM_HUB_URL: hubUrl,
    HELM_DATA_DIR: dataDir,
    ...(envServer.shellEnv ?? {}),
  };
  if ('dir' in cliBin) {
    baseShellEnv = prependPath(cliBin.dir, baseShellEnv);
  } else {
    log(`helm client locate failed: ${cliBin.error}`);
    throw new Error(cliBin.error);
  }

  let closePromise: Promise<void> | undefined;

  /**
   * registry source parse:remote(trustedRegistry !== true) only allows filterRpcRegistryUrl
   * allows manifest (official source or HELM_NPM_REGISTRY explicit config); local machine can message invoke (CLI host)
   * can explicit designate any source.
   */
  const resolveUpgradeRegistry = (registryUrl: string | undefined, trustedRegistry: boolean): string | undefined =>
    trustedRegistry === true ? (registryUrl === undefined || registryUrl === '' ? undefined : registryUrl) : filterRpcRegistryUrl(registryUrl);

  /** sharing boundary validate after check update implement (outside layer RPC and daemon method shared use). */
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

  /** RpcResult → throw carriescode Error public method adapt (CLI convention). */
  const unwrapRpc = async <T>(result: Promise<RpcResult<T>>): Promise<T> => {
    const settled = await result;
    if (!settled.ok) {
      throw Object.assign(new Error(settled.error.message), { code: settled.error.code });
    }
    return settled.value;
  };

  /**
   * sharing upgrade implement: outside layer RPC(trusted=false) and local machine daemon method (can true) shared use.
   * without replace host not_supported; concurrency/committed busy invalid; without operation (upgraded:false)
 * restore flags/gate/reconnect; succeeded and commit not confirm keep let;close after reject new upgrade.
   */
  const daemonUpgrade = (
    input: NodeUpgradeRpcInput | undefined,
    trustedRegistry: boolean,
  ): Promise<RpcResult<NodeUpgradeResult>> => {
    if (closed) {
      return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'daemon already close, reject new upgrade request' } });
    }
    if (upgradeActive || upgradeInFlight !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid', message: 'upgrade already in in progress or committed await exit (busy), reject concurrency upgrade request' },
      });
    }
    if (options.prepareUpgradeReplacement === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'not_supported',
          message: 'this daemon not access upgrade replace host (prepareUpgradeReplacement missing), reject upgrade: do not fabricate result',
        },
      });
    }
    let run: Promise<RpcResult<NodeUpgradeResult>>;
    run = (async (): Promise<RpcResult<NodeUpgradeResult>> => {
      // let upgradeInFlight assignment first at any sync segment execute: invalid input fast failed also will not
      // completed error promise forever long cache in upgradeInFlight(finally must however in its after run).
      await Promise.resolve();
      upgradeActive = true;
      // upgrade all process paused reconnect: old socket by choose top do not reconnect contend grab; failed/without operation after restore.
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
        if (value.upgraded) return { ok: true, value }; // committed: keep flags/gate wait for host exit
        // same version without operation: not do any change, must restore subject to and reconnect, node must not forever long busy.
        upgradeActive = false;
        suspendReconnect = false;
        applyDraining(false);
        connect();
        return { ok: true, value };
      } catch (error) {
        if (!isCommitUnconfirmed(error)) {
          // failed and uncommitted: restore gate and reconnect (original socket by top do not belongs to failed semantics).
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

  /** RPC error message seal: keep self has invalid/not_supported/aborted error code; policy reject
 * UpgradeRejectedError → invalid; the rest unknown. */
  const rpcErrorOf = (error: unknown): RpcEnvError => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UpgradeRejectedError) return { code: 'invalid', message };
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'invalid' || code === 'not_supported' || code === 'aborted') {
      return { code, message };
    }
    return { code: 'unknown', message };
  };

  /** commit not confirm identify: engine its package wrap is ordinary Error throw (cause chain keep original error). */
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
      // registered online (heartbeat already start) immediately true; only connect in/not registered when wait for under once result.
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
          if (!drained) throw new Error('node connect asset clean up timeout, still has in-flight asset not release');
          if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'node connect asset clean up failed');
        })();
      }
      return closePromise;
    },
    checkUpgrade: (input?, trustedRegistry?) => unwrapRpc(daemonCheckUpgrade(input, trustedRegistry === true)),
    upgrade: (input?, trustedRegistry?) => unwrapRpc(daemonUpgrade(input, trustedRegistry === true)),
    confirmUpgrade: async (commit: NodeUpgradeCommit): Promise<void> => {
      // parameter illegal directly throw (local machine can message invoke, non- RPC boundary).
      const validated = assertUpgradeCommit(commit);
      // choose identity strictly for account: only when commit and this process upgrade context consistent only then solve except gate,
      // guard against error process/stale commit mistakenly open gate; the same commit duplicate invoke idempotent without harm.
      if (options.pendingActivation === true) {
        const expectedAttempt = options.upgradeAttemptId;
        if (
          (expectedAttempt !== undefined && validated.attemptId !== expectedAttempt) ||
          validated.version !== getNodeVersion() ||
          validated.pid !== process.pid
        ) {
          throw Object.assign(
            new Error(
              `confirmUpgrade and this choose daemon inconsistent, reject activate (attemptId=${validated.attemptId}, version=${validated.version}, pid=${validated.pid}; expectation attemptId=${expectedAttempt ?? '(not designate)'}, version=${getNodeVersion()}, pid=${process.pid})`,
            ),
            { code: 'invalid' },
          );
        }
      }
      // record and async on report: never because Hub ACK timeout decide activate failed (idempotent follow heartbeat retry).
      upgradeCommit = validated;
      applyDraining(false); // solve except choose pendingActivation gate, restore subject to new command
      pushHeartbeatSoon(true);
    },
    isUpgrading: (): boolean => upgradeActive,
  };

  connect();
  return daemon;
}

/** CLI entry (helm-node connect): foreground run until signal abort. */
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

/** for collection into/test handle edition: do not take over signal, return daemon supply directly control. */
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
    const stop = (): void => { void daemon.close().catch(() => console.error('[helm-node] signal close asset failed')); };
    daemon.close = () => {
      signal.removeEventListener('abort', stop);
      return originalClose();
    };
    if (signal.aborted) await daemon.close();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return daemon;
}
