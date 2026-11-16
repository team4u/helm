/**
 * node side remote execute environment RPC server side (group install main dry): complete implement `NodeEnvRpcFunctions`.
 *
 * file/shell capability by inside placement zero external dependency `LocalExecutionEnv`(Node.js original generate
 * fs/promises + child_process, see ./local-env.ts) bear load: each cwd a
 * env instance (without across cwd pollute);reader with readerId handle bridge,dispose close
 * all reader;envExec with independent AbortController cancel,envAbortExec(execId)
 * immediately terminate command process tree, streaming output via onExecOutput frame back pass Hub; connect on disconnect
 * dispose: closure reader, kill this connect start command and wait for in-flight promise settle; each
 * connect (generation) a independent server instance, old proxy command/readers never across proxy re- use.
 *
 * Herdr IPC bridge (ipcCall/ipcSubscribe) and node side TCP tunnel (nodeTunnelOpen,
 * and daemon inject openTunnelStream double work stream double to pipe, this layer zero credentials) respectively in
 * ./env-rpc-ipc.ts and ./env-rpc-tunnel.ts, via isDisposed()/isDraining()
 * state query collaboration;admit/draining guard and dispose unify arrange empty order in this where.
 *
 * error code semantics (upgrade arrange empty vs cancel):draining refuse new request (envExec / ipcCall /
 * ipcSubscribe / nodeTunnelOpen / envCleanup) one rule return stable code node_draining;
 * user/host cancel, connect proxy final,dispose force compute still is aborted- - never mutual mix.
 */

import type { Duplex } from 'node:stream';
import {
  LocalExecutionEnv,
  isManagedHelmEnvKey,
  type BinaryReader,
  type DirReader,
  type TextLineReader,
} from './local-env.js';
import { createNodePathUsageIo, scanPathUsage, setEnvEntry } from '@helm/env-io';
import type {
  EnvExecInput,
  EnvExecOk,
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodePathUsage,
  NodeTunnelOpenInput,
  RpcResult,
} from '@helm/protocol';
import { drainingRejection, invalidInput, isRecord, rpcFail } from './env-rpc-shared.js';
import { createIpcBridge, resolveHerdrIpcEndpoint } from './env-rpc-ipc.js';
import { createTunnelHandler } from './env-rpc-tunnel.js';

export { MAX_IPC_FRAME_BYTES, resolveHerdrIpcEndpoint } from './env-rpc-ipc.js';
export type { IpcEndpointContext } from './env-rpc-ipc.js';

export interface NodeEnvRpcServerOptions {
  /** relative path base allow directory (daemon data directory). */
  defaultCwd: string;
  /** shell output streaming call back (forwarding back Hub  onEnvExecOutput). */
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  /**
   * inject each shell child process environment (daemon build): such as HELM_HUB_URL.
   * secret and short phase token by Hub side envOptions together into after via envExec.env one by one invoke pass
   * (node do not persist any secret).
   */
  shellEnv?: Record<string, string | undefined>;
  /** command output single time back pass most large character count (streaming chunked cap, guard against single frame large;≥1). */
  maxOutputChunkChars?: number;
  /** IPC subscribe event call back (forwarding back Hub  onIpcEvent). */
  onIpcEvent?: (event: NodeIpcEvent) => void;
  /** IPC subscribe close/fails call back (forwarding back Hub  onIpcClosed). */
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /**
   * optional IPC wait for pre- compute; not config when by caller timeoutMs, cancel signal and connect proxy control.
   * Herdr long task wait for cannot by daemon stealthily stealthily apply add a extra fixed die line.
   */
  ipcCallIdleTimeoutMs?: number;
  /** optional IPC single frame (single row) byte cap (by default MAX_IPC_FRAME_BYTES = 32 MiB). */
  maxIpcFrameBytes?: number;
  /**
   * process occupy scan inject (only test or subject to control host inject; produce do not fabricate):
   * - procRoot:/proc alternative (default '/proc');
   * - platform: platform fact alternative (default process.platform; non- linux explicit
   *   not_supported, never fabricate across platform result).
   */
  pathUsage?: {
    procRoot?: string;
    platform?: () => string;
  };
  /**
   * cancel/timeout after wait for underlying stdio pipeline arrange empty hard timeout (milli second, by default 500):
   * when command derive detached descendant process inherit stdout/stderr fd and continuous write when,
   * SDK exec may because wait for stream close while forever long suspended; exceeds the wide limit phase i.e. force compute,
   * guarantee envExec / dispose never by orphan child descendant process drag.
   */
  abortDrainGraceMs?: number;
  /**
   * open tunnel double work stream (daemon layer inject: connect Hub  /ws/node-tunnel and complete grasp manually).
   * signal used to cancel in-flight create connect (nodeTunnelAbort / dispose): implement should as soon as possible
   * reject and destroy underlying asset;env-rpc-tunnel only consume double work stream, zero credentials.
   */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
}

