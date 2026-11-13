/**
 * 运行时工具装配器：负责内核基础工具（helm-core）与插件衍生工具（helm-plugins）的注册与热装。
 *
 * 职责：
 * 1. installKernelTools：构造 bash/read/write/edit/read_artifact 与 run_action 元工具，
 *    统一以 wrapToolExecute 包装以支持 tool_call handled 接管返回；
 * 2. installPluginTools：将 PluginHost.listTools() 返回的 DerivedToolSpec 映射为真实 SDK
 *    工具扩展并安装到 registry（原地热替换旧插件工具扩展），出站结果经 pluginToolResult 脱敏与格式化；
 * 3. 消费与 HookBridge 共享的 handledToolCalls Map，实现无反向依赖的工具级拦截短路。
 */

import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { HelmError, matchesConversationScope } from '@helm/protocol'
import type { ConversationSummary } from '@helm/protocol'
import type { DerivedToolSpec, PluginHost } from '../plugins/index.js'
import type { HandledToolCallEntry } from './hook-bridge.js'
import { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
import { pluginToolResult } from './runtime-helpers.js'
import type { HelmToolDeps } from './tool-deps.js'
import {
  createBashTool,
  createEditTool,
  createReadArtifactTool,
  createReadTool,
  createWriteTool,
} from './tools.js'

export type PluginHostToolTarget = Pick<PluginHost, 'invokeAction' | 'executeTool' | 'listTools' | 'listActions'>

export interface RuntimeToolRegistryOptions {
  readonly registry: { install(extension: Extension): void }
  readonly toolDeps: HelmToolDeps
  readonly getPluginHost: () => PluginHostToolTarget | undefined
  readonly isArtifactAuthorized: (conversationId: number, artifactConversationId: number) => boolean
  readonly redact: (text: string) => string
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
  /** 会话摘要读取（run_action describe 模式的 scope 判定用）。 */
  readonly getConversation: (conversationId: number) => ConversationSummary
}

/** 内核/插件工具 execute 包装：tool_call handled 接管结果优先返回（不执行真实工具）。 */
export function wrapToolExecute(
  handledToolCalls: Map<string, HandledToolCallEntry>,
  execute: (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown>,
): (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown> {
  return async (args, api, context) => {
    const callId = (api as unknown as { callId?: string }).callId
    const handled = callId !== undefined ? handledToolCalls.get(callId) : undefined
    if (handled !== undefined) {
      handledToolCalls.delete(callId!)
      return handled.result
    }
    return execute(args, api, context)
  }
}

export class RuntimeToolRegistry {
  constructor(private readonly options: RuntimeToolRegistryOptions) {}

  /**
   * 内核基础工具（bash/read/write/edit/read_artifact + run_action 元工具）
   * 统一注册（与插件工具同一 registry 机制；execute 统一包 handled 接管）。
   * subagent / SubagentWorkflow / cleanup_worktree 由 builtin:workflow 插件提供。
   */
  installKernelTools(): void {
    const { registry, toolDeps, getPluginHost, isArtifactAuthorized, redact, handledToolCalls, getConversation } = this.options
    const toolHost: KernelToolHost = {
      invokePluginAction: async (
        pluginId: string,
        actionId: string,
        input: unknown,
        context: { conversationId: number; signal?: AbortSignal },
      ) => {
        const host = getPluginHost()
        if (!host) throw new HelmError('runtime_not_initialized', '插件宿主未初始化', 503)
        return host.invokeAction(pluginId, actionId, input, context)
      },
      describePluginAction: async (
        pluginId: string,
        actionId: string,
        context: { conversationId: number },
      ) => {
        const host = getPluginHost()
        if (!host) throw new HelmError('runtime_not_initialized', '插件宿主未初始化', 503)
        // 只读清单查询：绝不经 invokeAction（不执行 handler、不微输入校验、
        // 不创建 liveTask）；启用过滤内建在 listActions（activeEnabledPluginIds）。
        const manifest = host
          .listActions()
          .find((item) => item.pluginId === pluginId && item.id === actionId)
        if (manifest === undefined) {
          throw new HelmError(
            'unknown_action',
            `插件 ${pluginId} 未声明动作 ${actionId}（或未启用）`,
            404,
            { pluginId, actionId },
          )
        }
        // scope 外会话不泄露 Schema：与执行期间同码拒绝（描述面与执行面一致）。
        if (!matchesConversationScope(manifest.scope, getConversation(context.conversationId))) {
          throw new HelmError(
            'conversation_scope_violation',
            `动作 ${pluginId}.${actionId} 不允许在会话 ${context.conversationId} 上查询（scope 未命中）`,
            403,
            { pluginId, actionId, conversationId: context.conversationId },
          )
        }
        return manifest
      },
      redact: (text: string) => redact(text),
    }
    const kernelTools = [
      createBashTool(toolDeps),
      createReadTool(toolDeps),
      createWriteTool(toolDeps),
      createEditTool(toolDeps),
      createReadArtifactTool(toolDeps, (convId: number, artifactConvId: number) =>
        isArtifactAuthorized(convId, artifactConvId),
      ),
      createRunActionTool(toolHost),
    ].map((tool) => {
      const raw = tool as unknown as Record<string, unknown>
      const execute = raw['execute'] as (
        args: never,
        api: never,
        context: never,
      ) => Promise<unknown>
      return {
        ...raw,
        execute: wrapToolExecute(
          handledToolCalls,
          execute.bind(raw) as unknown as (
            args: never,
            api: never,
            context: { abortSignal?: AbortSignal },
          ) => Promise<unknown>,
        ),
      } as unknown as ToolRegistration
    })
    registry.install(
      defineExtension({ name: 'helm-core', tools: kernelTools }) as Extension,
    )
  }

  /**
   * 根据插件提供的 DerivedToolSpec 清单构造 helm-plugins 扩展并安装。
   * 同名扩展 install 语义为原地替换；空集也会安装以清空旧插件工具。
   * onUpdate partial 经 SDK 原生 api.output 机制进入实时视图（conversation.live
   * 工具卡）；字符串/文本块均过统一脱敏，结算后调用静默忽略（SDK 契约）。
   */
  installPluginTools(specs: DerivedToolSpec[]): void {
    const { registry, getPluginHost, redact, handledToolCalls } = this.options
    const host = getPluginHost()
    if (!host) return
    const tools = specs.map((spec) => {
      const raw = defineTool({
        name: spec.name,
        description: spec.description,
        parameters: (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, object>,
        ...(spec.structuredOutputSchema !== undefined
          ? { structuredOutputSchema: spec.structuredOutputSchema as Record<string, object> }
          : {}),
        async execute(args: unknown, api: never, context: { abortSignal?: AbortSignal }) {
          const toolApi = api as unknown as { conversationId: number; callId?: string; output?: (chunk: string) => void }
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
            signal: context.abortSignal,
            ...(typeof toolApi.output === 'function'
              ? {
                  onUpdate: (partial) => {
                    // SDK 契约：结算后 output 抛错（Tool call has settled）——仅
                    // 此一类迟到 partial 静默丢弃；其他异常（宿主故障等）如实
                    // 上抛给插件作者，绝不吞掉伪装成功。脱敏按完整 partial 全串
                    // 执行（secret 可能跨 chunk 拼接，同步全串 redactor 覆盖当次
                    // 快照；不声称消除一切进程内泄漏）。
                    const text = typeof partial.output === 'string'
                      ? partial.output
                      : partial.output.map((block) => block.text).join('')
                    try {
                      toolApi.output!(redact(text))
                    } catch (err) {
                      if (err instanceof Error && err.message.includes('has settled')) return
                      throw err
                    }
                  },
                }
              : {}),
          })
          // 插件工具返回任意值：包成 SDK ToolExecutionResult 契约（content/text）。
          return pluginToolResult(result, (text) => redact(text), {
            structuredOutputSchema: spec.structuredOutputSchema,
            toolName: spec.name,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
          })
        },
      } as never) as unknown as {
        execute: (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown>
      }
      return {
        ...raw,
        execute: wrapToolExecute(
          handledToolCalls,
          raw.execute.bind(raw) as unknown as (
            args: never,
            api: never,
            context: { abortSignal?: AbortSignal },
          ) => Promise<unknown>,
        ),
      } as never
    })
    registry.install(defineExtension({ name: 'helm-plugins', tools }) as Extension)
  }

  /** 插件启停后热更新工具集（app 组合层与 enable/disable 路径调用）。 */
  refreshPluginTools(): void {
    const host = this.options.getPluginHost()
    if (!host) return
    this.installPluginTools(host.listTools())
  }
}
