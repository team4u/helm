/**
 * CLI layer public base seat: output inject point (NodeCliIo), use method error and pid/log path small assist manually.
 * pure mechanism, without command business; by entry cli.ts and each command module shared use, keep domain file between zero horizontal dependency.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** inject point: test within store writer and spawn replace body replace real process IO. */
export interface NodeCliIo {
  env?: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** background start (default real detached spawn + stdio IPC ready on report). */
  spawnDaemon?: (options: {
    nodePath: string;
    args: readonly string[];
    execArgv: readonly string[];
    dataDir: string;
    env: NodeJS.ProcessEnv;
    /** this instance control identifier (via env pass to child process; never enter argv/log). */
    instanceId: string;
    /** control end point (UDS path or Windows pipe name). */
    endpoint: string;
    /** ready on report total timeout (default 45s). */
    readyTimeoutMs?: number;
  }) => Promise<{ pid: number; readyState: import('./control.js').DaemonReadyState; logPath: string }>;
  /** store probe (default process.kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
  /** ready on report total timeout (default 45s): test inject short when limit. */
  readyTimeoutMs?: number;
  /** launcher trace polling interval (default 2s): test inject short interval. */
  launcherPollMs?: number;
  /** service install entry override (default parse compile artifact dist/cli.js). */
  serviceEntry?: string;
}

/** use method/input validate error:code follow JSON error message seal output (the rest error internal_error). */
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

/** pid Profile content:pid + instance identifier + control end point (identity verify independent of /proc, across platform consistent). */
export interface PidRecord {
  pid: number;
  instanceId: string;
  endpoint: string;
}

/**
 * read pid Profile: only ENOENT treated as without background process return null; corrupt/structure illegal/IO error
 * explicit throw, never broken file static default when act not run.
 */
export async function readPidRecord(dataDir: string): Promise<PidRecord | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(pidPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`read pid file failed (${pidPath(dataDir)}):${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `pid file corrupt (${pidPath(dataDir)}):${error instanceof Error ? error.message : String(error)}; please human confirm no residue process after delete the file`,
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
      `pid file content illegal (${pidPath(dataDir)}): expectation { pid, instanceId, endpoint }; please human confirm no residue process after delete the file`,
    );
  }
  return { pid: record.pid, instanceId: record.instanceId, endpoint: record.endpoint };
}

/** atomic write pid Profile (same directory temp file + rename;0600, non- Windows chmod failed explicit throw). */
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
    throw new Error(`write pid file failed (${target}):${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removePidFile(dataDir: string): Promise<void> {
  try {
    await fsp.rm(pidPath(dataDir), { force: true });
  } catch (error) {
    throw new Error(`remove pid file failed (${pidPath(dataDir)}):${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * CAS delete pid Profile: only when file content still points to expected(pid+instanceId) when only then delete.
 * upgrade/concurrency scenario under node.pid may already by new instance take over: never mistakenly delete other person Profile.
 * expected is undefined(without original record can validate) when do not delete, hand over by stale stream process handle.
 */
export async function removePidFileIfMatch(dataDir: string, expected: PidRecord | undefined | null): Promise<boolean> {
  if (expected === null || expected === undefined) return false;
  const current = await readPidRecord(dataDir).catch(() => null);
  if (current === null || current.pid !== expected.pid || current.instanceId !== expected.instanceId) return false;
  await removePidFile(dataDir);
  return true;
}

/** wait for pid disappear (process truly exit); timeout return false. */
export async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}
