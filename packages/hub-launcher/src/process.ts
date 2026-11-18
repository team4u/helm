/**
 * Hub process lifecycle owned by the launcher:
 *
 * - `startHub` spawns the committed payload entry (`start.mjs start`) detached with stdio to
 *   `logs/hub.log`, gates readiness on the public health endpoint, and only then persists
 *   `hub.pid` plus the sticky `launch.json`;
 * - `stopHub` verifies the recorded pid is really our Hub (health probe) before signalling,
 *   escalates to `killProcessTree` (process group on POSIX, `taskkill /T` on Windows) when the
 *   graceful SIGTERM budget expires, and removes the pid file only after a confirmed exit;
 * - identity discipline mirrors the node daemon: a live pid without a reachable health endpoint is
 *   never signalled blindly (possible pid reuse) — the user must verify manually.
 *
 * Cross-platform boundary: graceful shutdown is POSIX-first. On Windows `process.kill(pid,
 * 'SIGTERM')` terminates without delivering a signal handler, so the graceful budget effectively
 * degrades to a short pre-escalation wait; the escalation path (`taskkill /F /T`) is uniform.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { killProcessTree } from '@helm/env-io';
import { DEFAULTS, pathsOf } from './layout.js';
import {
  assertEntryExists,
  persistableLaunchConfig,
  readCurrentRelease,
  readLaunchConfig,
  readPidRecord,
  removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  writeLaunchConfig,
  writePidRecord,
  type EffectiveLaunchConfig,
  type HubPidRecord,
  type LaunchConfig,
} from './records.js';
import { hubHealthUrl, probeHubHealth, waitForHubHealth, type HubHealthStatus } from './health.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';

const EXIT_POLL_MS = 100;
const LOG_TAIL_LINES = 40;

export interface StartHubOptions {
  /** Explicit flags (highest precedence) folded into the effective launch configuration. */
  flags?: LaunchConfig;
  healthTimeoutMs?: number;
  pollMs?: number;
  fetchFn?: typeof fetch;
}

export interface StartHubResult {
  pid: number;
  version: string;
  entryPath: string;
  url: string;
  logPath: string;
  health: HubHealthStatus;
}

export interface StopHubOptions {
  stopTimeoutMs?: number;
  escalationWaitMs?: number;
  fetchFn?: typeof fetch;
}

export interface StopHubResult {
  wasRunning: boolean;
  pid?: number;
  /** True when the process only exited after `killProcessTree` escalation. */
  escalated: boolean;
  /** True when a dead pid record was found and removed (nothing was running). */
  cleanedStalePid: boolean;
}

