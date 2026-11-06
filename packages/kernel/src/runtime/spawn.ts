/**
 * 原生 subagent：默认 agent_spawn 执行行。
 *
 * - 在 pi-durable 创建原生子会话，onCreated 回调上报 convId；
 * - resume：严格校验 ref（纯数字 convId 或既有 agentId 映射），绝不静默新建假续接；
 * - signal：创建前已 abort 直接拒绝；运行中 abort -> conversation.abort 并等待 settle；
 * - schema：AJV 全量校验（复用 plugins/schema，$async 显式拒绝），回合内
 *   register_structured_output 工具自愈（per-child 扩展注入），工具拒绝错误
 *   参数同回合重试，最终未走工具可再文本追问一次，仍失败显式
 *   schema_validation_failed（不吞错、不假数据）；
 * - profile：经 resolveProfile 端口读取真实 Profile（model/runtime），无效
 *   profile 显式报错；herdr runtime 未被插件接管时 unsupported_runtime；
 * - gate：真实 shell 执行（runGate，cwd 用子会话实际 cwd），失败即 spawn 失败；
 * - isolation: 'worktree' 未支持 -> 显式 unsupported_runtime 错误。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, defineTool, type AgentChange, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import { validateOrThrow } from '../plugins/schema.js'
import type { HelmToolDeps } from './tool-deps.js'
import { runGate } from './tools.js'

const bg = BACKGROUND_CONTEXT

/** 默认 spawn profile：assistant（真实存在的常驻 profile；不新造角色枚举）。 */
const DEFAULT_SPAWN_PROFILE = 'assistant'

/** thinkingLevel 合法枚举（pi-ai ModelThinkingLevel；effort 映射到此，拒绝任意字符串）。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface ResolvedProfile {
  model?: string
  cwd?: string
  /** 外部运行时声明（如 herdr）：原生执行行不支持，显式报错。 */
  runtime?: { kind: string; agent: string; args?: string[] }
}

/**
 * 原生 spawn 依赖端口（宿主注入；runtime.ts 组合具体实现）。
 * resolveProfile 返回 undefined 表示 profile 不存在（显式报错，不静默当 default）。
 */
