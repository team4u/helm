/**
 * 受控节点守护进程：文件身份 + 单世代在途的 WS+birpc 生命周期。
 *
 * - 身份：`<dataDir>/node.json`（nodeId + token，0600，全字段严格校验）。两种来源：
 *   a) Hub 签发的 JOIN 令牌 `nodeId:secret`（nodeId 不含冒号）——
 *      runNodeDaemon 直接从令牌解析并持久化（原子 0600 写）；
 *   b) 显式 identity 参数（createNodeDaemon 低层入口，测试 fixture 用）。
 * - 连接世代（generation）：一次连接尝试自 new WebSocket 起即建代——握手/
 *   注册/心跳任一阶段失败都走同一条幂等终结路径：close rpc、dispose 该代
 *   env server（关 reader、杀该代命令、销毁 IPC socket）、终止 socket；
 *   旧代回调绝不触碰新代状态；同一时刻至多一个重连计时器、一个在途连接。
 * - 心跳：单次心跳预算 = 心跳间隔的 3/4（1s..30s 封顶）；在途心跳未落定前
 *   不发下一跳；连续 2 次预算内无应答或被显式拒绝 → 终结当前代并重连。
 * - 远端受管 shell 能直接运行 `helm`：daemon 将本机受管 helm 客户端 bin
 *   目录前置到 PATH；bin 目录不可定位时启动即显式诊断失败，绝不假称支持。
 * - 重连：指数退避（默认 500ms 起、上限 30s），无限重试；重连等待期保持
 *   事件循环存活（计时器不 unref），库模式由 close() 终止一切。断开期间
 *   in-flight RPC 立即失败——已开始的 envExec 不重放（结果未知语义）。
 * - waitUntilRegistered：反映**当前**注册状态——已在线立即 true；等待中
 *   的调用由**下一次**注册结果 settle（新注册可将其翻为 true）；当前代
 *   终结且处于离线时 resolve(false)，绝不把过去成功当现在在线、绝不伪造。
 * - 库模式不接管 process 信号（CLI/宿主自行管理生命周期）；
 *   close() 幂等，返回前等待全部在途世代清理完成，无孤儿定时器。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeConnectInput,
  NodeEnvRpcFunctions,
  NodeHealthSnapshot,
  NodeHeartbeatInput,
  NodeIpcClosedEvent,
  NodeIpcEvent,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helm/protocol';
import { DEFAULT_NODE_ID } from '@helm/protocol';
import { createNodeEnvRpcServer, type NodeEnvRpcServer, type NodeEnvRpcServerOptions } from './env-rpc-server.js';

/** 节点侧调用 Hub 的函数集（register/heartbeat/onEnvExecOutput/onIpc*）。 */
export interface HubSideFunctions {
  register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>;
  onEnvExecOutput(event: EnvExecOutputEvent): Promise<void> | void;
  onIpcEvent?(event: NodeIpcEvent): Promise<void> | void;
  onIpcClosed?(event: NodeIpcClosedEvent): Promise<void> | void;
}

export interface NodeIdentity {
  nodeId: string;
  token: string;
  /** 签发时记录的 hub 地址（提示用；实际连接以 hubUrl 参数为准）。 */
  hubUrl?: string;
}

export interface NodeDaemonOptions {
  hubUrl: string;
  identity: NodeIdentity;
  dataDir: string;
  /** env RPC 服务器选项（defaultCwd 默认 dataDir）。 */
  envServer?: Omit<NodeEnvRpcServerOptions, 'defaultCwd' | 'onExecOutput' | 'onIpcEvent' | 'onIpcClosed'>;
  /** 重连基础延迟（毫秒）；缺省 500。 */
  reconnectBaseDelayMs?: number;
  /** 重连最大延迟（毫秒）；缺省 30_000。 */
  reconnectMaxDelayMs?: number;
  /** 日志（缺省 console.error）。绝不回传消息内容（不得含 token）。 */
  log?: (message: string) => void;
}

