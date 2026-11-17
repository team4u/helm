/**
 * Shared CLI primitives: I/O injection (`NodeCliIo`), `UsageError`, and PID/log file helpers.
 * Pure mechanism with no command-specific business logic, shared by `cli.ts` and `commands/*`
 * without introducing horizontal dependencies between command modules.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Injectable I/O hooks allowing tests to swap real process spawning and stdio. */
export interface NodeCliIo {
  env?: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Spawn the daemon in the background (defaults to detached spawn + stdio IPC ready reporting). */
  spawnDaemon?: (options: {
    nodePath: string;
    args: readonly string[];
    execArgv: readonly string[];
    dataDir: string;
    env: NodeJS.ProcessEnv;
    /** Control identifier for this instance (passed via env; never placed in argv or logs). */
    instanceId: string;
    /** Control endpoint (UDS path or Windows named pipe). */
    endpoint: string;
    /** Overall timeout waiting for the ready signal (defaults to 45s). */
    readyTimeoutMs?: number;
  }) => Promise<{ pid: number; readyState: import('./control.js').DaemonReadyState; logPath: string }>;
  /** Liveness probe (defaults to `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Overall timeout waiting for ready reporting (defaults to 45s; tests may inject shorter bounds). */
  readyTimeoutMs?: number;
  /** Launcher polling interval (defaults to 2s; tests may inject shorter intervals). */
  launcherPollMs?: number;
  /** Service install entrypoint override (defaults to compiled `dist/cli.js`). */
  serviceEntry?: string;
}

/** Usage or input validation error; its `code` is emitted in `--json` error envelopes. */
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

/** PID record persisted on disk (`pid`, `instanceId`, `endpoint`) for cross-platform identity verification without `/proc`. */
export interface PidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

/**
 * Read the PID record: only `ENOENT` returns `null`; corrupted files, invalid fields, or I/O errors
 * throw explicitly so a broken record is never silently treated as not running.
 */
export async function readPidRecord(dataDir: string): Promise<PidRecord | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(pidPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read pid file (${pidPath(dataDir)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `pid file is corrupt (${pidPath(dataDir)}): ${error instanceof Error ? error.message : String(error)}; confirm no stray process remains before removing it`,
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
      `pid file has invalid contents (${pidPath(dataDir)}): expected { pid, instanceId, endpoint }; confirm no stray process remains before removing it`,
    );
  }
  return { pid: record.pid, instanceId: record.instanceId, endpoint: record.endpoint };
}

/** Atomically write the PID record (`0600` via sibling temp file + rename; chmod failure on POSIX throws explicitly). */
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
    throw new Error(`failed to write pid file (${target}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removePidFile(dataDir: string): Promise<void> {
  try {
    await fsp.rm(pidPath(dataDir), { force: true });
  } catch (error) {
    throw new Error(`failed to remove pid file (${pidPath(dataDir)}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Compare-and-swap PID removal: deletes `node.pid` only when it still matches `expected`
 * (`pid` + `instanceId`), avoiding clobbering a record taken over by a newer upgrade/instance.
 */
export async function removePidFileIfMatch(dataDir: string, expected: PidRecord | undefined | null): Promise<boolean> {
  if (expected === null || expected === undefined) return false;
  const current = await readPidRecord(dataDir).catch(() => null);
  if (current === null || current.pid !== expected.pid || current.instanceId !== expected.instanceId) return false;
  await removePidFile(dataDir);
  return true;
}

/** Wait until `pid` is no longer alive, returning `false` on timeout. */
export async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}
