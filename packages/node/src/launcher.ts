/**
 * background start and trace:start lock,detached spawn(stdio IPC ready on report) and foreground stable
 * launcher(systemd/launchd main process).
 *
 * - start concurrency lock (O_CREAT|O_EXCL) override already has instance verify → spawn → pid Profile all process;
 * - already has pid first away control channel verify: true daemon reject duplicate start;pid store but channel
 *   cannot reach (cannot verify can security override) same reject; indeed already death only then clean up pid continue start;
 * - foreground stable launcher: cycle via node.pid + control channel verify trace when before instance (upgrade
 *   swap pid after automatically trace new daemon);SIGTERM/INT via control channel stop when before instance and wait for
 *   stop result set after only then exit - -systemd main PID do not because old daemon exit while kill the whole cgroup.
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
  type ControlServer,
  type DaemonReadyState,
} from './control.js';

// ---------------------------------------------------------------------------
// background start:start lock + detached spawn(stdio IPC ready on report)
// ---------------------------------------------------------------------------

/** launcher trace when before instance polling interval. */
const LAUNCHER_POLL_MS = 2_000;

/** background child process ready on report protocol (Node original generate stdio IPC):{ type:'helm-node.ready', pid, instanceId, state }. */
function parseReadyMessage(message: unknown, instanceId: string): DaemonReadyState | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'helm-node.ready' || record['instanceId'] !== instanceId) return null;
  return record['state'] === 'registered' ? 'registered' : 'starting';
}

/**
 * background start by default implement (export supply test re- use):
 * 1. open node.log(failed explicit errors, never carries broken fd start);
 * 2. detached spawn:stdio = ['ignore', logFd, logFd, 'ipc']- - ready via Node original generate
 *    IPC channel on report, across platform no need to grasp manually socket;argv without token;instanceId/endpoint
 *    via environment variable pass;
 * 3. ready / spawn error / child process exit three way compete fast, outside add total timeout;
 * 4. any one scoped after immediately clean up parent side fd/IPC channel/timer/listener, do not orphan child handle.
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
    throw new Error(`open log file failed (${logFile}):${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    // instanceId/endpoint already in env in (startDaemon inject): no longer duplicate piece together install.
    const childEnv = { ...env }
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'HELM_TOKEN') delete childEnv[key]
    child = spawn(nodePath, [...execArgv, ...args], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`background process spawn failed:${error instanceof Error ? error.message : String(error)}`);
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
      // disconnected.
    }
  };

  if (outcome.kind === 'ready') {
    detachChannel();
    child.unref();
    await logHandle.close().catch(() => undefined);
    if (child.pid === undefined) {
      throw new Error('background process ready on report after pid unavailable (internal error)');
    }
    return { pid: child.pid, readyState: outcome.state, logPath: logFile };
  }

  // failed path: stop this time hold has ChildProcess(self has child process), keep diagnose log.
  try {
    child.kill('SIGKILL');
  } catch {
    // already exit.
  }
  detachChannel();
  child.unref();
  await logHandle.close().catch(() => undefined);
  const reason =
    outcome.kind === 'error'
      ? `background process failed to start (spawn error):${outcome.error.message}`
      : outcome.kind === 'exit'
        ? `background process after startup immediately exit (code=${outcome.code ?? 'null'})`
        : `background process ${readyTimeoutMs}ms inside not on report ready (helm-node.ready)`;
  const tail = await readLogTail(logFile, 40);
  throw new Error(`${reason}${tail !== '' ? `\n--- ${logFile} finally 40 row ---\n${tail}` : ''}`);
}

/**
 * start concurrency lock (O_CREAT|O_EXCL): hold lock override already has instance verify → spawn → pid Profile
 * all process; all branch release; leftover lock explicit diagnose (not silently delete - - may is another start in-flight).
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
        `concurrency start conflict:${lockPath} already exists (another helm-node start is now enter row, or on time start exception exit leftover); confirm without concurrency after startup delete the file retry`,
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

/** background child process and parent process same source tsx compile environment which must execArgv(--require/--import loader etc.). */
function inheritExecArgv(): string[] {
  return process.execArgv.filter((arg) => !/^-{1,2}(inspect|debug|cpu-prof|heap-prof)(-brk)?(-[a-z-]+)?(=.*)?$/.test(arg));
}

/**
 * parse background start target:current.json takes precedence (already upgrade after must run new release entry,
 * broken current explicit errors); without current fall back fixed launcher(itself entry, do not bind any
 * release). also return cliBinDir(has current when inject HELM_CLI_BIN_DIR).
 */
