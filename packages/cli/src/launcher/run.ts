/**
 * `helmx update --watch` — the supervised foreground lifecycle.
 *
 * One long-running launcher process owns the local Hub end to end:
 *
 * - startup: installs the dist-tag's latest release when nothing is committed yet, then starts
 *   the committed release through the normal readiness gate. A hub that is already running (a
 *   leftover from another launcher run, or started by hand) is refused explicitly — this launcher
 *   only ever supervises processes it spawned itself;
 * - periodic checks: every `--interval-ms` the registry dist-tag (`--tag`, default `latest`) is
 *   compared against the committed version; a newer one flows through the ordinary update
 *   orchestration (staging → stop → commit → start) with its existing readiness-gated rollback.
 *   A failed check or a bad candidate keeps the previous hub serving — the loop logs the failure
 *   and continues with the next tick (never exits, never silently degrades);
 * - process ownership: every hub this launcher starts is held as a `ChildProcess` (the
 *   `HubLifecycleDriver` seam feeds it into the update orchestration, so updates and rollbacks
 *   also restart the held process). SIGINT/SIGTERM shut down the hub this launcher can prove it
 *   owns — the held handle — via graceful SIGTERM with process-tree escalation; a pid record is
 *   maintained alongside purely for `status`/`stop` observability;
 * - honesty boundaries: a signal that arrives during an in-flight update cycle waits for the
 *   cycle to finish (state mutations are never interleaved with an abort; the second signal
 *   force-exits without stopping anything — locks and atomic writes make that crash-safe). An
 *   unexpected exit of the supervised hub (crash, or someone else stopping it) ends the launcher
 *   with exit code 1 and the hub log tail pointer instead of fighting over the instance.
 */
