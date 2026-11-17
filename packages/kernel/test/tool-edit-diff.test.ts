/**
 * Real line-level diff result tests for the edit tool (runtime/tool-edit-diff.ts).
 *
 * Covers:
 * 1. Pure computeEditDiff: exact line numbers (real scan), +/-3 context lines, inline/multi-line/
 *    pure-deletion, CRLF, missing trailing newline, trailing empty lines, duplicate context, long line and row/text budget
 *    truncation (counts still reflect full diff), and no-op;
 * 2. Redaction safety: whole-text line-level redaction first (single-line secrets become placeholders); multi-line and
 *    window-spanning secrets (where per-window redaction would leak fragments) fall back to rows=[]/truncated=true with
 *    zero secret substrings in serialized output; line numbers/counts always reflect the original text;
 * 3. Tool level: local and remote share the same pure function (identical content produces identical diffs), structured
 *    output conforms to @helm/protocol EDIT_TOOL_RESULT_SCHEMA (validated via Ajv), literal
 *    replacement ($& is not interpreted), and failures (missing/duplicate match) never produce diffs or mutate files.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Ajv } from 'ajv'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDIT_TOOL_RESULT_SCHEMA,
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_TEXT_CHARS,
  type EditToolResult,
  type ToolDiffRow,
} from '@helm/protocol'
import { computeEditDiff } from '../src/runtime/tool-edit-diff.js'
import { createEditTool } from '../src/runtime/tools.js'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'

const identityRedact = (text: string): string => text

/** n lines 'l1..ln' with trailing newline. */
function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n'
}

/** Perform unique exact replacement for (original, oldText, newText) across full text. */
function applyEdit(original: string, oldText: string, newText: string): string {
  const offset = original.indexOf(oldText)
  assert.ok(offset >= 0, `test precondition: oldText must exist (${JSON.stringify(oldText.slice(0, 20))})`)
  return original.slice(0, offset) + newText + original.slice(offset + oldText.length)
}

function diffOf(original: string, oldText: string, newText: string, redact = identityRedact) {
  const offset = original.indexOf(oldText)
  return computeEditDiff(original, applyEdit(original, oldText, newText), offset, oldText.length, redact)
}

function rowTexts(rows: ToolDiffRow[]): string[] {
  return rows.map((row) => row.text)
}

