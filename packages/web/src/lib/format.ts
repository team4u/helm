/**
 * Web host formatting entry; shared implementations come from @helmx/plugin-client.
 */
export {
  formatBytes,
  formatCompactTimestamp,
  formatDurationMs,
  formatTime,
} from '@helmx/plugin-client'

/**
 * Compact human-readable token counts (strictly mirrors the pi agent footer formatTokens tiers,
 * same source as the conversation usage display):
 * <1000 raw; <10000 one-decimal k; <1M rounded k; <10M one-decimal M; afterwards rounded M.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

/** Locale-formatted full date-time (form-style display such as node connect time / health sample time). */
export function formatDateTime(ms: number | undefined, options?: { placeholder?: string }): string {
  if (ms === undefined) return options?.placeholder ?? '--'
  return new Date(ms).toLocaleString()
}

/**
 * Message display time (minimal time in the main chat flow):
 * - same day returns "HH:mm" (e.g. "14:28");
 * - other days return "MM-DD HH:mm" (e.g. "11-10 14:28");
 * - invalid or missing returns an empty string.
 * Accepts an optional nowOrOptions for unit tests and deterministic clock injection.
 */
export function formatMessageTime(
  ms: number | undefined,
  nowOrOptions?: number | { now?: number },
): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const nowMs = typeof nowOrOptions === 'number' ? nowOrOptions : (nowOrOptions?.now ?? Date.now())
  const nowDate = new Date(nowMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const isToday =
    d.getFullYear() === nowDate.getFullYear() &&
    d.getMonth() === nowDate.getMonth() &&
    d.getDate() === nowDate.getDate()
  if (isToday) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Full timestamp `YYYY-MM-DD HH:mm:ss` (complete localized time shown in the message hover tooltip); invalid or missing returns an empty string. */
export function formatFullTimestamp(ms: number | undefined, options?: { placeholder?: string }): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return options?.placeholder ?? ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return options?.placeholder ?? ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
