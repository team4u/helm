/**
 * Hub activity heartbeat: the process-private contract between the running Hub and the launcher's
 * update busy-gate.
 *
 * The Hub periodically (and synchronously on every idle→busy transition) writes a small JSON file
 * into its own data directory describing live conversation activity; the launcher reads it before
 * stopping the Hub for an update and refuses to proceed while the Hub reports work (or when the
 * signal cannot be trusted — see the launcher-side reader for the fail-closed binding chain).
 *
 * This is deliberately NOT an HTTP endpoint: activity signaling stays on a process-private local
 * file (no new public API surface, nothing added to the auth status responses).
 */

/** Live conversation-activity counts aggregated by the kernel over its conversation mirrors. */
export interface HubActivityCounts {
  /**
   * Conversations with an active run (`live.run` defined: generating, tool rounds, or an
   * approval-blocked run whose tool call is still in flight — blocked-with-live-run included,
   * a pending approval whose run already ended is not).
   */
  activeConversations: number;
  /** Active context-compaction tasks across conversations. */
  activeCompactions: number;
  /** Conversations with queued (not yet admitted) inbox input. */
  queuedConversations: number;
  /** Conversations with in-flight `turn_settled` callback chains. */
  settlingConversations: number;
}

/** On-disk heartbeat record (atomic tmp+rename writes; strict schema, unknown fields rejected by readers). */
export interface HubActivityFile {
  schema: 1;
  /** Per-launch identity passed by the supervisor to the Hub process. */
  launchId: string | null;
  /** Real Hub process id (the payload `start.mjs` wrapper's grandchild). */
  pid: number;
  /** Parent pid at write time: in the payload layout, the `start.mjs` wrapper the launcher recorded in `hub.pid`. */
  ppid: number;
  /** Port the Hub HTTP server is bound to. */
  port: number;
  /** Linux `/proc/<pid>/stat` start time (field 22) of `pid`; `null` where unavailable. */
  startTime: number | null;
  /** Epoch milliseconds at write time (freshness bound for readers). */
  updatedAt: number;
  counts: HubActivityCounts;
}

/** Heartbeat file name inside the Hub's data directory (writer and readers share this constant). */
export const HUB_ACTIVITY_FILENAME = 'hub-activity.json';

/** Whether the counts describe live work the update gate must not interrupt. */
export function isHubActivityBusy(counts: HubActivityCounts): boolean {
  return (
    counts.activeConversations > 0 ||
    counts.activeCompactions > 0 ||
    counts.queuedConversations > 0 ||
    counts.settlingConversations > 0
  );
}