const readerNotFound = <T>(readerId: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'not_found', message: `Unknown reader: ${readerId}` },
});

/** two enter system transfer cap (64 MiB):read/write/base64 to return single time payload cap, over limit explicit errors. */
const MAX_BINARY_TRANSFER_BYTES = 64 * 1024 * 1024;

/** base64 boundary validate: standard character parent table + fill, forbidden Node loosely parse static default swallow illegal character;
 * decode before validate encode after length cap (decode after ≤ 64 MiB), over limit explicit errors. */
const decodeBase64 = (content: string, what: string): Uint8Array => {
  if (typeof content !== 'string') {
    throw Object.assign(new Error(`${what} must be a base64 string`), { code: 'invalid' });
  }
  const encodedLimit = Math.ceil(MAX_BINARY_TRANSFER_BYTES / 3) * 4;
  if (content.length > encodedLimit) {
    throw Object.assign(new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`), { code: 'invalid' });
  }
  // without embed set duplicate group, avoid large payload trigger regex backtrack stack overflow.
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw Object.assign(new Error(`${what} is not valid base64 (standard alphabet)`), { code: 'invalid' });
  }
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  const decodedBytes = (content.length / 4) * 3 - padding;
  if (decodedBytes > MAX_BINARY_TRANSFER_BYTES) {
    throw Object.assign(
      new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit (decoded size ~${decodedBytes})`),
      { code: 'invalid' },
    );
  }
  return Buffer.from(content, 'base64');
};

/**
 * output chunked under a cut point: by codepoint boundary truncate UTF-16 text, never proxy for
 * split into two half (across frame each JSON encode will produce alternative character U+FFFD, break downstream concatenate).
 * even if config cap is 1, also allows a complete proxy for occupy 2 code meta, ensure each round before enter.
 */
const safeChunkEnd = (text: string, offset: number, limit: number): number => {
  const desired = Math.min(offset + Math.max(limit, 1), text.length);
  if (desired >= text.length) return text.length;
  // high proxy in cut point on (low proxy in desired where by split): fall back one code meta.
  const code = text.charCodeAt(desired - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    const backed = desired - 1;
    return backed > offset ? backed : desired + 1;
  }
  return desired;
};

/** NodeEnvRpcFunctions + dispose/inside omit + IPC end point parse (daemon connect line use). */
export interface NodeEnvRpcServer extends NodeEnvRpcFunctions {
  /**
   * open to target host:port(host default 127.0.0.1, by this node parse connect) TCP
   * tunnel, and openTunnelStream double work stream double to pipe. strictly validate reference (only
   * tunnelId/host/port/timeoutMs);draining when return node_draining,disposed
   * when return aborted; local machine failed to connect/grasp manually failed return structure error (never fabricate succeeded).
   */
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
  /** cancel in-flight tunnel (grasp manually in or already establish): destroy the tunnel TCP/WS and immediately return. */
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** close all reader, kill die in-flight command, destroy all IPC socket(connect disconnect or stop machine when invoke). idempotent. */  dispose(): Promise<void>;
  /**
   * arrange empty switch:true during new envExec / ipcCall / ipcSubscribe subject to i.e. refuse (upgrade
   * arrange empty/committed let/choose await activate), does not affect already in-flight command;false restore subject to. idempotent.
   */
  setDraining(value: boolean): void;
  /** in-flight envExec amount (arrange empty inside omit; contains already subject to not spawn invoke). */
  getActiveExecCount(): number;
  /** open reader amount (inside omit/test). */
  getOpenReaderCount(): number;
  /** in-flight ipcCall amount (arrange empty inside omit; contains without callId in-flight invoke, subject to i.e. counter). */
  getActiveIpcCallCount(): number;
  /** leap ipcSubscribe amount (inside omit/test; long resident subscribe do not count arrange empty wait for). */
  getActiveIpcSubscriptionCount(): number;
  /** in-flight tunnel amount (arrange empty inside omit; contains TCP already start not complete grasp manually tunnel). */
  getActiveTunnelCount(): number;
}

