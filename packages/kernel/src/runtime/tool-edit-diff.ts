/**
 * edit tool real difference compute (unique implement;local and remote two execute path sharing).
 *
 * contract (and @helm/protocol  EDIT_TOOL_RESULT_SCHEMA align):
 * - input is unique precise replace completed before after all text and replace zone between:original(change before all text),
 *   updated(change after all text, and actual content consistent),matchOffset / replacedLength
 *   (oldText in original in unique match zone between). pre- condition by break when immediately throws
 *   (caller in write before compute, throws i.e. edit_failed, file not by modify);
 * - difference only compute replace involves complete row ±3 row context window (do not diff whole large file);
 *   row number from for original real row scan (accept prefix line scan, do not is O(change)
 *   sacrifice correct);
 * - redaction first row: for original / updated all text respectively redact after again by row number take window row
 *   (first cut piece again redaction will leak leak horizontal across window boundary many row secret in window inside leftover segment);
 * - row number and count always reverse reflect original text:addedLines / removedLines / firstChangedLine
 *   based on not redaction window diffLines row level difference, override complete difference,rows pre- compute truncate do not
 *   affect count;
 * - if all text redaction change row count (secret itself contains newline, replace placeholder excludes newline, row count only can
 *   reduce and as long as each other etc. i.e. boundary not motion), window row cannot again for should real file row number - - directly
 *   rows=[] + truncated=true and keep original text count, never fabricate row number, never leak leak secret;
 * - pre- compute with redaction after text count:rows ≤ TOOL_DIFF_MAX_ROWS, single row text ≤
 *   TOOL_DIFF_MAX_ROW_CHARS(over long row truncate show, count still by complete row), cumulative text ≤
 *   TOOL_DIFF_MAX_TEXT_CHARS; any form truncate all placement truncated=true;
 * - algorithm level pre- compute:diffLines carries maxEditLength(over limit return undefined), large segment
 *   each other different replace never without cap block kernel; over limit when retreat is whole segment replace means - - strip public
 *   before suffix row after remove all old row / add all new row (valid but non- most small difference), count and
 *   the means consistent, and explicit placement truncated=true;
 * - no-op(updated === original, i.e. tool allows oldText === newText):rows=[],
 *   counts=0,firstChangedLine=replace which in row.
 */

import { diffLines } from 'diff'
import {
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_TEXT_CHARS,
  type ToolDiffRow,
  type ToolEditDiff,
} from '@helm/protocol'

/** replace involves row on under each keep context row count. */
const EDIT_CONTEXT_LINES = 3

/**
 * diffLines algorithm pre- compute (edit length): row pre- compute TOOL_DIFF_MAX_ROWS ten remaining multiple - -
 * exceeds it most small difference increase delete row count must far over row pre- compute (forever cannot complete render), whole segment replace
 * means do not loss lose can render information, also seal top kernel compute overhead.
 */
const EDIT_DIFF_MAX_EDIT_LENGTH = 2_000

const LF = 10
const CR = 13

/** row count:'' is 0 row; with \n counter, tail not newline patch 1(and splitLineTexts consistent). */
function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) newlines += 1
  }
  return text.charCodeAt(text.length - 1) === LF ? newlines : newlines + 1
}

/** by row split (strip row tail \n and tight neighbor \r; keep empty row;'' → []). */
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
 * row start point scan:lineStarts[k] is k+1 row start point; tail \n after without content,
 * does not enable empty row (and countLines/splitLineTexts row count opening path consistent); empty string without row.
 */
function scanLineStarts(original: string): number[] {
  if (original === '') return []
  const lineStarts = [0]
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === LF && i + 1 < original.length) lineStarts.push(i + 1)
  }
  return lineStarts
}

/** offset which in row (1 base):lineStarts rise order, two locate finally a start point ≤ offset row. */
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

/** diff row skeleton (row number real; text later by row number from redaction window row take). */
type SkeletonRow =
  | { kind: 'context'; oldLine: number; newLine: number }
  | { kind: 'remove'; oldLine: number }
  | { kind: 'add'; newLine: number }

/** let row count pre- compute takes precedence to real change, avoid large replace fragment in not change row squeeze after continue change. */
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
 * in unique precise replace before after all text and match zone between on generate ToolEditDiff(pure function, without IO).
 *
 * redact must satisfy: replace placeholder excludes newline (SecretStash  [REDACTED] system column satisfy);
 * all text redaction after row count do not change i.e. verify no any newline at secret internal, window row and original text row one one for
 * should, row number real. violate reverse when by contract away rows=[] fall back, do not fabricate.
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
      `edit diff pre- condition failed: replace zone between [${matchOffset}, ${matchOffset + replacedLength}) out of bounds (file ${original.length} character)`,
    )
  }
  const lineStarts = scanLineStarts(original)
  const totalLines = lineStarts.length
  const firstLine = lineAt(lineStarts, matchOffset)
  const lastLine = lineAt(lineStarts, matchOffset + replacedLength - 1)
  // no-op(tool allows oldText === newText): without difference can render, row number points to replace where.
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

  // row level difference skeleton and count (original text, not redaction): row number/count reverse reflect real change.
  let addedLines = 0
  let removedLines = 0
  let firstChanged = 0
  const skeleton: SkeletonRow[] = []
  // algorithm pre- compute over limit: retreat whole segment replace means (valid but non- most small), count and the means consistent.
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
          // pure delete first change row take delete point new file row (its after first context/new increase row same number;
          // EOF delete then under row unify clamp to new file end row).
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
  // first change row (new file row number): clamp to new file real row count (EOF delete take end row; new file is empty take 1).
  const firstChangedLine =
    firstChanged === 0 ? firstLine : Math.min(firstChanged, Math.max(1, countLines(updated)))

  // redaction first row: for before after all text respectively redact(across window boundary many row secret therefore whole hit).
  const redOriginal = redact(original)
  const redUpdated = redact(updated)
  if (countLines(redOriginal) !== totalLines || countLines(redUpdated) !== countLines(updated)) {
    // all text redaction change row count (secret contains newline): window row cannot for should real row number. honest fall back:
    // do not render row (never leak leak), count and first change row keep original text compute result.
    return { rows: [], addedLines, removedLines, firstChangedLine, truncated: true }
  }
  // row count do not change ⇒ newline not by any secret contains ⇒ redaction before after row boundary one by one row for should;
  // window row = redaction all text by row number trim (new window occupy new file windowStartLine start
  // countLines(rawNewWindow) row: window before each row original not motion).
  const newWindowCount = countLines(rawNewWindow)
  const redOldLines = splitLineTexts(redOriginal).slice(windowStartLine - 1, windowEndLine)
  const redNewLines = splitLineTexts(redUpdated).slice(
    windowStartLine - 1,
    windowStartLine - 1 + newWindowCount,
  )

  // pre- compute (by redaction after text): row count, single row length, cumulative text; any truncate all placement truncated.
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
      // over long row truncate show (count do not change); retreat one avoid cut cut UTF-16 proxy for.
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
