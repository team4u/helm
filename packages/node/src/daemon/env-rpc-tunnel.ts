/**
 * Node-side TCP tunnel handler (`nodeTunnelOpen` / `nodeTunnelAbort`): opens a local TCP socket to
 * `host:port` (default `127.0.0.1`) and pipes it bidirectionally to the daemon-injected WS tunnel
 * duplex stream (`openTunnelStream`). Credentials stay out of this layer.
 */

import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { RpcEnvError, RpcResult } from '@helmx/protocol';
import { drainingRejection, invalidInput, isRecord, rpcFail } from './env-rpc-shared.js';

const TUNNEL_OPEN_DEFAULT_MS = 15_000;
const TUNNEL_DEFAULT_HOST = '127.0.0.1';
const TUNNEL_HOST_MAX_CHARS = 255;

/** Validate optional tunnel target host (non-empty <=255 chars, no whitespace or control characters). */
const assertValidTunnelHost = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > TUNNEL_HOST_MAX_CHARS) {
    throw Object.assign(
      new Error(`nodeTunnelOpen host must be a non-empty string of 1..${TUNNEL_HOST_MAX_CHARS} characters`),
      { code: 'invalid' },
    );
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x20) {
      throw Object.assign(new Error('nodeTunnelOpen host must not contain control or whitespace characters'), { code: 'invalid' });
    }
  }
  if (raw.trim() !== raw) {
    throw Object.assign(new Error('nodeTunnelOpen host must not have leading/trailing whitespace'), { code: 'invalid' });
  }
  return raw;
};

interface ActiveTunnel {
  tunnelId: string;
  tcp: net.Socket;
  duplex?: Duplex;
  controller: AbortController;
  lifecycle: Promise<void>;
  settle(): void;
}

export interface TunnelHandlerOptions {
  /** Opens the daemon-authenticated WS tunnel duplex stream for `tunnelId`. */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
  isDisposed(): boolean;
  isDraining(): boolean;
}

export interface TunnelHandler {
  nodeTunnelOpen(raw: unknown): Promise<RpcResult<null>>;
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  destroyAllTunnels(): void;
  getActiveTunnelCount(): number;
  getTunnelWaiters(): Set<Promise<void>>;
}

