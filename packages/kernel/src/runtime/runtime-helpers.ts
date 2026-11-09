/**
 * runtime 共享文件级 helpers（无状态纯函数）。
 *
 * 从 runtime.ts 拆出：工具结果契约、before_turn sections/messages 手术、
 * rewind 区间解析、404 会话校验等跨模块复用的小函数。
 */
import type { JsonValue } from '@earendil-works/chord'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '@helm/protocol'
import { HelmError, ROOT_CONVERSATION_ID as PROTO_ROOT } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import type { ConvMeta } from './store.js'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { HelmStore } from './store.js'

// ---------------------------------------------------------------------------
// 通用序列化 / 转义
// ---------------------------------------------------------------------------

/** XML 属性/文本转义（defang 防逃逸与 ownership 标记共用）。 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 剥离已有 external_event 包裹（trigger transform 后再 defang 防双重包裹；保留包裹外追加文本）。 */
export function stripEnvelope(text: string): string {
  const match = /[\s\S]*?<external_event[^>]*>\n([\s\S]*?)\n<\/external_event>([\s\S]*)/.exec(text)
  if (match === null) return text
  const body = match[1] ?? ''
  const tail = match[2] ?? ''
  const unescaped = body
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
  return tail.trim() === '' ? unescaped : `${unescaped}${tail}`
}

/** 任意值 -> 模型可见文本（对象 JSON 序列化）。 */
export function safeResultText(value: unknown, redact: (text: string) => string = (text) => text): string {
  if (typeof value === 'string') return redact(value)
  if (value === undefined) return ''
  return JSON.stringify(redactJsonValue(value, redact))
}

// ---------------------------------------------------------------------------
// 会话存在性 404（全文去重的公共 helper）
// ---------------------------------------------------------------------------

/** store.getConv + 404（全文重复 15+ 处的公共收敛）。 */
export function requireConv(store: HelmStore, id: number): NonNullable<ReturnType<HelmStore['getConv']>> {
  const meta = store.getConv(id)
  if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
  return meta
}

// ---------------------------------------------------------------------------
// 工具结果契约 helpers（插件/钩子产物 -> SDK ToolExecutionResult）
// ---------------------------------------------------------------------------

/**
 * 插件工具结构化结果信封的判别条件（防止任意含 output 字段的业务对象被误
 * 识别为信封）：必须至少含 output（字符串或数组）/ structuredOutput /
 * isError 三个信封字段之一，且出现的信封字段全部类型合法；任一信封字段
 * 类型非法则显式报错（不是当普通对象静默走文本通道——工具作者意图不明，
 * 边界拒绝优于猜测）。
 */
function envelopeProblem(raw: Record<string, unknown>): { isEnvelope: boolean; problem?: string } {
  const hasOutput = raw['output'] !== undefined
  const hasStructured = raw['structuredOutput'] !== undefined
  const hasError = raw['isError'] !== undefined
  if (!hasOutput && !hasStructured && !hasError) return { isEnvelope: false }
  if (hasOutput && typeof raw['output'] !== 'string' && !Array.isArray(raw['output'])) {
    return { isEnvelope: true, problem: 'output 必须是字符串或 { type: \'text\', text } 数组' }
  }
  if (hasError && typeof raw['isError'] !== 'boolean') {
    return { isEnvelope: true, problem: 'isError 必须是布尔值' }
  }
  return { isEnvelope: true }
}

/**
 * 插件工具原始返回 -> SDK ToolExecutionResult：
 * - 结构化结果信封 { output, structuredOutput?, isError? }：仅当出现的信封
 *   字段全部类型合法时按信封规整（文本与 structuredOutput 均过脱敏；
 *   structuredOutput 仅在工具声明了 structuredOutputSchema 时保留）；
 * - 工具未声明 structuredOutputSchema 却返回 structuredOutput：显式拒绝
 *   （invalid_tool_result，不再静默丢弃——数据丢失必须让插件作者看见）；
 * - 其余任意值统一包单文本块 content（无 schema 不传 structuredOutput）。
 */
