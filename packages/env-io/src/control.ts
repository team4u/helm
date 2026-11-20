/**
 * Cross-process control channel shared by long-running Helmx processes (`@helmx/node` daemon and
 * the local Hub): deterministic endpoint naming, a single-shot client, and the server side.
 *
 * - Endpoint: short `sha256(dataDir + instanceId)` hash per product (`Unix UDS` / `Windows named pipe`).
 * - Protocol: newline-delimited JSON <= 64 KiB with request/idle timeouts; the server validates
 *   `instanceId` and accepts only `status`, `stop`, and `upgrade` (never signals unverified PIDs).
 * - Client returns `null` on connect failure, timeout, or invalid response, and validates `pid` /
 *   `instanceId` against expectations when provided.
 *
 * This module is pure mechanism (no product policy): the `state` field is an opaque string owned
 * by the embedding product, and the optional `upgrade` command is only active when the server
 * supplies a handler.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';

/** Control-channel connect, response, and idle timeout for status/stop requests. */
export const CONTROL_TIMEOUT_MS = 5_000;
/** Total timeout for `stop`: the target must finish cleanup before replying. */
export const CONTROL_STOP_TIMEOUT_MS = 15_000;
/** Maximum single-line control frame size (bytes), sized to carry upgrade request options. */
export const CONTROL_MAX_LINE_BYTES = 64_096;
/** Total timeout for `upgrade`: exceeds max npm install time (10 minutes). */
export const CONTROL_UPGRADE_TIMEOUT_MS = 11 * 60 * 1000;
/** Timeout waiting for the target process to exit after accepting `stop`. */
export const STOP_EXIT_TIMEOUT_MS = 10_000;

/**
 * Derive the deterministic control endpoint from `sha256(dataDir + '\0' + instanceId)`.
 * Unix: `/tmp/<product>-<hash>.sock`; Windows: `\\.\pipe\<product>-<hash>`.
 * `product` namespaces sibling installations (e.g. `helmx-node`, `helmx-hub`).
 */
export function controlEndpoint(dataDir: string, instanceId: string, product: string): string {
  const hash = createHash('sha256').update(`${dataDir}\0${instanceId}`).digest('hex').slice(0, 16);
  const safeProduct = product.replace(/[^A-Za-z0-9-]/g, '-');
  return process.platform === 'win32' ? `\\\\.\\pipe\\${safeProduct}-${hash}` : `/tmp/${safeProduct}-${hash}.sock`;
}

/** Endpoint prefix namespacing Hub control sockets (distinct from `helmx-node`). */
export const HUB_CONTROL_PRODUCT = 'helmx-hub';

/** Discovery record a running Hub writes into its data directory (`0600`, removed on shutdown). */
export interface HubControlRecord {
  instanceId: string;
  endpoint: string;
  pid: number;
  version: string;
  port: number;
  startedAt: string;
}

function validateHubControlRecord(raw: unknown): HubControlRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = rec[key];
    if (typeof value !== 'string' || value === '') throw new Error(`expected field "${key}" to be a non-empty string`);
    return value;
  };
  const port = rec['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('expected field "port" to be an integer between 1 and 65535');
  }
  const pid = rec['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error('expected field "pid" to be a positive integer');
  return { instanceId: str('instanceId'), endpoint: str('endpoint'), pid, version: str('version'), port, startedAt: str('startedAt') };
}

/** Record path inside the Hub data directory (`<dataDir>/hub-control.json`). */
export function hubControlRecordPath(dataDir: string): string {
  return path.join(dataDir, 'hub-control.json');
}

/** Strict reader for CLI / handoff consumers; `null` only on ENOENT, corrupt records throw. */
export async function readHubControlRecord(dataDir: string): Promise<HubControlRecord | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(hubControlRecordPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`hub control record is corrupt (${hubControlRecordPath(dataDir)}); remove it and retry`);
  }
  return validateHubControlRecord(parsed);
}

/** Control-channel response payload (`state` is product-owned and opaque here). */
export interface ControlResponse {
  ok: boolean;
  pid?: number;
  instanceId?: string;
  state?: string;
  /** Running version reported by the target process, when known. */
  version?: string;
  result?: unknown;
  error?: string;
}

/** Control-channel request payload. */
export interface ControlRequest {
  type: 'status' | 'stop' | 'upgrade';
  instanceId: string;
  input?: unknown;
}

/**
 * Send a single control request and await one JSON response line.
 * Returns `null` on connect failure, timeout, malformed payload, or mismatched `expect` identity.
 */
export async function controlRequest(
  endpoint: string,
  request: ControlRequest,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
  expect?: { pid?: number; instanceId?: string },
): Promise<ControlResponse | null> {
  return await new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = net.connect(endpoint);
    const finish = (value: ControlResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_MAX_LINE_BYTES) { finish(null); return }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      if (line === '') return;
      try {
        const parsed = JSON.parse(line) as ControlResponse;
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
          finish(null);
          return;
        }
        // Identity verification: an `ok` response must belong to the expected PID/instanceId.
        if (parsed.ok === true && expect !== undefined) {
          if (expect.pid !== undefined && parsed.pid !== expect.pid) { finish(null); return }
          if (expect.instanceId !== undefined && parsed.instanceId !== expect.instanceId) { finish(null); return }
        }
        finish(parsed);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
  });
}

