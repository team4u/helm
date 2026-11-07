#!/usr/bin/env node
/**
 * helm-node CLI 入口。
 *
 * - runNodeCli(argv, io) 为唯一测试/嵌入入口；直接运行时（argv[1] 实路径
 *   等于本模块实路径，兼容 pnpm bin symlink）才自动执行。
 * - 命令：connect / start / stop / restart / status / service install|uninstall|status / --help。
 * - --json 全局生效：成功 stdout JSON，失败 stderr JSON 错误信封 + 非零退出码。
 * - 后台控制（跨平台，不依赖 /proc、不向任意 PID 发信号）：
 *   · 每次后台启动生成随机 instanceId；node.pid = { pid, instanceId, endpoint }
 *     （0600 原子写）。daemon 子进程自持控制 IPC（Unix: /tmp/helm-node-<hash>.sock；
 *     Windows: \\.\pipe\helm-node-<hash>），单行 JSON ≤4KiB、带空闲超时、验证
 *     instanceId，只接受 status/stop——绝不向无关进程发送信号或按键。
 *   · start -d 用 Node 原生 stdio IPC 上报就绪（helm-node.ready），子进程 argv
 *     只有 `start --data-dir <dir> [--hub <url>]`，无 token；token 一律从 0600
 *     node.json 读取。instanceId/endpoint 经 HELM_NODE_INSTANCE_ID /
 *     HELM_NODE_CONTROL_ENDPOINT 环境变量传递（本机实例控制信息，不进日志）。
 *   · stop 仅对通过 instanceId 验证的控制端点发 stop：daemon 先完成执行环境
 *     清理（handle.close）再确认退出，之后才删 pid 文件；控制通道不可达且
 *     pid 存活时显式失败并保留 pid 文件；pid 确已死亡才按 stale 清理。
 * - start -d 以 node.start.lock（O_CREAT|O_EXCL）防并发启动，持锁到 pid 留档
 *   完成；残留锁显式诊断，不静默删除。
 * - 前台 connect/start 注册前只输出「连接中」；state=registered 只来自真实
 *   daemon 注册 ACK，未完成为 starting；控制 server 仅供后台实例启动。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/** 注入点：测试以内存 writer 与 spawn 替身替换真实进程 IO。 */
export interface NodeCliIo {
  env?: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** 后台启动器（缺省真实 detached spawn + stdio IPC 就绪上报）。 */
  spawnDaemon?: (options: {
    nodePath: string;
    args: readonly string[];
    execArgv: readonly string[];
    dataDir: string;
    env: NodeJS.ProcessEnv;
    /** 本实例控制标识（经 env 传给子进程；绝不进 argv/日志）。 */
    instanceId: string;
    /** 控制端点（UDS 路径或 Windows pipe 名）。 */
    endpoint: string;
    /** 就绪上报总超时（缺省 45s）。 */
    readyTimeoutMs?: number;
  }) => Promise<{ pid: number; readyState: DaemonReadyState; logPath: string }>;
  /** 存活探测（缺省 process.kill(pid, 0)）。 */
  isAlive?: (pid: number) => boolean;
  /** 就绪上报总超时（缺省 45s）：测试注入短时限。 */
  readyTimeoutMs?: number;
  /** service install 入口覆盖（缺省解析编译产物 dist/cli.js）。 */
  serviceEntry?: string;
}

/** 后台守护进程就绪状态：registered=已完成 Hub 注册；starting=进程存活持续重连（可诊断）。 */
export type DaemonReadyState = 'registered' | 'starting';

const USAGE = `helm-node — helm 跨平台受控节点守护进程

用法: helm-node <command> [options]

命令:
  connect <hubUrl> --token <token>   绑定 JOIN 令牌并前台运行（--once 仅尝试注册一次）
  start [-d|--daemon]                启动守护进程（-d 后台 detached，写 <dataDir>/node.pid）
  stop                               停止后台守护进程（经控制通道验证身份后优雅停止）
  restart                            重启后台守护进程（先确认停止成功再拉新进程）
  status                             输出身份绑定状态、后台进程与运行态摘要
  service install|uninstall|status   开机自启服务管理（launchd / systemd --user / schtasks）

通用选项:
  --token <token>        JOIN 令牌（nodeId:secret）
  --hub <url>            Hub 地址
  --data-dir <dir>       数据目录（默认 $HELM_DATA_DIR 或 ~/.helm）
  --json                 机器可读 JSON 输出
  --once                 connect 模式下仅尝试注册一次即退出
  --help, -h             显示帮助

环境变量: HELM_DATA_DIR（默认 ~/.helm）· HELM_HUB_URL · HERDR_SOCKET_PATH
`;

interface ParsedCli {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
  help: boolean;
}

