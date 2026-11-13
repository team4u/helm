/**
 * 内核工具工厂：run_action 元工具。
 *
 * subagent / SubagentWorkflow / cleanup_worktree 已迁移至 builtin:workflow
 * 插件（ctx.tool 声明）；内核只保留与插件无关的基础元工具。
 */
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { safeResultText, type ActionManifest } from '@helm/protocol'

/** 工具工厂的宿主能力面。 */
export interface KernelToolHost {
  /** 插件动作调用（run_action 元工具）。 */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * 动作清单只读查询（run_action describe 模式）：按当前启用插件与调用会话
   * scope 过滤后返回完整 ActionManifest（input/outputSchema），绝不执行
   * handler、不做输入校验、不创建 liveTask。
   */
  describePluginAction(
    pluginId: string,
    actionId: string,
    context: { conversationId: number },
  ): Promise<ActionManifest>
  /** 出站文本脱敏（受管 token / stash 明文）。 */
  redact(text: string): string
}

/** run_action 元工具：按需调用插件动作（qualifiedId，输入输出 schema 边界校验）；describe 只查清单不执行。 */
export function createRunActionTool(host: KernelToolHost): ToolRegistration {
  return defineTool({
    name: 'run_action',
    description:
      '调用插件声明的动作（pluginId.actionId 全限定 ID）。可用动作目录由系统提示 <available_actions> 注入。' +
      'describe: true 时仅返回该动作完整清单（input/outputSchema，不执行动作），用于查询嵌套或复杂参数结构。输入校验失败显式报错。',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'pluginId.actionId 全限定动作 ID' },
        input: { type: 'object', description: '动作输入（按动作 inputSchema）' },
        describe: {
          type: 'boolean',
          description: 'true 时只返回该动作的完整清单（input/outputSchema），不执行动作；缺省 false 执行',
        },
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
      const pluginId = qualified.slice(0, dot)
      const actionId = qualified.slice(dot + 1)
      try {
        if (args['describe'] === true) {
          const manifest = await host.describePluginAction(pluginId, actionId, {
            conversationId: api.conversationId,
          })
          return {
            output: [{ type: 'text', text: host.redact(JSON.stringify(manifest, null, 2)) }],
          }
        }
        const result = await host.invokePluginAction(pluginId, actionId, args['input'] ?? {}, {
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
