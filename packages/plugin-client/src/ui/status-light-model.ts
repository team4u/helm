/**
 * Tone model for the shared StatusLight primitive (pure functions, zero
 * React/DOM dependencies): normalizes the zoo of raw status words used across
 * the host and plugins (running/completed/error/aborted/skipped/offline/...)
 * into the seven honest presentation tones behind a single status light.
 *
 * Tone semantics (shape + color + visible label, never color alone):
 * - working: in flight (accent dot, soft pulse);
 * - blocked: waiting for approval/input (solid warn dot);
 * - done: settled successfully (solid ok dot);
 * - failed: settled with error (solid err dot);
 * - aborted: stopped before settling — NOT plain gray: a hollow warn diamond,
 *   clearly distinct from blocked's solid dot and done/failed's solid dots;
 * - pending: not started / skipped / unknown (hollow neutral ring);
 * - idle: offline / disabled / resting (small muted dot).
 */

/** The seven presentation tones of the unified status light. */
export type StatusLightTone =
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'pending'
  | 'idle'

/** Raw status word aliases collected from host + plugin card surfaces. */
const TONE_ALIASES: Readonly<Record<string, StatusLightTone>> = {
  // in flight
  working: 'working',
  running: 'working',
  active: 'working',
  streaming: 'working',
  executing: 'working',
  // awaiting decision
  blocked: 'blocked',
  waiting: 'blocked',
  approving: 'blocked',
  // settled ok
  done: 'done',
  completed: 'done',
  success: 'done',
  succeeded: 'done',
  passed: 'done',
  ok: 'done',
  settled: 'done',
  configured: 'done',
  // settled with error
  failed: 'failed',
  error: 'failed',
  err: 'failed',
  // stopped before settling
  aborted: 'aborted',
  cancelled: 'aborted',
  canceled: 'aborted',
  superseded: 'aborted',
  stopped: 'aborted',
  // not started / skipped / unknown
  pending: 'pending',
  queued: 'pending',
  skipped: 'pending',
  'not-configured': 'pending',
  unconfigured: 'pending',
  // resting
  idle: 'idle',
  offline: 'idle',
  disabled: 'idle',
  online: 'done',
}

/**
 * Normalize a raw status word (any case) into a StatusLightTone; unknown or
 * missing statuses map to the honest neutral `pending` ring (never a fake
 * done/failed verdict).
 */
export function normalizeStatusLightTone(status: string | undefined): StatusLightTone {
  if (status === undefined || status === '') return 'pending'
  return TONE_ALIASES[status.toLowerCase()] ?? 'pending'
}

/** CSS dot class for a tone (reuses the host .status-dot design-system vocabulary). */
export function statusLightDotClass(tone: StatusLightTone): string {
  if (tone === 'idle') return 'status-dot'
  if (tone === 'failed') return 'status-dot status-dot-error'
  return `status-dot status-dot-${tone}`
}
