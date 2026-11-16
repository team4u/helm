/**
 * instance control channel: across platform end point naming, single request client and daemon side IPC server.
 *
 * - end point:sha256(dataDir+instanceId) short hash;Unix UDS / Windows named pipe;
 * - protocol: single row JSON ≤64KiB, carries idle/request pre- compute, verify instanceId, only accept
 *   status/stop/upgrade- - never to without closure process send signal or keystroke;
 * - client failed to connect/timeout/response illegal one rule return null(caller zone cannot reach and
 *   by reject);ok response attach carries expectation pid/instanceId when validate consistency.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import { UsageError } from './cli-context.js';

/** background daemon ready state:registered=completed Hub register;starting=process store continuous reconnect (can diagnose). */
export type DaemonReadyState = 'registered' | 'starting';

/** ready on report total pre- compute. */
export const READY_TIMEOUT_MS = 45_000;
/** control channel connect/response/idle pre- compute (status query,stop request channel layer cap). */
export const CONTROL_TIMEOUT_MS = 5_000;
/** stop request total pre- compute:daemon must first complete handle.close execute environment clean up again reply. */
export const CONTROL_STOP_TIMEOUT_MS = 15_000;
/** control protocol single row cap (byte);upgrade request carry input, fit when increase large. */
export const CONTROL_MAX_LINE_BYTES = 64_096;
/** upgrade request total pre- compute: must greater than install most long when limit (npm install 10 minute). */
export const CONTROL_UPGRADE_TIMEOUT_MS = 11 * 60_000;
/** stop by accept after wait for process real exit cap. */
export const STOP_EXIT_TIMEOUT_MS = 10_000;
/** old daemon upgrade after commit latency exit time: to response conflict refresh remaining amount. */
export const UPGRADE_EXIT_DELAY_MS = 100;

/**
 * control end point:sha256(dataDir + instanceId) short hash naming, avoid path over long and collision.
 * Unix: /tmp/helm-node-<hash>.sock;Windows: \\.\pipe\helm-node-<hash>.
 */