/** Create a per-connection tunnel handler. */
export function createTunnelHandler(options: TunnelHandlerOptions): TunnelHandler {
  const { openTunnelStream, isDisposed, isDraining } = options;
  const activeTunnels = new Map<string, ActiveTunnel>();
  const tunnelWaiters = new Set<Promise<void>>();

  const newTunnel = (tunnelId: string, tcp: net.Socket): ActiveTunnel => {
    let settle!: () => void;
    const lifecycle = new Promise<void>((resolve) => { settle = resolve; });
    const tunnel: ActiveTunnel = { tunnelId, tcp, controller: new AbortController(), lifecycle, settle };
    tunnelWaiters.add(lifecycle);
    activeTunnels.set(tunnelId, tunnel);
    return tunnel;
  };

  /** Abort handshake and tear down both ends of a tunnel idempotently. */
  const teardownTunnel = (tunnel: ActiveTunnel): void => {
    if (activeTunnels.get(tunnel.tunnelId) !== tunnel) return;
    activeTunnels.delete(tunnel.tunnelId);
    tunnel.controller.abort(new Error('tunnel aborted'));
    try { tunnel.tcp.destroy(); } catch { /* already destroyed */ }
    if (tunnel.duplex !== undefined) {
      tunnel.duplex.once('error', () => undefined);
      try { void Promise.resolve(tunnel.duplex.destroy()).catch(() => undefined); } catch { /* sync throw */ }
    }
    tunnelWaiters.delete(tunnel.lifecycle);
    tunnel.settle();
  };

  const nodeTunnelOpenCore = async (raw: unknown): Promise<RpcResult<null>> => {
    if (!isRecord(raw) || Array.isArray(raw)) return invalidInput('nodeTunnelOpen input must be a plain object');
    const unknownFields = Object.keys(raw).filter(
      (key) => key !== 'tunnelId' && key !== 'port' && key !== 'timeoutMs' && key !== 'host',
    );
    if (unknownFields.length > 0) {
      return invalidInput(`nodeTunnelOpen rejects unknown field(s): ${unknownFields.join(', ')}`);
    }
    const tunnelId = raw['tunnelId'];
    if (typeof tunnelId !== 'string' || tunnelId.length === 0 || tunnelId.length > 128) {
      return invalidInput('nodeTunnelOpen tunnelId must be a string of 1..128 characters');
    }
    const port = raw['port'];
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return invalidInput('nodeTunnelOpen port must be a safe integer within 1..65535');
    }
    let host: string;
    try {
      host = assertValidTunnelHost(raw['host']) ?? TUNNEL_DEFAULT_HOST;
    } catch (error) {
      return rpcFail(error);
    }
    const rawTimeout = raw['timeoutMs'];
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
      return invalidInput('nodeTunnelOpen timeoutMs must be a positive finite number when present');
    }
    if (typeof openTunnelStream !== 'function') {
      return {
        ok: false,
        error: { code: 'not_supported', message: 'node daemon has no tunnel transport configured (openTunnelStream missing); refusing nodeTunnelOpen' },
      };
    }
    if (activeTunnels.has(tunnelId)) {
      return invalidInput(`nodeTunnelOpen tunnelId is already active: ${JSON.stringify(tunnelId)}`);
    }
    if (isDraining() || isDisposed()) {
      return {
        ok: false,
        error: isDisposed()
          ? { code: 'aborted', message: 'server disposed' }
          : drainingRejection('tunnels'),
      };
    }
    // Single overall budget spanning TCP connect + WS handshake.
    const budgetMs = typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : TUNNEL_OPEN_DEFAULT_MS;
    const target = `${host}:${port}`;
    const tcp = net.connect({ host, port });
    const tunnel = newTunnel(tunnelId, tcp);
    let settled = false;
    let settleResult: (result: RpcResult<null>) => void = () => undefined;
    const rpcResult = new Promise<RpcResult<null>>((resolve) => { settleResult = resolve; });
    const settleOnce = (result: RpcResult<null>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      settleResult(result);
    };
    const connectFailed = (detail: string): RpcEnvError => ({
      code: 'connect_failed',
      message: `tunnel TCP connect to ${target} failed: ${detail}`,
    });
    const budgetTimer = setTimeout(() => {
      settleOnce({ ok: false, error: { code: 'timeout', message: `tunnel open timed out after ${budgetMs}ms (${target})` } });
      teardownTunnel(tunnel);
    }, budgetMs);
    const onTcpError = (error: Error): void => {
      if (activeTunnels.get(tunnelId) !== tunnel) return;
      settleOnce({ ok: false, error: connectFailed(error.message) });
      teardownTunnel(tunnel);
    };
    tcp.on('error', onTcpError);
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once('connect', () => resolve());
        tcp.once('error', (error) => reject(connectFailed(error.message)));
        tunnel.controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('tunnel aborted'), { code: 'aborted' })),
          { once: true },
        );
      });
    } catch {
      if (!settled) {
        settleOnce(
          tunnel.controller.signal.aborted
            ? { ok: false, error: { code: 'aborted', message: 'tunnel aborted' } }
            : { ok: false, error: connectFailed('connection failed') },
        );
      }
      teardownTunnel(tunnel);
      return await rpcResult;
    }
    // Pause TCP while the WS tunnel handshake runs so early server banners are buffered, not dropped.
    tcp.pause();
    // Attach a no-op readable listener so libuv still detects peer EOF/RST during the handshake.
    const keepPollingForEof = (): void => {};
    tcp.on('readable', keepPollingForEof);
    let handshakeDone = false;
    const onHandshakePeerClosed = (): void => {
      if (handshakeDone || activeTunnels.get(tunnelId) !== tunnel) return;
      cleanupHandshakeListeners();
      settleOnce({ ok: false, error: connectFailed('peer closed connection during tunnel handshake') });
      teardownTunnel(tunnel);
    };
    const cleanupHandshakeListeners = (): void => {
      tcp.off('readable', keepPollingForEof);
      tcp.off('end', onHandshakePeerClosed);
      tcp.off('close', onHandshakePeerClosed);
    };
    tcp.once('end', onHandshakePeerClosed);
    tcp.once('close', onHandshakePeerClosed);
    if (tcp.destroyed || tcp.readableEnded) {
      onHandshakePeerClosed();
    }
    const streamPromise = Promise.resolve(openTunnelStream(tunnelId, tunnel.controller.signal));
    void streamPromise.then(
      (late) => { if (handshakeDone || activeTunnels.get(tunnelId) !== tunnel) late.destroy(); },
      () => undefined,
    );
    let duplex: Duplex;
    try {
      duplex = await new Promise<Duplex>((resolve, reject) => {
        tunnel.controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('tunnel aborted'), { code: 'aborted' })),
          { once: true },
        );
        streamPromise.then(
          (stream) => resolve(stream),
          (error) => reject(error),
        );
      });
    } catch (error) {
      handshakeDone = true;
      cleanupHandshakeListeners();
      settleOnce(rpcFail(error));
      teardownTunnel(tunnel);
      return await rpcResult;
    }
    if (settled || activeTunnels.get(tunnelId) !== tunnel) {
      handshakeDone = true;
      cleanupHandshakeListeners();
      duplex.destroy();
      return await rpcResult;
    }
    handshakeDone = true;
    cleanupHandshakeListeners();
    tunnel.duplex = duplex;
    settleOnce({ ok: true, value: null });
    // Let normal FIN/EOF propagate through `pipe()` before tearing down; force-destroy on error/close/abort.
    const teardown = (): void => teardownTunnel(tunnel);
    duplex.once('error', teardown);
    duplex.once('close', teardown);
    duplex.once('aborted', teardown);
    tcp.pipe(duplex);
    duplex.pipe(tcp);
    return await rpcResult;
  };

  const teardownTunnelById = (tunnelId: string): void => {
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel === undefined) return;
    teardownTunnel(tunnel);
  };

  const nodeTunnelAbort = async (tunnelId: string): Promise<void> => {
    teardownTunnelById(tunnelId);
  };

  return {
    nodeTunnelOpen: nodeTunnelOpenCore,
    nodeTunnelAbort,
    destroyAllTunnels: () => {
      for (const tunnel of [...activeTunnels.values()]) teardownTunnel(tunnel);
    },
    getActiveTunnelCount: () => activeTunnels.size,
    getTunnelWaiters: () => tunnelWaiters,
  };
}
