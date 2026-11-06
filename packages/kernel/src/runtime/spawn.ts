/**
 * 原生 subagent：默认 agent_spawn 执行行。
 *
 * - 在 pi-durable 创建原生子会话（task-owned），onCreated 回调上报 convId；
 * - resume：优先用请求携带的原 child convId，其次按稳定 agentId 从映射表查找；
 * - schema：提交后从最后 assistant 文本解析 JSON 并校验；失败时回合内追加一次
 *   自愈提示，仍失败显式报 schema_validation_failed（不吞错、不假数据）；
 * - gate：真实 shell 执行（runGate），失败即 spawn 失败；
 * - isolation: 'worktree' 未支持 -> 显式 unsupported_runtime 错误。
 */

import type { AgentSpawnRequest } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { HelmToolDeps } from './tool-deps.js'
import { runGate } from './tools.js'

export interface NativeSpawnDeps extends HelmToolDeps {
  harness: Harness
  /** conversationId -> 最近 assistant 文本（由 tracker 维护）。 */
  getLastAssistantText(conversationId: number): string | undefined
  /** 默认模型（未配置时显式报错）。 */
  resolveModel(): { provider: string; modelId: string }
  /** agentId -> child convId（resume 映射，持久于内存；进程内稳定）。 */
  agentSessions: Map<string, number>
  /** 记录子会话与父会话关系（列表展示）。 */
  registerChildConversation(childId: number, parentId: number, profileId?: string): Promise<void>
}

export interface SpawnOutcome {
  kind: 'text'
  text: string
  kind2?: never
}

export async function runNativeSpawn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
): Promise<unknown> {
  if (request.isolation !== undefined && request.isolation !== null) {
    throw new HelmError(
      'unsupported_runtime',
      `isolation='${request.isolation}' 暂不支持：请经 builtin:herdr 委派终端 CLI Agent`,
      400,
    )
  }
  const agentType = request.agentType ?? ''
  if (agentType.startsWith('herdr:')) {
    // 无 herdr 插件接管时的显式失败（不误当 profile 处理）。
    throw new HelmError(
      'unsupported_runtime',
      `agentType '${agentType}' 需要 builtin:herdr 插件启用（当前未注册该运行时）`,
      400,
    )
  }

  // resume 解析：显式 convId > agentId 映射。
  let childId: number | undefined
  const resumeRef = request.resume
  if (resumeRef) {
    const parsed = Number.parseInt(resumeRef, 10)
    childId = Number.isFinite(parsed) && String(parsed) === resumeRef
      ? parsed
      : deps.agentSessions.get(resumeRef) ?? (Number.isFinite(parsed) ? parsed : undefined)
  }

  const modelRef = request.model ? parseSpawnModel(request.model) : deps.resolveModel()
  if (!childId) {
    // 创建原生子会话。
    const conv = await deps.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          model: { provider: modelRef.provider, modelId: modelRef.modelId },
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.effort ? { thinkingLevel: request.effort as 'low' } : {}),
        },
      },
      bgContext,
    )
    childId = conv.id as number
    if (request.agentId) deps.agentSessions.set(request.agentId, childId)
    await deps.registerChildConversation(childId, request.parentConversationId, agentType || undefined)
    request.onCreated?.(childId)
  }

  const conversation = await deps.harness.conversation(childId as never, bgContext)
  if (!conversation) {
    throw new HelmError('not_found', `子会话不存在：${childId}`, 404)
  }

  const promptText = request.schema
    ? `${request.prompt}\n\n<structured_output_contract>\n完成回答后，最后单独输出一行合法 JSON（满足给定 JSON Schema），不要包在代码块中。\nSchema: ${JSON.stringify(request.schema)}\n</structured_output_contract>`
    : request.prompt

  const submission = await conversation.submit(
    { type: 'input', content: promptText, whenBusy: 'followUp' },
    bgContext,
  )
  let settled = await submission.wait(bgContext)

  // schema 校验 + 一次自愈追问。
  if (request.schema) {
    let text = deps.getLastAssistantText(childId) ?? ''
    let parsed = tryParseSchema(text, request.schema)
    if (parsed === undefined) {
      const heal = await conversation.submit(
        {
          type: 'input',
          content: `你上一条回答未包含满足 Schema 的合法 JSON。请立即重新输出：只输出一行满足 Schema 的合法 JSON，不要任何其他文字。\nSchema: ${JSON.stringify(request.schema)}`,
          whenBusy: 'followUp',
        },
        bgContext,
      )
      await heal.wait(bgContext)
      text = deps.getLastAssistantText(childId) ?? ''
      parsed = tryParseSchema(text, request.schema)
    }
    if (parsed === undefined) {
      throw new HelmError(
        'schema_validation_failed',
        `子代理（会话 ${childId}）两次输出均未通过 Schema 校验；最后输出开头：${text.slice(0, 200)}`,
        502,
        { conversationId: childId, lastText: text.slice(0, 1000) },
      )
    }
    await settleGate(deps, request, childId)
    return parsed
  }

  if (settled.status === 'unanswered') {
    throw new HelmError(
      'subagent_failed',
      `子代理（会话 ${childId}）回合未完成：${settled.reason}`,
      502,
      { conversationId: childId, reason: settled.reason },
    )
  }
  await settleGate(deps, request, childId)
  const text = deps.getLastAssistantText(childId)
  if (text === undefined || text === '') {
    throw new HelmError(
      'subagent_failed',
      `子代理（会话 ${childId}）完成但无文本输出`,
      502,
      { conversationId: childId },
    )
  }
  return text
}