export function pluginToolResult(
  raw: unknown,
  redact: (text: string) => string,
  options?: { structuredOutputSchema?: unknown; toolName?: string; callId?: string },
): {
  output: Array<{ type: 'text'; text: string }>
  structuredOutput?: unknown
  isError?: boolean
} {
  const where = options?.toolName !== undefined
    ? `工具 ${options.toolName}${options?.callId !== undefined ? `（callId=${options.callId}）` : ''}`
    : '插件工具'
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const env = raw as { output?: unknown; structuredOutput?: unknown; isError?: unknown }
    const verdict = envelopeProblem(raw as Record<string, unknown>)
    if (verdict.isEnvelope) {
      if (verdict.problem !== undefined) {
        throw new HelmError(
          'invalid_tool_result',
          `${where} 的结果信封字段类型非法：${verdict.problem}`,
          500,
        )
      }
      // output：字符串包单文本块；数组原样校验后透传。
      let output: Array<{ type: 'text'; text: string }>
      if (typeof env.output === 'string') {
        output = [{ type: 'text', text: redact(env.output) }]
      } else if (Array.isArray(env.output)) {
        output = env.output.map((block) => {
          if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
            throw new HelmError(
              'invalid_tool_result',
              `${where} 的结果信封 output 数组仅接受 { type: 'text', text } 块`,
              500,
            )
          }
          return { type: 'text' as const, text: redact((block as { text: string }).text) }
        })
      } else if (env.output === undefined) {
        output = []
      } else {
        throw new HelmError(
          'invalid_tool_result',
          `${where} 的结果信封 output 必须是字符串或 { type: 'text', text } 数组`,
          500,
        )
      }
      const result: { output: Array<{ type: 'text'; text: string }>; structuredOutput?: unknown; isError?: boolean } = {
        output,
      }
      // structuredOutput 仅在工具声明 schema 时保留（SDK 契约）；值级脱敏。
      // 未声明 schema 却返回 structuredOutput：显式拒绝（不静默丢数据）。
      if (env.structuredOutput !== undefined && options?.structuredOutputSchema === undefined) {
        throw new HelmError(
          'invalid_tool_result',
          `${where} 未声明 structuredOutputSchema 却返回了 structuredOutput（SDK 契约禁止；请声明 schema 或改为纯 output 文本）`,
          500,
        )
      }
      if (env.structuredOutput !== undefined && options?.structuredOutputSchema !== undefined) {
        result.structuredOutput = redactJsonValue(env.structuredOutput, redact)
      }
      if (env.isError === true) result.isError = true
      return result
    }
  }
  // 未命中信封判别（无任何信封字段，或字段类型全部合法但一个都没出现）：
  // 普通业务值统一走文本通道（无 schema 不传 structuredOutput）。
  return { output: [{ type: 'text', text: safeResultText(raw, redact) }] }
}

/** tool_call handled 的接管产物 -> 合法 ToolExecutionResult（非法形状显式错误结果）。 */
export function toolResultOf(handled: unknown): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
} {
  const normalized = normalizeToolResult(handled)
  if (normalized !== undefined) {
    return normalized as { output: Array<{ type: 'text'; text: string }>; isError: boolean }
  }
  return {
    output: [{ type: 'text', text: 'tool_call handled 钩子返回了非法结果形状（已按错误落盘）' }],
    isError: true,
  }
}

/** tool_result transform 产物规整：必须形如 ToolExecutionResult，否则 undefined（保持原结果）。 */
export function normalizeToolResult(value: unknown): ToolExecutionResultShape | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as ToolExecutionResultShape
  if (candidate.output === undefined && candidate.structuredOutput === undefined && candidate.isError === undefined) {
    return undefined
  }
  // output 必须是 content 数组（字符串包成单文本块；SDK 契约只接受数组）。
  if (typeof candidate.output === 'string') {
    return { ...candidate, output: [{ type: 'text', text: candidate.output }] }
  }
  if (candidate.output !== undefined && !Array.isArray(candidate.output)) return undefined
  return candidate
}

