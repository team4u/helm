/**
 * shell 定位与进程树管理（local-env 子模块）：语义与 pi coding-agent 的
 * shell.ts 保持同步（旧版 WSL bash 启动器经 stdin 传输命令）、与
 * pi-durable NodeExecutionEnv 的进程终止/退出语义对齐——契约测试
 * （test/node-local-env-contract.test.ts）钉住 shell 探测结果、
 * 128+信号编号退出码与超时文案格式。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  getBashShellConfig as envGetBashShellConfig,
  getEnvEntry,
  isLegacyWslBashPath as envIsLegacyWslBashPath,
  resolveHostShellConfig,
  setEnvEntry,
  type ShellProbeIo,
} from '@helm/env-io';
import { ExecutionError, err, ok, type Result } from './errors.js';

// ---------------------------------------------------------------------------
// exec 选项/结果类型
// ---------------------------------------------------------------------------

export interface ShellSpillOptions {
  afterBytes: number;
  afterLines: number;
}

export interface ShellOutputSkip {
  bytes: number;
  newlines: number;
  endsWithNewline: boolean;
}

export interface ShellOutputInfo {
  stream: 'stdout' | 'stderr';
  skipped?: ShellOutputSkip;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** 超时时间（秒）。 */
  timeout?: number;
  onOutput?: (text: string, info: ShellOutputInfo) => void;
  spill?: ShellSpillOptions;
}

export interface ShellExecResult {
  exitCode: number;
  spillPath?: string;
}

// ---------------------------------------------------------------------------
// 内部常量
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 进程退出后留给 stdio 排空的宽限时间，防孙进程持有 fd 卡死。 */
const EXIT_STDIO_GRACE_MS = 100;
/** 溢写文件写流的高水位。 */
export const SPILL_HIGH_WATER_MARK = 1024 * 1024;

export function resolveTimeoutMs(timeout: number | undefined): Result<undefined | number> {
  if (timeout === undefined) return ok(undefined);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'));
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return err(
      new ExecutionError('timeout', `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`),
    );
  }
  return ok(timeoutMs);
}

// ---------------------------------------------------------------------------
// shell 定位（委托 @helm/env-io，含 Windows 宿主机 Git Bash 探测与 WSL 过滤）
// ---------------------------------------------------------------------------

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport: 'stdin' | 'argv';
}

/** 与 pi coding-agent shell.ts 保持同步：旧版 WSL bash 启动器需经 stdin 传输命令。 */
export function isLegacyWslBashPath(path: string): boolean {
  return envIsLegacyWslBashPath(path, process.env);
}

export function getBashShellConfig(shell: string): ShellConfig {
  return envGetBashShellConfig(shell, process.env);
}

export async function getShellConfig(
  customShellPath: string | undefined,
  io?: ShellProbeIo,
): Promise<Result<ShellConfig>> {
  const resolved = await resolveHostShellConfig(customShellPath, io);
  if (!resolved.ok) {
    return err(new ExecutionError('shell_unavailable', resolved.message));
  }
  return ok(resolved.value);
}

// ---------------------------------------------------------------------------
// 子进程环境组装（受管身份变量剥除）
// ---------------------------------------------------------------------------

/**
 * 受管身份变量名（大小写不敏感）剥除清单：宿主 daemon 进程自身的这些
 * 环境变量绝不经继承进入子命令——HELM_TOKEN（节点凭据）、
 * HELM_EXECUTION_SCOPE（执行作用域标记，由 Hub 侧按调用注入最新值）。
 * 静默继承旧值会伪造执行身份/作用域，与内核 buildManagedEnv 的受管
 * 固定覆盖同向；shellEnv（daemon 提供的 HELM_HUB_URL/HELM_DATA_DIR）与
 * 调用方显式 env 不在剥除范围。
 */
const MANAGED_INHERIT_STRIP_UPPER = new Set(['HELM_TOKEN', 'HELM_EXECUTION_SCOPE']);

/** 受管身份变量判定（导出供 env-rpc-server 的继承基底复用；大小写不敏感）。 */
export function isManagedHelmEnvKey(key: string): boolean {
  return MANAGED_INHERIT_STRIP_UPPER.has(key.toUpperCase());
}

export function getShellEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  extraEnv: Record<string, string> | undefined,
  inheritEnv = true,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged: Record<string, string> = {};
  if (inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (isManagedHelmEnvKey(key)) continue;
      setEnvEntry(merged, key, value, platform);
    }
    for (const [key, value] of Object.entries(baseEnv ?? {})) {
      if (value === undefined) continue;
      setEnvEntry(merged, key, value, platform);
    }
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) continue;
    setEnvEntry(merged, key, value, platform);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 进程树终止与收尾
// ---------------------------------------------------------------------------

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const systemRoot = getEnvEntry(process.env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
      const child = spawn(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/F', '/T', '/PID', String(pid)],
        { stdio: 'ignore', detached: true, windowsHide: true },
      );
      // spawn 失败会异步发 error：消费掉避免打崩 Node。
      child.once('error', () => {});
    } catch {
      // 忽略错误。
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已死。
    }
  }
}

export interface ChildProcessLike {
  pid?: number;
  stdin: null | { on(event: 'error', listener: (error: Error) => void): void; end(data?: string): boolean };
  stdout: null | (NodeJS.ReadableStream & { pause(): void; resume(): void; destroy(): void });
  stderr: null | (NodeJS.ReadableStream & { pause(): void; resume(): void; destroy(): void });
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

/**
 * 等待子进程收尾：exit 后留 100ms stdio 排空宽限（孙进程持有 fd 时不卡死），
 * spill 流背压期间重新计时；close 或宽限到点即结算。
 */
export function waitForChildProcess(
  child: ChildProcessLike,
  spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('end', onStdoutEnd);
      child.stderr?.removeListener('end', onStderrEnd);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
    };
    const finalize = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ code: exitCode, signal: exitSignal });
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize();
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => {
        if (spillIsDraining()) armIdleTimer();
        else finalize();
      }, EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: string | null) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null, signal: string | null) => {
      exitCode = code;
      exitSignal = signal;
      finalize();
    };
    child.stdout?.once('end', onStdoutEnd);
    child.stderr?.once('end', onStderrEnd);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}
