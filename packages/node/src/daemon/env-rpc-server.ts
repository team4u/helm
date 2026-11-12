/**
 * 节点侧远端执行环境 RPC 服务端：完整实现 `NodeEnvRpcFunctions`。
 *
 * 文件/shell 能力由内置零外部依赖的 `LocalExecutionEnv`
 * （Node.js 原生 fs/promises + child_process，见 ./local-env.ts）承载：
 * - 每个 cwd 一个 env 实例（进程内缓存，无跨 cwd 污染）；
 * - reader 以 readerId 句柄桥接；dispose 关闭全部 reader；
 * - envExec 以独立 AbortController 取消；envAbortExec(execId)
 *   立即终止该命令的进程树；流式输出经 onExecOutput 分帧回传 Hub；
 * - 连接断开时 dispose：关 reader、杀本连接发起的命令并等待其在途
 *   promise settle，无孤儿 promise；每个连接（generation）独立的 server
 *   实例，旧代的命令/readers 绝不跨代复用（见 daemon/index.ts）。
 *
 * 本机 IPC 桥（ipcCall / ipcSubscribe）：以 node:net 直连节点本机的
 * Unix Socket / Windows Named Pipe，供 Hub 上可选的 builtin:herdr 等插件
 * 跨节点访问当地 Herdr——一条连接一个请求（call）或一条事件流（subscribe）。
 * - call：写一行、读一行完整 UTF-8 JSON 后立即关 socket；带 callId 登记
 *   在途 socket，ipcAbortCall 可立即中断阻塞等待（如 agent.prompt --wait）；
 *   超时由调用方或显式服务器选项决定，取消与连接代关闭立即释放 socket；
 * - subscribe：首行 ACK（15s 超时）须为结构化的 subscription_started，
 *   之后每行经 onIpcEvent 转发；断开经 onIpcClosed 通知；不静默吞错。
 *
 * 节点侧 TCP 隧道（nodeTunnelOpen）：Hub 请求在节点本机 127.0.0.1:port
 * 建立 TCP，与 daemon 层注入的 openTunnelStream 双工流（WS 隧道，hubUrl/
 * token 等凭据由 daemon 层封闭）双向 pipe——本层零凭据。draining/disposed
 * 拒绝新隧道；TCP 在隧道握手期间 pause，pipe 后不丢首包；dispose 销毁
 * 全部隧道 TCP/双工流并等待 settle。
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import {
  LocalExecutionEnv,
  type BinaryReader,
  type DirReader,
  type TextLineReader,
} from './local-env.js';
import type {
  EnvExecInput,
  EnvExecOk,
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeIpcCallInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeIpcSubscribeInput,
  RpcEnvError,
  RpcResult,
} from '@helm/protocol';

type RpcErrorCode = RpcEnvError['code'];

export interface NodeEnvRpcServerOptions {
  /** 相对路径的基准目录（daemon 数据目录）。 */
  defaultCwd: string;
  /** shell 输出流式回调（转发回 Hub 的 onEnvExecOutput）。 */
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  /**
   * 注入每个 shell 子进程的环境（daemon 构建）：如 HELM_HUB_URL。
   * 机密与短期令牌由 Hub 侧 envOptions 合成后经 envExec.env 逐调用传入
   * （节点不持久化任何机密）。
   */
  shellEnv?: Record<string, string | undefined>;
  /** 命令输出单次回传的最大字符数（流式分块上限，防单帧过大；≥1）。 */
  maxOutputChunkChars?: number;
  /** IPC 订阅事件回调（转发回 Hub 的 onIpcEvent）。 */
  onIpcEvent?: (event: NodeIpcEvent) => void;
  /** IPC 订阅关闭/出错回调（转发回 Hub 的 onIpcClosed）。 */
  onIpcClosed?: (event: NodeIpcClosedEvent) => void;
  /**
   * 可选 IPC 等待预算；未配置时由调用方的 timeoutMs、取消信号和连接代控制。
   * Herdr 长任务等待不能被守护进程偷偷施加一个额外的固定死线。
   */
  ipcCallIdleTimeoutMs?: number;
  /**
   * 取消/超时后等待底层 stdio 管道排空的硬超时（毫秒，默认 500）：
   * 当命令派生的 detached 孙进程继承了 stdout/stderr fd 并持续写入时，
   * SDK exec 可能因等待流关闭而永久挂起；超过该宽限期即强制结算，
   * 保证 envExec / dispose 绝不被孤儿孙进程拽住。
   */
  abortDrainGraceMs?: number;
  /**
   * 打开隧道双工流（daemon 层注入：连接 Hub 的 /ws/node-tunnel 并完成握手）。
   * env-rpc-server 只消费该双工流，绝不感知 hubUrl/token 等凭据。
   */
  openTunnelStream?: (tunnelId: string) => Promise<Duplex>;
}

