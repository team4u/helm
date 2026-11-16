/**
 * shell locate and process tree manage (local-env sub- module): semantics and pi coding-agent 
 * shell.ts keep sync (old edition WSL bash start via stdin transfer command), and
 * pi-durable NodeExecutionEnv process terminate/exit semantics align - - contract test
 * (test/node-local-env-contract.test.ts) pin shell probe result,
 * 128+signal edit number exit code and timeout text proposal format.
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
// exec option/result type
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
  /** on timeout between (second). */
  timeout?: number;
  onOutput?: (text: string, info: ShellOutputInfo) => void;
  spill?: ShellSpillOptions;
}

export interface ShellExecResult {
  exitCode: number;
  spillPath?: string;
}

// ---------------------------------------------------------------------------
// internal constant
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** process exit after to stdio arrange empty wide limit time, guard against descendant process hold has fd card die. */
const EXIT_STDIO_GRACE_MS = 100;
/** overflow write file write stream high watermark. */
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
// shell locate (delegate @helm/env-io, contains Windows host machine Git Bash probe and WSL filter)
// ---------------------------------------------------------------------------

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport: 'stdin' | 'argv';
}

/** and pi coding-agent shell.ts keep sync: old edition WSL bash start must via stdin transfer command. */
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
// child process environment group install (managed identity variable strip except)
// ---------------------------------------------------------------------------

/**
 * managed identity variable name (large small write do not sensitive) strip except manifest: host daemon process itself these
 * environment variable never via inherit enter sub- command - -HELM_TOKEN(node credentials),
 * HELM_EXECUTION_SCOPE(execute effect domain mark record, by Hub side by invoke inject most new value).
 * static default inherit old value will fabricate execute identity/effect domain, and kernel buildManagedEnv managed
 * fixed override same to;shellEnv(daemon provide HELM_HUB_URL/HELM_DATA_DIR) and
 * caller explicit env do not in strip except scope.
 */
const MANAGED_INHERIT_STRIP_UPPER = new Set(['HELM_TOKEN', 'HELM_EXECUTION_SCOPE']);

/** managed identity variable decide (export supply env-rpc-server inherit base bottom re- use; large small write do not sensitive). */
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
// process tree terminate and wrap-up
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
      // spawn failed will async error: consume avoid hit crash Node.
      child.once('error', () => {});
    } catch {
      // ignore error.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already die.
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
 * wait for child process wrap-up:exit after 100ms stdio arrange empty wide limit (descendant process hold has fd when do not card die),
 * spill stream back press during re- count when;close or wide limit to point i.e. compute.
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
