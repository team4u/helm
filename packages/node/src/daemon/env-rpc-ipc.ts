/**
 * Local Herdr IPC bridge (`ipcCall` / `ipcSubscribe`): connects over `node:net` to the local
 * Unix socket or Windows named pipe so Hub plugins (such as `builtin:herdr`) can reach Herdr
 * across nodes via single-request calls or line-delimited event subscriptions.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  NodeIpcCallInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeIpcSubscribeInput,
  RpcResult,
} from '@helm/protocol';
import { invalidInput, isRecord, rpcFail, type RpcErrorCode } from './env-rpc-shared.js';

/** Max single-frame size (matches kernel Herdr transport; oversized frames fail explicitly). */
export const MAX_IPC_FRAME_BYTES = 32 * 1024 * 1024;
const IPC_SUBSCRIBE_ACK_TIMEOUT_MS = 15_000;
/** Windows Named Pipe namespace prefix (NPFS local host). */
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';

/** Session-name allowlist matching Herdr's `validate_name`: non-empty, <=64 chars, not `.`/`..`, `[A-Za-z0-9._-]`. */
const isValidHerdrSession = (session: string): boolean => {
  if (session.length === 0 || session.length > 64) return false;
  if (session === '.' || session === '..') return false;
  for (const ch of session) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
      ch === '.' || ch === '_' || ch === '-';
    if (!ok) return false;
  }
  return true;
};

/** Splits byte streams into newline-delimited frames while enforcing max frame size and rejecting NUL bytes. */
class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = MAX_IPC_FRAME_BYTES) {}

  /** Append a chunk and return complete lines (without trailing CR/LF). */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, searchFrom);
      if (nl === -1) break;
      let end = nl;
      if (end > searchFrom && this.buffer[end - 1] === 0x0d) end -= 1; // strip CR
      if (end - searchFrom > this.maxFrameBytes) {
        throw new Error(`IPC frame exceeds ${this.maxFrameBytes} bytes`);
      }
      lines.push(this.buffer.subarray(searchFrom, end).toString('utf8'));
      searchFrom = nl + 1;
    }
    this.buffer = searchFrom === 0 ? this.buffer : this.buffer.subarray(searchFrom);
    if (this.buffer.includes(0)) {
      throw new Error('IPC frame contains NUL byte');
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error(`IPC frame exceeds ${this.maxFrameBytes} bytes`);
    }
    return lines;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/** Validate that an outbound NDJSON line is a non-empty string with no CR, LF, or NUL bytes. */
const assertSingleLine = (line: unknown, what: string): string => {
  if (typeof line !== 'string' || line.length === 0) {
    throw Object.assign(new Error(`${what} must be a non-empty string`), { code: 'invalid' });
  }
  if (line.includes('\n') || line.includes('\r') || line.includes('\u0000')) {
    throw Object.assign(
      new Error(`${what} must be a single line without CR/LF/NUL (got ${JSON.stringify(line.slice(0, 40))}...)`),
      { code: 'invalid' },
    );
  }
  return line;
};

/** Injectable context for pure Herdr IPC endpoint resolution. */
export interface IpcEndpointContext {
  platform?: string;
  getEnv?(name: string): string | undefined;
  homeDir?: string;
  tempDir?: string;
}

/**
 * Resolve the Herdr IPC endpoint: explicit `endpoint` > `HERDR_SOCKET_PATH` > derived config dir + session.
 *
 * On Windows, matches `interprocess` 2.4.2 (`\\.\pipe\` + raw config path string, preserving drive
 * colons and backslashes). Config dir precedence matches Herdr (`XDG_CONFIG_HOME` > `APPDATA` >
 * `USERPROFILE\AppData\Roaming` > `HOME/.config` > `temp` on win32; `XDG_CONFIG_HOME` > `HOME/.config` on POSIX).
 */