const toRpcError = (error: unknown): RpcEnvError => {
  const anyError = error as { code?: string; message?: string; spillPath?: string } | null;
  if (anyError && typeof anyError === 'object' && anyError.code && anyError.message !== undefined) {
    return {
      code: anyError.code as RpcErrorCode,
      message: anyError.message,
      ...(anyError.spillPath !== undefined ? { spillPath: anyError.spillPath } : {}),
    };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
};

const rpcFail = <T>(error: unknown): RpcResult<T> => ({ ok: false, error: toRpcError(error) });

const invalidInput = <T>(message: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'invalid', message },
});

const readerNotFound = <T>(readerId: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'not_found', message: `Unknown reader: ${readerId}` },
});

/** 单帧（单行）字节上限：与内核 Herdr 传输层一致，超限显式报错不静默截断。 */
const MAX_IPC_FRAME_BYTES = 32 * 1024 * 1024;
/** 二进制传输上限（64 MiB）：read/write/base64 往返的单次载荷上限，超限显式报错。 */
const MAX_BINARY_TRANSFER_BYTES = 64 * 1024 * 1024;
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

  /** 推入一个 chunk，返回其中完整行（不含换行符）；无完整行返回空数组。 */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, searchFrom);
      if (nl === -1) break;
      let end = nl;
      if (end > searchFrom && this.buffer[end - 1] === 0x0d) end -= 1; // 剥离 CR
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

/** base64 边界校验：标准字母表 + 填充，禁止 Node 宽松解析静默吞非法字符；
 * 解码前校验编码后长度上限（解码后 ≤ 64 MiB），超限显式报错。 */
