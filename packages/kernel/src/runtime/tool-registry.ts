/**
 * runtime tool install match: negative duty kernel basis tool (helm-core) and plugin derived tool (helm-plugins) register and hot install.
 *
 * responsibility:
 * 1. installKernelTools: construct bash/read/write/edit/read_artifact/register_artifact
 *    and run_action meta tool, unify with wrapToolExecute wrap with support tool_call handled take over return;
 * 2. installPluginTools: PluginHost.listTools() return DerivedToolSpec mapping is real SDK
 *    tool extend and install to registry(original ground hot replace old plugin tool extend), out station result via pluginToolResult redaction and format;
 * 3. consume and HookBridge sharing handledToolCalls Map, implement without reverse dependency tool level intercept short route.
 */

import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { HelmError, matchesConversationScope } from '@helm/protocol'
import type { ConversationSummary } from '@helm/protocol'
import type { DerivedToolSpec, PluginHost } from '../plugins/index.js'
import type { HandledToolCallEntry } from './hook-bridge.js'
import { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
import { pluginToolResult } from './runtime-helpers.js'
import { throwIfToolAborted, type HelmToolDeps } from './tool-deps.js'
import {
  createBashTool,
  createEditTool,
  createReadArtifactTool,
  createReadTool,
  createRegisterArtifactTool,
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
  /** conversation summary read (run_action describe pattern scope decide use). */
  readonly getConversation: (conversationId: number) => ConversationSummary
}

type PluginToolApi = Pick<ToolExecutionApi, 'conversationId'> & {
  callId?: string
  output?: (chunk: string) => void
}

/** kernel/plugin tool execute wrap:tool_call handled take over result takes precedence return (do not execute real tool). */
export function wrapToolExecute<
  TArgs,
  TApi extends { callId?: string },
  TContext extends { abortSignal?: AbortSignal },
  TResult,
>(
  handledToolCalls: Map<string, HandledToolCallEntry>,
  execute: (args: TArgs, api: TApi, context: TContext) => Promise<TResult>,
): (args: TArgs, api: TApi, context: TContext) => Promise<TResult | HandledToolCallEntry['result']> {
  return async (args, api, context) => {
    const callId = api.callId
    const handled = callId !== undefined ? handledToolCalls.get(callId) : undefined
    if (handled !== undefined) {
      handledToolCalls.delete(callId!)
      return handled.result
    }
    const result = await execute(args, api, context)
    // if tool implement swallow or convert abort (such as return { isError: true }), in this unify throw abort
    // exception, ensure pi-durable ToolTask enter interrupt / writeAtClose() retreat back pending branch.
    throwIfToolAborted(context?.abortSignal)
    return result
  }
}

/**
 * unify wrap specific tool register and erase inverse change parameter generic, concentrate consolidate to `Extension.tools` different construct array boundary.
 */
function wrapToolRegistration<TParameters extends object, TDetails extends JsonValue>(
  handledToolCalls: Map<string, HandledToolCallEntry>,
  tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration {
  const execute = wrapToolExecute(handledToolCalls, tool.execute.bind(tool))
  return {
    ...tool,
    execute,
  } as unknown as ToolRegistration
}

export class RuntimeToolRegistry {
  constructor(private readonly options: RuntimeToolRegistryOptions) {}

  /**
   * kernel basis tool (bash/read/write/edit/read_artifact/register_artifact +
   * run_action meta tool) unify register (and plugin tool the same registry mechanism;execute unify
   * package handled take over).subagent / SubagentWorkflow / cleanup_worktree by
   * builtin:workflow plugin provide.
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
        if (!host) throw new HelmError('runtime_not_initialized', 'plugin host not initialized', 503)
        return host.invokeAction(pluginId, actionId, input, context)
      },
      describePluginAction: async (
        pluginId: string,
        actionId: string,
        context: { conversationId: number },
      ) => {
        const host = getPluginHost()
        if (!host) throw new HelmError('runtime_not_initialized', 'plugin host not initialized', 503)
        // only read manifest query: never via invokeAction(do not execute handler, does not input validate,
        // do not create liveTask); enable filter inside create in listActions(activeEnabledPluginIds).
        const manifest = host
          .listActions()
          .find((item) => item.pluginId === pluginId && item.id === actionId)
        if (manifest === undefined) {
          throw new HelmError(
            'unknown_action',
            `plugin ${pluginId} not declaration action ${actionId}(or not enabled)`,
            404,
            { pluginId, actionId },
          )
        }
        // scope outside conversation do not leak Schema: and execute during same code reject (description side and execute side consistent).
        if (!matchesConversationScope(manifest.scope, getConversation(context.conversationId))) {
          throw new HelmError(
            'conversation_scope_violation',
            `action ${pluginId}.${actionId} disallows in conversation ${context.conversationId} on query (scope missed)`,
            403,
            { pluginId, actionId, conversationId: context.conversationId },
          )
        }
        return manifest
      },
      redact: (text: string) => redact(text),
    }
    const kernelTools: ToolRegistration[] = [
      wrapToolRegistration(handledToolCalls, createBashTool(toolDeps)),
      wrapToolRegistration(handledToolCalls, createReadTool(toolDeps)),
      wrapToolRegistration(handledToolCalls, createWriteTool(toolDeps)),
      wrapToolRegistration(handledToolCalls, createEditTool(toolDeps)),
      wrapToolRegistration(
        handledToolCalls,
        createReadArtifactTool(toolDeps, (convId: number, artifactConvId: number) =>
          isArtifactAuthorized(convId, artifactConvId),
        ),
      ),
      wrapToolRegistration(handledToolCalls, createRegisterArtifactTool(toolDeps)),
      wrapToolRegistration(handledToolCalls, createRunActionTool(toolHost)),
    ]
    registry.install(defineExtension({ name: 'helm-core', tools: kernelTools }))
  }

  /**
   * based on plugin provide DerivedToolSpec manifest construct helm-plugins extend and install.
   * same name extend install semantics is original ground replace; empty collection also will install with empty old plugin tool.
   * onUpdate partial via SDK original generate api.output mechanism enter real-time view (conversation.live
   * tool card); string/text chunk all unify redaction, compute after invoke static default ignore (SDK contract).
   */
  installPluginTools(specs: DerivedToolSpec[]): void {
    const { registry, getPluginHost, redact, handledToolCalls } = this.options
    const host = getPluginHost()
    if (!host) return
    const tools: ToolRegistration[] = specs.map((spec) => {
      const parameters = (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
      const raw = defineTool({
        name: spec.name,
        description: spec.description,
        parameters,
        ...(spec.structuredOutputSchema !== undefined
          ? { structuredOutputSchema: spec.structuredOutputSchema }
          : {}),
        async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
          const toolApi: PluginToolApi = api
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
            signal: context.abortSignal,
            ...(typeof toolApi.output === 'function'
              ? {
                  onUpdate: (partial) => {
                    // SDK contract: compute after output throws (Tool call has settled) - - only
                    // this one class late to partial static default discard; other exception (host fault etc.) such as
                    // on throw to plugin act, never swallow disguise succeeded. redaction by complete partial all string
                    // execute (secret may across chunk concatenate, sync all string redactor override when time
                    // snapshot; do not sound call eliminate everything process inside leak leak).
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
          // plugin tool return any value: package into SDK ToolExecutionResult contract (content/text).
          return pluginToolResult(result, (text) => redact(text), {
            structuredOutputSchema: spec.structuredOutputSchema,
            toolName: spec.name,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
          }) as ToolExecutionResult
        },
      })
      return wrapToolRegistration(handledToolCalls, raw)
    })
    registry.install(defineExtension({ name: 'helm-plugins', tools }))
  }

  /** plugin start stop after hot update tool collection (app combine layer and enable/disable path invoke). */
  refreshPluginTools(): void {
    const host = this.options.getPluginHost()
    if (!host) return
    this.installPluginTools(host.listTools())
  }
}
