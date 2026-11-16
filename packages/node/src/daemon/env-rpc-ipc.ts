/**
 * node local machine Herdr IPC bridge (ipcCall / ipcSubscribe): with node:net direct connect node
 * local machine Unix Socket / Windows Named Pipe, supply Hub on optional builtin:herdr
 * etc. plugin across node access when ground Herdr- - a connect a request (call) or a event stream
 * (subscribe).
 * - call: write one row, read one row complete UTF-8 JSON after immediately closure socket; carries callId register
 *   in-flight socket,ipcAbortCall can immediately interrupt block wait for (such as agent.prompt --wait);
 *   timeout by caller or explicit server option decide, cancel and connect proxy close immediately release socket;
 *   draining when refuse new (node_draining), already in-flight count upgrade arrange empty opening path (do not by old host
 *   exit hard cut assert); cancel/assert connect still in-flight day fold is aborted;
 * - subscribe: first row ACK(15s timeout) must is structure subscription_started,
 *   after each row via onIpcEvent forwarding; disconnect via onIpcClosed notify; not silently swallow wrong.
 *   long resident semantics:draining when refuse new (node_draining), since has by dispose unify graceful
 *   close and notify.
 *
 * this module also bear load Herdr IPC end point parse pure function (resolveHerdrIpcEndpoint);
 * subject to guard (draining/disposed refuse new and arrange empty append trace connect line) by env-rpc-server group install.
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

/** single frame (single row) byte cap: and kernel Herdr transfer layer consistent, over limit explicit errors not silently truncate. */
export const MAX_IPC_FRAME_BYTES = 32 * 1024 * 1024;
/** subscribe grasp manually ACK timeout. */
const IPC_SUBSCRIBE_ACK_TIMEOUT_MS = 15_000;
/** Windows Named Pipe naming empty between prefix (NPFS local host). */
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';

/**
 * session name blank name single: and herdr side validate_name same to - - non-empty,≤64 byte,
 * non- `.`/`..`, only ASCII character parent number and `.` `_` `-`(first token symbol without extra restrict).
 */
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

/** by byte find newline symbol cut complete row; carry across chunk leftover buffer. reject NUL byte and over limit frame. */
class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = MAX_IPC_FRAME_BYTES) {}

  /** push a chunk, return among them complete row (excludes newline symbol); without complete row return empty array.
   * one by one row length check: carries newline complete row and without newline leftover same subject to single frame cap constraint,
   * otherwise for end one frame over long row as long as carries newline i.e. bypass restrict whole row enter memory. */
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

  /** when before buffer byte amount (diagnose use). */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/** send row validate: non-empty string and excludes any newline/NUL(guard against many frame inject and frame pollute). */
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

/** end point parse can inject context (pure function: test inject win32 platform, do not guess behavior). */
export interface IpcEndpointContext {
  /** target platform (default process.platform). */
  platform?: string;
  /** environment variable read (default read process.env). */
  getEnv?(name: string): string | undefined;
  /** main directory (default os.homedir()). */
  homeDir?: string;
  /** temp directory (default os.tmpdir()). */
  tempDir?: string;
}

