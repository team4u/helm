/**
 * HTTP 详情出口的 ConversationEntry 投影（纯函数，机制层）。
 *
 * 消费方：仅详情分页（ConversationDetailService.getConversationDetail）与
 * 单条端点（getConversationEntry 的签名剥离）。SSE conversation.entry 事件、
 * SDK rewind/context/settlement 与 waitForInput 结果一律不经此投影——
 * toConversationEntry 的既有语义保持不变。
 *
 * 策略（详见 @helm/protocol ConversationEntry 的投影约定注释）：
 * - `pi.system`：模型侧簿记（系统提示词/工具声明），详情分页不外发；
 * - 供应商签名载荷 thinkingSignature / textSignature / thoughtSignature
 *   （pi-ai TextContent / ThinkingContent / ToolCall 的不透明加密块）：对
 *   客户端无语义且体积可观，出口统一剥离——仅限 assistant 消息 content
 *   块，toolResult details 等业务对象与 entry.data 不触碰；数据库原文不变；
 * - 超限纯文本 toolResult 显式截断：保留头尾、消息级携带
 *   truncated/totalChars/totalLines（与每条 pi.tool-result 精确配对，无
 *   多消息歧义）；结构化通道 details（subagent/SubagentWorkflow 等）与
 *   可解析 JSON 文本豁免（截断会破坏下游解析）；尾部 `[Artifact] id=`
 *   尾标因保留尾部而天然保留。
 */

import type { ConversationEntry } from '@helm/protocol'

/** 供应商签名载荷键（pi-ai 内容块/工具调用字段）。 */
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  'thinkingSignature',
  'textSignature',
  'thoughtSignature',
])

/** tool-result 纯文本截断阈值（字符，投影层；SDK 自身输出限额之外的最后防线）。
 * bash spill 预览（≈4KiB 头 + 256B 尾）与 read_artifact（≤128KiB）是典型
 * 大输出来源：阈值取 1536 字符（头 1024 + 尾 512 + 省略标记），100 条/页
 * 的详情分页因此有确定上界。 */
export const TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS = 1536
/** 截断后保留的头部字符数。 */
export const TOOL_RESULT_HEAD_CHARS = 1024
/** 截断后保留的尾部字符数（[Artifact] id= 尾标随尾部保留）。 */
export const TOOL_RESULT_TAIL_CHARS = 512

/**
 * 单条 entry 的通用脱敏（详情分页与单条端点共用）：
 * - 仅对 role=assistant 消息的 content 内容块剥离签名键——签名是 pi-ai
 *   供应商对 assistant 思考/文本/工具调用块的不透明载荷；
 * - toolResult 消息（含 details 业务对象）与其他角色一律不触碰（details
 *   是插件结构化 JSON，可能合法携带同名字段）；entry.data 同样不动；
 * - copy-on-write：无命中返回原对象（零拷贝），绝不改写输入（SSE/SDK 与
 *   数据库共享同一记录）。
 */
export function stripEntrySignatures(entry: ConversationEntry): ConversationEntry {
  if (entry.model === undefined) return entry
  let changed = false
  const model = entry.model.map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
    const m = message as Record<string, unknown>
    if (m['role'] !== 'assistant') return message
    const content = m['content']
    if (!Array.isArray(content)) return message
    let contentChanged = false
    const projectedContent = content.map((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return block
      if (Object.getPrototypeOf(block) !== Object.prototype) return block
      let blockChanged = false
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(block)) {
        if (SIGNATURE_KEYS.has(key)) {
          blockChanged = true
          continue
        }
        out[key] = value
      }
      if (!blockChanged) return block
      contentChanged = true
      return out
    })
    if (!contentChanged) return message
    changed = true
    return { ...m, content: projectedContent }
  })
  if (!changed) return entry
  return { ...entry, model }
}

// ---------------------------------------------------------------------------
// tool-result 纯文本截断
// ---------------------------------------------------------------------------

/** 纯文本内容判定：字符串，或全部为 {type:'text'} 块的数组（与前端
 * contentTextOf 的拼接口径一致）。 */
function isPlainTextContent(content: unknown): content is string | ReadonlyArray<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.every(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
}