/** Line-by-line assertion helper: verifies kind + line numbers + text for each row. */
function assertRows(actual: ToolDiffRow[], expected: ToolDiffRow[]): void {
  assert.deepEqual(actual, expected)
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-edit-diff-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('computeEditDiff pure function: line numbers and context window', { timeout: 60_000 }, () => {
  it('mid-file inline replacement: exact line numbers, +/-3 context window, line counts', { timeout: 60_000 }, () => {
    const original = numberedLines(12)
    const diff = diffOf(original, 'l7', 'L7')
    assert.equal(diff.truncated, false)
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 7)
    assertRows(diff.rows, [
      { kind: 'context', oldLine: 4, newLine: 4, text: 'l4' },
      { kind: 'context', oldLine: 5, newLine: 5, text: 'l5' },
      { kind: 'context', oldLine: 6, newLine: 6, text: 'l6' },
      { kind: 'remove', oldLine: 7, text: 'l7' },
      { kind: 'add', newLine: 7, text: 'L7' },
      { kind: 'context', oldLine: 8, newLine: 8, text: 'l8' },
      { kind: 'context', oldLine: 9, newLine: 9, text: 'l9' },
      { kind: 'context', oldLine: 10, newLine: 10, text: 'l10' },
    ])
  })

  it('deep prefix computes real line numbers from scan (line 100 edit -> window 97-103)', { timeout: 60_000 }, () => {
    const original = numberedLines(120)
    const diff = diffOf(original, 'l100', 'CHANGED')
    assert.equal(diff.firstChangedLine, 100)
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 97)
    const last = diff.rows[diff.rows.length - 1]!
    assert.equal(last.kind, 'context')
    assert.equal((last as { oldLine: number }).oldLine, 103)
    assert.ok(diff.rows.every((row) => row.text.length <= 7), 'window only covers lines 97-103 rather than diffing full file')
    // Context line numbers stay contiguous and oldLine === newLine (equal line counts in unchanged region).
    const contexts = diff.rows.filter((row) => row.kind === 'context') as Array<{ oldLine: number; newLine: number }>
    assert.ok(contexts.every((row) => row.oldLine === row.newLine))
  })

  it('beginning-of-file edit: window starts at line 1 without underflowing', { timeout: 60_000 }, () => {
    const original = numberedLines(8)
    const diff = diffOf(original, 'l1', 'FIRST')
    assert.equal(diff.firstChangedLine, 1)
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // Window covers changed line (line 1) +/-3: ends at line 4, not EOF.
    const last = diff.rows[diff.rows.length - 1] as { oldLine: number }
    assert.equal(last.oldLine, 4)
  })

  it('multi-line replacement: firstChangedLine and add/remove counts', { timeout: 60_000 }, () => {
    const original = numberedLines(12)
    const diff = diffOf(original, 'l5\nl6\n', 'n1\nn2\nn3\n')
    assert.equal(diff.addedLines, 3)
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 5)
    const removes = diff.rows.filter((r) => r.kind === 'remove') as Array<{ oldLine: number }>
    assert.deepEqual(removes.map((r) => r.oldLine), [5, 6])
    const adds = diff.rows.filter((r) => r.kind === 'add') as Array<{ newLine: number }>
    assert.deepEqual(adds.map((r) => r.newLine), [5, 6, 7])
    // Trailing context reflects line shift: old 7-9 <-> new 8-10.
    const tail = diff.rows.filter((r) => r.kind === 'context') as Array<{ oldLine: number; newLine: number }>
    const after = tail.filter((r) => r.oldLine >= 7)
    assert.deepEqual(
      after.map((r) => [r.oldLine, r.newLine]),
      [
        [7, 8],
        [8, 9],
        [9, 10],
      ],
    )
  })

  it('pure deletion (middle): firstChangedLine equals new line number at deletion point', { timeout: 60_000 }, () => {
    const original = '1\n2\n3\n4\n5\n'
    const diff = diffOf(original, '3\n', '')
    assert.equal(diff.addedLines, 0)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 3)
    assertRows(diff.rows, [
      { kind: 'context', oldLine: 1, newLine: 1, text: '1' },
      { kind: 'context', oldLine: 2, newLine: 2, text: '2' },
      { kind: 'remove', oldLine: 3, text: '3' },
      { kind: 'context', oldLine: 4, newLine: 3, text: '4' },
      { kind: 'context', oldLine: 5, newLine: 4, text: '5' },
    ])
  })

  it('pure deletion (EOF): firstChangedLine clamps to final line of new file', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc\n', 'c\n', '')
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2, 'new file has 2 lines total; EOF deletion selects final line')
  })

  it('deleting entire file: firstChangedLine clamps to 1 (Schema minimum)', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\n', 'a\nb\n', '')
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 1)
  })
})

