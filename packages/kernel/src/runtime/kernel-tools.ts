/**
 * kernel tool work vendor:run_action meta tool.
 *
 * subagent / SubagentWorkflow / cleanup_worktree already migration until builtin:workflow
 * plugin (ctx.tool declaration); kernel only keep and plugin without closure basis meta tool.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str, unsafe } from '@earendil-works/pi-schema'
import { safeResultText, type ActionManifest } from '@helm/protocol'

/** tool work vendor host capability side. */
export interface KernelToolHost {
  /** plugin action invoke (run_action meta tool). */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * action manifest only read query (run_action describe pattern): by when before enable plugin and invoke conversation
   * scope filter after return complete ActionManifest(input/outputSchema), never execute
   * handler, does not input validate, do not create liveTask.
   */
  describePluginAction(
    pluginId: string,
    actionId: string,
    context: { conversationId: number },
  ): Promise<ActionManifest>
  /** out station text redaction (managed token / stash plaintext). */
  redact(text: string): string
}

const runActionParameters = obj({
  actionId: str({ description: 'pluginId.actionId all limit set action ID' }),
  input: opt(unsafe<Record<string, unknown>>({ type: 'object', description: 'action input (by action inputSchema)' })),
  describe: opt(
    bool({
      description: 'true when only return the action complete manifest (input/outputSchema), do not execute action; default false execute',
    }),
  ),
})

/** run_action meta tool: on demand invoke plugin action (qualifiedId, input output schema boundary validate);describe only inspect manifest do not execute. */
export function createRunActionTool(host: KernelToolHost): ToolRegistration<typeof runActionParameters> {
  return defineTool({
    name: 'run_action',
    description:
      'invoke plugin declaration action (pluginId.actionId all limit set ID). available action directory by system hint <available_actions> inject.' +
      'describe: true when only return the action complete manifest (input/outputSchema, do not execute action), used to query embed set or complex parameter structure. input validation failed explicit errors.',
    parameters: runActionParameters,
    async execute(args, api: ToolExecutionApi, context: Context) {
      const qualified = args.actionId
      const dot = qualified.indexOf('.')
      if (dot <= 0) {
        return {
          output: [{ type: 'text', text: `run_action_failed: illegal action ID(expectation pluginId.actionId):${qualified}` }],
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