export interface ToolExecutionResultShape {
  output?: Array<{ type: string; text?: string }> | string
  structuredOutput?: JsonValue
  isError?: boolean
  details?: JsonValue
}

// ---------------------------------------------------------------------------
// before_turn sections / tools 手术（SDK system 前导消息改写）
// ---------------------------------------------------------------------------

/** 从模型消息提取当前生效 system sections（含前导声明与后续 patch 回放）。 */
export function systemSectionsOf(messages: ReadonlyArray<{ role?: string; sections?: unknown }>): Array<{ id: string; text: string }> {
  const sections = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    if (message.sections === null || typeof message.sections !== 'object') continue
    for (const [key, value] of Object.entries(message.sections as Record<string, unknown>)) {
      if (value === null) sections.delete(key)
      else if (typeof value === 'string') sections.set(key, value)
    }
  }
  return [...sections.entries()].map(([id, text]) => ({ id, text }))
}

export function sectionsEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.text !== b[i]!.text) return false
  }
  return true
}

/**
 * 把前导 system 消息的 sections 整体替换为 desired（保留 base content）。
 * 后续 system 段消息的旧 sections patch 通过 null 清除，避免回放残留。
 */
export function withSections(
  messages: ReadonlyArray<Record<string, unknown>>,
  desired: Array<{ id: string; text: string }>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [...messages]
  const out: Array<Record<string, unknown>> = [...messages]
  const lead = out[0]!
  if (lead['role'] !== 'system') return out
  const previous = lead['sections']
  const previousKeys =
    previous !== null && typeof previous === 'object'
      ? Object.keys(previous as Record<string, unknown>)
      : []
  // 新声明集；旧键不在新集中的以 null 移除（回放语义）。
  const next: Record<string, string | null> = {}
  for (const [i, section] of desired.entries()) {
    void i
    next[section.id] = section.text
  }
  for (const key of previousKeys) {
    if (!(key in next)) next[key] = null
  }
  out[0] = { ...lead, sections: next }
  return out
}

/**
 * 工具集变更：在前导 system 消息追加 toolsRemoved/toolsAdded 声明。
 * 模型侧由 pi-ai 回放机制解析（getCurrentTools），下一轮即生效。
 */