const VALUE_FLAGS = ['token', 'hub', 'data-dir'] as const;
const BOOL_FLAGS = ['once', 'help', 'daemon', 'd'] as const;
/** 各命令合法的选项集合；未知选项/多余位置参数一律显式报错。 */
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  connect: new Set(['token', 'hub', 'data-dir', 'json', 'once']),
  start: new Set(['token', 'hub', 'data-dir', 'json', 'daemon', 'd']),
  stop: new Set(['data-dir', 'json']),
  restart: new Set(['hub', 'data-dir', 'json']),
  status: new Set(['data-dir', 'json']),
  service: new Set(['hub', 'data-dir', 'json']),
};
/** 各命令位置参数个数（connect 可带 hubUrl；service 恰一个子命令；其余 0）。 */
const COMMAND_POSITIONALS: Record<string, { min: number; max: number }> = {
  connect: { min: 1, max: 1 },
  start: { min: 0, max: 0 },
  stop: { min: 0, max: 0 },
  restart: { min: 0, max: 0 },
  status: { min: 0, max: 0 },
  service: { min: 1, max: 1 },
};

class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 'usage_error',
  ) {
    super(message);
  }
}

function parseCli(argv: readonly string[]): ParsedCli {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let json = false;
  let help = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      i += 1;
      continue;
    }
    if (token === '-d') {
      flags.set('daemon', true);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        let raw = eq === -1 ? undefined : token.slice(eq + 1);
        if (raw === undefined || raw === '') {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            throw new UsageError(`--${name} 缺少取值`);
          }
          raw = next;
          i += 1;
        }
        flags.set(name, raw);
      } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`未知选项 --${name}（helm-node --help 查看用法）`);
      }
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`未知选项 ${token}（helm-node --help 查看用法）`);
    }
    positional.push(token);
    i += 1;
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags, json, help };
}

/** 解析后校验：未知命令、多余位置参数、不属于该命令的选项都显式报错。 */
function validateCli(parsed: ParsedCli): void {
  if (parsed.help) return;
  if (parsed.command === '') {
    throw new UsageError('缺少命令（helm-node --help 查看用法）');
  }
  const allowed = COMMAND_FLAGS[parsed.command];
  if (allowed === undefined) {
    throw new UsageError(`未知命令：helm-node ${parsed.command}（helm-node --help 查看用法）`, 'unknown_command');
  }
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`命令 ${parsed.command} 不支持 --${name}（helm-node --help 查看用法）`);
    }
  }
  const range = COMMAND_POSITIONALS[parsed.command]!;
  if (parsed.positional.length < range.min || parsed.positional.length > range.max) {
    throw new UsageError(
      `命令 ${parsed.command} 需要 ${range.min === range.max ? String(range.min) : `${range.min}-${range.max}`} 个位置参数，实得 ${parsed.positional.length}（helm-node --help 查看用法）`,
    );
  }
  if (parsed.command === 'service') {
    const action = parsed.positional[0];
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      throw new UsageError(`service 需要 install|uninstall|status 子命令，实得 ${JSON.stringify(action ?? '(空)')}`);
    }
  }
}

const flagString = (parsed: ParsedCli, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const pidPath = (dataDir: string): string => path.join(dataDir, 'node.pid');
const startLockPath = (dataDir: string): string => path.join(dataDir, 'node.start.lock');
const logPathOf = (dataDir: string): string => path.join(dataDir, 'node.log');

// ---------------------------------------------------------------------------
// 控制通道：endpoint 命名 + pid 留档 + 客户端请求 + daemon 侧 server
// ---------------------------------------------------------------------------

/** 就绪上报总预算。 */
const READY_TIMEOUT_MS = 45_000;
/** 控制通道连接/响应/空闲预算（status 查询、stop 请求的通道层上限）。 */
const CONTROL_TIMEOUT_MS = 5_000;
/** stop 请求总预算：daemon 需先完成 handle.close 执行环境清理再应答。 */
const CONTROL_STOP_TIMEOUT_MS = 15_000;
/** 控制协议单行上限（字节）。 */
const CONTROL_MAX_LINE_BYTES = 4_096;
/** stop 被接受后等待进程真实退出的上限。 */
const STOP_EXIT_TIMEOUT_MS = 10_000;

/**
 * 控制端点：sha256(dataDir + instanceId) 短 hash 命名，避免路径超长与碰撞。
 * Unix: /tmp/helm-node-<hash>.sock；Windows: \\.\pipe\helm-node-<hash>。
 */
function controlEndpoint(dataDir: string, instanceId: string): string {
  const hash = createHash('sha256').update(`${dataDir}\0${instanceId}`).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\helm-node-${hash}` : `/tmp/helm-node-${hash}.sock`;
}

/** pid 留档内容：pid + 实例标识 + 控制端点（身份验证不依赖 /proc，跨平台一致）。 */
interface PidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

/**
 * 读 pid 留档：仅 ENOENT 视为「无后台进程」返回 null；损坏/结构非法/IO 错误
 * 显式抛出，绝不把坏文件静默当作「未运行」。
 */
async function readPidRecord(dataDir: string): Promise<PidRecord | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(pidPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`读取 pid 文件失败（${pidPath(dataDir)}）：${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `pid 文件损坏（${pidPath(dataDir)}）：${error instanceof Error ? error.message : String(error)}；请人工确认无残留进程后删除该文件`,
    );
  }
  const record = parsed as Partial<PidRecord>;
  if (
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.instanceId !== 'string' ||
    record.instanceId === '' ||
    typeof record.endpoint !== 'string' ||
    record.endpoint === ''
  ) {
    throw new Error(
      `pid 文件内容非法（${pidPath(dataDir)}）：期望 { pid, instanceId, endpoint }；请人工确认无残留进程后删除该文件`,
    );
  }
  return { pid: record.pid, instanceId: record.instanceId, endpoint: record.endpoint };
}