export function resolveHerdrIpcEndpoint(
  input: { endpoint?: string; session?: string },
  context: IpcEndpointContext = {},
): string {
  const platform = context.platform ?? process.platform;
  const getEnv = context.getEnv ?? ((name: string) => process.env[name]);
  const home = context.homeDir ?? os.homedir();
  const temp = context.tempDir ?? os.tmpdir();

  if (input.endpoint !== undefined && input.endpoint !== '') return input.endpoint;
  const envSocket = getEnv('HERDR_SOCKET_PATH');
  if (envSocket !== undefined && envSocket !== '') return envSocket;

  const session = input.session !== undefined && input.session !== '' ? input.session : undefined;
  if (session !== undefined && !isValidHerdrSession(session)) {
    throw Object.assign(
      new Error(`Invalid Herdr session name: ${JSON.stringify(session)}`),
      { code: 'invalid' },
    );
  }
  const relative = session === undefined
    ? ['herdr', 'herdr.sock']
    : ['herdr', 'sessions', session, 'herdr.sock'];
  const xdg = getEnv('XDG_CONFIG_HOME');

  if (platform === 'win32') {
    // Use explicit backslashes regardless of host OS so pure tests work cross-platform.
    if (xdg !== undefined && xdg !== '') return WIN_PIPE_PREFIX + [xdg, ...relative].join('\\');
    const appdata = getEnv('APPDATA');
    if (appdata !== undefined && appdata !== '') return WIN_PIPE_PREFIX + [appdata, ...relative].join('\\');
    const userProfile = getEnv('USERPROFILE');
    if (userProfile !== undefined && userProfile !== '') {
      return WIN_PIPE_PREFIX + [userProfile, 'AppData', 'Roaming', ...relative].join('\\');
    }
    const homeEnv = getEnv('HOME');
    if (homeEnv !== undefined && homeEnv !== '') {
      return WIN_PIPE_PREFIX + [homeEnv, '.config', ...relative].join('\\');
    }
    return WIN_PIPE_PREFIX + [temp, ...relative].join('\\');
  }
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(home, '.config');
  return path.join(base, ...relative);
}

export interface IpcBridgeOptions {
  onIpcEvent?: (event: NodeIpcEvent) => void;
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /** Optional idle timeout; omitted by default so long-running Herdr requests are governed by caller timeout/abort. */
  ipcCallIdleTimeoutMs?: number;
  /** Optional single-frame byte cap (defaults to `MAX_IPC_FRAME_BYTES`; lowered only in tests). */
  maxIpcFrameBytes?: number;
  isDisposed(): boolean;
}

export interface IpcBridge {
  ipcCall(input: NodeIpcCallInput): Promise<RpcResult<string>>;
  ipcAbortCall(callId: string): Promise<void>;
  ipcSubscribe(input: NodeIpcSubscribeInput): Promise<RpcResult<null>>;
  ipcUnsubscribe(subscribeId: string): Promise<void>;
  /** Track one-shot `ipcCall` promises for upgrade draining. */
  trackIpc<T>(promise: Promise<T>): Promise<T>;
  /** Destroy all open IPC sockets and clear active registrations. */
  destroySockets(): void;
  getActiveCallCount(): number;
  getActiveSubscriptionCount(): number;
}

