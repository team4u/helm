/**
 * Launcher-side reader of the Hub's activity heartbeat file (`@helmx/kernel`'s
 * `activity-heartbeat.ts` writer; contract in `@helmx/protocol`'s `activity.ts`).
 *
 * This is the update busy-gate's evidence source — a process-private local file instead of any
 * new user HTTP surface. Every step of the binding chain is fail-closed: any mismatch, staleness,
 * missing proof, or malformed content yields `{ kind: 'unknown' }` and the caller must refuse to
 * stop the Hub on it (never guess that an unverifiable Hub is idle). The chain:
 *
 * 1. the recorded wrapper pid (`hub.pid`) is alive and — on Linux — still matches its recorded
 *    `/proc` start time (the same immutable-identity proof `stopHubLocked` requires before
 *    signalling; without it the record could describe a reused pid);
 * 2. the heartbeat file parses and satisfies the strict schema (unknown/missing fields rejected);
 * 3. `port` matches the recorded port and the writer is the recorded process itself or a direct
 *    child of it (the real Hub is the grandchild under the payload `start.mjs` wrapper the
 *    launcher recorded — not some other Hub's heartbeat);
 * 4. the writer pid is alive and — on Linux — its current `/proc` start time matches the record
 *    (the writing process is still the one that wrote it; pid reuse is refused);
 * 5. the record is fresh: `updatedAt` within `staleAfterMs` of now (and not meaningfully in the
 *    future — clock jumps count as unknown, not idle).
 *
 * A supervisor with the child handle can use the per-launch identity on platforms without
 * `/proc`. A detached process still requires the full start-time proof.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HUB_ACTIVITY_FILENAME, isHubActivityBusy, type HubActivityCounts, type HubActivityFile } from '@helmx/protocol';
import { readProcessStartTime, type HubPidRecord } from './records.js';
import { isAliveOf, type LauncherIo } from './io.js';

/** The gate verdict consumed by the update orchestration. */
export type HubActivityGate =
  | { kind: 'idle' }
  | { kind: 'busy'; counts: HubActivityCounts }
  | { kind: 'unknown'; detail: string };

export interface ReadHubActivityOptions {
  /** The supervisor holds the live wrapper handle. */
  ownsWrapper?: boolean;
  /** Clock seam (tests). */
  now?: () => number;
  /** Freshness bound for `updatedAt` (default 20 seconds). */
  staleAfterMs?: number;
  /** Start-time reader seam (tests; defaults to the launcher's `/proc` reader). */
  readStartTime?: (pid: number) => Promise<number | null>;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Strict schema validation of the heartbeat record (boundary discipline: malformed is unknown, never patched up). */
function validateActivityFile(raw: unknown): HubActivityFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec['schema'] !== 1) return null;
  const { pid, ppid, port, startTime, updatedAt, counts, launchId } = rec;
  if (launchId !== null && (typeof launchId !== 'string' || launchId === '')) return null;
  if (!isCount(pid) || pid === 0) return null;
  if (!isCount(ppid)) return null;
  if (!isCount(port) || port === 0 || port > 65535) return null;
  if (startTime !== null && !isCount(startTime)) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return null;
  const c = counts as Record<string, unknown>;
  if (
    !isCount(c['activeConversations']) ||
    !isCount(c['activeCompactions']) ||
    !isCount(c['queuedConversations']) ||
    !isCount(c['settlingConversations'])
  ) {
    return null;
  }
  return {
    schema: 1,
    launchId,
    pid,
    ppid,
    port,
    startTime,
    updatedAt,
    counts: {
      activeConversations: c['activeConversations'],
      activeCompactions: c['activeCompactions'],
      queuedConversations: c['queuedConversations'],
      settlingConversations: c['settlingConversations'],
    },
  };
}

/** Human-readable one-liner of busy counts for deferral messages and logs. */
export function describeActivityCounts(counts: HubActivityCounts): string {
  const parts = [
    `${counts.activeConversations} active conversation${counts.activeConversations === 1 ? '' : 's'}`,
    `${counts.activeCompactions} compaction${counts.activeCompactions === 1 ? '' : 's'}`,
    `${counts.queuedConversations} queued`,
    `${counts.settlingConversations} settling`,
  ];
  return parts.join(', ');
}

/**
 * Read and bind the Hub's activity heartbeat for the recorded (alive) wrapper pid record. Never
 * throws: every failure mode is `{ kind: 'unknown', detail }` and the caller decides how to
 * surface it (the update path fails closed on it).
 */
export async function readHubActivityGate(
  record: HubPidRecord,
  dataDir: string,
  io: LauncherIo,
  options?: ReadHubActivityOptions,
): Promise<HubActivityGate> {
  const now = options?.now ?? Date.now;
  const staleAfterMs = options?.staleAfterMs ?? 20_000;
  const readStartTime = options?.readStartTime ?? readProcessStartTime;
  const isAlive = isAliveOf(io);
  const file = path.join(dataDir, HUB_ACTIVITY_FILENAME);
  const unknown = (detail: string): HubActivityGate => ({ kind: 'unknown', detail });

  if (record.launchId === undefined) return unknown('pid record has no activity launch identity');
  if (record.startTime === undefined) {
    if (!options?.ownsWrapper) return unknown(`pid record for ${record.pid} carries no process start-time proof`);
  } else if (await readStartTime(record.pid) !== record.startTime) {
    return unknown(`recorded wrapper pid ${record.pid} fails its start-time proof`);
  }

  // Read the heartbeat only after verifying the wrapper identity.
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    return unknown(`activity file missing or unreadable at ${file} (${(error as Error).message}); the running hub may predate the heartbeat writer`);
  }
  const activity = validateActivityFile(raw);
  if (activity === null) {
    return unknown(`activity file at ${file} does not satisfy the heartbeat schema`);
  }

  if (activity.launchId !== record.launchId) return unknown('activity file belongs to another launch');

  // The writer belongs to this launcher's recorded process and port: in the payload layout
  // the real Hub is a direct child of the recorded `start.mjs` wrapper (`ppid` match); a
  // single-level spawn (the recorded process itself serves and writes) is equally accepted.
  if (activity.port !== record.port) {
    return unknown(`activity file reports port ${activity.port} but the recorded hub listens on ${record.port}`);
  }
  if (activity.pid !== record.pid && activity.ppid !== record.pid) {
    return unknown(
      `activity file was written by pid ${activity.pid} (child of ${activity.ppid}), which is neither the recorded hub process ${record.pid} nor its direct child`,
    );
  }

  if (!isAlive(activity.pid)) return unknown(`activity writer pid ${activity.pid} is no longer alive`);
  if (record.startTime !== undefined) {
    if (activity.startTime === null) return unknown('activity file carries no writer start-time proof');
    if (await readStartTime(activity.pid) !== activity.startTime) {
      return unknown(`writer pid ${activity.pid} fails its start-time proof`);
    }
  }

  // Stale or future-skewed clocks cannot establish whether the Hub is idle.
  const age = now() - activity.updatedAt;
  if (age > staleAfterMs) {
    return unknown(`activity file is stale (${Math.round(age)}ms old, bound ${staleAfterMs}ms); the hub may be hung or overloaded`);
  }
  if (age < -5_000) {
    return unknown(`activity file timestamp is in the future (${Math.round(-age)}ms ahead); clock skew counts as unknown`);
  }

  return isHubActivityBusy(activity.counts) ? { kind: 'busy', counts: activity.counts } : { kind: 'idle' };
}