export interface NodeDaemon {
  readonly identity: NodeIdentity;
  readonly hubUrl: string;
  /** 当前是否连接并已注册。 */
  isConnected(): boolean;
  /**
   * 等待注册结果：已在线立即 true；否则等待**下一次**注册尝试的结果——
   * 成功 true；关闭/离线确认/被拒/超时 false。绝不把历史成功当现在在线。
   */
  waitUntilRegistered(timeoutMs?: number): Promise<boolean>;
  /** 停止：断开连接、dispose 全部世代 env server、清理定时器。幂等，返回前等待清理完成。 */
  close(): Promise<void>;
}

// —— 常量预算 ————————————————————————————————————————————————————————
/** WS 握手（TCP+HTTP upgrade）预算；超时终结本次尝试走重连。 */
const CONNECT_TIMEOUT_MS = 10_000;
/** 单次 register 总预算（WS open 后）。 */
const REGISTER_TIMEOUT_MS = 15_000;
/** 心跳预算下/上限（实际 = min(max(interval*3/4, 1s), 30s)）。 */
const HEARTBEAT_BUDGET_MIN_MS = 1_000;
const HEARTBEAT_BUDGET_MAX_MS = 30_000;
/** close 等待世代清理的兜底上限。 */
const CLOSE_SETTLE_TIMEOUT_MS = 10_000;
/** NODE_ID 合法字符（JOIN 的 nodeId 段，非 local）。 */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** JOIN 令牌 secret 段非空且不含控制字符/首尾空白。 */
const JOIN_SECRET_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

/** 节点数据目录：显式 > HELM_DATA_DIR > ~/.helm。 */
export function resolveNodeDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = process.env['HELM_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.helm');
}

/**
 * 采集本机节点健康快照（纯只读）：
 * - 基础指标来自 os 模块（uptime/loadavg/freemem/totalmem）；
 * - 磁盘空间用 fs.statfs 采集目标目录所在挂载点（目录不存在回退 homedir，
 *   仍失败则省略 disk 字段）；任何采集失败都不得中断注册/心跳主流程。
 */
export async function collectNodeHealth(targetDir?: string): Promise<NodeHealthSnapshot> {
  const load = os.loadavg();
  const snapshot: NodeHealthSnapshot = {
    collectedAt: Date.now(),
    uptimeSec: os.uptime(),
    loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memFreeBytes: os.freemem(),
    memTotalBytes: os.totalmem(),
  };
  try {
    const dir = targetDir ?? os.homedir();
    let stats: { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };
    try {
      stats = await fs.statfs(dir);
    } catch {
      // 目标目录不存在（挂载点尚未就绪等）：回退 homedir 再试一次。
      stats = await fs.statfs(os.homedir());
    }
    snapshot.diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    snapshot.diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // statfs 不可用（平台/权限）：省略磁盘字段，绝不抛出中断心跳。
  }
  return snapshot;
}

/** JOIN 令牌格式：`nodeId:secret`（nodeId 不含冒号、非保留 local ID）。
 * 拒绝：local ID、空白 nodeId/secret、控制字符。secret 可含冒号（取首段后全部）。
 */
export function parseJoinToken(token: string): { nodeId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  if (token !== token.trim()) return null;
  const index = token.indexOf(':');
  if (index <= 0 || index === token.length - 1) return null;
  const nodeId = token.slice(0, index);
  const secret = token.slice(index + 1);
  if (!NODE_ID_PATTERN.test(nodeId) || nodeId === DEFAULT_NODE_ID) return null;
  if (!JOIN_SECRET_PATTERN.test(secret)) return null;
  return { nodeId, secret };
}

