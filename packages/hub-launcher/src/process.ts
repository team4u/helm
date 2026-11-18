/**
 * Hub process lifecycle owned by the launcher:
 *
 * - `startHub` spawns the committed payload entry (`start.mjs start`) detached with stdio
 *   redirected to `logs/hub.log` (file-backed output survives launcher exit; no pipes that could
 *   break a detached child), gates readiness primarily on the candidate's own stdout
 *   `Helm Hub: <url>` listen-success line appearing in the log after spawn plus the child staying
 *   alive (`@helm/hub` prints that line only after the HTTP server is listening) and the URL
 *   matching the launch configuration, and only then persists `hub.pid` plus the sticky
 *   `launch.json`. On Linux the pid record also carries the `/proc` start time as a reuse proof.
 *   `onSpawn` hands the spawned `ChildProcess` to callers that keep supervising it (`run`), so
 *   the same controlled startup flow can stop its own child without pid guessing;
 * - `stopHub` verifies the recorded pid is really our Hub before signalling, fail-closed: the
 *   only accepted proof is the immutable `/proc` start time recorded at spawn (a mismatch is pid
 *   reuse and is refused even when some other process answers on the port; a record without the
 *   proof — non-Linux platforms — is refused outright, steering to the supervised `run`), then
 *   escalates to `killProcessTree` (process group on POSIX, `taskkill /T` on Windows) when the
 *   graceful SIGTERM budget expires, and removes the pid file only after a confirmed exit;
 * - identity discipline mirrors the node daemon: without an ownership proof (a held
 *   `ChildProcess` from the same launcher, or a matching start time) a live pid is never
 *   signalled blindly — the user must verify manually;
 * - `lifecycle.lock` serializes every process-state mutation: concurrent starts, stops, and the
 *   update flow's stop→commit→start window (which takes the same lock as one atomic section via
 *   the exported `*Locked` primitives) can never interleave on one machine.
 *
 * Cross-platform boundary: graceful shutdown is POSIX-first. On Windows `process.kill(pid,
 * 'SIGTERM')` terminates without delivering a signal handler, so stop degrades to a short
 * pre-escalation wait; the escalation path (`taskkill /F /T`) is uniform.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { killProcessTree } from '@helm/env-io';
import { DEFAULTS, assertInstallIsolation, pathsOf } from './layout.js';
import {
  assertEntryExists,
  persistableLaunchConfig,
  readLaunchConfig,
  readPidRecord,
  readProcessStartTime,
  removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  writeLaunchConfig,
  writePidRecord,
  type EffectiveLaunchConfig,
  type HubPidRecord,
  type LaunchConfig,
} from './records.js';
import { hubHealthUrl, probeHubHealth, type HubHealthStatus } from './health.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { readCurrentEntry } from './current.js';

const EXIT_POLL_MS = 100;
const LOG_TAIL_LINES = 40;
/** `@helm/hub` prints `Helm Hub: <url>` right after `startHub` resolves (server listening). Multiline + global: the banner may follow earlier log lines in the same read, and `matchAll` requires global matching. */
const LISTEN_LINE_PATTERN = /^Helm Hub: (\S+)\s*$/gm;

export interface StartHubOptions {
  /** Explicit flags (highest precedence) folded into the effective launch configuration. */
  flags?: LaunchConfig;
  healthTimeoutMs?: number;
  pollMs?: number;
  fetchFn?: typeof fetch;
  /**
   * Receives the spawned hub `ChildProcess` right after spawn (before the readiness wait).
   * Lets a supervising caller hold the handle — stopping its own child never depends on pid
   * guessing or health probing.
   */
  onSpawn?: (child: ChildProcess) => void;
}

export interface StartHubResult {
  pid: number;
  version: string;
  entryPath: string;
  url: string;
  logPath: string;
  /** Auxiliary health confirmation; `null` means the probe did not answer (readiness already confirmed by the listen line). */
  health: HubHealthStatus | null;
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

/**
 * Held across every process-state mutation (start/stop and the update commit window) so the
 * three can never interleave on one machine.
 */
export async function withLifecycleLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = pathsOf(root).lifecycleLockPath;
  await fsp.mkdir(root, { recursive: true });
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageError(
        `concurrent lifecycle operation conflict: ${lockPath} already exists (another start/stop/update is in progress, or a previous one crashed); confirm nothing is running and remove the lock file before retrying`,
        'lifecycle_lock_busy',
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

/** Read the log from `offset` and return the new text plus the advanced offset. */
async function readLogFrom(logFile: string, offset: number): Promise<{ text: string; offset: number }> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(logFile, 'r');
  } catch {
    return { text: '', offset };
  }
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) return { text: '', offset };
    const length = Math.min(stat.size - offset, 1_000_000);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), offset: offset + bytesRead };
  } finally {
    await handle.close().catch(() => undefined);
  }
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

