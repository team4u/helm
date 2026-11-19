/**
 * Hub activity heartbeat: a process-private local file the running Hub maintains inside its own
 * data directory so the launcher's update busy-gate can observe live conversation activity
 * without any new public HTTP surface (nothing is added to auth status or user APIs).
 *
 * Write discipline (the reader side — the launcher — fails closed on anything it cannot bind to
 * the current Hub instance; see `@helm/hub-launcher`'s activity reader):
 * - periodic atomic rewrite (tmp + rename) every `intervalMs`, plus an immediate write at start;
 * - SYNCHRONOUS rewrite on every idle→busy transition (registered via `listenBusyEntered`): the
 *   tracker invokes the listener inside its synchronous mutation path. This limits the idle
 *   observation window to the reader's read, decision and signal latency;
 * - best-effort semantics on write failures: the heartbeat never destabilizes the Hub (failures
 *   are reported through `onWriteError` and the outdated record is removed where possible);
 * - `stop()` removes the file (clean shutdown leaves no evidence a later launcher could mistake
 *   for a live idle Hub).
 *
 * Identity fields (`pid`, `ppid`, `port`, Linux `/proc` `startTime`) let the reader chain the
 * record to the launcher's own `hub.pid` proof (wrapper pid + start time) — the same
 * immutable-process identity discipline used for signalling decisions.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { HUB_ACTIVITY_FILENAME, type HubActivityCounts, type HubActivityFile } from '@helm/protocol';

/** Parse the start-time field (22) out of a `/proc/<pid>/stat` line (`comm` may contain spaces). */
function parseProcStartTime(statContent: string): number | null {
  const close = statContent.lastIndexOf(')');
  if (close === -1) return null;
  const fields = statContent.slice(close + 2).trim().split(/\s+/);
  const raw = fields[19]; // fields[0] is state (field 3 overall); start time is field 22 → index 19.
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Linux `/proc` start time of a pid (immutable per pid lifetime), or `null` where unavailable. */
function procStartTimeOf(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return parseProcStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

export interface ActivityHeartbeatOptions {
  /** Absolute path of the heartbeat file (the Hub's own data directory). */
  file: string;
  /** Port the Hub HTTP server is bound to (identity binding for readers). */
  port: number;
  launchId?: string;
  /** Live activity counts (the kernel runtime's aggregate snapshot). */
  snapshot(): HubActivityCounts;
  /**
   * Subscribes the heartbeat's synchronous rewrite to the provider's idle→busy transitions
   * (wired to the kernel runtime's `onActivityBusyEntered`); returns an unsubscribe function.
   */
  subscribeBusyEntered(listener: () => void): () => void;
  /** Periodic rewrite interval (default 5s; tests inject shorter values). */
  intervalMs?: number;
  /** Clock seam for tests. */
  now?(): number;
  /** Write-failure sink (the heartbeat itself never throws); each failure is reported once. */
  onWriteError?(error: unknown): void;
}

export interface ActivityHeartbeat {
  /** Stop the periodic writes and remove the file (idempotent). */
  stop(): Promise<void>;
}

/** Serialize the record (fixed field order keeps the file diff-stable for readers/debugging). */
function serializeRecord(record: HubActivityFile): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Start the heartbeat: writes the file immediately, rewrites it on every busy transition
 * (synchronously) and every `intervalMs`, and removes it on `stop()`.
 */
export function startActivityHeartbeat(options: ActivityHeartbeatOptions): ActivityHeartbeat {
  const intervalMs = options.intervalMs ?? 5_000;
  const now = options.now ?? Date.now;
  const pid = process.pid;
  const ppid = process.ppid;
  // Captured once: both are immutable for this process's lifetime, and re-reading ppid after an
  // orphaning reparent would silently break the reader's wrapper binding (fail-closed is better).
  const startTime = procStartTimeOf(pid);
  let stopped = false;

  const writeSync = (): void => {
    if (stopped) return;
    const record: HubActivityFile = {
      schema: 1,
      launchId: options.launchId ?? null,
      pid,
      ppid,
      port: options.port,
      startTime,
      updatedAt: now(),
      counts: options.snapshot(),
    };
    const tmp = `${options.file}.tmp-${pid}`;
    try {
      // mkdir is idempotent and keeps the writer self-sufficient when the data dir appears late.
      mkdirSync(path.dirname(options.file), { recursive: true });
      writeFileSync(tmp, serializeRecord(record), { mode: 0o600 });
      renameSync(tmp, options.file);
    } catch (error) {
      for (const file of [tmp, options.file]) {
        try {
          unlinkSync(file);
        } catch {
          // A write failure may also make the file unremovable. The reader still checks freshness.
        }
      }
      options.onWriteError?.(error);
    }
  };

  writeSync();
  const unsubscribeBusyEntered = options.subscribeBusyEntered(writeSync);

  const timer = setInterval(writeSync, intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribeBusyEntered();
      try {
        unlinkSync(options.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.onWriteError?.(error);
      }
    },
  };
}

/** Resolve the heartbeat file path inside a Hub data directory (writer and readers share this name). */
export function hubActivityFilePath(dataDir: string): string {
  return path.join(dataDir, HUB_ACTIVITY_FILENAME);
}
