/**
 * 节点本机 Herdr IPC 桥（ipcCall / ipcSubscribe）：以 node:net 直连节点
 * 本机的 Unix Socket / Windows Named Pipe，供 Hub 上可选的 builtin:herdr
 * 等插件跨节点访问当地 Herdr——一条连接一个请求（call）或一条事件流
 * （subscribe）。
 * - call：写一行、读一行完整 UTF-8 JSON 后立即关 socket；带 callId 登记
 *   在途 socket，ipcAbortCall 可立即中断阻塞等待（如 agent.prompt --wait）；
 *   超时由调用方或显式服务器选项决定，取消与连接代关闭立即释放 socket；
 *   draining 时拒新（node_draining），已在途的计入升级排空口径（不被旧宿主
 *   退出硬切断）；取消/断连仍在途天折为 aborted；
 * - subscribe：首行 ACK（15s 超时）须为结构化的 subscription_started，
 *   之后每行经 onIpcEvent 转发；断开经 onIpcClosed 通知；不静默吞错。
 *   长驻语义：draining 时拒新（node_draining），既有的由 dispose 统一优雅
 *   关闭并通知。
 *
 * 本模块同时承载 Herdr IPC 端点解析纯函数（resolveHerdrIpcEndpoint）；
 * 受理守卫（draining/disposed 拒新与排空追踪接线）由 env-rpc-server 组装。
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

/** 单帧（单行）字节上限：与内核 Herdr 传输层一致，超限显式报错不静默截断。 */
const MAX_IPC_FRAME_BYTES = 32 * 1024 * 1024;
/** 订阅握手 ACK 超时。 */
const IPC_SUBSCRIBE_ACK_TIMEOUT_MS = 15_000;
/** Windows Named Pipe 命名空间前缀（NPFS 本地主机）。 */
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';

/**
 * session 名白名单：与 herdr 侧 validate_name 同向——非空、≤64 字节、
 * 非 `.`/`..`、仅 ASCII 字母数字与 `.` `_` `-`（首字符无额外限制）。
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

/** 按字节查找换行符切分完整行；携带跨 chunk 残留缓冲。拒绝 NUL 字节与超限帧。 */
class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0);

  /** 推入一个 chunk，返回其中完整行（不含换行符）；无完整行返回空数组。
   * 逐行长度检查：带换行的完整行与无换行残留同样受单帧上限约束，
   * 否则对端一帧超长行只要带换行即绕过限制整行进内存。 */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, searchFrom);
      if (nl === -1) break;
      let end = nl;
      if (end > searchFrom && this.buffer[end - 1] === 0x0d) end -= 1; // 剥离 CR
      if (end - searchFrom > MAX_IPC_FRAME_BYTES) {
        throw new Error(`IPC frame exceeds ${MAX_IPC_FRAME_BYTES} bytes`);
      }
      lines.push(this.buffer.subarray(searchFrom, end).toString('utf8'));
      searchFrom = nl + 1;
    }
    this.buffer = searchFrom === 0 ? this.buffer : this.buffer.subarray(searchFrom);
    if (this.buffer.includes(0)) {
      throw new Error('IPC frame contains NUL byte');
    }
    if (this.buffer.length > MAX_IPC_FRAME_BYTES) {
      throw new Error(`IPC frame exceeds ${MAX_IPC_FRAME_BYTES} bytes`);
    }
    return lines;
  }

  /** 当前缓冲字节量（诊断用）。 */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/** 发送行校验：非空字符串且不含任何换行/NUL（防多帧注入与帧污染）。 */
const assertSingleLine = (line: unknown, what: string): string => {
  if (typeof line !== 'string' || line.length === 0) {
    throw Object.assign(new Error(`${what} must be a non-empty string`), { code: 'invalid' });
  }
  if (line.includes('\n') || line.includes('\r') || line.includes('\u0000')) {
    throw Object.assign(
      new Error(`${what} must be a single line without CR/LF/NUL (got ${JSON.stringify(line.slice(0, 40))}…)`),
      { code: 'invalid' },
    );
  }
  return line;
};

/** 端点解析的可注入上下文（纯函数化：测试注入 win32 平台，不猜行为）。 */
export interface IpcEndpointContext {
  /** 目标平台（缺省 process.platform）。 */
  platform?: string;
  /** 环境变量读取（缺省读 process.env）。 */
  getEnv?(name: string): string | undefined;
  /** 主目录（缺省 os.homedir()）。 */
  homeDir?: string;
  /** 临时目录（缺省 os.tmpdir()）。 */
  tempDir?: string;
}