/** 原子写 pid 留档（同目录临时文件 + rename；0600，非 Windows chmod 失败显式抛出）。 */
async function writePidRecord(dataDir: string, record: PidRecord): Promise<void> {
  await fsp.mkdir(dataDir, { recursive: true });
  const target = pidPath(dataDir);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temp, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o600);
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw new Error(`写入 pid 文件失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removePidFile(dataDir: string): Promise<void> {
  try {
    await fsp.rm(pidPath(dataDir), { force: true });
  } catch (error) {
    throw new Error(`移除 pid 文件失败（${pidPath(dataDir)}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function isAliveOf(io: NodeCliIo): (pid: number) => boolean {
  return (
    io.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
  );
}

/** 等待 pid 消失（进程真正退出）；超时返回 false。 */
async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

/** 控制通道响应：ok=true 时含真实 pid/instanceId/state；ok=false 时含 error。 */
interface ControlResponse {
  ok: boolean;
  pid?: number;
  instanceId?: string;
  state?: DaemonReadyState | 'stopping';
  error?: string;
}

/**
 * 控制通道客户端：单连接单请求（一行 JSON 请求、一行 JSON 响应）。
 * 连接失败/超时/响应非法一律返回 null（调用方区分「不可达」与「被拒绝」）。
 */
async function controlRequest(
  endpoint: string,
  request: { type: 'status' | 'stop'; instanceId: string },
  timeoutMs: number = CONTROL_TIMEOUT_MS,
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
        finish(parsed);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
  });
}

/** daemon 侧控制 server：只接受 status/stop；instanceId 不匹配一律拒绝且不影响进程。 */
interface ControlServer {
  listening: Promise<void>;
  close(): Promise<void>;
}

function createControlServer(options: {
  endpoint: string;
  instanceId: string;
  onStatus: () => { pid: number; state: DaemonReadyState };
  onStop: () => Promise<void>;
}): ControlServer {
  const { endpoint, instanceId, onStatus, onStop } = options;
  const sockets = new Set<net.Socket>();
  let stopping = false;
  let closed = false;
  /** stop 处理链（含应答冲刷与自清理）：close() 必须先等它完成，防应答被销毁。 */
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
      // close 回调在 server 未监听/已关时可能不同步返回：兜底立即 resolve。
      if (!server.listening) resolve();
    });
    if (socketFile !== undefined) await fsp.rm(socketFile, { force: true }).catch(() => undefined);
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
    /** 同 reply，但等待数据真正冲刷（stop 路径销毁 socket 前必须保证应答可达）。 */
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
      let request: { type?: unknown; instanceId?: unknown };
      try {
        request = JSON.parse(line) as { type?: unknown; instanceId?: unknown };
      } catch {
        reply({ ok: false, error: 'bad_request' });
        return;
      }
      // 身份门槛：instanceId 不一致一律拒绝（绝不触发停止，防误杀无关实例）。
      if (request === null || typeof request !== 'object' || request.instanceId !== instanceId) {
        reply({ ok: false, error: 'instance_mismatch' });
        return;
      }
      if (request.type === 'status') {
        const snapshot = onStatus();
        reply({ ok: true, pid: snapshot.pid, instanceId, state: snapshot.state });
        return;
      }
      if (request.type === 'stop') {
        if (stopping) {
          reply({ ok: false, error: 'stopping' });
          return;
        }
        stopping = true;
        server.close(() => undefined); // 立即停止接受新连接；存量连接由本分支应答
        stopChain = (async () => {
          try {
            await onStop();
            // 等应答真正冲刷到对端后再关 server（destroy 会丢弃未冲刷缓冲）。
            await replyAndWait({ ok: true, pid: process.pid, instanceId, state: 'stopping' });
          } catch (error) {
            await replyAndWait({
              ok: false,
              error: `stop 清理失败：${error instanceof Error ? error.message : String(error)}`,
            }).catch(() => undefined);
          }
          await closeSelf();
        })();
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
      // 先等在途 stop 链（含应答冲刷）完成，再硬清理——否则应答会被销毁丢失。
      if (stopChain !== undefined) await stopChain.catch(() => undefined);
      await closeSelf();
    },
  };
}