/** 严格校验身份对象：null/数组/坏 nodeId/token/hubUrl 一律拒绝。 */
function assertValidIdentity(identity: unknown, context: string): asserts identity is NodeIdentity {
  const invalid = (detail: string): Error =>
    new Error(`${context}：${detail}（期望 { nodeId, token[, hubUrl] }，nodeId 匹配 ${NODE_ID_PATTERN}）`);
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw invalid('值不是对象');
  }
  const record = identity as Record<string, unknown>;
  if (typeof record['nodeId'] !== 'string' || !NODE_ID_PATTERN.test(record['nodeId']) || record['nodeId'] === DEFAULT_NODE_ID) {
    throw invalid('nodeId 缺失或非法');
  }
  if (typeof record['token'] !== 'string' || parseJoinToken(record['token'])?.nodeId !== record['nodeId']) {
    throw invalid('token 非法或与 nodeId 不一致');
  }
  if (record['hubUrl'] !== undefined) {
    if (typeof record['hubUrl'] !== 'string') throw invalid('hubUrl 非字符串');
    try {
      assertValidHubUrl(record['hubUrl']);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
}

/** 校验 http(s) Hub URL：协议、主机、无 userinfo/片段/凭据查询。 */
function assertValidHubUrl(hubUrl: string): URL {
  if (typeof hubUrl !== 'string' || hubUrl === '' || hubUrl !== hubUrl.trim()) throw new Error('Hub 地址必须是非空 URL');
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error('Hub 地址无法解析');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Hub 地址协议必须为 http(s): ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Hub 地址不得包含 userinfo（user:pass@）');
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Hub 地址不得包含 fragment 或查询参数');
  }
  return parsed;
}

