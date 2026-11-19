/**
 * Real diff computation for the `edit` tool (sole implementation; shared by local and remote execution paths).
 *
 * Contract (aligned with `@helmx/protocol` `EDIT_TOOL_RESULT_SCHEMA`):
 * - Inputs are the full texts before/after an exact unique replacement and the replaced span: `original`,
 *   `updated` (must match real updated content), and `matchOffset` / `replacedLength` (the unique matched range
 *   of `oldText` in `original`). Throws immediately on broken preconditions (`edit_failed` before writing so the file
 *   is never modified);
 * - Diff computes only a `+-3` line context window around the modified lines (never diffs whole huge files);
 *   line numbers come from real newline scans (fast prefix scan without sacrificing correctness for `O(changes)`);
 * - Redact first: redact full `original` and `updated` before slicing window lines (slicing first then redacting
 *   could leak multi-line secrets crossing window boundaries);
 * - Line numbers and counts always reflect the raw text: `addedLines` / `removedLines` / `firstChangedLine` come
 *   from raw `diffLines` differences across the unredacted window, unaffected by row display truncation;
 * - If full-text redaction alters line count (e.g. a secret contains newlines replaced by a single-line placeholder),
 *   window lines no longer align with real file line numbers — falls back to `rows = []`, `truncated = true`, while
 *   keeping raw line counts; never fabricates line numbers or leaks secrets;
 * - Display budgets count post-redaction text: `rows <= TOOL_DIFF_MAX_ROWS`, per-row chars <= `TOOL_DIFF_MAX_ROW_CHARS`
 *   (long rows truncate for display while counts reflect full lines), cumulative chars <= `TOOL_DIFF_MAX_TEXT_CHARS`;
 *   any truncation sets `truncated = true`;
 * - Algorithmic diff budget: `diffLines` uses `maxEditLength` (returns `undefined` when exceeded) so huge diffs never
 *   stall the kernel; falls back to full-span replacement (strip common prefix/suffix lines, remove old, add new —
 *   valid though non-minimal, with consistent counts and explicit `truncated = true`);
 * - No-op (`updated === original`, i.e. `oldText === newText`): `rows = []`, counts `0`, `firstChangedLine` = match line.
 */

import { diffLines } from 'diff'
import {
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_TEXT_CHARS,
  type ToolDiffRow,
  type ToolEditDiff,
} from '@helmx/protocol'

/** Context lines retained before and after edited spans. */
const EDIT_CONTEXT_LINES = 3

/**
 * Algorithmic edit-length budget for `diffLines`: 10x `TOOL_DIFF_MAX_ROWS` — diffs exceeding this always
 * produce far more add/remove rows than fit the row budget anyway, so falling back to full-span replacement
 * preserves all renderable info while bounding kernel CPU cost.
 */
const EDIT_DIFF_MAX_EDIT_LENGTH = 2_000

const LF = 10
const CR = 13

/** Line count: `''` is 0 lines; counts `\n`, adding 1 when no trailing newline (matches `splitLineTexts`). */
function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) newlines += 1
  }
  return text.charCodeAt(text.length - 1) === LF ? newlines : newlines + 1
}

/** Split into lines (strips trailing `\n` and adjacent `\r`; preserves blank lines; `''` -> `[]`). */
function splitLineTexts(text: string): string[] {
  if (text === '') return []
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) {
      const end = i > start && text.charCodeAt(i - 1) === CR ? i - 1 : i
      lines.push(text.slice(start, end))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/**
 * Scan line start offsets: `lineStarts[k]` is the start offset of line `k+1`; a trailing `\n` with nothing
 * after it does not open an empty line (consistent with `countLines`/`splitLineTexts`); `''` yields `[]`.
 */
function scanLineStarts(original: string): number[] {
  if (original === '') return []
  const lineStarts = [0]
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === LF && i + 1 < original.length) lineStarts.push(i + 1)
  }
  return lineStarts
}

/** Line number containing `offset` (1-based): binary-searches ascending `lineStarts` for last start <= `offset`. */
function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Diff skeleton row (exact line numbers; text populated later by line number from redacted window). */
type SkeletonRow =
  | { kind: 'context'; oldLine: number; newLine: number }
  | { kind: 'remove'; oldLine: number }
  | { kind: 'add'; newLine: number }