/** void return RPC(abort/cleanup/unsubscribe): does not RpcResult boundary wrap;
 * envCleanup because by cwd kill all same cwd conversation in-flight command break semantics, in function inside
 * self carries disposed/draining explicit reject (throws via birpc error message seal such as back refuse). */
const VOID_RPC_METHODS = new Set(['envAbortExec', 'envCleanup', 'ipcAbortCall', 'ipcUnsubscribe', 'nodeTunnelAbort']);

/**
 * guard subject to policy (and VOID_RPC_METHODS same layer data declaration, default policy is do not refuse new, do not append trace):
 * - envExec: subject to i.e. register - -draining/disposed/object validate and execWaiters counter
 *   all in guard entry sync complete, upgrade arrange empty polling see to counter contains already subject to not
 *   spawninvoke, and already subject to invoke will not because after setDraining by refuse;
 * - nodeTunnelOpen:draining refuse new tunnel; tunnel lifecycle (double end destroy) by
 *   tunnelWaiters append trace,dispose arrange empty when wait for its settle, no longer another row counter;
 * - ipcCall: once call count arrange empty opening path (ipcWaiters), upgrade wait for its converge,
 *   do not by old host exit hard cut assert;
 * - ipcSubscribe: subscribe is long resident semantics, arrange empty without waiting it converge (wait for it equals forbidden
 *   upgrade during subscribe store in), but draining when refuse new - - old host dispose before unify graceful
 *   close since has subscribe and via onIpcClosed notify Hub,Hub side can self row heavy subscribe.
 */
const ADMIT_POLICIES: Record<string, { drainingWhat?: string; tracked?: 'exec' | 'ipc' }> = {
  envExec: { drainingWhat: 'commands', tracked: 'exec' },
  nodeTunnelOpen: { drainingWhat: 'tunnels' },
  ipcCall: { drainingWhat: 'IPC calls', tracked: 'ipc' },
  ipcSubscribe: { drainingWhat: 'IPC subscriptions' },
};

