/**
 * builtin:workflow 插件 client 纯逻辑：subagent 工具行语义摘要与子会话实时流
 * 展开（toolCall / toolResult 配对、live 流合并、统计尾注；零 React/DOM 依赖）。
 */
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf, formatShortModelName, inputString } from './model-format.ts'

// ---------------------------------------------------------------------------
// 工具行语义摘要
// ---------------------------------------------------------------------------

/** 仅缩短相对于子会话 cwd 的路径，兼容远端节点与 Windows 路径。 */
function shortenPath(p: string, cwd?: string): string {
  const separator = p.includes('\\') ? '\\' : '/'
  const prefix = cwd?.replace(/[\\/]+$/, '')
  const relative = prefix && p.startsWith(`${prefix}${separator}`) ? p.slice(prefix.length + 1) : p
  return relative.length > 48 ? `…${relative.slice(-46)}` : relative
}

/** 单行轨迹核心入参摘要（工具名 + 入参压缩为一行）。 */
export function toolSummaryText(toolName: string, input: unknown): string {
  void toolName
  let raw = ''
  if (typeof input === 'string') {
    raw = input
  } else if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const preferred = ['command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill_id']
    for (const key of preferred) {
      const v = record[key]
      if (typeof v === 'string' && v !== '') {
        raw = v
        break
      }
    }
    if (raw === '') {
      raw = Object.entries(record)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${summarizeValue(v)}`)
        .join(' ')
    }
  }
  const firstLine = raw.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

function summarizeValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** 活跃工具语义化动作提炼。 */
export function formatSemanticToolAction(toolName: string, input: unknown, cwd?: string): { tag: string; text: string } {
  switch (toolName) {
    case 'bash': {
      const command = inputString(input, 'command')
      return { tag: 'bash', text: command !== undefined ? firstLineOf(command, 80) : toolName }
    }
    case 'read':
    case 'read_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '读取', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'edit':
    case 'edit_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '编辑', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'write':
    case 'write_file': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'path')
      return { tag: '写入', text: path !== undefined ? shortenPath(path, cwd) : toolName }
    }
    case 'grep': {
      const pattern = inputString(input, 'pattern')
      return { tag: '搜索', text: pattern !== undefined ? firstLineOf(pattern, 60) : toolName }
    }
    case 'find':
    case 'ls': {
      const target = inputString(input, 'pattern') ?? inputString(input, 'path')
      return { tag: '查找', text: target !== undefined ? shortenPath(firstLineOf(target, 80), cwd) : toolName }
    }
    default: {
      const text = toolSummaryText(toolName, input)
      return { tag: toolName, text: text !== '' ? text : toolName }
    }
  }
}

// ---------------------------------------------------------------------------
// 子会话实时流（detail.entries + ConversationLive 合并展开）
// ---------------------------------------------------------------------------

/** 子会话紧凑活动行。 */
export type SubagentStreamLine =
  | { kind: 'prompt'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolName: string
      summary: string
      status: 'running' | 'done' | 'error' | 'unknown'
      isError: boolean
      durationMs?: number
      resultPreview?: string
    }
  | { kind: 'text'; key: string; text: string }

/** 展示层剥离的 spawn 注入结构化输出契约样板（末尾尾行）。 */
const STRUCTURED_OUTPUT_CONTRACT_TAIL_RE = /\n*<structured_output_contract>[\s\S]*?<\/structured_output_contract>\s*$/

/** 子会话实时内容流：detail.entries + ConversationLive 合并展开为紧凑活动行。 */
export function buildSubagentStreamLines(
  entries: ReadonlyArray<ConversationEntry>,
  live?: ConversationLive,
  working?: boolean,
): SubagentStreamLine[] {
  const lines: SubagentStreamLine[] = []
  const liveToolKeys = new Set((live?.tools ?? []).map((t) => `tool:${t.callId}`))
  const liveToolByKey = new Map((live?.tools ?? []).map((t) => [`tool:${t.callId}`, t] as const))
  let liveTextConsumed = false
  let seq = 0
  for (const entry of entries) {
    if (entry.kind === 'helm.input' || entry.kind === 'pi.user') {
      const text = entry.kind === 'helm.input'
        ? (entry.data !== null && typeof entry.data === 'object' && !Array.isArray(entry.data) ? (entry.data as Record<string, unknown>)['text'] : undefined)
        : undefined
      const finalText = typeof text === 'string' ? text : ''
      if (finalText.trim() !== '') {
        lines.push({ kind: 'prompt', key: `prompt:${entry.id}`, text: finalText.replace(STRUCTURED_OUTPUT_CONTRACT_TAIL_RE, '').trim() })
      }
      continue
    }
    if (entry.kind !== 'pi.assistant' && entry.kind !== 'pi.tool-result') continue
    const model = entry.model
    if (!Array.isArray(model)) continue
    for (let mi = 0; mi < model.length; mi++) {
      const msg = model[mi]
      if (msg === null || typeof msg !== 'object') continue
      const m0 = msg as { role?: unknown; content?: unknown }
      // 仅展开 assistant 消息的内容块；toolResult 消息（role=toolResult/tool）
      // 的 content 是结果文本，由下方配对逻辑合并进对应工具行，不另生正文行。
      if (m0.role !== undefined && m0.role !== 'assistant') continue
      const content = m0.content
      if (!Array.isArray(content)) continue
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi]
        if (block === null || typeof block !== 'object') continue
        const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; input?: unknown }
        const key = `${entry.id}:${mi}:${bi}`
        if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim() !== '') {
            lines.push({ kind: 'thinking', key: `think:${key}`, text: b.thinking })
          }
        } else if (b.type === 'text') {
          if (typeof b.text === 'string' && b.text !== '') lines.push({ kind: 'text', key: `text:${key}`, text: b.text })
        } else if (b.type === 'toolCall' || b.type === 'tool_use') {
          const callId = typeof b.id === 'string' ? b.id : typeof b.callId === 'string' ? b.callId : undefined
          const name = typeof b.name === 'string' ? b.name : '(unknown tool)'
          const input = 'arguments' in b ? b.arguments : b.input
          const lt = callId !== undefined ? liveToolByKey.get(`tool:${callId}`) : undefined
          lines.push({
            kind: 'tool',
            key: `tool:${callId ?? key}`,
            toolName: name,
            summary: toolSummaryText(name, input),
            status: lt?.status ?? (working === true ? 'running' : 'unknown'),
            isError: false,
          })
        }
      }
    }
    // pi.tool-result 配对补全（与 toolCall 行同 key 去重）。
    if (entry.kind === 'pi.tool-result') {
      for (let mi = 0; mi < model.length; mi++) {
        const msg = model[mi]
        if (msg === null || typeof msg !== 'object') continue
        const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown }
        if (m.role !== 'toolResult' && m.role !== 'tool') continue
        const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
        const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
        const isError = m.isError === true
        const durationMs = typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) ? m.durationMs : undefined
        const resultText = contentTextOf(m.content)
        const key = `tool:${callId ?? `${entry.id}:${mi}`}`
        const existing = lines.findLast((line) => line.kind === 'tool' && line.key === key)
        if (existing !== undefined && existing.kind === 'tool') {
          existing.status = isError ? 'error' : 'done'
          existing.isError = isError
          if (durationMs !== undefined) existing.durationMs = durationMs
          if (resultText !== '') existing.resultPreview = firstLineOf(resultText, 100)
          continue
        }
        lines.push({
          kind: 'tool',
          key,
          toolName,
          summary: toolSummaryText(toolName, undefined),
          status: isError ? 'error' : 'done',
          isError,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(resultText !== '' ? { resultPreview: firstLineOf(resultText, 100) } : {}),
        })
      }
    }
  }
  // live 合并：流式思考 / 未配对新工具 / 流式文本。
  if (typeof live?.thinking === 'string' && live.thinking.trim() !== '') {
    lines.push({ kind: 'thinking', key: 'think:live', text: live.thinking })
  }
  for (const lt of live?.tools ?? []) {
    if (typeof lt?.callId !== 'string' || liveToolKeys.has(`tool:${lt.callId}`) === false) continue
  }
  if (live?.tools !== undefined) {
    const seenCallIds = new Set(
      lines.filter((l): l is Extract<SubagentStreamLine, { kind: 'tool' }> => l.kind === 'tool' && l.key.startsWith('tool:'))
        .map((l) => l.key.slice('tool:'.length)),
    )
    for (const lt of live.tools) {
      if (typeof lt?.callId !== 'string' || seenCallIds.has(lt.callId)) continue
      const text = typeof lt.result === 'string' ? lt.result : undefined
      lines.push({
        kind: 'tool',
        key: `tool:${lt.callId}`,
        toolName: lt.toolName,
        summary: toolSummaryText(lt.toolName, lt.input),
        status: lt.status,
        isError: lt.status === 'error',
        ...(text !== undefined && text !== '' ? { resultPreview: firstLineOf(text, 100) } : {}),
      })
    }
  }
  if (!liveTextConsumed && typeof live?.text === 'string' && live.text.trim() !== '') {
    const persistedText = lines.findLast((line) => line.kind === 'text')?.text
    if (persistedText?.startsWith(live.text) !== true) {
      lines.push({ kind: 'text', key: `text:live:${seq++}`, text: live.text })
    }
  }
  return lines
}

function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

// ---------------------------------------------------------------------------
// 头部极简统计尾注
// ---------------------------------------------------------------------------

function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/** 头部极简统计尾注片段（总耗时已拆至独立展示位，不在此收集）。 */
export function buildSubagentStatSegments(input: {
  summary?: ConversationSummary
  entries?: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  backgroundRun?: WorkflowRunSummary
  /** 工作流节点的权威模型 / Token 统计；存在时覆盖摘要中的同类字段。 */
  modelOverride?: string
  tokensOverride?: number
}): string[] {
  const segments: string[] = []
  const shortModel = formatShortModelName(input.modelOverride || input.summary?.model || input.backgroundRun?.nodes?.[0]?.model)
  if (shortModel !== undefined) segments.push(shortModel)
  if (input.summary?.thinkingLevel !== undefined && input.summary.thinkingLevel.trim() !== '' && input.summary.thinkingLevel !== 'off') {
    segments.push(input.summary.thinkingLevel)
  }
  const steps = countToolSteps(input.entries, input.live)
  if (steps !== undefined && steps > 0) segments.push(`已载 ${steps} 次工具`)
  const tokens = input.tokensOverride ?? input.backgroundRun?.nodes?.[0]?.tokens
  if (tokens !== undefined && tokens > 0) segments.push(formatCompactTokens(tokens))
  return segments
}

/** 统计 entries 已落库 toolCall 总次数，加上 live.tools 中尚未落库的新 callId。 */
function countToolSteps(entries: ReadonlyArray<ConversationEntry> | undefined, live: ConversationLive | undefined): number | undefined {
  if (entries === undefined) {
    return live !== undefined && live.tools.length > 0 ? live.tools.length : undefined
  }
  const lines = buildSubagentStreamLines(entries)
  const seenCallIds = new Set<string>()
  let count = 0
  for (const line of lines) {
    if (line.kind !== 'tool') continue
    count++
    if (line.key.startsWith('tool:')) {
      const callId = line.key.slice('tool:'.length)
      if (callId !== '') seenCallIds.add(callId)
    }
  }
  for (const t of live?.tools ?? []) {
    if (t.callId !== '' && !seenCallIds.has(t.callId)) count++
  }
  return count
}
