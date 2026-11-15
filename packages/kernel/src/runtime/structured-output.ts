/**
 * 原生 subagent 结构化输出（自 spawn.ts 拆出）。
 *
 * - register_structured_output 工具：AJV 全量校验（复用 plugins/schema，$async
 *   显式拒绝），工具拒绝错误参数同回合重试；结果槽按会话隔离，经注入的
 *   sessions Map（宿主 per-Harness 持有，替代原模块级全局 WeakMap）动态定位；
 * - 文本自愈提取：extractJsonCandidates / scanBalanced（平衡扫描全部 {...}/[...]
 *   字面量，含跨行），先 fenced json block、后平衡扫描、再整体文本。
 */

import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { HelmError } from '@helm/protocol'
import { validateOrThrow } from '../plugins/schema.js'

/** 单会话结构化输出任务槽：schema + 已接受结果（undefined = 尚未接受）。 */
export interface StructuredOutputSession {
  schema: Record<string, unknown>
  accepted: unknown | undefined
}

/**
 * 构造 helm-structured-output 扩展（工具定义可复用；同名重装为原地替换）。
 * 结果槽按注入的 sessions Map 定位（per-request 实例，按 conversationId 隔离）。
 */
export function buildStructuredOutputExtension(sessions: Map<number, StructuredOutputSession>): Extension {
  const tool: ToolRegistration = defineTool({
    name: 'register_structured_output',
    description:
      '提交最终结构化结果。output 必须满足任务给定的 JSON Schema；校验失败会收到错误并被要求重试。',
    parameters: {
      type: 'object',
      properties: {
        output: {
          description: '满足任务 JSON Schema 的结构化结果（任意 JSON 值，含 null）',
        },
      },
      required: ['output'],
      // output 值形状由任务 Schema 全量校验，这里不限制其内部结构。
      additionalProperties: false,
    },
    structuredOutputSchema: {
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
      required: ['accepted'],
    },
    async execute(args, api) {
      const session = sessions.get(api.conversationId as number)
      if (session === undefined) {
        return { output: [{ type: 'text', text: '当前会话没有在途的结构化输出任务。' }], isError: true }
      }
      let payload = (args as { output?: unknown }).output
      let result = validateAgainstSchema(payload, session.schema)
      // 防御性反序列化：若初始校验未通过且入参为字符串，尝试 JSON.parse 后再次校验
      // （兼容模型因无强类型声明或传输层序列化而将结构化 JSON 编码为字符串的场景）。
      if (!result.ok && typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload)
          const secondResult = validateAgainstSchema(parsed, session.schema)
          if (secondResult.ok) {
            payload = parsed
            result = secondResult
          }
        } catch {
          // 非合法 JSON 字符串，保持初始校验报错
        }
      }
      if (!result.ok) {
        return {
          output: [
            {
              type: 'text',
              text:
                `结构化输出校验失败，请修正后重新调用 register_structured_output：\n${result.errors}` +
                `\n\nSchema: ${JSON.stringify(session.schema)}`,
            },
          ],
          isError: true,
        }
      }
      session.accepted = payload
      return {
        output: [{ type: 'text', text: '结构化输出已接受。' }],
        structuredOutput: { accepted: true },
      }
    },
  }) as ToolRegistration
  return defineExtension({ name: 'helm-structured-output', tools: [tool] }) as Extension
}

/** 声明边界即拒绝 $async：AJV 异步校验返回 Promise，同步 boolean 判断会
 * 把 Promise 当 truthy 放行非法数据（诚实性红线）。 */
export function assertSchemaNotAsync(schema: Record<string, unknown>): void {
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `schema 含 $async：原生 subagent 同步校验边界不支持异步 Schema`,
      400,
    )
  }
}

/** AJV 全量校验（复用 plugins/schema；$async 在编译期已拒绝）。 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  try {
    validateOrThrow(schema, value, '结构化输出校验失败', 'schema_validation_failed', 502)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof HelmError && error.code === 'schema_validation_failed') {
      return { ok: false, errors: error.message }
    }
    throw error
  }
}

/** 从文本提取候选并做全量 Schema 校验；支持任意合法 JSON 顶层（null/bool/number/string/跨行）。 */
export function parseSchemaCandidate(
  text: string,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; raw: string } {
  for (const candidate of extractJsonCandidates(text)) {
    const result = validateAgainstSchema(candidate, schema)
    if (result.ok) return { ok: true, value: result.value }
  }
  return { ok: false, raw: text }
}

function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const push = (value: unknown) => {
    const key = JSON.stringify(value)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }
  // 1) fenced json block（优先：明确的意图标记）。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of text.matchAll(fenced)) {
    const parsed = safeParse(match[1] ?? '')
    if (parsed !== undefined) push(parsed)
  }
  // 2) 平衡扫描提取全部 {...} / [...] 字面量（含跨行；后出现的优先，unshift 保持顺序倒序）。
  const bracketed = scanBalanced(text)
  for (const candidate of bracketed) push(candidate)
  // 3) 整体文本是合法 JSON（null/true/42/"text" 等标量顶层）。
  const whole = safeParse(text)
  if (whole !== undefined) push(whole)
  return out
}

/** 扫描文本中所有平衡的 {...}/[...] 片段，返回按出现顺序的解析结果。 */
function scanBalanced(text: string): unknown[] {
  const results: unknown[] = []
  const stack: Array<{ start: number; ch: string }> = []
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push({ start: i, ch })
      continue
    }
    if ((ch === '}' || ch === ']') && stack.length > 0) {
      const open = stack[stack.length - 1] as { start: number; ch: string }
      if ((ch === '}' && open.ch === '{') || (ch === ']' && open.ch === '[')) {
        stack.pop()
        if (stack.length === 0) {
          // 顶层闭合：整个片段是候选（嵌套子对象由外层覆盖，不重复提取）。
          const parsed = safeParse(text.slice(open.start, i + 1))
          if (parsed !== undefined) results.push(parsed)
        }
      } else {
        // 不平衡（如 "}" 出现但栈顶是 "["）：丢弃当前片段，防止提取残缺 JSON。
        stack.length = 0
      }
    }
  }
  return results
}

function safeParse(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/**
 * 兼容入口：完整 AJV 校验（plugins/schema 复用；$async 显式拒绝）。
 * 保留导出供既有消费方；行为等价 validateOrThrow 的 boolean 包装。
 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const result = validateAgainstSchema(value, schema)
  return result.ok ? { ok: true, errors: [] } : { ok: false, errors: [result.errors] }
}
