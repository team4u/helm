/**
 * Background daemon spawning and foreground launcher loop:
 * - Start concurrency lock (`O_CREAT|O_EXCL`) guards instance verification -> spawn -> PID recording;
 * - Verifies existing `node.pid` via the control channel before allowing a fresh start;
 * - Foreground stable launcher (for systemd/launchd) tracks `node.pid` across upgrade handoffs
 *   and stops the tracked instance gracefully via the control channel on SIGTERM/SIGINT.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import process from 'node:process';
import {
  isAliveOf,
  logPathOf,
  pidPath,
  readPidRecord,
  removePidFile,
  removePidFileIfMatch,
  startLockPath,
  waitForExit,
  writePidRecord,
  type NodeCliIo,
  type PidRecord,
  UsageError,
} from './cli-context.js';
import { cliSelfEntry } from './service-entry.js';
import {
  controlEndpoint,
  controlRequest,
  CONTROL_STOP_TIMEOUT_MS,
  CONTROL_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  STOP_EXIT_TIMEOUT_MS,
  type DaemonReadyState,
} from './control.js';

// ---------------------------------------------------------------------------
// Background startup: start lock + detached spawn with stdio IPC readiness
// ---------------------------------------------------------------------------

const LAUNCHER_POLL_MS = 2_000;

/** Parse `{ type: 'helmx-node.ready', pid, instanceId, state }` over native Node stdio IPC. */
function parseReadyMessage(message: unknown, instanceId: string): DaemonReadyState | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helmx-node.ready' || record['instanceId'] !== instanceId) return null;
  return record['state'] === 'registered' ? 'registered' : 'starting';
}

/**
 * Default detached daemon spawner:
 * 1. Opens `node.log` explicitly (never launches with a broken fd);
 * 2. Spawns detached with `stdio = ['ignore', logFd, logFd, 'ipc']` (token never in argv/env);
 * 3. Races ready message vs spawn error vs early exit within `readyTimeoutMs`;
 * 4. Cleans up parent fds, IPC channel, timers, and listeners on every exit path.
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
    throw new Error(`failed to open log file (${logFile}): ${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'HELMX_TOKEN') delete childEnv[key];
    child = spawn(nodePath, [...execArgv, ...args], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`failed to spawn background process: ${error instanceof Error ? error.message : String(error)}`);
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
      // Already disconnected.
    }
  };

  if (outcome.kind === 'ready') {
    detachChannel();
    child.unref();
    await logHandle.close().catch(() => undefined);
    if (child.pid === undefined) {
      throw new Error('background process pid unavailable after ready report (internal error)');
    }
    return { pid: child.pid, readyState: outcome.state, logPath: logFile };
  }

  // Failure path: kill only the ChildProcess we own and preserve diagnostic logs.
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
  detachChannel();
  child.unref();
  await logHandle.close().catch(() => undefined);
  const reason =
    outcome.kind === 'error'
      ? `background process failed to start (spawn error): ${outcome.error.message}`
      : outcome.kind === 'exit'
        ? `background process exited immediately after startup (code=${outcome.code ?? 'null'})`
        : `background process did not report ready (helmx-node.ready) within ${readyTimeoutMs}ms`;
  const tail = await readLogTail(logFile, 40);
  throw new Error(`${reason}${tail !== '' ? `\n--- ${logFile} last 40 lines ---\n${tail}` : ''}`);
}

/**
 * Concurrency lock (`O_CREAT|O_EXCL`) spanning instance check -> spawn -> PID persistence.
 * Never deletes a pre-existing lock silently because another `start` may be in flight.
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
        `concurrent start conflict: ${lockPath} already exists (another helmx-node start is in progress, or a previous start crashed); confirm no start is running and remove the lock file before retrying`,
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

/** Inherit loader flags (`--require`/`--import`) while stripping inspector/profiler flags. */
function inheritExecArgv(): string[] {
  return process.execArgv.filter((arg) => !/^-{1,2}(inspect|debug|cpu-prof|heap-prof)(-brk)?(-[a-z-]+)?(=.*)?$/.test(arg));
}

/**
 * Resolve the daemon launch target: `current.json` takes precedence (so upgraded releases are used);
 * falls back to `selfEntry` when no release is staged. Broken `current.json` targets fail explicitly.
 */
async function resolveDaemonLaunchTarget(
  dataDir: string,
  selfEntry: string,
): Promise<{ entryPath: string }> {
  const { readCurrentRelease } = await import('./daemon/upgrader.js');
  const current = await readCurrentRelease(dataDir);
  if (current === null) return { entryPath: selfEntry };
  try {
    await fsp.access(current.entryPath);
  } catch {
    throw new Error(
      `current.json points to a missing entry (${current.entryPath}, version ${current.version}): staged release may be corrupted; fix current.json or re-upgrade instead of falling back to an older entry`,
    );
  }
  return { entryPath: current.entryPath };
}

/** Ensure no live daemon or unverified PID owns `node.pid`; cleans up confirmed-dead stale records. */
async function assertNoLiveInstance(io: NodeCliIo, dataDir: string): Promise<void> {
  const isAlive = isAliveOf(io);
  const existing = await readPidRecord(dataDir);
  if (existing === null) return;
  const response = await controlRequest(existing.endpoint, { type: 'status', instanceId: existing.instanceId });
  if (response !== null && response.ok === true) {
    throw new UsageError(
      `daemon is already running (pid ${response.pid}, state ${response.state ?? 'unknown'}, pid file ${pidPath(dataDir)}); use helmx-node restart instead`,
      'already_running',
    );
  }
  if (isAlive(existing.pid)) {
    throw new UsageError(
      `pid ${existing.pid} is alive, but control channel is unreachable (endpoint ${existing.endpoint}): cannot verify identity safely; run helmx-node stop or verify the process manually and remove ${pidPath(dataDir)}`,
      'control_unreachable',
    );
  }
  await removePidFile(dataDir);
}