async function withStartLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = pathsOf(root).startLockPath;
  await fsp.mkdir(root, { recursive: true });
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageError(
        `concurrent start conflict: ${lockPath} already exists (another start is in progress, or a previous start crashed); confirm no start is running and remove the lock file before retrying`,
        'start_lock_busy',
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

export function hubDisplayUrl(config: EffectiveLaunchConfig): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

/** Poll a pid until it exits or the budget expires (returns whether it exited). */
async function waitForExitPid(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return true;
}

/**
 * Refuse to start when a pid record claims a live Hub. A dead record is cleaned up; a live one is
 * verified against the health endpoint (identity confirmation) before being rejected.
 */
async function assertNoLiveHub(
  root: string,
  io: LauncherIo,
  fetchFn: typeof fetch | undefined,
): Promise<void> {
  const existing = await readPidRecord(root);
  if (existing === null) return;
  const isAlive = isAliveOf(io);
  if (!isAlive(existing.pid)) {
    await removePidFileIfMatch(root, existing);
    return;
  }
  const health = await probeHubHealth(existing.port, existing.host, {
    fetchFn,
    timeoutMs: DEFAULTS.identityProbeTimeoutMs,
  });
  if (health !== null) {
    throw new UsageError(
      `hub is already running (pid ${existing.pid}, version ${existing.version}, ${hubHealthUrl(existing.port, existing.host)}); use restart or stop first`,
      'hub_already_running',
    );
  }
  throw new UsageError(
    `pid ${existing.pid} is alive, but the hub health endpoint is unreachable (${hubHealthUrl(existing.port, existing.host)}): cannot verify identity safely (possible pid reuse); verify the process manually, stop it directly, or remove ${pathsOf(root).pidPath}`,
    'hub_identity_unverifiable',
  );
}

/** Start the committed Hub release detached; persists `hub.pid` + `launch.json` only after readiness. */
export async function startHub(root: string, io: LauncherIo, options: StartHubOptions): Promise<StartHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  return await withStartLock(root, async () => {
    await assertNoLiveHub(root, io, options.fetchFn);
    const current = await readCurrentRelease(root);
    if (current === null) {
      throw new UsageError(
        `no hub release installed under ${root}; run helm-hub-launcher update first`,
        'no_release_installed',
      );
    }
    await assertEntryExists(current.entryPath, `current.json (version ${current.version})`);
    const config = resolveEffectiveLaunchConfig({
      flags: options.flags,
      env: io.env,
      saved: await readLaunchConfig(root),
    });

    await fsp.mkdir(paths.logDir, { recursive: true });
    const logHandle = await fsp.open(paths.hubLogPath, 'a');
    let child: ReturnType<typeof spawn>;
    const childEnv: NodeJS.ProcessEnv = {
      ...io.env,
      HELM_PORT: String(config.port),
      HELM_HOST: config.host,
    };
    if (config.dataDir !== undefined) childEnv.HELM_DATA_DIR = config.dataDir;
    if (config.model !== undefined) childEnv.HELM_MODEL = config.model;
    if (config.webDistDir !== undefined) childEnv.HELM_WEB_DIST_DIR = config.webDistDir;
    try {
      child = spawn(process.execPath, [current.entryPath, 'start'], {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: childEnv,
      });
    } catch (error) {
      await logHandle.close().catch(() => undefined);
      throw new Error(`failed to spawn hub process: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Readiness = health endpoint answers; fail fast when the child dies before answering.
    const cleanup = async (): Promise<void> => {
      child.removeAllListeners('exit');
      await logHandle.close().catch(() => undefined);
    };
    const exitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `hub process exited before becoming healthy (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
          ),
        );
      });
    });

    const healthPromise = waitForHubHealth(config.port, config.host, {
      timeoutMs: options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });

    let health: HubHealthStatus;
    try {
      health = await Promise.race([healthPromise, exitPromise]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (child.pid !== undefined && isAlive(child.pid)) killProcessTree(child.pid);
      const tail = await readLogTail(paths.hubLogPath, LOG_TAIL_LINES);
      await cleanup();
      throw new Error(
        `hub failed to become healthy: ${reason}${tail !== '' ? `\n--- ${paths.hubLogPath} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
      );
    }

    if (child.pid === undefined) {
      await cleanup();
      throw new Error('hub process pid unavailable after readiness (internal error)');
    }
    try {
      await writePidRecord(root, {
        pid: child.pid,
        version: current.version,
        entryPath: current.entryPath,
        port: config.port,
        ...(config.host !== undefined ? { host: config.host } : {}),
        ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
        startedAt: new Date().toISOString(),
      });
      await writeLaunchConfig(root, persistableLaunchConfig(config));
    } catch (error) {
      // Never leave an untracked healthy hub behind: best-effort kill, then surface the original error.
      killProcessTree(child.pid);
      await cleanup();
      throw new AggregateError(
        [error],
        `failed to persist hub state after startup; attempted to terminate pid ${child.pid} — verify ${paths.pidPath} manually`,
      );
    }
    child.unref();
    await cleanup();
    return {
      pid: child.pid,
      version: current.version,
      entryPath: current.entryPath,
      url: hubDisplayUrl(config),
      logPath: paths.hubLogPath,
      health,
    };
  });
}

/** Stop the recorded Hub gracefully; identity is verified before any signal is sent. */
export async function stopHub(root: string, io: LauncherIo, options?: StopHubOptions): Promise<StopHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(root);
  if (record === null) return { wasRunning: false, escalated: false, cleanedStalePid: false };
  if (!isAlive(record.pid)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: false, escalated: false, cleanedStalePid: true };
  }
  const health = await probeHubHealth(record.port, record.host, {
    ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    timeoutMs: DEFAULTS.identityProbeTimeoutMs,
  });
  if (health === null) {
    throw new UsageError(
      `pid ${record.pid} is alive, but the hub health endpoint is unreachable (${hubHealthUrl(record.port, record.host)}): refusing to signal an unverified process (possible pid reuse); verify the pid manually, stop it directly, or remove ${paths.pidPath}`,
      'hub_identity_unverifiable',
    );
  }
  process.kill(record.pid, 'SIGTERM');
  const stopTimeoutMs = options?.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
  if (await waitForExitPid(record.pid, stopTimeoutMs, isAlive)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: true, pid: record.pid, escalated: false, cleanedStalePid: false };
  }
  killProcessTree(record.pid);
  const escalationWaitMs = options?.escalationWaitMs ?? DEFAULTS.stopEscalationWaitMs;
  if (!(await waitForExitPid(record.pid, escalationWaitMs, isAlive))) {
    throw new Error(
      `hub pid ${record.pid} did not exit within ${stopTimeoutMs}ms graceful budget plus ${escalationWaitMs}ms after escalation; pid file retained for diagnostics (${paths.pidPath})`,
    );
  }
  await removePidFileIfMatch(root, record);
  return { wasRunning: true, pid: record.pid, escalated: true, cleanedStalePid: false };
}

export interface RunningHubInfo {
  record: HubPidRecord;
  alive: boolean;
  health: HubHealthStatus | null;
}

/** Read-only snapshot for `status`: pid record liveness plus a short health probe. */
export async function readRunningHub(
  root: string,
  io: LauncherIo,
  fetchFn?: typeof fetch,
): Promise<RunningHubInfo | null> {
  const record = await readPidRecord(root);
  if (record === null) return null;
  const alive = isAliveOf(io)(record.pid);
  const health = alive
    ? await probeHubHealth(record.port, record.host, {
        ...(fetchFn !== undefined ? { fetchFn } : {}),
        timeoutMs: DEFAULTS.identityProbeTimeoutMs,
      })
    : null;
  return { record, alive, health };
}