export interface NativeSpawnDeps extends HelmToolDeps {
  harness: Harness
  /** conversationId -> 最近 assistant 文本（由 tracker 维护）。 */
  getLastAssistantText(conversationId: number): string | undefined
  /** 默认模型 'provider/model'（未配置时抛 HelmError）。 */
  resolveModel(): { provider: string; modelId: string }
  /** agentId -> child convId（resume 映射，进程内稳定）。 */
  agentSessions: Map<string, number>
  /**
   * 记录子会话与父会话关系并校验 profile 合法性；无效 profileId 必须抛
   * HelmError('not_found')。childCwd 为子会话将使用的实际 cwd（gate 也用它）。
   */
  registerChildConversation(
    childId: number,
    parentId: number,
    profileId: string,
    childCwd: string,
  ): Promise<void>
  /** 按 profileId 读取真实 Profile（model/cwd/runtime）；不存在返回 undefined。 */
  resolveProfile(profileId: string): Promise<ResolvedProfile | undefined>
  /**
   * 校验子会话归属：resume 时确认 childId 的 parentConversationId 与请求一致。
   * 返回该会话记录的父 ID；会话不存在返回 undefined。
   */
  getParentOfConversation(childId: number): number | undefined
  /**
   * 将 per-child 扩展安装进 SDK registry（spawn 构造的 StructuredOutput 工具
   * 需真实注册后才能被会话按名选中；同名重装为原地替换）。
   */
  installChildExtension(extension: Extension): void
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
  if (request.signal?.aborted) {
    throw new HelmError('aborted', 'spawn 请求在创建前已取消（signal 已 abort）', 409)
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
  if (request.effort !== undefined && !THINKING_LEVELS.has(request.effort)) {
    throw new HelmError(
      'validation_error',
      `effort '${request.effort}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }

  const profileId = agentType || DEFAULT_SPAWN_PROFILE
  const profile = await deps.resolveProfile(profileId)
  if (profile === undefined) {
    throw new HelmError(
      'not_found',
      `agentType '${profileId}' 不是已注册的 Profile（profiles/${profileId} 不存在）`,
      404,
    )
  }
  if (profile.runtime) {
    // Profile 显式声明外部运行时（如 herdr）而未有其插件接管 -> 不默默降级原生。
    throw new HelmError(
      'unsupported_runtime',
      `Profile '${profileId}' 声明 runtime.kind='${profile.runtime.kind}'（agent '${profile.runtime.agent}'），` +
        `需要对应插件接管；原生 subagent 执行行不支持该运行时`,
      400,
    )
  }

  const modelRef = request.model ? parseSpawnModel(request.model) : undefined
  const resolvedModel = modelRef ?? (profile.model ? parseSpawnModel(profile.model) : undefined) ?? deps.resolveModel()
  const childCwd = request.cwd ?? profile.cwd ?? deps.defaultCwd
  // gate 与子会话同 cwd（请求缺省时用 profile/宿主缺省，不依赖 main cwd）。
  const gateCwd = childCwd

  // ---- resume 解析：纯数字 convId 或 agentId 映射；绝不猜测续接（'12abc' 拒绝）。----
  let childId: number | undefined
  let isResume = false
  const resumeRef = request.resume
  if (resumeRef !== undefined) {
    childId = resolveResumeRef(deps, resumeRef, request.parentConversationId)
    if (childId === undefined) {
      throw new HelmError(
        'not_found',
        `resume ref '${resumeRef}' 不存在或不属于父会话 ${request.parentConversationId}：` +
          `既非既有 agentId 会话映射，也非有效子会话 ID；绝不静默新建续接会话`,
        404,
      )
    }
    isResume = true
    request.onCreated?.(childId)
  }

  let structured: StructuredOutputSession | undefined
  if (request.schema) {
    // 声明边界即拒绝 $async：AJV 异步校验返回 Promise，同步 boolean 判断会
    // 把 Promise 当 truthy 放行非法数据（诚实性红线）。
    if ((request.schema as { $async?: unknown }).$async !== undefined) {
      throw new HelmError(
        'invalid_plugin_schema',
        `schema 含 $async：原生 subagent 同步校验边界不支持异步 Schema`,
        400,
      )
    }
    structured = { schema: request.schema, accepted: undefined }
  }

  if (!isResume) {
    const extension = structured ? buildStructuredOutputExtension(structured) : undefined
    if (extension) deps.installChildExtension(extension)
    const agentChange: AgentChange = {
      model: { provider: resolvedModel.provider, modelId: resolvedModel.modelId },
      cwd: childCwd,
      ...(request.effort ? { thinkingLevel: request.effort as ModelThinkingLevel } : {}),
      // extensions 需传扩展对象：SDK 存名（names()）但快照解析发生在 install 之后。
      ...(extension ? { extensions: [extension] } : {}),
    }
    const conv = await deps.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: agentChange },
      bg,
    )
    childId = conv.id as number
    if (request.agentId) deps.agentSessions.set(request.agentId, childId)
    await deps.registerChildConversation(childId, request.parentConversationId, profileId, childCwd)
    request.onCreated?.(childId)
  }

  const conversation = await deps.harness.conversation(childId as never, bg)
  if (!conversation) {
    throw new HelmError('not_found', `子会话不存在：${childId}`, 404)
  }

  // resume 续接时补挂结构化输出扩展（原会话创建时可能没有；同样需真实注册）。
  if (isResume && structured) {
    const extension = buildStructuredOutputExtension(structured)
    deps.installChildExtension(extension)
    await conversation.configure({ extensions: { add: [extension] } }, bg)
  }

  // ---- signal 桥：运行中 abort -> conversation.abort；listener 在 finally 摘除。----
  let abortError: HelmError | undefined
  const onAbort = () => {
    abortError = new HelmError('aborted', '子代理执行被取消（request.signal abort）', 499, {
      conversationId: childId,
    })
    void conversation.abort(bg).catch(() => {})
  }
  if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await driveTurn(deps, request, conversation, childId as number, structured, gateCwd)
  } catch (error) {
    if (abortError !== undefined && error !== abortError) throw abortError
    throw error
  } finally {
    if (request.signal) request.signal.removeEventListener('abort', onAbort)
  }
}

/** 一个回合的提交、等待与终态检查（schema 分支先检查 settled 再取文本）。 */
async function driveTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  const promptText = structured
    ? `${request.prompt}

<structured_output_contract>
完成回答后，调用 register_structured_output 工具提交最终结构化结果（output 参数必须满足给定 JSON Schema）。
Schema: ${JSON.stringify(structured.schema)}
</structured_output_contract>`
    : request.prompt

  const submission = await conversation.submit(
    { type: 'input', content: promptText, whenBusy: 'followUp' },
    bg,
  )
  const settled = await submission.wait(bg)
  assertNotUnanswered(settled, childId)

  if (structured) {
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd)
      return structured.accepted
    }
    // 未走工具：一次文本自愈追问（模型可能直接输出 JSON 文本）。
    const text = deps.getLastAssistantText(childId) ?? ''
    const parsed = parseSchemaCandidate(text, structured.schema)
    if (parsed.ok) {
      await settleGate(deps, request, gateCwd)
      return parsed.value
    }
    const heal = await conversation.submit(
      {
        type: 'input',
        content:
          `你上一条回答未通过 register_structured_output 工具提交结果。请立即调用 ` +
          `register_structured_output 工具，output 参数为满足 Schema 的合法 JSON。` +
          `
Schema: ${JSON.stringify(structured.schema)}`,
        whenBusy: 'followUp',
      },
      bg,
    )
    const healSettled = await heal.wait(bg)
    assertNotUnanswered(healSettled, childId)
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd)
      return structured.accepted
    }
    const lastText = deps.getLastAssistantText(childId) ?? ''
    const retry = parseSchemaCandidate(lastText, structured.schema)
    if (retry.ok) {
      await settleGate(deps, request, gateCwd)
      return retry.value
    }
    throw new HelmError(
      'schema_validation_failed',
      `子代理（会话 ${childId}）两次输出均未通过 Schema 校验；最后输出开头：${(retry.raw || lastText).slice(0, 200)}`,
      502,
      { conversationId: childId, lastText: lastText.slice(0, 1000) },
    )
  }

  await settleGate(deps, request, gateCwd)
  const text = deps.getLastAssistantText(childId)
  if (text === undefined || text === '') {
    throw new HelmError('subagent_failed', `子代理（会话 ${childId}）完成但无文本输出`, 502, {
      conversationId: childId,
    })
  }
  return text
}

/** 未完成回合（失败/中止等）显式报错；绝不返回旧 assistant 文本冒充结果。 */
function assertNotUnanswered(settled: { status: string; reason?: string }, childId: number): void {
  if (settled.status !== 'unanswered') return
  throw new HelmError(
    'subagent_failed',
    `子代理（会话 ${childId}）回合未完成：${settled.reason}`,
    502,
    { conversationId: childId, reason: settled.reason },
  )
}

interface StructuredOutputSession {
  schema: Record<string, unknown>
  accepted: unknown | undefined
}

/** register_structured_output 工具扩展（per-child 注入，accepted 经闭包回传）。 */
function buildStructuredOutputExtension(session: StructuredOutputSession): Extension {
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
    async execute(args) {
      const payload = (args as { output?: unknown }).output
      const result = validateAgainstSchema(payload, session.schema)
      if (!result.ok) {
        return {
          output: [
            {
              type: 'text',
              text:
                `结构化输出校验失败，请修正后重新调用 register_structured_output：\n${result.errors}` +
                `
Schema: ${JSON.stringify(session.schema)}`,
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

async function settleGate(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  cwd: string,
): Promise<void> {
  if (!request.gate) return
  // cwd 用子会话实际工作目录，不依赖请求缺省 main cwd；gate 是验收命令，
  // 输出直接进错误诊断（不挂会话，避免误注入会话级 stash 环境）。
  const gate = await runGate(deps, request.gate, { cwd, signal: request.signal })
  if (!gate.ok) {
    throw new HelmError(
      'gate_failed',
      `验收命令失败（exit≠0）：${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      { output: gate.output.slice(-4000) },
    )
  }
}

/** AJV 全量校验（复用 plugins/schema；$async 在编译期已拒绝）。 */
function validateAgainstSchema(
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

function parseSpawnModel(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash <= 0) throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/**
 * resume ref 严格解析：仅接受纯十进制整数 convId（agentId 映射先翻译成 convId 再走同一校验）。
 * 会话必须真实存在且父归属正确；任何失败返回 undefined（调用方显式报错，
 * 绝不 Number.parseInt('12abc') 宽容续接到错误会话，绝不静默新建假续接）。
 */
function resolveResumeRef(deps: NativeSpawnDeps, ref: string, parentId: number): number | undefined {
  const mapped = deps.agentSessions.get(ref)
  const candidate = mapped ?? (/^\d+$/.test(ref) ? Number(ref) : undefined)
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate <= 0) return undefined
  const parent = deps.getParentOfConversation(candidate)
  if (parent === undefined || parent !== parentId) return undefined
  return candidate
}