/** 读取节点身份：仅 ENOENT 视为未配置返回 null；损坏/结构非法/IO 错误显式抛出。 */
export async function readNodeIdentity(dataDir: string): Promise<NodeIdentity | null> {
  const file = path.join(dataDir, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`节点身份文件损坏（${file}）：无法解析 JSON`);
  }
  try {
    assertValidIdentity(parsed, `节点身份文件结构非法（${file}）`);
  } catch (error) {
    throw new Error(`节点身份文件结构非法（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

/** 原子写入身份（同目录临时文件 + rename；0600，chmod 失败显式抛出）。 */
export async function writeNodeIdentity(dataDir: string, identity: NodeIdentity): Promise<void> {
  assertValidIdentity(identity, '节点身份非法');
  const target = path.join(dataDir, 'node.json');
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

// —— 绑定互斥（进程内 + 跨进程锁文件）————————————————————————————————

/** 进程内绑定互斥（同 dataDir 的并发 bindIdentityFromJoinToken 串行）。 */
const bindLocks = new Map<string, Promise<unknown>>();

/**
 * 跨进程身份锁：`node.json.lock`（O_CREAT|O_EXCL）。离开作用域即清理
 * （含异常）；纯朴素锁文件满足开发期需要——不做陈锁仲裁。
 */
async function withIdentityLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = bindLocks.get(dataDir);
  let releaseInner: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  bindLocks.set(dataDir, gate);
  try {
    if (previous !== undefined) await previous;
  } catch {
    // 前序失败不阻塞本次绑定。
  }
  const lockPath = path.join(dataDir, 'node.json.lock');
  let handle: fs.FileHandle | undefined;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(
        `并发绑定冲突：${lockPath} 已存在（另一 helm-node connect 正在写入，或上次绑定异常退出残留；确认后删除该文件重试）`,
      );
    }
  } catch (error) {
    releaseInner();
    if (bindLocks.get(dataDir) === gate) bindLocks.delete(dataDir);
    throw error;
  }
  try {
    return await fn();
  } finally {
    await handle!.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    releaseInner();
    if (bindLocks.get(dataDir) === gate) bindLocks.delete(dataDir);
  }
}

/**
 * 持久化身份绑定（JOIN 语义；绑定全程持锁）：
 * - 无既有身份：持久化令牌身份；
 * - 既有同 nodeId：令牌轮换（新 secret 更新）；
 * - 既有不同 nodeId：显式报错（同一数据目录不得静默改换门庭），需人工清理。
 */
export async function bindIdentityFromJoinToken(
  dataDir: string,
  token: string,
  hubUrl: string,
): Promise<NodeIdentity> {
  const parsed = parseJoinToken(token);
  if (parsed === null) {
    throw new Error(`JOIN 令牌格式非法（期望 nodeId:secret，nodeId 不含冒号、不得为 local）：${describeToken(token)}`);
  }
  try {
    assertValidHubUrl(hubUrl);
  } catch (error) {
    throw new Error(`JOIN 绑定失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedDataDir = path.resolve(dataDir);
  return await withIdentityLock(resolvedDataDir, async () => {
    const existing = await readNodeIdentity(resolvedDataDir);
    if (existing !== null && existing.nodeId !== parsed.nodeId) {
      throw new Error(
        `数据目录已绑定节点 ${existing.nodeId}，拒绝改绑为 ${parsed.nodeId}；如确需更换请先删除 ${path.join(dataDir, 'node.json')}`,
      );
    }
    const identity: NodeIdentity = { nodeId: parsed.nodeId, token, hubUrl };
    await writeNodeIdentity(resolvedDataDir, identity);
    return identity;
  });
}

/** 非法令牌的安全描述（永不输出前缀/内容，只给形状）。 */
function describeToken(token: string): string {
  const kind = typeof token !== 'string' ? `类型 ${typeof token}` : `长度 ${token.length}`;
  return `令牌（${kind}）不匹配格式`;
}

/**
 * 从 JOIN 令牌解析运行身份：token 非法一律显式拒绝，绝不回退既存身份
 * （传入的 token 就是意图本身——坏 token 却静默用旧身份运行是鉴权事故）。
 */
async function resolveRunIdentity(dataDir: string, input: NodeConnectInput): Promise<NodeIdentity> {
  if (parseJoinToken(input.token) === null) {
    throw new Error(
      `token 非法，拒绝启动（必须是 Hub 签发的 JOIN 令牌 nodeId:secret，nodeId 不含冒号、不得为 local）：${describeToken(input.token)}`,
    );
  }
  return bindIdentityFromJoinToken(dataDir, input.token, input.hubUrl);
}

// —— 受管 helm 客户端 bin 目录 ————————————————————————————————————————

/** 受管 helm 客户端 bin 目录解析结果：目录或显式诊断（无可静默回退的路径）。 */
export type ResolvedCliBinDir = { dir: string } | { error: string };

type RegisterOutcome = { kind: 'ack'; result: NodeRegisterResult } | { kind: 'timeout' } | { kind: 'error' };
type HeartbeatOutcome = { kind: 'ack'; alive: boolean } | { kind: 'timeout' };


const statExecutable = async (target: string): Promise<boolean> => {
  try {
    const st = await fs.stat(target);
    if (process.platform === 'win32') return st.isFile();
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * 解析本机受管 helm 客户端 bin 目录（远端 bash `helm ...` 的来源）：
 * a) 显式入参 / `HELM_CLI_BIN_DIR` 环境变量；
 * b) 当前 PATH 中已部署的客户端；
 * c) 逐级向上找 node_modules/.bin（workspace 安装布局，含 helm 链接）。
 * 找不到即返回显式诊断——绝不假称支持。
 */