/**
 * The listen line must describe the configured endpoint, not just any `Helm Hub: ` output: a
 * mismatch means the candidate bound somewhere other than the requested host/port and is surfaced
 * as an explicit failure instead of a false-ready.
 */
function assertListenUrlMatches(listenUrl: string, config: EffectiveLaunchConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(listenUrl);
  } catch {
    throw new Error(`startup listen line URL is not parseable: "${listenUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`startup listen line URL is not http(s): "${listenUrl}"`);
  }
  const expectedHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '');
  if (parsed.port !== String(config.port) || stripBrackets(parsed.hostname) !== stripBrackets(expectedHost)) {
    throw new Error(
      `startup listen line reports ${listenUrl} but the launch configuration expects http://${expectedHost}:${config.port}`,
    );
  }
}

/**
 * Primary readiness gate: the candidate's own `Helm Hub: <url>` listen line in `hub.log` (only
 * content appended after spawn counts) while the child stays alive. The URL's port must match the
 * launch config — a banner naming a different endpoint is not this candidate's listen success and
 * keeps the wait going; a port-matching line is then host-checked before being accepted. Rejects
 * with the exit detail and the log tail.
 */
async function waitForListenLine(
  logFile: string,
  startOffset: number,
  pid: number,
  isAlive: (pid: number) => boolean,
  options: { timeoutMs: number; pollMs: number; expectedPort: number; exitDetail: () => string | null },
): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  let offset = startOffset;
  let scanned = '';
  for (;;) {
    if (!isAlive(pid)) {
      const tail = await readLogTail(logFile, LOG_TAIL_LINES);
      const detail = options.exitDetail();
      throw new Error(
        `hub process exited before reporting readiness${detail !== null ? ` ${detail}` : ''} (no "Helm Hub: " listen line)${tail !== '' ? `\n--- ${logFile} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
      );
    }
    const chunk = await readLogFrom(logFile, offset);
    offset = chunk.offset;
    if (chunk.text !== '') {
      scanned += chunk.text;
      if (scanned.length > 200_000) scanned = scanned.slice(-100_000);
      // Multiline-anchored match: the payload may (and does) print preceding log lines in the
      // same chunk.
      for (const match of scanned.matchAll(LISTEN_LINE_PATTERN)) {
        const candidateUrl = match[1]!;
        const parsed = /^https?:\/\/\[?([^\]]+)\]?:([0-9]+)$/.exec(candidateUrl);
        if (parsed !== null && Number(parsed[2]) === options.expectedPort) return candidateUrl;
      }
    }
    if (Date.now() >= deadline) {
      const tail = await readLogTail(logFile, LOG_TAIL_LINES);
      throw new Error(
        `hub readiness timed out after ${options.timeoutMs}ms: no "Helm Hub: " listen line in ${logFile}${tail !== '' ? `\n--- last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/**
 * Start the committed Hub release detached; persists `hub.pid` + `launch.json` only after
 * readiness. Unlocked body of the public `startHub` (the update flow calls it while already
 * holding `lifecycle.lock`).
 */
export async function startHubLocked(root: string, io: LauncherIo, options: StartHubOptions): Promise<StartHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  await assertNoLiveHub(root, io, options.fetchFn);
  const current = await readCurrentEntry(root);
  await assertEntryExists(current.entryPath, `current.json (version ${current.version})`);
  const config = resolveEffectiveLaunchConfig({
    flags: options.flags,
    env: io.env,
    saved: await readLaunchConfig(root),
  });
  assertInstallIsolation(root, config.dataDir, io.env);

  await fsp.mkdir(paths.logDir, { recursive: true });
  const logHandle = await fsp.open(paths.hubLogPath, 'a');
  const startOffset = (await logHandle.stat()).size;
  const childEnv: NodeJS.ProcessEnv = {
    ...io.env,
    HELM_PORT: String(config.port),
    HELM_HOST: config.host,
  };
  if (config.dataDir !== undefined) childEnv.HELM_DATA_DIR = config.dataDir;
  if (config.model !== undefined) childEnv.HELM_MODEL = config.model;
  if (config.webDistDir !== undefined) childEnv.HELM_WEB_DIST_DIR = config.webDistDir;
  let child: ReturnType<typeof spawn>;
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
  if (child.pid === undefined) {
    await logHandle.close().catch(() => undefined);
    throw new Error('hub process pid unavailable after spawn (internal error)');
  }
  const pid = child.pid;
  let exitDetail: string | null = null;
  child.once('exit', (code, signal) => {
    exitDetail = `(code=${code ?? 'null'} signal=${signal ?? 'null'})`;
  });
  child.unref();
  options.onSpawn?.(child);
  // Linux reuse proof for the pid record (see records.ts); harmless null elsewhere.
  const startTime = await readProcessStartTime(pid);
  await logHandle.close().catch(() => undefined);

  try {
    const listenUrl = await waitForListenLine(paths.hubLogPath, startOffset, pid, isAlive, {
      timeoutMs: options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
      pollMs: options.pollMs ?? DEFAULTS.healthPollMs,
      expectedPort: config.port,
      exitDetail: () => exitDetail,
    });
    assertListenUrlMatches(listenUrl, config);
    // Auxiliary confirmation only: the listen line already proves the candidate is serving.
    const health = await probeHubHealth(config.port, config.host, {
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      timeoutMs: DEFAULTS.healthRequestTimeoutMs,
    });
    await writePidRecord(root, {
      pid,
      version: current.version,
      entryPath: current.entryPath,
      port: config.port,
      ...(config.host !== undefined ? { host: config.host } : {}),
      ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
      startedAt: new Date().toISOString(),
      ...(startTime !== null ? { startTime } : {}),
    });
    await writeLaunchConfig(root, persistableLaunchConfig(config));
    return {
      pid,
      version: current.version,
      entryPath: current.entryPath,
      url: listenUrl,
      logPath: paths.hubLogPath,
      health,
    };
  } catch (error) {
    // Never leave an untracked half-started hub behind: kill the tree, then surface the error.
    killProcessTree(pid);
    await waitForExitPid(pid, 5_000, isAlive).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    const tail = await readLogTail(paths.hubLogPath, LOG_TAIL_LINES);
    throw new Error(
      `hub failed to become ready: ${reason}${tail !== '' && !reason.includes('---') ? `\n--- ${paths.hubLogPath} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
    );
  }
}

/** Public start: one atomic lifecycle-lock section. */
export function startHub(root: string, io: LauncherIo, options: StartHubOptions): Promise<StartHubResult> {
  return withLifecycleLock(root, () => startHubLocked(root, io, options));
}

/**
 * Stop the recorded Hub gracefully; identity is proven before any signal is sent. Unlocked body
 * of the public `stopHub` (the update flow calls it while already holding `lifecycle.lock`).
 */
export async function stopHubLocked(root: string, io: LauncherIo, options?: StopHubOptions): Promise<StopHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(root);
  if (record === null) return { wasRunning: false, escalated: false, cleanedStalePid: false };
  if (!isAlive(record.pid)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: false, escalated: false, cleanedStalePid: true };
  }
  // Fail-closed identity proof: the only signal-safe evidence that the recorded pid is still
  // the hub this launcher spawned is the immutable process start time. A reachable health
  // endpoint proves only that some hub-shaped server answers on the port — never that the
  // recorded pid is that server — so without a start-time proof the pid is never signalled.
  // Platforms without the proof (non-Linux detached records) surface an explicit refusal that
  // steers to the supervised `run` (which holds its own ChildProcess and needs no pid guessing).
  if (record.startTime === undefined) {
    throw new UsageError(
      `pid ${record.pid} cannot be verified as this launcher's hub: the pid record carries no process start-time proof (no /proc start time on this platform or at spawn time), and a health endpoint alone cannot prove the pid was not reused; refusing to signal it — stop the hub from the launcher 'run' session that owns it (Ctrl+C), or verify the process manually, stop it directly, and remove ${paths.pidPath}`,
      'hub_identity_unverifiable',
    );
  }
  const current = await readProcessStartTime(record.pid);
  if (current === null || current !== record.startTime) {
    throw new UsageError(
      `pid ${record.pid} no longer matches the recorded process start time (recorded ${record.startTime}, current ${current ?? 'unavailable'}): the hub exited and the pid was probably reused; refusing to signal it — remove ${paths.pidPath} after verifying, then start the hub again`,
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

/** Public stop: one atomic lifecycle-lock section. */
export function stopHub(root: string, io: LauncherIo, options?: StopHubOptions): Promise<StopHubResult> {
  return withLifecycleLock(root, () => stopHubLocked(root, io, options));
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
        ...(fetchFn !== undefined ? { fetchFn: fetchFn } : {}),
        timeoutMs: DEFAULTS.identityProbeTimeoutMs,
      })
    : null;
  return { record, alive, health };
}