describe('computeEditDiff pure function: line endings & edge cases', { timeout: 60_000 }, () => {
  it('CRLF: strips \\r from row text while preserving accurate line numbers and counts', { timeout: 60_000 }, () => {
    const original = 'a\r\nb\r\nc\r\n'
    const diff = diffOf(original, 'b', 'B')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2)
    assert.ok(rowTexts(diff.rows).every((text) => !text.includes('\r') && !text.includes('\n')))
    assertRows(diff.rows, [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'remove', oldLine: 2, text: 'b' },
      { kind: 'add', newLine: 2, text: 'B' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'c' },
    ])
  })

  it('mixed CRLF and LF around modified CRLF line', { timeout: 60_000 }, () => {
    const original = 'x\r\ny\nz'
    const diff = diffOf(original, 'x', 'X')
    assert.equal(diff.firstChangedLine, 1)
    assertRows(diff.rows, [
      { kind: 'remove', oldLine: 1, text: 'x' },
      { kind: 'add', newLine: 1, text: 'X' },
      { kind: 'context', oldLine: 2, newLine: 2, text: 'y' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'z' },
    ])
  })

  it('no trailing newline: final-line edit keeps accurate text and counters', { timeout: 60_000 }, () => {
    const original = 'a\nb\nc'
    const diff = diffOf(original, 'c', 'C')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 3)
    assertRows(diff.rows, [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'context', oldLine: 2, newLine: 2, text: 'b' },
      { kind: 'remove', oldLine: 3, text: 'c' },
      { kind: 'add', newLine: 3, text: 'C' },
    ])
  })

  it('replacement introducing trailing newline (c -> c\\n): accurate line-level diff', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc', 'c', 'c\n')
    // Replacing old final line 'c' (no newline) with 'c\n': line diff records 1 removed / >=1 added (includes newline transition).
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.addedLines >= 1, true)
  })

  it('trailing blank lines edited and replaced: blank lines have real line numbers', { timeout: 60_000 }, () => {
    const original = 'a\nb\n\n\n'
    const diff = diffOf(original, 'b\n\n\n', 'B\n')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 3)
    assert.equal(diff.firstChangedLine, 2)
    assertRows(diff.rows, [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'remove', oldLine: 2, text: 'b' },
      { kind: 'remove', oldLine: 3, text: '' },
      { kind: 'remove', oldLine: 4, text: '' },
      { kind: 'add', newLine: 2, text: 'B' },
    ])
  })

  it('duplicate context lines keep distinct real line numbers without collapsing', { timeout: 60_000 }, () => {
    const original = 'r\nr\nr\nTARGET\nr\nr\nr\n'
    const diff = diffOf(original, 'TARGET', 'DONE')
    const contexts = diff.rows.filter((r) => r.kind === 'context')
    assert.deepEqual(contexts.map((r) => r.oldLine), [1, 2, 3, 5, 6, 7])
    assert.deepEqual(rowTexts(contexts), ['r', 'r', 'r', 'r', 'r', 'r'])
  })

  it('intra-line insertion without adding/removing lines still produces remove old + add new line', { timeout: 60_000 }, () => {
    const diff = diffOf('alpha\nbeta\n', 'beta', 'bbeta')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2)
  })
})

