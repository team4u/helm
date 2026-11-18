/**
 * Hook bridge: maps SDK `GenerationTask` / `ToolTask` hooks to helm's 7 lifecycle hook pipelines.
 *
 * Extracted from `runtime.ts`. Bridges `tool_call`, `tool_result`, and `before_turn` into `PluginHost.runHook`;
 * terminal cleanup (`handled` takeover leftovers) for `turn_settled` is injected by the host via callbacks.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import {
  GenerationTask,
  ToolTask,
  defineExtension,
  hook,
  type Extension,
  type JsonObject,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable'
import type {
  BeforeTurnHookPayload,
  ConversationSummary,
  HookName,
  HookPayloadMap,
  HookResult,
} from '@helm/protocol'
import { HelmError, matchesConversationScope } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { PluginHost } from '../plugins/index.js'
import { redactJsonValue } from '../redact.js'
import {
  actionCliCommand,
  projectActionPromptSection,
  renderAvailableActionsSection,
  type ActionDirectoryEntry,
} from './action-prompts.js'
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

type HookDecision =
  | { action: 'continue' }
  | { action: 'transform'; value: unknown }
  | { action: 'handled'; result?: unknown }
  | { action: 'block'; reason: string }

/** Cached `tool_call` `handled` takeover entry (consumed by execution-layer wrapper; `conversationId` tracks owner for safety cleanup). */
export interface HandledToolCallEntry {
  conversationId: number | undefined
  result: { output: Array<{ type: 'text'; text: string }>; isError: boolean }
}

interface HookBridgeOptions {
  readonly registry: { install(extension: Extension): void }
  /** Lazily resolved `PluginHost` (may not exist yet during initialization). */
  readonly pluginHost: () => PluginHost | undefined
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
  /** Unified outbound tool-result processor (spill boundary + redaction; host implementation). */
  readonly prepareToolResult: (conversationId: number, result: ToolExecutionResult) => Promise<ToolExecutionResult>
  /** Safe conversation summary lookup (returns `undefined` if missing/corrupted -> skips `before_turn`). */
  readonly safeSummary: (conversationId: number) => ConversationSummary | undefined
  /** Current turn's input metadata (`before_turn` payload). */
  readonly currentRunInputs: (conversationId: number) => BeforeTurnHookPayload['inputs']
  readonly redact: (text: string) => string
  /** Tool artifact port (used by `prepareToolResult` host implementation). */
  readonly artifacts: {
    spill(conversationId: number, id: string, text: string): Promise<{ artifact?: unknown; text: string }>
  }
}

export class HookBridge {
  private readonly options: HookBridgeOptions

  constructor(options: HookBridgeOptions) {
    this.options = options
  }

  /** Install the SDK hook extension once during initialization. */
  install(): void {
    this.options.registry.install(
      defineExtension({
        name: 'helm-hook-bridge',
        hooks: [
          hook(ToolTask, {
            /** `tool_call`: transform args or block execution. */
            beforeTool: async (call, api) => {
              const outcome = await this.runHookChain('tool_call', {
                conversationId: api.conversationId,
                callId: call.id,
                toolName: call.name,
                input: call.arguments,
              })
              if (outcome?.action === 'block') {
                return { block: this.options.redact(outcome.reason ?? 'blocked') }
              }
              if (outcome?.action === 'handled') {
                // Takeover: cache result for the execution wrapper (`wrapToolCalls`) and track conversationId
                // so terminal/abort/delete hooks can clean up any unconsumed leftover entries.
                this.options.handledToolCalls.set(call.id, {
                  conversationId: api.conversationId,
                  result: toolResultOf(outcome.result),
                })
                return undefined
              }
              if (outcome?.action === 'transform') {
                return outcome.value.input !== undefined
                  ? { arguments: outcome.value.input as JsonObject }
                  : undefined
              }
              return undefined
            },
            /** All final tool outputs pass through the same redaction and spill boundary before persistence. */
            afterTool: async (call, result, api) => {
              this.options.handledToolCalls.delete(call.id)
              try {
                const outcome = await this.runHookChain('tool_result', {
                  conversationId: api.conversationId,
                  callId: call.id,
                  toolName: call.name,
                  input: call.arguments,
                  result,
                })
                let effective = result
                if (outcome?.action === 'transform') {
                  const transformed = normalizeToolResult(outcome.value.result)
                  if (!transformed) throw new HelmError('invalid_hook_result', 'tool_result must return a valid tool result', 500)
                  effective = transformed as ToolExecutionResult
                } else if (outcome?.action === 'handled') {
                  const handled = normalizeToolResult(outcome.result)
                  if (!handled) throw new HelmError('invalid_hook_result', 'tool_result handled payload is not a valid tool result', 500)
                  effective = handled as ToolExecutionResult
                }
                return await this.options.prepareToolResult(api.conversationId, effective)
              } catch (error) {
                return {
                  isError: true,
                  output: [{ type: 'text', text: this.options.redact(`tool_result_failed: ${error instanceof Error ? error.message : String(error)}`) }],
                }
              }
            },
          }),
          hook(GenerationTask, {
            /**
             * `before_turn` bridge: SDK native `sections` (`PromptSection`) and tools are already resolved during
             * prepare (`request.messages` includes the leading `pi.system` message), so `beforeRequest` receives
             * the final model messages (starting with system). Passes real `sections`/`tools`/`messages` payloads to
             * plugins, and rewrites the model request via leading system `sections` / `toolsAdded`.
             * After hooks converge, host projects `prompt.tools.*` sections (see `transformBeforeTurn`).
             */
            beforeRequest: async (request, api) => {
              const conversationId = api.conversationId
              const summary = this.options.safeSummary(conversationId)
              if (!summary) return undefined
              return this.transformBeforeTurn(request, summary, conversationId)
            },
          }),
        ],
      }) as Extension,
    )
  }