// ---------------------------------------------------------------------------
// 后台启动：start 锁 + detached spawn（stdio IPC 就绪上报）
// ---------------------------------------------------------------------------

/** 后台子进程就绪上报协议（Node 原生 stdio IPC）：{ type:'helm-node.ready', pid, instanceId, state }。 */
function parseReadyMessage(message: unknown, instanceId: string): DaemonReadyState | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helm-node.ready' || record['instanceId'] !== instanceId) return null;
  return record['state'] === 'registered' ? 'registered' : 'starting';
}

/**
 * 后台启动默认实现（导出供测试复用）：
 * 1. 打开 node.log（失败显式报错，绝不带坏 fd 启动）；
 * 2. detached spawn：stdio = ['ignore', logFd, logFd, 'ipc']——就绪经 Node 原生
 *    IPC channel 上报，跨平台无需握手 socket；argv 无 token；instanceId/endpoint
 *    经环境变量传递；
 * 3. ready / spawn error / 子进程退出三方竞速，外加总超时；
 * 4. 任一结局后立即清理父侧 fd/IPC channel/timer/listener，不留孤儿句柄。
 */
export async function defaultSpawnDaemon(options: {
  nodePath: string;
  args: readonly string[];
  execArgv: readonly string[];
  dataDir: string;
  env: NodeJS.ProcessEnv;
  instanceId: string;
  endpoint: string;
  readyTimeoutMs?: number;
}): Promise<{ pid: number; readyState: DaemonReadyState; logPath: string }> {
  const { nodePath, args, execArgv, dataDir, env, instanceId } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  await fsp.mkdir(dataDir, { recursive: true });
  const logFile = logPathOf(dataDir);

  let logHandle: fsp.FileHandle;
  try {
    logHandle = await fsp.open(logFile, 'a');
  } catch (error) {
    throw new Error(`打开日志文件失败（${logFile}）：${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    // instanceId/endpoint 已在 env 中（startDaemon 注入）：不再重复拼装。
    const childEnv = { ...env }
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'HELM_TOKEN') delete childEnv[key]
    child = spawn(nodePath, [...execArgv, ...args], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`后台进程 spawn 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  type Outcome =
    | { kind: 'ready'; state: DaemonReadyState }
    | { kind: 'error'; error: Error }
    | { kind: 'exit'; code: number | null }
    | { kind: 'timeout' };
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const finish = (value: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(value);
    };
    const onMessage = (message: unknown): void => {
      const state = parseReadyMessage(message, instanceId);
      if (state !== null) finish({ kind: 'ready', state });
    };
    const onError = (error: Error): void => finish({ kind: 'error', error });
    const onExit = (code: number | null): void => finish({ kind: 'exit', code });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), readyTimeoutMs);
    timer.unref?.();
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });

  const detachChannel = (): void => {
    try {
      if (child.connected) child.disconnect();
    } catch {
      // 已断开。
    }
  };

  if (outcome.kind === 'ready') {
    detachChannel();
    child.unref();
    await logHandle.close().catch(() => undefined);
    if (child.pid === undefined) {
      throw new Error('后台进程就绪上报后 pid 不可用（内部错误）');
    }
    return { pid: child.pid, readyState: outcome.state, logPath: logFile };
  }

  // 失败路径：停止本次持有的 ChildProcess（自有子进程），保留诊断日志。
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出。
  }
  detachChannel();
  child.unref();
  await logHandle.close().catch(() => undefined);
  const reason =
    outcome.kind === 'error'
      ? `后台进程启动失败（spawn error）：${outcome.error.message}`
      : outcome.kind === 'exit'
        ? `后台进程启动后立即退出（code=${outcome.code ?? 'null'}）`
        : `后台进程 ${readyTimeoutMs}ms 内未上报就绪（helm-node.ready）`;
  const tail = await readLogTail(logFile, 40);
  throw new Error(`${reason}${tail !== '' ? `\n--- ${logFile} 最后 40 行 ---\n${tail}` : ''}`);
}

/**
 * start 并发锁（O_CREAT|O_EXCL）：持锁覆盖「已有实例验证 → spawn → pid 留档」
 * 全程；所有分支释放；残留锁显式诊断（不静默删——可能是另一 start 在途）。
 */
async function withStartLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = startLockPath(dataDir);
  await fsp.mkdir(dataDir, { recursive: true });
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `并发启动冲突：${lockPath} 已存在（另一 helm-node start 正在进行，或上次启动异常退出残留）；确认无并发启动后删除该文件重试`,
      );
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.unlink(lockPath).catch(() => undefined);
  }
}

