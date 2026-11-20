/**
 * `helmx start` (foreground): install-if-needed, start the committed release through the normal
 * detached readiness gate, then stay attached for the operator — streaming the hub log to the
 * terminal and turning SIGINT/SIGTERM into a graceful shutdown over the hub control channel.
 *
 * There is no update mediation here: updates are explicit (`helmx update`), so this runner holds
 * no lifecycle driver and never swaps the running process underneath the operator. Process
 * ownership for shutdown goes through the hub's own control channel (`hub-control.json` +
 * verified `instanceId`), with the pid-record identity proof as the fallback — the same stops
 * `helmx stop` performs.
 *
 * Honesty boundaries: a hub already running under another owner is an explicit refusal (this
 * command never adopts foreign processes); an unexpected hub death ends the run with exit code 1
 * and a log-tail pointer instead of fighting over the instance; a second signal force-exits
 * without stopping anything (atomic writes make that crash-safe).
 */
import type { ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { controlRequest, CONTROL_STOP_TIMEOUT_MS, killProcessTree, readHubControlRecord } from '@helmx/env-io';
import { readCurrentRelease } from '@helmx/env-io';
import { DEFAULTS, defaultHubDataDir, pathsOf } from './layout.js';
import { readPidRecord, readLaunchConfig, removePidFileIfMatch, resolveEffectiveLaunchConfig, type LaunchConfig } from './records.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { startHub, stopHubGraceful } from './process.js';
import { performHubUpdate } from './update.js';

import type { UpdateCore } from './update-core.js';

export interface RunHubOptions {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** npm dist-tag channel used when the bootstrap install is needed (default `latest`). */
  tag?: string;
  /** Launch flags for the hub start (initial only — no restarts happen here). */
  launchFlags?: LaunchConfig;
  core?: UpdateCore;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  stopEscalationWaitMs?: number;
  /** Test seam: resolves to emulate SIGINT/SIGTERM (production installs real handlers). */
  shutdownSignal?: Promise<void>;
}

interface FollowState {
  pid: number;
  version: string;
  url: string;
  logPath: string;
  logOffset: number;
  child?: ChildProcess;
}

/** Read the last `maxLines` of a log file for shutdown diagnostics. */
async function readLogTail(logFile: string, maxLines: number): Promise<string> {
  try {
    const text = await fsp.readFile(logFile, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** Stream log increments to the operator until the hub process is gone. */
async function followLog(state: FollowState, io: LauncherIo, isAlive: (pid: number) => boolean): Promise<void> {
  for (;;) {
    if (!isAlive(state.pid)) return;
    let size = 0;
    try {
      size = (await fsp.stat(state.logPath)).size;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, DEFAULTS.healthPollMs));
      continue;
    }
    if (size > state.logOffset) {
      const text = await fsp.readFile(state.logPath, 'utf8').then(
        (content) => content.slice(state.logOffset),
        () => '',
      );
      state.logOffset += Buffer.byteLength(text, 'utf8');
      if (text !== '') io.out(text);
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULTS.healthPollMs));
  }
}

/** Stop a hub this process spawned and still holds: SIGTERM the wrapper (it forwards signals), escalate, clean the pid record. */
async function stopHeldChild(child: ChildProcess, pid: number, root: string, isAlive: (pid: number) => boolean, stopTimeoutMs: number): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead — the exit wait below decides
  }
  if (!(await waitForExitPidLocal(pid, stopTimeoutMs, isAlive))) {
    killProcessTree(pid);
    if (!(await waitForExitPidLocal(pid, DEFAULTS.stopEscalationWaitMs, isAlive))) {
      throw new Error(`hub pid ${pid} did not exit within ${stopTimeoutMs}ms graceful budget plus escalation`);
    }
  }
  const record = await readPidRecord(root);
  if (record !== null && record.pid === pid) {
    await removePidFileIfMatch(root, record);
  }
}

function waitForExitPidLocal(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
    timer.unref?.();
  });
}