const decodeBase64 = (content: string, what: string): Uint8Array => {
  if (typeof content !== 'string') {
    throw Object.assign(new Error(`${what} must be a base64 string`), { code: 'invalid' });
  }
  const encodedLimit = Math.ceil(MAX_BINARY_TRANSFER_BYTES / 3) * 4;
  if (content.length > encodedLimit) {
    throw Object.assign(new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`), { code: 'invalid' });
  }
  // 无嵌套重复组，避免大载荷触发正则回溯栈溢出。
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
 * 输出分块的下一个切点：按 codepoint 边界截断 UTF-16 文本，绝不把代理对
 * 劈成两半（跨帧各自 JSON 编码会产生替代字符 U+FFFD，破坏下游拼接）。
 * 即使配置上限为 1，也允许一个完整代理对占 2 个码元，确保每轮前进。
 */
const safeChunkEnd = (text: string, offset: number, limit: number): number => {
  const desired = Math.min(offset + Math.max(limit, 1), text.length);
  if (desired >= text.length) return text.length;
  // 高代理落在切点上（低代理在 desired 处被劈开）：回退一码元。
  const code = text.charCodeAt(desired - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    const backed = desired - 1;
    return backed > offset ? backed : desired + 1;
  }
  return desired;
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

/** NodeEnvRpcFunctions + dispose/内省 + IPC 端点解析（daemon 接线用）。 */
export interface NodeEnvRpcServer extends NodeEnvRpcFunctions {
  /**
   * 打开到节点本机 127.0.0.1:port 的 TCP 隧道，与 openTunnelStream 双工流
   * 双向 pipe。严格校验入参（仅 tunnelId/port/timeoutMs）；draining/disposed
   * 时返回 aborted；本机连接失败/握手失败返回结构化错误（绝不伪造成功）。
   */
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
  /** 关闭全部 reader、杀死在途命令、销毁全部 IPC socket（连接断开或停机时调用）。幂等。 */
  dispose(): Promise<void>;
  /**
   * 排空开关：true 期间新 envExec 受理即拒（升级排空/已提交让位/候选待激活），
   * 不影响已在途命令；false 恢复受理。幂等。
   */
  setDraining(value: boolean): void;
  /** 在途 envExec 数量（排空内省；含已受理未 spawn 的调用）。 */
  getActiveExecCount(): number;
  /** 打开的 reader 数量（内省/测试）。 */
  getOpenReaderCount(): number;
  /** 在途 ipcCall 数量（内省/测试）。 */
  getActiveIpcCallCount(): number;
  /** 活跃 ipcSubscribe 数量（内省/测试）。 */
  getActiveIpcSubscriptionCount(): number;
  /** 在途隧道数量（排空内省；含 TCP 已发起未完成握手的隧道）。 */
  getActiveTunnelCount(): number;
}

/**
 * nodeTunnelOpen 入参（本地最小契约：protocol 分支并入 NodeTunnel 类型前的
 * 结构化声明，字段与未来 protocol 定义一致；合并后改为 type import）。
 */
export interface NodeTunnelOpenInput {
  /** 隧道标识（1..128 非空字符串；由 Hub 生成，节点不解析语义）。 */
  tunnelId: string;
  /** 节点本机回环目标端口（1..65535 safe integer）。 */
  port: number;
  /** 隧道建立（TCP connect + 双工流握手）预算（毫秒，正有限数）。 */
  timeoutMs?: number;
}

/** NodeEnvRpcFunctions + 节点隧道扩展（protocol 并入前的本地扩展面）。 */
type NodeEnvRpcWithTunnelFunctions = NodeEnvRpcFunctions & {
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
};

/** void 返回的 RPC（abort/cleanup/unsubscribe）：不做 RpcResult 边界包装。 */
const VOID_RPC_METHODS = new Set(['envAbortExec', 'envCleanup', 'ipcAbortCall', 'ipcUnsubscribe']);

export function createNodeEnvRpcServer(options: NodeEnvRpcServerOptions): NodeEnvRpcServer {
  const {
    defaultCwd,
    onExecOutput,
    shellEnv,
    onIpcEvent,
    onIpcClosed,
    openTunnelStream,
  } = options;
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

  // —— IPC 桥状态 ————————————————————————————————————————————————
  const activeIpcCalls = new Map<string, net.Socket>();
  const activeIpcSubscriptions = new Map<string, net.Socket>();
  const allIpcSockets = new Set<net.Socket>();

  const resolveIpcEndpoint = (input: { endpoint?: string; session?: string }): string =>
    resolveHerdrIpcEndpoint(input);

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
            if (disposed || activeIpcSubscriptions.get(input.subscribeId) !== socket) return;
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

  // —— 节点侧 TCP 隧道（nodeTunnelOpen）—————————————————————————————
  // 目标固定本机回环；隧道 WS 与凭据由 daemon 注入的 openTunnelStream 封闭。
  /** 隧道建立（TCP connect + 双工流握手）缺省预算。 */
  const TUNNEL_OPEN_DEFAULT_MS = 15_000;

  interface ActiveTunnel {
    tunnelId: string;
    tcp: net.Socket;
    duplex?: Duplex;
    /** 双端销毁后 resolve（dispose 排空用）。 */
    lifecycle: Promise<void>;
    settle(): void;
  }
  const activeTunnels = new Map<string, ActiveTunnel>();
  const tunnelWaiters = new Set<Promise<void>>();

  const newTunnel = (tunnelId: string, tcp: net.Socket): ActiveTunnel => {
    let settle!: () => void;
    const lifecycle = new Promise<void>((resolve) => { settle = resolve; });
    const tunnel: ActiveTunnel = { tunnelId, tcp, lifecycle, settle };
    tunnelWaiters.add(lifecycle);
    activeTunnels.set(tunnelId, tunnel);
    return tunnel;
  };

  /** 销毁单个隧道（幂等）：移除登记、销毁 TCP 与双工流并结算生命周期。 */
  const teardownTunnel = (tunnel: ActiveTunnel): void => {
    if (activeTunnels.get(tunnel.tunnelId) !== tunnel) return;
    activeTunnels.delete(tunnel.tunnelId);
    tunnel.tcp.destroy();
    tunnel.duplex?.destroy();
    tunnelWaiters.delete(tunnel.lifecycle);
    tunnel.settle();
  };

  const nodeTunnelOpenCore = async (raw: unknown): Promise<RpcResult<null>> => {
    // 边界严格校验：plain object、字段白名单、值域——未知字段一律拒绝。
    if (!isRecord(raw) || Array.isArray(raw)) return invalidInput('nodeTunnelOpen input must be a plain object');
    const unknownFields = Object.keys(raw).filter((key) => key !== 'tunnelId' && key !== 'port' && key !== 'timeoutMs');
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
    const rawTimeout = raw['timeoutMs'];
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
      return invalidInput('nodeTunnelOpen timeoutMs must be a positive finite number when present');
    }
    if (typeof openTunnelStream !== 'function') {
      return {
        ok: false,
        error: { code: 'not_supported', message: 'node daemon 未配置隧道传输（openTunnelStream 缺失），拒绝 nodeTunnelOpen：不伪造隧道' },
      };
    }
    if (activeTunnels.has(tunnelId)) {
      return invalidInput(`nodeTunnelOpen tunnelId is already active: ${JSON.stringify(tunnelId)}`);
    }
    if (draining || disposed) {
      return {
        ok: false,
        error: {
          code: 'aborted',
          message: disposed ? 'server disposed' : 'daemon is draining (upgrade in progress), rejecting new tunnels',
        },
      };
    }
    const budgetMs = typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : TUNNEL_OPEN_DEFAULT_MS;
    // 固定本机回环目标（不解析主机名、不越出节点本机）。
    const tcp = net.connect({ host: '127.0.0.1', port });
    const tunnel = newTunnel(tunnelId, tcp);
    const fail = (error: unknown): RpcResult<null> => {
      teardownTunnel(tunnel);
      return rpcFail(error);
    };
    // TCP 连接（有界预算）：失败/超时销毁并返回结构化错误（如端口拒绝）。
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(Object.assign(new Error(`tunnel TCP connect to 127.0.0.1:${port} timed out after ${budgetMs}ms`), { code: 'timeout' }));
        }, budgetMs);
        const onConnectError = (error: Error): void => {
          clearTimeout(timer);
          // 保留底层诊断（ECONNREFUSED 等）并附上目标，不静默截断。
          reject(
            Object.assign(
              new Error(`tunnel TCP connect to 127.0.0.1:${port} failed: ${error.message}`),
              { code: (error as NodeJS.ErrnoException).code ?? 'unknown' },
            ),
          );
        };
        tcp.once('connect', () => {
          clearTimeout(timer);
          tcp.removeListener('error', onConnectError);
          resolve();
        });
        tcp.once('error', onConnectError);
      });
    } catch (error) {
      return fail(error);
    }
    // 暂停 TCP：openTunnelStream 握手期间缓冲对端首批数据，pipe 后不丢首包。
    tcp.pause();
    // 双工流握手（有界预算；超时后迟到 resolve 的流立即销毁防泄漏）。
    let abandoned = false;
    const streamPromise = Promise.resolve(openTunnelStream(tunnelId));
    void streamPromise.then(
      (late) => { if (abandoned) late.destroy(); },
      () => undefined, // 失败路径由下方 await 分支统一处理
    );
    let duplex: Duplex;
    try {
      duplex = await new Promise<Duplex>((resolve, reject) => {
        const timer = setTimeout(() => {
          abandoned = true;
          reject(Object.assign(new Error(`tunnel stream handshake timed out after ${budgetMs}ms`), { code: 'timeout' }));
        }, budgetMs);
        streamPromise.then(
          (stream) => { if (!abandoned) { clearTimeout(timer); resolve(stream); } },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
    } catch (error) {
      return fail(error);
    }
    tunnel.duplex = duplex;
    // 双向 pipe：任一端 error/close/end/finish 都销毁两端（单用途连接，
    // 不做半关闭状态机）；pipe 隐含 resume，pause 期间缓冲的首包此刻放行。
    let torn = false;
    const teardown = (): void => {
      if (torn) return;
      torn = true;
      teardownTunnel(tunnel);
    };
    tcp.on('error', teardown);
    duplex.on('error', teardown);
    tcp.once('close', teardown);
    duplex.once('close', teardown);
    duplex.once('end', teardown);
    duplex.once('finish', teardown);
    tcp.pipe(duplex);
    duplex.pipe(tcp);
    return { ok: true, value: null };
  };

  /** Result 适配：void → null（JSON 序列化友好）；失败保结构。 */
  const unwrap = async <T, R = T extends void ? null : T>(
    promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
  ): Promise<RpcResult<R>> => {
    const result = await promise;
    return result.ok ? { ok: true, value: (result.value ?? null) as R } : rpcFail(result.error);
  };

  /**
   * 组装 envExec 子进程环境（宿主 token 隔离）：
   * - 基底：节点宿主 process.env 的非机密部分（PATH/HOME 等本机工具链）；
   * - 剥除宿主 HELM_TOKEN（节点自身凭据绝不进远端会话；SDK 默认
   *   inheritEnv:true 会把 process.env 重新合并回来，故必须显式传
   *   inheritEnv:false 并自带合并结果）；
   * - 节点 daemon shellEnv（HELM_HUB_URL/HELM_DATA_DIR）覆盖基底；
   * - 调用方 input.env（Hub 受管注入，可含合法 HELM_TOKEN）最后覆盖。
   * input.inheritEnv:false 语义：只用 shellEnv + input.env，不带宿主基底。
   */
  const buildExecEnv = (
    input: { env?: Record<string, string>; inheritEnv?: boolean },
  ): { env: Record<string, string>; inheritEnv: false } => {
    const merged: Record<string, string> = {};
    if (input.inheritEnv !== false) {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toUpperCase() !== 'HELM_TOKEN') merged[key] = value;
      }
    }
    for (const [key, value] of Object.entries(shellEnv ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      merged[key] = value;
    }
    return { env: merged, inheritEnv: false as const };
  };

  /** 在途 envExec 的 settle promise（dispose 排空用；按调用追踪，幂等键不可靠）。 */
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
    // 重复 execId：在途条目会被覆盖并失去 cancel 句柄——显式拒绝。
    if (running.has(execId)) {
      return invalidInput(`Duplicate execId in flight: ${JSON.stringify(execId)}`);
    }
    const executionEnv = envFor(cwd);
    const controller = new AbortController();
    running.set(execId, { controller });
    // env 将输出回调异常转为 callback_error，并负责杀进程树及等待退出。
    const emit = (text: string, stream: 'stdout' | 'stderr', skipped?: EnvExecOutputEvent['skipped']): void => {
      if (!onExecOutput) return;
      for (let offset = 0; offset < text.length;) {
        const end = safeChunkEnd(text, offset, maxOutputChunkChars);
        onExecOutput({ execId, text: text.slice(offset, end), stream, ...(offset === 0 && skipped ? { skipped } : {}) });
        offset = end;
      }
    };
    /**
     * 取消/超时后的 stdio 排空硬超时：SDK exec 在子进程退出后仍可能被
     * detached 孙进程拽住的 stdout/stderr 管道挂住（idle grace 会因持续
     * 写入不断重置）。宽限期内底层未 settle 即强制结算，绝不永久挂死。
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
    // 取消（envAbortExec / dispose）：先给底层一个排空窗口，逾期强制 aborted。
    controller.signal.addEventListener('abort', () => {
      if (execSettled) return;
      const timer = setTimeout(
        () => forceSettleNow('aborted', 'Command aborted (stdio drain grace exceeded)'),
        abortDrainGraceMs,
      );
      drainTimers.add(timer);
    }, { once: true });
    // 底层自身 timeout 杀树后同样可能被孙进程管道挂住：timeout+宽限期到点
    // 先 cancel 再强制 timeout 结算（不再额外叠加宽限）。
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
        // 用同一文件句柄有界读取；检查后文件增长也不会触发无界分配。
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
      // 解码后：真实字节数复验（含 utf8 路径与 base64 解码结果）。
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
      // LocalExecutionEnv 未实现可选 listFiles：如实返回 not_supported，
      // 调用方（pi-durable 宿主）自行回退遍历。
      return { ok: false, error: { code: 'not_supported', message: 'listFiles is not available on this environment' } };
    },
    async envCanonicalPath({ path: target, cwd }) {
      return unwrap(envFor(cwd).canonicalPath(target));
    },
    async envExists({ path: target, cwd }) {
      return unwrap(envFor(cwd).exists(target));
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
      // 传输上限：请求的读取长度超 64 MiB 显式拒绝（分页读取由调用方分批进行）。
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

    async envCleanup(cwd?: string): Promise<void> {
      await Promise.all(
        [...envs.values()].map(async (env) => {
          if (cwd !== undefined && env.cwd !== cwd) return;
          await env.cleanup().catch(() => undefined);
        }),
      );
    },

    ipcCall,
    ipcAbortCall,
    ipcSubscribe,
    ipcUnsubscribe,
  };
  // 隧道 RPC 附着在 env 函数面之上（protocol 并入前的本地扩展）。
  const rpcFunctions: NodeEnvRpcWithTunnelFunctions = Object.assign(rpc, {
    nodeTunnelOpen: (input: NodeTunnelOpenInput): Promise<RpcResult<null>> => nodeTunnelOpenCore(input),
  });

  /**
   * 边界统一包装：所有 RpcResult 返回的 RPC——disposed / 同步异常 /
   * null 输入解构错误——一律转为结构化 RpcResult 错误信封，绝不向
   * birpc 调用方抛裸异常。void 返回的 abort/cleanup 不改签名。
   */
  const pendingOperations = new Set<Promise<unknown>>();
  const guarded = rpcFunctions as unknown as Record<string, unknown>;
  for (const key of Object.keys(rpcFunctions) as (keyof NodeEnvRpcWithTunnelFunctions)[]) {
    if (VOID_RPC_METHODS.has(key)) continue;
    const original = guarded[key];
    if (typeof original !== 'function') continue;
    if (key === 'envExec') {
      // 受理即登记：draining/disposed/对象校验与 execWaiters 计数全部在 guard
      // 入口同步完成——升级排空轮询看到的计数包含「已受理未 spawn」的调用，
      // 且已受理的调用不会因之后的 setDraining 被拒。
      guarded[key] = async (...args: unknown[]): Promise<RpcResult<unknown>> => {
        if (disposed) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
        const input = args[0];
        if (!input || typeof input !== 'object' || Array.isArray(input)) return invalidInput('RPC input must be an object');
        if (draining) {
          return { ok: false, error: { code: 'aborted', message: 'daemon is draining (upgrade in progress), rejecting new commands' } };
        }
        const operation = trackExec(
          Promise.resolve().then(() => (original as (...a: unknown[]) => Promise<RpcResult<unknown>>)(...args)),
        );
        pendingOperations.add(operation);
        try {
          return await operation;
        } catch (error) {
          return rpcFail(error);
        } finally {
          pendingOperations.delete(operation);
        }
      };
      continue;
    }
    if (key === 'nodeTunnelOpen') {
      // 受理即登记：draining/disposed 拒新隧道；隧道生命周期（双端销毁）
      // 由 tunnelWaiters 追踪，dispose 排空时等待其 settle。
      guarded[key] = async (...args: unknown[]): Promise<RpcResult<unknown>> => {
        if (disposed) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
        const input = args[0];
        if (!input || typeof input !== 'object' || Array.isArray(input)) return invalidInput('RPC input must be an object');
        if (draining) {
          return { ok: false, error: { code: 'aborted', message: 'daemon is draining (upgrade in progress), rejecting new tunnels' } };
        }
        const operation = Promise.resolve().then(() => (original as (...a: unknown[]) => Promise<RpcResult<unknown>>)(...args));
        pendingOperations.add(operation);
        try {
          return await operation;
        } catch (error) {
          return rpcFail(error);
        } finally {
          pendingOperations.delete(operation);
        }
      };
      continue;
    }
    guarded[key] = async (...args: unknown[]): Promise<RpcResult<unknown>> => {
      if (disposed) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
      if (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return invalidInput('RPC input must be an object');
      const operation = Promise.resolve().then(() => disposed
        ? { ok: false as const, error: { code: 'aborted' as const, message: 'server disposed' } }
        : (original as (...a: unknown[]) => Promise<RpcResult<unknown>>)(...args));
      pendingOperations.add(operation);
      try {
        return await operation;
      } catch (error) {
        return rpcFail(error);
      } finally {
        pendingOperations.delete(operation);
      }
    };
  }

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      for (const exec of running.values()) exec.controller.abort(new Error('connection closed'));
      // 隧道：销毁全部 TCP/双工流并等待生命周期 settle（teardown 幂等）。
      for (const tunnel of [...activeTunnels.values()]) teardownTunnel(tunnel);
      for (const socket of allIpcSockets) socket.destroy();
      allIpcSockets.clear();
      activeIpcCalls.clear();
      activeIpcSubscriptions.clear();
      await Promise.allSettled([...pendingOperations, ...execWaiters, ...tunnelWaiters]);
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
    resolveIpcEndpoint,
    setDraining: (value: boolean): void => {
      draining = value === true;
    },
    // 排空内省按「已受理」计数（execWaiters 在受理同步段登记，含尚未 spawn 的调用）。
    getActiveExecCount: () => execWaiters.size,
    getOpenReaderCount: () => readers.size,
    getActiveIpcCallCount: () => activeIpcCalls.size,
    getActiveIpcSubscriptionCount: () => activeIpcSubscriptions.size,
    getActiveTunnelCount: () => activeTunnels.size,
  }) as NodeEnvRpcServer;
}