async function readLogTail(logFile: string, maxLines: number): Promise<string> {
  try {
    const text = await fsp.readFile(logFile, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** 后台子进程与父进程同源 tsx 编译环境所需的 execArgv（--require/--import loader 等）。 */
function inheritExecArgv(): string[] {
  return process.execArgv.filter((arg) => !/^-{1,2}(inspect|debug|cpu-prof|heap-prof)(-brk)?(-[a-z-]+)?(=.*)?$/.test(arg));
}

function cliSelfEntry(): string {
  return path.resolve(fileURLToPath(import.meta.url));
}

/**
 * service install 入口：开机服务无 tsx loader，必须使用编译产物 dist/cli.js。
 * - 以编译产物运行：返回自身；
 * - 以源码入口运行：返回同包 dist/cli.js（须已存在）；
 * - 源码运行且无编译产物：显式报错（不生成无法启动的服务）。
 */
export function resolveServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath);
  if (self.endsWith(path.join('dist', 'cli.js'))) return self;
  const distEntry = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
  try {
    return realpathSync(distEntry);
  } catch {
    throw new UsageError(
      `服务入口必须使用编译产物（期望 ${distEntry}）：当前以源码入口运行且未找到编译产物；请先在仓库根执行 pnpm build 再安装服务`,
      'missing_build',
    );
  }
}

/** 读身份；缺失显式报错（后台/前台启动共用）。 */
async function readNodeIdentityStrict(dataDir: string): Promise<{ nodeId: string; token: string; hubUrl?: string }> {
  const { readNodeIdentity } = await import('./daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) {
    throw new UsageError(
      `未找到节点身份（${path.join(dataDir, 'node.json')}）。请先 helm-node connect <hubUrl> --token <token> 绑定`,
      'missing_identity',
    );
  }
  return identity;
}

/**
 * 后台启动入口：持 start 锁完成「已有实例验证 → spawn + 就绪确认 → pid 留档」。
 * 已有 pid 先走控制通道验证：活的真守护进程拒绝重复启动；pid 存活但通道不可达
 * （无法证实可安全覆盖）同样拒绝；确已死亡才清理 pid 继续启动。
 */
async function startDaemon(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
): Promise<{ pid: number; logPath: string; nodeId: string; readyState: DaemonReadyState }> {
  const identity = await readNodeIdentityStrict(dataDir);
  const isAlive = isAliveOf(io);
  return await withStartLock(dataDir, async () => {
    const existing = await readPidRecord(dataDir);
    if (existing !== null) {
      const response = await controlRequest(existing.endpoint, { type: 'status', instanceId: existing.instanceId });
      if (response !== null && response.ok === true) {
        throw new UsageError(
          `守护进程已在运行（pid ${response.pid}，state ${response.state ?? 'unknown'}，pid 文件 ${pidPath(dataDir)}）；拒绝重复启动，如需重启请用 helm-node restart`,
          'already_running',
        );
      }
      if (isAlive(existing.pid)) {
        throw new UsageError(
          `pid ${existing.pid} 存活但控制通道不可达（endpoint ${existing.endpoint}）：无法证实可安全覆盖，拒绝启动；请先 helm-node stop，或人工确认进程身份后删除 ${pidPath(dataDir)}`,
          'control_unreachable',
        );
      }
      // pid 确已死亡：留档过期，清理后继续。
      await removePidFile(dataDir);
    }
    const instanceId = randomBytes(16).toString('hex');
    const endpoint = controlEndpoint(dataDir, instanceId);
    const spawnDaemon = io.spawnDaemon ?? defaultSpawnDaemon;
    const args = [cliSelfEntry(), 'start', '--data-dir', dataDir];
    if (effectiveHub !== '') args.push('--hub', effectiveHub);
    const { pid, readyState, logPath } = await spawnDaemon({
      nodePath: process.execPath,
      args,
      execArgv: inheritExecArgv(),
      dataDir,
      // 控制标识经 env 传递（spawnDaemon 收到的 env 即子进程完整 env）。
      env: {
        ...process.env,
        ...(io.env ?? {}),
        HELM_NODE_INSTANCE_ID: instanceId,
        HELM_NODE_CONTROL_ENDPOINT: endpoint,
      },
      instanceId,
      endpoint,
      ...(io.readyTimeoutMs !== undefined ? { readyTimeoutMs: io.readyTimeoutMs } : {}),
    });
    try {
      await writePidRecord(dataDir, { pid, instanceId, endpoint });
    } catch (error) {
      const stopped = await controlRequest(endpoint, { type: 'stop', instanceId }, CONTROL_STOP_TIMEOUT_MS)
      if (!stopped?.ok || !(await waitForExit(pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
        throw new AggregateError([error], `PID 留档失败且后台进程 ${pid} 无法确认停止，需人工诊断`)
      }
      throw error
    }
    return { pid, logPath, nodeId: identity.nodeId, readyState };
  });
}

/** 查询后台实例状态：控制通道 OK → 真实运行态；通道不可达 → pid 存活则 unknown，否则 stale。 */
async function statusDaemon(io: NodeCliIo, dataDir: string): Promise<{
  pid: number | null;
  pidAlive: boolean;
  state?: DaemonReadyState | 'unknown';
  pidStale?: boolean;
  detail?: string;
}> {
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) return { pid: null, pidAlive: false };
  const response = await controlRequest(record.endpoint, { type: 'status', instanceId: record.instanceId });
  if (response !== null && response.ok === true) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: response.state === 'registered' ? 'registered' : 'starting',
    };
  }
  if (isAlive(record.pid)) {
    return {
      pid: record.pid,
      pidAlive: true,
      state: 'unknown',
      detail: `控制通道不可达（endpoint ${record.endpoint}）：pid 存活但无法确认守护进程运行状态`,
    };
  }
  return { pid: record.pid, pidAlive: false, pidStale: true, detail: 'pid 文件残留（进程已退出）待清理' };
}