async function resolveDaemonLaunchTarget(
  dataDir: string,
  selfEntry: string,
): Promise<{ entryPath: string; cliBinDir?: string }> {
  const { readCurrentRelease } = await import('./daemon/upgrader.js');
  const current = await readCurrentRelease(dataDir);
  if (current === null) return { entryPath: selfEntry };
  try {
    await fsp.access(current.entryPath);
  } catch {
    throw new Error(
      `current.json points to entry missing (${current.entryPath},version ${current.version}): upgrade artifact may already corrupt; please fix current.json or re- upgrade, reject fall back old entry start`,
    );
  }
  return { entryPath: current.entryPath, ...(current.cliBinDir !== undefined ? { cliBinDir: current.cliBinDir } : {}) };
}

/** already has pid Profile verify: true daemon/pid store but cannot reach all reject; indeed already death clean up after let through. */
async function assertNoLiveInstance(io: NodeCliIo, dataDir: string): Promise<void> {
  const isAlive = isAliveOf(io);
  const existing = await readPidRecord(dataDir);
  if (existing === null) return;
  const response = await controlRequest(existing.endpoint, { type: 'status', instanceId: existing.instanceId });
  if (response !== null && response.ok === true) {
    throw new UsageError(
      `daemon already in run (pid ${response.pid},state ${response.state ?? 'unknown'},pid file ${pidPath(dataDir)}); reject duplicate start, such as must restart please use helm-node restart`,
      'already_running',
    );
  }
  if (isAlive(existing.pid)) {
    throw new UsageError(
      `pid ${existing.pid} store but control channel cannot reach (endpoint ${existing.endpoint}): cannot verify can security override, reject start; please first helm-node stop, or human confirm process identity after delete ${pidPath(dataDir)}`,
      'control_unreachable',
    );
  }
  // pid indeed already death: Profile expired, clean up after continue.
  await removePidFile(dataDir);
}

/**
 * background start entry: hold start lock complete already has instance verify → spawn + ready confirm → pid Profile.
 */
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
    // current release takes precedence: already upgrade after start must pull new entry, cannot continue run old launcher.
    const target = await resolveDaemonLaunchTarget(dataDir, cliSelfEntry());
    const args = [target.entryPath, 'start', '--data-dir', dataDir];
    if (effectiveHub !== '') args.push('--hub', effectiveHub);
    const { pid, readyState, logPath } = await spawnDaemon({
      nodePath: process.execPath,
      args,
      // fixed launcher(itself entry) inherit same source compile environment;release entry is compile artifact, do not carries loader.
      execArgv: target.entryPath === cliSelfEntry() ? inheritExecArgv() : [],
      dataDir,
      // control identifier via env pass (spawnDaemon receives env i.e. child process complete env).
      env: {
        ...process.env,
        ...(io.env ?? {}),
        HELM_NODE_INSTANCE_ID: instanceId,
        HELM_NODE_CONTROL_ENDPOINT: endpoint,
        ...(target.cliBinDir !== undefined ? { HELM_CLI_BIN_DIR: target.cliBinDir } : {}),
      },
      instanceId,
      endpoint,
      ...(io.readyTimeoutMs !== undefined ? { readyTimeoutMs: io.readyTimeoutMs } : {}),
    });
    try {
      await writePidRecord(dataDir, { pid, instanceId, endpoint });
    } catch (error) {
      const stopped = await controlRequest(endpoint, { type: 'stop', instanceId }, CONTROL_STOP_TIMEOUT_MS, { pid, instanceId })
      if (!stopped?.ok || !(await waitForExit(pid, STOP_EXIT_TIMEOUT_MS, isAlive))) {
        throw new AggregateError([error], `PID Profile failed and background process ${pid} cannot confirm stop, must human diagnose`)
      }
      // only when Profile still points to this time instance only then delete (may already by other write take over, do not mistakenly delete other person Profile).
      await removePidFileIfMatch(dataDir, { pid, instanceId, endpoint });
      throw error
    }
    return { pid, logPath, readyState };
  });
}

// ---------------------------------------------------------------------------
// foreground stable launcher
// ---------------------------------------------------------------------------