/** 内容全文本（块文本直接拼接，与前端渲染口径一致）。 */
function combinedTextOf(content: string | ReadonlyArray<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((block) => block.text).join('')
}

/** 结构化结果文本豁免：subagent / SubagentWorkflow 等的文本是完整 JSON
 * 信封（可带 `[subagent ...]` / `[Artifact] ...` 风格的尾部 footer 行），
 * 截断会破坏下游解析。判定：整体可解析 JSON，或剥离尾部单行方括号
 * footer 后可解析 JSON。 */
function isStructuredJsonText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  if (parsable(trimmed)) return true
  const lines = trimmed.split('\n')
  // 自尾行起剥离形如 [ ... ] 的单行 footer（至多 4 行），剩余主体可解析即豁免。
  for (let drop = 1; drop <= Math.min(4, lines.length - 1); drop += 1) {
    const candidate = lines.slice(0, lines.length - drop).join('\n').trim()
    if (candidate === '' || (!candidate.startsWith('{') && !candidate.startsWith('['))) break
    const footerOnly = lines.slice(lines.length - drop).every((l) => /^\[[^\n]*\]\s*$/.test(l.trim()))
    if (footerOnly && parsable(candidate)) return true
  }
  return false
}

function parsable(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 已经由 artifacts spill 层截断过的文本（携带 [Artifact] id= 全文入口）：
 * 全文在产物中、条目只存预览——再叠加投影截断会让前端误以为单条端点能
 * 取回完整输出。此层绝不重复截断，保留现有产物入口。 */
const ARTIFACT_SPILL_MARKER_RE = /\[Artifact\]\s+id=/

/** 截断文本：保留头尾 + 自描述省略标记（含全文规模与取原文指引）。 */
function truncatePlainText(text: string): { text: string; totalChars: number; totalLines: number } {
  const totalChars = text.length
  const totalLines = text === '' ? 0 : text.split('\n').length
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS)
  const tail = text.slice(totalChars - TOOL_RESULT_TAIL_CHARS)
  const omitted = totalChars - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS
  const marker =
    `\n\n…[helm 截断：省略 ${omitted} 字符（全文 ${totalChars} 字符 / ${totalLines} 行，` +
    'GET /api/conversations/<id>/entries/<entryId> 取未截断原文]…\n\n'
  return { text: `${head}${marker}${tail}`, totalChars, totalLines }
}

/** 单个 model 消息的截断投影；无需截断时原样返回（共享引用）。
 * 截断时在消息对象上追加 truncated/totalChars/totalLines（消息级标记，
 * 与每条 pi.tool-result 精确配对，无顶层歧义）。 */
function projectToolResultMessage(message: unknown): unknown {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
  const m = message as Record<string, unknown>
  if (m['role'] !== 'toolResult' && m['role'] !== 'tool') return message
  const content = m['content']
  if (!isPlainTextContent(content)) return message
  const text = combinedTextOf(content)
  if (text.length <= TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS) return message
  if (isStructuredJsonText(text)) return message
  if (ARTIFACT_SPILL_MARKER_RE.test(text)) return message
  const truncated = truncatePlainText(text)
  const projectedContent =
    typeof content === 'string' ? truncated.text : [{ type: 'text', text: truncated.text }]
  return {
    ...m,
    content: projectedContent,
    truncated: true as const,
    totalChars: truncated.totalChars,
    totalLines: truncated.totalLines,
  }
}

/**
 * 详情分页投影：pi.system 过滤 + 签名剥离 + 安全纯文本 tool-result 截断。
 * 返回 undefined 表示该条不外发（pi.system）。输入不被改写。
 */
export function projectDetailEntry(entry: ConversationEntry): ConversationEntry | undefined {
  if (entry.kind === 'pi.system') return undefined
  const stripped = stripEntrySignatures(entry)
  if (stripped.kind !== 'pi.tool-result' || stripped.model === undefined) return stripped
  let changed = false
  const model = stripped.model.map((message) => {
    const projected = projectToolResultMessage(message)
    if (projected !== message) changed = true
    return projected
  })
  return changed ? { ...stripped, model } : stripped
}
