/**
 * Pure data-model helpers for the builtin:memory client (no component exports —
 * Fast Refresh friendly; display copy lives in copy.ts).
 *
 * The host validates plugin action outputs against their outputSchema, but the
 * client still guards the boundary it consumes: a malformed dream status must
 * surface as an honest "status unavailable" state instead of crashing the whole
 * memory section.
 */

/** Read subset of the backend `dream_status` action output the UI consumes. */
export interface DreamStatusResult {
  profileId?: string
  config: { enabled: boolean; hour: number; timezone: string }
  nextRunAt?: number
  running: string[]
  profiles: Array<{
    profileId: string
    candidateCount: number
    memoryChars: number | null
    lastRun?: {
      lastRunAt?: number
      ran: boolean
      applied?: boolean
      conflict?: boolean
      reason?: string
      error?: string
    }
  }>
}

/** Read subset of the backend `dream` action output the UI consumes. */
export interface DreamRunResult {
  profileId: string
  ran: boolean
  reason?: string
  applied?: boolean
  conflict?: boolean
  consumed?: number
}

/** Boundary shape check for the dream status payload before it reaches render. */
export function isDreamStatusResult(value: unknown): value is DreamStatusResult {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const config = v.config
  if (config === null || typeof config !== 'object') return false
  const c = config as Record<string, unknown>
  if (typeof c.enabled !== 'boolean' || typeof c.hour !== 'number' || typeof c.timezone !== 'string') return false
  if (!Array.isArray(v.running) || !Array.isArray(v.profiles)) return false
  return true
}
