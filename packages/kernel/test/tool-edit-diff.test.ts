/**
 * edit 工具真实差异结果（runtime/tool-edit-diff.ts）测试。
 *
 * 覆盖：
 * 1. 纯函数 computeEditDiff：精确行号（真实扫描）、±3 上下文窗口、行内/多行/
 *    纯增删、CRLF、末尾无换行、尾部空行、重复上下文、巨长行与行数/文本预算
 *    截断（统计仍覆盖完整差异）、no-op；
 * 2. 脱敏安全：全文先行脱敏（单行秘密命中占位符）；跨行秘密与横跨窗口边界
 *    的秘密（窗口切片脱敏会泄漏的形态）必须回退 rows=[]/truncated=true 且
 *    序列化结果无任何秘密残段；行号/统计始终反映原文；
 * 3. 工具级：local 与远端共享同一纯函数（同内容产出完全一致 diff）、结构化
 *    输出符合 @helm/protocol EDIT_TOOL_RESULT_SCHEMA（Ajv 真实校验）、字面
 *    替换（$& 不解释）、失败（不存在/多次）绝不产生成功 diff 且文件不变。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
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

/** n 行 'l1..ln'，末行带换行。 */
function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n'
}

/** 对 (original, oldText, newText) 做唯一精确替换后的全文。 */
function applyEdit(original: string, oldText: string, newText: string): string {
  const offset = original.indexOf(oldText)
  assert.ok(offset >= 0, `测试前置：oldText 应存在（${JSON.stringify(oldText.slice(0, 20))}）`)
  return original.slice(0, offset) + newText + original.slice(offset + oldText.length)
}

function diffOf(original: string, oldText: string, newText: string, redact = identityRedact) {
  const offset = original.indexOf(oldText)
  return computeEditDiff(original, applyEdit(original, oldText, newText), offset, oldText.length, redact)
}

function rowTexts(rows: ToolDiffRow[]): string[] {
  return rows.map((row) => row.text)
}

/** 全部行级断言辅助：逐行 kind + 行号 + 文本。 */
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

