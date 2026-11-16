/**
 * hook bridge:SDK GenerationTask/ToolTask hook -> helm 7 class lifecycle hook pipeline.
 *
 * from runtime.ts split out.tool_call/tool_result/before_turn in this connect to PluginHost
 *  runHook;turn_settled honor bottom clean up (handled take over leftover) by host via call back inject.
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

export type HookDecision =
  | { action: 'continue' }
  | { action: 'transform'; value: unknown }
  | { action: 'handled'; result?: unknown }
  | { action: 'block'; reason: string }

/** tool_call handled take over cache item (execute layer wrap consume; ownership conversation used to honor bottom clean up). */
export interface HandledToolCallEntry {
  conversationId: number | undefined
  result: { output: Array<{ type: 'text'; text: string }>; isError: boolean }
}

export interface HookBridgeOptions {
  readonly registry: { install(extension: Extension): void }
  /** pluginHost hot inject (initialize phase may not yet create). */
  readonly pluginHost: () => PluginHost | undefined
  readonly handledToolCalls: Map<string, HandledToolCallEntry>
  /** tool result out station unify handle (Spill boundary + redaction; host implement). */
  readonly prepareToolResult: (conversationId: number, result: ToolExecutionResult) => Promise<ToolExecutionResult>
  /** conversation summary security read (missing/corrupt return undefined -> skip before_turn). */
  readonly safeSummary: (conversationId: number) => ConversationSummary | undefined
  /** when before turn input manifest (before_turn payload use). */
  readonly currentRunInputs: (conversationId: number) => BeforeTurnHookPayload['inputs']
  readonly redact: (text: string) => string
  /** tool artifact port (prepareToolResult host implement use). */
  readonly artifacts: {
    spill(conversationId: number, id: string, text: string): Promise<{ artifact?: unknown; text: string }>
  }
}

export class HookBridge {
  private readonly options: HookBridgeOptions

  constructor(options: HookBridgeOptions) {
    this.options = options
  }