describe('computeEditDiff pure function: budgets and truncation', { timeout: 60_000 }, () => {
  it('very long line: single row text caps at limit while counts cover full diff without echoing full line', { timeout: 60_000 }, () => {
    const long = 'x'.repeat(9_000)
    const original = `head\n${long}\ntail\n`
    const diff = diffOf(original, long, long.replace(/^x/, 'y'))
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    const changed = diff.rows.filter((r) => r.kind !== 'context')
    assert.equal(changed.length, 2)
    for (const row of changed) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS, `single line text <= ${TOOL_DIFF_MAX_ROW_CHARS}`)
      assert.ok(!row.text.includes('\n'))
    }
  })

  it('long-line truncation never splits UTF-16 surrogate pairs (no broken characters)', { timeout: 60_000 }, () => {
    // 1 BMP char + 3000 emoji (each 2 code units): truncation boundary lands mid-surrogate.
    const line = 'x' + '😊'.repeat(3_000)
    const original = `${line}\n`
    const diff = diffOf(original, 'x😊', 'x🚀')
    assert.equal(diff.truncated, true)
    for (const row of diff.rows.filter((r) => r.kind !== 'context')) {
      const last = row.text.charCodeAt(row.text.length - 1)
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'trailing char must never be an unpaired high surrogate')
    }
  })

  it('row count budget: rows <= 160, truncated=true, counts reflect full change', { timeout: 60_000 }, () => {
    const oldBlock = Array.from({ length: 200 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 200 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `before\n${oldBlock}after\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.ok(diff.rows.length <= TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, 'fixture far exceeds budget so rows should clamp exactly to max')
    // Counts are unaffected by row truncation.
    assert.equal(diff.removedLines, 200)
    assert.equal(diff.addedLines, 200)
    assert.equal(diff.firstChangedLine, 2)
  })

  it('cumulative text budget counts post-redaction text, caps total text, and sets truncated=true', { timeout: 60_000 }, () => {
    const line = 'c'.repeat(1_000)
    const oldBlock = Array.from({ length: 60 }, (_, i) => `${line}-old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 60 }, (_, i) => `${line}-new-${i}`).join('\n') + '\n'
    const original = oldBlock
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 60)
    assert.equal(diff.removedLines, 60)
    const total = rowTexts(diff.rows).reduce((sum, text) => sum + text.length, 0)
    assert.ok(total <= TOOL_DIFF_MAX_TEXT_CHARS, `cumulative text <= ${TOOL_DIFF_MAX_TEXT_CHARS}, actual ${total}`)
    assert.ok(diff.rows.length < 60, 'text budget should truncate before hitting row count budget')
  })

  it('no-op (oldText === newText): rows=[], counts=0, firstChangedLine=target line', { timeout: 60_000 }, () => {
    const original = numberedLines(10)
    const diff = diffOf(original, 'l4', 'l4')
    assert.deepEqual(diff, {
      rows: [],
      addedLines: 0,
      removedLines: 0,
      firstChangedLine: 4,
      truncated: false,
    })
  })

  it('out-of-bounds replaced range: precondition throws immediately before writing', { timeout: 60_000 }, () => {
    assert.throws(() => computeEditDiff('abc', 'abc', 3, 2, identityRedact), /Edit diff precondition failed/)
    assert.throws(() => computeEditDiff('abc', 'abc', -1, 1, identityRedact), /Edit diff precondition failed/)
    assert.throws(() => computeEditDiff('abc', 'abc', 0, 0, identityRedact), /Edit diff precondition failed/)
  })

  it('algorithm budget (maxEditLength) exceeded: falls back to block replacement, preserves common affixes and exact counts, truncated=true', { timeout: 60_000 }, () => {
    // Replacing 2100 old lines with 2100 new lines exceeds maxEditLength 2000 so diffLines stops short.
    const oldBlock = Array.from({ length: 2_100 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 2_100 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    // Block replacement fallback: explicitly flags truncated=true with counts matching block representation.
    assert.equal(diff.truncated, true)
    assert.equal(diff.removedLines, 2_100)
    assert.equal(diff.addedLines, 2_100)
    assert.equal(diff.firstChangedLine, 2, 'first change after common prefix (head) is at new line 2')
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, 'trimmed by row budget')
    // Preserves common prefix context: row 0 is head (line 1).
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // Removed lines in block representation start contiguously at old line 2.
    const firstRemove = diff.rows.find((r) => r.kind === 'remove') as { oldLine: number; text: string }
    assert.equal(firstRemove.oldLine, 2)
    assert.equal(firstRemove.text, 'old-0')
  })

  it('within-budget window at same scale avoids block fallback and emits minimal diff normally', { timeout: 60_000 }, () => {
    // Swapping 800 lines (edit length < 2000) produces a minimal diff rather than block fallback, proving the limit drives the branch.
    const oldBlock = Array.from({ length: 800 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 800 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.removedLines, 800)
    assert.equal(diff.addedLines, 800)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.truncated, true, 'row budget truncation is still marked')
    // Minimal diff and block representation happen to share counts here; verify consistent counts and firstChangedLine.
    assert.equal(diff.firstChangedLine, 2)
  })

  it('sparse changes retain context only around each hunk without discarding later hunks', { timeout: 60_000 }, () => {
    const original = Array.from({ length: 400 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
    const updated = original.replace('line-20\n', 'changed-20\n').replace('line-380\n', 'changed-380\n')
    const diff = computeEditDiff(original, updated, 0, original.length, (text) => text)
    assert.equal(diff.truncated, false)
    assert.equal(diff.addedLines, 2)
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 20)
    assert.equal(diff.rows.length, 16)
    assert.ok(diff.rows.some((row) => row.kind === 'add' && row.newLine === 20 && row.text === 'changed-20'))
    assert.ok(diff.rows.some((row) => row.kind === 'add' && row.newLine === 380 && row.text === 'changed-380'))
    const contexts = diff.rows.filter((row) => row.kind === 'context')
    assert.deepEqual(contexts.map((row) => row.oldLine), [17, 18, 19, 21, 22, 23, 377, 378, 379, 381, 382, 383])
  })
})