describe('computeEditDiff 纯函数：行号与窗口', { timeout: 60_000 }, () => {
  it('行内替换：精确行号、±3 上下文窗口、行级统计', { timeout: 60_000 }, () => {
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

  it('大前缀下行号来自真实扫描（第 100 行编辑，窗口 97-103）', { timeout: 60_000 }, () => {
    const original = numberedLines(120)
    const diff = diffOf(original, 'l100', 'CHANGED')
    assert.equal(diff.firstChangedLine, 100)
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 97)
    const last = diff.rows[diff.rows.length - 1]!
    assert.equal(last.kind, 'context')
    assert.equal((last as { oldLine: number }).oldLine, 103)
    assert.ok(diff.rows.every((row) => row.text.length <= 7), '窗口只覆盖 97-103 行（不 diff 全文件）')
    // 上下文行号连续且 oldLine === newLine（未变更区间行号一致）。
    const contexts = diff.rows.filter((row) => row.kind === 'context') as Array<{ oldLine: number; newLine: number }>
    assert.ok(contexts.every((row) => row.oldLine === row.newLine))
  })

  it('文件开头编辑：窗口从第 1 行起（不越界）', { timeout: 60_000 }, () => {
    const original = numberedLines(8)
    const diff = diffOf(original, 'l1', 'FIRST')
    assert.equal(diff.firstChangedLine, 1)
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // 窗口为涉及行（第 1 行）±3：末行是第 4 行，而非文件末尾。
    const last = diff.rows[diff.rows.length - 1] as { oldLine: number }
    assert.equal(last.oldLine, 4)
  })

  it('多行替换：首变更行与增删统计', { timeout: 60_000 }, () => {
    const original = numberedLines(12)
    const diff = diffOf(original, 'l5\nl6\n', 'n1\nn2\nn3\n')
    assert.equal(diff.addedLines, 3)
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 5)
    const removes = diff.rows.filter((r) => r.kind === 'remove') as Array<{ oldLine: number }>
    assert.deepEqual(removes.map((r) => r.oldLine), [5, 6])
    const adds = diff.rows.filter((r) => r.kind === 'add') as Array<{ newLine: number }>
    assert.deepEqual(adds.map((r) => r.newLine), [5, 6, 7])
    // 变更后上下文行号错位：old 7-9 ↔ new 8-10（行号跳跃真实）。
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

  it('纯删除（中部）：firstChangedLine 为删除点新行号', { timeout: 60_000 }, () => {
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

  it('纯删除（EOF）：firstChangedLine 钳到新文件末行', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc\n', 'c\n', '')
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2, '新文件共 2 行，EOF 删除取末行')
  })

  it('整文件删空：firstChangedLine 钳到 1（Schema 最小值）', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\n', 'a\nb\n', '')
    assert.equal(diff.removedLines, 2)
    assert.equal(diff.firstChangedLine, 1)
  })
})

describe('computeEditDiff 纯函数：行边界形态', { timeout: 60_000 }, () => {
  it('CRLF：行文本剥 \r，行号与统计正确', { timeout: 60_000 }, () => {
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

  it('CRLF 与 LF 混合并改含 CRLF 的行', { timeout: 60_000 }, () => {
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

  it('末尾无换行：末行编辑行文本无换行且计数正确', { timeout: 60_000 }, () => {
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

  it('替换引入末尾换行（c -> c\n）：真实行级差异', { timeout: 60_000 }, () => {
    const diff = diffOf('a\nb\nc', 'c', 'c\n')
    // 旧末行 'c'（无换行）被 'c\n' 替换：行级差异表现为删 1 增 1（含末行换行变化）。
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.addedLines >= 1, true)
  })

  it('尾部空行参与替换：空行行号真实', { timeout: 60_000 }, () => {
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

  it('重复上下文：同文本不同行号（行号真实不折叠）', { timeout: 60_000 }, () => {
    const original = 'r\nr\nr\nTARGET\nr\nr\nr\n'
    const diff = diffOf(original, 'TARGET', 'DONE')
    const contexts = diff.rows.filter((r) => r.kind === 'context') as Array<{ oldLine: number }>
    assert.deepEqual(contexts.map((r) => r.oldLine), [1, 2, 3, 5, 6, 7])
    assert.deepEqual(rowTexts(contexts), ['r', 'r', 'r', 'r', 'r', 'r'])
  })

  it('行内纯插入（无整行增删）：仍为删旧行增新行', { timeout: 60_000 }, () => {
    const diff = diffOf('alpha\nbeta\n', 'beta', 'bbeta')
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 2)
  })
})

describe('computeEditDiff 纯函数：预算与截断', { timeout: 60_000 }, () => {
  it('巨长行：单行文本截断到上限，统计覆盖完整差异，不把巨长行传回', { timeout: 60_000 }, () => {
    const long = 'x'.repeat(9_000)
    const original = `head\n${long}\ntail\n`
    const diff = diffOf(original, long, long.replace(/^x/, 'y'))
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    const changed = diff.rows.filter((r) => r.kind !== 'context')
    assert.equal(changed.length, 2)
    for (const row of changed) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS, `单行文本 ≤ ${TOOL_DIFF_MAX_ROW_CHARS}`)
      assert.ok(!row.text.includes('\n'))
    }
  })

  it('巨长行截断避开 UTF-16 代理对（不产生半个字符）', { timeout: 60_000 }, () => {
    // 1 个 BMP 字符 + 3000 个 emoji（每个 2 个代码单元）：截断点落在高代理项上。
    const line = 'x' + '😊'.repeat(3_000)
    const original = `${line}\n`
    const diff = diffOf(original, 'x😊', 'x🚀')
    assert.equal(diff.truncated, true)
    for (const row of diff.rows.filter((r) => r.kind !== 'context')) {
      const last = row.text.charCodeAt(row.text.length - 1)
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), '末字符不得是孤立高代理项')
    }
  })

  it('行数预算：rows ≤ 160、truncated=true、统计覆盖完整差异', { timeout: 60_000 }, () => {
    const oldBlock = Array.from({ length: 200 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 200 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `before\n${oldBlock}after\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.ok(diff.rows.length <= TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, '本例骨架远超预算，应恰好裁到上限')
    // 统计不受 rows 截断影响。
    assert.equal(diff.removedLines, 200)
    assert.equal(diff.addedLines, 200)
    assert.equal(diff.firstChangedLine, 2)
  })

  it('累计文本预算：以脱敏后文本计，总文本不超限且 truncated=true', { timeout: 60_000 }, () => {
    const line = 'c'.repeat(1_000)
    const oldBlock = Array.from({ length: 60 }, (_, i) => `${line}-old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 60 }, (_, i) => `${line}-new-${i}`).join('\n') + '\n'
    const original = oldBlock
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.truncated, true)
    assert.equal(diff.addedLines, 60)
    assert.equal(diff.removedLines, 60)
    const total = rowTexts(diff.rows).reduce((sum, text) => sum + text.length, 0)
    assert.ok(total <= TOOL_DIFF_MAX_TEXT_CHARS, `累计文本 ≤ ${TOOL_DIFF_MAX_TEXT_CHARS}，实际 ${total}`)
    assert.ok(diff.rows.length < 60, '文本预算应先于行数预算截断')
  })

  it('no-op（oldText === newText）：rows=[] counts=0 firstChangedLine=替换所在行', { timeout: 60_000 }, () => {
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

  it('替换区间越界：前置条件立即抛错（写盘前失败）', { timeout: 60_000 }, () => {
    assert.throws(() => computeEditDiff('abc', 'abc', 3, 2, identityRedact), /前置条件失败/)
    assert.throws(() => computeEditDiff('abc', 'abc', -1, 1, identityRedact), /前置条件失败/)
    assert.throws(() => computeEditDiff('abc', 'abc', 0, 0, identityRedact), /前置条件失败/)
  })

  it('算法预算（maxEditLength）超限：整段替换表示，公共前后缀保留、统计一致、truncated=true', { timeout: 60_000 }, () => {
    // 2100 行旧块替换为 2100 行全新新块：编辑长度远超预算 2000，diffLines 超限。
    const oldBlock = Array.from({ length: 2_100 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 2_100 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    // 整段替换表示：truncated 显式标记（非最小差异），统计与该表示一致。
    assert.equal(diff.truncated, true)
    assert.equal(diff.removedLines, 2_100)
    assert.equal(diff.addedLines, 2_100)
    assert.equal(diff.firstChangedLine, 2, '公共前缀（head）后第一处变更在新文件第 2 行')
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS, '行预算裁剪')
    // 骨架保留公共前后缀上下文：首行是 head（第 1 行）。
    assert.equal(diff.rows[0]!.kind, 'context')
    assert.equal((diff.rows[0] as { oldLine: number }).oldLine, 1)
    // 整段表示的 remove 行连续来自旧窗口第 2 行起。
    const firstRemove = diff.rows.find((r) => r.kind === 'remove') as { oldLine: number; text: string }
    assert.equal(firstRemove.oldLine, 2)
    assert.equal(firstRemove.text, 'old-0')
  })

  it('算法预算内的同规模窗口不触发整段表示（最小差异正常产出）', { timeout: 60_000 }, () => {
    // 800 行互换（编辑长度 < 2000）：产出最小差异而非整段替换；同规模保证
    // 两分支规模相当，超限行为确实由编辑长度驱动。
    const oldBlock = Array.from({ length: 800 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const newBlock = Array.from({ length: 800 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const original = `head\n${oldBlock}tail\n`
    const diff = diffOf(original, oldBlock, newBlock)
    assert.equal(diff.removedLines, 800)
    assert.equal(diff.addedLines, 800)
    assert.equal(diff.rows.length, TOOL_DIFF_MAX_ROWS)
    assert.equal(diff.truncated, true, '行预算截断仍如实标记')
    // 最小差异与整段表示在此构造下骨架等价（全量删/全量增），区别在超限分支
    // 由预算驱动；这里验证统计一致且首变更行相同。
    assert.equal(diff.firstChangedLine, 2)
  })
})

describe('computeEditDiff 纯函数：脱敏', { timeout: 60_000 }, () => {
  it('单行秘密：行文本替换为占位符，行号/统计与未脱敏一致', { timeout: 60_000 }, () => {
    const original = 'l1\nl2 token=s3cret-value\nl3\n'
    const redact = (text: string): string => text.split('s3cret-value').join('[REDACTED]')
    const plain = diffOf(original, 'l2', 'L2')
    const masked = diffOf(original, 'l2', 'L2', redact)
    assert.equal(masked.truncated, false)
    assert.equal(masked.addedLines, plain.addedLines)
    assert.equal(masked.removedLines, plain.removedLines)
    assert.equal(masked.firstChangedLine, plain.firstChangedLine)
    const serialized = JSON.stringify(masked)
    assert.ok(!serialized.includes('s3cret-value'), '序列化结果不得包含秘密')
    assert.ok(serialized.includes('[REDACTED]'), '命中的秘密行显示占位符')
    // 行号仍是真实行号（与未脱敏运行一致）。
    assert.deepEqual(
      masked.rows.map((r) => r.kind),
      plain.rows.map((r) => r.kind),
    )
  })

  it('跨行秘密（含换行）：行数改变，回退 rows=[]/truncated=true，统计保留原文', { timeout: 60_000 }, () => {
    const original = 'a\nHEAD\nTAIL\nb\n'
    // 秘密 'HEAD\nTAIL' 横跨第 2、3 行；整值脱敏后行数 4 -> 3。
    const redact = (text: string): string => text.split('HEAD\nTAIL').join('[X]')
    const diff = diffOf(original, 'b', 'B', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [], '行数被脱敏改变时绝不展示行（无法对应真实行号）')
    // 统计与首变更行仍是原文真实差异（b -> B 在第 4 行）。
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 4)
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('HEAD') && !serialized.includes('TAIL'))
  })

  it('横跨窗口边界的多行秘密：全文先行脱敏，窗口内残段绝不泄漏', { timeout: 60_000 }, () => {
    // 窗口为第 3-9 行（编辑第 6 行）；秘密横跨第 2/3 行（窗口边界）。
    // 若先裁窗口再脱敏，窗口内的 'BOUNDARY-TAIL' 残段将命中不了整值秘密而泄漏。
    const original =
      'l1\npre BOUNDARY-HEAD\nBOUNDARY-TAIL l3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n'
    const secret = 'BOUNDARY-HEAD\nBOUNDARY-TAIL'
    const redact = (text: string): string => text.split(secret).join('[X]')
    const diff = diffOf(original, 'l6', 'L6', redact)
    assert.equal(diff.truncated, true)
    assert.deepEqual(diff.rows, [])
    const serialized = JSON.stringify(diff)
    assert.ok(!serialized.includes('BOUNDARY-TAIL'), '窗口内秘密残段不得泄漏')
    assert.ok(!serialized.includes('BOUNDARY-HEAD'))
    // 统计仍是原文真实差异。
    assert.equal(diff.addedLines, 1)
    assert.equal(diff.removedLines, 1)
    assert.equal(diff.firstChangedLine, 6)
  })

  it('秘密只在窗口外的行：全文脱敏行数不变，窗口行照常展示且无秘密', { timeout: 60_000 }, () => {
    const original = 'secret-line=s3cret\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'
    const redact = (text: string): string => text.split('s3cret').join('[R]')
    const diff = diffOf(original, 'l5', 'L5', redact)
    assert.equal(diff.truncated, false)
    assert.equal(diff.firstChangedLine, 5)
    assert.ok(!JSON.stringify(diff).includes('s3cret'), '序列化结果不得包含秘密')
    // 窗口从第 2 行起（第 5 行 - 3）：含秘密的第 1 行不在窗口内，也不出现在任何行文本。
    const contexts = diff.rows.filter((r) => r.kind === 'context') as Array<{ oldLine: number; text: string }>
    assert.equal(contexts[0]!.oldLine, 2, '窗口首行是第 2 行')
    assert.ok(rowTexts(diff.rows).every((text) => !text.includes('[R]')), '窗口行不含脱敏占位符（秘密不在窗口内）')
  })
})

// ---------------------------------------------------------------------------
// 工具级（真实执行）
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
      throw new Error('测试不使用')
    },
    getTask: () => undefined,
    waitForTask: async () => {
      throw new Error('测试不使用')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('测试不使用')
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
const validateEditResult = ajv.compile(EDIT_TOOL_RESULT_SCHEMA)

function assertSchemaValid(structured: unknown): EditToolResult {
  assert.ok(validateEditResult(structured), `结构化输出应符合 EDIT_TOOL_RESULT_SCHEMA：${JSON.stringify(validateEditResult.errors)}`)
  return structured as EditToolResult
}

/** 受控远端 env：真实内存文件表（对齐 file-mutation-queue.test.ts 模式）。 */
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

describe('edit 工具：local 真实差异结构化输出', { timeout: 60_000 }, () => {
  it('local：结构化输出符合协议 Schema，diff 行号/文本/统计真实；newText 字面写入（$& 不解释）', { timeout: 60_000 }, async () => {
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
    // 落盘内容与 diff 同源：newText 字面写入，$& 绝不被解释为反向引用。
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA $& \\1\nomega\n')
  })

  it('失败（不存在/多次出现）：isError 且绝不产生成功 diff，文件字节不变', { timeout: 60_000 }, async () => {
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
    assert.ok((dup.output as Array<{ text: string }>)[0]!.text.includes('出现 2 次'))
    assert.equal(readFileSync(file, 'utf8'), 'a\nsame\nb\nsame\nc\n', '失败路径文件必须保持原样')
  })

  it('真实 SecretStash 脱敏贯穿结构化输出（巨长行截断仍不泄漏）', { timeout: 60_000 }, async () => {
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
    assert.ok(!serialized.includes('hunter2-super-secret'), '序列化结果不得包含秘密')
    assert.ok(serialized.includes('[REDACTED]'))
    // 含秘密的巨长行被截断显示：预算生效且统计完整。
    assert.equal(structured.diff.truncated, true)
    assert.equal(structured.diff.removedLines, 1)
    assert.equal(structured.diff.addedLines, 1)
    for (const row of structured.diff.rows) {
      assert.ok(row.text.length <= TOOL_DIFF_MAX_ROW_CHARS)
    }
  })
})

describe('edit 工具：远端共享同一纯函数', { timeout: 60_000 }, () => {
  it('远端与 local 对同内容产出完全一致 diff；文件写回远端内存文件表', { timeout: 60_000 }, async () => {
    // local 侧（真实磁盘）。
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

    // 远端侧（受控内存文件表 + stub fabric）。
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
    // 两条路径必须复用同一纯函数：diff 逐字段一致（nodeId/path 除外）。
    const localStructured = assertSchemaValid(localResult.structuredOutput)
    assert.deepEqual(remoteStructured.diff, localStructured.diff)
    assert.equal(files.get('/workspace/same.txt'), content.replace('five', 'FIVE'))
  })

  it('远端 oldText 不存在：失败且远端文件表不变、无结构化输出', { timeout: 60_000 }, async () => {
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