async function settleGate(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
): Promise<void> {
  if (!request.gate) return
  const gate = await runGate(deps, request.gate, {
    cwd: request.cwd,
    conversationId: childId,
    signal: request.signal,
  })
  if (!gate.ok) {
    throw new HelmError(
      'gate_failed',
      `验收命令失败（exit≠0）：${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      { conversationId: childId, output: gate.output.slice(-4000) },
    )
  }
}

function tryParseSchema(text: string, schema: Record<string, unknown>): unknown | undefined {
  const candidates = extractJsonCandidates(text)
  for (const candidate of candidates) {
    const result = validateJsonSchema(candidate, schema)
    if (result.ok) return candidate
  }
  return undefined
}

function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = []
  // 1) fenced json block
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of text.matchAll(fenced)) {
    const parsed = safeParse(match[1] ?? '')
    if (parsed !== undefined) out.push(parsed)
  }
  // 2) last {...} or [...] line
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line.startsWith('{') || line.startsWith('[')) {
      const parsed = safeParse(line)
      if (parsed !== undefined) {
        out.push(parsed)
        break
      }
    }
  }
  return out
}

function safeParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 轻量 JSON Schema 校验（type/required/properties 一层；完整校验由 ajv 在 HTTP 边界做）。 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const type = schema['type']
  if (typeof type === 'string' && !typeMatches(value, type)) {
    errors.push(`类型应为 ${type}，实际 ${typeName(value)}`)
  }
  if (Array.isArray(schema['required'])) {
    for (const key of schema['required'] as string[]) {
      if (
        value === null ||
        typeof value !== 'object' ||
        !(key in (value as Record<string, unknown>))
      ) {
        errors.push(`缺少必填字段 ${key}`)
      }
    }
  }
  const properties = schema['properties']
  if (
    value !== null &&
    typeof value === 'object' &&
    properties &&
    typeof properties === 'object'
  ) {
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined) continue
      if (
        typeof sub === 'object' &&
        sub !== null &&
        typeof (sub as Record<string, unknown>)['type'] === 'string' &&
        !typeMatches(child, (sub as Record<string, unknown>)['type'] as string)
      ) {
        errors.push(`字段 ${key} 类型应为 ${(sub as Record<string, unknown>)['type']}`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
    case 'integer':
      return typeof value === 'number' && (type !== 'integer' || Number.isInteger(value))
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function parseSpawnModel(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash <= 0) throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

import { BACKGROUND_CONTEXT as bgContext } from '@earendil-works/chord/context'
