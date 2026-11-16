/**
 * 节点侧远端执行环境 RPC 服务端（组装主干）：完整实现 `NodeEnvRpcFunctions`。
 *
 * 文件/shell 能力由内置零外部依赖的 `LocalExecutionEnv`（Node.js 原生
 * fs/promises + child_process，见 ./local-env.ts）承载：每个 cwd 一个
 * env 实例（无跨 cwd 污染）；reader 以 readerId 句柄桥接，dispose 关闭
 * 全部 reader；envExec 以独立 AbortController 取消，envAbortExec(execId)
 * 立即终止命令进程树，流式输出经 onExecOutput 分帧回传 Hub；连接断开时
 * dispose：关 reader、杀本连接发起的命令并等待在途 promise settle；每个
 * 连接（generation）一个独立 server 实例，旧代命令/readers 绝不跨代复用。
 *
 * Herdr IPC 桥（ipcCall/ipcSubscribe）与节点侧 TCP 隧道（nodeTunnelOpen，
 * 与 daemon 注入的 openTunnelStream 双工流双向 pipe，本层零凭据）分别在
 * ./env-rpc-ipc.ts 与 ./env-rpc-tunnel.ts，经 isDisposed()/isDraining()
 * 状态查询协作；admit/draining 守卫与 dispose 统一排空顺序留在此处。
 *
 * 错误码语义（升级排空 vs 取消）：draining 拒新请求（envExec / ipcCall /
 * ipcSubscribe / nodeTunnelOpen / envCleanup）一律返回稳定码 node_draining；
 * 用户/宿主取消、连接代终结、dispose 强制结算仍为 aborted——绝不互混。
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

export { resolveHerdrIpcEndpoint } from './env-rpc-ipc.js';
export type { IpcEndpointContext } from './env-rpc-ipc.js';

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
   * 进程占用扫描注入（仅测试或受控宿主注入；生产不伪造）：
   * - procRoot：/proc 根替代（缺省 '/proc'）；
   * - platform：平台事实替代（缺省 process.platform；非 linux 显式
   *   not_supported，绝不伪造跨平台结果）。
   */
  pathUsage?: {
    procRoot?: string;
    platform?: () => string;
  };
  /**
   * 取消/超时后等待底层 stdio 管道排空的硬超时（毫秒，默认 500）：
   * 当命令派生的 detached 孙进程继承了 stdout/stderr fd 并持续写入时，
   * SDK exec 可能因等待流关闭而永久挂起；超过该宽限期即强制结算，
   * 保证 envExec / dispose 绝不被孤儿孙进程拽住。
   */
  abortDrainGraceMs?: number;
  /**
   * 打开隧道双工流（daemon 层注入：连接 Hub 的 /ws/node-tunnel 并完成握手）。
   * signal 用于取消在途建连（nodeTunnelAbort / dispose）：实现应尽快
   * reject 并销毁底层资源；env-rpc-tunnel 只消费双工流，零凭据。
   */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
}

const readerNotFound = <T>(readerId: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'not_found', message: `Unknown reader: ${readerId}` },
});

/** 二进制传输上限（64 MiB）：read/write/base64 往返的单次载荷上限，超限显式报错。 */
const MAX_BINARY_TRANSFER_BYTES = 64 * 1024 * 1024;

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

/** NodeEnvRpcFunctions + dispose/内省 + IPC 端点解析（daemon 接线用）。 */
export interface NodeEnvRpcServer extends NodeEnvRpcFunctions {
  /**
   * 打开到目标 host:port（host 缺省 127.0.0.1，由本节点解析连接）的 TCP
   * 隧道，与 openTunnelStream 双工流双向 pipe。严格校验入参（仅
   * tunnelId/host/port/timeoutMs）；draining 时返回 node_draining、disposed
   * 时返回 aborted；本机连接失败/握手失败返回结构化错误（绝不伪造成功）。
   */
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
  /** 取消在途隧道（握手中或已建立）：销毁该隧道的 TCP/WS 并立即返回。 */
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** 关闭全部 reader、杀死在途命令、销毁全部 IPC socket（连接断开或停机时调用）。幂等。 */  dispose(): Promise<void>;
  /**
   * 排空开关：true 期间新 envExec / ipcCall / ipcSubscribe 受理即拒（升级
   * 排空/已提交让位/候选待激活），不影响已在途命令；false 恢复受理。幂等。
   */
  setDraining(value: boolean): void;
  /** 在途 envExec 数量（排空内省；含已受理未 spawn 的调用）。 */
  getActiveExecCount(): number;
  /** 打开的 reader 数量（内省/测试）。 */
  getOpenReaderCount(): number;
  /** 在途 ipcCall 数量（排空内省；含无 callId 的在途调用，受理即计数）。 */
  getActiveIpcCallCount(): number;
  /** 活跃 ipcSubscribe 数量（内省/测试；长驻订阅不计入排空等待）。 */
  getActiveIpcSubscriptionCount(): number;
  /** 在途隧道数量（排空内省；含 TCP 已发起未完成握手的隧道）。 */
  getActiveTunnelCount(): number;
}