/** Prioritize actual changes inside the row budget so trailing changes aren't crowded out by long unchanged middle spans. */
function trimUnchangedContext(skeleton: SkeletonRow[]): SkeletonRow[] {
  const rows: SkeletonRow[] = []
  for (let start = 0; start < skeleton.length;) {
    if (skeleton[start]!.kind !== 'context') {
      rows.push(skeleton[start++]!)
      continue
    }
    let end = start + 1
    while (end < skeleton.length && skeleton[end]!.kind === 'context') end++
    const before = start > 0
    const after = end < skeleton.length
    for (let i = start; i < end; i++) {
      if ((before && i < start + EDIT_CONTEXT_LINES) || (after && i >= end - EDIT_CONTEXT_LINES)) {
        rows.push(skeleton[i]!)
      }
    }
    start = end
  }
  return rows
}

/**
 * Compute `ToolEditDiff` from before/after full texts and matched span (pure, zero IO).
 *
 * `redact` requirement: placeholders must not introduce newlines (true for `[REDACTED]` in `SecretStash`).
 * Preserving line count across redaction confirms no secret spanned a newline so redacted window lines correspond
 * 1:1 with real line numbers; on mismatch, falls back by contract to `rows = []` rather than fabricating.
 */
export function computeEditDiff(
  original: string,
  updated: string,
  matchOffset: number,
  replacedLength: number,
  redact: (text: string) => string,
): ToolEditDiff {
  if (
    !Number.isInteger(matchOffset) ||
    matchOffset < 0 ||
    !Number.isInteger(replacedLength) ||
    replacedLength < 1 ||
    matchOffset + replacedLength > original.length
  ) {
    throw new Error(
      `Edit diff precondition failed: replaced range [${matchOffset}, ${matchOffset + replacedLength}) is out of bounds (file has ${original.length} chars)`,
    )
  }
  const lineStarts = scanLineStarts(original)
  const totalLines = lineStarts.length
  const firstLine = lineAt(lineStarts, matchOffset)
  const lastLine = lineAt(lineStarts, matchOffset + replacedLength - 1)
  // No-op (`oldText === newText`): no diff rows to display; line number points to the matched span.
  if (updated === original) {
    return { rows: [], addedLines: 0, removedLines: 0, firstChangedLine: firstLine, truncated: false }
  }
  const matchEnd = matchOffset + replacedLength
  const windowStartLine = Math.max(1, firstLine - EDIT_CONTEXT_LINES)
  const windowEndLine = Math.min(lastLine + EDIT_CONTEXT_LINES, totalLines)
  const windowStartOffset = lineStarts[windowStartLine - 1]!
  const windowEndOffset = windowEndLine < totalLines ? lineStarts[windowEndLine]! : original.length
  const rawOldWindow = original.slice(windowStartOffset, windowEndOffset)
  const insertedLength = updated.length - original.length + replacedLength
  const rawNewWindow =
    original.slice(windowStartOffset, matchOffset) +
    updated.slice(matchOffset, matchOffset + insertedLength) +
    original.slice(matchEnd, windowEndOffset)

  // Raw (unredacted) line-level diff skeleton and counts accurately reflect real edits.
  let addedLines = 0
  let removedLines = 0
  let firstChanged = 0
  const skeleton: SkeletonRow[] = []
  // Algorithmic budget exceeded: fall back to full-span replacement (valid though non-minimal; counts match skeleton).
  let editBudgetExceeded = false
  const changes = diffLines(rawOldWindow, rawNewWindow, {
    maxEditLength: EDIT_DIFF_MAX_EDIT_LENGTH,
    timeout: 250,
  })
  if (changes === undefined) {
    editBudgetExceeded = true
    const oldWindowLines = splitLineTexts(rawOldWindow)
    const newWindowLines = splitLineTexts(rawNewWindow)
    let prefix = 0
    while (
      prefix < oldWindowLines.length &&
      prefix < newWindowLines.length &&
      oldWindowLines[prefix] === newWindowLines[prefix]
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < oldWindowLines.length - prefix &&
      suffix < newWindowLines.length - prefix &&
      oldWindowLines[oldWindowLines.length - 1 - suffix] ===
        newWindowLines[newWindowLines.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const removedCount = oldWindowLines.length - prefix - suffix
    const addedCount = newWindowLines.length - prefix - suffix
    for (let i = 0; i < prefix; i++) {
      skeleton.push({ kind: 'context', oldLine: windowStartLine + i, newLine: windowStartLine + i })
    }
    for (let i = 0; i < removedCount; i++) {
      skeleton.push({ kind: 'remove', oldLine: windowStartLine + prefix + i })
    }
    for (let i = 0; i < addedCount; i++) {
      skeleton.push({ kind: 'add', newLine: windowStartLine + prefix + i })
    }
    for (let i = 0; i < suffix; i++) {
      skeleton.push({
        kind: 'context',
        oldLine: windowStartLine + oldWindowLines.length - suffix + i,
        newLine: windowStartLine + newWindowLines.length - suffix + i,
      })
    }
    removedLines = removedCount
    addedLines = addedCount
    firstChanged = windowStartLine + prefix
  } else {
    let oldLine = windowStartLine
    let newLine = windowStartLine
    for (const change of changes) {
      const lineCount = splitLineTexts(change.value).length
      if (change.added === true) {
        for (let i = 0; i < lineCount; i++) {
          if (firstChanged === 0) firstChanged = newLine
          skeleton.push({ kind: 'add', newLine })
          addedLines += 1
          newLine += 1
        }
      } else if (change.removed === true) {
        for (let i = 0; i < lineCount; i++) {
          // For pure deletions, `firstChanged` targets the new-file line at the deletion point (matching the first
          // subsequent context/added line, clamped to end-of-file for trailing deletions).
          if (firstChanged === 0) firstChanged = newLine
          skeleton.push({ kind: 'remove', oldLine })
          removedLines += 1
          oldLine += 1
        }
      } else {
        for (let i = 0; i < lineCount; i++) {
          skeleton.push({ kind: 'context', oldLine, newLine })
          oldLine += 1
          newLine += 1
        }
      }
    }
  }
  // Clamp `firstChangedLine` to actual new-file line count (handles EOF deletions; empty files clamp to 1).
  const firstChangedLine =
    firstChanged === 0 ? firstLine : Math.min(firstChanged, Math.max(1, countLines(updated)))

  // Redact full texts first so multi-line secrets crossing window boundaries are fully caught.
  const redOriginal = redact(original)
  const redUpdated = redact(updated)
  if (countLines(redOriginal) !== totalLines || countLines(redUpdated) !== countLines(updated)) {
    // Full-text redaction changed line count (secret contained newlines): window lines no longer align with real lines.
    // Honest fallback: return no rows (never leak), keeping raw counts and firstChangedLine.
    return { rows: [], addedLines, removedLines, firstChangedLine, truncated: true }
  }
  // Unchanged line count => no secret spanned a newline => redacted lines correspond 1:1 with raw lines;
  // slice the window directly from redacted full texts (earlier lines before the window stay aligned).
  const newWindowCount = countLines(rawNewWindow)
  const redOldLines = splitLineTexts(redOriginal).slice(windowStartLine - 1, windowEndLine)
  const redNewLines = splitLineTexts(redUpdated).slice(
    windowStartLine - 1,
    windowStartLine - 1 + newWindowCount,
  )

  // Enforce budgets on post-redaction text: rows, per-row chars, cumulative chars; mark `truncated` on any cut.
  const rows: ToolDiffRow[] = []
  let usedChars = 0
  let truncated = editBudgetExceeded
  for (const entry of trimUnchangedContext(skeleton)) {
    if (rows.length >= TOOL_DIFF_MAX_ROWS) {
      truncated = true
      break
    }
    let text =
      entry.kind === 'add'
        ? redNewLines[entry.newLine - windowStartLine]!
        : redOldLines[entry.oldLine - windowStartLine]!
    if (text.length > TOOL_DIFF_MAX_ROW_CHARS) {
      // Truncate oversized row for display (counts unaffected); back up 1 code unit to avoid splitting UTF-16 surrogates.
      let cut = TOOL_DIFF_MAX_ROW_CHARS
      const prev = text.charCodeAt(cut - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1
      text = text.slice(0, cut)
      truncated = true
    }
    if (usedChars + text.length > TOOL_DIFF_MAX_TEXT_CHARS) {
      truncated = true
      break
    }
    usedChars += text.length
    if (entry.kind === 'context') {
      rows.push({ kind: 'context', oldLine: entry.oldLine, newLine: entry.newLine, text })
    } else if (entry.kind === 'remove') {
      rows.push({ kind: 'remove', oldLine: entry.oldLine, text })
    } else {
      rows.push({ kind: 'add', newLine: entry.newLine, text })
    }
  }
  return { rows, addedLines, removedLines, firstChangedLine, truncated }
}