/** Create a per-connection Herdr IPC bridge. */
export function createIpcBridge(options: IpcBridgeOptions): IpcBridge {
  const { onIpcEvent, onIpcClosed, isDisposed } = options;
  const ipcIdleTimeoutMs = options.ipcCallIdleTimeoutMs;
  const maxIpcFrameBytes = options.maxIpcFrameBytes ?? MAX_IPC_FRAME_BYTES;
  const activeIpcCalls = new Map<string, net.Socket>();
  const activeIpcSubscriptions = new Map<string, net.Socket>();
  const allIpcSockets = new Set<net.Socket>();

  const resolveIpcEndpoint = (input: { endpoint?: string; session?: string }): string =>
    resolveHerdrIpcEndpoint(input);

  // One-shot `ipcCall` waiters included in upgrade drain (long-lived `ipcSubscribe` streams are excluded).
  const ipcWaiters = new Set<Promise<unknown>>();
  const trackIpc = <T>(promise: Promise<T>): Promise<T> => {
    ipcWaiters.add(promise);
    void promise.finally(() => ipcWaiters.delete(promise)).catch(() => undefined);
    return promise;
  };

  const ipcCall = async (input: NodeIpcCallInput): Promise<RpcResult<string>> => {
    let endpoint: string;
    let line: string;
    try {
      endpoint = resolveIpcEndpoint(input);
      line = assertSingleLine(input.line, 'IPC call line');
      if (input.callId !== undefined && input.callId !== '' && (input.callId.length > 128 || input.callId.includes('\u0000'))) {
        throw Object.assign(new Error(`Invalid IPC callId: ${JSON.stringify(input.callId)}`), { code: 'invalid' });
      }
      if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)) {
        throw Object.assign(new Error(`Invalid IPC timeoutMs: ${JSON.stringify(input.timeoutMs)}`), { code: 'invalid' });
      }
    } catch (error) {
      return rpcFail(error);
    }
    if (input.callId && activeIpcCalls.has(input.callId)) return invalidInput('IPC callId is already in flight');
    const timeoutMs = input.timeoutMs !== undefined && input.timeoutMs > 0
      ? input.timeoutMs
      : ipcIdleTimeoutMs;
    return await new Promise<RpcResult<string>>((resolve) => {
      let settled = false;
      const assembler = new LineAssembler(maxIpcFrameBytes);
      const socket: net.Socket = net.connect(endpoint);
      allIpcSockets.add(socket);
      socket.once('close', () => allIpcSockets.delete(socket));
      const finish = (result: RpcResult<string>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (input.callId !== undefined) activeIpcCalls.delete(input.callId);
        socket.destroy();
        resolve(result);
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        finish({ ok: false, error: { code: 'timeout', message: `IPC call timed out after ${timeoutMs}ms` } });
      }, timeoutMs);
      if (input.callId !== undefined && input.callId !== '') {
        activeIpcCalls.set(input.callId, socket);
      }
      socket.once('connect', () => {
        socket.write(`${line}\n`, (err) => {
          if (err !== undefined && err !== null && !settled) {
            finish({ ok: false, error: { code: 'unknown', message: `IPC write failed: ${err.message}` } });
          }
        });
      });
      socket.on('data', (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = assembler.push(chunk);
        } catch (error) {
          finish({ ok: false, error: { code: 'unknown', message: error instanceof Error ? error.message : String(error) } });
          return;
        }
        const first = lines[0];
        if (first !== undefined) {
          if (first.includes('\u0000')) {
            finish({ ok: false, error: { code: 'unknown', message: 'IPC frame contains NUL byte' } });
            return;
          }
          finish({ ok: true, value: first });
        }
      });
      socket.once('error', (error) => {
        finish({ ok: false, error: { code: 'unknown', message: `IPC socket error: ${error.message}` } });
      });
      socket.once('close', () => {
        finish({ ok: false, error: { code: 'unknown', message: 'IPC socket closed before first response line' } });
      });
    });
  };

  const ipcAbortCall = async (callId: string): Promise<void> => {
    const socket = activeIpcCalls.get(callId);
    if (socket === undefined) return;
    activeIpcCalls.delete(callId);
    socket.destroy();
  };

  const ipcSubscribe = async (input: NodeIpcSubscribeInput): Promise<RpcResult<null>> => {
    if (typeof input.subscribeId !== 'string' || input.subscribeId.length === 0 || input.subscribeId.length > 128) {
      return invalidInput(`Invalid subscribeId: ${JSON.stringify(input.subscribeId)}`);
    }
    if (activeIpcSubscriptions.has(input.subscribeId)) return invalidInput('IPC subscribeId is already active');
    let endpoint: string;
    let line: string;
    try {
      endpoint = resolveIpcEndpoint(input);
      line = assertSingleLine(input.line, 'IPC subscribe line');
    } catch (error) {
      return rpcFail(error);
    }
    return await new Promise<RpcResult<null>>((resolve) => {
      let settled = false;
      let acked = false;
      const assembler = new LineAssembler(maxIpcFrameBytes);
      const socket: net.Socket = net.connect(endpoint);
      allIpcSockets.add(socket);
      activeIpcSubscriptions.set(input.subscribeId, socket);
      socket.once('close', () => allIpcSockets.delete(socket));
      const fail = (code: RpcErrorCode, message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeIpcSubscriptions.delete(input.subscribeId);
        socket.destroy();
        resolve({ ok: false, error: { code, message } });
      };
      const closeSubscription = (error?: string): void => {
        if (activeIpcSubscriptions.get(input.subscribeId) !== socket) return;
        activeIpcSubscriptions.delete(input.subscribeId);
        socket.destroy();
        try { onIpcClosed?.({ subscribeId: input.subscribeId, ...(error ? { error } : {}) }); }
        catch { console.error('[helm-node] IPC close notification callback failed'); }
      };
      const timer: NodeJS.Timeout = setTimeout(() => {
        if (acked) return;
        fail('timeout', `IPC subscription ack timed out after ${IPC_SUBSCRIBE_ACK_TIMEOUT_MS}ms`);
      }, IPC_SUBSCRIBE_ACK_TIMEOUT_MS);

      const isSubscriptionStartedAck = (frame: string): boolean => {
        try {
          const envelope = JSON.parse(frame) as unknown;
          return isRecord(envelope) && isRecord(envelope['result']) &&
            envelope['result']['type'] === 'subscription_started';
        } catch {
          return false;
        }
      };

      const handleLine = (raw: string): void => {
        let envelope: unknown;
        try {
          envelope = JSON.parse(raw);
        } catch (error) {
          fail('unknown', `IPC subscription ack is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!isRecord(envelope)) {
          fail('unknown', 'IPC subscription ack is not a JSON object');
          return;
        }
        if (isSubscriptionStartedAck(raw)) {
          if (settled) return;
          settled = true;
          acked = true;
          clearTimeout(timer);
          activeIpcSubscriptions.set(input.subscribeId, socket);
          resolve({ ok: true, value: null });
          return;
        }
        if (envelope['error'] !== undefined && envelope['error'] !== null) {
          const body = isRecord(envelope['error']) ? envelope['error'] : {};
          const code = typeof body['code'] === 'string' && body['code'] !== '' ? body['code'] : 'unknown';
          const message = typeof body['message'] === 'string' && body['message'] !== '' ? body['message'] : 'IPC subscription rejected';
          fail(code as RpcErrorCode, `${code}: ${message}`);
          return;
        }
        const snippet = JSON.stringify(raw.slice(0, 200));
        fail('unknown', `IPC subscription ack unexpected: ${snippet}`);
      };

      socket.once('connect', () => {
        socket.write(`${line}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = assembler.push(chunk);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (acked) { closeSubscription(message); return; }
          fail('unknown', message);
          return;
        }
        for (const frame of lines) {
          if (acked) {
            if (isDisposed() || activeIpcSubscriptions.get(input.subscribeId) !== socket) return;
            if (frame.includes('\u0000')) { closeSubscription('IPC event frame contains NUL byte'); return; }
            try { onIpcEvent?.({ subscribeId: input.subscribeId, line: frame }); }
            catch { closeSubscription('IPC event callback failed'); return; }
          } else {
            handleLine(frame);
          }
        }
      });
      socket.once('error', (error) => {
        const message = `IPC subscription socket error: ${error.message}`;
        if (acked) { closeSubscription(message); return; }
        fail('unknown', message);
      });
      socket.once('close', () => {
        if (acked) { closeSubscription(); return; }
        fail('unknown', 'IPC subscription socket closed before ack');
      });
    });
  };

  const ipcUnsubscribe = async (subscribeId: string): Promise<void> => {
    const socket = activeIpcSubscriptions.get(subscribeId);
    if (socket === undefined) return;
    activeIpcSubscriptions.delete(subscribeId);
    socket.destroy(); // Active unsubscribe does not emit an unexpected `onIpcClosed` notification.
  };

  const destroySockets = (): void => {
    for (const socket of allIpcSockets) socket.destroy();
    allIpcSockets.clear();
    activeIpcCalls.clear();
    activeIpcSubscriptions.clear();
  };

  return {
    ipcCall,
    ipcAbortCall,
    ipcSubscribe,
    ipcUnsubscribe,
    trackIpc,
    destroySockets,
    getActiveCallCount: () => ipcWaiters.size,
    getActiveSubscriptionCount: () => activeIpcSubscriptions.size,
  };
}