/** Server-side control IPC accepting `status`, `stop`, and `upgrade` for its `instanceId`. */
export interface ControlServer {
  listening: Promise<void>;
  close(): Promise<void>;
}

export function createControlServer(options: {
  endpoint: string;
  instanceId: string;
  onStatus: () => { pid: number; state: string; version?: string };
  onStop: () => Promise<void>;
  /** Local trusted upgrade handler; passes result through and rejects `stop` while in flight. */
  onUpgrade?: (input: unknown) => Promise<unknown>;
  /** True while an upgrade is in flight (causes `stop` to return `upgrade_in_progress`). */
  isUpgrading?: () => boolean;
}): ControlServer {
  const { endpoint, instanceId, onStatus, onStop, onUpgrade, isUpgrading } = options;
  const sockets = new Set<net.Socket>();
  let stopping = false;
  let closed = false;
  /** Tracks active stop handling (including response flush) so `close()` does not destroy the reply early. */
  let stopChain: Promise<void> | undefined;
  const socketFile = process.platform === 'win32' ? undefined : endpoint;

  const closeSelf = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // `server.close` callback may be deferred if not listening; resolve immediately as fallback.
      if (!server.listening) resolve();
    });
    if (socketFile !== undefined) await fsp.rm(socketFile, { force: true }).catch(() => undefined);
  };

  /** Execute stop callback and flush response to peer before closing the server. */
  const runStopAndClose = async (socket: net.Socket, replyAndWait: (payload: Record<string, unknown>) => Promise<void>): Promise<void> => {
    try {
      await onStop();
      await replyAndWait({ ok: true, pid: process.pid, instanceId, state: 'stopping' });
    } catch (error) {
      await replyAndWait({
        ok: false,
        error: `stop cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined);
    }
    socket.destroy();
    await closeSelf();
  };

  /** Execute long-running upgrade request and flush reply before destroying the socket. */
  const runUpgradeReply = async (
    socket: net.Socket,
    replyAndWait: (payload: Record<string, unknown>) => Promise<void>,
    input: unknown,
  ): Promise<void> => {
    try {
      const result = await onUpgrade?.(input);
      await replyAndWait({ ok: true, pid: process.pid, instanceId, state: onStatus().state, result });
    } catch (error) {
      await replyAndWait({
        ok: false,
        pid: process.pid,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    socket.destroy();
  };

  const server = net.createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => { clearTimeout(idle); sockets.delete(socket) });
    let buffer = '';
    let handled = false;
    const idle = setTimeout(() => socket.destroy(), CONTROL_TIMEOUT_MS);
    const reply = (payload: Record<string, unknown>): void => {
      try {
        socket.end(`${JSON.stringify(payload)}\n`);
      } catch {
        socket.destroy();
      }
    };
    /** Reply and wait for `socket.end` flush so stop/upgrade responses reach the caller before destroy. */
    const replyAndWait = (payload: Record<string, unknown>): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(done, 1_000);
        fallback.unref?.();
        try {
          socket.end(`${JSON.stringify(payload)}\n`, done);
        } catch {
          done();
        }
      });
    socket.on('error', () => {
      clearTimeout(idle);
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_MAX_LINE_BYTES) { clearTimeout(idle); socket.destroy(); return }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      if (handled) return;
      handled = true;
      clearTimeout(idle);
      const line = buffer.slice(0, nl).trim();
      let request: { type?: unknown; instanceId?: unknown; input?: unknown };
      try {
        request = JSON.parse(line) as { type?: unknown; instanceId?: unknown; input?: unknown };
      } catch {
        reply({ ok: false, error: 'bad_request' });
        return;
      }
      // Identity guard: reject any request whose instanceId does not match this instance.
      if (request === null || typeof request !== 'object' || request.instanceId !== instanceId) {
        reply({ ok: false, error: 'instance_mismatch' });
        return;
      }
      if (request.type === 'status') {
        const snapshot = onStatus();
        reply({ ok: true, pid: snapshot.pid, instanceId, state: snapshot.state, ...(snapshot.version !== undefined ? { version: snapshot.version } : {}) });
        return;
      }
      if (request.type === 'stop') {
        if (stopping) {
          reply({ ok: false, error: 'stopping' });
          return;
        }
        // Reject `stop` while an upgrade is in flight (candidate may already have taken over).
        if (isUpgrading?.() === true) {
          reply({ ok: false, error: 'upgrade_in_progress' });
          return;
        }
        stopping = true;
        server.close(() => undefined); // Stop accepting new connections; active connection replies via `stopChain`.
        stopChain = runStopAndClose(socket, replyAndWait);
        return;
      }
      if (request.type === 'upgrade') {
        // Upgrades outlast the idle timeout; clear idle timer once accepted.
        if (onUpgrade === undefined) {
          reply({ ok: false, error: 'upgrade_not_supported' });
          return;
        }
        if (stopping) {
          reply({ ok: false, error: 'stopping' });
          return;
        }
        clearTimeout(idle);
        void runUpgradeReply(socket, replyAndWait, (request as { input?: unknown }).input);
        return;
      }
      reply({ ok: false, error: 'unknown_command' });
    });
  });

  const listening = new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  return {
    listening,
    close: async (): Promise<void> => {
      if (stopChain !== undefined) await stopChain.catch(() => undefined);
      await closeSelf();
    },
  };
}
