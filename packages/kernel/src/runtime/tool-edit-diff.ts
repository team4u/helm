/**
 * edit 工具真实差异计算（唯一实现；local 与远端两条执行路径共享）。
 *
 * 契约（与 @helm/protocol 的 EDIT_TOOL_RESULT_SCHEMA 对齐）：
 * - 输入是「唯一精确替换已完成」的前后全文与替换区间：original（改前全文）、
 *   updated（改后全文，与实际落盘内容一致）、matchOffset / replacedLength
 *   （oldText 在 original 中的唯一匹配区间）。前置条件被破坏时立即抛错
 *   （调用方在写盘前计算，抛错即 edit_failed、文件未被修改）；
 * - 差异仅计算替换涉及的完整行 ±3 行上下文窗口（不 diff 整份大文件）；
 *   行号来自对 original 的真实行扫描（接受前缀线性扫描，不为 O(改动)
 *   牺牲正确性）；
 * - 脱敏先行：对 original / updated 全文分别 redact 之后再按行号取窗口行
 *   （先切片再脱敏会泄漏横跨窗口边界的多行秘密的在窗口内残段）；
 * - 行号与统计始终反映原文：addedLines / removedLines / firstChangedLine
 *   基于未脱敏窗口的 diffLines 行级差异，覆盖完整差异，rows 预算截断不
 *   影响统计；
 * - 若全文脱敏改变行数（秘密本身含换行，替换占位符不含换行，行数只能
 *   减少且只要相等即边界未动），窗口行无法再对应真实文件行号——直接
 *   rows=[] + truncated=true 并保留原文统计，绝不伪造行号、绝不泄漏秘密；
 * - 预算以脱敏后文本计：rows ≤ TOOL_DIFF_MAX_ROWS、单行文本 ≤
 *   TOOL_DIFF_MAX_ROW_CHARS（超长行截断显示，统计仍按完整行）、累计文本 ≤
 *   TOOL_DIFF_MAX_TEXT_CHARS；任何形式的截断都置 truncated=true；
 * - 算法级预算：diffLines 带 maxEditLength（超限返回 undefined），大段
 *   相异替换绝不无上限阻塞内核；超限时退为「整段替换表示」——剥离公共
 *   前后缀行后 remove 全部旧行 / add 全部新行（有效但非最小差异），统计与
 *   该表示一致，并显式置 truncated=true；
 * - no-op（updated === original，即工具允许的 oldText === newText）：rows=[]、
 *   counts=0、firstChangedLine=替换所在行。
 */

import { diffLines } from 'diff'
import {
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_TEXT_CHARS,
  type ToolDiffRow,
  type ToolEditDiff,
} from '@helm/protocol'

/** 替换涉及行上下各保留的上下文行数。 */
const EDIT_CONTEXT_LINES = 3

/**
 * diffLines 算法预算（编辑长度）：行预算 TOOL_DIFF_MAX_ROWS 的十余倍——
 * 超过它的最小差异增删行数必远超行预算（永远无法完整展示），整段替换
 * 表示不损失可展示信息，同时封顶内核计算开销。
 */
const EDIT_DIFF_MAX_EDIT_LENGTH = 2_000

const LF = 10
const CR = 13

/** 行数：'' 为 0 行；以 \n 计数，末尾未换行补 1（与 splitLineTexts 一致）。 */
function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) newlines += 1
  }
  return text.charCodeAt(text.length - 1) === LF ? newlines : newlines + 1
}

/** 按行拆分（剥掉行尾 \n 与紧邻的 \r；保留空行；'' → []）。 */
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
 * 行起点扫描：lineStarts[k] 为第 k+1 行起点；末尾 \n 之后无内容，
 * 不开启空行（与 countLines/splitLineTexts 行数口径一致）；空串无行。
 */
function scanLineStarts(original: string): number[] {
  if (original === '') return []
  const lineStarts = [0]
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === LF && i + 1 < original.length) lineStarts.push(i + 1)
  }
  return lineStarts
}

/** offset 所在行（1 基）：lineStarts 升序，二分定位最后一个起点 ≤ offset 的行。 */
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

/** diff 行骨架（行号真实；文本稍后按行号从脱敏窗口行取）。 */
type SkeletonRow =
  | { kind: 'context'; oldLine: number; newLine: number }
  | { kind: 'remove'; oldLine: number }
  | { kind: 'add'; newLine: number }

/** 让行数预算优先留给真实改动，避免大替换片段中的未改行挤掉后续变更。 */
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
 * 在唯一精确替换的前后全文与匹配区间上生成 ToolEditDiff（纯函数，无 IO）。
 *
 * redact 需满足：替换占位符不含换行（SecretStash 的 [REDACTED] 系列满足）；
 * 全文脱敏后行数不变即证明没有任何换行位于秘密内部，窗口行与原文行一一对
 * 应，行号真实。违反时按契约走 rows=[] 回退，不伪造。
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
      `edit diff 前置条件失败：替换区间 [${matchOffset}, ${matchOffset + replacedLength}) 越界（文件 ${original.length} 字符）`,
    )
  }
  const lineStarts = scanLineStarts(original)
  const totalLines = lineStarts.length
  const firstLine = lineAt(lineStarts, matchOffset)
  const lastLine = lineAt(lineStarts, matchOffset + replacedLength - 1)
  // no-op（工具允许 oldText === newText）：无差异可展示，行号指向替换处。
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

  // 行级差异骨架与统计（原始文本，未脱敏）：行号/统计反映真实变更。
  let addedLines = 0
  let removedLines = 0
  let firstChanged = 0
  const skeleton: SkeletonRow[] = []
  // 算法预算超限：退整段替换表示（有效但非最小），统计与该表示一致。
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
          // 纯删除的首变更行取删除点的新文件行（其后首条上下文/新增行同号；
          // EOF 删除则下行统一钳到新文件末行）。
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
  // 首变更行（新文件行号）：钳到新文件真实行数（EOF 删除取末行；新文件为空取 1）。
  const firstChangedLine =
    firstChanged === 0 ? firstLine : Math.min(firstChanged, Math.max(1, countLines(updated)))

  // 脱敏先行：对前后全文分别 redact（跨窗口边界的多行秘密因此整体命中）。
  const redOriginal = redact(original)
  const redUpdated = redact(updated)
  if (countLines(redOriginal) !== totalLines || countLines(redUpdated) !== countLines(updated)) {
    // 全文脱敏改变了行数（秘密含换行）：窗口行无法对应真实行号。诚实回退：
    // 不展示行（绝不泄漏），统计与首变更行保留原文计算结果。
    return { rows: [], addedLines, removedLines, firstChangedLine, truncated: true }
  }
  // 行数不变 ⇒ 换行未被任何秘密包含 ⇒ 脱敏前后行边界逐行对应；
  // 窗口行 = 脱敏全文按行号裁剪（新窗口占新文件第 windowStartLine 起的
  // countLines(rawNewWindow) 行：窗口前各行原样未动）。
  const newWindowCount = countLines(rawNewWindow)
  const redOldLines = splitLineTexts(redOriginal).slice(windowStartLine - 1, windowEndLine)
  const redNewLines = splitLineTexts(redUpdated).slice(
    windowStartLine - 1,
    windowStartLine - 1 + newWindowCount,
  )

  // 预算（按脱敏后文本）：行数、单行长度、累计文本；任何截断都置 truncated。
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
      // 超长行截断显示（统计不变）；退一位避免切割 UTF-16 代理对。
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
