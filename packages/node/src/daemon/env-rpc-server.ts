/**
 * Node-side remote execution RPC server implementing `NodeEnvRpcFunctions`.
 *
 * File and shell operations are handled by `LocalExecutionEnv` (our thin adapter over
 * `@earendil-works/pi-durable/env/node`'s `NodeExecutionEnv`, see `./local-env.ts`), scoped
 * per `cwd`, with `readerId` handles and per-exec `AbortController`s. Herdr IPC (`ipcCall` /
 * `ipcSubscribe`) and TCP tunneling (`nodeTunnelOpen` / `nodeTunnelAbort`) are delegated to
 * `./env-rpc-ipc.ts` and `./env-rpc-tunnel.ts` with centralized admission/draining guards.
 *
 * Error semantics: requests rejected due to upgrade draining return `node_draining`, while
 * user/host cancellation, generation retirement, and disposal return `aborted`.
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
  /** Base directory for relative paths (daemon data directory). */
  defaultCwd: string;
  /** Callback forwarding shell stdout/stderr chunks back to the Hub (`onEnvExecOutput`). */
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  /** Daemon-injected base env vars for shell commands (e.g. `HELM_HUB_URL`). */
  shellEnv?: Record<string, string | undefined>;
  /** Maximum characters per streamed output chunk (>= 1; defaults to 256 KiB chars). */
  maxOutputChunkChars?: number;
  /** Callback forwarding Herdr IPC subscription events back to the Hub (`onIpcEvent`). */
  onIpcEvent?: (event: NodeIpcEvent) => void;
  /** Callback forwarding Herdr IPC subscription closures back to the Hub (`onIpcClosed`). */
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /** Optional idle timeout for `ipcCall`; omitted so long Herdr calls obey caller timeout/abort. */
  ipcCallIdleTimeoutMs?: number;
  /** Optional single-frame byte cap for Herdr IPC (defaults to `MAX_IPC_FRAME_BYTES = 32 MiB`). */
  maxIpcFrameBytes?: number;
  /** Test/managed-host overrides for `envPathUsage` scanning. */
  pathUsage?: {
    procRoot?: string;
    platform?: () => string;
  };
  /**
   * Hard grace window (ms, default 500) for stdio to drain after abort/timeout so detached
   * descendants holding stdout/stderr open cannot hang `envExec` or `dispose()` indefinitely.
   */
  abortDrainGraceMs?: number;
  /** Daemon-injected duplex stream opener for `/ws/node-tunnel` (keeps credentials out of this layer). */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
}

const readerNotFound = <T>(readerId: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'not_found', message: `Unknown reader: ${readerId}` },
});

/** Binary transfer payload limit (64 MiB). */
const MAX_BINARY_TRANSFER_BYTES = 64 * 1024 * 1024;