import type { ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { killProcessTree } from '@helmx/env-io';
import { readCurrentRelease } from '@helmx/env-io';
import { DEFAULTS, pathsOf } from './layout.js';
import { readPidRecord, removePidFileIfMatch, type LaunchConfig } from './records.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { startHubLocked, withLifecycleLock } from './process.js';
import { checkHubUpgrade, performHubUpdate, type HubLifecycleDriver } from './update.js';
import { describeActivityCounts } from './activity.js';
import type { UpdateCore } from './update-core.js';

export interface RunLauncherOptions {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** npm dist-tag channel (default `latest`). */
  tag?: string;
  /** Update-check interval (default `DEFAULTS.updateIntervalMs`). */
  intervalMs?: number;
  /** Launch flags for every hub start (initial, post-update, rollback). */
  launchFlags?: LaunchConfig;
  core?: UpdateCore;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  /** Test seam: resolves to emulate SIGINT/SIGTERM (production installs real handlers). */
  shutdownSignal?: Promise<void>;
}

interface HeldHub {
  child: ChildProcess;
  pid: number;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Cancellable sleep: the timer must never outlive the run loop (it would pin the process). */
function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Wait for a child's exit event with a budget (false = still running when the budget expired). */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
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

/**
 * The supervised run. Resolves only when the launcher shuts down (signal, supervised-hub death,
 * or a refused startup); the resolved value is the process exit code.
 */
export async function runSupervised(options: RunLauncherOptions): Promise<number> {
  const { io, root } = options;
  const tag = options.tag ?? 'latest';
  const intervalMs = options.intervalMs ?? DEFAULTS.updateIntervalMs;
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;

  let held: HeldHub | null = null;
  let transitioning = false;
  let shuttingDown = false;
  const shutdown = deferred<void>();
  let shutdownCode = 0;
  let shutdownMessage = '';

  const requestShutdown = (code: 0 | 1, message: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownCode = code;
    shutdownMessage = message;
    shutdown.resolve();
  };

  const unexpectedExitMessage = (exitCode: number | null, signalCode: NodeJS.Signals | null): string =>
    `the supervised hub process exited unexpectedly (code=${exitCode ?? 'null'} signal=${signalCode ?? 'null'}); inspect ${paths.hubLogPath}`;

  const captureChild = (child: ChildProcess): void => {
    if (child.pid === undefined) return;
    held = { child, pid: child.pid };
    child.once('exit', (code, signal) => {
      if (held === null || held.child !== child) return; // superseded by stop/start/rollback
      if (shuttingDown) return; // teardown already in progress
      if (transitioning) return; // parked: endTransition re-checks liveness when the transition ends
      held = null;
      requestShutdown(1, unexpectedExitMessage(code, signal));
    });
  };

  /**
   * Close out a mediated transition. Exits observed while `transitioning` was set were parked
   * (they may be the mediated stop itself), so re-check the held child once the transition ends:
   * one that is already dead was never mediated away — a hub can die after its readiness gate
   * but before the transition completes (install/update tail), and supervising that corpse
   * forever would break the unexpected-exit contract. Surface it instead.
   */
  const endTransition = (): void => {
    transitioning = false;
    const hub = held;
    if (hub === null || shuttingDown) return;
    const { exitCode, signalCode } = hub.child;
    if (exitCode === null && signalCode === null) return;
    held = null;
    requestShutdown(1, unexpectedExitMessage(exitCode, signalCode));
  };

  /**
   * Stop the held hub through the held handle (the ownership proof — signalling it can never hit
   * a reused pid). POSIX: graceful SIGTERM (the payload entry forwards it to the real hub child),
   * escalating to a process-tree kill when the budget expires. Windows has no deliverable
   * signals: a SIGTERM-ish kill would only terminate the entry wrapper and orphan the real hub
   * grandchild, so the whole tree is closed up front while the wrapper is provably ours.
   */
  const stopHeldHub = async (): Promise<void> => {
    const hub = held;
    if (hub === null) return;
    transitioning = true;
    try {
      if (process.platform === 'win32') {
        killProcessTree(hub.pid);
        if (!(await waitForChildExit(hub.child, DEFAULTS.stopEscalationWaitMs))) {
          throw new Error(
            `supervised hub pid ${hub.pid} did not exit after a process-tree termination on Windows; see ${paths.hubLogPath}`,
          );
        }
        await removeRecordIfOurs(hub.pid);
        return;
      }
      hub.child.kill('SIGTERM');
      if (await waitForChildExit(hub.child, stopTimeoutMs)) {
        await removeRecordIfOurs(hub.pid);
        return;
      }
      killProcessTree(hub.pid);
      if (!(await waitForChildExit(hub.child, DEFAULTS.stopEscalationWaitMs))) {
        throw new Error(
          `supervised hub pid ${hub.pid} did not exit within ${stopTimeoutMs}ms graceful budget plus escalation; see ${paths.hubLogPath}`,
        );
      }
      await removeRecordIfOurs(hub.pid);
    } finally {
      // The held child is always released, on success and on failure alike: nothing this
      // launcher spawned may outlive the run loop untracked.
      held = null;
      endTransition();
    }
  };

  /** Remove the pid record only while it still describes the hub we spawned (CAS semantics). */
  const removeRecordIfOurs = async (pid: number): Promise<void> => {
    const record = await readPidRecord(root);
    if (record !== null && record.pid === pid) await removePidFileIfMatch(root, record);
  };

  const driver: HubLifecycleDriver = {
    isRunning: async () => held !== null && held.child.exitCode === null && held.child.signalCode === null,
    ownsProcess: (pid) => held?.pid === pid && held.child.exitCode === null && held.child.signalCode === null,
    stop: stopHeldHub,
    async start() {
      // The unlocked body: inside `performHubUpdate` the lifecycle lock is already held (the
      // update's stop→commit→start window); the standalone startup path wraps this in the lock.
      transitioning = true;
      try {
        const result = await startHubLocked(root, io, {
          ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
          ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
          ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
          ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
          onSpawn: captureChild,
        });
        return { pid: result.pid, url: result.url };
      } catch (error) {
        held = null; // never became a supervised hub; its own failure path already killed it
        throw error;
      } finally {
        endTransition();
      }
    },
  };

  const updateCommon = {
    io,
    root,
    pkgName: options.pkgName,
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.core !== undefined ? { core: options.core } : {}),
    ...(options.launchFlags !== undefined ? { launchFlags: options.launchFlags } : {}),
    ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
    driver,
  };

  const runUpdateCycle = async (): Promise<void> => {
    try {
      // The check must query the SAME dist-tag as the update: with --tag beta the loop reacts
      // to the beta channel even while `latest` is unchanged (and vice versa stays idle).
      const check = await checkHubUpgrade({ ...updateCommon, tag });
      if (!check.updateAvailable) {
        io.out(`up to date: ${check.currentVersion ?? '(none)'} (tag ${tag}, latest ${check.latestVersion})\n`);
        return;
      }
      const outcome = await performHubUpdate({ ...updateCommon, targetVersion: check.latestVersion });
      if (outcome.deferred !== undefined) {
        io.out(
          `update to ${outcome.targetVersion} deferred: hub is busy (${describeActivityCounts(outcome.deferred.counts)}); nothing stopped, retrying next cycle\n`,
        );
        return;
      }
      if (!outcome.changed) {
        io.out(`already at ${outcome.targetVersion}; nothing to do\n`);
        return;
      }
      const pidNote = outcome.pid !== undefined ? ` (pid ${outcome.pid}, ${outcome.url})` : '';
      io.out(
        outcome.restarted || outcome.started
          ? `updated ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}; hub restarted${pidNote}\n`
          : `updated ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await readCurrentRelease(root);
      io.err(`update cycle failed; keeping ${current?.version ?? '(no release)'} running: ${message}\n`);
    }
  };

  // Production signal handling; the injected `shutdownSignal` seam keeps tests handler-free.
  const onSignal =
    options.shutdownSignal !== undefined
      ? undefined
      : (signal: NodeJS.Signals) => {
          if (shuttingDown) {
            // Second signal: stop waiting for the in-flight cycle and force-exit. State is
            // crash-safe (locks, atomic writes, throwaway staging); the hub may stay up.
            if (held !== null) {
              try {
                killProcessTree(held.pid);
              } catch {
                // best-effort on the hard-exit path
              }
            }
            process.exit(130);
          }
          requestShutdown(0, `received ${signal}`);
        };
  if (onSignal !== undefined) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  const externalSignal = options.shutdownSignal;
  const onExternalSignal = externalSignal !== undefined && onSignal === undefined
    ? () => requestShutdown(0, 'shutdown requested')
    : undefined;
  if (externalSignal !== undefined && onExternalSignal !== undefined) externalSignal.then(onExternalSignal);

  try {
    // Startup: never adopt a hub this launcher did not spawn — ownership is the whole safety
    // story for signal-mediated shutdown, so an existing live hub is an explicit refusal.
    const record = await readPidRecord(root);
    if (record !== null && isAlive(record.pid)) {
      throw new UsageError(
        `a hub is already running (pid ${record.pid}, version ${record.version}) that this launcher did not start; stop it first (helmx update --stop) or keep managing it manually`,
        'run_refuses_existing_hub',
      );
    }
    const current = await readCurrentRelease(root);
    if (current === null) {
      io.out(`no release installed under ${root}; installing ${options.pkgName} (tag ${tag})\n`);
      const outcome = await performHubUpdate({ ...updateCommon, tag, startIfNotRunning: true });
      const pidNote = outcome.pid !== undefined ? ` (pid ${outcome.pid}, ${outcome.url})` : '';
      io.out(`installed ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}; hub started${pidNote}\n`);
    } else {
      // Standalone start: take the lifecycle lock around the unlocked driver body (the update
      // path already holds it when it drives the same driver).
      const started = await withLifecycleLock(root, () => driver.start());
      io.out(`hub ${current.version} running: pid ${started.pid} at ${started.url}\n`);
    }
    io.out(`supervising: update checks every ${intervalMs}ms against tag "${tag}" (Ctrl+C to stop)\n`);

    for (;;) {
      const sleep = cancellableSleep(intervalMs);
      await Promise.race([sleep.promise, shutdown.promise.then(() => sleep.cancel())]);
      if (shuttingDown) break;
      await runUpdateCycle();
      if (shuttingDown) break;
    }

    await stopHeldHub().catch((error: unknown) => {
      // Shutdown must still return an exit code; an unstoppable hub is a failure exit with the
      // diagnostic instead of a rejected run.
      shutdownCode = 1;
      shutdownMessage += `${shutdownMessage !== '' ? '; ' : ''}${error instanceof Error ? error.message : String(error)}`;
    });
    if (shutdownMessage !== '') {
      const prefix = shutdownCode === 0 ? 'launcher stopping' : 'launcher stopping after a failure';
      io.err(`${prefix}: ${shutdownMessage}\n`);
      if (shutdownCode !== 0) {
        const tail = await readLogTail(paths.hubLogPath, 40);
        if (tail !== '') io.err(`--- ${paths.hubLogPath} last 40 lines ---\n${tail}\n`);
      }
    }
    return shutdownCode;
  } finally {
    if (onSignal !== undefined) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    // No last-resort child cleanup here on purpose: stopHeldHub's own finally always releases
    // `held` (success and failure alike), and the compiler's control-flow analysis proves no
    // escape path can reach this point with a child still held.
  }
}
