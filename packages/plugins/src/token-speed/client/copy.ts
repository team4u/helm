/**
 * Display copy for the token-speed badge (pure copy table + builders, no
 * component exports — Fast Refresh friendly).
 *
 * Honesty discipline carried by the copy itself:
 * - Every rate is an approximation derived from throttled live frames (75ms
 *   frames × 100ms partial commits), so titles always say the time is a
 *   throttled-frame approximation, never an exact server decode time;
 * - Tool pauses and streaming gaps keep the last valid rate of the turn and
 *   the tooltip says the timer is paused while tools run.
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'

/** Token accounting basis shown in tooltips. */
const SOURCE_LABELS: Record<string, LocalizedText> = {
  provider: { en: 'provider usage', 'zh-CN': '供应商 usage' },
  mixed: { en: 'provider usage + char estimate mixed', 'zh-CN': '供应商 usage + 字符估算混合' },
  estimate: { en: 'char estimate (chars/4)', 'zh-CN': '字符估算（chars/4）' },
}

/** Resolve the accounting-basis label for a tracker source. */
export function tokenSpeedSourceLabel(source: string, locale: HelmLocale): string {
  const entry = SOURCE_LABELS[source] ?? SOURCE_LABELS.estimate!
  return resolveLocalizedText(entry, locale)
}

/** TTFT disclosure appended to tooltips (plugin-first observation caveat). */
export function tokenSpeedTtftSuffix(ms: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    {
      en: `; TTFT ${ms}ms (first observed by the plugin, not the exact request start)`,
      'zh-CN': `；首字延迟 ${ms}ms（起点为插件首次观测，非请求精确起点）`,
    },
    locale,
  )
}

/** Settled-turn tooltip: reconciled totals, paired-response caveat, frame-approximation disclosure. */
export function tokenSpeedSettledTitle(parts: {
  tps: string
  tokens: number
  decode: string
  source: string
  ttft: string
}, locale: HelmLocale): string {
  return resolveLocalizedText(
    {
      en: `Last turn decode ≈${parts.tps} tok/s (settled total ${parts.tokens} tok, observed net decode time ${parts.decode}, basis ${parts.source}; rate only counts responses whose token counts and durations can be paired; time is a throttled-frame approximation, not exact server decode time; excludes TTFT and tool execution${parts.ttft})`,
      'zh-CN': `最近回合解码 ≈${parts.tps} tok/s（对账累计 ${parts.tokens} tok，观测解码净耗时 ${parts.decode}，口径 ${parts.source}；速率仅统计计数与时长可配对的响应；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行${parts.ttft}）`,
    },
    locale,
  )
}

/** Tool-pause tooltip: timer paused, tool time excluded from decode time. */
export function tokenSpeedToolsTitle(parts: {
  tps: string
  source: string
  tokens: number
  decode: string
  ttft: string
}, locale: HelmLocale): string {
  return resolveLocalizedText(
    {
      en: `Timer paused during tools · latest decode ≈${parts.tps} tok/s (basis ${parts.source}; tool execution time is not counted as decode time; ${parts.tokens} tok generated / ${parts.decode} observed decode${parts.ttft})`,
      'zh-CN': `工具执行暂停计时 · 最近解码 ≈${parts.tps} tok/s（口径 ${parts.source}；工具执行耗时不计入解码时间；已生成 ${parts.tokens} tok / 观测解码 ${parts.decode}${parts.ttft}）`,
    },
    locale,
  )
}

/** Live tooltip: sliding-window streaming rate plus the approximation disclosures. */
export function tokenSpeedLiveTitle(parts: {
  tps: string
  window: string
  source: string
  tokens: number
  decode: string
  ttft: string
}, locale: HelmLocale): string {
  return resolveLocalizedText(
    {
      en: `Live decode ≈${parts.tps} tok/s (${parts.window}s sliding-window streaming rate, basis ${parts.source}; time is a throttled-frame approximation, not exact server decode time; excludes TTFT and tool execution; ${parts.tokens} tok generated / ${parts.decode} observed decode${parts.ttft})`,
      'zh-CN': `实时解码 ≈${parts.tps} tok/s（${parts.window}s 滑动窗口流式观测速率，口径 ${parts.source}；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行；已生成 ${parts.tokens} tok / 观测解码 ${parts.decode}${parts.ttft}）`,
    },
    locale,
  )
}
