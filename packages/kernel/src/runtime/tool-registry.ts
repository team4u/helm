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
import { HelmError } from '@helm/protocol'
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

export type PluginHostToolTarget = Pick<PluginHost, 'invokeAction' | 'executeTool' | 'listTools'>

export interface RuntimeToolRegistryOptions {
  readonly registry: { install(extension: Extension): void }
  readonly toolDeps: HelmToolDeps
  readonly getPluginHost: () => PluginHostToolTarget | undefined
  readonly isArtifactAuthorized: (conversationId: number, artifactConversationId: number) => boolean
  readonly redact: (text: string) => string
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
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
    const { registry, toolDeps, getPluginHost, isArtifactAuthorized, redact, handledToolCalls } = this.options
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
          const toolApi = api as unknown as { conversationId: number; callId?: string }
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
            signal: context.abortSignal,
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
