/**
 * 工具展开体纯数据层（纯 .ts，零 React/DOM 依赖，单测直测）。
 *
 * 职责：
 * - write / read / bash 展示数据提取（入参与 structuredOutput 的字段只做类型
 *   收窄，缺失即 undefined，绝不编造字段或伪造文件状态）；
 * - 行切片（head/tail，用于源码预览与输出尾部折叠——均为本地已有完整文本，
 *   展开可还原，与服务端截断语义无关）；
 * - 通用工具入参的键值归一（多行字符串/嵌套值块状展示，原始数据入口兜底）；
 * - 26px 单行摘要的极简统计（edit +N −N / write 行数；运行态只报事实不报成功）。
 */

import type { ToolTrace } from './timeline-model.js'
import { languageFromFilename } from './code-language.js'
import { buildPendingEditDiff, checkEditToolResult } from './edit-diff-model.js'

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

export function inputPathOf(input: unknown): string | undefined {
  return stringField(asRecord(input), 'path')
}

/** JSON 美化；循环引用等异常退回 String()，绝不抛出打断渲染。 */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function countLines(text: string): number {
  return splitForLines(text).length
}

/** 行切分：末尾单个换行产生的空行不计为真实行（与编辑器行号一致）。 */
function splitForLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface LineSlice {
  /** 展示文本（head 或 tail 的原文切片）。 */
  visible: string
  /** 完整文本总行数。 */
  totalLines: number
  /** 被折叠的行数（head：开头保留后的剩余；tail：开头被折叠的行数）。 */
  hiddenLines: number
}

/** 头部切片：保留前 maxLines 行，hiddenLines = 总行数 - 保留行数。 */
export function headLines(text: string, maxLines: number): LineSlice {
  const lines = splitForLines(text)
  const keep = Math.min(lines.length, maxLines)
  return {
    visible: lines.slice(0, keep).join('\n'),
    totalLines: lines.length,
    hiddenLines: lines.length - keep,
  }
}

/** 尾部切片：保留最后 maxLines 行，hiddenLines = 被折叠的前置行数。 */
export function tailLines(text: string, maxLines: number): LineSlice {
  const lines = splitForLines(text)
  const keep = Math.min(lines.length, maxLines)
  return {
    visible: lines.slice(lines.length - keep).join('\n'),
    totalLines: lines.length,
    hiddenLines: lines.length - keep,
  }
}

/** 键值归一：短单行值内联，多行/长字符串与嵌套值标记为块状（原始 JSON 兜底）。 */
export interface KvEntry {
  key: string
  value: string
  /** true = 块状展示（等宽块），false = 单行内联。 */
  block: boolean
}

const KV_INLINE_MAX_CHARS = 160

export function inputKvEntries(input: unknown): KvEntry[] {
  const record = asRecord(input)
  if (record === undefined) {
    if (typeof input === 'string') return [{ key: 'input', value: input, block: input.includes('\n') || input.length > KV_INLINE_MAX_CHARS }]
    return []
  }
  const entries: KvEntry[] = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      entries.push({
        key,
        value,
        block: value.includes('\n') || value.length > KV_INLINE_MAX_CHARS,
      })
    } else {
      const json = prettyJson(value)
      entries.push({ key, value: json, block: json.includes('\n') || json.length > KV_INLINE_MAX_CHARS })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// write / read / bash 展示数据
// ---------------------------------------------------------------------------

export interface WriteBodyData {
  path: string | undefined
  content: string | undefined
  language: string
  lineCount: number | undefined
  /** 成功结果携带的字节数（structuredOutput.bytesWritten，仅类型收窄）。 */
  bytesWritten: number | undefined
}

export function writeBodyData(tool: ToolTrace): WriteBodyData {
  const input = asRecord(tool.input)
  const path = stringField(input, 'path')
  const content = stringField(input, 'content')
  const structured = asRecord(tool.structuredOutput)
  const bytes = structured?.bytesWritten
  return {
    path,
    content,
    language: languageFromFilename(path),
    lineCount: content !== undefined ? countLines(content) : undefined,
    bytesWritten:
      tool.status === 'done' && !tool.isError && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
        ? bytes
        : undefined,
  }
}

export interface ReadBodyData {
  /** 展示用内容：structuredOutput.content 优先，退回 resultText。 */
  content: string | undefined
  language: string
  /** 输出含内核超长 Spill 标记：预览性质文本，不做源码语法高亮。 */
  isSpill: boolean
}

export function readBodyData(tool: ToolTrace): ReadBodyData {
  const structured = asRecord(tool.structuredOutput)
  const input = asRecord(tool.input)
  const path = stringField(structured, 'path') ?? stringField(input, 'path')
  const content = stringField(structured, 'content') ?? tool.resultText
  return {
    content,
    language: languageFromFilename(path),
    isSpill: tool.artifactRef !== undefined,
  }
}

export interface BashBodyData {
  command: string | undefined
  output: string | undefined
  /** structuredOutput.exitCode：数字为实际值，null 表示无退出码（如启动失败）。 */
  exitCode: number | null | undefined
  timedOut: boolean
}

export function bashBodyData(tool: ToolTrace): BashBodyData {
  const input = asRecord(tool.input)
  const structured = asRecord(tool.structuredOutput)
  const exit = structured?.exitCode
  return {
    command: stringField(input, 'command'),
    output: tool.resultText,
    exitCode: typeof exit === 'number' && Number.isSafeInteger(exit) ? exit : exit === null ? null : undefined,
    timedOut: structured?.timedOut === true,
  }
}

// ---------------------------------------------------------------------------
// 26px 单行极简统计（只报事实：差异行数 / 内容行数；运行态不伪称成功）
// ---------------------------------------------------------------------------

export interface ToolRowStats {
  addCount?: number
  removeCount?: number
  /** 纯文本统计（如 write 的 “12 行”）。 */
  text?: string
  /** 悬浮说明：数字来源（已应用差异 / 待执行片段）。 */
  title: string
}

export function toolRowStats(tool: ToolTrace): ToolRowStats | undefined {
  // 插件 tool.view 接管的行由插件自绘，宿主不叠加统计。
  if (tool.toolView !== undefined) return undefined
  if (tool.toolName === 'edit') {
    if (tool.status === 'done' && !tool.isError) {
      const check = checkEditToolResult(tool.structuredOutput)
      if (check.ok) {
        return {
          addCount: check.value.diff.addedLines,
          removeCount: check.value.diff.removedLines,
          title: '已应用差异统计',
        }
      }
      return undefined
    }
    if (tool.status === 'running') {
      const pending = buildPendingEditDiff(tool.input)
      if (pending?.kind === 'computed') {
        return {
          addCount: pending.addedLines,
          removeCount: pending.removedLines,
          title: '待执行变更片段统计（尚未应用）',
        }
      }
    }
    return undefined
  }
  if (tool.toolName === 'write') {
    const content = stringField(asRecord(tool.input), 'content')
    if (content === undefined) return undefined
    return { text: `${countLines(content)} 行`, title: '写入内容行数' }
  }
  return undefined
}