/**
 * parse Herdr IPC end point (pure function): explicit endpoint > HERDR_SOCKET_PATH >
 * by config directory and session push lead.session name illegal i.e. errors - - it into is path segment.
 *
 * Windows mapping based on interprocess 2.4.2 real source code (and herdr listen end consistent):
 * - `src/os/windows/local_socket/name_type.rs`
 *   `map_generic_namespaced_osstr`:GenericNamespaced name only via
 *   `convert_and_encode_path(name, None)` handle;
 * - `src/os/windows/path_conversion.rs` `pathcvt`: piece together `\\` + `.` + `\pipe\`
 *   + original name string - -**do not replace smoke number/slash**.herdr pass name is its config
 *   directory under `herdr.sock` complete path string (disk on the path only is content is
 *   `pid:timestamp` mark record file, is not can connect end point).
 * therefore this function in win32 by default push lead when return `\\.\pipe\` + config directory path string
 * (contains `C:` symbol smoke number original keep); explicit complete pipe endpoint original return.
 *
 * config directory and herdr `config::io::config_dir` all platform same to:
 * XDG_CONFIG_HOME takes precedence;win32 again retreat APPDATA > USERPROFILE\AppData\Roaming
 * > HOME/.config > temp;unix retreat HOME/.config > temp.
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
    // real Windows on path isolate symbol is '\', and herdr PathBuf render consistent;
    // use explicit '\\' connect (independent of run platform path.sep), pure function can across platform assertion.
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

/** IPC bridge dependency (host call back and connect lifecycle state query; separation of mechanism and policy). */
export interface IpcBridgeOptions {
  /** IPC subscribe event call back (forwarding back Hub  onIpcEvent). */
  onIpcEvent?: (event: NodeIpcEvent) => void;
  /** IPC subscribe close/fails call back (forwarding back Hub  onIpcClosed). */
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /**
   * optional IPC wait for pre- compute (host already archive one); not config when by caller timeoutMs,
   * cancel signal and connect proxy control.Herdr long task wait for cannot by daemon stealthily stealthily apply add a
   * extra fixed die line.
   */
  ipcCallIdleTimeoutMs?: number;
  /** optional single frame (single row) byte cap (by default MAX_IPC_FRAME_BYTES = 32 MiB; only test inject small threshold). */
  maxIpcFrameBytes?: number;
  /** host disposed state query:dispose after subscribe event frame forwarding immediately stop swing. */
  isDisposed(): boolean;
}

/** IPC bridge handle:RPC implement side + arrange empty append trace and dispose destroy hook. */
export interface IpcBridge {
  ipcCall(input: NodeIpcCallInput): Promise<RpcResult<string>>;
  ipcAbortCall(callId: string): Promise<void>;
  ipcSubscribe(input: NodeIpcSubscribeInput): Promise<RpcResult<null>>;
  ipcUnsubscribe(subscribeId: string): Promise<void>;
  /** in-flight once ipcCall subject to append trace (upgrade arrange empty opening path;guard subject to sync segment invoke). */
  trackIpc<T>(promise: Promise<T>): Promise<T>;
  /** dispose hook: destroy all IPC socket and empty in-flight register (idempotent). */
  destroySockets(): void;
  /** in-flight ipcCall amount (arrange empty inside omit; contains without callId in-flight invoke, subject to i.e. counter). */
  getActiveCallCount(): number;
  /** leap ipcSubscribe amount (inside omit/test; long resident subscribe do not count arrange empty wait for). */
  getActiveSubscriptionCount(): number;
}

/** create Herdr IPC bridge: a connect proxy a instance, state mutual do not sharing. */
export function createIpcBridge(options: IpcBridgeOptions): IpcBridge {
  const { onIpcEvent, onIpcClosed, isDisposed } = options;
  const ipcIdleTimeoutMs = options.ipcCallIdleTimeoutMs;
  const maxIpcFrameBytes = options.maxIpcFrameBytes ?? MAX_IPC_FRAME_BYTES;
  const activeIpcCalls = new Map<string, net.Socket>();
  const activeIpcSubscriptions = new Map<string, net.Socket>();
  const allIpcSockets = new Set<net.Socket>();

  const resolveIpcEndpoint = (input: { endpoint?: string; session?: string }): string =>
    resolveHerdrIpcEndpoint(input);

  // in-flight once ipcCall  settle promise: upgrade arrange empty opening path must contains they - -
  // otherwise old host on exit dispose hard destroy socket,Hub side long wait for (such as herdr --wait)
  // by midway cut assert and without retry convention. long resident ipcSubscribe does not enter this set (see guard branch note release).
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
          // first row contains NUL: non- legal NDJSON frame, reject (not silently truncate fill when succeeded).
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
      /** ack before failed: destroy socket and with error message seal resolve(do not register subscribe). */
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
        catch { console.error('[helm-node] IPC close notify call back failed'); }
      };
      const timer: NodeJS.Timeout = setTimeout(() => {
        if (acked) return;
        fail('timeout', `IPC subscription ack timed out after ${IPC_SUBSCRIBE_ACK_TIMEOUT_MS}ms`);
      }, IPC_SUBSCRIBE_ACK_TIMEOUT_MS);

      /** ACK decide: structure JSON- -result.type === 'subscription_started'. */
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
            // event frame contains NUL: reject the frame and close stream (not silently truncate).
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
    socket.destroy(); // actively close does not trigger onIpcClosed exception notify
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
