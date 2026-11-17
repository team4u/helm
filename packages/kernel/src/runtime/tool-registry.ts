/**
 * Runtime tool installer: registers and hot-swaps foundational kernel tools (`helm-core`) and plugin-derived
 * tools (`helm-plugins`).
 *
 * Responsibilities:
 * 1. `installKernelTools`: constructs `bash`/`read`/`write`/`edit`/`read_artifact`/`register_artifact` and the
 *    `run_action` meta-tool, wrapped uniformly via `wrapToolExecute` to honor `tool_call` `handled` takeovers;
 * 2. `installPluginTools`: converts `DerivedToolSpec` entries from `PluginHost.listTools()` into SDK tool
 *    extensions and installs them into the registry (replacing stale `helm-plugins` tools in place), with
 *    outbound results redacted and formatted via `pluginToolResult`;
 * 3. Shares the `handledToolCalls` Map with `HookBridge` for tool-level interception short-circuiting without
 *    circular dependencies.
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

interface RuntimeToolRegistryOptions {
  readonly registry: { install(extension: Extension): void }
  readonly toolDeps: HelmToolDeps
  readonly getPluginHost: () => PluginHostToolTarget | undefined
  readonly isArtifactAuthorized: (conversationId: number, artifactConversationId: number) => boolean
  readonly redact: (text: string) => string
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
  /** Conversation summary lookup (used for `run_action` `describe` scope checks). */
  readonly getConversation: (conversationId: number) => ConversationSummary
}

type PluginToolApi = Pick<ToolExecutionApi, 'conversationId'> & {
  callId?: string
  output?: (chunk: string) => void
}

/** Kernel/plugin tool execution wrapper: returns `tool_call` `handled` takeover results first without running the tool. */
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
    // If a tool implementation swallowed or converted an abort (e.g. returned `{ isError: true }`), rethrow
    // uniformly here so pi-durable `ToolTask` enters its interrupted / `writeAtClose()` revert-to-pending branch.
    throwIfToolAborted(context?.abortSignal)
    return result
  }
}

/**
 * Uniformly wrap typed tool registrations and erase contravariant type params at the heterogeneous
 * `Extension.tools` array boundary.
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
   * Install foundational kernel tools (`bash`/`read`/`write`/`edit`/`read_artifact`/`register_artifact` +
   * `run_action` meta-tool) under `helm-core` (sharing the same registry and `wrapToolExecute` takeover path as
   * plugins). `subagent` / `SubagentWorkflow` / `cleanup_worktree` are provided by `builtin:workflow`.
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
        // Read-only manifest query: never calls `invokeAction` (never executes handler, validates input, or
        // creates a `liveTask`); enablement filtering already comes from `listActions(activeEnabledPluginIds)`.
        const manifest = host
          .listActions()
          .find((item) => item.pluginId === pluginId && item.id === actionId)
        if (manifest === undefined) {
          throw new HelmError(
            'unknown_action',
            `Plugin '${pluginId}' does not declare action '${actionId}' (or is disabled)`,
            404,
            { pluginId, actionId },
          )
        }
        // Do not leak schemas to out-of-scope conversations: reject with the exact same code as execution.
        if (!matchesConversationScope(manifest.scope, getConversation(context.conversationId))) {
          throw new HelmError(
            'conversation_scope_violation',
            `Action '${pluginId}.${actionId}' cannot be queried in conversation ${context.conversationId} (outside allowed scope)`,
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
   * Build and install the `helm-plugins` extension from plugin `DerivedToolSpec` declarations.
   * Re-installing under the same extension name replaces tools in place; an empty array clears stale tools.
   * Partial `onUpdate` payloads stream to live tool cards via native `api.output`; text is redacted uniformly,
   * and post-settlement calls are silently ignored per SDK contract.
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
        ...(spec.replay !== undefined ? { replay: spec.replay } : {}),
        async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
          const toolApi: PluginToolApi = api
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
            signal: context.abortSignal,
            ...(typeof toolApi.output === 'function'
              ? {
                  onUpdate: (partial) => {
                    // SDK contract: `output()` throws after settlement (`Tool call has settled`) — silently
                    // drop only that late-update case; propagate other errors (e.g. host faults) to plugin authors
                    // rather than faking success. Redaction runs on full concatenated partial text (so secrets split
                    // across chunks still match; synchronous `redact` snapshots current secrets and does not promise
                    // eliminating all in-process leaks).
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
          // Wrap arbitrary plugin return value into the SDK `ToolExecutionResult` contract.
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

  /** Hot-update plugin tool set after plugins enable/disable (called from app assembly and lifecycle handlers). */
  refreshPluginTools(): void {
    const host = this.options.getPluginHost()
    if (!host) return
    this.installPluginTools(host.listTools())
  }
}