/** void 返回的 RPC（abort/cleanup/unsubscribe）：不做 RpcResult 边界包装；
 * envCleanup 因按 cwd 杀全部同 cwd 会话在途命令的破坏性语义，在函数内
 * 自带 disposed/draining 显式拒绝（抛错经 birpc 错误信封如实回拒）。 */
const VOID_RPC_METHODS = new Set(['envAbortExec', 'envCleanup', 'ipcAbortCall', 'ipcUnsubscribe', 'nodeTunnelAbort']);

/**
 * guard 受理策略（与 VOID_RPC_METHODS 同层的数据声明，缺省策略为不拒新、不追踪）：
 * - envExec：受理即登记——draining/disposed/对象校验与 execWaiters 计数
 *   全部在 guard 入口同步完成，升级排空轮询看到的计数包含「已受理未
 *   spawn」的调用，且已受理的调用不会因之后的 setDraining 被拒；
 * - nodeTunnelOpen：draining 拒新隧道；隧道生命周期（双端销毁）由
 *   tunnelWaiters 追踪，dispose 排空时等待其 settle，不再另行计数；
 * - ipcCall：一次性 call 计入排空口径（ipcWaiters），升级等待其收敛，
 *   不被旧宿主退出硬切断；
 * - ipcSubscribe：订阅是长驻语义，排空不等待它收敛（等待它等于禁止
 *   升级期间订阅存在），但 draining 时拒新——旧宿主 dispose 前统一优雅
 *   关闭既有订阅并经 onIpcClosed 通知 Hub，Hub 侧可自行重订。
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
    isDisposed: () => disposed,
  });
  const tunnels = createTunnelHandler({
    openTunnelStream: options.openTunnelStream,
    isDisposed: () => disposed,
    isDraining: () => draining,
  });

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
        // 受管身份变量剥除（HELM_TOKEN / HELM_EXECUTION_SCOPE）：daemon 宿主
        // 自身的值绝不静默进入子命令；合法值只由调用方 input.env 按次注入。
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

    /**
     * 节点本机进程占用快照（删除前诊断；只读面，升级排空不拒绝——与文件
     * 只读操作同口径）。进程内直接扫描（零 helper spawn、不用目标 cwd 启动
     * 任何子进程）；只读 cwd/fd/comm 定位信息，绝不读 cmdline/environ。
     * 入参严格校验（仅 path 字段）；非 Linux 平台显式 not_supported；持久
     * 权限拒读（EACCES/EPERM，跨 uid 或 non-dumpable 如 systemd --user）
     * 计为结构性盲区（unobservable 计数 + 诊断，不影响完整性）；非权限
     * 类读取错误使 complete=false（绝不假装完整/干净）。
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
      // 与 Hub 侧共用 @helm/env-io 同一 node fs 适配，绝不各复制一套语义。
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

    /**
     * 按 cwd 粒度清理：杀同 cwd 下**全部**在途命令进程树（envs 被同节点多
     * 会话共享，cwd 不是会话隔离键），会误杀同 cwd 其他会话的在途命令；
     * Hub 侧 remote-env 刻意不调用本方法（连接级 dispose 兜底）。
     * draining/disposed 时拒绝：排空期清杀破坏「排空不强杀」事务语义
     * （birpc 错误信封如实回拒，不静默）。
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
  // 隧道 RPC 附着（protocol NodeEnvRpcFunctions 已含 optional 两方法）。
  const rpcFunctions: NodeEnvRpcFunctions = Object.assign(rpc, {
    nodeTunnelOpen: (input: NodeTunnelOpenInput): Promise<RpcResult<null>> => tunnels.nodeTunnelOpen(input),
    nodeTunnelAbort: tunnels.nodeTunnelAbort,
  });

  /**
   * 边界统一包装：所有 RpcResult 返回的 RPC——disposed / 同步异常 /
   * null 输入解构错误——一律转为结构化 RpcResult 错误信封，绝不向
   * birpc 调用方抛裸异常。void 返回的 abort/cleanup 不改签名。
   *
   * 方法差异只经 admit 参数化：
   * - drainingWhat：参与升级排空拒新的方法及其拒新文案主题；未配置的
   *   方法不拒新（文件只读面与排空无关），并在延迟执行段复核 disposed
   *   （受理与执行间被 dispose 时以 aborted 拒绝，不再触碰 original）；
   * - tracker：受理即计入排空内省（trackExec / trackIpc）。
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
      // 隧道/IPC：销毁全部 TCP、双工流与 socket 并清空在途登记（幂等）。
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
    // 排空内省按「已受理」计数（execWaiters/ipcWaiters 在受理同步段登记）。
    getActiveExecCount: () => execWaiters.size,
    getOpenReaderCount: () => readers.size,
    getActiveIpcCallCount: () => ipc.getActiveCallCount(),
    getActiveIpcSubscriptionCount: () => ipc.getActiveSubscriptionCount(),
    getActiveTunnelCount: () => tunnels.getActiveTunnelCount(),
  }) as NodeEnvRpcServer;
}
