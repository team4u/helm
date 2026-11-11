/**
 * hook 桥：SDK GenerationTask/ToolTask 钩子 -> helm 7 类生命周期 hook 管道。
 *
 * 从 runtime.ts 拆出。tool_call/tool_result/before_turn 在此接到 PluginHost
 * 的 runHook；turn_settled 的兑底清理（handled 接管残留）由宿主经回调注入。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { GenerationTask, ToolTask, defineExtension, hook, type Extension, type ToolExecutionResult } from '@earendil-works/pi-durable'
import type { ConversationSummary, ToolResultHookPayload } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { PluginHost } from '../plugins/index.js'
import { redactJsonValue } from '../redact.js'
import {
  assertSafeMessageSurgery,
  normalizeToolResult,
  projectToolPromptSections,
  sectionsEqual,
  systemSectionsOf,
  toolResultOf,
  withSections,
  withToolDeclarations,
} from './runtime-helpers.js'

export type HookDecision =
  | { action: 'continue' }
  | { action: 'transform'; value: unknown }
  | { action: 'handled'; result?: unknown }
  | { action: 'block'; reason: string }

/** tool_call handled 接管缓存条目（execute 层包装器消费；归属会话用于兑底清理）。 */
export interface HandledToolCallEntry {
  conversationId: number | undefined
  result: { output: Array<{ type: 'text'; text: string }>; isError: boolean }
}

export interface HookBridgeOptions {
  readonly registry: { install(extension: Extension): void }
  /** pluginHost 热注入（initialize 阶段可能尚未创建）。 */
  readonly pluginHost: () => PluginHost | undefined
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
  /** 工具结果出站统一处理（Spill 边界 + 脱敏；宿主实现）。 */
  readonly prepareToolResult: (conversationId: number, result: ToolExecutionResult) => Promise<ToolExecutionResult>
  /** 会话摘要安全读取（不存在/损坏返回 undefined -> 跳过 before_turn）。 */
  readonly safeSummary: (conversationId: number) => ConversationSummary | undefined
  /** 当前回合输入清单（before_turn payload 用）。 */
  readonly currentRunInputs: (conversationId: number) => unknown
  readonly redact: (text: string) => string
  /** 工具产物落盘端口（prepareToolResult 的宿主实现用）。 */
  readonly artifacts: {
    spill(conversationId: number, id: string, text: string): Promise<{ artifact?: unknown; text: string }>
  }
}

export class HookBridge {
  private readonly options: HookBridgeOptions

  constructor(options: HookBridgeOptions) {
    this.options = options
  }