  /** install SDK hook extend (initialize phase once). */
  install(): void {
    this.options.registry.install(
      defineExtension({
        name: 'helm-hook-bridge',
        hooks: [
          hook(ToolTask, {
            /** tool_call:transform change write parameter / block intercept. */
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
                // take over: result register to execute layer cache (wrapToolCalls wrap consume);
                // also record ownership conversation, turn terminal state/abort/delete when honor bottom clean up unconsumed leftover.
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
            /** all tool eventually output all in persist before through the same redaction and Spill boundary. */
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
                  if (!transformed) throw new HelmError('invalid_hook_result', 'tool_result must return legal tool result', 500)
                  effective = transformed as ToolExecutionResult
                } else if (outcome?.action === 'handled') {
                  const handled = normalizeToolResult(outcome.result)
                  if (!handled) throw new HelmError('invalid_hook_result', 'tool_result take over artifact is not legal tool result', 500)
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
             * before_turn bridge:SDK original generate sections(PromptSection) and tools already in
             * prepare phase parse (request.messages inside contains pi.system segment message),
             * beforeRequest receives messages is eventually model message (contains system before lead).
             * this in sections/tools/messages real payload hand over to plugin,transform result
             * via system message sections / toolsAdded truly change write model request.
             * hook chain converge after host unify throw shoot prompt.tools.* segment (see transformBeforeTurn).
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

  /** before_turn transform should use (sections / messages / tools three route manually technique). */
  private async transformBeforeTurn(
    request: { readonly messages: readonly Message[] },
    summary: ConversationSummary,
    conversationId: number,
  ): Promise<{ readonly messages: readonly Message[] } | undefined> {
    const host = this.options.pluginHost()
    const runtimeTools = getCurrentTools(request.messages)
    // scope trim: plugin tool global install (helm-plugins) extend, but scope outside conversation must not
    // see to declaration- - enter hook chain before by this conversation available spec filter, kernel tool keep.
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
    // host final scoped throw shoot: regardless of hook is otherwise transform, by eventually active tools unify heavy write
    // prompt.tools.* segment (only activate tool enter prompt; deactivate/strip tool old segment one and clear,
    // do not phantom text). throw shoot based on PluginHost when before declaration (contains prompt metadata).
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

    // sections change -> change write before lead system message sections(SDK original generate mechanism).
    // messages change -> whole replace (plugin explicit want seek when). boundary validate:
    // 1. must be non-empty array and before lead is system message (SDK back put mechanism dependency before lead system);
    // 2. keep original before lead system  content base bottom (sections/tools declaration can change, person format and
    //    history body text never can by plugin override - - guard against original ground mutation diff cannot rely and system head corrupt);
    // 3. original a non- system message after history one rule keep original order (only allows truncate header,
    //    disallows heavy write/fabricate history).
    let messages = original
    const sectionsChanged = !sectionsEqual(value.sections, payload.sections)
    const messagesChanged = value.messages !== payload.messages
    if (messagesChanged) messages = assertSafeMessageSurgery(original, value.messages)
    if (sectionsChanged) messages = withSections(messages, value.sections)

    // declaration heavy write baseline is SDK original parse tool collection (contains scope outside plugin tool): as long as eventually collection
    // and original collection has difference (scope trim or hook strip), all via toolsRemoved/toolsAdded replay.
    const initialNames = new Set(runtimeTools.map((tool) => tool.name))
    const declared = new Set(value.tools.map((tool) => tool.name))
    if (declared.size !== initialNames.size || [...declared].some((name) => !initialNames.has(name))) {
      messages = withToolDeclarations(messages, declared, runtimeTools)
    }
    if (messages === original) return undefined
    return { messages: messages as unknown as readonly Message[] }
  }

  /**
   * plugin tool scope trim: global install plugin tool (helm-plugins) in,scope does not match
   * when before conversation in enter hook chain before strip declaration(kernel tool and scope inside plugin tool
   * keep). execute phase assertScopeAllows second validate do not change; this in eliminate is request level leak.
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
   * action directory segment render: only when run_action in this request tool and hook eventually tool hand over collection inside
   * (real can reach) when generate;scope hit and non- exposeAsTool direct throw (direct throw action via each
   * tool channel declare pass, hook strip after also do not via directory re-). without can reach action return undefined
   * (prompt.actions old segment follow of clear).
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
      if (!matchesConversationScope(manifest.scope, summary)) continue
      entries.push({ manifest, cliCommand: actionCliCommand(manifest) })
    }
    return renderAvailableActionsSection(entries)
  }

  /**
   * eventually active tools prompt metadata collection:PluginHost when before declaration (scope filter)
   * and hook chain converge after tool manifest take hand over collection - - by plugin strip (such as memory close) tool
   * do not throw shoot any segment. hook not transform when with SDK parse request tool collection is allow.
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

  /** unify hook pipeline execute; return eventually decide (continue archive one is undefined by caller away by default). */
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
   * around(continuation) hook execute (only agent_spawn): plugin can via subject to control next
   * package wrap complete execute (contains after continue pipeline and by default original generate execute row). without plugin when directly defaultRun.
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

/** SDK result out station unify handle: redaction + Spill boundary (artifacts cap truncate to artifact). */
export async function prepareToolResultWith(
  artifacts: HookBridgeOptions['artifacts'],
  redact: (text: string) => string,
  conversationId: number,
  result: ToolExecutionResult,
): Promise<ToolExecutionResult> {
  // SDK result optional property can is undefined; first by JSON semantics omit, again one by one string redaction.
  const safe = redactJsonValue(JSON.parse(JSON.stringify(result)), redact) as ToolExecutionResult
  const output = safe.output ?? []
  const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const spill = await artifacts.spill(conversationId, `tool-${randomUUID()}`, text)
  if (!spill.artifact) return safe
  return { ...safe, output: [{ type: 'text', text: spill.text }, ...output.filter((block) => block.type !== 'text')] }
}

export { BACKGROUND_CONTEXT }