/**
 * 解析 Herdr IPC 端点（纯函数）：显式 endpoint > HERDR_SOCKET_PATH >
 * 按配置目录与 session 推导。session 名非法即报错——它将成为路径段。
 *
 * Windows 映射依据 interprocess 2.4.2 真实源码（与 herdr 监听端一致）：
 * - `src/os/windows/local_socket/name_type.rs`
 *   `map_generic_namespaced_osstr`：GenericNamespaced 名仅经
 *   `convert_and_encode_path(name, None)` 处理；
 * - `src/os/windows/path_conversion.rs` `pathcvt`：拼 `\\` + `.` + `\pipe\`
 *   + 原始名字字符串——**不替换冒号/斜杠**。herdr 传入的名字是其配置
 *   目录下的 `herdr.sock` 完整路径字符串（磁盘上该路径仅是内容为
 *   `pid:timestamp` 的标记文件，不是可连接端点）。
 * 因此本函数在 win32 默认推导时返回 `\\.\pipe\` + 配置目录路径字符串
 * （含 `C:` 盘符冒号原样保留）；显式完整 pipe endpoint 原样返回。
 *
 * 配置目录与 herdr `config::io::config_dir` 全平台同向：
 * XDG_CONFIG_HOME 优先；win32 再退 APPDATA > USERPROFILE\AppData\Roaming
 * > HOME/.config > temp；unix 退 HOME/.config > temp。
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
    // 真实 Windows 上路径分隔符为 '\'，与 herdr PathBuf 展示一致；
    // 用显式 '\\' 连接（不依赖运行平台的 path.sep），纯函数可跨平台断言。
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

/** IPC 桥依赖（宿主回调与连接生命周期状态查询；机制与策略分离）。 */
export interface IpcBridgeOptions {
  /** IPC 订阅事件回调（转发回 Hub 的 onIpcEvent）。 */
  onIpcEvent?: (event: NodeIpcEvent) => void;
  /** IPC 订阅关闭/出错回调（转发回 Hub 的 onIpcClosed）。 */
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /**
   * 可选 IPC 等待预算（宿主已归一化）；未配置时由调用方的 timeoutMs、
   * 取消信号和连接代控制。Herdr 长任务等待不能被守护进程偷偷施加一个
   * 额外的固定死线。
   */
  ipcCallIdleTimeoutMs?: number;
  /** 宿主 disposed 状态查询：dispose 后订阅事件帧转发立即停摆。 */
  isDisposed(): boolean;
}

/** IPC 桥句柄：RPC 实现面 + 排空追踪与 dispose 销毁钩子。 */
export interface IpcBridge {
  ipcCall(input: NodeIpcCallInput): Promise<RpcResult<string>>;
  ipcAbortCall(callId: string): Promise<void>;
  ipcSubscribe(input: NodeIpcSubscribeInput): Promise<RpcResult<null>>;
  ipcUnsubscribe(subscribeId: string): Promise<void>;
  /** 在途一次性 ipcCall 的受理追踪（升级排空口径；guard 受理同步段调用）。 */
  trackIpc<T>(promise: Promise<T>): Promise<T>;
  /** dispose 钩子：销毁全部 IPC socket 并清空在途登记（幂等）。 */
  destroySockets(): void;
  /** 在途 ipcCall 数量（排空内省；含无 callId 的在途调用，受理即计数）。 */
  getActiveCallCount(): number;
  /** 活跃 ipcSubscribe 数量（内省/测试；长驻订阅不计入排空等待）。 */
  getActiveSubscriptionCount(): number;
}

/** 创建 Herdr IPC 桥：一个连接代一个实例，状态互不共享。 */
export function createIpcBridge(options: IpcBridgeOptions): IpcBridge {
  const { onIpcEvent, onIpcClosed, isDisposed } = options;
  const ipcIdleTimeoutMs = options.ipcCallIdleTimeoutMs;
  const activeIpcCalls = new Map<string, net.Socket>();
  const activeIpcSubscriptions = new Map<string, net.Socket>();
  const allIpcSockets = new Set<net.Socket>();

  const resolveIpcEndpoint = (input: { endpoint?: string; session?: string }): string =>
    resolveHerdrIpcEndpoint(input);

  // 在途一次性 ipcCall 的 settle promise：升级排空口径必须包含它们——
  // 否则旧宿主退出时 dispose 硬销毁 socket，Hub 侧长等待（如 herdr --wait）
  // 被拦腰切断且无重试约定。长驻 ipcSubscribe 不进此集合（见 guard 分支注释）。
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
      const assembler = new LineAssembler();
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
          // 首行含 NUL：非合法 NDJSON 帧，拒绝（不静默截断充当成功）。
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
      const assembler = new LineAssembler();
      const socket: net.Socket = net.connect(endpoint);
      allIpcSockets.add(socket);
      activeIpcSubscriptions.set(input.subscribeId, socket);
      socket.once('close', () => allIpcSockets.delete(socket));
      /** ack 前的失败：销毁 socket 并以错误信封 resolve（不注册订阅）。 */
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
        catch { console.error('[helm-node] IPC 关闭通知回调失败'); }
      };
      const timer: NodeJS.Timeout = setTimeout(() => {
        if (acked) return;
        fail('timeout', `IPC subscription ack timed out after ${IPC_SUBSCRIBE_ACK_TIMEOUT_MS}ms`);
      }, IPC_SUBSCRIBE_ACK_TIMEOUT_MS);

      /** ACK 判定：结构化 JSON——result.type === 'subscription_started'。 */
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
            // 事件帧含 NUL：拒绝该帧并关闭流（不静默截断）。
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
    socket.destroy(); // 主动关闭不触发 onIpcClosed 异常通知
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
