/**
 * Foreground scheduled auto-update loop (the `run` command): the stable external supervisor the
 * product mandates — the Hub never re-launches itself through its own internal cron.
 *
 * One process-control model: the loop uses the same start/stop/update machinery as the one-shot
 * commands (detached spawn, banner-gated readiness, `lifecycle.lock` serialization, pid-record
 * identity verification); there is no second supervision path. Semantics:
 *
 * - bootstrap: install a release when none exists yet, then ensure exactly one Hub is running
 *   (start when absent/dead, adopt the running one otherwise);
 * - every cycle: query the registry dist-tag, and when a newer version exists, run the full
 *   health-gated update (graceful stop → atomic commit → banner-gated start with rollback).
 *   The stop is a graceful SIGTERM: in-flight turns are interrupted mid-request at worst, and the
 *   kernel's journaling recovers them on the new release — the short stop→start window is honest
 *   downtime, not a zero-downtime canary;
 * - failures (registry unreachable, staging failure, candidate rejected) never exit the loop and
 *   never touch the running Hub: the failed version enters the blocked cooldown and the next
 *   cycle retries;
 * - shutdown (Ctrl-C / SIGTERM): the loop stops the Hub it owns — the same identity-verified
 *   graceful stop the `stop` command performs (with escalation), then the launcher exits.
 */
import { readCurrentRelease } from '@helm/update';
import { readPidRecord, type LaunchConfig } from './records.js';
import { isAliveOf, type LauncherIo } from './io.js';
import { startHub, stopHub } from './process.js';
import { checkHubUpgrade, performHubUpdate } from './update.js';
import { defaultUpdateCore, type UpdateCore } from './update-core.js';

/** Default auto-update check interval (1 hour). */
export const DEFAULT_RUN_INTERVAL_MS = 60 * 60 * 1000;

export type RunLoopEvent =
  | { type: 'installed'; version: string }
  | { type: 'already-running'; version: string; pid: number }
  | { type: 'started'; version: string; pid: number; url: string }
  | { type: 'start-failed'; error: string }
  | { type: 'no-update'; current: string; latest: string }
  | { type: 'updated'; previous: string; next: string; pid: number; url: string }
  | { type: 'check-failed'; error: string }
  | { type: 'update-failed'; error: string }
  | { type: 'stopping' }
  | { type: 'stopped'; pid?: number }
  | { type: 'stop-failed'; error: string };

export interface RunLauncherLoopOptions {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** npm dist-tag channel (default `latest`; e.g. `beta`). */
  tag?: string;
  /** Interval between periodic checks (the first check runs immediately after bootstrap). */
  intervalMs: number;
  launchFlags?: LaunchConfig;
  fetchFn?: typeof fetch;
  core?: UpdateCore;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
  /** Abort handle (Ctrl-C in the CLI); aborting triggers the graceful shutdown path. */
  signal?: AbortSignal;
  /** Event sink: CLI printing and test assertions. */
  onEvent?: (event: RunLoopEvent) => void;
}

export interface RunLoopSummary {
  /** Completed periodic check cycles. */
  cycles: number;
  /** Successful updates applied by the loop. */
  updates: number;
  /** True when the owned hub was confirmed stopped on shutdown. */
  stoppedHub: boolean;
  /** Last non-fatal failure surfaced by a cycle or by shutdown (the loop itself never throws). */
  lastError?: string;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Sleep that resolves early (`false`) when the abort signal fires. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run the scheduled auto-update loop until aborted; returns the shutdown summary. */
export async function runLauncherLoop(options: RunLauncherLoopOptions): Promise<RunLoopSummary> {
  const { io, root } = options;
  const core = options.core ?? defaultUpdateCore();
  const emit = (event: RunLoopEvent): void => {
    options.onEvent?.(event);
  };
  const isAlive = isAliveOf(io);
  const summary: RunLoopSummary = { cycles: 0, updates: 0, stoppedHub: false };

  const updateOptions = {
    io,
    core,
    root,
    pkgName: options.pkgName,
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.launchFlags !== undefined ? { launchFlags: options.launchFlags } : {}),
    ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
    ...(options.payloadCheckTimeoutMs !== undefined ? { payloadCheckTimeoutMs: options.payloadCheckTimeoutMs } : {}),
  };

  // Bootstrap 1/2: install a release when none exists yet (loop updates retry on failure).
  if ((await readCurrentRelease(root)) === null) {
    try {
      const outcome = await performHubUpdate({ ...updateOptions, startIfNotRunning: false });
      emit({ type: 'installed', version: outcome.targetVersion });
    } catch (error) {
      summary.lastError = errorMessage(error);
      emit({ type: 'update-failed', error: summary.lastError });
    }
  }

  // Bootstrap 2/2: ensure exactly one Hub is running (start when absent or dead, adopt otherwise).
  const pidRecord = await readPidRecord(root);
  if (pidRecord !== null && isAlive(pidRecord.pid)) {
    emit({ type: 'already-running', version: pidRecord.version, pid: pidRecord.pid });
  } else {
    try {
      const started = await startHub(root, io, {
        ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
        ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      });
      emit({ type: 'started', version: started.version, pid: started.pid, url: started.url });
    } catch (error) {
      summary.lastError = errorMessage(error);
      emit({ type: 'start-failed', error: summary.lastError });
      // Nothing can run right now: keep looping — a later update/retry may recover it.
    }
  }

  // Periodic cycles: the first check runs immediately, then one per interval. Cycle failures
  // never exit the loop and never disturb the running Hub.
  for (;;) {
    if (options.signal?.aborted) break;
    summary.cycles += 1;
    try {
      const check = await checkHubUpgrade({
        io,
        root,
        pkgName: options.pkgName,
        ...(options.core !== undefined ? { core: options.core } : {}),
        ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        ...(options.tag !== undefined ? { tag: options.tag } : {}),
      });
      if (!check.updateAvailable) {
        emit({ type: 'no-update', current: check.currentVersion ?? '(none)', latest: check.latestVersion });
      } else {
        try {
          const outcome = await performHubUpdate({ ...updateOptions, startIfNotRunning: true });
          summary.updates += 1;
          emit({
            type: 'updated',
            previous: outcome.previousVersion ?? '(none)',
            next: outcome.targetVersion,
            pid: outcome.pid ?? 0,
            url: outcome.url ?? '',
          });
        } catch (error) {
          summary.lastError = errorMessage(error);
          emit({ type: 'update-failed', error: summary.lastError });
        }
      }
    } catch (error) {
      summary.lastError = errorMessage(error);
      emit({ type: 'check-failed', error: summary.lastError });
    }
    const slept = await abortableSleep(options.intervalMs, options.signal);
    if (!slept) break;
  }

  // Shutdown: gracefully stop the hub owned by this loop (identity-verified, with escalation).
  emit({ type: 'stopping' });
  try {
    const stopped = await stopHub(root, io, {
      ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });
    summary.stoppedHub = stopped.wasRunning;
    emit(stopped.wasRunning ? { type: 'stopped', pid: stopped.pid } : { type: 'stopped' });
  } catch (error) {
    summary.lastError = errorMessage(error);
    emit({ type: 'stop-failed', error: summary.lastError });
  }
  return summary;
}
