/**
 * edit tool real difference result (runtime/tool-edit-diff.ts) test.
 *
 * override:
 * 1. pure function computeEditDiff: precise row number (real scan),±3 context window, row inside/many row/
 *    pure increase delete,CRLF, tail without newline, tail part empty row, duplicate context, huge long row and row count/text pre- compute
 *    truncate (count still override complete difference),no-op;
 * 2. redaction security: all text first row redaction (single row secret hit placeholder); across row secret and horizontal across window boundary
 *    secret (window cut piece redaction will leak leak form) must fall back rows=[]/truncated=true and
 *    serialization result without any secret leftover segment; row number/count always reverse reflect original text;
 * 3. tool level:local and remote sharing the same pure function (same content produce out fully consistent diff), structure
 *    output conforms to @helm/protocol EDIT_TOOL_RESULT_SCHEMA(Ajv real validate), literal
 *    replace ($& do not explain), failed (missing/many time) never produce succeeded diff and file do not change.
 */

import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
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

/** n row 'l1..ln', end row carries newline. */
function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n'
}

/** for (original, oldText, newText) do unique precise replace after all text. */
function applyEdit(original: string, oldText: string, newText: string): string {
  const offset = original.indexOf(oldText)
  assert.ok(offset >= 0, `test pre-:oldText should store in (${JSON.stringify(oldText.slice(0, 20))})`)
  return original.slice(0, offset) + newText + original.slice(offset + oldText.length)
}

function diffOf(original: string, oldText: string, newText: string, redact = identityRedact) {
  const offset = original.indexOf(oldText)
  return computeEditDiff(original, applyEdit(original, oldText, newText), offset, oldText.length, redact)
}

function rowTexts(rows: ToolDiffRow[]): string[] {
  return rows.map((row) => row.text)
}

/** all row level assertion auxiliary: one by one row kind + row number + text. */
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

describe('computeEditDiff pure function: row number and window', { timeout: 60_000 }, () => {
  it('row inside replace: precise row number,±3 context window, row level count', { timeout: 60_000 }, () => {
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

  it('large prefix under row number from real scan ( 100 row edit, window 97-103)', { timeout: 60_000 }, () => {
    const original = numberedLines(120)
    const diff = diffOf(original, 'l100', 'CHANGED')
    assert.equal(diff.firstChangedLine, 100)
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 97)
    const last = diff.rows[diff.rows.length - 1]!
    assert.equal(last.kind, 'context')
    assert.equal((last as { oldLine: number }).oldLine, 103)
    assert.ok(diff.rows.every((row) => row.text.length <= 7), 'window only override 97-103 row (do not diff all file)')
    // context row number connect continue and oldLine === newLine(not change zone between row number consistent).
    const contexts = diff.rows.filter((row) => row.kind === 'context') as Array<{ oldLine: number; newLine: number }>
    assert.ok(contexts.every((row) => row.oldLine === row.newLine))
  })

  it('file open head edit: window from 1 row start (do not out of bounds)', { timeout: 60_000 }, () => {
    const original = numberedLines(8)
    const diff = diffOf(original, 'l1', 'FIRST')
    assert.equal(diff.firstChangedLine, 1)
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // window is involves row ( 1 row)±3: end row is 4 row, while non- file tail.
    const last = diff.rows[diff.rows.length - 1] as { oldLine: number }
    assert.equal(last.oldLine, 4)
  })

  it('many row replace: first change row and increase delete count', { timeout: 60_000 }, () => {
    const original = numberedLines(12)
    const diff = diffOf(original, 'l5\nl6\n', 'n1\nn2\nn3\n')
    assert.equal(diff.addedLines, 3)
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 5)
    const removes = diff.rows.filter((r) => r.kind === 'remove') as Array<{ oldLine: number }>
    assert.deepEqual(removes.map((r) => r.oldLine), [5, 6])
    const adds = diff.rows.filter((r) => r.kind === 'add') as Array<{ newLine: number }>
    assert.deepEqual(adds.map((r) => r.newLine), [5, 6, 7])
    // change after context row number wrong:old 7-9 ↔ new 8-10(row number jump real).
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

  it('pure delete (in part):firstChangedLine is delete point new row number', { timeout: 60_000 }, () => {
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

  it('pure delete (EOF):firstChangedLine clamp to new file end row', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc\n', 'c\n', '')
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2, 'new file shared 2 row,EOF delete take end row')
  })

  it('whole file delete empty:firstChangedLine clamp to 1(Schema most small value)', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\n', 'a\nb\n', '')
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 1)
  })
})