export function controlEndpoint(dataDir: string, instanceId: string): string {
  const hash = createHash('sha256').update(`${dataDir}\0${instanceId}`).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\helm-node-${hash}` : `/tmp/helm-node-${hash}.sock`;
}

/** control channel response:ok=true when contains real pid/instanceId/state;ok=false when contains error;upgrade attach result. */
export interface ControlResponse {
  ok: boolean;
  pid?: number;
  instanceId?: string;
  state?: DaemonReadyState | 'stopping';
  /** status response attach carries run version (daemon real on report, via getNodeVersion read). */
  version?: string;
  result?: unknown;
  error?: string;
}

/** control channel request payload (upgrade carry upgrade reference). */
export interface ControlRequest {
  type: 'status' | 'stop' | 'upgrade';
  instanceId: string;
  input?: unknown;
}

/**
 * control channel client: single connect single request (one row JSON request, one row JSON response).
 * failed to connect/timeout/response illegal one rule return null(caller zone cannot reach and by reject);
 * ok response attach carries expectation pid/instanceId when verify consistency (local machine credentials cannot mistakenly stop another instance).
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
        // identity verify:ok response must from Profile points to the same instance (pid/instanceId inconsistent
        // treated as invalid response - - local machine credentials cannot mistakenly operation another instance).
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

/**
 * control channel upgrade response result validate (boundary where Schema validate): must be contains ok===true,
 * boolean upgraded, non-empty string previousVersion/targetVersion, positive integer pid(new instance)
 * object; illegal or ok:false throw UsageError, never illegal artifact when succeeded output.
 */
export function validateUpgradeResult(
  raw: unknown,
): { previousVersion: string; targetVersion: string; upgraded: boolean; pid?: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError('upgrade response result is not legal object (reject fabricate succeeded, please use helm-node status verify actual state)', 'invalid_upgrade_result');
  }
  const record = raw as Record<string, unknown>;
  if (record['ok'] !== true) {
    throw new UsageError(
      `upgrade response result ok do not is true(${JSON.stringify(record['ok'] ?? '(missing)')}, reject fabricate succeeded)`,
      'invalid_upgrade_result',
    );
  }
  if (typeof record['upgraded'] !== 'boolean') {
    throw new UsageError('upgrade response result missing boolean upgraded field (reject fabricate succeeded)', 'invalid_upgrade_result');
  }
  for (const key of ['previousVersion', 'targetVersion'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string) === '') {
      throw new UsageError(`upgrade response result missing non-empty string ${key}(reject fabricate succeeded)`, 'invalid_upgrade_result');
    }
  }
  const pid = record['pid'];
  if ((record['upgraded'] || pid !== undefined) && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new UsageError('upgrade response result missing new instance positive integer pid(reject fabricate succeeded)', 'invalid_upgrade_result');
  }
  return {
    previousVersion: record['previousVersion'] as string,
    targetVersion: record['targetVersion'] as string,
    upgraded: record['upgraded'] as boolean,
    ...(typeof pid === 'number' ? { pid } : {}),
  };
}

/** daemon side control server: only accept status/stop/upgrade;instanceId does not match one rule reject and does not affect process. */
export interface ControlServer {
  listening: Promise<void>;
  close(): Promise<void>;
}

export function createControlServer(options: {
  endpoint: string;
  instanceId: string;
  onStatus: () => { pid: number; state: DaemonReadyState; version?: string };
  onStop: () => Promise<void>;
  /** upgrade request (local machine can message source); return result follow response pass-through, upgrade in-flight when reject stop/restart. */
  onUpgrade?: (input: unknown) => Promise<unknown>;
  /** upgrade in-flight probe (busy when reject stop/restart, old control end point continue available). */
  isUpgrading?: () => boolean;
}): ControlServer {
  const { endpoint, instanceId, onStatus, onStop, onUpgrade, isUpgrading } = options;
  const sockets = new Set<net.Socket>();
  let stopping = false;
  let closed = false;
  /** stop handle chain (contains reply conflict refresh and self clean up):close() must first etc. it complete, guard against reply by destroy. */
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
      // close call back in server not listen/already closure when may different step return: fall back immediately resolve.
      if (!server.listening) resolve();
    });
    if (socketFile !== undefined) await fsp.rm(socketFile, { force: true }).catch(() => undefined);
  };

  /** stop handle chain: etc. reply truly conflict refresh to for end after again closure server(destroy will discard not conflict refresh buffer). */
  const runStopAndClose = async (socket: net.Socket, replyAndWait: (payload: Record<string, unknown>) => Promise<void>): Promise<void> => {
    try {
      await onStop();
      await replyAndWait({ ok: true, pid: process.pid, instanceId, state: 'stopping' });
    } catch (error) {
      await replyAndWait({
        ok: false,
        error: `stop clean up failed:${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined);
    }
    socket.destroy();
    await closeSelf();
  };

  /** upgrade reply chain: long resident execute and wait for conflict refresh (pre- compute far greater than idle timeout). */
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
    /** same reply, but wait for data truly conflict refresh (stop/upgrade path destroy socket before must guarantee reply can reach). */
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
      // identity threshold:instanceId inconsistent one rule reject (never trigger stop, guard against mistakenly kill without closure instance).
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
        // upgrade in-flight: explicit reject stop(choose may already take over responsibility), old control end point continue available.
        if (isUpgrading?.() === true) {
          reply({ ok: false, error: 'upgrade_in_progress' });
          return;
        }
        stopping = true;
        server.close(() => undefined); // immediately stop accept new connect; store amount connect by this branch reply
        stopChain = runStopAndClose(socket, replyAndWait);
        return;
      }
      if (request.type === 'upgrade') {
        // upgrade pre- compute far greater than idle timeout: subject to after first clean idle, long resident to reply complete.
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
      // first etc. in-flight stop chain (contains reply conflict refresh) complete, again hard clean up - - otherwise reply will by destroy lose.
      if (stopChain !== undefined) await stopChain.catch(() => undefined);
      await closeSelf();
    },
  };
}
