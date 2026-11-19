/**
 * Pure display model for the conversation context usage readout (shared by the
 * Composer status text and tests).
 *
 * Display rules mirror the pi agent 1.5.2 footer
 * (dist/modes/interactive/components/footer.js) exactly:
 * - formatTokens tiers: <1000 raw; <10000 one decimal k; <1M rounded k;
 *   <10M one decimal M; beyond that rounded M;
 * - known window shows `${percent.toFixed(1)}%/${formatTokens(window)}`;
 *   percentage >90 turns red, >70 yellow, everything else stays default gray;
 *   coloring thresholds are strictly greater (>90 / >70);
 * - after a compaction with no valid assistant usage yet (tokens null) shows
 *   `?/${formatTokens(window)}`;
 * - an unknown window never shows a fake percentage or fake denominator: with
 *   tokens present only the compact estimate is shown, uncolored;
 * - tokens=0 (empty conversation / just reset) and empty usage outside
 *   compaction render nothing.
 *
 * Contract (kernel ConversationContextUsage): tokens is always present (may be
 * null); contextWindow is omitted when unknown (the kernel never fakes it);
 * compacting passes through as a boolean. Response-speed readouts do not ride
 * along with usage (policy belongs to the optional builtin:token-speed plugin).
 * formatTokens lives in lib/format.ts (the repo's single implementation,
 * shared with the conversation usage display).
 */
import type { ConversationContextUsage } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { formatTokens } from '../lib/format.js'

export type ContextUsageTone = 'default' | 'warn' | 'high'

export interface ContextUsageLabel {
  /** Read-only text (pi footer format). */
  text: string
  /** Semantic tone: high red / warn yellow / default gray; unknown windows are always default. */
  tone: ContextUsageTone
  /** Hover explanation (non-interactive; for a11y and explaining the window/unknown semantics). */
  title: string
}

export interface ContextUsageInput {
  tokens: number | null
  contextWindow?: number
  compacting?: boolean
}

/** Assemble the read-only status text (pure function); null renders no status text at all. */
export function contextUsageLabel(usage: ContextUsageInput, t: WebMessageTranslator = englishWebTranslator): ContextUsageLabel | null {
  if (usage.compacting === true) {
    return { text: t('composer.context.compactingStatus'), tone: 'default', title: t('composer.compaction.inProgress') }
  }
  if (usage.tokens === null) {
    // No new reply since the last compaction: the real context is unknown —
    // never pass a summary estimate off as the truth.
    return usage.contextWindow !== undefined
      ? {
          text: `?/${formatTokens(usage.contextWindow)}`,
          tone: 'default',
          title: t('composer.context.unknownAfterCompaction'),
        }
      : { text: '?', tone: 'default', title: t('composer.context.unknownNoWindow') }
  }
  // Empty conversation / just reset: no context to occupy, render no status text.
  if (usage.tokens === 0) return null
  if (usage.contextWindow === undefined) {
    return {
      text: formatTokens(usage.tokens),
      tone: 'default',
      title: t('composer.context.estimateTitle', { tokens: formatTokens(usage.tokens) }),
    }
  }
  const percent = (usage.tokens / usage.contextWindow) * 100
  const tone: ContextUsageTone = percent > 90 ? 'high' : percent > 70 ? 'warn' : 'default'
  return {
    text: `${percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`,
    tone,
    title: t('composer.context.usageTitle', {
      percent: percent.toFixed(1),
      used: formatTokens(usage.tokens),
      window: formatTokens(usage.contextWindow),
    }),
  }
}