export function createNodeEnvRpcServer(options: NodeEnvRpcServerOptions): NodeEnvRpcServer {
  const { defaultCwd, onExecOutput, shellEnv } = options;
  const rawChunkLimit = options.maxOutputChunkChars;
  const maxOutputChunkChars = typeof rawChunkLimit === 'number' && Number.isFinite(rawChunkLimit) && rawChunkLimit >= 1
    ? Math.floor(rawChunkLimit)
    : 256 * 1024;
  const ipcIdleTimeoutMs = typeof options.ipcCallIdleTimeoutMs === 'number' &&
    Number.isFinite(options.ipcCallIdleTimeoutMs) && options.ipcCallIdleTimeoutMs > 0
    ? options.ipcCallIdleTimeoutMs
    : undefined;
  const abortDrainGraceMs = typeof options.abortDrainGraceMs === 'number' &&
    Number.isFinite(options.abortDrainGraceMs) && options.abortDrainGraceMs >= 0
    ? options.abortDrainGraceMs
    : 500;

  const envs = new Map<string, LocalExecutionEnv>();
  let disposed = false;
  let draining = false;
  const envFor = (cwd?: string): LocalExecutionEnv => {
    if (disposed) {
      throw Object.assign(new Error('server disposed'), { code: 'aborted' });
    }
    const base = cwd ?? defaultCwd;
    let env = envs.get(base);
    if (env === undefined) {
      env = new LocalExecutionEnv({ cwd: base, ...(shellEnv ? { shellEnv: shellEnv as NodeJS.ProcessEnv } : {}) });
      envs.set(base, env);
    }
    return env;
  };

  type ReaderHandle =
    | { kind: 'text'; reader: TextLineReader }
    | { kind: 'binary'; reader: BinaryReader }
    | { kind: 'dir'; reader: DirReader };

  const readers = new Map<string, ReaderHandle>();
  let readerSeq = 0;
  const putReader = async (handle: ReaderHandle): Promise<string> => {
    if (disposed) {
      await handle.reader.close();
      throw Object.assign(new Error('server disposed'), { code: 'aborted' });
    }
    const id = `r${++readerSeq}`;
    readers.set(id, handle);
    return id;
  };
  const getReader = <R extends TextLineReader | BinaryReader | DirReader>(
    readerId: string,
    kind: ReaderHandle['kind'],
  ): R | undefined => {
    const handle = readers.get(readerId);
    return handle !== undefined && handle.kind === kind ? (handle.reader as R) : undefined;
  };
  const closeReader = async (readerId: string): Promise<void> => {
    const handle = readers.get(readerId);
    if (handle === undefined) return;
    readers.delete(readerId);
    await handle.reader.close().catch(() => undefined);
  };

  type RunningExec = { controller: AbortController };
  const running = new Map<string, RunningExec>();

  const ipc = createIpcBridge({
    onIpcEvent: options.onIpcEvent,
    onIpcClosed: options.onIpcClosed,
    ipcCallIdleTimeoutMs: ipcIdleTimeoutMs,
    maxIpcFrameBytes: options.maxIpcFrameBytes,
    isDisposed: () => disposed,
  });
  const tunnels = createTunnelHandler({
    openTunnelStream: options.openTunnelStream,
    isDisposed: () => disposed,
    isDraining: () => draining,
  });

  /** Result adapt:void → null(JSON serialization friend well); failed keep structure. */
  const unwrap = async <T, R = T extends void ? null : T>(
    promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
  ): Promise<RpcResult<R>> => {
    const result = await promise;
    return result.ok ? { ok: true, value: (result.value ?? null) as R } : rpcFail(result.error);
  };

  /**
   * group install envExec child process environment (host token isolated):
   * - base bottom: node host process.env non- secret part (PATH/HOME etc. local machine tool chain);
   * - strip except host HELM_TOKEN(node itself credentials never enter remote conversation;SDK by default
   *   inheritEnv:true will process.env re- merge back come, reason must explicit pass
   *   inheritEnv:false and self carries merge result);
   * - node daemon shellEnv(HELM_HUB_URL/HELM_DATA_DIR) override base bottom;
   * - caller input.env(Hub managed inject, can contains legal HELM_TOKEN) finally override.
   * input.inheritEnv:false semantics: only use shellEnv + input.env, do not carries host base bottom.
   */
  const buildExecEnv = (
    input: { env?: Record<string, string>; inheritEnv?: boolean },
  ): { env: Record<string, string>; inheritEnv: false } => {
    const merged: Record<string, string> = {};
    if (input.inheritEnv !== false) {
      for (const [key, value] of Object.entries(process.env)) {
        // managed identity variable strip except (HELM_TOKEN / HELM_EXECUTION_SCOPE):daemon host
        // itself value never static default enter sub- command; legal value only by caller input.env by time inject.
        if (value === undefined || isManagedHelmEnvKey(key)) continue;
        setEnvEntry(merged, key, value);
      }
    }
    for (const [key, value] of Object.entries(shellEnv ?? {})) {
      if (value !== undefined) setEnvEntry(merged, key, value);
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (value !== undefined) setEnvEntry(merged, key, value);
    }
    return { env: merged, inheritEnv: false as const };
  };

  /** in-flight envExec  settle promise(dispose arrange empty use; by invoke append trace, idempotent key cannot rely). */
  const execWaiters = new Set<Promise<unknown>>();
  const trackExec = <T>(promise: Promise<T>): Promise<T> => {
    execWaiters.add(promise);
    void promise.finally(() => execWaiters.delete(promise)).catch(() => undefined);
    return promise;
  };

  const execOnce = async (input: EnvExecInput): Promise<RpcResult<EnvExecOk>> => {
    const { execId, command, cwd, timeout, spill, window } = input;
    if (typeof execId !== 'string' || execId.length === 0 || execId.length > 128) {
      return invalidInput(`Invalid execId: ${JSON.stringify(execId)}`);
    }
    // duplicate execId: in-flight item will by override and lose remove cancel handle - - explicit reject.
    if (running.has(execId)) {
      return invalidInput(`Duplicate execId in flight: ${JSON.stringify(execId)}`);
    }
    const executionEnv = envFor(cwd);
    const controller = new AbortController();
    running.set(execId, { controller });
    // env output call back exception rotate is callback_error, and negative duty kill process tree and wait for exit.
    const emit = (text: string, stream: 'stdout' | 'stderr', skipped?: EnvExecOutputEvent['skipped']): void => {
      if (!onExecOutput) return;
      for (let offset = 0; offset < text.length;) {
        const end = safeChunkEnd(text, offset, maxOutputChunkChars);
        onExecOutput({ execId, text: text.slice(offset, end), stream, ...(offset === 0 && skipped ? { skipped } : {}) });
        offset = end;
      }
    };
    /**
     * cancel/timeout after stdio arrange empty hard timeout:SDK exec in child process exit after still may by
     * detached descendant process drag stdout/stderr pipeline hang (idle grace will because continuous
     * write do not assert reset). wide limit phase inside underlying not settle i.e. force compute, never forever long hang die.
     */
    let forced: { ok: false; error: { code: 'aborted' | 'timeout'; message: string } } | undefined;
    let execSettled = false;
    let settleForce: (() => void) | undefined;
    const drainTimers = new Set<NodeJS.Timeout>();
    const forceSettleNow = (code: 'aborted' | 'timeout', message: string): void => {
      if (execSettled) return;
      execSettled = true;
      forced = { ok: false, error: { code, message } };
      settleForce?.();
    };
    // cancel (envAbortExec / dispose): first to underlying a arrange empty window, past due phase force aborted.
    controller.signal.addEventListener('abort', () => {
      if (execSettled) return;
      const timer = setTimeout(
        () => forceSettleNow('aborted', 'Command aborted (stdio drain grace exceeded)'),
        abortDrainGraceMs,
      );
      drainTimers.add(timer);
    }, { once: true });
    // underlying itself timeout kill tree after same may by descendant process pipeline hang:timeout+wide limit phase to point
    // first cancel again force timeout compute (no longer extra stack add wide limit).
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      const timer = setTimeout(() => {
        if (execSettled) return;
        controller.abort(new Error('Command timed out'));
        forceSettleNow('timeout', `Command timed out after ${timeout} seconds`);
      }, timeout * 1000 + abortDrainGraceMs);
      drainTimers.add(timer);
    }
    try {
      const result = await new Promise<RpcResult<EnvExecOk>>((resolve) => {
        settleForce = () => resolve(forced!);
        void executionEnv.exec(command, {
          ...(cwd === undefined ? {} : { cwd }),
          ...buildExecEnv(input),
          ...(timeout === undefined ? {} : { timeout }),
          ...(spill === undefined ? {} : { spill }),
          ...(window === undefined ? {} : { window }),
          onOutput: (text, info) => emit(text, info.stream, info.skipped),
        }, controller.signal).then(
          (value) => { if (!execSettled) { execSettled = true; resolve(value.ok ? { ok: true, value: value.value } : rpcFail(value.error)); } },
          (error: unknown) => { if (!execSettled) { execSettled = true; resolve(rpcFail(error)); } },
        );
      });
      return result;
    } finally {
      running.delete(execId);
      for (const timer of drainTimers) clearTimeout(timer);
      drainTimers.clear();
    }
  };

  const rpc: NodeEnvRpcFunctions = {
    async envAbsolutePath({ path: target, cwd }) {
      return unwrap(envFor(cwd).absolutePath(target));
    },
    async envJoinPath({ parts, cwd }) {
      return unwrap(envFor(cwd).joinPath(parts));
    },

    async envReadTextFile({ path: target, cwd }) {
      return unwrap(envFor(cwd).readTextFile(target));
    },
    async envReadTextLines({ path: target, maxLines, cwd }) {
      return unwrap(envFor(cwd).readTextLines(target, { maxLines }));
    },
    async envReadBinaryFile({ path: target, cwd }) {
      const opened = await envFor(cwd).openBinaryReader(target, {});
      if (!opened.ok) return rpcFail(opened.error);
      const reader = opened.value;
      try {
        const info = await reader.info();
        if (!info.ok) return rpcFail(info.error);
        if (info.value.size > MAX_BINARY_TRANSFER_BYTES) {
          return invalidInput(`readBinaryFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
        }
        // use the same file handle has boundary read; check after file increase long also will not trigger without boundary allocate.
        const result = await reader.read(0, MAX_BINARY_TRANSFER_BYTES + 1);
        if (!result.ok) return rpcFail(result.error);
        if (result.value.byteLength > MAX_BINARY_TRANSFER_BYTES) {
          return invalidInput(`readBinaryFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
        }
        return { ok: true, value: { base64: Buffer.from(result.value).toString('base64') } };
      } finally {
        await reader.close();
      }
    },

    async envWriteFile({ path: target, content, encoding, cwd }) {
      let bytes: Uint8Array | string;
      try {
        bytes = encoding === 'base64' ? decodeBase64(content, 'content') : content;
      } catch (error) {
        return rpcFail(error);
      }
      // decode after: real byte count re- verify (contains utf8 path and base64 decode result).
      const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
      if (size > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(
          `content is ${size} bytes, exceeding the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`,
        );
      }
      return unwrap(envFor(cwd).writeFile(target, bytes));
    },
    async envAppendFile({ path: target, content, encoding, cwd }) {
      let bytes: Uint8Array | string;
      try {
        bytes = encoding === 'base64' ? decodeBase64(content, 'content') : content;
      } catch (error) {
        return rpcFail(error);
      }
      const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
      if (size > MAX_BINARY_TRANSFER_BYTES) return invalidInput(`content exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
      return unwrap(envFor(cwd).appendFile(target, bytes));
    },
    async envFlushFile({ path: target, cwd }) {
      return unwrap(envFor(cwd).flushFile(target));
    },
    async envTruncateFile({ path: target, size, cwd }) {
      return unwrap(envFor(cwd).truncateFile(target, size));
    },
    async envRenameFile({ sourcePath, destinationPath, cwd }) {
      return unwrap(envFor(cwd).renameFile(sourcePath, destinationPath));
    },

    async envFileInfo({ path: target, cwd }) {
      return unwrap(envFor(cwd).fileInfo(target));
    },
    async envListDir({ path: target, cwd }) {
      return unwrap(envFor(cwd).listDir(target));
    },
    async envListFiles() {
      // LocalExecutionEnv not implemented optional listFiles: such as return not_supported,
      // caller (pi-durable host) self row fall back iterate.
      return { ok: false, error: { code: 'not_supported', message: 'listFiles is not available on this environment' } };
    },
    async envCanonicalPath({ path: target, cwd }) {
      return unwrap(envFor(cwd).canonicalPath(target));
    },
    async envExists({ path: target, cwd }) {
      return unwrap(envFor(cwd).exists(target));
    },

    /**
     * node local machine process occupy snapshot (before deletion diagnose; only read side, upgrade arrange empty do not reject - - and file
     * only read operation same opening path). process inside directly scan (zero helper spawn, do not use target cwd start
     * any child process); only read cwd/fd/comm locate information, never read cmdline/environ.
     * reference strictly validate (only path field); non- Linux platform explicit not_supported; durable
     * permission refuse read (EACCES/EPERM, across uid or non-dumpable such as systemd --user)
     * count is structure blind spot (unobservable counter + diagnose, does not affect complete); non- permission
     * class read error make complete=false(never pretend complete/clean).
     */
    async envPathUsage(raw: unknown): Promise<RpcResult<NodePathUsage>> {
      if (!isRecord(raw) || Array.isArray(raw)) {
        return invalidInput('envPathUsage input must be a plain object');
      }
      const unknownFields = Object.keys(raw).filter((key) => key !== 'path');
      if (unknownFields.length > 0) {
        return invalidInput(`envPathUsage rejects unknown field(s): ${unknownFields.join(', ')}`);
      }
      const target = (raw as { path?: unknown }).path;
      if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || target.includes('\u0000')) {
        return invalidInput('envPathUsage path must be a non-empty string without NUL, at most 4096 chars');
      }
      const procRoot = options.pathUsage?.procRoot ?? '/proc';
      // and Hub side shared use @helm/env-io the same node fs adapt, never each duplicate one set semantics.
      const io = createNodePathUsageIo();
      const result = await scanPathUsage(target, {
        io,
        platform: options.pathUsage?.platform?.() ?? process.platform,
        ...(procRoot === '/proc' ? {} : { procRoot }),
      });
      if (result.ok) return { ok: true, value: result.value };
      const code = result.error.code === 'invalid'
        ? 'invalid'
        : result.error.code === 'not_supported'
          ? 'not_supported'
          : result.error.code === 'permission_denied'
            ? 'permission_denied'
            : result.error.code === 'aborted'
              ? 'aborted'
              : 'unknown';
      return { ok: false, error: { code, message: result.error.message } };
    },

    async envCreateDir({ path: target, recursive, cwd }) {
      return unwrap(envFor(cwd).createDir(target, { recursive }));
    },
    async envRemove({ path: target, recursive, force, cwd }) {
      return unwrap(envFor(cwd).remove(target, { recursive, force }));
    },
    async envCreateTempDir({ prefix, cwd }) {
      return unwrap(envFor(cwd).createTempDir(prefix));
    },
    async envCreateTempFile({ prefix, suffix, cwd }) {
      return unwrap(envFor(cwd).createTempFile({ prefix, suffix }));
    },

    async envOpenTextLineReader({ path: target, cwd }) {
      const result = await envFor(cwd).openTextLineReader(target);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await putReader({ kind: 'text', reader: result.value }) } };
    },
    async envTextReaderRead({ readerId }) {
      const reader = getReader<TextLineReader>(readerId, 'text');
      if (reader === undefined) return readerNotFound(readerId);
      const result = await reader.readLine();
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: result.value ?? null };
    },
    async envTextReaderClose({ readerId }) {
      await closeReader(readerId);
      return { ok: true, value: null };
    },

    async envOpenBinaryReader({ path: target, noFollow, cwd }) {
      const result = await envFor(cwd).openBinaryReader(target, { noFollow });
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await putReader({ kind: 'binary', reader: result.value }) } };
    },
    async envBinaryReaderInfo({ readerId }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.info());
    },
    async envBinaryReaderRead({ readerId, offset, length }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      // transfer cap: request read length over 64 MiB explicit reject (page read by caller batch enter row).
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(
          `length must be a safe integer no greater than ${MAX_BINARY_TRANSFER_BYTES}`,
        );
      }
      const result = await reader.read(offset, length);
      if (!result.ok) return rpcFail(result.error);
      if (result.value.byteLength > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(
          `binary reader chunk is ${result.value.byteLength} bytes, exceeding the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`,
        );
      }
      return {
        ok: true,
        value: { base64: Buffer.from(result.value).toString('base64'), byteLength: result.value.byteLength },
      };
    },
    async envBinaryReaderScanLines({ readerId, startLine, endLine }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }));
    },
    async envBinaryReaderClose({ readerId }) {
      await closeReader(readerId);
      return { ok: true, value: null };
    },

    async envOpenDirReader({ path: target, cwd }) {
      const result = await envFor(cwd).openDirReader(target);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await putReader({ kind: 'dir', reader: result.value }) } };
    },
    async envDirReaderNext({ readerId, maxEntries }) {
      const reader = getReader<DirReader>(readerId, 'dir');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.next(maxEntries));
    },
    async envDirReaderClose({ readerId }) {
      await closeReader(readerId);
      return { ok: true, value: null };
    },

    async envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>> {
      return execOnce(input);
    },

    async envAbortExec(execId: string): Promise<void> {
      running.get(execId)?.controller.abort(new Error('aborted by hub'));
    },

    /**
     * by cwd granularity clean up: kill same cwd under**all**in-flight command process tree (envs by same node many
     * conversation sharing,cwd is not conversation isolated key), will mistakenly kill same cwd other conversation in-flight command;
     * Hub side remote-env moment intent do not invoke this method (connect level dispose fall back).
     * draining/disposed when reject: arrange empty phase clean kill break arrange empty do not strong kill transaction semantics
     * (birpc error message seal such as back refuse, not silently).
     */
    async envCleanup(cwd?: string): Promise<void> {
      if (disposed) {
        throw Object.assign(new Error('server disposed, rejecting envCleanup'), { code: 'aborted' });
      }
      if (draining) {
        throw Object.assign(
          new Error('daemon is draining (upgrade in progress), rejecting envCleanup (would kill in-flight commands of all sessions sharing the cwd)'),
          { code: 'node_draining' },
        );
      }
      await Promise.all(
        [...envs.values()].map(async (env) => {
          if (cwd !== undefined && env.cwd !== cwd) return;
          await env.cleanup().catch(() => undefined);
        }),
      );
    },

    ipcCall: ipc.ipcCall,
    ipcAbortCall: ipc.ipcAbortCall,
    ipcSubscribe: ipc.ipcSubscribe,
    ipcUnsubscribe: ipc.ipcUnsubscribe,
  };
  // tunnel RPC attach (protocol NodeEnvRpcFunctions already contains optional two method).
  const rpcFunctions: NodeEnvRpcFunctions = Object.assign(rpc, {
    nodeTunnelOpen: (input: NodeTunnelOpenInput): Promise<RpcResult<null>> => tunnels.nodeTunnelOpen(input),
    nodeTunnelAbort: tunnels.nodeTunnelAbort,
  });

  /**
   * boundary unify wrap: all RpcResult return RPC- -disposed / sync exception /
   * null input solve construct error - - one rule rotate is structure RpcResult error message seal, never to
   * birpc caller throw bare exception.void return abort/cleanup do not change signature.
   *
   * method difference only via admit parameter:
   * - drainingWhat: reference and upgrade arrange empty refuse new method and its refuse new text proposal theme; not config
   *   method do not refuse new (file only read side and arrange empty without closure), and in latency execute segment re-check disposed
   *   (subject to and execute between by dispose when with aborted reject, no longer trigger touch original);
   * - tracker: subject to i.e. count arrange empty inside omit (trackExec / trackIpc).
   */
  const guardRpcMethod = (
    original: (...args: unknown[]) => Promise<RpcResult<unknown>>,
    admit: { drainingWhat?: string; tracker?: <T>(promise: Promise<T>) => Promise<T> },
  ): ((...args: unknown[]) => Promise<RpcResult<unknown>>) =>
    async (...args: unknown[]): Promise<RpcResult<unknown>> => {
      if (disposed) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
      if (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return invalidInput('RPC input must be an object');
      if (admit.drainingWhat !== undefined && draining) {
        return { ok: false, error: drainingRejection(admit.drainingWhat) };
      }
      const recheckDisposedInFlight = admit.drainingWhat === undefined;
      const operation = Promise.resolve().then(() =>
        recheckDisposedInFlight && disposed
          ? { ok: false as const, error: { code: 'aborted' as const, message: 'server disposed' } }
          : original(...args),
      );
      const tracked = admit.tracker !== undefined ? admit.tracker(operation) : operation;
      pendingOperations.add(tracked);
      try {
        return await tracked;
      } catch (error) {
        return rpcFail(error);
      } finally {
        pendingOperations.delete(tracked);
      }
    };

  const pendingOperations = new Set<Promise<unknown>>();
  const guarded = rpcFunctions as unknown as Record<string, unknown>;
  for (const key of Object.keys(rpcFunctions)) {
    if (VOID_RPC_METHODS.has(key)) continue;
    const original = guarded[key];
    if (typeof original !== 'function') continue;
    const admit = ADMIT_POLICIES[key];
    const tracker =
      admit?.tracked === 'exec' ? trackExec
      : admit?.tracked === 'ipc' ? ipc.trackIpc
      : undefined;
    guarded[key] = guardRpcMethod(original as (...args: unknown[]) => Promise<RpcResult<unknown>>, {
      drainingWhat: admit?.drainingWhat,
      tracker,
    });
  }

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      for (const exec of running.values()) exec.controller.abort(new Error('connection closed'));
      // tunnel/IPC: destroy all TCP, double work stream and socket and empty in-flight register (idempotent).
      tunnels.destroyAllTunnels();
      ipc.destroySockets();
      await Promise.allSettled([...pendingOperations, ...execWaiters, ...tunnels.getTunnelWaiters()]);
      const handles = [...readers.values()];
      readers.clear();
      await Promise.all(handles.map((handle) => handle.reader.close()));
      running.clear();
      await Promise.all([...envs.values()].map((env) => env.cleanup()));
      envs.clear();
    })();
    return disposal;
  };

  return Object.assign(rpcFunctions, {
    dispose,
    resolveIpcEndpoint: (input: { endpoint?: string; session?: string }): string =>
      resolveHerdrIpcEndpoint(input),
    setDraining: (value: boolean): void => {
      draining = value === true;
    },
    // arrange empty inside omit by already subject to counter (execWaiters/ipcWaiters in subject to sync segment register).
    getActiveExecCount: () => execWaiters.size,
    getOpenReaderCount: () => readers.size,
    getActiveIpcCallCount: () => ipc.getActiveCallCount(),
    getActiveIpcSubscriptionCount: () => ipc.getActiveSubscriptionCount(),
    getActiveTunnelCount: () => tunnels.getActiveTunnelCount(),
  }) as NodeEnvRpcServer;
}