/** The foreground run. Resolves with the process exit code when the operator stops it or the hub dies. */
export async function runHubForeground(options: RunHubOptions): Promise<number> {
  const { io, root } = options;
  const tag = options.tag ?? 'latest';
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);

  // Startup: never adopt a hub started elsewhere — stopping and restarting stay explicit.
  const record = await readPidRecord(root);
  if (record !== null && isAlive(record.pid)) {
    throw new UsageError(
      `a hub is already running (pid ${record.pid}, version ${record.version}); use helmx restart to take it over, helmx stop to stop it, or keep managing it manually`,
      'run_refuses_existing_hub',
    );
  }

  let state: FollowState;
  const current = await readCurrentRelease(root);
  if (current === null) {
    io.out(`no release installed under ${root}; installing ${options.pkgName} (tag ${tag})\n`);
    const outcome = await performHubUpdate({
      io,
      root,
      pkgName: options.pkgName,
      registryUrl: options.registryUrl,
      tag,
      startIfNotRunning: true,
      launchFlags: options.launchFlags,
      ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.core !== undefined ? { core: options.core } : {}),
    });
    const pidNote = outcome.pid !== undefined ? ` (pid ${outcome.pid}, ${outcome.url})` : '';
    io.out(`installed ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}; hub started${pidNote}\n`);
    if (outcome.pid === undefined || outcome.url === null) {
      throw new UsageError('bootstrap install finished without a running hub (internal error)', 'bootstrap_start_failed');
    }
    state = {
      pid: outcome.pid,
      version: outcome.targetVersion,
      url: outcome.url as string,
      logPath: paths.hubLogPath,
      logOffset: await fsp.stat(paths.hubLogPath).then((s) => s.size, () => 0),
    };
  } else {
    let captured: ChildProcess | undefined;
    const started = await startHub(root, io, {
      flags: options.launchFlags,
      healthTimeoutMs: options.healthTimeoutMs,
      pollMs: options.pollMs,
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      onSpawn: (child) => {
        captured = child;
      },
    });
    state = {
      pid: started.pid,
      version: started.version,
      url: started.url,
      logPath: started.logPath,
      logOffset: 0,
      child: captured,
    };
  }

  io.out(`hub ${state.version} running: pid ${state.pid} at ${state.url}\n`);
  io.out(`attached in the foreground: Ctrl+C stops the hub (updates are manual: helmx update)\n`);

  let stopping = false;
  let signalName: string | undefined;
  let shutdownRequested: (() => void) | undefined;
  const shutdownSignal =
    options.shutdownSignal ??
    new Promise<void>((resolve) => {
      shutdownRequested = resolve;
    });
  const onSignal =
    shutdownRequested !== undefined
      ? (signal: NodeJS.Signals) => {
          if (stopping) {
            // Second signal: leave everything as-is; locks and atomic writes make this crash-safe.
            process.exit(130);
          }
          stopping = true;
          signalName = signal;
          shutdownRequested?.();
        }
      : undefined;
  if (onSignal !== undefined) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  let exitCode = 0;
  let exitMessage = '';
  const hubGone = followLog(state, io, isAlive).then(() => true);
  const signalOrDeath = await Promise.race([shutdownSignal.then(() => 'signal'), hubGone.then(() => 'gone')]);

  if (signalOrDeath === 'gone') {
    exitCode = 1;
    exitMessage = `the hub process exited (pid ${state.pid}); inspect ${state.logPath}`;
    io.err(`${exitMessage}\n`);
    const tail = await readLogTail(state.logPath, 40);
    if (tail !== '') io.err(`--- ${state.logPath} last 40 lines ---\n${tail}\n`);
  } else {
    // Stop order: a hub this process spawned is stopped through the held handle (the strongest
    // ownership proof, platform-independent); the bootstrap-install path (no handle) falls back
    // to the verified control channel and then the pid-record identity proof.
    if (state.child !== undefined && state.child.pid === state.pid) {
      try {
        await stopHeldChild(state.child, state.pid, root, isAlive, options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs);
        exitMessage = `hub pid ${state.pid} stopped`;
      } catch (error) {
        exitCode = 1;
        exitMessage = `failed to stop hub pid ${state.pid}: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      const stop = await stopHubGraceful(root, io, {
        ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
        ...(options.stopEscalationWaitMs !== undefined ? { stopEscalationWaitMs: options.stopEscalationWaitMs } : {}),
      });
      if (!stop.wasRunning) {
        // The hub died between attach and stop — surface honestly instead of reporting success.
        exitCode = 1;
        exitMessage = `the hub process exited before the stop request completed (pid ${state.pid}); inspect ${state.logPath}`;
      } else if (stop.escalated) {
        exitCode = 0;
        exitMessage = `hub pid ${stop.pid} stopped (escalated after graceful timeout)`;
      } else {
        exitMessage = `hub pid ${stop.pid} stopped${stop.via === 'control-channel' ? ' (control channel)' : ''}`;
      }
    }
    io.err(`launcher stopping${signalName !== undefined ? ` (${signalName})` : ''}: ${exitMessage}\n`);
  }

  if (onSignal !== undefined) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return exitCode;
}

/** Resolve the data directory a running hub would have written `hub-control.json` into. */
export async function resolveControlDataDir(root: string, io: LauncherIo): Promise<string | undefined> {
  const record = await readPidRecord(root);
  if (record?.dataDir !== undefined) return record.dataDir;
  const effective = resolveEffectiveLaunchConfig({ env: io.env, saved: await readLaunchConfig(root) });
  if (effective.dataDir !== undefined) return effective.dataDir;
  return defaultHubDataDir(io.env);
}

/** One verified control-channel stop attempt; `false` = channel unavailable or rejected. */
export async function tryControlChannelStop(dataDir: string, timeoutMs: number = CONTROL_STOP_TIMEOUT_MS): Promise<boolean> {
  const control = await readHubControlRecord(dataDir).catch(() => null);
  if (control === null) return false;
  const reply = await controlRequest(control.endpoint, { type: 'stop', instanceId: control.instanceId }, timeoutMs, {
    instanceId: control.instanceId,
  });
  return reply !== null && reply.ok === true;
}