/** Start the daemon detached under `withStartLock` and persist `node.pid`. */
export async function startDaemon(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
): Promise<{ pid: number; logPath: string; readyState: DaemonReadyState }> {
  const isAlive = isAliveOf(io);
  return await withStartLock(dataDir, async () => {
    await assertNoLiveInstance(io, dataDir);
    const instanceId = randomBytes(16).toString('hex');
    const endpoint = controlEndpoint(dataDir, instanceId);
    const spawnDaemon = io.spawnDaemon ?? defaultSpawnDaemon;
    const target = await resolveDaemonLaunchTarget(dataDir, cliSelfEntry());
    const args = [target.entryPath, 'start', '--data-dir', dataDir];
    if (effectiveHub !== '') args.push('--hub', effectiveHub);
    const { pid, readyState, logPath } = await spawnDaemon({
      nodePath: process.execPath,
      args,
      execArgv: target.entryPath === cliSelfEntry() ? inheritExecArgv() : [],
      dataDir,
      env: {
        ...process.env,
        ...(io.env ?? {}),
        HELMX_NODE_INSTANCE_ID: instanceId,
        HELMX_NODE_CONTROL_ENDPOINT: endpoint,
      },
      instanceId,
      endpoint,
      ...(io.readyTimeoutMs !== undefined ? { readyTimeoutMs: io.readyTimeoutMs } : {}),
    });
    try {
      await writePidRecord(dataDir, { pid, instanceId, endpoint });
    } catch (error) {
      const stopped = await controlRequest(endpoint, { type: 'stop', instanceId }, CONTROL_STOP_TIMEOUT_MS, { pid, instanceId });
      if (!stopped?.ok || !(await waitForExit(pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
        throw new AggregateError([error], `failed to write PID record and could not confirm background process ${pid} stopped; manual cleanup required`);
      }
      await removePidFileIfMatch(dataDir, { pid, instanceId, endpoint });
      throw error;
    }
    return { pid, logPath, readyState };
  });
}

// ---------------------------------------------------------------------------
// Foreground stable launcher
// ---------------------------------------------------------------------------

/** Stop the tracked daemon instance via its control channel and wait for exit + CAS PID cleanup. */
async function stopTrackedInstance(io: NodeCliIo, dataDir: string, record: PidRecord): Promise<string | undefined> {
  const response = await controlRequest(
    record.endpoint,
    { type: 'stop', instanceId: record.instanceId },
    CONTROL_STOP_TIMEOUT_MS,
    { pid: record.pid, instanceId: record.instanceId },
  );
  if (response === null || response.ok !== true) {
    return `failed to stop daemon (pid ${record.pid}, endpoint ${record.endpoint}): ${
      response === null ? 'control channel unreachable' : response.error ?? 'unknown'
    }; daemon may still be running — use helmx-node stop`;
  }
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAliveOf(io)))) {
    return `pid ${record.pid} did not exit within ${STOP_EXIT_TIMEOUT_MS}ms; pid file retained for diagnostics`;
  }
  await removePidFileIfMatch(dataDir, record);
  return undefined;
}

/**
 * Foreground stable launcher (for systemd/launchd): spawns a controlled daemon child and tracks
 * `node.pid` across upgrade handoffs, forwarding SIGINT/SIGTERM via the control channel.
 */
export async function runForegroundLauncher(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
  json: boolean,
): Promise<number> {
  const isAlive = isAliveOf(io);
  const envPollMs = Number(io.env?.HELMX_NODE_LAUNCHER_POLL_MS ?? '');
  const pollMs = Number.isFinite(envPollMs) && envPollMs > 0 ? envPollMs : (io.launcherPollMs ?? LAUNCHER_POLL_MS);
  const started = await startDaemon(io, dataDir, effectiveHub);
  if (!json) {
    io.out(`helmx-node launcher: daemon pid ${started.pid}; tracking instance (Ctrl+C to stop)\n`);
  }
  let stopError: string | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string): void => {
    if (shutdownPromise !== undefined) return;
    shutdownPromise = (async () => {
      try {
        const record = await readPidRecord(dataDir);
        if (record !== null && isAlive(record.pid)) {
          const error = await stopTrackedInstance(io, dataDir, record);
          if (error !== undefined) {
            stopError = `launcher received ${reason}, but ${error}`;
            return;
          }
        }
      } catch (error) {
        stopError = `launcher shutdown error: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  };
  const onSigint = (): void => shutdown('SIGINT');
  const onSigterm = (): void => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  for (;;) {
    if (shutdownPromise !== undefined) break;
    let record: PidRecord | null;
    try {
      record = await readPidRecord(dataDir);
    } catch (error) {
      stopError = `launcher failed to read pid record: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    if (record === null) {
      // Daemon stopped cleanly and deleted `node.pid`.
      break;
    }
    if (!isAlive(record.pid)) {
      const response = await controlRequest(
        record.endpoint,
        { type: 'status', instanceId: record.instanceId },
        CONTROL_TIMEOUT_MS,
        { pid: record.pid, instanceId: record.instanceId },
      ).catch(() => null);
      if (response === null || response.ok !== true) {
        stopError = `daemon pid ${record.pid} exited and control channel could not be verified; launcher exiting (run helmx-node start to restart)`;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  if (shutdownPromise !== undefined) await shutdownPromise;
  if (stopError !== undefined) io.err(`error: ${stopError}\n`);
  return stopError === undefined ? 0 : 1;
}