  /** Apply `before_turn` transforms across all three surfaces (`sections` / `messages` / `tools`). */
  private async transformBeforeTurn(
    request: { readonly messages: readonly Message[] },
    summary: ConversationSummary,
    conversationId: number,
  ): Promise<{ readonly messages: readonly Message[] } | undefined> {
    const host = this.options.pluginHost()
    const runtimeTools = getCurrentTools(request.messages)
    // Scope filtering: plugin tools are registered globally on the harness (`helm-plugins`), so out-of-scope
    // conversations must not see their declarations — filter to available tools for this conversation before
    // entering hooks while retaining kernel tools.
    const effectiveTools = host !== undefined ? this.scopeLocalTools(host, summary, runtimeTools) : runtimeTools
    const original = request.messages as unknown as Array<Record<string, unknown>>
    const payload: BeforeTurnHookPayload = {
      conversation: summary,
      inputs: this.options.currentRunInputs(conversationId),
      tools: effectiveTools.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.parameters as Record<string, unknown>,
      })) as unknown as BeforeTurnHookPayload['tools'],
      sections: systemSectionsOf(request.messages),
      messages: original,
    }
    const outcome = await this.runHookChain('before_turn', payload)
    // Host final scoped projection: regardless of whether hooks transformed, overwrite `prompt.tools.*`
    // sections according to final active tools (only active tools enter the prompt; disabled/stripped tools
    // have their sections cleared immediately, leaving no phantom prompts). Uses live PluginHost declarations.
    const activeTools = this.activeToolPrompts(summary, effectiveTools, outcome)
    const outcomeSections = outcome?.action === 'transform'
      ? outcome.value.sections
      : payload.sections
    const projected = projectActionPromptSection(
      projectToolPromptSections(outcomeSections, activeTools),
      this.renderActionDirectory(host, summary, effectiveTools, outcome),
    )
    const value: BeforeTurnHookPayload = outcome?.action === 'transform'
      ? { ...outcome.value, sections: projected }
      : { ...payload, sections: projected }

    // `sections` changes -> rewrite leading system message sections (SDK native mechanism).
    // `messages` changes -> full replacement (when explicitly requested by plugin). Boundary checks:
    // 1. Must be a non-empty array with a leading system message (SDK replay mechanism expects a leading system);
    // 2. Preserve original base system content (sections/tool declarations may change, but formatting rules and
    //    history body must never be overwritten by plugins — prevents inplace diff mutation corruption of system header);
    // 3. Remaining non-system history keeps strict original ordering (prefix trimming only; never fabricate/rewrite history).
    let messages = original
    const sectionsChanged = !sectionsEqual(value.sections, payload.sections)
    const messagesChanged = value.messages !== payload.messages
    if (messagesChanged) messages = assertSafeMessageSurgery(original, value.messages)
    if (sectionsChanged) messages = withSections(messages, value.sections)

    // Tool declaration rewrite baseline is SDK's originally resolved tool set (including out-of-scope plugin tools):
    // whenever the final set differs from original (due to scope trimming or hook stripping), replay via toolsRemoved/toolsAdded.
    const initialNames = new Set(runtimeTools.map((tool) => tool.name))
    const declared = new Set(value.tools.map((tool) => tool.name))
    if (declared.size !== initialNames.size || [...declared].some((name) => !initialNames.has(name))) {
      messages = withToolDeclarations(messages, declared, runtimeTools)
    }
    if (messages === original) return undefined
    return { messages: messages as unknown as readonly Message[] }
  }

  /**
   * Scope-trim plugin tools: among globally registered plugin tools (`helm-plugins`), strip declarations whose
   * scope does not match this conversation before entering the hook chain (retaining kernel tools and matching
   * plugin tools). Runtime `assertScopeAllows` still enforces at execution; this eliminates request-level leaks.
   */
  private scopeLocalTools<T extends { name: string }>(
    host: PluginHost,
    summary: ConversationSummary,
    requestTools: T[],
  ): T[] {
    const globalNames = new Set(host.listTools().map((tool) => tool.name))
    if (globalNames.size === 0) return requestTools
    const localNames = new Set(host.listTools(summary).map((tool) => tool.name))
    return requestTools.filter((tool) => !globalNames.has(tool.name) || localNames.has(tool.name))
  }

  /**
   * Render `<available_actions>` catalog section: generated only when `run_action` is present in both request tools
   * and final post-hook tools (actually reachable); includes scope-matched non-`exposeAsTool` actions (`exposeAsTool`
   * actions are declared directly as tools and do not fall back to the catalog even if stripped). Returns `undefined`
   * when no actions are reachable (clearing any stale `prompt.actions` section).
   */
  private renderActionDirectory(
    host: PluginHost | undefined,
    summary: ConversationSummary,
    requestTools: Array<{ name: string }>,
    outcome: { action: string; value?: unknown } | undefined,
  ): string | undefined {
    if (host === undefined) return undefined
    const requestNames = new Set(requestTools.map((tool) => tool.name))
    const finalNames =
      outcome?.action === 'transform'
        ? new Set(
            ((outcome.value as { tools?: Array<{ name?: unknown }> }).tools ?? [])
              .filter((t) => typeof t.name === 'string')
              .map((t) => t.name as string),
          )
        : requestNames
    if (!requestNames.has('run_action') || !finalNames.has('run_action')) return undefined
    const entries: ActionDirectoryEntry[] = []
    for (const manifest of host.listActions()) {
      if (manifest.exposeAsTool === true) continue
      if (manifest.exposeToPrompt === false) continue
      if (!matchesConversationScope(manifest.scope, summary)) continue
      entries.push({ manifest, cliCommand: actionCliCommand(manifest) })
    }
    return renderAvailableActionsSection(entries)
  }

  /**
   * Collect prompt metadata for final active tools: intersection of PluginHost's live scoped declarations and the
   * converged post-hook tool list — tools stripped by plugins (e.g. memory disabled) do not project prompt sections.
   * When hooks do not transform, all SDK-resolved request tools are permitted.
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

  /** Run a unified hook pipeline; converts `continue` into `undefined` so callers apply default behavior. */
  async runHookChain<K extends HookName>(
    name: K,
    payload: HookPayloadMap[K],
  ): Promise<HookResult<HookPayloadMap[K]> | undefined>
  async runHookChain(name: HookName, payload: unknown): Promise<HookDecision | undefined>
  async runHookChain<K extends HookName>(
    name: K,
    payload: HookPayloadMap[K] | unknown,
  ): Promise<HookResult<HookPayloadMap[K]> | HookDecision | undefined> {
    const host = this.options.pluginHost()
    if (!host) return undefined
    const result = await host.runHook(name, payload as HookPayloadMap[K])
    if (result.action === 'continue') return undefined
    return result
  }

  /**
   * Run an `around` (continuation) hook (`agent_spawn` only): plugins wrap full execution (downstream hooks
   * and default native execution) by controlling `next`; falls through directly to `defaultRun` when no host.
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

/** Unified outbound tool-result handling: redaction + spill boundary (truncates oversized payloads to artifacts). */
export async function prepareToolResultWith(
  artifacts: HookBridgeOptions['artifacts'],
  redact: (text: string) => string,
  conversationId: number,
  result: ToolExecutionResult,
): Promise<ToolExecutionResult> {
  // SDK result optional properties can be undefined; apply JSON-omission semantics first, then redact every string.
  const safe = redactJsonValue(JSON.parse(JSON.stringify(result)), redact) as ToolExecutionResult
  const output = safe.output ?? []
  const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const spill = await artifacts.spill(conversationId, `tool-${randomUUID()}`, text)
  if (!spill.artifact) return safe
  return { ...safe, output: [{ type: 'text', text: spill.text }, ...output.filter((block) => block.type !== 'text')] }
}

export { BACKGROUND_CONTEXT }