describe('computeEditDiff pure function: row boundary form', { timeout: 60_000 }, () => {
  it('CRLF: row text strip \r, row number and count correct', { timeout: 60_000 }, () => {
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

  it('CRLF and LF mixed and change contains CRLF row', { timeout: 60_000 }, () => {
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

  it('tail without newline: end row edit row text without newline and counter correct', { timeout: 60_000 }, () => {
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

  it('replace introduce tail newline (c -> c\n): real row level difference', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc', 'c', 'c\n')
    // old end row 'c'(without newline) by 'c\n' replace: row level difference table now is delete 1 increase 1(contains end row newline change).
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.addedLines >= 1, true)
  })

  it('tail part empty row reference and replace: empty row row number real', { timeout: 60_000 }, () => {
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

  it('duplicate context: same text different row number (row number real do not collapse)', { timeout: 60_000 }, () => {
    const original = 'r\nr\nr\nTARGET\nr\nr\nr\n'
    const diff = diffOf(original, 'TARGET', 'DONE')
    const contexts = diff.rows.filter((r) => r.kind === 'context')
    assert.deepEqual(contexts.map((r) => r.oldLine), [1, 2, 3, 5, 6, 7])
    assert.deepEqual(rowTexts(contexts), ['r', 'r', 'r', 'r', 'r', 'r'])
  })

  it('row inside pure insert (without whole row increase delete): still is delete old row increase new row', { timeout: 60_000 }, () => {
    const diff = diffOf('alpha\nbeta\n', 'beta', 'bbeta')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2)
  })
})

describe('computeEditDiff pure function: pre- compute and truncate', { timeout: 60_000 }, () => {
  it('huge long row: single row text truncate to cap, count override complete difference, does not huge long row pass back', { timeout: 60_000 }, () => {
    const long = 'x'.repeat(9_000)
    const original = `head\n${long}\ntail\n`
    const diff = diffOf(original, long, long.replace(/^x/, 'y'))
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    const changed = diff.rows.filter((r) => r.kind !== 'context')
    assert.equal(changed.length, 2)
    for (const row of changed) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS, `single row text ≤ ${TOOL_DIFF_MAX_ROW_CHARS}`)
      assert.ok(!row.text.includes('\n'))
    }
  })

  it('huge long row truncate avoid open UTF-16 proxy for (produces no half character)', { timeout: 60_000 }, () => {
    // 1  BMP character + 3000  emoji(each 2 code unit): truncate point in high proxy items on.
    const line = 'x' + '😊'.repeat(3_000)
    const original = `${line}\n`
    const diff = diffOf(original, 'x😊', 'x🚀')
    assert.equal(diff.truncated, true)
    for (const row of diff.rows.filter((r) => r.kind !== 'context')) {
      const last = row.text.charCodeAt(row.text.length - 1)
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'end character must not is isolated high proxy items')
    }
  })

  it('row count pre- compute:rows ≤ 160,truncated=true, count override complete difference', { timeout: 60_000 }, () => {
    const oldBlock = Array.from({ length: 200 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 200 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `before\n${oldBlock}after\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.ok(diff.rows.length <= TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, 'this example skeleton far over pre- compute, should exactly trim to cap')
    // count do not subject to rows truncate affect.
    assert.equal(diff.removedLines, 200)
    assert.equal(diff.addedLines, 200)
    assert.equal(diff.firstChangedLine, 2)
  })

  it('cumulative text pre- compute: with redaction after text count, total text do not over limit and truncated=true', { timeout: 60_000 }, () => {
    const line = 'c'.repeat(1_000)
    const oldBlock = Array.from({ length: 60 }, (_, i) => `${line}-old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 60 }, (_, i) => `${line}-new-${i}`).join('\n') + '\n'
    const original = oldBlock
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 60)
    assert.equal(diff.removedLines, 60)
    const total = rowTexts(diff.rows).reduce((sum, text) => sum + text.length, 0)
    assert.ok(total <= TOOL_DIFF_MAX_TEXT_CHARS, `cumulative text ≤ ${TOOL_DIFF_MAX_TEXT_CHARS}, actual ${total}`)
    assert.ok(diff.rows.length < 60, 'text pre- compute should first at row count pre- compute truncate')
  })

  it('no-op(oldText === newText):rows=[] counts=0 firstChangedLine=replace which in row', { timeout: 60_000 }, () => {
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

  it('replace zone between out of bounds: pre- condition immediately throws (write before failed)', { timeout: 60_000 }, () => {
    assert.throws(() => computeEditDiff('abc', 'abc', 3, 2, identityRedact), /pre- condition failed/)
    assert.throws(() => computeEditDiff('abc', 'abc', -1, 1, identityRedact), /pre- condition failed/)
    assert.throws(() => computeEditDiff('abc', 'abc', 0, 0, identityRedact), /pre- condition failed/)
  })

  it('algorithm pre- compute (maxEditLength) over limit: whole segment replace means, public before suffix keep, count consistent,truncated=true', { timeout: 60_000 }, () => {
    // 2100 row old chunk replace is 2100 row all new new chunk: edit length far over pre- compute 2000,diffLines over limit.
    const oldBlock = Array.from({ length: 2_100 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 2_100 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    // whole segment replace means:truncated explicit mark record (non- most small difference), count and the means consistent.
    assert.equal(diff.truncated, true)
    assert.equal(diff.removedLines, 2_100)
    assert.equal(diff.addedLines, 2_100)
    assert.equal(diff.firstChangedLine, 2, 'public prefix (head) after one where change in new file 2 row')
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, 'row pre- compute trim')
    // skeleton keep public before suffix context: first row is head( 1 row).
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // whole segment means remove row connect continue from old window 2 row start.
    const firstRemove = diff.rows.find((r) => r.kind === 'remove') as { oldLine: number; text: string }
    assert.equal(firstRemove.oldLine, 2)
    assert.equal(firstRemove.text, 'old-0')
  })

  it('algorithm pre- compute inside same rule mode window does not trigger whole segment means (most small difference normal produce out)', { timeout: 60_000 }, () => {
    // 800 row mutual swap (edit length < 2000): produce out most small difference while non- whole segment replace; same rule mode guarantee
    // two branch rule mode fairly, over limit behavior indeed by edit length drive.
    const oldBlock = Array.from({ length: 800 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 800 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.removedLines, 800)
    assert.equal(diff.addedLines, 800)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.truncated, true, 'row pre- compute truncate still such as mark record')
    // most small difference and whole segment means in this construct under skeleton etc. price (all amount delete/all amount increase), difference in over limit branch
    // by pre- compute drive; this in verify count consistent and first change row identical.
    assert.equal(diff.firstChangedLine, 2)
  })

  it('sparse change only keep each change surrounding context, row count pre- compute do not swallow after continue change', { timeout: 60_000 }, () => {
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
  it('single row secret: row text replace is placeholder, row number/count and not redaction consistent', { timeout: 60_000 }, () => {
    const original = 'l1\nl2 token=s3cret-value\nl3\n'
    const redact = (text: string): string => text.split('s3cret-value').join('[REDACTED]')
    const plain = diffOf(original, 'l2', 'L2')
    const masked = diffOf(original, 'l2', 'L2', redact)
    assert.equal(masked.truncated, false)
    assert.equal(masked.addedLines, plain.addedLines)
    assert.equal(masked.removedLines, plain.removedLines)
    assert.equal(masked.firstChangedLine, plain.firstChangedLine)
    const serialized = JSON.stringify(masked)
    assert.ok(!serialized.includes('s3cret-value'), 'serialization result must not contains secret')
    assert.ok(serialized.includes('[REDACTED]'), 'hit secret row show placeholder')
    // row number still is real row number (and not redaction run consistent).
    assert.deepEqual(
      masked.rows.map((r) => r.kind),
      plain.rows.map((r) => r.kind),
    )
  })

  it('across row secret (contains newline): row count change, fall back rows=[]/truncated=true, count keep original text', { timeout: 60_000 }, () => {
    const original = 'a\nHEAD\nTAIL\nb\n'
    // secret 'HEAD\nTAIL' horizontal across 2,3 row; whole value redaction after row count 4 -> 3.
    const redact = (text: string): string => text.split('HEAD\nTAIL').join('[X]')
    const diff = diffOf(original, 'b', 'B', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [], 'row count by redaction change when never render row (cannot for should real row number)')
    // count and first change row still is original text real difference (b -> B in 4 row).
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 4)
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('HEAD') && !serialized.includes('TAIL'))
  })

  it('horizontal across window boundary many row secret: all text first row redaction, window inside leftover segment never leak leak', { timeout: 60_000 }, () => {
    // window is 3-9 row (edit 6 row); secret horizontal across 2/3 row (window boundary).
    // if first trim window again redaction, window inside 'BOUNDARY-TAIL' leftover segment hit do not whole value secret while leak leak.
    const original =
      'l1\npre BOUNDARY-HEAD\nBOUNDARY-TAIL l3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'
    const secret = 'BOUNDARY-HEAD\nBOUNDARY-TAIL'
    const redact = (text: string): string => text.split(secret).join('[X]')
    const diff = diffOf(original, 'l6', 'L6', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [])
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('BOUNDARY-TAIL'), 'window inside secret leftover segment must not leak leak')
    assert.ok(!serialized.includes('BOUNDARY-HEAD'))
    // count still is original text real difference.
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 6)
  })

  it('secret only in window outside row: all text redaction row count do not change, window row per common render and without secret', { timeout: 60_000 }, () => {
    const original = 'secret-line=s3cret\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'
    const redact = (text: string): string => text.split('s3cret').join('[R]')
    const diff = diffOf(original, 'l5', 'L5', redact)
    assert.equal(diff.truncated, false)
    assert.equal(diff.firstChangedLine, 5)
    assert.ok(!JSON.stringify(diff).includes('s3cret'), 'serialization result must not contains secret')
    // window from 2 row start ( 5 row - 3): contains secret 1 row do not in window inside, also do not appear in any row text.
    const contexts = diff.rows.filter((r) => r.kind === 'context') as Array<{ oldLine: number; text: string }>
    assert.equal(contexts[0]!.oldLine, 2, 'window first row is 2 row')
    assert.ok(rowTexts(diff.rows).every((text) => !text.includes('[R]')), 'window row excludes redaction placeholder (secret do not in window inside)')
  })
})

// ---------------------------------------------------------------------------
// tool level (real execute)
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
      throw new Error('test does not use')
    },
    getTask: () => undefined,
    waitForTask: async () => {
      throw new Error('test does not use')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('test does not use')
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
  assert.ok(validateEditResult(structured), `structure output should conforms to EDIT_TOOL_RESULT_SCHEMA:${JSON.stringify(validateEditResult.errors)}`)
  return structured
}

/** subject to control remote env: real memory file table (align file-mutation-queue.test.ts pattern). */
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

describe('edit tool:local real difference structure output', { timeout: 60_000 }, () => {
  it('local: structure output conforms to protocol Schema,diff row number/text/count real;newText literal write ($& do not explain)', { timeout: 60_000 }, async () => {
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
    // details is persist UI channel (Web difference render read it), must and structuredOutput
    // same value and same conforms to protocol Schema.
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
    // content and diff same source:newText literal write,$& never by explain is reverse reference.
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA $& \\1\nomega\n')
  })

  it('failed (missing/many time appear):isError and never produce succeeded diff, file byte do not change', { timeout: 60_000 }, async () => {
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
    assert.ok((dup.output as Array<{ text: string }>)[0]!.text.includes('appear 2 time'))
    assert.equal(readFileSync(file, 'utf8'), 'a\nsame\nb\nsame\nc\n', 'failed path file must keep original')
  })

  it('real SecretStash redaction throughout structure output (huge long row truncate still without leaking)', { timeout: 60_000 }, async () => {
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
    assert.ok(!serialized.includes('hunter2-super-secret'), 'serialization result must not contains secret')
    assert.ok(serialized.includes('[REDACTED]'))
    // details mirror the same redaction after object: persist UI channel same without leaking.
    assert.ok(!JSON.stringify(result.details).includes('hunter2-super-secret'), 'details must not contains secret')
    // contains secret huge long row by truncate show: pre- compute takes effect and count complete.
    assert.equal(structured.diff.truncated, true)
    assert.equal(structured.diff.removedLines, 1)
    assert.equal(structured.diff.addedLines, 1)
    for (const row of structured.diff.rows) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS)
    }
  })
})

describe('edit tool: remote sharing the same pure function', { timeout: 60_000 }, () => {
  it('remote and local for same content produce out fully consistent diff; file write back remote memory file table', { timeout: 60_000 }, async () => {
    // local side (real disk).
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

    // remote side (subject to control memory file table + stub fabric).
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
    // two path must re- use the same pure function:diff one by one field consistent (nodeId/path except outside).
    const localStructured = assertSchemaValid(localResult.structuredOutput)
    assert.deepEqual(remoteStructured.diff, localStructured.diff)
    assert.equal(files.get('/workspace/same.txt'), content.replace('five', 'FIVE'))
  })

  it('remote oldText missing: failed and remote file table do not change, without structure output', { timeout: 60_000 }, async () => {
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