export function withToolDeclarations(
  messages: ReadonlyArray<Record<string, unknown>>,
  declared: Set<string>,
  tools: ReturnType<typeof getCurrentTools>,
): Array<Record<string, unknown>> {
  const available = new Map(tools.map((tool) => [tool.name, tool]))
  const added: Array<Record<string, unknown>> = []
  for (const name of declared) {
    const tool = available.get(name)
    if (!tool) throw new HelmError('unknown_tool', `before_turn 选择了未注册工具：${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // 完整重声明：移除全部旧声明再加新集（等价重放，防顺序漂移）。
  const next: Record<string, unknown> = { ...lead }
  const sections = lead['sections']
  next['sections'] =
    sections !== null && typeof sections === 'object'
      ? { ...(sections as Record<string, unknown>) }
      : {}
  next['toolsRemoved'] = currentToolNames(messages).filter((name) => declared.has(name) === false).map((name) => ({ name }))
  next['toolsAdded'] = added
  return [{ ...next }, ...messages.slice(1)]
}

/** 回放消息中的当前工具名清单。 */
export function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message['role'] !== 'system') continue
    for (const tool of message['toolsAdded'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof tool?.name === 'string') names.add(tool.name)
    }
    for (const ref of message['toolsRemoved'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof ref?.name === 'string') names.delete(ref.name)
    }
  }
  return [...names]
}

// ---------------------------------------------------------------------------
// 会话摘要回退 / 错误归一
// ---------------------------------------------------------------------------

export function summaryOfFallback(
  meta: ConvMeta,
  status: ConversationSummary['status'],
  pendingAskCount: number,
): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    ...(meta as { parentConversationId?: number }).parentConversationId !== undefined
      ? { parentConversationId: (meta as { parentConversationId?: number }).parentConversationId }
      : {},
    cwd: meta.cwd,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    ...(meta.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: meta.thinkingLevelOverride } : {}),
    status,
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

export function normalizeBusyError(error: unknown): unknown {
  const name = (error as { name?: string })?.name
  if (name === 'ConversationBusy') {
    return new HelmError('conversation_busy', '会话正忙且 whenBusy=reject', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmError('conversation_idle', '会话空闲与 whenIdle=reject 冲突', 409)
  }
  return error
}

export function entryModelText(entry: { model?: ReadonlyArray<{ content?: unknown }> }): string {
  const content = entry.model?.[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** entry.model 消息数组 -> assistant 文本块拼接（waitForInput 提取回答用）。 */
export function assistantTextOfModel(model: unknown[] | undefined): string {
  if (model === undefined) return ''
  const out: string[] = []
  for (const message of model) {
    const blocks = (message as { content?: ReadonlyArray<{ type: string; text?: string }> }).content
    if (!blocks) continue
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// rewind 区间（原地覆盖重发契约）
// ---------------------------------------------------------------------------

/** helm.rewind 截断标记声明的覆盖区间（闭区间 [from, through]）。
 *
 * throughEntryId 是新契约：覆盖区间内最大的旧条目 ID，新输入条目 ID 必然
 * 更大、绝不会被自家区间误删。 */
export interface RewindInterval {
  from: number
  through: number
  marker: number
}

/** 解析一条条目的 rewind 区间；非 rewind 标记或载荷非法返回 undefined。 */
export function rewindIntervalOf(entry: { id: number | string; kind: string; data?: unknown }): RewindInterval | undefined {
  if (entry.kind !== 'helm.rewind') return undefined
  const data = entry.data as { fromEntryId?: unknown; throughEntryId?: unknown } | undefined
  const from = Number(data?.fromEntryId)
  if (!Number.isSafeInteger(from) || from <= 0) return undefined
  const marker = Number(entry.id)
  const through = Number(data?.throughEntryId)
  if (!Number.isSafeInteger(marker) || !Number.isSafeInteger(through) || through < from || through >= marker) {
    throw new HelmError('invalid_rewind_entry', `历史覆盖标记 ${entry.id} 的区间无效`, 500)
  }
  return { from, through, marker }
}

/** 条目是否被任一 rewind 区间覆盖（详情投影 / FTS 重建 / lastAssistant 清理共用）。 */
export function coveredByRewind(entryId: number, intervals: ReadonlyArray<RewindInterval>): boolean {
  return intervals.some((cut) => entryId >= cut.from && entryId <= cut.through)
}

/** 编辑目标限定：仅允许覆盖人类输入条目（agent/trigger 注入与控制条目拒绝）。 */
export function assertEditableHumanInput(
  entry: { kind: string; data?: unknown },
  conversationId: number,
  entryId: number,
): void {
  if (entry.kind === 'pi.user') return
  if (entry.kind !== 'helm.input') {
    throw new HelmError(
      'entry_not_editable',
      `仅支持编辑人类输入条目（条目 ${entryId} kind=${entry.kind}）`,
      400,
      { conversationId, entryId, kind: entry.kind },
    )
  }
  const origin = (entry.data as { origin?: unknown } | undefined)?.origin
  if (origin !== 'human') {
    throw new HelmError(
      'entry_not_editable',
      `条目 ${entryId} 来源为 ${String(origin)}，仅人类输入可原地覆盖重发`,
      409,
      { conversationId, entryId, origin: String(origin) },
    )
  }
}

export { PROTO_ROOT }
export type { ToolExecutionResult }