/**
 * 停止后台守护进程：仅对通过 instanceId 验证的控制端点发 stop（绝不向任意 PID
 * 发信号/按键）。stop 被接受后等进程真实退出才删 pid 文件；通道不可达但 pid
 * 存活 → 显式失败并保留 pid；pid 确已死亡 → 按 stale 清理。
 */
async function stopDaemon(io: NodeCliIo, dataDir: string): Promise<{ outcome: 'stopped' | 'stale'; pid: number }> {
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(`未找到 pid 文件（${pidPath(dataDir)}）：后台守护进程未在运行`, 'not_running');
  }
  const response = await controlRequest(record.endpoint, { type: 'stop', instanceId: record.instanceId }, CONTROL_STOP_TIMEOUT_MS);
  if (response === null || response.ok !== true) {
    const reason =
      response === null
        ? `控制通道不可达（endpoint ${record.endpoint}）`
        : `控制端点拒绝停止（${response.error ?? 'unknown'}，endpoint ${record.endpoint}）`;
    if (isAlive(record.pid)) {
      throw new Error(
        `${reason}，且 pid ${record.pid} 仍存活：拒绝向未经身份验证的进程发送信号；pid 文件已保留（${pidPath(dataDir)}）供诊断`,
      );
    }
    await removePidFile(dataDir);
    return { outcome: 'stale', pid: record.pid };
  }
  // stop 已被接受且完成了执行环境清理：等进程真实退出后才删 pid 文件。
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
    throw new Error(
      `stop 已被接受但 pid ${record.pid} 在 ${STOP_EXIT_TIMEOUT_MS}ms 内未退出：保留 pid 文件（${pidPath(dataDir)}）供诊断`,
    );
  }
  await removePidFile(dataDir);
  return { outcome: 'stopped', pid: record.pid };
}

async function resolveHubUrl(io: NodeCliIo, parsed: ParsedCli, requireUrl: boolean): Promise<string> {
  const explicit = flagString(parsed, 'hub');
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = io.env?.['HELM_HUB_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (requireUrl) {
    throw new UsageError('缺少 Hub 地址：请提供位置参数 <hubUrl>、--hub <url> 或环境变量 HELM_HUB_URL', 'missing_hub_url');
  }
  return '';
}

/** 前台信号接管：返回卸载函数（try/finally 保证监听器清理）。 */
function forwardSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

/**
 * 守护进程运行主体（前台 connect/start 与受控后台共用）：
 * - 注册前只输出「连接中」；registered 只来自真实 daemon 注册 ACK，未完成为 starting；
 * - 受控模式（control）：先监听控制 server（daemon 未就绪也能应答 status/拒绝伪造
 *   stop），daemon 注册结果落定后经 stdio IPC 上报 ready 并 disconnect；stop 请求
 *   → abort → handle.close()（等待执行环境清理）→ 应答 → 关 server 与 socket；
 * - 退出路径 finally 清理全部资源（handle、控制 server、信号监听器）。
 */
