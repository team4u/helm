/**
 * node side TCP tunnel handle (nodeTunnelOpen / nodeTunnelAbort):Hub request in
 * node side to target host:port(host default 127.0.0.1, by this node parse and connect) establish
 * TCP, and daemon layer inject openTunnelStream double work stream (WS tunnel,hubUrl/token
 * etc. credentials by daemon layer seal closed) double to pipe- - this layer zero credentials.draining/disposed reject
 * new tunnel (draining is node_draining,disposed is aborted);TCP in tunnel
 * grasp manually during pause,pipe after do not lose first package;dispose destroy all tunnel TCP/double work stream and wait for
 * settle. subject to guard and dispose arrange empty connect line by env-rpc-server group install.
 */

import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { RpcEnvError, RpcResult } from '@helm/protocol';
import { drainingRejection, invalidInput, isRecord, rpcFail } from './env-rpc-shared.js';

/** tunnel establish (TCP connect + double work stream grasp manually) total pre- compute, self subject to start compute (non- segment stack add). */
const TUNNEL_OPEN_DEFAULT_MS = 15_000;
/** target host default value: node local machine loopback (and since has loopback semantics compatibility). */
const TUNNEL_DEFAULT_HOST = '127.0.0.1';
/** host cap:IPv6 text form most long about 45 character, host name generally ≤253; fit remaining. */
const TUNNEL_HOST_MAX_CHARS = 255;

/**
 * host boundary validate: non-empty string,≤255 character, without control character/first tail whitespace;
 * illegal i.e. throw invalid(never static default change write or fall back loopback).
 */
const assertValidTunnelHost = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > TUNNEL_HOST_MAX_CHARS) {
    throw Object.assign(
      new Error(`nodeTunnelOpen host must be a non-empty string of 1..${TUNNEL_HOST_MAX_CHARS} characters`),
      { code: 'invalid' },
    );
  }
  // control character (contains NUL/CR/LF/Tab) and any whitespace (contains internal space) one rule reject:
  // host name disallows whitespace (guard against parse ambiguity and inject).
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
  /** create connect cancel: grasp manually in abort immediately failed, do not etc. to pre- compute exhausted. */
  controller: AbortController;
  /** double end destroy after resolve(dispose arrange empty use). */
  lifecycle: Promise<void>;
  settle(): void;
}

/** tunnel handle dependency (host inject transfer and connect lifecycle state query). */
export interface TunnelHandlerOptions {
  /**
   * open tunnel double work stream (daemon layer inject: connect Hub  /ws/node-tunnel and complete grasp manually).
   * signal used to cancel in-flight create connect (nodeTunnelAbort / dispose): implement should as soon as possible
   * reject and destroy underlying asset; this layer only consume double work stream, zero credentials.
   */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
  /** host disposed state query (connect level terminal state: refuse new is aborted). */
  isDisposed(): boolean;
  /** host draining state query (upgrade arrange empty: refuse new is node_draining). */
  isDraining(): boolean;
}

/** tunnel handle handle:RPC implement side + dispose destroy hook and arrange empty inside omit. */
export interface TunnelHandler {
  /** open tunnel (strictly validate reference;draining/disposed/connect failed structure refuse new). */
  nodeTunnelOpen(raw: unknown): Promise<RpcResult<null>>;
  /** cancel in-flight tunnel (grasp manually in or already establish): destroy the tunnel TCP/WS and immediately return. */
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** dispose hook: destroy all tunnel TCP/double work stream and compute lifecycle (teardown idempotent). */
  destroyAllTunnels(): void;
  /** in-flight tunnel amount (arrange empty inside omit; contains TCP already start not complete grasp manually tunnel). */
  getActiveTunnelCount(): number;
  /** dispose arrange empty wait for tunnel lifecycle promise set (reference, arrange empty when expand snapshot). */
  getTunnelWaiters(): Set<Promise<void>>;
}