describe('computeEditDiff pure function: redaction', { timeout: 60_000 }, () => {
  it('single-line secret: row text shows placeholder while line numbers and counts match unredacted output', { timeout: 60_000 }, () => {
    const original = 'l1\nl2 token=s3cret-value\nl3\n'
    const redact = (text: string): string => text.split('s3cret-value').join('[REDACTED]')
    const plain = diffOf(original, 'l2', 'L2')
    const masked = diffOf(original, 'l2', 'L2', redact)
    assert.equal(masked.truncated, false)
    assert.equal(masked.addedLines, plain.addedLines)
    assert.equal(masked.removedLines, plain.removedLines)
    assert.equal(masked.firstChangedLine, plain.firstChangedLine)
    const serialized = JSON.stringify(masked)
    assert.ok(!serialized.includes('s3cret-value'), 'serialized output must not contain secret')
    assert.ok(serialized.includes('[REDACTED]'), 'line containing secret shows placeholder')
    // Line numbers match true source lines consistently with unredacted pass.
    assert.deepEqual(
      masked.rows.map((r) => r.kind),
      plain.rows.map((r) => r.kind),
    )
  })

  it('multi-line secret (containing newline): line count shifts so falls back to rows=[]/truncated=true while counts match original text', { timeout: 60_000 }, () => {
    const original = 'a\nHEAD\nTAIL\nb\n'
    // Secret 'HEAD\nTAIL' spans lines 2 and 3; full redaction reduces 4 lines to 3.
    const redact = (text: string): string => text.split('HEAD\nTAIL').join('[X]')
    const diff = diffOf(original, 'b', 'B', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [], 'must not emit rows when redaction changes line count (cannot align real line numbers)')
    // Counts and firstChangedLine reflect actual edit in unredacted text (b -> B on line 4).
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 4)
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('HEAD') && !serialized.includes('TAIL'))
  })

  it('window-boundary-spanning multi-line secret: redacting full text first prevents leftover fragment leakage', { timeout: 60_000 }, () => {
    // Window covers lines 3-9 (editing line 6); secret spans lines 2/3 across window boundary.
    // Trimming window before redacting would leave 'BOUNDARY-TAIL' inside window unmatched and leaked.
    const original =
      'l1\npre BOUNDARY-HEAD\nBOUNDARY-TAIL l3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'
    const secret = 'BOUNDARY-HEAD\nBOUNDARY-TAIL'
    const redact = (text: string): string => text.split(secret).join('[X]')
    const diff = diffOf(original, 'l6', 'L6', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [])
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('BOUNDARY-TAIL'), 'secret fragment inside window must never leak')
    assert.ok(!serialized.includes('BOUNDARY-HEAD'))
    // Counts still match the original diff.
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 6)
  })

  it('secret only outside window: full-text redaction keeps line count invariant, window renders cleanly without secret', { timeout: 60_000 }, () => {
    const original = 'secret-line=s3cret\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'
    const redact = (text: string): string => text.split('s3cret').join('[R]')
    const diff = diffOf(original, 'l5', 'L5', redact)
    assert.equal(diff.truncated, false)
    assert.equal(diff.firstChangedLine, 5)
    assert.ok(!JSON.stringify(diff).includes('s3cret'), 'serialized output must not contain secret')
    // Window starts at line 2 (5 - 3): secret on line 1 stays outside window and never appears in rows.
    const contexts = diff.rows.filter((r) => r.kind === 'context') as Array<{ oldLine: number; text: string }>
    assert.equal(contexts[0]!.oldLine, 2, 'window starts at line 2')
    assert.ok(rowTexts(diff.rows).every((text) => !text.includes('[R]')), 'window rows exclude redaction placeholders when secret is outside window')
  })
})

// ---------------------------------------------------------------------------
// Tool level (real execution)
// ---------------------------------------------------------------------------

function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-test-1',
    registry: { tools: [] },
    agent: async () => ({ cwd }),
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: () => {},
    outputWindow: undefined,
    retainedOutput: () => ({ text: '', truncated: false }),
    diagnostic: () => {},
    details: async () => undefined,
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('not used in test')
    },
    getTask: () => undefined,
    waitForTask: async () => {
      throw new Error('not used in test')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('not used in test')
    },
  } as never
}