  /** 安装 SDK 钩子扩展（initialize 阶段一次）。 */
  install(): void {
    const self = this
    this.options.registry.install(
      defineExtension({
        name: 'helm-hook-bridge',
        hooks: [
          hook(ToolTask, {
            /** tool_call：transform 改写参数 / block 拦截。 */
            beforeTool: async (call, api) => {
              const outcome = await self.runHookChain('tool_call', {
                conversationId: api.conversationId as number,
                callId: call.id,
                toolName: call.name,
                input: call.arguments as Record<string, unknown>,
              })
              if (outcome?.action === 'block') {
                return { block: self.options.redact(outcome.reason ?? 'blocked') }
              }
              if (outcome?.action === 'handled') {
                // 接管：结果登记到 execute 层缓存（wrapToolCalls 包装器消费）；
                // 同时记录归属会话，回合终态/abort/删除时兑底清理未消费残留。
                self.options.handledToolCalls.set(call.id, {
                  conversationId: api.conversationId as number,
                  result: toolResultOf(outcome.result),
                })
                return undefined
              }
              if (outcome?.action === 'transform') {
                const value = outcome.value as { input?: Record<string, unknown> }
                return { arguments: (value.input ?? call.arguments) as never }
              }
              return undefined
            },
            /** 所有工具最终输出都在持久化前经过同一脱敏与 Spill 边界。 */
            afterTool: async (call, result, api) => {
              self.options.handledToolCalls.delete(call.id)
              try {
                const outcome = await self.runHookChain('tool_result', {
                  conversationId: api.conversationId as number,
                  callId: call.id,
                  toolName: call.name,
                  input: call.arguments as Record<string, unknown>,
                  result,
                })
                let effective = result
                if (outcome?.action === 'transform') {
                  const payload = outcome.value as ToolResultHookPayload
                  const transformed = normalizeToolResult(payload.result)
                  if (!transformed) throw new HelmError('invalid_hook_result', 'tool_result 必须返回合法工具结果', 500)
                  effective = transformed as ToolExecutionResult
                } else if (outcome?.action === 'handled') {
                  const handled = normalizeToolResult(outcome.result)
                  if (!handled) throw new HelmError('invalid_hook_result', 'tool_result 接管产物不是合法工具结果', 500)
                  effective = handled as ToolExecutionResult
                }
                return await self.options.prepareToolResult(api.conversationId as number, effective)
              } catch (error) {
                return {
                  isError: true,
                  output: [{ type: 'text', text: self.options.redact(`tool_result_failed: ${error instanceof Error ? error.message : String(error)}`) }],
                }
              }
            },
          }),
          hook(GenerationTask, {
            /**
             * before_turn 桥：SDK 原生 sections（PromptSection）与 tools 已在
             * prepare 阶段解析（request.messages 内含 pi.system 段消息），
             * beforeRequest 收到的 messages 是最终模型消息（含 system 前导）。
             * 这里把 sections/tools/messages 真实载荷交给插件，transform 结果
             * 通过 system 消息 sections / toolsAdded 真正改写模型请求。
             * 钩子链收敛后宿主统一投射 prompt.tools.* 段（见 transformBeforeTurn）。
             */
            beforeRequest: async (request, api) => {
              const conversationId = api.conversationId as number
              const summary = self.options.safeSummary(conversationId)
              if (!summary) return undefined
              return self.transformBeforeTurn(request, summary, conversationId) as never
            },
          }),
        ],
      }) as Extension,
    )
  }

