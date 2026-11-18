/**
 * Shared timeline-entry text extraction for server-side plugin settlement summaries.
 *
 * Contract: an entry's `model` field is the pi-ai message array of that entry's record. Entries of kind
 * `pi.tool-result` carry `{ role: 'toolResult', content: [{ type: 'text', ... }] }` messages and user-side
 * entries (steers, onYield continuations) can carry `{ role: 'user', content: [{ type: 'text', ... }] }`
 * blocks — all shaped exactly like assistant text blocks. Extracting "the last assistant reply" therefore
 * MUST match on `role === 'assistant'`: without the role check, a tool's raw output (e.g. a bash listing)
 * or an injected user text is returned as the member's reply summary.
 */

import { HelmError, isAbsoluteAgentPath, redactJsonValue, type HelmHostApi } from '@helm/protocol'

/** Last assistant text across entries (newest first, message-role checked; '' when none). */
export function lastAssistantText(entries: Array<{ kind?: string; model?: unknown }>): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const model = entries[i]!.model
    if (!Array.isArray(model)) continue
    for (let j = model.length - 1; j >= 0; j -= 1) {
      const message = model[j] as { role?: unknown; content?: unknown } | null | undefined
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue
      const blocks = message.content
      if (!Array.isArray(blocks)) continue
      const texts = blocks
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === 'object' &&
            b !== null &&
            (b as { type?: string }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    }
  }
  return ''
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 单条 timeline entry 摘要文本：优先 assistant 文本，否则有界 JSON 概要（不伪造内容）。 */
export function entryDigestText(entry: { kind: string; data?: unknown; model?: unknown }): string {
  const assistant = lastAssistantText([entry])
  if (assistant !== '') return assistant
  if (entry.data !== undefined) {
    const json = JSON.stringify(entry.data)
    return json.length > 400 ? `${json.slice(0, 399)}…` : json
  }
  return ''
}

/** 时间线条目受控摘要：assistant 取真实文本，其余取 JSON 概要（脱敏 + 截断）。 */
export function recentEntrySummaries(
  host: Pick<HelmHostApi, 'redact'>,
  entries: Array<{ id: string; kind: string; data?: unknown; model?: unknown }>,
  maxEntries = 20,
): Array<{ id: string; kind: string; text: string }> {
  const redacted = redactJsonValue(entries.slice(-maxEntries), (t) => host.redact(t)) as typeof entries
  return redacted.map((e) => ({
    id: e.id,
    kind: e.kind,
    text: truncate(entryDigestText(e), 400),
  }))
}

export function assertWorkerConversationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HelmError('validation_error', `workerConversationId 必须是正整数（收到：${String(value)}）`, 400, {})
  }
  return value
}

/** Worker 工作目录：跨平台绝对路径校验（不以宿主 node:path 规则误判远端目标）。 */
export function assertWorkerCwd(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || !isAbsoluteAgentPath(trimmed)) {
    throw new HelmError(
      'validation_error',
      `cwd 必须是跨平台绝对路径（POSIX / 开头、Windows 盘符或 UNC；收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}

/** Worker 绑定节点：非空 1..64 字符、无空白、无路径分隔符。 */
export function assertWorkerNodeId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
    throw new HelmError(
      'validation_error',
      `nodeId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}