export async function resolveManagedHelmBinDir(explicit?: string): Promise<ResolvedCliBinDir> {
  const describe = async (dir: string): Promise<ResolvedCliBinDir> => {
    const entry = process.platform === 'win32' ? path.join(dir, 'helm.cmd') : path.join(dir, 'helm');
    return (await statExecutable(entry)) ? { dir } : { error: `目录 ${dir} 中找不到可执行的 helm 客户端` };
  };
  if (explicit !== undefined && explicit !== '') return await describe(explicit);
  const fromEnv = process.env['HELM_CLI_BIN_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return await describe(fromEnv);
  const inheritedPath = process.env['PATH'] ?? '';
  for (const entry of inheritedPath.split(path.delimiter)) {
    if (!entry) continue;
    const result = await describe(entry);
    if ('dir' in result) return result;
  }
  // node_modules/.bin 兜底（pnpm workspace 布局；每次重新解析避免缓存陈旧）。
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = selfDir, depth = 0; dir !== path.dirname(dir) && depth < 16; dir = path.dirname(dir), depth += 1) {
    const candidate = path.join(dir, 'node_modules', '.bin');
    const result = await describe(candidate);
    if ('dir' in result) return result;
  }
  return {
    error:
      '无法定位本机 helm 客户端 bin 目录（远端 bash 将无法运行 helm）。' +
      '请部署独立的 helm 客户端并将其加入 PATH，或设置 HELM_CLI_BIN_DIR=<含 helm 可执行文件的目录>',
  };
}

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/** 前置受管 bin 目录到 PATH（构建 daemon shellEnv 用）。 */
const prependPath = (binDir: string, shellEnv: Record<string, string | undefined>): Record<string, string | undefined> => {
  const current = shellEnv['PATH'] ?? process.env['PATH'] ?? '';
  const merged = current === '' ? binDir : `${binDir}${PATH_SEP}${current}`;
  return { ...shellEnv, PATH: merged };
};

