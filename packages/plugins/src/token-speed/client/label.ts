/**
 * Pure display model for the builtin:token-speed rate badge (no component
 * exports, Fast Refresh friendly).
 *
 * Honesty discipline:
 * - Every rate is an approximation observed from throttled live frames (75ms
 *   frames × 100ms partial commits) — even when the settled token count is
 *   reconciled against provider usage, the timing is still a frame-level
 *   approximation, so the badge shows a plain rounded integer (product copy:
 *   no ≈ prefix, no decimals) and the approximation disclosure lives in the
 *   tooltip prose ("throttled-frame approximation, not exact server decode
 *   time") — never implying exact server decode timing;
 * - Tool pauses and streaming gaps keep the last valid rate of the turn (tool
 *   execution is not counted as decode time, and the tooltip says the timer is
 *   paused); when nothing measurable has accumulated yet, render nothing at
 *   all — never fake a rate with 0.0 tok/s;
 * - Tooltips must distinguish "live sliding-window observation", "paused while
 *   tools run" and "settled reconciliation", and disclose honestly: excludes
 *   TTFT and tool execution time, the accounting basis (provider / estimate /
 *   mixed), and that the TTFT origin is the plugin's first observation (not
 *   the exact request start).
 *
 * All display copy is resolved from copy.ts against the explicit locale
 * parameter (defaults to the en locale so existing English assertions stay
 * valid); execution-facing payloads never change with locale.
 */
import { DEFAULT_HELMX_LOCALE, type HelmxLocale } from '@helmx/plugin-client'
import {
  tokenSpeedLiveTitle,
  tokenSpeedSettledTitle,
  tokenSpeedSourceLabel,
  tokenSpeedToolsTitle,
  tokenSpeedTtftSuffix,
} from './copy.ts'

interface SpeedLabel {
  /** Compact read-only text (mono/tabular, e.g. `52 tok/s`). */
  text: string
  /** Hover explanation (discloses the accounting basis). */
  title: string
}

/** Seconds label: one decimal below 10s, integer above. */
function secondsLabel(ms: number): string {
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

/** Rate badge copy; returns null when there is no reliable rate (render nothing). */
export function tokenSpeedLabelOf(
  status: {
    phase: 'decoding' | 'tools' | 'settled'
    tps?: number
    outputTokens: number
    decodeMs: number
    source: string
    ttftMs?: number
    windowMs: number
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): SpeedLabel | null {
  const tps = status.tps
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null
  const tokens = Math.max(1, Math.round(status.outputTokens))
  const source = tokenSpeedSourceLabel(status.source, locale)
  const decode = secondsLabel(status.decodeMs)
  const ttft =
    typeof status.ttftMs === 'number' && Number.isFinite(status.ttftMs) && status.ttftMs >= 0
      ? tokenSpeedTtftSuffix(Math.round(status.ttftMs), locale)
      : ''
  // 整数展示：四舍五入后下限钳到 1 —— 正实测速率绝不渲染成 "0 tok/s"（0 意味着没有可测量速率，那应返回 null）。
  const tpsText = String(Math.max(1, Math.round(tps)))
  if (status.phase === 'settled') {
    return {
      text: `${tpsText} tok/s`,
      title: tokenSpeedSettledTitle({ tps: tpsText, tokens, decode, source, ttft }, locale),
    }
  }
  if (status.phase === 'tools') {
    return {
      text: `${tpsText} tok/s`,
      title: tokenSpeedToolsTitle({ tps: tpsText, source, tokens, decode, ttft }, locale),
    }
  }
  const windowSeconds = status.windowMs / 1000
  return {
    text: `${tpsText} tok/s`,
    title: tokenSpeedLiveTitle(
      {
        tps: tpsText,
        window: windowSeconds.toFixed(windowSeconds < 10 ? 1 : 0),
        source,
        tokens,
        decode,
        ttft,
      },
      locale,
    ),
  }
}