/** launcher close chain: via control channel stop when before instance and wait for result set (do not early retreat). */
async function stopTrackedInstance(io: NodeCliIo, dataDir: string, record: PidRecord): Promise<string | undefined> {
  const response = await controlRequest(
    record.endpoint,
    { type: 'stop', instanceId: record.instanceId },
    CONTROL_STOP_TIMEOUT_MS,
    { pid: record.pid, instanceId: record.instanceId },
  );
  if (response === null || response.ok !== true) {
    return `stop daemon failed (pid ${record.pid},endpoint ${record.endpoint}):${
      response === null ? 'control channel cannot reach' : response.error ?? 'unknown'
    }; daemon continue run, available helm-node stop stop`;
  }
  // etc. stop result set:daemon real exit and pid Profile by CAS clean up after only then return.
  if (!(await waitForExit(record.pid, STOP_EXIT_TIMEOUT_MS, isAliveOf(io)))) {
    return `pid ${record.pid} in ${STOP_EXIT_TIMEOUT_MS}ms inside not exit;pid file keep supply diagnose`;
  }
  await removePidFileIfMatch(dataDir, record);
  return undefined;
}

/**
 * foreground stable launcher(without control env  start,systemd/launchd main process):
 * - invoke startDaemon pull start subject to control background child process, itself keep store;
 * - cycle via node.pid + control channel verify trace when before instance: upgrade swap pid after automatically trace
 *   new daemon(new process by old daemon via upgrade handover pull start and change write pid Profile);
 * - SIGTERM/INT via control channel stop when before instance (verify pid/instanceId consistent) after exit,
 *   never to not via identity verify process signal;
 */
export async function runForegroundLauncher(
  io: NodeCliIo,
  dataDir: string,
  effectiveHub: string,
  json: boolean,
): Promise<number> {
  const isAlive = isAliveOf(io);
  // env override takes precedence at io inject: real child process launcher cannot connect io, only can via env shrink short polling.
  const envPollMs = Number(io.env?.HELM_NODE_LAUNCHER_POLL_MS ?? '')
  const pollMs = Number.isFinite(envPollMs) && envPollMs > 0 ? envPollMs : (io.launcherPollMs ?? LAUNCHER_POLL_MS)
  const started = await startDaemon(io, dataDir, effectiveHub);
  if (!json) {
    io.out(`helm-node launcher: daemon pid ${started.pid};launcher keep store trace,Ctrl+C stop\n`);
  }
  let stopError: string | undefined;
  /** close chain promise: signal trigger after start, return before must await set (do not let systemd early retreat). */
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string): void => {
    if (shutdownPromise !== undefined) return;
    shutdownPromise = (async () => {
      try {
        // trace when before instance: upgrade after node.pid already points to new daemon(old daemon already exit).
        const record = await readPidRecord(dataDir);
        if (record !== null && isAlive(record.pid)) {
          const error = await stopTrackedInstance(io, dataDir, record);
          if (error !== undefined) {
            stopError = `launcher receives ${reason}, but ${error}`;
            return;
          }
        }
      } catch (error) {
        stopError = `launcher close exception:${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  };
  const onSigint = (): void => shutdown('SIGINT');
  const onSigterm = (): void => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  // trace loop: Profile disappear or long phase cannot verify when such as exit (service manage will restart diagnose).
  for (;;) {
    if (shutdownPromise !== undefined) break;
    let record: PidRecord | null;
    try {
      record = await readPidRecord(dataDir);
    } catch (error) {
      stopError = `launcher read pid Profile failed:${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    if (record === null) {
      // daemon already stop (stop after pid file by delete):launcher task complete exit.
      break;
    }
    if (!isAlive(record.pid)) {
      const response = await controlRequest(
        record.endpoint,
        { type: 'status', instanceId: record.instanceId },
        CONTROL_TIMEOUT_MS,
        { pid: record.pid, instanceId: record.instanceId },
      ).catch(() => null);
      if (response !== null && response.ok === true) {
        // pid re- use rare window: Profile consistent and control end point verify via, continue trace.
      } else {
        stopError = `daemon pid ${record.pid} already exit and control channel cannot verify;launcher exit (available helm-node start restart)`;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // signal listener clean up (finally semantics); signal trigger close chain must await set after only then return
  // (stop result confirm,pid CAS clean up complete, do not let systemd in daemon exit before early retreat);
  // loop self retreat path (Profile disappear/cannot verify) no need to stop instance, directly return.
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  if (shutdownPromise !== undefined) await shutdownPromise;
  if (stopError !== undefined) io.err(`error: ${stopError}\n`);
  return stopError === undefined ? 0 : 1;
}