async function withinBudget<T>(operation: Promise<T>, timeoutMs: number, expired: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(expired), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createNodeDaemon(options: NodeDaemonOptions): Promise<NodeDaemon> {
  const {
    hubUrl,
    identity,
    dataDir,
    envServer = {},
    reconnectBaseDelayMs = 500,
    reconnectMaxDelayMs = 30_000,
    log: writeLog = (message) => console.error(`[helm-node] ${message}`),
  } = options;

  assertValidIdentity(identity, '节点身份非法');
  const log = (message: string): void => writeLog(message.replaceAll(identity.token, '[REDACTED]'));
  const hub = assertValidHubUrl(hubUrl);

  // 远端 bash 必须能直接运行 helm：不可定位即启动失败（显式诊断，不静默降级）。
  const cliBin = await resolveManagedHelmBinDir(envServer.shellEnv?.['HELM_CLI_BIN_DIR'] as string | undefined);

  let closed = false;
  /** 在途连接世代（自 new WebSocket 起存在，close/失败后清空）。 */
  let generation:
    | {
        server: NodeEnvRpcServer;
        hubRpc: BirpcReturn<HubSideFunctions, NodeEnvRpcFunctions>;
        socket: WebSocket;
        heartbeatTimer: NodeJS.Timeout | undefined;
        connectTimeout?: NodeJS.Timeout;
        registered: boolean;
        disposePromise?: Promise<void>;
      }
    | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = reconnectBaseDelayMs;
  /** 清理中世代（dispose 未落定）；close() 等待它们排空。 */
  const settlingDisposes = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];

  const registerWaiters = new Set<(ok: boolean) => void>();

  /**
   * 离线确认：resolve 全部等待者 false。仅对「当前」等待者生效——
   * 随后的重连注册仍可把新等待者翻为 true（不缓存失败）。
   */
  const confirmOffline = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(false);
  };

  /** 新注册结果：仅成功时清理等待者（失败不缓存——下次尝试仍可成功）。 */
  const announceRegistered = (): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(true);
  };

  /** 至多一个重连计时器：已有未触发计时器则保持不变。 */
  const scheduleReconnect = (): void => {
    if (closed || connectTimer !== undefined) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectMaxDelayMs, reconnectDelay * 2);
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      connect();
    }, delay);
  };

  const clearHeartbeat = (gen: NonNullable<typeof generation>): void => {
    if (gen.heartbeatTimer !== undefined) {
      clearInterval(gen.heartbeatTimer);
      gen.heartbeatTimer = undefined;
    }
  };

  /**
   * 世代终结（幂等，仅该世代自身路径调用）：rpc $close、socket terminate、
   * dispose env server（登记 settling，close() 等待排空）。绝不触碰全局状态
   * 之外的东西——当前代清空后，迟到回调即失效。返回 dispose promise。
   */
  const retireGeneration = (gen: NonNullable<typeof generation>): Promise<void> => {
    if (gen.disposePromise) return gen.disposePromise;
    clearHeartbeat(gen);
    clearTimeout(gen.connectTimeout);
    gen.registered = false;
    try {
      gen.hubRpc.$close();
    } catch {
      // 已关闭。
    }
    if (gen.socket.readyState === WebSocket.OPEN || gen.socket.readyState === WebSocket.CONNECTING) {
      try {
        gen.socket.terminate();
      } catch {
        // 忽略。
      }
    }
    const dispose = gen.server
      .dispose()
      .catch((error: unknown) => {
        cleanupErrors.push(error);
        log('节点连接资源清理失败');
      })
      .finally(() => {
        settlingDisposes.delete(dispose);
      });
    gen.disposePromise = dispose;
    settlingDisposes.add(dispose);
    if (generation === gen) {
      generation = undefined;
      confirmOffline();
    }
    return dispose;
  };

  const startConnect = (): void => {
    const wsUrl = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${hub.pathname.replace(/\/+$/, '')}/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}`;

    // —— 新世代：连接尝试即建代（握手失败也要 dispose server/rpc）——
    const socket = new WebSocket(wsUrl);
    const server = createNodeEnvRpcServer({
      defaultCwd: dataDir,
      ...envServer,
      shellEnv: baseShellEnv,
      onExecOutput: (event) => pushEvent('onEnvExecOutput', event),
      onIpcEvent: (event) => pushEvent('onIpcEvent', event),
      onIpcClosed: (event) => pushEvent('onIpcClosed', event),
    });
    const hubRpc = createBirpc<HubSideFunctions, NodeEnvRpcFunctions>(server, {
      post: (data) => {
        // 非 OPEN 一律显式抛错（消息不得无声丢失）；事件推送调用侧已 catch。
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error(`[birpc] WS 非 OPEN 状态拒绝发送（readyState=${socket.readyState}）`);
        }
        socket.send(JSON.stringify(data));
      },
      // post 抛错（断开半开等）会被 birpc 的消息处理路径重新抛出：在此吸收并
      // 诊断，同时终结当前代（断开语义由重连兑底，不静默丢消息也不崩溃）。
      onGeneralError: (error, functionName) => {
        log(`RPC 发送失败（${functionName ?? 'unknown'}）: ${error instanceof Error ? error.message : String(error)}`);
        onGone('RPC transport failed');
        return true;
      },
      on: (callback) => {
        socket.on('message', (raw) => {
          const text = typeof raw === 'string' ? String(raw) : Buffer.from(raw as ArrayBuffer).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            // 非法 JSON 帧：协议级污染——关闭并诊断，绝不静默丢帧。
            log(`收到非法 JSON 帧长度=${text.length}，终止连接`);
            onGone('invalid frame');
            return;
          }
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) callback(parsed);
          else {
            log('收到非法 RPC 帧，终止连接');
            onGone('invalid frame');
          }
        });
      },
      off: (callback) => {
        socket.off('message', callback as never);
      },
      serialize: (data) => data,
      deserialize: (data) => data as never,
      timeout: 30 * 60 * 1000, // envExec 等长请求预算；register/heartbeat 单独限时
    });

    const gen: NonNullable<typeof generation> = {
      server,
      hubRpc,
      socket,
      heartbeatTimer: undefined,
      registered: false,
    };
    generation = gen;
    let gone = false;

    /** 世代终结唯一路径：幂等，只处理本代。 */
    const onGone = (reason: string): void => {
      if (gone || generation !== gen) return;
      gone = true;
      clearTimeout(connectTimeout);
      const dispose = retireGeneration(gen);
      gen.disposePromise = dispose;
      log(`连接断开（${reason}），${closed ? '已停止' : '将重连'}`);
      scheduleReconnect();
    };

    function pushEvent(method: 'onEnvExecOutput' | 'onIpcEvent' | 'onIpcClosed', event: EnvExecOutputEvent | NodeIpcEvent | NodeIpcClosedEvent): void {
      if (generation !== gen) return;
      const fn = gen.hubRpc[method];
      if (!fn) {
        onGone('stream callback unavailable');
        throw new Error('Hub 不支持节点流式回调');
      }
      try {
        void Promise.resolve(fn.asEvent(event as never)).catch(() => onGone('stream send failed'));
      } catch (error) {
        onGone('stream send failed');
        throw error;
      }
    }

    // 握手预算：超时即终结本代（close 事件随之而来但已幂等）。
    const connectTimeout = setTimeout(() => {
      if (generation === gen && !gone) onGone('connect timeout');
    }, CONNECT_TIMEOUT_MS);

    gen.connectTimeout = connectTimeout;

    socket.on('open', () => {
      if (closed || generation !== gen) return;
      clearTimeout(connectTimeout);
      void (async () => {
        // register 短预算：超时按失败终结本代（不占用 30 分钟 RPC 预算）。
        const health = await collectNodeHealth(dataDir).catch(() => undefined);
        const ack = await withinBudget<RegisterOutcome>(
          hubRpc.register({
            nodeId: identity.nodeId, token: identity.token,
            hostname: os.hostname(), platform: process.platform, hubUrl,
            ...(health !== undefined ? { health } : {}),
          }).then((result) => ({ kind: 'ack', result })),
          REGISTER_TIMEOUT_MS,
          { kind: 'timeout' },
        ).catch((): RegisterOutcome => ({ kind: 'error' }));
        if (closed || generation !== gen) return;
        if (ack.kind !== 'ack') {
          log(ack.kind === 'timeout' ? 'register 超时' : 'register 失败（连接中断）');
          onGone(ack.kind === 'timeout' ? 'register timeout' : 'register failed');
          return;
        }
        const result = ack.result;
        if (result?.ok !== true || !Number.isFinite(result.heartbeatMs) || result.heartbeatMs <= 0 || result.heartbeatMs > 300_000) {
          log('register 被拒绝');
          onGone('register rejected');
          return;
        }
        gen.registered = true;
        reconnectDelay = reconnectBaseDelayMs;
        announceRegistered();

        // 心跳：预算 = interval 的 3/4（1s..30s）；在途不重叠；连续 2 次
        // 预算内无应答或被显式拒绝 → 终结当前代并重连。
        const interval = typeof result.heartbeatMs === 'number' && result.heartbeatMs > 0 ? result.heartbeatMs : 15_000;
        const budget = Math.min(Math.max(Math.floor((interval * 3) / 4), HEARTBEAT_BUDGET_MIN_MS), HEARTBEAT_BUDGET_MAX_MS);
        let inFlight = false;
        let misses = 0;
        gen.heartbeatTimer = setInterval(() => {
          if (closed || generation !== gen) return;
          if (inFlight) return; // 上一跳仍在预算窗口内：跳过本拍，不堆积
          inFlight = true;
          const outcome = withinBudget<HeartbeatOutcome>(
            (async () => {
              // 每跳捎带最新健康快照；采集失败仍发送心跳（不中断存活信号）。
              const beat = await collectNodeHealth(dataDir).catch(() => undefined);
              const alive = await hubRpc.heartbeat(identity.nodeId, beat !== undefined ? { health: beat } : undefined);
              return { kind: 'ack', alive: alive === true };
            })(),
            budget,
            { kind: 'timeout' },
          )
            .catch((): HeartbeatOutcome => ({ kind: 'ack', alive: false }))
            .finally(() => {
              inFlight = false;
            });
          void outcome.then((r) => {
            if (closed || generation !== gen) return;
            if (r.kind === 'timeout') {
              misses += 1;
              if (misses >= 2) {
                log('心跳连续超时，重连');
                onGone('heartbeat timeout');
              }
              return;
            }
            if (r.alive) {
              misses = 0;
              return;
            }
            log('心跳被拒（注册已失效），重连');
            onGone('heartbeat rejected');
          });
        }, interval);
      })().catch((error: unknown) => {
        if (closed || generation !== gen) return;
        log(`register 失败: ${error instanceof Error ? error.message : String(error)}`);
        onGone('register error');
      });
    });

    socket.on('close', () => onGone('closed'));
    socket.on('error', (err) => {
      log(`WS 错误: ${err instanceof Error ? err.message : String(err)}`);
      onGone('error');
    });
    socket.on('unexpected-response', (_req, res) => {
      log(`WS 拒绝: HTTP ${res.statusCode}`);
      try {
        res.resume(); // 释放底层请求/response，避免句柄泄漏
      } catch {
        // 忽略。
      }
      onGone('rejected');
    });
  };

  const connect = (): void => {
    if (closed) return;
    if (generation !== undefined) return; // 至多一个在途世代（防并行连接）
    startConnect();
  };

  // daemon 子进程 base 环境：HELM_HUB_URL 为该节点实际连接的 Hub（不引用
  // Hub 端本地 bin/dataDir）；PATH 前置受管 helm 客户端 bin 目录。
  let baseShellEnv: Record<string, string | undefined> = {
    HELM_HUB_URL: hubUrl,
    HELM_DATA_DIR: dataDir,
    ...(envServer.shellEnv ?? {}),
  };
  if ('dir' in cliBin) {
    baseShellEnv = prependPath(cliBin.dir, baseShellEnv);
  } else {
    log(`helm 客户端定位失败: ${cliBin.error}`);
    throw new Error(cliBin.error);
  }

  let closePromise: Promise<void> | undefined;
  const daemon: NodeDaemon = {
    identity,
    hubUrl,
    isConnected: () => generation?.registered === true && generation.socket.readyState === WebSocket.OPEN,
    waitUntilRegistered(timeoutMs = 10_000): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      // 已注册在线（心跳已启动）立即 true；仅连接中/未注册时等待下一次结果。
      if (generation?.registered === true && generation.socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiter = (ok: boolean): void => {
          clearTimeout(timer);
          registerWaiters.delete(waiter);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          registerWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        registerWaiters.add(waiter);
      });
    },
    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = (async () => {
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
          const gen = generation;
          if (gen) retireGeneration(gen);
          confirmOffline();
          const drained = await withinBudget(Promise.all([...settlingDisposes]).then(() => true), CLOSE_SETTLE_TIMEOUT_MS, false);
          if (!drained) throw new Error('节点连接资源清理超时，仍有在途资源未释放');
          if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, '节点连接资源清理失败');
        })();
      }
      return closePromise;
    },
  };

  connect();
  return daemon;
}

/** CLI 入口（helm-node connect）：前台运行直到 signal 中止。 */
export async function runNodeDaemon(
  input: NodeConnectInput,
  options: { signal?: AbortSignal; dataDir?: string; envServer?: NodeDaemonOptions['envServer'] } = {},
): Promise<void> {
  const dataDir = resolveNodeDataDir(options.dataDir);
  const identity = await resolveRunIdentity(dataDir, input);
  const daemon = await createNodeDaemon({
    hubUrl: input.hubUrl,
    identity,
    dataDir,
    envServer: options.envServer,
  });
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      options.signal?.removeEventListener('abort', stop);
      void daemon.close().then(resolve, reject);
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
  });
}

/** 面向集成/测试的句柄版：不接管信号，返回 daemon 供直接控制。 */
export async function runNodeDaemonHandle(
  input: NodeConnectInput,
  options: { signal?: AbortSignal; dataDir?: string } = {},
): Promise<NodeDaemon> {
  const dataDir = resolveNodeDataDir(options.dataDir);
  const identity = await resolveRunIdentity(dataDir, input);
  const daemon = await createNodeDaemon({ hubUrl: input.hubUrl, identity, dataDir });
  if (options.signal) {
    const signal = options.signal;
    const originalClose = daemon.close.bind(daemon);
    const stop = (): void => { void daemon.close().catch(() => console.error('[helm-node] signal 关闭资源失败')); };
    daemon.close = () => {
      signal.removeEventListener('abort', stop);
      return originalClose();
    };
    if (signal.aborted) await daemon.close();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return daemon;
}
