/**
 * Kernel tool factory: `run_action` meta-tool.
 *
 * `subagent` / `SubagentWorkflow` / `cleanup_worktree` have moved to the `builtin:workflow` plugin
 * (`ctx.tool` declarations); the kernel retains only plugin-agnostic foundational meta-tools.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str, unsafe } from '@earendil-works/pi-schema'
import { safeResultText, type ActionManifest } from '@helmx/protocol'

/** Host capability port for kernel tools. */
export interface KernelToolHost {
  /** Invoke a plugin action (`run_action` meta-tool). */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * Read-only introspection of an action manifest (`run_action` `describe` mode): returns the full
   * `ActionManifest` (`inputSchema`/`outputSchema`) after filtering by currently enabled plugins and
   * conversation scope; never invokes the handler, validates input, or creates a `liveTask`.
   */
  describePluginAction(
    pluginId: string,
    actionId: string,
    context: { conversationId: number },
  ): Promise<ActionManifest>
  /** Outbound text redaction (managed tokens / stash plaintexts). */
  redact(text: string): string
}

const runActionParameters = obj({
  actionId: str({ description: 'Fully-qualified action ID in pluginId.actionId format' }),
  input: opt(unsafe<Record<string, unknown>>({ type: 'object', description: "Action input matching the action's inputSchema" })),
  describe: opt(
    bool({
      description: 'When true, return only the full action manifest (inputSchema/outputSchema) without executing; defaults to false (execute)',
    }),
  ),
})

/** `run_action` meta-tool: invoke plugin actions on demand (qualified ID + boundary schema checks); `describe` inspects manifest read-only. */
export function createRunActionTool(host: KernelToolHost): ToolRegistration<typeof runActionParameters> {
  return defineTool({
    name: 'run_action',
    description:
      'Invoke a plugin-declared action (by qualified ID: pluginId.actionId). Reachable actions are listed in the system <available_actions> catalog. ' +
      'Set describe: true to read the full action manifest (inputSchema/outputSchema without executing), useful for inspecting nested or complex parameters. Invalid inputs fail explicitly.',
    parameters: runActionParameters,
    async execute(args, api: ToolExecutionApi, context: Context) {
      const qualified = args.actionId
      const dot = qualified.indexOf('.')
      if (dot <= 0) {
        return {
          output: [{ type: 'text', text: `run_action_failed: invalid action ID (expected pluginId.actionId): ${qualified}` }],
          isError: true,
        }
      }
      const pluginId = qualified.slice(0, dot)
      const actionId = qualified.slice(dot + 1)
      try {
        if (args.describe === true) {
          const manifest = await host.describePluginAction(pluginId, actionId, {
            conversationId: api.conversationId,
          })
          return {
            output: [{ type: 'text', text: host.redact(JSON.stringify(manifest, null, 2)) }],
          }
        }
        const result = await host.invokePluginAction(pluginId, actionId, args.input ?? {}, {
          conversationId: api.conversationId,
          signal: context.abortSignal,
        })
        return {
          output: [{ type: 'text', text: safeResultText(result, (text) => host.redact(text)) }],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `run_action_failed: ${message}` }],
          isError: true,
        }
      }
    },
  })
}
