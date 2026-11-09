/**
 * CLI 层公共基座：输出注入点（NodeCliIo）、用法错误与 pid/日志路径小助手。
 * 纯机制、无命令业务；被入口 cli.ts 与各命令模块共用，保持领域文件之间零横向依赖。
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
  }) => Promise<{ pid: number; readyState: import('./control.js').DaemonReadyState; logPath: string }>;
  /** 存活探测（缺省 process.kill(pid, 0)）。 */
  isAlive?: (pid: number) => boolean;
  /** 就绪上报总超时（缺省 45s）：测试注入短时限。 */
  readyTimeoutMs?: number;
  /** launcher 跟踪轮询间隔（缺省 2s）：测试注入短间隔。 */
  launcherPollMs?: number;
  /** service install 入口覆盖（缺省解析编译产物 dist/cli.js）。 */
  serviceEntry?: string;
}

/** 用法/输入校验错误：code 随 JSON 错误信封输出（其余错误 internal_error）。 */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 'usage_error',
  ) {
    super(message);
  }
}

export const pidPath = (dataDir: string): string => path.join(dataDir, 'node.pid');
export const startLockPath = (dataDir: string): string => path.join(dataDir, 'node.start.lock');
export const logPathOf = (dataDir: string): string => path.join(dataDir, 'node.log');

export function isAliveOf(io: NodeCliIo): (pid: number) => boolean {
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

/** pid 留档内容：pid + 实例标识 + 控制端点（身份验证不依赖 /proc，跨平台一致）。 */
export interface PidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

/**
 * 读 pid 留档：仅 ENOENT 视为「无后台进程」返回 null；损坏/结构非法/IO 错误
 * 显式抛出，绝不把坏文件静默当作「未运行」。
 */
export async function readPidRecord(dataDir: string): Promise<PidRecord | null> {
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
export async function writePidRecord(dataDir: string, record: PidRecord): Promise<void> {
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

export async function removePidFile(dataDir: string): Promise<void> {
  try {
    await fsp.rm(pidPath(dataDir), { force: true });
  } catch (error) {
    throw new Error(`移除 pid 文件失败（${pidPath(dataDir)}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * CAS 删除 pid 留档：仅当文件内容仍指向 expected（pid+instanceId）时才删。
 * 升级/并发场景下 node.pid 可能已被新实例接管：绝不误删他人的留档。
 * expected 为 undefined（无原记录可校验）时不删，交由 stale 流程处理。
 */
export async function removePidFileIfMatch(dataDir: string, expected: PidRecord | undefined | null): Promise<boolean> {
  if (expected === null || expected === undefined) return false;
  const current = await readPidRecord(dataDir).catch(() => null);
  if (current === null || current.pid !== expected.pid || current.instanceId !== expected.instanceId) return false;
  await removePidFile(dataDir);
  return true;
}

/** 等待 pid 消失（进程真正退出）；超时返回 false。 */
export async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}