async function runDaemonProcess(options: {
  io: NodeCliIo;
  parsed: ParsedCli;
  dataDir: string;
  hubUrl: string;
  token: string;
  nodeId: string;
  control?: { instanceId: string; endpoint: string };
}): Promise<number> {
  const { io, parsed, dataDir, hubUrl, token, nodeId, control } = options;
  const { runNodeDaemonHandle } = await import('./daemon/index.js');
  type Handle = Awaited<ReturnType<typeof runNodeDaemonHandle>>;
  const controller = new AbortController();
  const detachSignals = forwardSignals(controller);
  let handle: Handle | undefined;
  let stopFailure: string | undefined;

  let controlServer: ControlServer | undefined;
  if (control !== undefined) {
    controlServer = createControlServer({
      endpoint: control.endpoint,
      instanceId: control.instanceId,
      onStatus: () => ({
        pid: process.pid,
        state: handle !== undefined && handle.isConnected() ? 'registered' : 'starting',
      }),
      onStop: async () => {
        controller.abort();
        if (handle !== undefined) await handle.close();
      },
    });
    try {
      await controlServer.listening;
    } catch (error) {
      detachSignals();
      throw new Error(
        `控制通道监听失败（${control.endpoint}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!parsed.json && control === undefined) {
    io.out(`helm-node 连接中 ${hubUrl}（nodeId=${nodeId}）；注册完成后开始工作，Ctrl+C 退出\n`);
  }
  try {
    handle = await runNodeDaemonHandle({ hubUrl, token }, { dataDir });
    const registered = await handle.waitUntilRegistered(10_000);
    if (control !== undefined) {
      // 就绪上报：父进程据此写 pid 留档；父已退出时忽略（守护进程继续存活重连）。
      if (process.send !== undefined) {
        try {
          process.send({
            type: 'helm-node.ready',
            pid: process.pid,
            instanceId: control.instanceId,
            state: registered ? 'registered' : 'starting',
          } satisfies { type: 'helm-node.ready'; pid: number; instanceId: string; state: DaemonReadyState });
        } catch {
          // 父侧 channel 已关闭。
        }
        try {
          if (process.connected) process.disconnect();
        } catch {
          // 已断开。
        }
      }
    } else if (!parsed.json) {
      io.out(
        registered
          ? `已注册并开始工作（${hubUrl}）\n`
          : '尚未完成注册（Hub 暂不可达时守护进程将持续退避重连），诊断见 stderr 日志\n',
      );
    }
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        stopFailure = error instanceof Error ? error.message : String(error);
      }
    }
    await controlServer?.close();
    detachSignals();
  }
  return stopFailure === undefined ? 0 : 1;
}

export async function runNodeCli(argv: readonly string[] = [], ioInput: Partial<NodeCliIo> = {}): Promise<number> {
  const io: NodeCliIo = {
    env: ioInput.env ?? process.env,
    out: ioInput.out ?? ((text) => process.stdout.write(text)),
    err: ioInput.err ?? ((text) => process.stderr.write(text)),
    spawnDaemon: ioInput.spawnDaemon,
    isAlive: ioInput.isAlive,
    ...(ioInput.readyTimeoutMs !== undefined ? { readyTimeoutMs: ioInput.readyTimeoutMs } : {}),
    ...(ioInput.serviceEntry !== undefined ? { serviceEntry: ioInput.serviceEntry } : {}),
  };
  const emit = (value: unknown): void => {
    io.out(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
    validateCli(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'usage_error';
    if (argv.includes('--json')) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  }

  const emitError = (message: string, code: string): number => {
    if (parsed.json) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  };

  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }

  const { bindIdentityFromJoinToken, resolveNodeDataDir, readNodeIdentity, runNodeDaemonHandle } = await import(
    './daemon/index.js'
  );
  const { installNodeService, uninstallNodeService, getNodeServiceStatus } = await import('./daemon/service.js');
  const dataDir = resolveNodeDataDir(flagString(parsed, 'data-dir') ?? io.env?.['HELM_DATA_DIR']);

  try {
    switch (parsed.command) {
      case 'connect': {
        const hubUrl = parsed.positional[0] !== undefined && /^https?:\/\//.test(parsed.positional[0]!)
          ? parsed.positional[0]!
          : await resolveHubUrl(io, parsed, true);
        const token = flagString(parsed, 'token');
        if (token === undefined) throw new UsageError('connect 需要 --token <token>（JOIN 令牌 nodeId:secret）', 'missing_token');
        await bindIdentityFromJoinToken(dataDir, token, hubUrl);
        const identity = await readNodeIdentity(dataDir);
        if (identity === null) throw new Error('身份写入后读取失败（内部错误）');
        if (parsed.flags.get('once') === true) {
          const handle = await runNodeDaemonHandle({ hubUrl, token }, { dataDir });
          const ok = await handle.waitUntilRegistered(15_000);
          await handle.close();
          emit({ ok, nodeId: identity.nodeId, hubUrl, dataDir, registered: ok });
          return ok ? 0 : 1;
        }
        return await runDaemonProcess({ io, parsed, dataDir, hubUrl, token, nodeId: identity.nodeId });
      }
      case 'start': {
        const detached = parsed.flags.get('daemon') === true || parsed.flags.get('d') === true;
        const hubUrl = await resolveHubUrl(io, parsed, false);
        const token = flagString(parsed, 'token');
        if (detached) {
          if (token !== undefined) {
            // 空地址由 bindIdentityFromJoinToken 显式拒绝（不编造回退 Hub）。
            await bindIdentityFromJoinToken(dataDir, token, hubUrl);
          }
          const identity = await readNodeIdentityStrict(dataDir);
          const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
          if (effectiveHub === '') throw new UsageError('后台启动需要 Hub 地址（--hub 或既绑定的 hubUrl）', 'missing_hub_url');
          const { pid, logPath, nodeId, readyState } = await startDaemon(io, dataDir, effectiveHub);
          const message =
            readyState === 'registered'
              ? `守护进程已启动并完成 Hub 注册（pid ${pid}）`
              : `守护进程已启动（pid ${pid}），尚未完成 Hub 注册：Hub 暂不可达时将持续退避重连，诊断见 ${logPath}`;
          emit({ ok: true, pid, dataDir, hubUrl: effectiveHub, nodeId, logPath, state: readyState, message });
          return 0;
        }
        // 前台 start：等价 connect（token 可选：缺省用既有身份；均缺才报错）。
        // 受控后台：由 start -d 父进程注入 HELM_NODE_INSTANCE_ID / HELM_NODE_CONTROL_ENDPOINT。
        const instanceId = io.env?.['HELM_NODE_INSTANCE_ID'];
        const endpoint = io.env?.['HELM_NODE_CONTROL_ENDPOINT'];
        const identity = await readNodeIdentity(dataDir);
        const effectiveToken = token ?? identity?.token;
        const effectiveHub = hubUrl !== '' ? hubUrl : identity?.hubUrl ?? '';
        if (effectiveToken === undefined || effectiveHub === '') {
          throw new UsageError(
            'start 前台运行需要既绑定的身份或 --token + --hub；或使用 start -d 后台启动',
            'missing_identity',
          );
        }
        return await runDaemonProcess({
          io,
          parsed,
          dataDir,
          hubUrl: effectiveHub,
          token: effectiveToken,
          nodeId: identity?.nodeId ?? '?',
          ...(instanceId !== undefined && instanceId !== '' && endpoint !== undefined && endpoint !== ''
            ? { control: { instanceId, endpoint } }
            : {}),
        });
      }
      case 'stop': {
        const stopped = await stopDaemon(io, dataDir);
        emit({ ok: true, stopped: true, outcome: stopped.outcome, pid: stopped.pid, dataDir });
        return 0;
      }
      case 'restart': {
        const hubUrl = await resolveHubUrl(io, parsed, false);
        const identity = await readNodeIdentityStrict(dataDir);
        const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
        if (effectiveHub === '') throw new UsageError('restart 需要既绑定身份（helm-node connect）；未找到', 'missing_identity');
        const previous = await readPidRecord(dataDir);
        let previousPid: number | null = null;
        if (previous !== null) {
          previousPid = previous.pid;
          // stopDaemon 停止失败会抛错：绝不带着旧进程继续拉新进程。
          await stopDaemon(io, dataDir);
        }
        const { pid, logPath, nodeId, readyState } = await startDaemon(io, dataDir, effectiveHub);
        emit({
          ok: true,
          pid,
          dataDir,
          hubUrl: effectiveHub,
          nodeId,
          logPath,
          state: readyState,
          ...(previousPid !== null ? { previousPid } : {}),
        });
        return 0;
      }
      case 'status': {
        const identity = await readNodeIdentity(dataDir);
        const daemon = await statusDaemon(io, dataDir);
        emit({
          bound: identity !== null,
          ...(identity !== null ? { nodeId: identity.nodeId, hubUrl: identity.hubUrl ?? null } : {}),
          dataDir,
          pid: daemon.pid,
          pidAlive: daemon.pidAlive,
          ...(daemon.state !== undefined ? { state: daemon.state } : {}),
          ...(daemon.pidStale === true ? { pidStale: true } : {}),
          ...(daemon.detail !== undefined ? { detail: daemon.detail } : {}),
        });
        return 0;
      }
      case 'service': {
        const action = parsed.positional[0];
        const cliEntryPath = io.serviceEntry ?? resolveServiceEntry();
        if (action === 'install') {
          const hubUrl = await resolveHubUrl(io, parsed, false);
          const result = await installNodeService(cliEntryPath, dataDir, {
            ...(hubUrl !== '' ? { hubUrl } : {}),
          });
          emit(result);
          return result.ok ? 0 : 1;
        }
        if (action === 'uninstall') {
          const result = await uninstallNodeService(cliEntryPath, dataDir);
          emit(result);
          return result.ok ? 0 : 1;
        }
        const status = await getNodeServiceStatus(cliEntryPath, dataDir);
        emit(status);
        return 0;
      }
      default:
        throw new UsageError(`未知命令：helm-node ${parsed.command}（helm-node --help 查看用法）`, 'unknown_command');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? error.code : 'internal_error';
    return emitError(message, code);
  }
}

/** 直接运行判定：argv[1] 实路径 === 本模块实路径（兼容 pnpm .bin symlink 调用）。 */
export function isDirectRun(entryArgv = process.argv[1]): boolean {
  if (entryArgv === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(entryArgv));
    return self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runNodeCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
