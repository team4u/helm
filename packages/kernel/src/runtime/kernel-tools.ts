/**
 * 内核工具工厂：run_action 元工具。
 *
 * subagent / SubagentWorkflow / cleanup_worktree 已迁移至 builtin:workflow
 * 插件（ctx.tool 声明）；内核只保留与插件无关的基础元工具。
 */
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { safeResultText } from './runtime-helpers.js'

/** 工具工厂的宿主能力面。 */
export interface KernelToolHost {
  /** 插件动作调用（run_action 元工具）。 */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /** 出站文本脱敏（受管 token / stash 明文）。 */
  redact(text: string): string
}

/** run_action 元工具：按需调用插件动作（qualifiedId，输入输出 schema 边界校验）。 */
export function createRunActionTool(host: KernelToolHost): ToolRegistration {
  return defineTool({
    name: 'run_action',
    description:
      '调用插件声明的动作（pluginId.actionId 全限定 ID）。动作清单由系统提示注入；输入校验失败显式报错。',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'pluginId.actionId 全限定动作 ID' },
        input: { type: 'object', description: '动作输入（按动作 inputSchema）' },
      },
      required: ['actionId'],
      additionalProperties: false,
    } as Record<string, unknown>,
    async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
      const qualified = String(args['actionId'])
      const dot = qualified.indexOf('.')
      if (dot <= 0) {
        return {
          output: [{ type: 'text', text: `run_action_failed: 非法动作 ID（期望 pluginId.actionId）：${qualified}` }],
          isError: true,
        }
      }
      try {
        const result = await host.invokePluginAction(qualified.slice(0, dot), qualified.slice(dot + 1), args['input'] ?? {}, {
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
  } as never)
}