async function makeRealDeps(dir: string, stash = new SecretStash()): Promise<HelmToolDeps> {
  await ensureDataDir(dir)
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts,
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validateEditResult = ajv.compile<EditToolResult>(EDIT_TOOL_RESULT_SCHEMA)

function assertSchemaValid(structured: unknown): EditToolResult {
  assert.ok(validateEditResult(structured), `structuredOutput must satisfy EDIT_TOOL_RESULT_SCHEMA: ${JSON.stringify(validateEditResult.errors)}`)
  return structured
}

/** Controlled remote env backed by an in-memory file map (aligned with file-mutation-queue.test.ts). */
function makeRemoteEnv(files: Map<string, string>) {
  return {
    id: 'remote:test-node',
    async absolutePath(path: string) {
      return { ok: true as const, value: path }
    },
    async joinPath(parts: string[]) {
      const segs: string[] = []
      for (const seg of parts.join('/').split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') segs.pop()
        else segs.push(seg)
      }
      return { ok: true as const, value: '/' + segs.join('/') }
    },
    async canonicalPath(path: string) {
      if (files.has(path)) return { ok: true as const, value: path }
      return { ok: false as const, error: { code: 'not_found', message: `ENOENT: ${path}` } }
    },
    async readTextFile(path: string) {
      const content = files.get(path)
      if (content === undefined) return { ok: false as const, error: { code: 'not_found', message: `ENOENT: ${path}` } }
      return { ok: true as const, value: content }
    },
    async writeFile(path: string, content: string) {
      files.set(path, content)
      return { ok: true as const, value: void 0 }
    },
    async createDir() {
      return { ok: true as const, value: void 0 }
    },
  }
}

function makeStubFabric(env: ReturnType<typeof makeRemoteEnv>): EnvFabric {
  return {
    envFor: () => env as never,
    envForTarget: () => env as never,
    isOnline: () => true,
    waitForOnline: () => Promise.resolve(true),
    getNodeHubUrl: () => 'http://10.0.0.5:3202',
    evictConversation: () => undefined,
    dispose: () => Promise.resolve(),
  } as never
}

describe('edit tool: real local diff structured output', { timeout: 60_000 }, () => {
  it('local: structured output satisfies protocol Schema with exact diff rows/counts; newText written literally ($& unexpanded)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'tool-local')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    const file = join(dir, 'code.ts')
    writeFileSync(file, 'alpha\nbeta gamma\nomega\n')
    const result = await createEditTool(deps).execute(
      { path: 'code.ts', oldText: 'beta gamma', newText: 'BETA $& \\1' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = assertSchemaValid(result.structuredOutput)
    // details drives persistent UI diff rendering and must match structuredOutput and satisfy Schema.
    assert.deepEqual(assertSchemaValid(result.details), structured)
    assert.equal(structured.path, file)
    assert.equal(structured.nodeId, 'local')
    assert.equal(structured.replaced, true)
    assert.equal(structured.diff.addedLines, 1)
    assert.equal(structured.diff.removedLines, 1)
    assert.equal(structured.diff.firstChangedLine, 2)
    assert.equal(structured.diff.truncated, false)
    assert.deepEqual(structured.diff.rows, [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'alpha' },
      { kind: 'remove', oldLine: 2, text: 'beta gamma' },
      { kind: 'add', newLine: 2, text: 'BETA $& \\1' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'omega' },
    ])
    // Content and diff share the same literal substitution ($& is never treated as a backreference).
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA $& \\1\nomega\n')
  })

  it('failures (missing / multiple matches): returns isError without structured diff and leaves file bytes untouched', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'tool-fail')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    const file = join(dir, 'dup.txt')
    writeFileSync(file, 'a\nsame\nb\nsame\nc\n')
    const tool = createEditTool(deps)
    const missing = await tool.execute({ path: 'dup.txt', oldText: 'nope', newText: 'x' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(missing.isError, true)
    assert.equal(missing.structuredOutput, undefined)
    const dup = await tool.execute({ path: 'dup.txt', oldText: 'same\n', newText: 'x' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dup.isError, true)
    assert.equal(dup.structuredOutput, undefined)
    assert.ok((dup.output as Array<{ text: string }>)[0]!.text.includes('appeared 2 times'))
    assert.equal(readFileSync(file, 'utf8'), 'a\nsame\nb\nsame\nc\n', 'failed edit path must preserve original file')
  })

  it('real SecretStash redaction flows through structured output (no leakage even on truncated long lines)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'tool-redact')
    mkdirSync(dir, { recursive: true })
    const stash = new SecretStash()
    stash.addRedaction('hunter2-super-secret')
    const deps = await makeRealDeps(dir, stash)
    const file = join(dir, 'env.txt')
    const padding = 'p'.repeat(6_000)
    writeFileSync(file, `# config\nkey=hunter2-super-secret ${padding}\nend\n`)
    const result = await createEditTool(deps).execute(
      { path: 'env.txt', oldText: '# config', newText: '# changed' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = assertSchemaValid(result.structuredOutput)
    const serialized = JSON.stringify(structured)
    assert.ok(!serialized.includes('hunter2-super-secret'), 'serialized output must not contain secret')
    assert.ok(serialized.includes('[REDACTED]'))
    // details mirrors the redacted object so persisted UI channel never leaks secrets either.
    assert.ok(!JSON.stringify(result.details).includes('hunter2-super-secret'), 'details must not contain secret')
    // Very long line containing secret gets truncated cleanly while budgets and counts remain intact.
    assert.equal(structured.diff.truncated, true)
    assert.equal(structured.diff.removedLines, 1)
    assert.equal(structured.diff.addedLines, 1)
    for (const row of structured.diff.rows) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS)
    }
  })
})

describe('edit tool: remote shares identical pure diff function', { timeout: 60_000 }, () => {
  it('remote and local emit identical diffs for identical content and write back to remote file map', { timeout: 60_000 }, async () => {
    // Local side (real disk)
    const localDir = join(rootDir, 'share-local')
    mkdirSync(localDir, { recursive: true })
    const content = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
    writeFileSync(join(localDir, 'same.txt'), content)
    const localDeps = await makeRealDeps(localDir)
    const localResult = await createEditTool(localDeps).execute(
      { path: 'same.txt', oldText: 'five', newText: 'FIVE' },
      makeApi(localDir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!localResult.isError, false)

    // Remote side (in-memory file map + stub fabric)
    const remoteDir = join(rootDir, 'share-remote')
    const remoteDeps = await makeRealDeps(remoteDir)
    const files = new Map<string, string>([['/workspace/same.txt', content]])
    const env = makeRemoteEnv(files)
    const fabric = makeStubFabric(env)
    const remoteWithFabric: HelmToolDeps = { ...remoteDeps, envFabric: fabric, nodeIdOf: () => 'test-node' }
    const remoteResult = await createEditTool(remoteWithFabric).execute(
      { path: 'same.txt', oldText: 'five', newText: 'FIVE' },
      makeApi('/workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!remoteResult.isError, false)
    const remoteStructured = assertSchemaValid(remoteResult.structuredOutput)
    assert.equal(remoteStructured.nodeId, 'test-node')
    assert.equal(remoteStructured.path, '/workspace/same.txt')
    // Both paths share the exact same pure diff computation (all fields match except nodeId/path).
    const localStructured = assertSchemaValid(localResult.structuredOutput)
    assert.deepEqual(remoteStructured.diff, localStructured.diff)
    assert.equal(files.get('/workspace/same.txt'), content.replace('five', 'FIVE'))
  })

  it('remote oldText missing: fails cleanly without altering remote file map or emitting structured output', { timeout: 60_000 }, async () => {
    const remoteDir = join(rootDir, 'remote-fail')
    const remoteDeps = await makeRealDeps(remoteDir)
    const files = new Map<string, string>([['/workspace/x.txt', 'a\nb\n']])
    const env = makeRemoteEnv(files)
    const fabric = makeStubFabric(env)
    const deps: HelmToolDeps = { ...remoteDeps, envFabric: fabric, nodeIdOf: () => 'test-node' }
    const result = await createEditTool(deps).execute(
      { path: 'x.txt', oldText: 'zzz', newText: 'y' },
      makeApi('/workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    assert.equal(result.structuredOutput, undefined)
    assert.equal(files.get('/workspace/x.txt'), 'a\nb\n')
  })
})
