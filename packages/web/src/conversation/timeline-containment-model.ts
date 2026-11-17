/**
 * Timeline render-containment pure-function layer (plain .ts, zero React/DOM deps, unit-testable directly).
 *
 * Background: long-conversation timelines keep the full DOM (outline locating / search highlight / plugin
 * timeline.renderer contracts forbid trimming entries), so finished historical rows are handed to the
 * browser via CSS `content-visibility: auto` + `contain-intrinsic-size: auto <px>` to skip offscreen rendering.
 *
 * Honesty boundary: this is not DOM virtualization (nodes stay in the document; querySelectorAll /
 * outline / search keep working); never-rendered rows only get bucketed placeholder height estimates,
 * corrected to real heights once scrolled past. The scroll container enables native scroll anchoring
 * to keep the viewport stable, but zero shift is not promised for all complex content.
 *
 * This module also hosts the IntersectionObserver decision functions for the viewport reading anchor:
 * intersection means "row top has passed the container top + OUTLINE_ACTIVE_LINE_PX baseline",
 * aligning with outline-model.resolveActiveOutlineEntryId's "last anchor past the baseline,
 * first anchor when none has passed" semantics, without forcing layout on the whole list via
 * getBoundingClientRect for offscreen rows.
 */

import type { TimelineItem } from './timeline-model.js'

// ---------------------------------------------------------------------------
// Height-estimate buckets
// ---------------------------------------------------------------------------

/** Render-containment buckets for finished historical rows (CSS classes tl-cv-<bucket>). */
export type ContainmentBucket = 'xs' | 'sm' | 'md' | 'lg'

/** contain-intrinsic-size starting estimate per bucket (px); the `auto` keyword keeps the real height once known. */
export const CONTAINMENT_INTRINSIC_PX: Readonly<Record<ContainmentBucket, number>> = {
  xs: 48,
  sm: 120,
  md: 360,
  lg: 900,
}

/** Row-level render-containment CSS class name. */
export function containmentClassName(bucket: ContainmentBucket): string {
  return `tl-cv-${bucket}`
}

/** Body height params: ~55 chars per line at 820px desktop width (a CJK/latin compromise), ~23px per line. */
const DEFAULT_CHARS_PER_LINE = 55
const MIN_CHARS_PER_LINE = 18
const AVG_MIXED_CHAR_WIDTH_PX = 14.9
const MAX_TIMELINE_INNER_PX = 820
const NARROW_CONTAINER_THRESHOLD_PX = 680
const LINE_HEIGHT_PX = 23
/** One tool row / folded-group summary row (26px row height + amortized gaps). */
const TOOL_ROW_PX = 30
/** Human pill padding + bottom bar, turn footer, and other fixed chrome estimates. */
const HUMAN_CHROME_PX = 42
const TURN_CHROME_PX = 48
/** Estimate per attachment chip (thumbnail/chip row). */
const ATTACHMENT_PX = 34

export interface ContainmentEstimateOptions {
  /** 滚动容器宽度（px）：窄屏/分屏自动收窄每行字符数，避免移动端估高偏矮。 */
  containerWidthPx?: number
  /** 显式指定每行字符数（优先级高于 containerWidthPx）。 */
  charsPerLine?: number
}

/** 按容器宽度自适应每行估算字符数；未传或非法宽度回退桌面默认 55。 */
export function resolveCharsPerLine(containerWidthPx?: number): number {
  if (containerWidthPx === undefined || !Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return DEFAULT_CHARS_PER_LINE
  }
  const horizontalPadding = containerWidthPx <= NARROW_CONTAINER_THRESHOLD_PX ? 28 : 48
  const contentWidth = Math.min(MAX_TIMELINE_INNER_PX, Math.max(200, containerWidthPx - horizontalPadding))
  return Math.max(
    MIN_CHARS_PER_LINE,
    Math.min(DEFAULT_CHARS_PER_LINE, Math.round(contentWidth / AVG_MIXED_CHAR_WIDTH_PX)),
  )
}

function bucketByEstimatedHeight(px: number): ContainmentBucket {
  if (px <= 160) return 'sm'
  if (px <= 480) return 'md'
  return 'lg'
}

/**
 * Pick a height-estimate bucket for a finished historical row by text volume:
 * - divider: a fixed 26px divider, smallest bucket;
 * - plugin-card: plugin timeline.renderer card heights are unknowable (variable content), medium bucket,
 *   with the real height remembered afterwards via contain-intrinsic-size auto;
 * - human / assistant: bucket after a rough line estimate from body chars (+ attachment/tool row counts).
 */