  /** before_turn transform 应用（sections / messages / tools 三路手术）。 */
  private async transformBeforeTurn(
    request: { messages: unknown },
    summary: ConversationSummary,
    conversationId: number,
  ): Promise<{ messages: unknown } | undefined> {
    const runtimeTools = getCurrentTools(request.messages as never)
    const payload = {
      conversation: summary,
      inputs: this.options.currentRunInputs(conversationId),
      tools: runtimeTools.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.parameters as Record<string, unknown>,
      })),
      sections: systemSectionsOf(request.messages as unknown as Array<Record<string, unknown>>),
      messages: request.messages as unknown as Array<Record<string, unknown>>,
    }
    const outcome = await this.runHookChain('before_turn', payload)
    // 宿主终局投射：无论钩子是否 transform，按最终 active tools 统一重写
    // prompt.tools.* 段（仅激活工具进提示词；停用/剥离的工具旧段一并清除，
    // 不留幻影文本）。投射基于 PluginHost 当前声明（含 prompt 元数据）。
    const activeTools = this.activeToolPrompts(summary, payload.tools, outcome)
    const outcomeSections = outcome?.action === 'transform'
      ? (outcome.value as typeof payload).sections
      : payload.sections
    const projected = projectToolPromptSections(outcomeSections, activeTools)
    if (outcome?.action !== 'transform' && projected === outcomeSections) return undefined
    const value: typeof payload = outcome?.action === 'transform'
      ? { ...(outcome.value as typeof payload), sections: projected }
      : { ...payload, sections: projected }

    // sections 变更 -> 改写前导 system 消息的 sections（SDK 原生机制）。
    // messages 变更 -> 整体替换（插件显式要求时）。边界校验：
    // 1. 必须是非空数组且前导为 system 消息（SDK 回放机制依赖前导 system）；
    // 2. 保留原前导 system 的 content 基底（sections/tools 声明可改，人格与
    //    历史正文绝不可被插件覆写——防原地 mutation diff 不可靠与 system 头损坏）；
    // 3. 原第一条非 system 消息之后的历史一律保留原序（只允许截断头部，
    //    不允许重写/伪造历史）。
    const original = request.messages as unknown as Array<Record<string, unknown>>
    let messages = original
    const sectionsChanged = !sectionsEqual(value.sections, payload.sections)
    const messagesChanged = value.messages !== payload.messages
    if (messagesChanged) messages = assertSafeMessageSurgery(original, value.messages)
    if (sectionsChanged) messages = withSections(messages, value.sections)

    const initialNames = new Set(runtimeTools.map((tool) => tool.name))
    const declared = new Set(value.tools.map((tool) => tool.name))
    if (declared.size !== initialNames.size || [...declared].some((name) => !initialNames.has(name))) {
      messages = withToolDeclarations(messages, declared, runtimeTools)
    }
    if (messages === original) return undefined
    return { messages: messages as unknown as typeof request.messages }
  }

  /**
   * 最终 active tools 的提示词元数据集：PluginHost 当前声明（scope 过滤）
   * 与钩子链收敛后的工具清单取交集——被插件剥离（如 memory 关闭）的工具
   * 不投射任何段落。钩子未 transform 时以 SDK 解析的请求工具集为准。
   */
  private activeToolPrompts(
    summary: ConversationSummary,
    requestTools: Array<{ name: string }>,
    outcome: { action: string; value?: unknown } | undefined,
  ): Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }> {
    const host = this.options.pluginHost()
    if (!host) return []
    const declared = host.listTools(summary)
    const requestNames = new Set(requestTools.map((tool) => tool.name))
    const finalNames =
      outcome?.action === 'transform'
        ? new Set(
            ((outcome.value as { tools?: Array<{ name?: unknown }> }).tools ?? [])
              .filter((t) => typeof t.name === 'string')
              .map((t) => t.name as string),
          )
        : requestNames
    const out: Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }> = []
    for (const spec of declared) {
      if (!requestNames.has(spec.name)) continue
      if (!finalNames.has(spec.name)) continue
      if (spec.promptSnippet === undefined && spec.promptGuidelines === undefined) continue
      out.push({
        name: spec.name,
        ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
        ...(spec.promptGuidelines !== undefined ? { promptGuidelines: spec.promptGuidelines } : {}),
      })
    }
    return out
  }

  /** 统一 hook 管道执行；返回最终决定（continue 归一为 undefined 由调用方走默认）。 */
  async runHookChain(name: string, payload: unknown): Promise<HookDecision | undefined> {
    const host = this.options.pluginHost()
    if (!host) return undefined
    const result = await host.runHook(name as never, payload as never)
    if (result.action === 'continue') return undefined
    return result as HookDecision
  }

  /**
   * around（continuation）钩子执行（仅 agent_spawn）：插件可经受控 next
   * 包裹完整执行（含后续管道与默认原生执行行）。无插件时直接 defaultRun。
   */
  runHookAround(
    name: 'agent_spawn',
    payload: import('@helm/protocol').AgentSpawnRequest,
    defaultRun: (finalPayload: import('@helm/protocol').AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    const host = this.options.pluginHost()
    if (!host) return defaultRun(payload)
    return host.runHookAround(name, payload, defaultRun)
  }
}

/** SDK 结果出站统一处理：脱敏 + Spill 边界（artifacts 上限截断到产物）。 */
export async function prepareToolResultWith(
  artifacts: HookBridgeOptions['artifacts'],
  redact: (text: string) => string,
  conversationId: number,
  result: ToolExecutionResult,
): Promise<ToolExecutionResult> {
  // SDK 结果的可选属性可为 undefined；先按 JSON 语义省略，再逐字符串脱敏。
  const safe = redactJsonValue(JSON.parse(JSON.stringify(result)), redact) as ToolExecutionResult
  const output = safe.output ?? []
  const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const spill = await artifacts.spill(conversationId, `tool-${randomUUID()}`, text)
  if (!spill.artifact) return safe
  return { ...safe, output: [{ type: 'text', text: spill.text }, ...output.filter((block) => block.type !== 'text')] }
}

export { BACKGROUND_CONTEXT }