/** create tunnel handle: a connect proxy a instance, state mutual do not sharing. */
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

  /** destroy single tunnel (idempotent):abort create connect, destroy TCP/double work stream and compute lifecycle. */
  const teardownTunnel = (tunnel: ActiveTunnel): void => {
    if (activeTunnels.get(tunnel.tunnelId) !== tunnel) return;
    activeTunnels.delete(tunnel.tunnelId);
    tunnel.controller.abort(new Error('tunnel aborted'));
    try { tunnel.tcp.destroy(); } catch { /* already destroy */ }
    if (tunnel.duplex !== undefined) {
      // duplexify without error listen when destroy will with not handle 'error' crash process;
      // honor bottom listen after destroy(sync throw and async rejection all absorb).
      tunnel.duplex.once('error', () => undefined);
      try { void Promise.resolve(tunnel.duplex.destroy()).catch(() => undefined); } catch { /* sync throw */ }
    }
    tunnelWaiters.delete(tunnel.lifecycle);
    tunnel.settle();
  };

  const nodeTunnelOpenCore = async (raw: unknown): Promise<RpcResult<null>> => {
    // boundary strictly validate:plain object, field blank name single, value domain - - unknown field one rule reject.
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
        error: { code: 'not_supported', message: 'node daemon not config tunnel transfer (openTunnelStream missing), reject nodeTunnelOpen: do not fabricate tunnel' },
      };
    }
    if (activeTunnels.has(tunnelId)) {
      return invalidInput(`nodeTunnelOpen tunnelId is already active: ${JSON.stringify(tunnelId)}`);
    }
    if (isDraining() || isDisposed()) {
      return {
        ok: false,
        // draining refuse new is stable code node_draining;disposed is connect level terminal state, keep aborted.
        error: isDisposed()
          ? { code: 'aborted', message: 'server disposed' }
          : drainingRejection('tunnels'),
      };
    }
    // total pre- compute self subject to start compute (TCP connect and WS grasp manually shared use, non- each 15s).
    const budgetMs = typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : TUNNEL_OPEN_DEFAULT_MS;
    // target host:port by Hub designate: node negative duty parse and connect (net.connect support host name and IP text).
    const target = `${host}:${port}`;
    const tcp = net.connect({ host, port });
    const tunnel = newTunnel(tunnelId, tcp);
    // unify settle: the whole establish process (TCP connect + WS grasp manually) only compute once.
    let settled = false;
    let settleResult: (result: RpcResult<null>) => void = () => undefined;
    const rpcResult = new Promise<RpcResult<null>>((resolve) => { settleResult = resolve; });
    const settleOnce = (result: RpcResult<null>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      settleResult(result);
    };
    // TCP error archive one connect_failed(protocol NodeTunnelErrorCode; system code keep in message, do not outside overflow to code).
    const connectFailed = (detail: string): RpcEnvError => ({
      code: 'connect_failed',
      message: `tunnel TCP connect to ${target} failed: ${detail}`,
    });
    const budgetTimer = setTimeout(() => {
      settleOnce({ ok: false, error: { code: 'timeout', message: `tunnel open timed out after ${budgetMs}ms (${target})` } });
      teardownTunnel(tunnel);
    }, budgetMs);
    // error self socket create start hang unify handle (connect after success do not excerpt except): grasp manually wait for phase/
    // pipe phase socket error unify settle+teardown, never not catch crash process.
    const onTcpError = (error: Error): void => {
      if (activeTunnels.get(tunnelId) !== tunnel) return;
      settleOnce({ ok: false, error: connectFailed(error.message) });
      teardownTunnel(tunnel);
    };
    tcp.on('error', onTcpError);
    // TCP connect (shared use total pre- compute): failed/timeout destroy and return structure error (such as port reject).
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once('connect', () => resolve());
        // onTcpError already unify settle; this where only guard against promise pending.
        tcp.once('error', (error) => reject(connectFailed(error.message)));
        tunnel.controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('tunnel aborted'), { code: 'aborted' })),
          { once: true },
        );
      });
    } catch {
      // abort(nodeTunnelAbort/dispose) or failed to connect: detail already settle;teardown
      // after such as return (abort semantics takes precedence, not settle extreme path by failed to connect fall back).
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
    // paused TCP:openTunnelStream grasp manually during buffer for end first batch data,pipe after do not lose first package.
    tcp.pause();
    // hang without operation readable keep underlying uv_read probe for end EOF/RST(never invoke tcp.read(),
    // ensure grasp manually phase receives first package byte continue in readableBuffer in supply pipe consume).
    const keepPollingForEof = (): void => {};
    tcp.on('readable', keepPollingForEof);
    // double work stream grasp manually (shared use total pre- compute, pass signal:abort immediately failed do not etc. pre- compute; late to
    // resolve stream immediately destroy guard against leak leak).
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
      () => undefined, // failed path by under way await branch unify handle
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
      // create connect during already timeout/abort: late to reach stream immediately destroy, never pipe to already destroy TCP.
      handshakeDone = true;
      cleanupHandshakeListeners();
      duplex.destroy();
      return await rpcResult;
    }
    handshakeDone = true;
    cleanupHandshakeListeners();
    tunnel.duplex = duplex;
    settleOnce({ ok: true, value: null });
    // normal end away pipe  end semantics: for end end → duplex readable end →
    // duplex.pipe(tcp) trigger tcp.end()(flush complete response after FIN)→ close destroy
    // double end;error/close/aborted only then immediately destroy two end, do not pinch assert flush in data.
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

  /** cancel in-flight tunnel (grasp manually in or already establish): immediately destroy TCP/WS and return. */
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