export function estimateContainmentBucket(
  item: TimelineItem,
  options?: ContainmentEstimateOptions,
): ContainmentBucket {
  if (item.kind === 'divider') return 'xs'
  if (item.kind === 'plugin-card') return 'md'
  const charsPerLine =
    options?.charsPerLine !== undefined && Number.isFinite(options.charsPerLine) && options.charsPerLine > 0
      ? options.charsPerLine
      : resolveCharsPerLine(options?.containerWidthPx)
  if (item.kind === 'human') {
    const lines = Math.max(1, Math.ceil(item.text.length / charsPerLine))
    const attachments = item.attachments?.length ?? 0
    return bucketByEstimatedHeight(lines * LINE_HEIGHT_PX + attachments * ATTACHMENT_PX + HUMAN_CHROME_PX)
  }
  // assistant: body text + tool rows (a folded step-group occupies one summary row;
  // user expansion is corrected by the auto memory; live turns never get contained, see resolveContainmentClass).
  let chars = 0
  let rows = 0
  for (const seg of item.segments) {
    if (seg.kind === 'text') chars += seg.text.length
    else rows += 1
  }
  const lines = chars === 0 ? 0 : Math.ceil(chars / charsPerLine)
  return bucketByEstimatedHeight(lines * LINE_HEIGHT_PX + rows * TOOL_ROW_PX + TURN_CHROME_PX)
}

// ---------------------------------------------------------------------------
// Containment decisions
// ---------------------------------------------------------------------------

/**
 * Anchor id of a timeline row: same convention as the renderer's `data-entry-id` (human/divider/plugin
 * cards use the entryId; assistant turns use the first persisted entry id, falling back to the React key).
 */
export function timelineAnchorId(item: TimelineItem): string {
  return item.kind === 'assistant' ? (item.entryIds[0] ?? item.key) : item.entryId
}

export interface ContainmentExclusions {
  /** Anchors that must be released from containment (search/outline highlights and locate targets: content needs real layout before measuring/scrolling). */
  releasedEntryIds: ReadonlySet<string>
  /** Latest assistant turn key: always rendered for real regardless of conversation busy state (see below). */
  latestAssistantKey?: string
  /** 滚动容器宽度（px），用于移动端/窄分屏自适应估高分桶。 */
  containerWidthPx?: number
  /** 显式每行字符数（优先级高于 containerWidthPx）。 */
  charsPerLine?: number
}

/**
 * Decide whether a single timeline row may receive the render-containment class:
 * - unsupported or disabled (enabled=false) always renders normally;
 * - still-changing content is never contained: live streaming turns, queued inputs (queuedMode);
 * - the latest assistant turn always renders for real: both the initial bottom-stick on first open and
 *   active bottom-following concentrate their estimate error at the tail (a long tail answer's real
 *   height far exceeds its bucket — containing it would land the initial stick on the estimated total), and that turn is the user's current focus;
 * - highlight / outline locate target rows must be released (otherwise scrollIntoView lands on placeholder heights).
 */
export function resolveContainmentClass(
  item: TimelineItem,
  exclusions: ContainmentExclusions,
  enabled: boolean,
): string {
  if (!enabled) return ''
  if (item.kind === 'human' && item.queuedMode !== undefined) return ''
  if (item.kind === 'assistant') {
    if (item.live) return ''
    if (item.key === exclusions.latestAssistantKey) return ''
  }
  if (exclusions.releasedEntryIds.has(timelineAnchorId(item))) return ''
  return containmentClassName(
    estimateContainmentBucket(item, {
      ...(exclusions.containerWidthPx !== undefined ? { containerWidthPx: exclusions.containerWidthPx } : {}),
      ...(exclusions.charsPerLine !== undefined ? { charsPerLine: exclusions.charsPerLine } : {}),
    }),
  )
}

/**
 * Whether the browser supports content-visibility containment; when unsupported the whole list renders
 * normally (stale declarations are ignored by CSS; the JS short-circuit just avoids pointless class churn).
 */
export function supportsTimelineContainment(): boolean {
  if (typeof window === 'undefined' || typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return false
  }
  return CSS.supports('content-visibility', 'auto') && CSS.supports('contain-intrinsic-size', 'auto 120px')
}

// ---------------------------------------------------------------------------
// Viewport reading anchor (IntersectionObserver decisions)
// ---------------------------------------------------------------------------

/**
 * Outline activation baseline (px): same source as outline-model.resolveActiveOutlineEntryId's
 * default threshold — the last anchor whose row top passed "container top + 96px" is the reading anchor.
 */
export const OUTLINE_ACTIVE_LINE_PX = 96

/**
 * Derive the active anchor index from the set of currently intersecting anchor indexes (the IO-path decision core):
 * - take the last intersecting anchor in DOM (index) order, aligning with resolveActiveOutlineEntryId's
 *   "last anchor past the baseline" semantics (the observer's rootMargin narrows the intersection zone's
 *   bottom edge to the baseline; a row intersects iff its top has passed the baseline and its body is not far taller than the viewport);
 * - an empty set (all anchors below the baseline, e.g. just opened or scrolled to the very top) falls back to the first anchor;
 * - no anchors returns -1.
 */
export function resolveActiveAnchorIndex(
  intersecting: ReadonlySet<number>,
  anchorCount: number,
): number {
  if (anchorCount === 0) return -1
  let max = -1
  for (const idx of intersecting) {
    if (idx < 0 || idx >= anchorCount) continue
    if (idx > max) max = idx
  }
  return max === -1 ? 0 : max
}