/** Strict base64 decoder (standard alphabet + padding, rejecting invalid chars and oversized payloads). */
const decodeBase64 = (content: string, what: string): Uint8Array => {
  if (typeof content !== 'string') {
    throw Object.assign(new Error(`${what} must be a base64 string`), { code: 'invalid' });
  }
  const encodedLimit = Math.ceil(MAX_BINARY_TRANSFER_BYTES / 3) * 4;
  if (content.length > encodedLimit) {
    throw Object.assign(new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`), { code: 'invalid' });
  }
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
 * Split UTF-16 output chunks on code-point boundaries so surrogate pairs are never torn across
 * JSON frames (which would introduce U+FFFD replacement characters on reassembly).
 */
const safeChunkEnd = (text: string, offset: number, limit: number): number => {
  const desired = Math.min(offset + Math.max(limit, 1), text.length);
  if (desired >= text.length) return text.length;
  const code = text.charCodeAt(desired - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    const backed = desired - 1;
    return backed > offset ? backed : desired + 1;
  }
  return desired;
};

/** `NodeEnvRpcFunctions` extended with lifecycle control (`dispose`, `setDraining`) and introspection. */
export interface NodeEnvRpcServer extends NodeEnvRpcFunctions {
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** Close all open readers, abort active commands, and tear down IPC/tunnel sockets. Idempotent. */
  dispose(): Promise<void>;
  /** Enable/disable drain mode (rejects new exec/IPC/tunnel calls with `node_draining`; existing work continues). */
  setDraining(value: boolean): void;
  getActiveExecCount(): number;
  getOpenReaderCount(): number;
  getActiveIpcCallCount(): number;
  getActiveIpcSubscriptionCount(): number;
  getActiveTunnelCount(): number;
}

/** Void-returning RPCs that throw directly via birpc instead of wrapping in `RpcResult`. */
const VOID_RPC_METHODS = new Set(['envAbortExec', 'envCleanup', 'ipcAbortCall', 'ipcUnsubscribe', 'nodeTunnelAbort']);

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

  const unwrap = async <T, R = T extends void ? null : T>(
    promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
  ): Promise<RpcResult<R>> => {
    const result = await promise;
    return result.ok ? { ok: true, value: (result.value ?? null) as R } : rpcFail(result.error);
  };

  /** Build child env while stripping daemon credentials (`HELM_TOKEN` / `HELM_EXECUTION_SCOPE`) unless explicitly supplied in `input.env`. */
  const buildExecEnv = (
    input: { env?: Record<string, string>; inheritEnv?: boolean },
  ): { env: Record<string, string>; inheritEnv: false } => {
    const merged: Record<string, string> = {};
    if (input.inheritEnv !== false) {
      for (const [key, value] of Object.entries(process.env)) {
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
    if (running.has(execId)) {
      return invalidInput(`Duplicate execId in flight: ${JSON.stringify(execId)}`);
    }
    const executionEnv = envFor(cwd);
    const controller = new AbortController();
    running.set(execId, { controller });
    const emit = (text: string, stream: 'stdout' | 'stderr', skipped?: EnvExecOutputEvent['skipped']): void => {
      if (!onExecOutput) return;
      for (let offset = 0; offset < text.length;) {
        const end = safeChunkEnd(text, offset, maxOutputChunkChars);
        onExecOutput({ execId, text: text.slice(offset, end), stream, ...(offset === 0 && skipped ? { skipped } : {}) });
        offset = end;
      }
    };
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
    controller.signal.addEventListener('abort', () => {
      if (execSettled) return;
      const timer = setTimeout(
        () => forceSettleNow('aborted', 'Command aborted (stdio drain grace exceeded)'),
        abortDrainGraceMs,
      );
      drainTimers.add(timer);
    }, { once: true });
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
      // Optional `listFiles` is not implemented on remote nodes; callers fall back to directory walks.
      return { ok: false, error: { code: 'not_supported', message: 'listFiles is not available on this environment' } };
    },
    async envCanonicalPath({ path: target, cwd }) {
      return unwrap(envFor(cwd).canonicalPath(target));
    },
    async envExists({ path: target, cwd }) {
      return unwrap(envFor(cwd).exists(target));
    },

    /** Scan `/proc` via `@helm/env-io` to report processes referencing `path` (read-only). */
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

    /** Kill all running commands for `cwd` (or all cwds); rejected while draining or disposed. */
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
  const rpcFunctions: NodeEnvRpcFunctions = Object.assign(rpc, {
    nodeTunnelOpen: (input: NodeTunnelOpenInput): Promise<RpcResult<null>> => tunnels.nodeTunnelOpen(input),
    nodeTunnelAbort: tunnels.nodeTunnelAbort,
  });

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
    getActiveExecCount: () => execWaiters.size,
    getOpenReaderCount: () => readers.size,
    getActiveIpcCallCount: () => ipc.getActiveCallCount(),
    getActiveIpcSubscriptionCount: () => ipc.getActiveSubscriptionCount(),
    getActiveTunnelCount: () => tunnels.getActiveTunnelCount(),
  }) as NodeEnvRpcServer;
}
